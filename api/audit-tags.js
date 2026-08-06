// POST /api/audit-tags
// Body: { quarterStart: "YYYY-MM-DD", quarterEnd: "YYYY-MM-DD" }
// Returns: { autoTagged, flaggedIncorrect, needsAttention, newPayees }

const YNAB_BASE      = 'https://api.ynab.com/v1';
const YNAB_BUDGET_ID = '69bdb53b-b170-4b0a-881a-24b5876a231f';
const HOSPITABLE_BASE = 'https://public.api.hospitable.com/v2';

// ── Payee rules ────────────────────────────────────────────────────────────────
const PAYEE_RULES = {
  '2123 E 6320 S': [
    'angelica quiroga','weed man','trusted trims','saela','lock and key',
    'ikea','ace hardware','home depot','beehive plumbing','millcreek plumbing',
    'western appliance solution','comcast','dominion energy','enbridge gas',
    'rocky mountain pacific','salt lake public utilities','cottonwood improvement district',
    'wasatch front waste','questar gas','apollo.io',
  ],
  '200 Stevens Rd': [
    'flawless 5 star','allsafepro','jamie shields','pricelabs',
    'jessica and nick raymond','hocha cool','freddy','covers & all',
    'choctaw electric co-op inc','mccurtain county propane','mccurtain co. rw',
    'pine telephone co inc','county trash services','town of hochatown','booking.com',
  ],
  '2123 E 6320 S and 200 Stevens Rd': [
    'claude.ai','anthropic','adobe',
  ],
  'All properties': [
    'bitwarden','intuit','apple',
  ],
};

// Payees we know about but intentionally skip (no tag needed)
const SKIP_PAYEES = [
  "claude's italian specialties",'google cloud','cloud gvxvh','cloud mghqzn',
  'cloud mghqzn','amazon grocery','plaid','render','twilio','ynab','relatio',
  'state farm insurance','progressive insurance','fay servicing','mr. cooper',
  'phh mortgage','rocket mortgage','galen smith',
];

// Categories that indicate property expenses
const PROPERTY_CATEGORIES = new Set([
  'Utilities','⚡️ Utilities','Repairs & Maintenance','Materials & Supplies',
  'Subscription','Appliances','Furniture','Lodging Taxes','Lodging Tax',
  'Platform Fees','Registration & Legal Fees',
]);

// Already-valid memo values
const VALID_MEMOS = new Set([
  '200 Stevens Rd','2123 E 6320 S',
  '2123 E 6320 S and 200 Stevens Rd','All properties',
]);

// Hospitable: months when Holladay STR is open → validated via API
async function getHolladayOpenMonths(token, qStart, qEnd) {
  try {
    const propsUrl = `${HOSPITABLE_BASE}/properties?per_page=100`;
    const propsR = await fetch(propsUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!propsR.ok) return new Set();
    const props = (await propsR.json()).data || [];
    const hints = ['holladay','6320','2123'];
    const holl = props.find(p => hints.some(h => (p.name||p.nickname||'').toLowerCase().includes(h)));
    if (!holl) return new Set();

    const resUrl = new URL(`${HOSPITABLE_BASE}/reservations`);
    resUrl.searchParams.set('properties[]', holl.uuid || holl.id);
    resUrl.searchParams.set('include', 'financials');
    resUrl.searchParams.set('start_date', qStart);
    resUrl.searchParams.set('end_date', qEnd);
    resUrl.searchParams.set('per_page', '100');
    const resR = await fetch(resUrl.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!resR.ok) return new Set();
    const reservations = (await resR.json()).data || [];
    const open = new Set();
    for (const r of reservations) {
      if (['cancelled','declined','expired'].includes((r.status||'').toLowerCase())) continue;
      const rev = (r.financials?.host?.revenue?.amount || 0);
      if (rev === 0) continue;
      const checkin = r.arrival_date || r.check_in || '';
      if (checkin) open.add(checkin.slice(0,7));
    }
    return open;
  } catch {
    return new Set();
  }
}

function expectedMemo(payeeLower, date, holladayOpenMonths) {
  for (const [memo, payees] of Object.entries(PAYEE_RULES)) {
    if (payees.some(p => payeeLower.includes(p))) {
      // Hospitable: memo depends on month
      if (payeeLower.includes('hospitable')) {
        const month = date.slice(0, 7);
        return holladayOpenMonths.has(month)
          ? '2123 E 6320 S and 200 Stevens Rd'
          : '200 Stevens Rd';
      }
      return memo;
    }
  }
  return null;
}

