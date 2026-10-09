/**
 * HAMZAWE — Conversations write-path deployment diagnostic
 *
 * Safe inspection only:
 * - Does not read or change cell number formats.
 * - Does not write values, append rows, call doPost, or send WhatsApp messages.
 * - Reports the configured spreadsheet, Conversations headers, and whether the
 *   deployed GoogleSheets object exposes the classified-column guard.
 *
 * Run: runConversationsWriteDiagnostic
 */
function runConversationsWriteDiagnostic() {
  var report = {
    tag: 'HAMZAWE_CONVERSATIONS_WRITE_DIAGNOSTIC',
    startedAt: new Date().toISOString(),
    scriptId: '',
    spreadsheetId: '',
    spreadsheetName: '',
    spreadsheetSource: '',
    sheetName: '',
    lastRow: null,
    lastColumn: null,
    headers: [],
    guardAvailable: false,
    status: 'STARTED',
    errors: []
  };

  function emit(event) {
    event.tag = report.tag;
    event.timestamp = new Date().toISOString();
    var line = JSON.stringify(event);
    console.log(line);
    Logger.log(line);
  }

  try {
    report.scriptId = ScriptApp.getScriptId() || '';

    var configuredId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';
    var spreadsheet;
    if (configuredId) {
      spreadsheet = SpreadsheetApp.openById(configuredId);
      report.spreadsheetSource = 'ScriptProperties.SPREADSHEET_ID';
    } else {
      spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      report.spreadsheetSource = 'SpreadsheetApp.getActiveSpreadsheet';
    }
    if (!spreadsheet) throw new Error('DIAGNOSTIC_NO_SPREADSHEET');

    report.spreadsheetId = spreadsheet.getId();
    report.spreadsheetName = spreadsheet.getName();

    var sheet = spreadsheet.getSheetByName('Conversations') ||
      spreadsheet.getSheetByName('conversations');
    if (!sheet) throw new Error('CONVERSATIONS_SHEET_NOT_FOUND');

    report.sheetName = sheet.getName();
    report.lastRow = sheet.getLastRow();
    report.lastColumn = sheet.getLastColumn();
    if (report.lastColumn < 1 || report.lastRow < 1) {
      throw new Error('CONVERSATIONS_SHEET_HAS_NO_HEADER_ROW');
    }

    report.headers = sheet.getRange(1, 1, 1, report.lastColumn).getDisplayValues()[0];
    report.guardAvailable = typeof GoogleSheets !== 'undefined' &&
      GoogleSheets &&
      typeof GoogleSheets._setTextFormatIfSupported === 'function';

    report.status = report.guardAvailable ? 'RUNTIME_GUARD_PRESENT' : 'RUNTIME_GUARD_MISSING';
    emit({
      phase: 'SUMMARY',
      status: report.status,
      scriptId: report.scriptId,
      spreadsheetId: report.spreadsheetId,
      spreadsheetName: report.spreadsheetName,
      spreadsheetSource: report.spreadsheetSource,
      configuredSpreadsheetIdMatchesOpenedSpreadsheet:
        !configuredId || configuredId === report.spreadsheetId,
      sheetName: report.sheetName,
      lastRow: report.lastRow,
      lastColumn: report.lastColumn,
      headers: report.headers,
      guardAvailable: report.guardAvailable,
      note: 'Safe inspection only. No cell formatting or values were read or changed. This confirms runtime wiring, not successful production writes.'
    });
  } catch (e) {
    report.status = 'DIAGNOSTIC_FAILED';
    report.errors.push({
      name: e && e.name ? String(e.name) : 'Error',
      message: e && e.message ? String(e.message) : String(e),
      stack: e && e.stack ? String(e.stack) : ''
    });
    emit({ phase: 'FATAL', status: report.status, errors: report.errors });
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
