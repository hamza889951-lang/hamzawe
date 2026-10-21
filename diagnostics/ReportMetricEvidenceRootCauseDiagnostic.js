/**
 * HAMZAWE — Report Metric Evidence Root-Cause Diagnostic
 * Diagnostic-only file. Safe to sync into Apps Script and run manually.
 *
 * PURPOSE
 *   Capture the actual runtime failure boundary behind report-generation
 *   failures such as METRIC_EVIDENCE_INVALID without changing production
 *   calculations, sheet contents, settings, appointments, or messaging.
 *
 * ENTRY POINT
 *   runHamzaweReportMetricEvidenceDiagnostic()
 *
 * SAFETY
 *   - Read-only: report services and AttendanceAuditReadRepository only.
 *   - Does not write Sheets, send WhatsApp messages, mutate state, or deploy.
 *   - Does not print raw audit rows, slot IDs, operator IDs, patient data,
 *     raw timestamp values, credentials, or script properties.
 *   - Logs only allowlisted failure fields and timestamp type/validity.
 *
 * IMPORTANT
 *   Run this against the same Apps Script project/deployment that produced
 *   the failing reports. The returned source marker identifies this diagnostic
 *   file, not the deployed application's commit SHA; Apps Script does not
 *   expose a trustworthy Git commit SHA through these application APIs.
 */

var HAMZAWE_REPORT_DIAGNOSTIC_MARKER = 'REPORT-METRIC-EVIDENCE-DIAG-v1';

