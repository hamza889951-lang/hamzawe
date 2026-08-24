/**
 * ReportService — M1-B (PHASE 1.3 — REPORT CONSUMERS)
 *
 * Daily / Weekly / Monthly reports over the ONE M1-A Metrics
 * Foundation. The three report types differ ONLY in the period they
 * cover — never in metric definition, calculation, source of truth,
 * failure semantics, or zero semantics:
 *
 *   ReportService → MetricsService          (the ONLY metrics path)
 *   ReportPeriod   → clinic-local periods   (Utils, pure arithmetic)
 *
 * ─── FROZEN M1-B RESPONSIBILITY ───
 *   resolve report type
 *   → construct period (ReportPeriod, clinic-local wall-clock
 *      boundaries as instants, start inclusive / end exclusive)
 *   → request metrics (MetricsService.calculateMany — ONE batched
 *      call for all six M1-A metrics, never six independent calls)
 *   → compose the report DTO (metric envelopes preserved VERBATIM)
 *   → calculate the overall report status (COMPLETE / PARTIAL)
 *   Nothing more. No sheet reads, no mutation, no business ratios,
 *   no insights, no attendance-rate/cancellation-rate/utilization
 *   formulas (those need their own approved Metric Contract).
 *
 *   REPORTING CALENDAR ≠ CLINIC WORKING SCHEDULE: periods are pure
 *   calendar boundaries (REPORT_WEEK_START = Saturday is only how a
 *   Weekly report splits time — not a claim that any day is a
 *   working day). The clinic's actual schedule and capacity are
 *   produced by the existing pipeline
 *   Settings → Slot Generation → Availability, flow into metrics
 *   through their real sources, and are NEVER assumed or hardcoded
 *   here. Future capacity/working-day metrics must consume Settings
 *   or the actually generated Availability under their own approved
 *   Metric Contract; if a historical metric needs schedule
 *   provenance that cannot be proven for that past period, it is
 *   DEFERRED — never guessed from current settings.
 *
 * ─── STATUS SEMANTICS (honest, never cosmetic) ───
 *   COMPLETE — every requested metric envelope is AVAILABLE.
 *   PARTIAL  — one or more envelopes are not AVAILABLE (DEFERRED,
 *              UNAVAILABLE, or any future non-AVAILABLE status). The
 *              report is still built; each affected metric carries
 *              its full honest envelope (value null + reason), and
 *              statusBreakdown/statusReason name them.
 *   Source failure — MetricsService failures (METRIC_SOURCE_UNAVAILABLE,
 *   METRIC_PERIOD_INVALID, METRIC_EVIDENCE_INVALID, …) propagate
 *   VERBATIM: no error→zero conversion, no empty report, no fake
 *   partial data. M1-B never re-wraps foundation failure codes.
 *
 *   Zero ≠ Deferred ≠ Unavailable:
 *     AVAILABLE value 0  = valid measured zero (preserved as 0)
 *     DEFERRED value null = historical value not provable (never 0)
 *     UNAVAILABLE value null = metric N/A for this period
 *
 * ─── PROVENANCE ───
 *   Every metric keeps its complete MetricsService envelope
 *   (metric, status, value, reason, period, evaluatedAt, provenance)
 *   inside report.metrics — never flattened to {confirmed: 10}. The
 *   chain stays walkable: Report → Metric envelope → Source /
 *   Condition / Period / Semantics.
 *
 * ─── SIDE EFFECTS ───
 *   READ ONLY. Report generation performs no booking, change, cancel,
 *   attendance transition, calendar mutation, sheet write, audit
 *   write, or message send. generatedAt comes from Clock.now() and
 *   never alters the period (the period derives from the reference
 *   instant only).
 *
 * ─── Evaluation-order note ───
 *   clasp evaluates project files alphabetically, so this file loads
 *   BEFORE Config.js and BEFORE Utils/ReportPeriod.js. Every
 *   cross-module reference (MetricsService, ReportPeriod, Clock,
 *   Result) is resolved at CALL time — same discipline as
 *   MetricsService/AttendanceService.
 */
