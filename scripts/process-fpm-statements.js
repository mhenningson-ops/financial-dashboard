#!/usr/bin/env node
// Scans the FPM statements folder in Google Drive for new Owner Statement PDFs,
// extracts figures + review notes via Claude, appends to Financial Review.json,
// and emails a summary via Resend. Runs as a GitHub Actions job.

const { google } = require('googleapis');
const Anthropic   = require('@anthropic-ai/sdk');
const { Resend }  = require('resend');

const DRIVE_FILE_ID     = process.env.DRIVE_FILE_ID;
const FPM_FOLDER_ID     = process.env.FPM_FOLDER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL      = process.env.NOTIFY_EMAIL;
const STORAGE_KEY       = 'cordoba_fin_v1';

// ── Drive ─────────────────────────────────────────────────────────────────────

function getDrive() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function readReviewFile(drive) {
  const res = await drive.files.get(
    { fileId: DRIVE_FILE_ID, alt: 'media' },
    { responseType: 'json' }
  );
  return res.data;
}

async function writeReviewFile(drive, data) {
  const { Readable } = require('stream');
  await drive.files.update({
    fileId: DRIVE_FILE_ID,
    media: { mimeType: 'application/json', body: Readable.from([JSON.stringify(data, null, 2)]) },
  });
}

// Handle both storage shapes:
//   dashboard-saved: { cordoba_fin_v1: { quarters, months }, ... }
//   flat (manually created): { quarters, months }
function getMonths(data) {
  return (data[STORAGE_KEY]?.months ?? data.months ?? []);
}
function setMonths(data, months) {
  if (data[STORAGE_KEY]) data[STORAGE_KEY].months = months;
  else data.months = months;
}

// ── Statement file detection ───────────────────────────────────────────────────

async function listFpmFiles(drive) {
  const res = await drive.files.list({
    q: `'${FPM_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`,
    fields: 'files(id, name, modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 100,
  });
  return res.data.files || [];
}

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const LONG_MONTHS  = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function parseMonthFromString(str) {
  const lower = str.toLowerCase();
  for (const [i, name] of LONG_MONTHS.entries()) {
    const m = lower.match(new RegExp(`${name}\\s+(20\\d{2})`));
    if (m) {
      const year    = parseInt(m[1]);
      const lastDay = new Date(year, i + 1, 0);
      return {
        month: `${SHORT_MONTHS[i]} ${year}`,
        date:  lastDay.toISOString().slice(0, 10),
      };
    }
  }
  return null;
}

function classifyFile(name) {
  const lower = name.toLowerCase();
  if (lower.includes('owner'))                                    return 'owner';
  if (lower.includes('cash flow') || lower.includes('cashflow')) return 'cashflow';
  return null;
}

function groupByMonth(files) {
  const map = {};
  for (const file of files) {
    const parsed = parseMonthFromString(file.name);
    const type   = classifyFile(file.name);
    if (!parsed || !type) continue;
    if (!map[parsed.month]) map[parsed.month] = { ...parsed, owner: null, cashflow: null };
    map[parsed.month][type] = file;
  }
  return map;
}

// ── PDF download + text extraction ────────────────────────────────────────────

async function downloadPdfText(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  const buf = Buffer.from(res.data);
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const parsed   = await pdfParse(buf);
  return parsed.text;
}

// ── Claude extraction + review ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are analyzing Foundation Property Management (FPM) owner statements for a Memphis rental portfolio.

Properties: Bradcliff, Neely, Greenmount.

Field mappings from FPM statement:
  income.rent    = "Rent Income" line
  income.other   = sum of all other income lines (Affordable Housing Income, Tenant damages - Owner, etc.)
  income.gross   = income.rent + income.other
  expenses.pm    = "Management Fees"
  expenses.rm    = "Repairs" (includes turn/make-ready costs)
  expenses.util  = "Utilities"
  expenses.other = anything else (legal/collections fees, NSF charges, adjustments, etc.)
  netCF          = income.gross − (pm + rm + util + other)
  endingBalance  = statement ending balance for the property