function runHamzaweReportMetricEvidenceDiagnostic() {
  var startedAt = new Date();
  var report = {
    diagnostic: HAMZAWE_REPORT_DIAGNOSTIC_MARKER,
    startedAtUtc: startedAt.toISOString(),
    mode: 'READ_ONLY',
    productionCalculationsChanged: false,
    sheetWrites: 0,
    messagesSent: 0,
    sourceCommitSha: 'NOT_AVAILABLE_FROM_APPS_SCRIPT_RUNTIME',
    checks: {},
    reportRuns: []
  };

  try {
    var required = [
      'Clock', 'Result', 'AttendanceAuditReadRepository',
      'MetricsService', 'ReportPeriod', 'ReportService',
      'EnhancedReportService'
    ];
    var missing = [];
    for (var i = 0; i < required.length; i++) {
      if (typeof this[required[i]] === 'undefined') missing.push(required[i]);
    }
    // Apps Script top-level const declarations are not guaranteed to be
    // properties of globalThis; actual references below are the authoritative
    // dependency check. Keep the initial check informational only.
    report.checks.dependencyProbe = {
      globalPropertyProbeMissing: missing,
      note: 'Global property probes can be false negatives for top-level const; direct calls below determine availability.'
    };

    report.checks.runtimeCodePathSignature = _hamzaweReportDiagRuntimeCodePathSignature();

    var reference = Clock.now();
    var referenceMs = reference.getTime();
    report.reference = {
      type: Object.prototype.toString.call(reference),
      finiteEpochMs: typeof referenceMs === 'number' && isFinite(referenceMs)
    };

    // Read-only inspect of the exact evidence rows used by the M1 metric.
    var auditResult = AttendanceAuditReadRepository.readAll();
    if (!auditResult || auditResult.ok !== true || !Array.isArray(auditResult.data)) {
      report.checks.attendanceAuditRead = {
        ok: false,
        failure: _hamzaweReportDiagFailure(auditResult)
      };
    } else {
      var rows = auditResult.data;
      var firstApplied = null;
      var firstAppliedOrder = null;
      for (var a = 0; a < rows.length; a++) {
        if (!rows[a] || rows[a].outcome !== MetricsService.AUDIT_OUTCOMES.APPLIED) continue;
        var order = MetricsService._rowOrder(rows[a], a);
        if (firstApplied === null || order < firstAppliedOrder) {
          firstApplied = rows[a];
          firstAppliedOrder = order;
        }
      }

      var ts = firstApplied ? firstApplied.timestamp : null;
      var timestampType = ts instanceof Date ? 'Date'
        : (ts === null ? 'null' : typeof ts);
      var dateMs = ts instanceof Date ? ts.getTime() : null;
      var metricEpochMs = firstApplied ? MetricsService._rowMs(ts) : null;

      // Read-only storage probe: distinguish a date-only text cell from
      // a Date-backed cell merely displayed without a time. No raw value,
      // formula, identifiers, or row content is logged.
      var timestampStorageProbe = null;
      try {
        var auditSheet = GoogleSheets._getSheet('ATTENDANCE_AUDIT');
        var auditHeaders = GoogleSheets.getHeaders('ATTENDANCE_AUDIT');
        var timestampColumn = auditHeaders.indexOf('timestamp') + 1;
        if (firstApplied && firstApplied._rowNumber > 1 && timestampColumn > 0) {
          var timestampCell = auditSheet.getRange(firstApplied._rowNumber, timestampColumn);
          var displayValue = timestampCell.getDisplayValue();
          var formulaValue = timestampCell.getFormula();
          var numberFormat = timestampCell.getNumberFormat();
          timestampStorageProbe = {
            ok: true,
            cellNumberFormat: typeof numberFormat === 'string' ? numberFormat.slice(0, 40) : null,
            displayValueType: typeof displayValue,
            displayValueLength: typeof displayValue === 'string' ? displayValue.length : null,
            displayLooksDateOnly: typeof displayValue === 'string' && displayValue.trim().length === 10 &&
              (displayValue.trim().charAt(4) === '/' || displayValue.trim().charAt(4) === '-') &&
              (displayValue.trim().charAt(7) === '/' || displayValue.trim().charAt(7) === '-'),
            formulaPresent: typeof formulaValue === 'string' && formulaValue.length > 0
          };
        } else {
          timestampStorageProbe = { ok: false, reason: 'FIRST_APPLIED_ROW_OR_TIMESTAMP_COLUMN_NOT_RESOLVED' };
        }
      } catch (probeError) {
        timestampStorageProbe = {
          ok: false,
          errorName: probeError && probeError.name ? String(probeError.name).slice(0, 60) : 'Error'
        };
      }

      var appliedTimestampTypes = { date: 0, number: 0, string: 0, nullish: 0, other: 0 };
      var appliedStringShapes = { dateOnlySlashOrDash: 0, isoLike: 0, other: 0 };
      var appliedTimestampAcceptedCount = 0;
      for (var p = 0; p < rows.length; p++) {
        var candidate = rows[p];
        if (!candidate || candidate.outcome !== MetricsService.AUDIT_OUTCOMES.APPLIED) continue;
        var value = candidate.timestamp;
        if (value instanceof Date) appliedTimestampTypes.date++;
        else if (typeof value === 'number') appliedTimestampTypes.number++;
        else if (typeof value === 'string') {
          appliedTimestampTypes.string++;
          if (value.trim().length === 10 && (value.trim().charAt(4) === '/' || value.trim().charAt(4) === '-') && (value.trim().charAt(7) === '/' || value.trim().charAt(7) === '-')) appliedStringShapes.dateOnlySlashOrDash++;
          else if (/^\\d{4}-\\d{2}-\\d{2}T/.test(value.trim())) appliedStringShapes.isoLike++;
          else appliedStringShapes.other++;
        } else if (value === null || typeof value === 'undefined' || value === '') appliedTimestampTypes.nullish++;
        else appliedTimestampTypes.other++;
        if (MetricsService._rowMs(value) !== null) appliedTimestampAcceptedCount++;
      }

      var sheetsApiTimestampProbe = _hamzaweReportDiagSheetsApiTimestampProbe(rows, firstApplied);

      report.checks.attendanceAuditRead = {
        ok: true,
        timestampStorageProbe: timestampStorageProbe,
        sheetsApiTimestampProbe: sheetsApiTimestampProbe,
        appliedTimestampTypes: appliedTimestampTypes,
        appliedStringShapes: appliedStringShapes,
        appliedTimestampAcceptedCount: appliedTimestampAcceptedCount,
        rowCount: rows.length,
        appliedRowCount: rows.filter(function(row) {
          return row && row.outcome === MetricsService.AUDIT_OUTCOMES.APPLIED;
        }).length,
        firstAppliedRow: firstApplied ? {
          rowNumber: typeof firstApplied._rowNumber === 'number' ? firstApplied._rowNumber : null,
          timestampType: timestampType,
          isValidDateObject: ts instanceof Date && isFinite(dateMs),
          isFiniteNumber: typeof ts === 'number' && isFinite(ts),
          isNonEmptyString: typeof ts === 'string' && ts.length > 0,
          stringLooksIsoLike: typeof ts === 'string' &&
            /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(ts),
          stringLength: typeof ts === 'string' ? ts.length : null,
          acceptedByMetricsRowMs: metricEpochMs !== null
        } : null,
        semantics: 'The first APPLIED row is selected by the same _rowOrder rule as MetricsService; no later row is substituted.'
      };
    }

    // Reproduce the public report paths for all three report periods. SUMMARY
    // is a projection of FULL in the production service, so the diagnostic
    // tests the canonical FULL composition and M1 separately.
    var types = ['DAILY', 'WEEKLY', 'MONTHLY'];
    for (var t = 0; t < types.length; t++) {
      var type = types[t];
      var run = { reportType: type };

      try {
        var periodResult = ReportPeriod.periodFor(type, referenceMs);
        run.period = periodResult && periodResult.ok === true ? {
          ok: true,
          startMs: periodResult.data.startMs,
          endMs: periodResult.data.endMs
        } : {
          ok: false,
          failure: _hamzaweReportDiagFailure(periodResult)
        };

        var m1 = ReportService.generate(type, referenceMs);
        run.m1ReportService = m1 && m1.ok === true
          ? { ok: true, status: m1.data.status, metricNames: Object.keys(m1.data.metrics || {}) }
          : { ok: false, failure: _hamzaweReportDiagFailure(m1) };

        var full = EnhancedReportService.generateFull(type, referenceMs, { includeTrend: false });
        run.enhancedFull = full && full.ok === true
          ? {
              ok: true,
              availability: full.data && full.data.availability
                ? full.data.availability.status : null
            }
          : { ok: false, failure: _hamzaweReportDiagFailure(full) };

        // Run the same M1 batch directly to preserve the exact foundation
        // failure result independently of M3 composition.
        if (run.period && run.period.ok) {
          var batch = MetricsService.calculateMany(
            ReportService.REPORT_METRICS.slice(),
            { start: run.period.startMs, end: run.period.endMs }
          );
          run.metricsBatch = batch && batch.ok === true
            ? { ok: true, metricNames: Object.keys(batch.data.results || {}) }
            : { ok: false, failure: _hamzaweReportDiagFailure(batch) };
        }
      } catch (e) {
        run.unhandledException = {
          name: e && e.name ? String(e.name).slice(0, 80) : 'Error',
          message: e && e.message ? String(e.message).slice(0, 240) : 'No message'
        };
      }
      report.reportRuns.push(run);
    }
  } catch (e) {
    report.fatal = {
      name: e && e.name ? String(e.name).slice(0, 80) : 'Error',
      message: e && e.message ? String(e.message).slice(0, 240) : 'No message'
    };
  }

  report.finishedAtUtc = new Date().toISOString();
  report.elapsedMs = new Date(report.finishedAtUtc).getTime() - startedAt.getTime();

  var serialized = JSON.stringify(report, null, 2);
  console.log(serialized);
  return serialized;
}