const ReportService = {

  STATUS: {
    COMPLETE: 'COMPLETE',
    PARTIAL: 'PARTIAL'
  },

  REPORT_TYPES: {
    DAILY: 'DAILY',
    WEEKLY: 'WEEKLY',
    MONTHLY: 'MONTHLY'
  },

  /**
   * The six M1-A metrics every M1-B report consumes — canonical
   * order. Frozen: M1-B adds no metrics and no ratios. Validated
   * against the MetricsService registry at CALL time so silent
   * foundation drift fails loudly (REPORT_METRIC_NOT_REGISTERED)
   * instead of producing a quietly different report.
   */
  REPORT_METRICS: [
    'CONFIRMED_APPOINTMENTS',
    'OFFICIAL_CANCELLATIONS',
    'OFFICIAL_CHANGES',
    'COMPLETED_APPOINTMENTS',
    'NO_SHOW_APPOINTMENTS',
    'BOOKABLE_SLOTS'
  ],

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Daily report: the one clinic-local calendar day containing the
   * reference instant (default Clock.now()).
   * @param {Date|number} [reference]
   * @returns {Result} ok(report) | fail (verbatim MetricsService /
   *                   ReportPeriod failure semantics)
   */
  generateDaily: function(reference) {
    return this.generate(this.REPORT_TYPES.DAILY, reference);
  },

  /**
   * Weekly report: the REPORTING CALENDAR week containing the
   * reference instant — Saturday 00:00 → following Friday 24:00
   * clinic-local (REPORT_WEEK_START, frozen M1-B reporting
   * convention). A pure calendar boundary: it says nothing about
   * which days the clinic works; the working schedule lives in
   * Settings → Slot Generation → Availability.
   * @param {Date|number} [reference]
   * @returns {Result}
   */
  generateWeekly: function(reference) {
    return this.generate(this.REPORT_TYPES.WEEKLY, reference);
  },

  /**
   * Monthly report: the clinic-local calendar month containing the
   * reference instant.
   * @param {Date|number} [reference]
   * @returns {Result}
   */
  generateMonthly: function(reference) {
    return this.generate(this.REPORT_TYPES.MONTHLY, reference);
  },

  /**
   * Generates one report. Composition pipeline (nothing hidden):
   *   resolve type → reference instant → period → ONE
   *   MetricsService.calculateMany(six metrics, {start,end}) →
   *   DTO + overall status.
   *
   * @param {string} reportType one of ReportService.REPORT_TYPES
   * @param {Date|number} [reference] instant inside the target period;
   *        defaults to Clock.now() (the current day/week/month)
   * @returns {Result} ok(report DTO) |
   *                   fail(REPORT_TYPE_UNKNOWN |
   *                        REPORT_REFERENCE_INVALID |
   *                        REPORT_PERIOD_INVALID |
   *                        REPORT_METRIC_NOT_REGISTERED |
   *                        verbatim METRIC_* failures)
   */
  generate: function(reportType, reference) {
    var typeResult = this._resolveReportType(reportType);
    if (!typeResult.ok) return typeResult;

    var referenceResult = this._referenceMs(reference);
    if (!referenceResult.ok) return referenceResult;
    var referenceMs = referenceResult.data;

    // Call-time binding (clasp evaluation order).
    var ReportPeriodRef = ReportPeriod;

    var periodResult = ReportPeriodRef.periodFor(reportType, referenceMs);
    if (!periodResult.ok) return periodResult;
    var period = periodResult.data;

    var metricsResult = this._requestMetrics(reportType, period);
    if (!metricsResult.ok) return metricsResult;
    var metricsData = metricsResult.data;

    // generatedAt NEVER alters the period — the period derives from
    // the reference instant alone (frozen M1-B rule).
    var generatedAt = Clock.now();

    var statusResult = this._overallStatus(metricsData.results);
    var requestedMetrics = this.REPORT_METRICS.slice();

    return Result.ok({
      reportType: reportType,
      period: Object.assign(
        { startMs: period.startMs, endMs: period.endMs },
        ReportPeriodRef.describe(reportType, period)
      ),
      generatedAt: generatedAt,
      generatedAtWallClock: ReportPeriodRef.formatWallClock(generatedAt.getTime()),
      requestedMetrics: requestedMetrics,
      status: statusResult.status,
      statusReason: statusResult.statusReason,
      statusBreakdown: statusResult.breakdown,
      // Metric envelopes preserved VERBATIM from MetricsService
      // (full provenance chain inside each envelope).
      metrics: metricsData.results
    });
  },

  // ─── Internals ─────────────────────────────────────────────────

  /** @returns {Result} ok(reportType) | fail(REPORT_TYPE_UNKNOWN) */
  _resolveReportType: function(reportType) {
    var types = this.REPORT_TYPES;
    var valid = Object.keys(types).some(function(key) {
      return types[key] === reportType;
    });
    if (!valid) {
      return Result.fail(
        'REPORT_TYPE_UNKNOWN',
        'Unknown report type: ' + reportType,
        {
          requested: reportType,
          available: Object.keys(types).map(function(key) { return types[key]; })
        }
      );
    }
    return Result.ok(reportType);
  },

  /**
   * reference omitted → Clock.now() (the only current-time source).
   * Date or finite epoch-ms accepted; strings rejected (no ambiguous
   * parsing).
   * @returns {Result} ok(referenceMs) | fail(REPORT_REFERENCE_INVALID)
   */
  _referenceMs: function(reference) {
    if (typeof reference === 'undefined') {
      return Result.ok(Clock.now().getTime());
    }
    var ms = ReportPeriod.toInstantMs(reference);
    if (ms === null) {
      return Result.fail(
        'REPORT_REFERENCE_INVALID',
        'Report reference must be a Date or finite epoch-ms value',
        { reference: reference }
      );
    }
    return Result.ok(ms);
  },

  /**
   * ONE MetricsService.calculateMany call for the whole report — the
   * primary (and only) metrics path. Verifies every REPORT_METRICS
   * name is still registered in the M1-A foundation (fail loudly on
   * drift, never silently shrink the report).
   * @returns {Result} ok(calculateMany data) | fail
   */
  _requestMetrics: function(reportType, period) {
    var MetricsServiceRef = MetricsService; // call-time binding
    var registered = MetricsServiceRef.METRICS;

    for (var i = 0; i < this.REPORT_METRICS.length; i++) {
      var name = this.REPORT_METRICS[i];
      var isRegistered = Object.keys(registered).some(function(key) {
        return registered[key] === name;
      });
      if (!isRegistered) {
        return Result.fail(
          'REPORT_METRIC_NOT_REGISTERED',
          'Report metric is not registered in MetricsService: ' + name,
          {
            reportType: reportType,
            missing: name,
            available: Object.keys(registered).map(function(key) {
              return registered[key];
            })
          }
        );
      }
    }

    return MetricsServiceRef.calculateMany(
      this.REPORT_METRICS.slice(),
      { start: period.startMs, end: period.endMs }
    );
  },

  /**
   * Overall report status from the metric envelopes.
   * COMPLETE ⇔ every envelope status === AVAILABLE. Any other status
   * (DEFERRED, UNAVAILABLE, or a future status) → PARTIAL, with the
   * offending metrics named — never hidden, never converted.
   * @param {Object} results {metricName: envelope}
   * @returns {{status, statusReason, breakdown}}
   */
  _overallStatus: function(results) {
    // Call-time binding to the frozen M1-A status vocabulary.
    var availableStatus = MetricsService.STATUS.AVAILABLE;
    var breakdown = {};
    var names = Object.keys(results);

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var status = results[name].status;
      if (!breakdown.hasOwnProperty(status)) breakdown[status] = [];
      breakdown[status].push(name);
    }

    var notAvailable = [];
    for (var j = 0; j < names.length; j++) {
      var metricName = names[j];
      if (results[metricName].status !== availableStatus) {
        notAvailable.push(metricName + '=' + results[metricName].status);
      }
    }

    if (notAvailable.length === 0) {
      return {
        status: this.STATUS.COMPLETE,
        statusReason: null,
        breakdown: breakdown
      };
    }

    return {
      status: this.STATUS.PARTIAL,
      statusReason:
        'Report built with honest gaps: ' + notAvailable.join(', ') +
        '. Affected metrics keep value=null with their original reason/provenance — never a fabricated zero.',
      breakdown: breakdown
    };
  }
};
