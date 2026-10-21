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
  var startedAt = Clock.now();
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
          var rawCellValue = timestampCell.getValue();
          var displayValue = timestampCell.getDisplayValue();
          var formulaValue = timestampCell.getFormula();
          var numberFormat = timestampCell.getNumberFormat();
          var rawCellType = rawCellValue instanceof Date ? 'Date'
            : (rawCellValue === null ? 'null' : typeof rawCellValue);
          var rawCellString = typeof rawCellValue === 'string' ? rawCellValue.trim() : '';
          var rawCellLooksDateOnly = rawCellString.length === 10 &&
            (rawCellString.charAt(4) === '/' || rawCellString.charAt(4) === '-') &&
            (rawCellString.charAt(7) === '/' || rawCellString.charAt(7) === '-');
          timestampStorageProbe = {
            ok: true,
            directCellValueType: rawCellType,
            directCellValueLength: typeof rawCellValue === 'string' ? rawCellValue.length : null,
            directCellValueLooksDateOnly: rawCellLooksDateOnly,
            directCellValueIsValidDate: rawCellValue instanceof Date && isFinite(rawCellValue.getTime()),
            directCellValueIsFiniteNumber: typeof rawCellValue === 'number' && isFinite(rawCellValue),
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

      var appliedTimestampInventory = _hamzaweReportDiagTimestampInventory(rows);
      var timestampOriginAssessment = _hamzaweReportDiagTimestampOriginAssessment(appliedTimestampInventory);

      report.checks.attendanceAuditRead = {
        ok: true,
        timestampStorageProbe: timestampStorageProbe,
        appliedTimestampInventory: appliedTimestampInventory,
        timestampOriginAssessment: timestampOriginAssessment,
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

  var finishedAt = Clock.now();
  report.finishedAtUtc = finishedAt.toISOString();
  report.elapsedMs = finishedAt.getTime() - startedAt.getTime();

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
/**
 * Enumerate every APPLIED timestamp in physical-row order without exposing
 * raw values or identifiers. This determines whether malformed values form
 * an older contiguous block followed by typed Date writes, a mixed/interleaved
 * pattern, or no observable transition.
 */
function _hamzaweReportDiagTimestampInventory(rows) {
  var items = [];
  var counts = { date: 0, number: 0, dateOnlyString: 0, otherString: 0, nullish: 0, other: 0 };
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || row.outcome !== MetricsService.AUDIT_OUTCOMES.APPLIED) continue;
    var value = row.timestamp;
    var type = value instanceof Date ? 'Date'
      : (value === null || typeof value === 'undefined' || value === '' ? 'nullish' : typeof value);
    var s = typeof value === 'string' ? value.trim() : '';
    var dateOnly = s.length === 10 &&
      (s.charAt(4) === '/' || s.charAt(4) === '-') &&
      (s.charAt(7) === '/' || s.charAt(7) === '-');
    if (type === 'Date') counts.date++;
    else if (type === 'number') counts.number++;
    else if (type === 'string' && dateOnly) counts.dateOnlyString++;
    else if (type === 'string') counts.otherString++;
    else if (type === 'nullish') counts.nullish++;
    else counts.other++;
    items.push({
      rowNumber: typeof row._rowNumber === 'number' ? row._rowNumber : null,
      rowOrder: MetricsService._rowOrder(row, i),
      type: type,
      dateOnlyString: dateOnly,
      acceptedByMetricParser: MetricsService._rowMs(value) !== null
    });
  }
  items.sort(function(a, b) {
    if (a.rowOrder !== b.rowOrder) return a.rowOrder - b.rowOrder;
    return (a.rowNumber || 0) - (b.rowNumber || 0);
  });
  var firstDateIndex = -1;
  var lastDateOnlyStringIndex = -1;
  var firstDateOnlyStringIndex = -1;
  for (var j = 0; j < items.length; j++) {
    if (items[j].type === 'Date' && firstDateIndex === -1) firstDateIndex = j;
    if (items[j].dateOnlyString) {
      if (firstDateOnlyStringIndex === -1) firstDateOnlyStringIndex = j;
      lastDateOnlyStringIndex = j;
    }
  }
  var sequencePattern = 'MIXED_TYPES_NO_CLEAR_ORDER';
  if (!items.length) sequencePattern = 'NO_APPLIED_ROWS';
  else if (counts.dateOnlyString === items.length) sequencePattern = 'ALL_APPLIED_TIMESTAMPS_ARE_DATE_ONLY_STRINGS';
  else if (counts.dateOnlyString > 0 && counts.date > 0 &&
           lastDateOnlyStringIndex < firstDateIndex) sequencePattern = 'DATE_ONLY_STRINGS_PRECEDE_DATE_VALUES';
  else if (counts.dateOnlyString > 0 && counts.date > 0 &&
           firstDateIndex < firstDateOnlyStringIndex) sequencePattern = 'DATE_VALUES_PRECEDE_DATE_ONLY_STRINGS';
  else if (counts.dateOnlyString > 0 && counts.date > 0) sequencePattern = 'MIXED_TYPES_INTERLEAVED';
  return {
    counts: counts,
    sequencePattern: sequencePattern,
    firstDateRowNumber: firstDateIndex >= 0 ? items[firstDateIndex].rowNumber : null,
    firstDateOnlyStringRowNumber: firstDateOnlyStringIndex >= 0 ? items[firstDateOnlyStringIndex].rowNumber : null,
    appliedRows: items.map(function(item) {
      return {
        rowNumber: item.rowNumber,
        type: item.type,
        dateOnlyString: item.dateOnlyString,
        acceptedByMetricParser: item.acceptedByMetricParser
      };
    })
  };
}