/**
 * Convert a Result-like failure into a deliberately allowlisted summary.
 * Do not return arbitrary details: they can contain business identifiers.
 */
function _hamzaweReportDiagFailure(result) {
  if (!result) return { code: 'NO_RESULT', message: 'Service returned no result' };

  var err = result.error || result.failure || {};
  var code = result.code || err.code || result.errorCode || 'UNKNOWN_FAILURE';
  var message = result.message || err.message || 'No failure message exposed';

  var out = {
    code: String(code).slice(0, 100),
    message: String(message).slice(0, 240)
  };

  // MetricsService's activation-boundary failure has these safe diagnostic
  // fields. Never emit timestampValue or arbitrary Result.details.
  var details = err.details || result.details || {};
  if (details && typeof details === 'object') {
    if (typeof details.metric === 'string') out.metric = details.metric;
    if (typeof details.source === 'string') out.source = details.source;
    if (typeof details.rowNumber === 'number') out.rowNumber = details.rowNumber;
    if (typeof details.timestampValue === 'string') {
      out.timestampValueRedacted = true;
      out.timestampValueType = 'string';
      out.timestampValueLength = details.timestampValue.length;
      out.timestampValueLooksIsoLike = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(details.timestampValue);
    }
    if (typeof details.startMs === 'number') out.startMs = details.startMs;
    if (typeof details.endMs === 'number') out.endMs = details.endMs;
  }

  // Some Result implementations store code/message/details directly on
  // result.data or result.error; report only known fields above.
  return out;
}


