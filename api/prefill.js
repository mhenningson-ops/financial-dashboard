// POST /api/prefill
// Body: { quarterEnd: "YYYY-MM-DD" }
// Returns: { draft: {field: value}, sources: {field: "YNAB"|"Hospitable"}, warnings: [] }

const YNAB_BASE       = 'https://api.ynab.com/v1';
const YNAB_BUDGET_ID  = '69bdb53b-b170-4b0a-881a-24b5876a231f';
const HOSPITABLE_BASE = 'https://public.api.hospitable.com/v2';

const RECONCILIATION_PAYEE = 'reconciliation balance adjustment';
const CANCELLED_STATUSES   = new Set(['cancelled','declined','inquiry','checkpoint voided','checkpoint_voided']);

// ── YNAB account config ────────────────────────────────────────────────────────
const YNAB_SINGLE = {
  brad_mortgage: '49de1223-11bf-4953-b956-28dcbcc278e5',
  bb_mortgage1:  '4c93665a-3e70-48c0-9f7e-2a020f57ac94',
  bb_mortgage2:  'e7b6575d-869b-40fb-a2ff-3be7c669df01',
  holl_mortgage: '2bc1a81f-f85b-403a-bcb8-36d96a16cebc',
  a_ibonds:      '45eed873-739d-4984-899c-7ce165edafa6',
  a_muni:        'ef75d06b-9df5-4b3d-a399-167791bb85f5',
};

const YNAB_GROUPED = {
  a_cash:  ['vio', 'mercury', 'venmo', 'investor checking'],
  d_other: ['chase', 'amex', 'skymiles', 'delta'],
};

const SAVINGS_ACCOUNTS = [
  {
    field:          's_other',
    label:          'Vio 5091',
    hint:           '5091',
    includePayees:  ['investor checking', 'vio bank - 9490'],
  },
  {
    field:                 's_other',
    label:                 'Schwab Brokerage *505',
    id:                    'ef75d06b-9df5-4b3d-a399-167791bb85f5',
    excludeTransferHints:  ['vio bank money mrkt'],
  },
];

// ── Property expense config ────────────────────────────────────────────────────
const PROPERTY_EXPENSE_CONFIG = [
  {
    label:    'Bradcliff',
    draftKey: 'brad',
    categories: {
      'Utilities':             'brad_util',
      '⚡️ Utilities':         'brad_util',
      'Repairs & Maintenance': 'brad_rm',
      'Subscription':          'brad_subs',
      'Appliances':            'brad_capex',
      'Furniture':             'brad_capex',
    },
  },
  {
    label:    'Neely',
    draftKey: 'neely',
    categories: {
      'Utilities':             'neely_util',
      '⚡️ Utilities':         'neely_util',
      'Repairs & Maintenance': 'neely_rm',
      'Subscription':          'neely_subs',
      'Appliances':            'neely_capex',
      'Furniture':             'neely_capex',
    },
  },
  {
    label:    'Greenmount',
    draftKey: 'green',
    categories: {
      'Utilities':             'green_util',
      '⚡️ Utilities':         'green_util',
      'Repairs & Maintenance': 'green_rm',
      'Subscription':          'green_subs',
      'Appliances':            'green_capex',
      'Furniture':             'green_capex',
    },
  },
  {
    label:    'Holladay',
    draftKey: 'holl',
    categories: {
      'Utilities':             'holl_util',
      '⚡️ Utilities':         'holl_util',
      'Repairs & Maintenance': 'holl_rm',
      'Materials & Supplies':  'holl_supplies',
      'Subscription':          'holl_subs',
      'Appliances':            'holl_capex',
      'Furniture':             'holl_capex',
    },
  },
  {
    label:    'Broken Bow',
    draftKey: 'bb',
    categories: {
      'Utilities':             'bb_util',
      '⚡️ Utilities':         'bb_util',
      'Repairs & Maintenance': 'bb_rm',
      'Materials & Supplies':  'bb_supplies',
      'Subscription':          'bb_subs',
      'Appliances':            'bb_capex',
      'Furniture':             'bb_capex',
      'Lodging Taxes':         'bb_lodging_tax',
      'Lodging Tax':           'bb_lodging_tax',
    },
  },
];

const NUM_PROPERTIES = PROPERTY_EXPENSE_CONFIG.length;

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmt(n) {
  return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function quarterForDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const q = Math.floor(d.getMonth() / 3) + 1;
  const year = d.getFullYear();
  const startMonth = (q - 1) * 3;
  const qStart = new Date(year, startMonth, 1);
  const qEnd   = new Date(year, startMonth + 3, 0); // last day of end-month
  const days   = Math.round((qEnd - qStart) / 86400000) + 1;
  return { q, year, qStart: qStart.toISOString().slice(0,10), qEnd: qEnd.toISOString().slice(0,10), days };
}

function classifyMemo(memo) {
  const m = (memo || '').toLowerCase();
  if (m === 'all properties') return 'all';
  const hasBB   = m.includes('200 stevens');
  const hasHoll = m.includes('2123');
  if (hasBB && hasHoll) return 'both';
  if (hasBB)   return 'bb';
  if (hasHoll) return 'holl';
  return null;
}

