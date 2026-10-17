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

      report.checks.attendanceAuditRead = {
        ok: true,
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
          acceptedByMetricsRowMs: metricEpochMs !== null,
          epochMsAvailable: metricEpochMs !== null ? metricEpochMs : null
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