Notes: short array of flag strings. Empty array if nothing notable. Be specific — include dollar amounts and payee/document references when present in the statement. Mark inferences from the statement alone with "(from statement)". Flag:
  - Late or missed rent (vacancy months, partial payments)
  - Turnover or eviction events with associated costs
  - Maintenance spikes vs prior month
  - Fee changes (management fee %, new charges)
  - Unusual entries in expenses.other
  - Ending balance concerns

Return ONLY valid JSON, no markdown, exactly this shape:
{
  "bradcliff":  {"income":{"rent":0,"other":0,"gross":0},"expenses":{"pm":0,"rm":0,"util":0,"other":0},"netCF":0,"endingBalance":0,"notes":[]},
  "neely":      {"income":{"rent":0,"other":0,"gross":0},"expenses":{"pm":0,"rm":0,"util":0,"other":0},"netCF":0,"endingBalance":0,"notes":[]},
  "greenmount": {"income":{"rent":0,"other":0,"gross":0},"expenses":{"pm":0,"rm":0,"util":0,"other":0},"netCF":0,"endingBalance":0,"notes":[]}
}`;

async function extractWithClaude(pdfTexts, priorMonth) {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const parts = pdfTexts.map(({ label, text }) => `=== ${label} ===\n${text}`);
  if (priorMonth) {
    parts.push(`=== PRIOR MONTH (${priorMonth.month}) — for comparison ===\n${JSON.stringify(priorMonth.properties, null, 2)}`);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: parts.join('\n\n') }],
    });
    const raw = msg.content[0].text.trim();
    try {
      return JSON.parse(raw);
    } catch {
      if (attempt === 1) throw new Error(`Claude returned non-JSON on retry: ${raw.slice(0, 300)}`);
      parts.push(`Your previous response was not valid JSON. Return only the JSON object, nothing else.\n\nPrevious response:\n${raw}`);
    }
  }
}

// ── Email ─────────────────────────────────────────────────────────────────────

function fmtMoney(n) {
  if (n === undefined || n === null) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function buildEmailHtml(monthLabel, properties, hadFlags) {
  const propRows = Object.entries({
    bradcliff: 'Bradcliff', neely: 'Neely', greenmount: 'Greenmount',
  }).map(([key, label]) => {
    const p = properties[key];
    if (!p) return '';
    const notesHtml = p.notes?.length
      ? '<ul style="margin:6px 0 0;padding-left:18px;color:#b45309;">' +
          p.notes.map(n => `<li>⚠ ${n}</li>`).join('') + '</ul>'
      : '<p style="margin:6px 0 0;color:#15803d;font-size:0.9em;">✓ Nothing notable</p>';
    return `<tr>
      <td style="padding:12px 16px;vertical-align:top;border-bottom:1px solid #e5e7eb;">
        <strong>${label}</strong>${notesHtml}
      </td>
      <td style="padding:12px 16px;vertical-align:top;border-bottom:1px solid #e5e7eb;white-space:nowrap;font-size:0.9em;line-height:1.7;">
        Rent ${fmtMoney(p.income.rent)}<br>
        Other ${fmtMoney(p.income.other)}<br>
        <strong>Gross ${fmtMoney(p.income.gross)}</strong>
      </td>
      <td style="padding:12px 16px;vertical-align:top;border-bottom:1px solid #e5e7eb;white-space:nowrap;font-size:0.9em;line-height:1.7;">
        Mgmt ${fmtMoney(p.expenses.pm)}<br>
        R&amp;M ${fmtMoney(p.expenses.rm)}<br>
        Util ${fmtMoney(p.expenses.util)}<br>
        Other ${fmtMoney(p.expenses.other)}
      </td>
      <td style="padding:12px 16px;vertical-align:top;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;">
        <strong style="font-size:1.05em;color:${p.netCF >= 0 ? '#15803d' : '#b91c1c'};">${fmtMoney(p.netCF)}</strong><br>
        <span style="font-size:0.8em;color:#6b7280;">Ending ${fmtMoney(p.endingBalance)}</span>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><body style="font-family:ui-sans-serif,system-ui,sans-serif;color:#111827;max-width:700px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 4px;">FPM Statement Review — ${monthLabel}</h2>
    <p style="margin:0 0 20px;color:#6b7280;">${hadFlags ? '⚠ Items flagged — review required' : '✓ All clear'}</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;font-size:0.9em;">
      <thead style="background:#f9fafb;">
        <tr style="font-size:0.75em;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">
          <th style="padding:8px 16px;text-align:left;font-weight:600;border-bottom:1px solid #e5e7eb;">Property</th>
          <th style="padding:8px 16px;text-align:left;font-weight:600;border-bottom:1px solid #e5e7eb;">Income</th>
          <th style="padding:8px 16px;text-align:left;font-weight:600;border-bottom:1px solid #e5e7eb;">Expenses</th>
          <th style="padding:8px 16px;text-align:right;font-weight:600;border-bottom:1px solid #e5e7eb;">NOI</th>
        </tr>
      </thead>
      <tbody>${propRows}</tbody>
    </table>
    <p style="margin:16px 0 0;font-size:0.8em;color:#9ca3af;">Generated by financial-dashboard · ${new Date().toUTCString()}</p>
  </body></html>`;
}

async function sendEmail(subject, html) {
  const resend = new Resend(RESEND_API_KEY);
  await resend.emails.send({
    from: process.env.RESEND_FROM || 'onboarding@resend.dev',
    to:   NOTIFY_EMAIL,
    subject,
    html,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const required = { DRIVE_FILE_ID, FPM_FOLDER_ID, ANTHROPIC_API_KEY, RESEND_API_KEY, NOTIFY_EMAIL };
  const missing  = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

  const drive = getDrive();

  const [data, files] = await Promise.all([
    readReviewFile(drive),
    listFpmFiles(drive),
  ]);

  const existingMonths = getMonths(data);
  const existingLabels = new Set(existingMonths.map(m => m.month));
  const byMonth        = groupByMonth(files);

  const toProcess = Object.values(byMonth)
    .filter(m => m.owner && !existingLabels.has(m.month))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  if (toProcess.length === 0) {
    console.log('No new statements found — nothing to do.');
    return;
  }

  const sortedSoFar = [...existingMonths].sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const monthInfo of toProcess) {
    console.log(`Processing ${monthInfo.month}…`);

    const pdfTexts = [{ label: 'Owner Statement', text: await downloadPdfText(drive, monthInfo.owner.id) }];
    if (monthInfo.cashflow) {
      pdfTexts.push({ label: 'Cash Flow Report', text: await downloadPdfText(drive, monthInfo.cashflow.id) });
    }

    const priorMonth = sortedSoFar[sortedSoFar.length - 1] || null;
    const properties = await extractWithClaude(pdfTexts, priorMonth);
    const newEntry   = { date: monthInfo.date, month: monthInfo.month, properties };

    // Re-read before writing — idempotency guard
    const freshData   = await readReviewFile(drive);
    const freshMonths = getMonths(freshData);
    if (freshMonths.some(m => m.month === monthInfo.month)) {
      console.log(`${monthInfo.month} already written — skipping.`);
      sortedSoFar.push(newEntry);
      continue;
    }

    setMonths(freshData, [...freshMonths, newEntry]);
    await writeReviewFile(drive, freshData);
    console.log(`Wrote ${monthInfo.month}.`);

    sortedSoFar.push(newEntry);

    // Email is best-effort — month is already safely written if this throws
    try {
      const hadFlags = Object.values(properties).some(p => p.notes?.length > 0);
      const subject  = hadFlags
        ? `⚠ FPM Review — ${monthInfo.month}: items flagged`
        : `✓ FPM Review — ${monthInfo.month}: all clear`;
      await sendEmail(subject, buildEmailHtml(monthInfo.month, properties, hadFlags));
      console.log(`Email sent for ${monthInfo.month}.`);
    } catch (emailErr) {
      console.error(`Email failed (month already written): ${emailErr.message}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