/**
 * Read-only raw-cell metadata probe using the Sheets REST API.
 *
 * Why this exists:
 * SpreadsheetApp.getValues() tells the runtime type, but not conclusively
 * whether the underlying cell was explicitly stored as text or as a numeric
 * date serial. This probe reads only typed cell metadata and never returns
 * cell values, spreadsheet IDs, formulas, or row identifiers beyond row
 * numbers already used by the diagnostic.
 *
 * Requires the existing spreadsheets OAuth scope and UrlFetchApp /
 * ScriptApp runtime APIs. It does not require enabling the Advanced Sheets
 * service. If the API is unavailable, the result says why and does not fail
 * the report diagnostic.
 */
function _hamzaweReportDiagSheetsApiTimestampProbe(rows, firstApplied) {
  var result = {
    attempted: false,
    available: false,
    method: 'Sheets REST API read-only grid metadata',
    rawValuesLogged: false
  };

  try {
    if (typeof UrlFetchApp === 'undefined' ||
        typeof ScriptApp === 'undefined' ||
        typeof ScriptApp.getOAuthToken !== 'function') {
      result.reason = 'URLFETCH_OR_SCRIPT_TOKEN_API_UNAVAILABLE';
      return result;
    }

    var spreadsheet = GoogleSheets._openSpreadsheet();
    var spreadsheetId = spreadsheet && typeof spreadsheet.getId === 'function'
      ? spreadsheet.getId() : '';
    if (!spreadsheetId) {
      result.reason = 'SPREADSHEET_ID_UNAVAILABLE';
      return result;
    }

    var headers = GoogleSheets.getHeaders('ATTENDANCE_AUDIT');
    var timestampColumn = headers.indexOf('timestamp') + 1;
    var sheet = GoogleSheets._getSheet('ATTENDANCE_AUDIT');
    var lastRow = sheet.getLastRow();
    if (timestampColumn < 1 || lastRow < 2) {
      result.reason = 'TIMESTAMP_COLUMN_OR_DATA_ROWS_UNAVAILABLE';
      return result;
    }

    var columnLetter = '';
    var n = timestampColumn;
    while (n > 0) {
      var rem = (n - 1) % 26;
      columnLetter = String.fromCharCode(65 + rem) + columnLetter;
      n = Math.floor((n - 1) / 26);
    }

    var a1Range = "'ATTENDANCE_AUDIT'!" + columnLetter + "2:" + columnLetter + lastRow;
    var fields = 'sheets(data(startRow,rowData(values(userEnteredValue,effectiveValue,userEnteredFormat(numberFormat),effectiveFormat(numberFormat)))))';
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
      encodeURIComponent(spreadsheetId) +
      '?includeGridData=true&ranges=' + encodeURIComponent(a1Range) +
      '&fields=' + encodeURIComponent(fields);

    result.attempted = true;
    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    result.httpStatus = status;
    if (status < 200 || status >= 300) {
      result.reason = status === 403 ? 'SHEETS_API_PERMISSION_OR_API_DISABLED'
        : (status === 401 ? 'OAUTH_TOKEN_REJECTED' : 'SHEETS_API_REQUEST_FAILED');
      return result;
    }

    var payload = JSON.parse(response.getContentText());
    var grid = payload && payload.sheets && payload.sheets[0] &&
      payload.sheets[0].data && payload.sheets[0].data[0];
    var gridRows = grid && Array.isArray(grid.rowData) ? grid.rowData : null;
    if (!gridRows) {
      result.reason = 'SHEETS_API_GRID_DATA_MISSING';
      return result;
    }

    function valueType(value) {
      if (!value || typeof value !== 'object') return 'unset';
      if (Object.prototype.hasOwnProperty.call(value, 'stringValue')) return 'string';
      if (Object.prototype.hasOwnProperty.call(value, 'numberValue')) return 'number';
      if (Object.prototype.hasOwnProperty.call(value, 'formulaValue')) return 'formula';
      if (Object.prototype.hasOwnProperty.call(value, 'boolValue')) return 'boolean';
      if (Object.prototype.hasOwnProperty.call(value, 'errorValue')) return 'error';
      return 'other';
    }

    function dateOnlyShape(value) {
      if (typeof value !== 'string') return false;
      var s = value.trim();
      return s.length === 10 &&
        (s.charAt(4) === '/' || s.charAt(4) === '-') &&
        (s.charAt(7) === '/' || s.charAt(7) === '-');
    }

    var appliedRows = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row && row.outcome === MetricsService.AUDIT_OUTCOMES.APPLIED &&
          typeof row._rowNumber === 'number') {
        appliedRows.push(row._rowNumber);
      }
    }

    var counts = {
      userEnteredString: 0,
      userEnteredNumber: 0,
      userEnteredFormula: 0,
      userEnteredUnset: 0,
      userEnteredOther: 0,
      effectiveString: 0,
      effectiveNumber: 0,
      effectiveUnset: 0,
      effectiveOther: 0,
      dateOnlyTextCells: 0,
      dateFormattedNumericCells: 0
    };
    var samples = [];

    for (var a = 0; a < appliedRows.length; a++) {
      var rowNumber = appliedRows[a];
      var cellRow = gridRows[rowNumber - 2];
      var cell = cellRow && cellRow.values && cellRow.values[0] ? cellRow.values[0] : {};
      var enteredType = valueType(cell.userEnteredValue);
      var effectiveType = valueType(cell.effectiveValue);
      if (enteredType === 'string') counts.userEnteredString++;
      else if (enteredType === 'number') counts.userEnteredNumber++;
      else if (enteredType === 'formula') counts.userEnteredFormula++;
      else if (enteredType === 'unset') counts.userEnteredUnset++;
      else counts.userEnteredOther++;
      if (effectiveType === 'string') counts.effectiveString++;
      else if (effectiveType === 'number') counts.effectiveNumber++;
      else if (effectiveType === 'unset') counts.effectiveUnset++;
      else counts.effectiveOther++;

      var enteredString = cell.userEnteredValue &&
        typeof cell.userEnteredValue.stringValue === 'string'
        ? cell.userEnteredValue.stringValue : null;
      if (dateOnlyShape(enteredString)) counts.dateOnlyTextCells++;

      var userFormat = cell.userEnteredFormat && cell.userEnteredFormat.numberFormat;
      var effectiveFormat = cell.effectiveFormat && cell.effectiveFormat.numberFormat;
      var formatType = userFormat && userFormat.type ? userFormat.type
        : (effectiveFormat && effectiveFormat.type ? effectiveFormat.type : null);
      if (enteredType === 'number' && formatType === 'DATE') {
        counts.dateFormattedNumericCells++;
      }

      samples.push({
        rowNumber: rowNumber,
        userEnteredValueType: enteredType,
        effectiveValueType: effectiveType,
        userEnteredDateOnlyText: dateOnlyShape(enteredString),
        userNumberFormatType: userFormat && userFormat.type ? userFormat.type : null,
        effectiveNumberFormatType: effectiveFormat && effectiveFormat.type ? effectiveFormat.type : null,
        formulaPresent: enteredType === 'formula'
      });
    }

    result.available = true;
    result.appliedRowCountInspected = samples.length;
    result.typeCounts = counts;
    result.appliedRowCellMetadata = samples;
    result.firstAppliedDiagnosis = samples.length ? (function() {
      var first = null;
      for (var k = 0; k < samples.length; k++) {
        if (!first || samples[k].rowNumber < first.rowNumber) first = samples[k];
      }
      if (!first) return 'NO_APPLIED_ROWS';
      if (first.userEnteredValueType === 'string' && first.userEnteredDateOnlyText) {
        return 'FIRST_APPLIED_TIMESTAMP_IS_EXPLICIT_DATE_ONLY_TEXT_IN_SHEET';
      }
      if (first.userEnteredValueType === 'number' &&
          (first.userNumberFormatType === 'DATE' || first.effectiveNumberFormatType === 'DATE')) {
        return 'FIRST_APPLIED_TIMESTAMP_IS_NUMERIC_DATE_CELL_BUT_RUNTIME_READS_STRING_CHECK_DEPLOYMENT_OR_READER_DRIFT';
      }
      if (first.userEnteredValueType === 'formula') {
        return 'FIRST_APPLIED_TIMESTAMP_IS_FORMULA_DERIVED';
      }
      return 'CELL_STORAGE_TYPE_RECORDED_REQUIRES_CORRELATION_WITH_RUNTIME_TYPE';
    })() : 'NO_APPLIED_ROWS';

    result.limits = [
      'Cell metadata can establish text-versus-number/formula storage, not the identity or time of the actor who wrote it.',
      'A text cell alone cannot distinguish manual editing, import, legacy code, or a different deployed writer.'
    ];
    return result;
  } catch (e) {
    result.reason = 'PROBE_EXCEPTION';
    result.errorName = e && e.name ? String(e.name).slice(0, 60) : 'Error';
    result.errorMessage = e && e.message ? String(e.message).slice(0, 180) : 'No message';
    return result;
  }
}


