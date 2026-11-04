// One-time patch: fix known Claude extraction errors in monthly data
// - Bradcliff Sep 2026: income.rent was 0 (AHI not merged); fix to 1450
// - Bradcliff Oct 2026: income.rent was 313 (AHI portion missing); fix to 1450
// - Neely Oct 2026: income.other was 955 (YTD figure, not period); fix to 0, gross to 0

const { google } = require('googleapis');
const path = require('path');
const { Readable } = require('stream');

const DRIVE_FILE_ID = '1bQmY9f4Z-Ehjrsm8nefbT8CamC-2-kOC';
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '../../Accounting/service_account.json');
const DRY_RUN = process.argv.includes('--dry-run');

const PATCHES = [
  {
    month: 'Sep 2026',
    prop: 'bradcliff',
    apply(p) {
      p.income.rent = 1450; // AHI $1,450 is lease-based, belongs in income.rent
    },
  },
  {
    month: 'Oct 2026',
    prop: 'bradcliff',
    apply(p) {
      p.income.rent = 1450; // tenant $313 + AHI $1,137 = full gross; both lease-based
    },
  },
  {
    month: 'Oct 2026',
    prop: 'neely',
    apply(p) {
      p.income.other = 0;  // $955 was YTD "Tenant damages" figure, not Oct period amount
      p.income.gross = 0;  // no income this month (vacancy); netCF sourced from statement, unchanged
    },
  },
];

async function main() {
  const credentials = require(SERVICE_ACCOUNT_PATH);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.get(
    { fileId: DRIVE_FILE_ID, alt: 'media' },
    { responseType: 'json' }
  );
  const data = res.data;

  const storageKey = 'cordoba_fin_v1';
  const months = data[storageKey]?.months ?? data.months ?? [];

  for (const patch of PATCHES) {
    const entry = months.find(m => m.month === patch.month);
    if (!entry) { console.warn(`Month not found: ${patch.month}`); continue; }
    const prop = entry.properties?.[patch.prop];
    if (!prop) { console.warn(`Property not found: ${patch.prop} in ${patch.month}`); continue; }

    const before = JSON.stringify(prop.income);
    patch.apply(prop);
    console.log(`[${patch.month}] ${patch.prop}: ${before} → ${JSON.stringify(prop.income)}`);
  }

  if (DRY_RUN) {
    console.log('\nDry run — no changes written.');
    return;
  }

  if (data[storageKey]) data[storageKey].months = months;
  else data.months = months;

  await drive.files.update({
    fileId: DRIVE_FILE_ID,
    media: { mimeType: 'application/json', body: Readable.from([JSON.stringify(data, null, 2)]) },
  });
  console.log('\nDrive file updated.');
}

main().catch(err => { console.error(err); process.exit(1); });