function shouldSkip(payeeLower) {
  return SKIP_PAYEES.some(s => payeeLower.includes(s));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const ynabToken  = process.env.YNAB_TOKEN;
  const hospToken  = process.env.HOSPITABLE_TOKEN;
  const { quarterStart, quarterEnd } = req.body || {};

  if (!ynabToken)    return res.status(500).json({ error: 'YNAB_TOKEN not set' });
  if (!quarterStart || !quarterEnd)
    return res.status(400).json({ error: 'quarterStart and quarterEnd required' });

  try {
    // Fetch YNAB transactions and Holladay open months in parallel
    const txnUrl = new URL(`${YNAB_BASE}/budgets/${YNAB_BUDGET_ID}/transactions`);
    txnUrl.searchParams.set('since_date', quarterStart);

    const [txnResp, holladayOpenMonths] = await Promise.all([
      fetch(txnUrl.toString(), { headers: { Authorization: `Bearer ${ynabToken}` } }),
      hospToken ? getHolladayOpenMonths(hospToken, quarterStart, quarterEnd) : Promise.resolve(new Set()),
    ]);

    if (!txnResp.ok) throw new Error(`YNAB transactions → ${txnResp.status}`);
    const allTxns = (await txnResp.json()).data.transactions
      .filter(t => t.date >= quarterStart && t.date <= quarterEnd);

    // Filter to property categories
    const propertyTxns = allTxns.filter(t =>
      PROPERTY_CATEGORIES.has(t.category_name) ||
      (t.subtransactions || []).some(s => PROPERTY_CATEGORIES.has(s.category_name))
    );

    const autoTagged       = [];
    const flaggedIncorrect = [];
    const needsAttention   = [];
    const newPayeesMap     = new Map();

    // Track which txn IDs we've auto-patched to avoid double-patching
    const patchPromises = [];

    for (const t of propertyTxns) {
      const payee    = t.payee_name || '';
      const pLower   = payee.toLowerCase();
      const memo     = (t.memo || '').trim();
      const isTagged = VALID_MEMOS.has(memo) ||
        (memo.startsWith('200 Stevens Rd') || memo.startsWith('2123'));

      if (shouldSkip(pLower)) continue;

      const expected = expectedMemo(pLower, t.date, holladayOpenMonths);

      if (expected) {
        if (!isTagged) {
          // Auto-tag it
          patchPromises.push(
            fetch(`${YNAB_BASE}/budgets/${YNAB_BUDGET_ID}/transactions/${t.id}`, {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${ynabToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ transaction: { memo: expected } }),
            }).then(r => ({ ok: r.ok, t, expected }))
          );
          autoTagged.push({
            id: t.id, date: t.date, payee,
            amount: t.amount / 1000,
            category: t.category_name,
            newMemo: expected,
          });
        } else if (memo !== expected && !memo.includes(expected)) {
          // Tagged but wrong
          flaggedIncorrect.push({
            id: t.id, date: t.date, payee,
            amount: t.amount / 1000,
            category: t.category_name,
            currentMemo: memo,
            expectedMemo: expected,
          });
        }
      } else if (!isTagged) {
        // Payee not in rules
        if (pLower.includes('amazon')) {
          needsAttention.push({
            id: t.id, date: t.date, payee,
            amount: t.amount / 1000,
            category: t.category_name,
            memo,
            reason: 'Amazon — tag per purchase',
          });
        } else {
          const key = pLower;
          if (!newPayeesMap.has(key)) {
            newPayeesMap.set(key, {
              payee, category: t.category_name,
              dates: [], totalAmount: 0,
            });
          }
          const entry = newPayeesMap.get(key);
          entry.dates.push(t.date);
          entry.totalAmount += t.amount / 1000;
        }
      }
    }

    // Wait for patches (fire-and-forget failures don't block response)
    await Promise.allSettled(patchPromises);

    return res.status(200).json({
      autoTagged,
      flaggedIncorrect,
      needsAttention,
      newPayees: Array.from(newPayeesMap.values()).map(e => ({
        ...e,
        count: e.dates.length,
        latestDate: e.dates.sort().slice(-1)[0],
      })),
    });

  } catch (err) {
    console.error('[/api/audit-tags]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
