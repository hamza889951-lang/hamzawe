/**
 * HAMZAWE — Conversations write-path diagnostic
 *
 * Run manually from the Apps Script editor:
 *   runConversationsWriteDiagnostic
 *
 * Purpose:
 * - Does NOT call doPost, doGet, or send a WhatsApp message.
 * - Does NOT write cell values or delete/append rows.
 * - Probes the exact per-cell setNumberFormat('@') operation used by
 *   GoogleSheets.appendRow / GoogleSheets.updateRowByColumn.
 * - Temporarily applies a number format only when allowed, then restores the
 *   original format immediately. All failures are captured with stack details.
 * - Logs column header, A1 cell, row, phase, original format and full exception.
 *
 * Note: Google Sheets may reject formatting in typed/classified table columns.
 * Formatting probes are temporary; this diagnostic is not a production fix.
 */

var ConversationsWriteDiagnostic = (function () {
  var TAG = 'HAMZAWE_CONVERSATIONS_WRITE_DIAGNOSTIC';

  function errorDetails(error) {
    return {
      name: error && error.name ? String(error.name) : 'Error',
      message: error && error.message ? String(error.message) : String(error),
      stack: error && error.stack ? String(error.stack) : '(no stack supplied by runtime)'
    };
  }

  function emit(event) {
    event.tag = TAG;
    event.timestamp = new Date().toISOString();
    var line;
    try {
      line = JSON.stringify(event);
    } catch (serializationError) {
      line = TAG + ' SERIALIZATION_FAILURE ' + String(serializationError);
    }
    console.log(line);
    Logger.log(line);
  }

  function spreadsheetForDiagnostic() {
    var spreadsheetId = '';
    try {
      spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || '';
    } catch (e) {
      emit({ phase: 'IDENTITY', status: 'SCRIPT_PROPERTY_READ_FAILED', error: errorDetails(e) });
    }

    if (spreadsheetId) {
      return {
        spreadsheet: SpreadsheetApp.openById(spreadsheetId),
        source: 'ScriptProperties.SPREADSHEET_ID',
        configuredId: spreadsheetId
      };
    }

    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (!active) {
      throw new Error('DIAGNOSTIC_NO_SPREADSHEET: SPREADSHEET_ID is empty and no active spreadsheet is available.');
    }
    return {
      spreadsheet: active,
      source: 'SpreadsheetApp.getActiveSpreadsheet',
      configuredId: ''
    };
  }

  function findConversationsSheet(spreadsheet) {
    var exactCandidates = ['conversations', 'Conversations'];
    for (var i = 0; i < exactCandidates.length; i++) {
      var exact = spreadsheet.getSheetByName(exactCandidates[i]);
      if (exact) return exact;
    }

    var sheets = spreadsheet.getSheets();
    for (var j = 0; j < sheets.length; j++) {
      if (String(sheets[j].getName()).toLowerCase() === 'conversations') {
        return sheets[j];
      }
    }
    return null;
  }

  function a1For(sheet, row, column) {
    return sheet.getRange(row, column).getA1Notation();
  }

  function probeCell(sheet, row, column, header, phase) {
    var range;
    var beforeFormat;
    var changed = false;
    var result = {
      phase: phase,
      status: 'STARTED',
      sheet: sheet.getName(),
      row: row,
      column: column,
      header: String(header == null ? '' : header),
      a1: ''
    };

    try {
      range = sheet.getRange(row, column);
      result.a1 = a1For(sheet, row, column);
      beforeFormat = range.getNumberFormats()[0][0];
      result.originalNumberFormat = beforeFormat;

      try {
        range.setNumberFormat('@');
        changed = true;
        result.status = 'FORMAT_SET_SUCCEEDED';
      } catch (formatError) {
        result.status = 'FORMAT_SET_FAILED';
        result.error = errorDetails(formatError);

        // Test the repair helper, if this source version exposes it. This is
        // deliberately separate from the raw call so we can see whether the
        // helper catches this exact runtime error or rethrows it.
        try {
          if (typeof GoogleSheets !== 'undefined' &&
              GoogleSheets &&
              typeof GoogleSheets._setTextFormatIfSupported === 'function') {
            result.helperAvailable = true;
            try {
              result.helperReturn = GoogleSheets._setTextFormatIfSupported(range);
              result.helperStatus = 'RETURNED';
            } catch (helperError) {
              result.helperStatus = 'THREW';
              result.helperError = errorDetails(helperError);
            }
          } else {
            result.helperAvailable = false;
          }
        } catch (helperProbeError) {
          result.helperProbeError = errorDetails(helperProbeError);
        }
      }

      if (changed) {
        try {
          range.setNumberFormat(beforeFormat);
          result.restoreStatus = 'RESTORED';
        } catch (restoreError) {
          result.restoreStatus = 'RESTORE_FAILED';
          result.restoreError = errorDetails(restoreError);
          result.status = 'CRITICAL_FORMAT_RESTORE_FAILURE';
        }
      } else {
        result.restoreStatus = 'NOT_NEEDED_FORMAT_CALL_FAILED';
      }
    } catch (outerError) {
      result.status = 'PROBE_SETUP_FAILED';
      result.error = errorDetails(outerError);
    }

    emit(result);
    return result;
  }

  function run() {
    var startedAt = new Date();
    var report = {
      diagnostic: TAG,
      startedAt: startedAt.toISOString(),
      scriptId: '',
      spreadsheetId: '',
      spreadsheetName: '',
      spreadsheetSource: '',
      sheetName: '',
      lastRow: null,
      lastColumn: null,
      headerCount: 0,
      probes: 0,
      formatFailures: 0,
      restoreFailures: 0,
      fatalError: null
    };

    emit({
      phase: 'START',
      status: 'STARTED',
      message: 'Read-only write-path diagnostic; no doPost invocation and no cell values are written.'
    });

    try {
      try {
        report.scriptId = ScriptApp.getScriptId() || '';
      } catch (scriptIdError) {
        emit({ phase: 'IDENTITY', status: 'SCRIPT_ID_UNAVAILABLE', error: errorDetails(scriptIdError) });
      }

      var resolved = spreadsheetForDiagnostic();
      var spreadsheet = resolved.spreadsheet;
      report.spreadsheetName = spreadsheet.getName();
      report.spreadsheetSource = resolved.source;
      report.spreadsheetId = spreadsheet.getId();

      emit({
        phase: 'IDENTITY',
        status: 'OK',
        scriptId: report.scriptId,
        spreadsheetName: report.spreadsheetName,
        spreadsheetId: report.spreadsheetId,
        spreadsheetSource: report.spreadsheetSource,
        configuredSpreadsheetIdMatchesOpenedSpreadsheet:
          !resolved.configuredId || resolved.configuredId === report.spreadsheetId
      });

      var sheet = findConversationsSheet(spreadsheet);
      if (!sheet) {
        throw new Error('CONVERSATIONS_SHEET_NOT_FOUND: searched for conversations case-insensitively in spreadsheet "' +
          report.spreadsheetName + '".');
      }

      report.sheetName = sheet.getName();
      report.lastRow = sheet.getLastRow();
      report.lastColumn = sheet.getLastColumn();

      if (report.lastColumn < 1 || report.lastRow < 1) {
        throw new Error('CONVERSATIONS_SHEET_EMPTY: no header row/columns found.');
      }

      var headers = sheet.getRange(1, 1, 1, report.lastColumn).getDisplayValues()[0];
      report.headerCount = headers.length;

      emit({
        phase: 'SHEET_DISCOVERY',
        status: 'OK',
        sheetName: report.sheetName,
        lastRow: report.lastRow,
        lastColumn: report.lastColumn,
        headerCount: report.headerCount,
        message: 'Headers are logged by name only; cell contents such as phone numbers are not read or logged.'
      });

      // Phase 1: inspect a populated row, where table/typed-column restrictions
      // are expected to be visible without writing business data.
      var existingRows = [];
      if (report.lastRow >= 2) existingRows.push({ row: 2, phase: 'UPDATE_ROW_BY_COLUMN_SIMULATION_FIRST_DATA' });
      if (report.lastRow >= 3) existingRows.push({ row: report.lastRow, phase: 'UPDATE_ROW_BY_COLUMN_SIMULATION_LAST_DATA' });

      for (var r = 0; r < existingRows.length; r++) {
        for (var c = 1; c <= report.lastColumn; c++) {
          var first = probeCell(sheet, existingRows[r].row, c, headers[c - 1], existingRows[r].phase);
          report.probes++;
          if (first.status === 'FORMAT_SET_FAILED' || first.status === 'PROBE_SETUP_FAILED') report.formatFailures++;
          if (first.status === 'CRITICAL_FORMAT_RESTORE_FAILURE') report.restoreFailures++;
        }
      }

      // Phase 2: inspect the exact row GoogleSheets.appendRow would target.
      // Values are never written. Every successful temporary format is restored.
      var appendRow = report.lastRow + 1;
      if (appendRow > sheet.getMaxRows()) {
        emit({
          phase: 'APPEND_ROW_SIMULATION',
          status: 'SKIPPED_NO_GRID_ROW',
          appendRow: appendRow,
          maxRows: sheet.getMaxRows(),
          message: 'The sheet has no pre-existing grid row available for a non-value-writing append probe.'
        });
      } else {
        for (var ac = 1; ac <= report.lastColumn; ac++) {
          var appendProbe = probeCell(sheet, appendRow, ac, headers[ac - 1], 'APPEND_ROW_SIMULATION');
          report.probes++;
          if (appendProbe.status === 'FORMAT_SET_FAILED' || appendProbe.status === 'PROBE_SETUP_FAILED') report.formatFailures++;
          if (appendProbe.status === 'CRITICAL_FORMAT_RESTORE_FAILURE') report.restoreFailures++;
        }
      }

      report.status = report.restoreFailures > 0
        ? 'CRITICAL_RESTORE_FAILURE'
        : (report.formatFailures > 0 ? 'FORMAT_RESTRICTION_FOUND' : 'NO_FORMAT_RESTRICTION_REPRODUCED');

      emit({
        phase: 'SUMMARY',
        status: report.status,
        probes: report.probes,
        formatFailures: report.formatFailures,
        restoreFailures: report.restoreFailures,
        sheetName: report.sheetName,
        lastRow: report.lastRow,
        lastColumn: report.lastColumn,
        elapsedMs: new Date().getTime() - startedAt.getTime(),
        interpretation: report.formatFailures > 0
          ? 'Inspect FORMAT_SET_FAILED events. Each event identifies the exact sheet, row, column, header, A1 cell and exception stack.'
          : 'The specific per-cell format restriction was not reproduced in probed cells. The failure may originate in another write call/site or a different spreadsheet/deployment.'
      });

    } catch (fatalError) {
      report.status = 'FATAL_DIAGNOSTIC_ERROR';
      report.fatalError = errorDetails(fatalError);
      emit({
        phase: 'FATAL',
        status: report.status,
        error: report.fatalError,
        partialReport: report
      });
    }

    report.finishedAt = new Date().toISOString();
    return report;
  }

  return { run: run };
})();

/**
 * Select this function in Apps Script and click Run.
 * The detailed per-cell report is emitted to Execution log / Cloud Logging.
 */
function runConversationsWriteDiagnostic() {
  return ConversationsWriteDiagnostic.run();
}
