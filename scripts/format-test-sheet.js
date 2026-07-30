#!/usr/bin/env node
// Apply the team's existing "AI Testing" sheet visual format to a sheet tab that already has data
// written in the No/Page/Sections/Status/Test note/Reopen note layout (see log-to-sheet.js) —
// copied from the real formatting found on the "[FC148] AI Testing" tab (read via the Sheets API,
// not guessed): a merged white title cell + merged green round/theme cell across rows 1-2, a green
// bold-white column-header row, and a validated dropdown (with conditional-format colors as a
// fallback, since the exact native dropdown "chip" colors aren't exposed through the public
// Sheets API) on the Status column.
//
// Usage:
//   node scripts/format-test-sheet.js <spreadsheetId> <sheetName> <dataRowCount>
//   dataRowCount: number of data rows under the header (rows 4..3+dataRowCount get the Status
//   dropdown + conditional formatting applied).
require('dotenv').config({ quiet: true });
const { google } = require('googleapis');

const [, , spreadsheetId, sheetName, dataRowCountArg] = process.argv;
const dataRowCount = parseInt(dataRowCountArg, 10);

if (!spreadsheetId || !sheetName || !dataRowCount) {
  console.error('Usage: node scripts/format-test-sheet.js <spreadsheetId> <sheetName> <dataRowCount>');
  process.exit(1);
}

const GREEN = { red: 0.41568628, green: 0.65882355, blue: 0.30980393 };
const WHITE = { red: 1, green: 1, blue: 1 };
const HEADER_TEXT_FORMAT = {
  foregroundColor: WHITE,
  fontFamily: 'Calibri',
  fontSize: 12,
  bold: true,
};

const STATUS_COLORS = {
  PASS: { red: 0.71, green: 0.84, blue: 0.66 },
  Reopen: { red: 0.92, green: 0.6, blue: 0.6 },
  Review: { red: 0.8, green: 0.65, blue: 0.83 },
  'Note for SA': { red: 0.95, green: 0.87, blue: 0.68 },
  Skip: { red: 0.6, green: 0.6, blue: 0.6 },
  'Tester done setup': { red: 0.85, green: 0.92, blue: 0.83 },
};

(async () => {
  try {
    const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
    const auth = new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetInfo = meta.data.sheets.find((s) => s.properties.title === sheetName);
    if (!sheetInfo) {
      console.error(`ERROR: sheet tab "${sheetName}" not found in this spreadsheet.`);
      process.exit(1);
    }
    const sheetId = sheetInfo.properties.sheetId;

    const headerRowFormat = (bgColor) => ({
      backgroundColor: bgColor,
      horizontalAlignment: 'CENTER',
      wrapStrategy: 'WRAP',
      textFormat: bgColor === GREEN ? HEADER_TEXT_FORMAT : undefined,
    });

    const dataStartRow = 3; // 0-based index of first data row (row 4 in the sheet, 1-based)
    const dataEndRow = dataStartRow + dataRowCount; // exclusive

    const requests = [
      // Row 1-2 title block: A1:D2 merged white, E1:F2 merged green+bold white text
      { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 4 }, mergeType: 'MERGE_ALL' } },
      { mergeCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 4, endColumnIndex: 6 }, mergeType: 'MERGE_ALL' } },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 4 },
          cell: { userEnteredFormat: { backgroundColor: WHITE, wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE' } },
          fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment)',
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 4, endColumnIndex: 7 },
          cell: { userEnteredFormat: { backgroundColor: GREEN, wrapStrategy: 'WRAP', verticalAlignment: 'MIDDLE', textFormat: HEADER_TEXT_FORMAT } },
          fields: 'userEnteredFormat(backgroundColor,wrapStrategy,verticalAlignment,textFormat)',
        },
      },
      // Row 3 column headers, all green + bold white + centered; B3:D3 merged ("Page/Sections")
      { mergeCells: { range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 4 }, mergeType: 'MERGE_ALL' } },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 7 },
          cell: { userEnteredFormat: headerRowFormat(GREEN) },
          fields: 'userEnteredFormat(backgroundColor,horizontalAlignment,wrapStrategy,textFormat)',
        },
      },
      // Status column (E) dropdown validation across all data rows
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: dataStartRow, endRowIndex: dataEndRow, startColumnIndex: 4, endColumnIndex: 5 },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: Object.keys(STATUS_COLORS).map((v) => ({ userEnteredValue: v })),
            },
            strict: true,
            showCustomUi: true,
          },
        },
      },
      // Conditional formatting fallback: color the Status cell background by its exact text value
      ...Object.entries(STATUS_COLORS).map(([value, color]) => ({
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: dataStartRow, endRowIndex: dataEndRow, startColumnIndex: 4, endColumnIndex: 5 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
              format: { backgroundColor: color },
            },
          },
          index: 0,
        },
      })),
      // Column widths: keep Page/Sections and note columns readable
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 7 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } },
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 4 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    ];

    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    console.log(`Formatted "${sheetName}": header rows styled, Status dropdown + colors applied to rows 4-${dataEndRow}.`);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
})();