/**
 * Classify what the current evidence proves. Never claim a historical writer
 * identity: Sheets cell values do not retain the actor/path that wrote them.
 */
function _hamzaweReportDiagTimestampOriginAssessment(inventory) {
  var firstApplied = inventory && inventory.appliedRows && inventory.appliedRows.length
    ? inventory.appliedRows[0] : null;
  var assessment = {
    reportFailureRootCause: firstApplied && firstApplied.dateOnlyString && !firstApplied.acceptedByMetricParser
      ? 'CONFIRMED_FIRST_APPLIED_TIMESTAMP_IS_UNPARSEABLE_DATE_ONLY_TEXT'
      : (firstApplied && !firstApplied.acceptedByMetricParser
        ? 'CONFIRMED_FIRST_APPLIED_TIMESTAMP_IS_UNPARSEABLE_NON_DATE_VALUE'
        : (firstApplied ? 'FIRST_APPLIED_TIMESTAMP_PARSER_ACCEPTED' : 'NO_APPLIED_TIMESTAMP_EVIDENCE')),
    historicalWriterIdentity: 'NOT_RECOVERABLE_FROM_CURRENT_CELL_VALUES_ALONE',
    nextInferenceLimit: 'Sequence can show a type-transition pattern, but cannot distinguish legacy code, manual edit, import, or external writer without edit/revision evidence.'
  };
  if (inventory && inventory.sequencePattern === 'DATE_ONLY_STRINGS_PRECEDE_DATE_VALUES') {
    assessment.writePathTransitionEvidence = 'OLDER_DATE_ONLY_TEXT_ROWS_PRECEDE_LATER_DATE_OBJECT_ROWS; CONSISTENT_WITH_LEGACY_OR_EXTERNAL_WRITES_FOLLOWED_BY_TYPED_WRITES';
  } else if (inventory && inventory.sequencePattern === 'MIXED_TYPES_INTERLEAVED') {
    assessment.writePathTransitionEvidence = 'MIXED_OR_INTERLEAVED_TIMESTAMP_TYPES; NO_SINGLE_CLEAN_TRANSITION';
  } else {
    assessment.writePathTransitionEvidence = inventory ? inventory.sequencePattern : 'INVENTORY_UNAVAILABLE';
  }
  return assessment;
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
    var rowParser = Function.prototype.toString.call(MetricsService._toEpochMs);
    var clock = Function.prototype.toString.call(Clock.now);
    out.available = true;
    out.signatures = {
      attendanceWriterUsesClockNow: /timestamp\s*:\s*Clock\.now\s*\(\s*\)/.test(writer),
      attendanceWriterUsesCanonicalAppendRows: /GoogleSheets\.appendRows\s*\(/.test(writer),
      appendRowsUsesSetValues: /setValues\s*\(\s*rows\s*\)/.test(appender),
      queryRowsReadsGetValues: /getDataRange\s*\(\s*\)\.getValues\s*\(\s*\)/.test(reader),
      timestampParserRejectsDateOnlyString: MetricsService._toEpochMs('2026/09/07') === null,
      timestampParserAcceptsDateObject: MetricsService._toEpochMs(Clock.now()) !== null,
      clockReturnsDate: /new\s+Date\s*\(\s*\)/.test(clock)
    };
    var checks = out.signatures;
    out.canonicalPathShapeMatches =
      checks.attendanceWriterUsesClockNow &&
      checks.attendanceWriterUsesCanonicalAppendRows &&
      checks.appendRowsUsesSetValues &&
      checks.queryRowsReadsGetValues &&
      checks.clockReturnsDate;
    out.timestampParserBehaviorMatchesContract = checks.timestampParserRejectsDateOnlyString && checks.timestampParserAcceptsDateObject;
    out.note = 'A matching shape does not prove the entire deployed project equals main; a mismatch is strong evidence of runtime code-path drift.';
    return out;
  } catch (e) {
    out.reason = 'RUNTIME_FUNCTION_SOURCE_UNAVAILABLE';
    out.errorName = e && e.name ? String(e.name).slice(0, 60) : 'Error';
    return out;
  }
}
