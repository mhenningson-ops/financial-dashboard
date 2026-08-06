// GET /api/data  — read Financial Review.json from Google Drive
// POST /api/data — write Financial Review.json back to Google Drive

const { google } = require('googleapis');

const FILE_ID = process.env.DRIVE_FILE_ID;

function getDrive() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!FILE_ID) return res.status(500).json({ error: 'DRIVE_FILE_ID not set' });

  try {
    const drive = getDrive();

    if (req.method === 'GET') {
      const response = await drive.files.get(
        { fileId: FILE_ID, alt: 'media' },
        { responseType: 'json' }
      );
      return res.status(200).json(response.data);
    }

    if (req.method === 'POST') {
      const { Readable } = require('stream');
      const body = JSON.stringify(req.body, null, 2);
      const stream = Readable.from([body]);
      await drive.files.update({
        fileId: FILE_ID,
        media: { mimeType: 'application/json', body: stream },
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[/api/data]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