// ── YNAB fetch helpers ─────────────────────────────────────────────────────────
async function ynabGet(path, token, params = {}) {
  const url = new URL(`${YNAB_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`YNAB ${path} → ${r.status}`);
  return r.json();
}

async function getAccounts(token) {
  const data = await ynabGet(`/budgets/${YNAB_BUDGET_ID}/accounts`, token);
  return data.data.accounts.filter(a => !a.deleted && !a.closed);
}

async function getAllTransactions(token, sinceDate) {
  const data = await ynabGet(`/budgets/${YNAB_BUDGET_ID}/transactions`, token, { since_date: sinceDate });
  return data.data.transactions;
}

// ── Balance at quarter-end via transaction reversal ────────────────────────────
function balanceAtDate(account, allTxns, qEnd) {
  const afterQEnd = allTxns.filter(t =>
    t.account_id === account.id &&
    t.date > qEnd &&
    !((t.payee_name || '').toLowerCase().includes(RECONCILIATION_PAYEE))
  );
  const postTotal = afterQEnd.reduce((s, t) => s + t.amount, 0);
  return (account.balance - postTotal) / 1000;
}

// ── Hospitable helpers ─────────────────────────────────────────────────────────
async function hospGet(path, token, params = {}) {
  const url = new URL(`${HOSPITABLE_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Hospitable ${path} → ${r.status}`);
  return r.json();
}

async function fetchStrQuarter(token, propertyId, qStart, qEnd, days) {
  const params = {
    'properties[]': propertyId,
    include: 'financials',
    per_page: 100,
    page: 1,
    start_date: qStart,
    end_date: qEnd,
  };
  let reservations = [];
  while (true) {
    const data = await hospGet('/reservations', token, params);
    const batch = data.data || [];
    reservations = reservations.concat(batch);
    if (batch.length < params.per_page) break;
    params.page++;
  }

  let revenue = 0, nights = 0, platformFees = 0;
  for (const r of reservations) {
    const status   = (r.status || '').toLowerCase().trim();
    const resCur   = (r.reservation_status?.current) || {};
    const category = (resCur.category || '').toLowerCase();
    const sub      = (resCur.sub_category || '').toLowerCase();
    const fin      = r.financials?.host || {};
    const rev      = (fin.revenue?.amount || 0) / 100;
    if (CANCELLED_STATUSES.has(status) || category === 'checkpoint' || sub === 'voided' ||
        (rev === 0 && !['accepted','staying','completed'].includes(category))) continue;
    let n = r.nights || 0;
    if (!n) {
      const ci = r.arrival_date || r.check_in;
      const co = r.departure_date || r.check_out;
      if (ci && co) n = Math.round((new Date(co) - new Date(ci)) / 86400000);
    }
    revenue += rev;
    nights  += n;
    for (const fee of fin.host_fees || []) {
      platformFees += Math.abs(fee.amount || 0);
    }
  }
  return { revenue, nights, platformFees: platformFees / 100, daysAvail: days };
}

// ── Savings inflows ────────────────────────────────────────────────────────────
function calcSavings(accounts, allTxns, qStart, qEnd, cfg) {
  const account = cfg.id
    ? accounts.find(a => a.id === cfg.id)
    : accounts.find(a => (a.name || '').toLowerCase().includes(cfg.hint));
  if (!account) return 0;

  const txns = allTxns.filter(t =>
    t.account_id === account.id &&
    t.date >= qStart &&
    t.date <= qEnd &&
    t.amount > 0
  );

  let total = 0;
  for (const t of txns) {
    const payee = (t.payee_name || '').toLowerCase();
    if (cfg.includePayees) {
      if (!cfg.includePayees.some(p => payee.includes(p))) continue;
    } else if (cfg.excludeTransferHints) {
      if (cfg.excludeTransferHints.some(h => payee.includes(h))) continue;
    }
    total += t.amount;
  }
  return total / 1000;
}

// ── Property expenses ──────────────────────────────────────────────────────────
function calcPropertyExpenses(allTxns, qStart, qEnd) {
  const totals = {};
  for (const t of allTxns) {
    if (t.date < qStart || t.date > qEnd) continue;
    const parentMemo = (t.memo || '').toLowerCase();
    const items = (t.subtransactions?.length ? t.subtransactions : [t]);
    for (const item of items) {
      if ((item.amount || 0) >= 0) continue;
      const memo = ((item.memo || '') || parentMemo).toLowerCase();
      const cat  = (item.category_name || '').trim();
      const memoType = classifyMemo(memo);
      if (!memoType) continue;

      for (const prop of PROPERTY_EXPENSE_CONFIG) {
        let share = 0;
        if (memoType === 'all') share = 1 / NUM_PROPERTIES;
        else if (memoType === 'both') share = 0.5;
        else if (memoType === 'bb'   && prop.draftKey === 'bb')   share = 1;
        else if (memoType === 'holl' && prop.draftKey === 'holl') share = 1;

        if (share > 0 && prop.categories[cat]) {
          const field = prop.categories[cat];
          totals[field] = (totals[field] || 0) + Math.abs(item.amount) * share;
        }
      }
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v / 1000]));
}

// ── Main handler ───────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const ynabToken       = process.env.YNAB_TOKEN;
  const hospToken       = process.env.HOSPITABLE_TOKEN;
  const { quarterEnd }  = req.body || {};

  if (!ynabToken)    return res.status(500).json({ error: 'YNAB_TOKEN not set' });
  if (!quarterEnd)   return res.status(400).json({ error: 'quarterEnd required' });

  const { q, year, qStart, qEnd, days } = quarterForDate(quarterEnd);
  const warnings = [];
  const draft    = {};
  const sources  = {};

  function set(field, value, source) {
    draft[field]   = fmt(value);
    sources[field] = source;
  }
  function setRaw(field, value, source) {
    draft[field]   = String(value);
    sources[field] = source;
  }

  try {
    // ── Round 1: parallel fetches ────────────────────────────────────────────
    const [accounts, allTxns, hospData] = await Promise.all([
      getAccounts(ynabToken),
      getAllTransactions(ynabToken, qStart),
      hospToken
        ? hospGet('/properties', hospToken, { per_page: 100 }).catch(() => null)
        : Promise.resolve(null),
    ]);

    const accountMap = Object.fromEntries(accounts.map(a => [a.id, a]));

    // ── YNAB single accounts (balance reversal) ──────────────────────────────
    for (const [field, id] of Object.entries(YNAB_SINGLE)) {
      const acct = accountMap[id];
      if (!acct) { warnings.push(`Account not found for ${field}`); continue; }
      const bal = balanceAtDate(acct, allTxns, qEnd);
      // Mortgages are liabilities — store as positive (balance is negative in YNAB)
      set(field, Math.abs(bal), 'YNAB');
    }

    // ── YNAB grouped accounts ────────────────────────────────────────────────
    for (const [field, hints] of Object.entries(YNAB_GROUPED)) {
      const matched = accounts.filter(a =>
        hints.some(h => (a.name || '').toLowerCase().includes(h))
      );
      const total = matched.reduce((s, a) => s + balanceAtDate(a, allTxns, qEnd), 0);
      set(field, Math.abs(total), 'YNAB');
    }

    // ── Property expenses (memo-tagged) ─────────────────────────────────────
    const expenses = calcPropertyExpenses(allTxns, qStart, qEnd);
    for (const [field, amount] of Object.entries(expenses)) {
      set(field, amount, 'YNAB');
    }

    // ── Additional savings ───────────────────────────────────────────────────
    let savingsTotal = 0;
    for (const cfg of SAVINGS_ACCOUNTS) {
      savingsTotal += calcSavings(accounts, allTxns, qStart, qEnd, cfg);
    }
    set('s_other', savingsTotal, 'YNAB');

    // ── Non-mortgage debt ────────────────────────────────────────────────────
    // d_other already handled in grouped above

    // ── Hospitable ───────────────────────────────────────────────────────────
    if (hospData) {
      const properties = hospData.data || [];
      const bbHints    = ['bison'];
      const hollHints  = ['holladay', '6320', '2123'];

      const findProp = hints => properties.find(p => {
        const name = (p.name || p.nickname || '').toLowerCase();
        return hints.some(h => name.includes(h));
      });

      const bbProp   = findProp(bbHints);
      const hollProp = findProp(hollHints);

      const propCalls = [];
      if (bbProp)   propCalls.push(fetchStrQuarter(hospToken, bbProp.uuid || bbProp.id, qStart, qEnd, days));
      if (hollProp) propCalls.push(fetchStrQuarter(hospToken, hollProp.uuid || hollProp.id, qStart, qEnd, days));

      const [bbResult, hollResult] = await Promise.all(propCalls);

      if (bbResult) {
        set('bb_revenue',      bbResult.revenue,      'Hospitable');
        setRaw('bb_nights_booked', bbResult.nights,   'Hospitable');
        setRaw('bb_nights_avail',  bbResult.daysAvail,'Hospitable');
        set('bb_platform',     bbResult.platformFees, 'Hospitable');
      }
      if (hollResult) {
        set('holl_rent',           hollResult.revenue,      'Hospitable (STR only — add MTR)');
        setRaw('holl_nights_booked', hollResult.nights,     'Hospitable (STR only — add MTR)');
        setRaw('holl_nights_avail',  hollResult.daysAvail,  'Hospitable');
        set('holl_platform',         hollResult.platformFees,'Hospitable');
      }
    } else {
      warnings.push('HOSPITABLE_TOKEN not set — STR data skipped');
    }

    // ── Reconciliation warnings ──────────────────────────────────────────────
    for (const [field, id] of Object.entries(YNAB_SINGLE)) {
      const acct = accountMap[id];
      if (!acct?.last_reconciled_at) continue;
      const recDate = acct.last_reconciled_at.slice(0, 10);
      if (recDate < qEnd) {
        warnings.push(`${acct.name} last reconciled ${recDate} — balance may be approximate`);
      }
    }

    return res.status(200).json({ draft, sources, warnings, quarter: `Q${q} ${year}` });

  } catch (err) {
    console.error('[/api/prefill]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
