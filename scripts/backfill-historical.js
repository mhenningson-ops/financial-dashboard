#!/usr/bin/env node
// Reads the historical PM transaction export (XLSX) and backfills monthly
// entries into Financial Review.json on Drive for all months not already present.
//
// Usage: node scripts/backfill-historical.js [--dry-run]

const { google } = require('googleapis');
const XLSX = require('xlsx');
const path = require('path');

const XLSX_PATH = path.join(
  process.env.HOME,
  'Library/CloudStorage/GoogleDrive-m.henningson@gmail.com/My Drive/Real Estate',
  'M Todd Holdings, LLC/Properties/Foundation Property Management Statements',
  'Historical Statements/June 2023-July 2026-.xlsx'
);

const DRIVE_FILE_ID = process.env.DRIVE_FILE_ID;
const STORAGE_KEY   = 'cordoba_fin_v1';
const DRY_RUN       = process.argv.includes('--dry-run');

const PROP_MAP = {
  '5274 Bradcliff Street': 'bradcliff',
  '5168 Neely Road':       'neely',
  '4277 Greenmount Ave':   'greenmount',
};
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── XLSX parsing ───────────────────────────────────────────────────────────────

function excelDateToISO(n) {
  return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
}

function lastDayOfMonth(year, month0) {
  return new Date(Date.UTC(year, month0 + 1, 0)).toISOString().slice(0, 10);
}

function monthLabel(year, month0) {
  return `${SHORT_MONTHS[month0]} ${year}`;
}

function loadTransactions() {
  const wb   = XLSX.readFile(XLSX_PATH);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const detailStart = rows.findIndex(r => r[0] === 'Date' && r[1] === 'Property');
  if (detailStart < 0) throw new Error('Could not find transaction detail header row');

  // Closing date for Neely and Bradcliff: June 23, 2023.
  // Exclude Apr/May 2023 (pre-acquisition repair charges); keep Jun 2023 onward
  // (June 20 closing-transfer credits are valid and included).
  const START_YM = '2023-06';

  const txns = [];
  let section = '';
  for (let i = detailStart + 1; i < rows.length; i++) {
    const r = rows[i];
    if (typeof r[0] === 'string' && r[0] && !r[3]) {
      section = r[0].toLowerCase().includes('subtract') ? 'sub' : 'add';
      continue;
    }
    if (typeof r[0] !== 'number' || r[0] < 40000) continue;
    const propKey = PROP_MAP[r[1]];
    if (!propKey) continue;
    const dateStr = excelDateToISO(r[0]);
    if (dateStr.slice(0, 7) < START_YM) continue;

    txns.push({
      date:    dateStr,
      ym:      dateStr.slice(0, 7),
      prop:    propKey,
      account: r[3],
      amount:  parseFloat(r[6]) || 0,
      section,
    });
  }
  return txns;
}

// ── Aggregation ────────────────────────────────────────────────────────────────

// Income accounts (from "additions" section that count as revenue)
const INCOME_RENT = new Set([
  'Rent Income',
  'Rent Income - Affordable Housing Income',
]);
const INCOME_OTHER = new Set([
  'Tenant damages - Owner',
  'Tenant Utility Charge-Owner',
  'Legal and Professional Fees-Owner',
]);

// Expense accounts (from "subtractions" section)
const EXP_PM   = new Set(['Management Fees']);
const EXP_RM   = new Set(['Repairs', 'Cleaning and Maintenance']);
const EXP_UTIL = new Set(['Utilities']);
const EXP_OTHER = new Set(['Accounting Fees', 'Commissions', 'Legal and Professional Fees', 'Periodic Inspections']);
const EXP_DRAW  = new Set(['Owner Draw']);

// Cash balance tracking: ALL additions - ALL subtractions (including SDs, prepayments, etc.)
const BALANCE_EXCLUDE = new Set(); // nothing excluded from balance

