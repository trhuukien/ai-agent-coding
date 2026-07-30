#!/usr/bin/env node
// Append rows to a Google Sheet using a Service Account (never a public "Anyone" link) — used to
// log step 7's Auto-verify FE results (or any other structured test/report data) into a shared
// tracking sheet. The Sheet must be shared with the service account's own email as Editor; nobody
// else gets access via this path, unlike a public Apps Script Web App URL.
//
// Setup (one-time, see .env.example):
//   1. Google Cloud Console -> enable "Google Sheets API" on a project.
//   2. IAM & Admin -> Service Accounts -> create one -> Keys -> Add key -> JSON -> download it.
//   3. Share the target Sheet with that service account's email (Editor).
//   4. Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH in .env to the downloaded JSON file's path.
//      NEVER commit that JSON file — add its filename to .gitignore.
//
// Usage:
//   node scripts/log-to-sheet.js <spreadsheetId> <sheetName> <rowsJsonFile>
//   spreadsheetId: the id segment from the sheet's URL
//     (https://docs.google.com/spreadsheets/d/<spreadsheetId>/edit...)
//   sheetName: the tab name to append to (e.g. "Sheet1")
//   rowsJsonFile: a JSON file containing either one row (a flat array of cell values) or multiple
//     rows (an array of arrays) — each inner array becomes one appended row, left to right.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { google } = require('googleapis');

const [, , spreadsheetId, sheetName, rowsJsonFile] = process.argv;

if (!spreadsheetId || !sheetName || !rowsJsonFile) {
  console.error('Usage: node scripts/log-to-sheet.js <spreadsheetId> <sheetName> <rowsJsonFile>');
  process.exit(1);
}

const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
if (!keyPath) {
  console.error('ERROR: GOOGLE_SERVICE_ACCOUNT_KEY_PATH is not set in .env.');
  process.exit(1);
}

(async () => {
  try {
    const rawRows = JSON.parse(fs.readFileSync(rowsJsonFile, 'utf8'));
    const rows = Array.isArray(rawRows[0]) ? rawRows : [rawRows];

    const auth = new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // GOTCHA (confirmed real, cost a real header row once): the Sheets API's own append logic
    // finds "the next row after the last contiguous non-empty row" starting from this anchor — it
    // does NOT look past a blank row to see if there's more real data (like a column-header row)
    // further down. If this sheet has a genuinely blank spacer row anywhere above where you expect
    // to append (e.g. a title row, then a blank row, then a header row, then data), append will
    // stop at that blank row and OVERWRITE everything below it, including the header row. Always
    // verify with values.get first when appending to a sheet that has any non-trivial structure
    // above the data rows — don't assume append "just finds the end" on a sheet like that.
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });

    console.log(
      `Appended ${rows.length} row(s) to "${sheetName}" -> ${result.data.updates.updatedRange}`
    );
  } catch (err) {
    if (err.code === 403 || /permission/i.test(err.message)) {
      console.error(
        'ERROR: permission denied — make sure the target Sheet is shared with the service ' +
          "account's email (Editor access), not just created/owned by a different account."
      );
    }
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
