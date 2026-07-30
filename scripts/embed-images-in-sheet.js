#!/usr/bin/env node
// Upload local PNG screenshots (Figma renders + live theme captures) to Google Drive using the
// same Service Account already set up for log-to-sheet.js/format-test-sheet.js, then write an
// `=IMAGE(url)` formula into the given Sheets cells so the Auto-verify FE report shows the actual
// Figma-vs-live images side by side, not just text notes.
//
// Requires the Google Drive API enabled on the same GCP project as the Sheets API (one-time,
// console.cloud.google.com -> APIs & Services -> enable "Google Drive API").
//
// Each uploaded file is set to "anyone with the link can view" — required for Sheets' own servers
// to be able to fetch the image over plain HTTP when rendering `=IMAGE()`; only screenshots/design
// renders should go through this script, never anything sensitive.
//
// CONFIRMED REAL: Service Accounts have NO Drive storage quota of their own (Google blocks this to
// prevent abuse) — uploading only works into a Shared Drive the service account has been added to
// (needs Google Workspace) or via domain-wide delegation. On a plain personal Gmail account with no
// Shared Drive available, this script's upload step will fail with "Service Accounts do not have
// storage quota" — there is no workaround short of Workspace access. The fallback used in that case
// on this project: build a self-contained HTML gallery (base64-embedded images, see the FC-166
// round) and link it from the sheet instead of embedding images per cell.
//
// LOCALE GOTCHA (confirmed real, cost a broken formula once): any multi-argument formula written
// via the Sheets API (e.g. `=HYPERLINK(url, label)`) must use the spreadsheet's OWN locale argument
// separator, not always a comma — a `vi_VN`-locale spreadsheet expects `;` between arguments
// (`=HYPERLINK(url; label)`), and a comma there silently becomes a "Formula parse error" cell
// instead of a working link. Check `spreadsheets.get(...).data.properties.locale` before writing
// any multi-arg formula, don't assume comma.
//
// Usage:
//   node scripts/embed-images-in-sheet.js <spreadsheetId> <sheetName> <mappingJsonFile>
//   mappingJsonFile: JSON array of { "cell": "H4", "path": "/abs/path/to/image.png" }
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const [, , spreadsheetId, sheetName, mappingFile] = process.argv;

if (!spreadsheetId || !sheetName || !mappingFile) {
  console.error('Usage: node scripts/embed-images-in-sheet.js <spreadsheetId> <sheetName> <mappingJsonFile>');
  process.exit(1);
}

(async () => {
  try {
    const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
    const auth = new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
      ],
    });
    const drive = google.drive({ version: 'v3', auth });
    const sheets = google.sheets({ version: 'v4', auth });

    const mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
    const data = [];

    for (const { cell, path: filePath } of mapping) {
      if (!fs.existsSync(filePath)) {
        console.error(`SKIP ${cell}: file not found -> ${filePath}`);
        continue;
      }
      const uploaded = await drive.files.create({
        requestBody: { name: path.basename(filePath) },
        media: { mimeType: 'image/png', body: fs.createReadStream(filePath) },
        fields: 'id',
      });
      const fileId = uploaded.data.id;
      await drive.permissions.create({
        fileId,
        requestBody: { role: 'reader', type: 'anyone' },
      });
      const imageUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
      data.push({
        range: `'${sheetName}'!${cell}`,
        values: [[`=IMAGE("${imageUrl}")`]],
      });
      console.log(`${cell} -> uploaded ${path.basename(filePath)} (${fileId})`);
    }

    if (data.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    }
    console.log(`Done: embedded ${data.length}/${mapping.length} image(s).`);
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.message.includes('Drive API has not been used') || err.message.includes('disabled')) {
      console.error('-> Enable the Drive API on this project, then retry.');
    }
    process.exit(1);
  }
})();