function aggregate(txns) {
  // Build a sorted list of unique year-months
  const ymSet = new Set(txns.map(t => t.ym));
  const yms   = [...ymSet].sort();

  // Running balance per property
  const runningBalance = { bradcliff: 0, neely: 0, greenmount: 0 };

  // Per-month accumulators: map[ym][prop] = { income, expenses, draw, addTotal, subTotal }
  const monthly = {};
  for (const ym of yms) {
    monthly[ym] = {};
    for (const p of Object.values(PROP_MAP)) {
      monthly[ym][p] = {
        rent: 0, other_income: 0,
        pm: 0, rm: 0, util: 0, other_exp: 0,
        draw: 0,
        cash_add: 0, cash_sub: 0,
      };
    }
  }

  // Single pass through sorted transactions
  for (const t of txns) {
    const m  = monthly[t.ym][t.prop];
    const ac = t.account;
    const amt = t.amount;

    if (t.section === 'add') {
      m.cash_add += amt;
      if (INCOME_RENT.has(ac))  m.rent         += amt;
      if (INCOME_OTHER.has(ac)) m.other_income += amt;
    } else {
      m.cash_sub += amt;
      if (EXP_PM.has(ac))   m.pm       += amt;
      if (EXP_RM.has(ac))   m.rm       += amt;
      if (EXP_UTIL.has(ac)) m.util     += amt;
      if (EXP_OTHER.has(ac)) m.other_exp += amt;
      if (EXP_DRAW.has(ac)) m.draw     += amt;
    }
  }

  // Convert to monthly entries (in chronological order)
  const entries = [];
  for (const ym of yms) {
    const [year, month0str] = ym.split('-');
    const month0 = parseInt(month0str) - 1;

    // Advance running balances for this month
    const properties = {};
    let totalDraw = 0;

    for (const p of Object.values(PROP_MAP)) {
      const m = monthly[ym][p];
      runningBalance[p] = runningBalance[p] + m.cash_add - m.cash_sub;

      const gross = round2(m.rent + m.other_income);
      const pm    = round2(m.pm);
      const rm    = round2(m.rm);
      const util  = round2(m.util);
      const other = round2(m.other_exp);
      const netCF = round2(gross - pm - rm - util - other);

      properties[p] = {
        income:   { rent: round2(m.rent), other: round2(m.other_income), gross },
        expenses: { pm, rm, util, other },
        netCF,
        endingBalance: round2(runningBalance[p]),
        notes: [],
      };
      totalDraw += m.draw;
    }

    entries.push({
      date:         lastDayOfMonth(parseInt(year), month0),
      month:        monthLabel(parseInt(year), month0),
      distribution: round2(totalDraw) || null,
      reserve:      null, // old PM doesn't expose reserve separately
      properties,
    });
  }

  return entries;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Drive ─────────────────────────────────────────────────────────────────────

function getDrive() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function readDriveFile(drive) {
  const res = await drive.files.get(
    { fileId: DRIVE_FILE_ID, alt: 'media' },
    { responseType: 'json' }
  );
  return res.data;
}

async function writeDriveFile(drive, data) {
  const { Readable } = require('stream');
  await drive.files.update({
    fileId: DRIVE_FILE_ID,
    media: { mimeType: 'application/json', body: Readable.from([JSON.stringify(data, null, 2)]) },
  });
}

function getMonths(data) {
  return (data[STORAGE_KEY]?.months ?? data.months ?? []);
}

function setMonths(data, months) {
  if (data[STORAGE_KEY]) data[STORAGE_KEY].months = months;
  else data.months = months;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Reading historical XLSX…');
  const txns   = loadTransactions();
  console.log(`Loaded ${txns.length} transactions`);

  const newEntries = aggregate(txns);
  console.log(`Aggregated ${newEntries.length} monthly entries (${newEntries[0].month} – ${newEntries[newEntries.length - 1].month})`);

  if (DRY_RUN) {
    console.log('\n=== DRY RUN — sample output ===');
    newEntries.slice(0, 3).forEach(e => console.log(JSON.stringify(e, null, 2)));
    console.log('…');
    newEntries.slice(-2).forEach(e => console.log(JSON.stringify(e, null, 2)));
    console.log(`\nWould write ${newEntries.length} months. Run without --dry-run to apply.`);
    return;
  }

  if (!DRIVE_FILE_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('DRIVE_FILE_ID and GOOGLE_SERVICE_ACCOUNT_JSON env vars required');
  }

  const drive      = getDrive();
  const driveData  = await readDriveFile(drive);
  const existing   = getMonths(driveData);
  const existingSet = new Set(existing.map(m => m.month));

  const toAdd = newEntries.filter(e => !existingSet.has(e.month));
  console.log(`${toAdd.length} new months to add (${existing.length} already in JSON)`);

  if (toAdd.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Merge and sort chronologically
  const merged = [...existing, ...toAdd].sort((a, b) => new Date(a.date) - new Date(b.date));
  setMonths(driveData, merged);
  await writeDriveFile(drive, driveData);
  console.log(`Done. Wrote ${merged.length} total months to Drive.`);
  toAdd.forEach(e => console.log(' +', e.month));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
