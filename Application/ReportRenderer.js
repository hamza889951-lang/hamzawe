/**
 * ReportRenderer — M1-B (PHASE 1.3 — REPORT CONSUMERS)
 *
 * Presentation ONLY: converts a ReportService DTO into a
 * human-readable plain-text representation.
 *
 *   Report Model → human-readable representation
 *
 * Frozen M1-B boundaries:
 *   - NO repositories, NO sheet/calendar/network access of any kind.
 *   - NO metrics recalculation — the renderer never calls
 *     MetricsService and never re-derives a number; it prints what
 *     the report already carries.
 *   - NO Clock / current time, NO side effects — rendering the same
 *     report twice yields byte-identical output.
 *   - NO ratios or rates (attendance rate, no-show rate, utilization,
 *     …) and NO insights — M1-B renders the six M1-A metrics with
 *     their honest statuses only.
 *   - Honesty rules: AVAILABLE 0 prints as '0' (valid measured zero);
 *     DEFERRED prints as DEFERRED (reason) with value null — never a
 *     fabricated zero; UNAVAILABLE prints as N/A-style status.
 *
 * All period/generatedAt strings are read from the DTO (precomputed
 * in clinic-local wall clock at composition time), so this file has
 * ZERO cross-module references — not even call-time ones.
 */
const ReportRenderer = {

  /**
   * Renders a report DTO as plain text (WhatsApp-friendly single
   * block, presentation language provisional in M1-B).
   * @param {Object} report ReportService DTO
   * @returns {Result} ok(string) | fail(REPORT_INVALID)
   */
  renderPlainText: function(report) {
    if (!report || typeof report !== 'object' ||
        typeof report.reportType !== 'string' ||
        !report.period || typeof report.period !== 'object' ||
        typeof report.period.startWallClock !== 'string' ||
        typeof report.period.endWallClock !== 'string' ||
        !report.metrics || typeof report.metrics !== 'object') {
      return Result.fail(
        'REPORT_INVALID',
        'Renderer input is not a valid report DTO',
        { report: report }
      );
    }

    var lines = [];

    lines.push('HAMZAWE ' + report.reportType + ' REPORT');
    lines.push(
      'Period: ' + report.period.startWallClock + ' -> ' +
      report.period.endWallClock +
      ' (' + (report.period.timeZone || '') + ')'
    );
    if (typeof report.generatedAtWallClock === 'string') {
      lines.push('Generated: ' + report.generatedAtWallClock);
    }
    lines.push('Status: ' + report.status + this._gapSummary(report));

    var names = Object.keys(report.metrics);
    for (var i = 0; i < names.length; i++) {
      lines.push(names[i] + ': ' + this._formatMetric(report.metrics[names[i]]));
    }

    return Result.ok(lines.join('\n'));
  },

  /** Non-AVAILABLE metric names for the status line (from the DTO). */
  _gapSummary: function(report) {
    if (report.status !== 'PARTIAL' || !report.statusBreakdown) return '';
    var gaps = [];
    var statuses = Object.keys(report.statusBreakdown);
    for (var i = 0; i < statuses.length; i++) {
      if (statuses[i] === 'AVAILABLE') continue;
      var names = report.statusBreakdown[statuses[i]];
      for (var j = 0; j < names.length; j++) {
        gaps.push(names[j] + '=' + statuses[i]);
      }
    }
    return gaps.length ? ' — ' + gaps.join(', ') : '';
  },

  /**
   * One metric line value: honest by construction. Numbers print as
   * numbers (0 is a VALID ZERO); non-AVAILABLE statuses print with
   * their status and reason, never a fabricated value.
   */
  _formatMetric: function(envelope) {
    if (envelope && envelope.status === 'AVAILABLE' &&
        typeof envelope.value === 'number') {
      return String(envelope.value);
    }
    var label = envelope && typeof envelope.status === 'string'
      ? envelope.status
      : 'UNKNOWN_STATUS';
    var reason = envelope && typeof envelope.reason === 'string' && envelope.reason !== ''
      ? ' (' + envelope.reason + ')'
      : '';
    return label + reason;
  }
};