/**
 * Structural signature checks against the canonical checked-in write/read
 * path. This is NOT a source SHA or cryptographic deployment attestation;
 * it detects material method-shape drift that can explain text timestamps.
 */
function _hamzaweReportDiagRuntimeCodePathSignature() {
  var out = {
    available: false,
    sourceShaVerified: false,
    interpretation: 'STRUCTURAL_SIGNATURE_ONLY_NOT_EXACT_DEPLOYMENT_IDENTITY'
  };
  try {
    var writer = Function.prototype.toString.call(AttendanceAuditRepository.append);
    var appender = Function.prototype.toString.call(GoogleSheets.appendRows);
    var reader = Function.prototype.toString.call(GoogleSheets.queryRows);
    var rowParser = Function.prototype.toString.call(MetricsService._rowMs);
    var clock = Function.prototype.toString.call(Clock.now);
    out.available = true;
    out.signatures = {
      attendanceWriterUsesClockNow: /timestamp\s*:\s*Clock\.now\s*\(\s*\)/.test(writer),
      attendanceWriterUsesCanonicalAppendRows: /GoogleSheets\.appendRows\s*\(/.test(writer),
      appendRowsUsesSetValues: /setValues\s*\(\s*rows\s*\)/.test(appender),
      queryRowsReadsGetValues: /getDataRange\s*\(\s*\)\.getValues\s*\(\s*\)/.test(reader),
      rowMsHasExplicitStringRejection: /typeof\s+value\s*===?\s*['"]string['"]/.test(rowParser),
      clockReturnsDate: /new\s+Date\s*\(\s*\)/.test(clock)
    };
    var checks = out.signatures;
    out.canonicalPathShapeMatches =
      checks.attendanceWriterUsesClockNow &&
      checks.attendanceWriterUsesCanonicalAppendRows &&
      checks.appendRowsUsesSetValues &&
      checks.queryRowsReadsGetValues &&
      checks.clockReturnsDate;
    out.rowParserShapeMatches = checks.rowMsHasExplicitStringRejection;
    out.note = 'A matching shape does not prove the entire deployed project equals main; a mismatch is strong evidence of runtime code-path drift.';
    return out;
  } catch (e) {
    out.reason = 'RUNTIME_FUNCTION_SOURCE_UNAVAILABLE';
    out.errorName = e && e.name ? String(e.name).slice(0, 60) : 'Error';
    return out;
  }
}
