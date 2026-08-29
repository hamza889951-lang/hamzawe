/**
 * EnhancedReportService — M3 (ENHANCED REPORT COMPOSITION)
 *
 * FROZEN CONTRACT: M3-ENHANCED-REPORT-v1
 * Base commit:     cab4be965cbafe99014674817e1b1ced913f8d27 (main, PR #15)
 *
 * ─── ROLE (contract §4, §17) ───
 * M3 is a COMPOSITION + PRESENTATION layer. It consumes the canonical
 * public outputs of M1 and M2 and assembles ONE canonical
 * EnhancedReportModel, then derives a SUMMARY as a pure PROJECTION of
 * that model. It never re-derives a metric, a rate, an episode, a
 * cohort, a threshold, a severity, an insight, a recommendation, or a
 * trend, and it never touches a repository, Sheet, Calendar,
 * attendance, notification, billing, or any write/recovery path.
 *
 *   M1/M2 public APIs
 *        ↓
 *   M3 composition  (this file)
 *        ↓
 *   EnhancedReportModel
 *     ├── FULL     (canonical — source of truth)
 *     └── SUMMARY  (projection of FULL — presentation-oriented)
 *
 * ─── DATA PATHS (contract §5, §6, §18 — the ONLY inbound edges) ───
 *   ReportPeriod.periodFor()            period arithmetic (never re-written)
 *   ReportService.generate()            M1 canonical report:
 *                                         period + the six M1-A metric
 *                                         envelopes (preserved VERBATIM,
 *                                         full provenance chain) + the
 *                                         honest COMPLETE/PARTIAL status.
 *   RateRuleService.generateInsightsForReport()
 *                                       M2 canonical output: the four
 *                                         rate results (as carried by the
 *                                         rule objects + their foundation
 *                                         provenance), rule/insight
 *                                         results, trend, cohort,
 *                                         minimumCohort, thresholdPolicy,
 *                                         and full provenance.
 *
 *   The M2 rate envelopes are NOT recomputed here: the "rates" section of
 *   the model is a faithful PROJECTION of the foundation facts each rule
 *   already carries (metric, foundationStatus, value, numerator,
 *   denominator, foundationReason, period, foundationProvenance). One M2
 *   entry point → ONE coherent snapshot (single evaluatedAt / asOfMs),
 *   never two independent foundation batches with disagreeing as-of
 *   instants.
 *
 * ─── REFERENCE RESOLUTION (technical — keeps M1 and M2 aligned) ───
 *   ReportService defaults an omitted reference to Clock.now(); the
 *   report-type rate path (ReportPeriod.periodFor) instead REJECTS an
 *   omitted reference. To make both consumers observe the SAME period,
 *   M3 resolves the reference to ONE concrete instant up front
 *   (Clock.now() when omitted; otherwise Date/epoch-ms, strings
 *   rejected — same discipline as ReportService) and passes that single
 *   instant to both. The two consumers then derive identical periods via
 *   ReportPeriod, and M3 asserts that equality (fails loudly on drift —
 *   never silently composes a mismatched report).
 *
 * ─── REPORT-LEVEL AVAILABILITY (contract §9 — data availability ONLY) ─
 *   COMPLETE     every M1 metric AVAILABLE and every M2 rate AVAILABLE.
 *   PARTIAL      some available, some not.
 *   UNAVAILABLE  nothing available (no M1 metric AVAILABLE and no M2
 *                rate AVAILABLE).
 *   This is a purely MECHANICAL aggregation of data availability across
 *   the two canonical sources — it is NOT business health, clinical
 *   severity, success/failure, or financial state. Nothing is converted
 *   (UNAVAILABLE is never 0, missing is never healthy, failure is never
 *   success). A hard SOURCE failure from M1 or M2 (Result.fail:
 *   METRIC_SOURCE_UNAVAILABLE / RATE_SOURCE_UNAVAILABLE / *_PERIOD_INVALID
 *   / *_TYPE_UNKNOWN / *_REFERENCE_INVALID) is PROPAGATED VERBATIM as a
 *   call-level failure — never masked into a zeroed or partial report
 *   (contract §19).
 *
 * ─── FULL vs SUMMARY (contract §10, §11) ───
 *   FULL is canonical and complete: it carries every metric envelope,
 *   every rate fact, every rule, every insight, the trend, the cohort,
 *   and the full provenance / data-quality surface — including the data
 *   a future Doctor Dashboard will need (nothing is silently dropped).
 *   SUMMARY is PROJECTION(FULL): it may select, reorder, reduce, and
 *   group for presentation, but it NEVER creates an insight, a severity,
 *   a ranking, a threshold, a causal statement, or a recalculated
 *   value. SUMMARY is built ONLY from an already-composed FULL model
 *   (project()), so it structurally cannot introduce new semantics.
 *
 * ─── GENERATED AT (contract §14) ───
 *   generatedAt is METADATA ONLY (Clock.now()). It never enters any rate,
 *   severity, trend, ranking, period, or business computation. With a
 *   fixed Clock the whole model — including generatedAt — is byte-stable
 *   (determinism, contract §20).
 *
 * ─── EVALUATION-ORDER NOTE (clasp alphabetical) ───
 *   This file sorts BEFORE MetricsService, RateFoundationService,
 *   RateRuleService, ReportService, ReportRenderer and Utils/ReportPeriod.
 *   Every cross-module reference (ReportService, RateRuleService,
 *   ReportPeriod, Clock, Result) is therefore resolved at CALL time —
 *   the same discipline as the other Application-level services.
 */
const EnhancedReportService = {

  SCHEMA: 'M3-ENHANCED-REPORT-v1',

  REPRESENTATIONS: {
    FULL: 'FULL',
    SUMMARY: 'SUMMARY'
  },

  REPORT_TYPES: {
    DAILY: 'DAILY',
    WEEKLY: 'WEEKLY',
    MONTHLY: 'MONTHLY'
  },

  /**
   * Report-level DATA-AVAILABILITY status (contract §9). NOT business
   * health / clinical severity / financial state.
   */
  AVAILABILITY: {
    COMPLETE: 'COMPLETE',
    PARTIAL: 'PARTIAL',
    UNAVAILABLE: 'UNAVAILABLE'
  },

  /** The four M2 management rates, in canonical order (never re-ranked). */
  RATE_METRICS: [
    'CANCELLATION_RATE',
    'CHANGE_RATE',
    'COMPLETION_RATE',
    'NO_SHOW_RATE'
  ],

  // ═══════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build both representations for one report.
   * @param {string} reportType one of REPORT_TYPES
   * @param {Date|number} [reference] instant inside the target period;
   *        defaults to Clock.now()
   * @param {{includeTrend?: boolean}} [options] includeTrend defaults to
   *        true (trend is shown when available — contract §12)
   * @returns {Result} ok({ full, summary }) | fail(verbatim M1/M2 failure)
   */
  generate: function(reportType, reference, options) {
    var fullResult = this.generateFull(reportType, reference, options);
    if (!fullResult.ok) return fullResult;
    return Result.ok({
      full: fullResult.data,
      summary: this.project(fullResult.data)
    });
  },

  /**
   * Build the canonical FULL EnhancedReportModel.
   * @returns {Result} ok(FULL model) | fail(REPORT_TYPE_UNKNOWN |
   *   REPORT_REFERENCE_INVALID | REPORT_PERIOD_INVALID |
   *   RATE_PERIOD_INVALID | METRIC_SOURCE_UNAVAILABLE |
   *   RATE_SOURCE_UNAVAILABLE | ENHANCED_REPORT_PERIOD_MISMATCH |
   *   verbatim METRIC_* / RATE_* failures)
   */
  generateFull: function(reportType, reference, options) {
    var typeResult = this._resolveReportType(reportType);
    if (!typeResult.ok) return typeResult;

    var referenceResult = this._referenceMs(reference);
    if (!referenceResult.ok) return referenceResult;
    var referenceMs = referenceResult.data;

    var opt = options || {};
    // Trend is included by default (presentation-friendly, contract §12);
    // an explicit false disables the extra comparable-period batch.
    var includeTrend = opt.includeTrend === undefined ? true : !!opt.includeTrend;

    // ── M1 canonical report (VERBATIM metric envelopes + honest status) ─
    var ReportServiceRef = ReportService; // call-time (clasp order)
    var m1Result = ReportServiceRef.generate(reportType, referenceMs);
    if (!m1Result.ok) return m1Result; // propagate source failure VERBATIM
    var m1 = m1Result.data;

    // ── M2 canonical output (rates via rules + rules + insights + trend) ─
    var RateRuleServiceRef = RateRuleService; // call-time
    var m2Result = RateRuleServiceRef.generateInsightsForReport(
      reportType, referenceMs, { includeTrend: includeTrend }
    );
    if (!m2Result.ok) return m2Result; // propagate source failure VERBATIM
    var m2 = m2Result.data;

    // ── Period coherence (technical invariant — never silently drift) ──
    var mismatch = this._assertPeriodsMatch(m1.period, m2.period);
    if (mismatch) return mismatch;

    // generatedAt is METADATA ONLY (contract §14) — never enters any
    // rate/severity/trend/ranking/period/business computation.
    var generatedAt = Clock.now();
    var generatedAtMs = generatedAt.getTime();

    var rates = this._projectRates(m2);
    var availability = this._availability(m1, rates);

    var full = {
      schema: this.SCHEMA,
      representation: this.REPRESENTATIONS.FULL,
      reportType: reportType,

      // Canonical period (clinic-local Asia/Baghdad, start inclusive /
      // end exclusive) — taken VERBATIM from the M1-B canonical report.
      period: m1.period,

      // Report-level DATA availability (contract §9) — NOT business health.
      availability: availability,

      // ── M1 canonical metrics (contract §8) — envelopes VERBATIM ──
      m1: {
        status: m1.status,
        statusReason: m1.statusReason,
        statusBreakdown: m1.statusBreakdown,
        requestedMetrics: m1.requestedMetrics,
        metrics: m1.metrics,
        generatedAt: m1.generatedAt,
        generatedAtWallClock: m1.generatedAtWallClock
      },

      // ── M2 rates + rule/insight results + trend (contract §8) ──
      m2: {
        // "M2 rates" — a faithful PROJECTION of the foundation facts each
        // rule carries (NOT a recalculation).
        rates: rates,
        // Rule results VERBATIM (severity, direction, threshold, reason,
        // confidence, per-rule provenance).
        rules: m2.rules,
        // Insights VERBATIM (one per metric + combined) — informational,
        // non-causal, non-blaming; never re-ranked here.
        insights: m2.insights,
        // Trend VERBATIM from M2 (contract §12) — never recomputed here,
        // never allowed to change severity.
        trend: m2.trend,
        // Shared cohort + governance, VERBATIM.
        cohort: m2.cohort,
        minimumCohort: m2.minimumCohort,
        thresholdPolicy: m2.thresholdPolicy,
        evaluatedAt: m2.evaluatedAt,
        asOfMs: m2.asOfMs
      },

      // ── Provenance / data quality (contract §8) ──
      provenance: {
        composition:
          'M3 ENHANCED REPORT — read-only composition over ReportService (M1) and RateRuleService (M2); no repository / Sheet / Calendar / attendance / notification / billing / write / recovery access',
        readPolicy:
          'raw repository reads: NONE — M1 metrics come from ReportService, M2 rates/rules/insights/trend come from RateRuleService (each performs its own read-only, one-read-per-source boundary)',
        reference: {
          referenceMs: referenceMs,
          periodSemantics: m1.period.periodSemantics,
          timeZone: m1.period.timeZone
        },
        m1: {
          status: m1.status,
          statusReason: m1.statusReason,
          statusBreakdown: m1.statusBreakdown
        },
        m2: m2.provenance,
        dataQuality: this._dataQuality(m1, m2, rates)
      },

      // ── Metadata (contract §14) — generatedAt is the ONLY runtime field ─
      metadata: {
        schema: this.SCHEMA,
        representation: this.REPRESENTATIONS.FULL,
        generatedAt: generatedAt,
        generatedAtMs: generatedAtMs,
        generatedAtWallClock: this._wallClock(generatedAtMs),
        includeTrend: includeTrend
      }
    };

    return Result.ok(full);
  },

  /**
   * Build the SUMMARY projection. Internally composes FULL first, so the
   * SUMMARY is ALWAYS a projection of a real canonical model.
   * @returns {Result} ok(SUMMARY) | fail(verbatim M1/M2 failure)
   */
  generateSummary: function(reportType, reference, options) {
    var fullResult = this.generateFull(reportType, reference, options);
    if (!fullResult.ok) return fullResult;
    return Result.ok(this.project(fullResult.data));
  },

  /** Daily convenience. */
  generateDaily: function(reference, options) {
    return this.generate(this.REPORT_TYPES.DAILY, reference, options);
  },
  /** Weekly convenience. */
  generateWeekly: function(reference, options) {
    return this.generate(this.REPORT_TYPES.WEEKLY, reference, options);
  },
  /** Monthly convenience. */
  generateMonthly: function(reference, options) {
    return this.generate(this.REPORT_TYPES.MONTHLY, reference, options);
  },

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY projection (contract §11 — projection ONLY)
  // ═══════════════════════════════════════════════════════════════

  /**
   * PURE projection of a FULL model into a SUMMARY. No I/O, no clock, no
   * service calls, no recomputation. Allowed operations (contract §11):
   * select fields, reorder, reduce detail, presentation-oriented
   * grouping. Forbidden: new insight / severity / ranking / threshold /
   * rate recompute / metric recompute / causal inference / changed
   * business meaning.
   *
   * @param {Object} full a FULL EnhancedReportModel (from generateFull)
   * @returns {Object} SUMMARY model (never a Result — pure transform)
   */
  project: function(full) {
    return {
      schema: this.SCHEMA,
      representation: this.REPRESENTATIONS.SUMMARY,
      reportType: full.reportType,

      // Reduced period presentation (canonical values selected, never
      // recomputed).
      period: {
        startMs: full.period.startMs,
        endMs: full.period.endMs,
        startWallClock: full.period.startWallClock,
        endWallClock: full.period.endWallClock,
        timeZone: full.period.timeZone
      },

      // Report-level availability (data availability ONLY — selected
      // verbatim, never converted).
      availability: {
        status: full.availability.status,
        reason: full.availability.reason
      },

      // Selected M1 metrics — honest by construction (AVAILABLE value is
      // the measured number, 0 stays 0; a non-AVAILABLE metric keeps its
      // status + reason and NEVER a fabricated value).
      metrics: this._summariseMetrics(full),

      // Selected M2 rates — value + severity + brief trend, all VERBATIM
      // from FULL. No new severity, no new ranking, no recomputation.
      rates: this._summariseRates(full),

      // Insights in CANONICAL order (never re-ranked — no "Top Findings",
      // contract §11). Text is preserved verbatim (informational,
      // non-causal).
      insights: this._summariseInsights(full),

      // Recommendations surface (contract §13) — labelled MANAGEMENT
      // NOTES, never "Actions"; verbatim, never turned into an automatic
      // action / notification / command / mandatory instruction.
      managementNotes: this._summariseManagementNotes(full),

      // Data-quality warnings preserved when relevant (contract §21) —
      // surfacing EXISTING provenance/status facts, never a new insight.
      dataQualityWarnings: this._summariseDataQuality(full),

      metadata: {
        schema: this.SCHEMA,
        representation: this.REPRESENTATIONS.SUMMARY,
        generatedAt: full.metadata.generatedAt,
        generatedAtMs: full.metadata.generatedAtMs,
        generatedAtWallClock: full.metadata.generatedAtWallClock,
        projectionOf: this.REPRESENTATIONS.FULL
      }
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // Internals — composition
  // ═══════════════════════════════════════════════════════════════

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
   * Resolve the reference to ONE concrete instant so M1 and M2 observe
   * the SAME period (same discipline as ReportService._referenceMs:
   * omitted → Clock.now(); Date/finite epoch-ms accepted; strings
   * rejected — no ambiguous parsing).
   * @returns {Result} ok(referenceMs) | fail(REPORT_REFERENCE_INVALID)
   */
  _referenceMs: function(reference) {
    if (typeof reference === 'undefined') {
      return Result.ok(Clock.now().getTime());
    }
    var ms = ReportPeriod.toInstantMs(reference); // call-time
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
   * The M1 and M2 consumers each derive the period from (reportType,
   * referenceMs) via ReportPeriod. They MUST agree. A mismatch is a
   * technical drift (not a business condition) and fails loudly instead
   * of composing an incoherent report.
   * @returns {Result|null} a fail Result on drift, otherwise null
   */
  _assertPeriodsMatch: function(m1Period, m2Period) {
    if (!m1Period || !m2Period ||
        m1Period.startMs !== m2Period.startMs ||
        m1Period.endMs !== m2Period.endMs) {
      return Result.fail(
        'ENHANCED_REPORT_PERIOD_MISMATCH',
        'M1 and M2 derived different periods for the same report type/reference',
        {
          m1: m1Period ? { startMs: m1Period.startMs, endMs: m1Period.endMs } : null,
          m2: m2Period ? { startMs: m2Period.startMs, endMs: m2Period.endMs } : null
        }
      );
    }
    return null;
  },

  /**
   * PROJECT the four rate facts from the M2 rule objects (NOT a
   * recalculation): each rule already carries the foundation envelope's
   * status/value/numerator/denominator/reason/period/provenance.
   * @returns {Object} { metric: rateFact }
   */
  _projectRates: function(m2) {
    var rates = {};
    for (var i = 0; i < this.RATE_METRICS.length; i++) {
      var metric = this.RATE_METRICS[i];
      var rule = m2.rules ? m2.rules[metric] : null;
      if (!rule) continue;
      var prov = rule.provenance || {};
      rates[metric] = {
        metric: metric,
        // Foundation availability + reason (data-quality), preserved.
        status: prov.foundationStatus !== undefined ? prov.foundationStatus : null,
        reason: prov.foundationReason !== undefined ? prov.foundationReason : null,
        // Measured value + cohort counts (VERBATIM from the foundation).
        value: rule.value,
        numerator: rule.numerator,
        denominator: rule.denominator,
        period: rule.period,
        // Full foundation provenance chain (walkable to source / cohort /
        // evidence) — never flattened away.
        provenance: prov.foundationProvenance !== undefined ? prov.foundationProvenance : null
      };
    }
    return rates;
  },

  /**
   * Report-level DATA availability (contract §9). Mechanical aggregation
   * of M1 metric availability and M2 rate availability — data
   * availability ONLY, never business health.
   */
  _availability: function(m1, rates) {
    var AVAILABLE = 'AVAILABLE';
    var total = 0;
    var available = 0;

    var m1Names = m1.metrics ? Object.keys(m1.metrics) : [];
    for (var i = 0; i < m1Names.length; i++) {
      total += 1;
      if (m1.metrics[m1Names[i]] && m1.metrics[m1Names[i]].status === AVAILABLE) {
        available += 1;
      }
    }

    var rateNames = Object.keys(rates);
    for (var j = 0; j < rateNames.length; j++) {
      total += 1;
      if (rates[rateNames[j]] && rates[rateNames[j]].status === AVAILABLE) {
        available += 1;
      }
    }

    var status;
    var reason;
    if (total > 0 && available === total) {
      status = this.AVAILABILITY.COMPLETE;
      reason = null;
    } else if (available === 0) {
      status = this.AVAILABILITY.UNAVAILABLE;
      reason =
        'No M1 metric and no M2 rate is AVAILABLE for this period. This reflects DATA AVAILABILITY only — it is not business health, clinical severity, success/failure, or financial state. Unavailable inputs keep their honest status/reason and are never converted to zero.';
    } else {
      status = this.AVAILABILITY.PARTIAL;
      reason =
        'Report built with honest gaps: ' + available + ' of ' + total +
        ' inputs (M1 metrics + M2 rates) are AVAILABLE. Non-available inputs keep value=null with their original reason/provenance — never a fabricated zero. Data availability only.';
    }

    return {
      status: status,
      reason: reason,
      availableInputs: available,
      totalInputs: total,
      m1Status: m1.status,
      m1StatusReason: m1.statusReason
    };
  },

  /**
   * Data-quality provenance surface (contract §8, §19): collect the
   * EXISTING honesty signals so nothing is silently lost. Preservation,
   * never a new business insight.
   */
  _dataQuality: function(m1, m2, rates) {
    var m1Gaps = [];
    if (m1.statusBreakdown) {
      var statuses = Object.keys(m1.statusBreakdown);
      for (var s = 0; s < statuses.length; s++) {
        if (statuses[s] === 'AVAILABLE') continue;
        var metricsForStatus = m1.statusBreakdown[statuses[s]];
        for (var k = 0; k < metricsForStatus.length; k++) {
          m1Gaps.push({ metric: metricsForStatus[k], status: statuses[s] });
        }
      }
    }

    var rateGaps = [];
    var ruleNotes = [];
    var rateNames = Object.keys(rates);
    for (var r = 0; r < rateNames.length; r++) {
      var rate = rates[rateNames[r]];
      if (rate.status !== 'AVAILABLE') {
        rateGaps.push({ metric: rateNames[r], status: rate.status, reason: rate.reason });
      }
      var rule = m2.rules ? m2.rules[rateNames[r]] : null;
      if (rule && rule.status !== 'EVALUATED') {
        ruleNotes.push({ metric: rateNames[r], ruleStatus: rule.status, reason: rule.reason });
      }
    }

    var cohort = m2.cohort || {};
    return {
      m1: {
        status: m1.status,
        gaps: m1Gaps
      },
      m2: {
        sourceFailure: m2.provenance ? m2.provenance.sourceFailure : null,
        rateGaps: rateGaps,
        ruleNotes: ruleNotes,
        cohortTotal: cohort.total !== undefined ? cohort.total : null,
        minimumCohort: m2.minimumCohort,
        unattributableRows: cohort.unattributableRows !== undefined ? cohort.unattributableRows : null,
        conflicts: Array.isArray(cohort.conflicts) ? cohort.conflicts : [],
        thresholdPolicySource: m2.thresholdPolicy ? m2.thresholdPolicy.source : null,
        trendAvailable: m2.trend ? m2.trend.available : null,
        trendReason: m2.trend ? m2.trend.reason : null
      }
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // Internals — SUMMARY projection helpers (pure)
  // ═══════════════════════════════════════════════════════════════

  _summariseMetrics: function(full) {
    var out = [];
    var names = full.m1.requestedMetrics && full.m1.requestedMetrics.length
      ? full.m1.requestedMetrics
      : Object.keys(full.m1.metrics);
    for (var i = 0; i < names.length; i++) {
      var env = full.m1.metrics[names[i]];
      if (!env) continue;
      out.push({
        metric: names[i],
        status: env.status,
        // Honest: numeric value ONLY when AVAILABLE (0 is a valid zero);
        // otherwise null + reason — never a fabricated value.
        value: env.status === 'AVAILABLE' && typeof env.value === 'number' ? env.value : null,
        reason: env.reason !== undefined ? env.reason : null
      });
    }
    return out;
  },

  _summariseRates: function(full) {
    var out = [];
    for (var i = 0; i < this.RATE_METRICS.length; i++) {
      var metric = this.RATE_METRICS[i];
      var rate = full.m2.rates[metric];
      if (!rate) continue;
      var rule = full.m2.rules ? full.m2.rules[metric] : null;
      out.push({
        metric: metric,
        status: rate.status,
        value: rate.status === 'AVAILABLE' && typeof rate.value === 'number' ? rate.value : null,
        reason: rate.reason,
        // Rule facts VERBATIM — no new severity is ever created here.
        ruleStatus: rule ? rule.status : null,
        severity: rule ? rule.severity : null,
        // Brief trend presentation (contract §12): direction only, shown
        // when available; never a causal explanation, never severity.
        trend: this._briefTrend(rule)
      });
    }
    return out;
  },

  /** Brief, non-causal trend presentation (contract §12). */
  _briefTrend: function(rule) {
    if (!rule || !rule.trend) return { available: false, direction: null };
    return {
      available: rule.trend.available === true,
      direction: rule.trend.available === true ? rule.trend.direction : null
    };
  },

  _summariseInsights: function(full) {
    var out = [];
    var insights = full.m2.insights || [];
    // Canonical order preserved (contract §11: no new ranking / no "Top
    // Findings"). Text is verbatim (informational, non-causal).
    for (var i = 0; i < insights.length; i++) {
      var ins = insights[i];
      if (!ins.explanation) continue;
      out.push({
        insightId: ins.insightId,
        metric: ins.metric,
        combined: ins.combined === true,
        patternId: ins.patternId !== undefined ? ins.patternId : null,
        status: ins.status,
        severity: ins.severity,
        reason: ins.reason !== undefined ? ins.reason : null,
        explanation: ins.explanation
      });
    }
    return out;
  },

  /**
   * MANAGEMENT NOTES (contract §13): the M2 recommendations, verbatim,
   * labelled as notes — never "Actions", never automatic actions /
   * notifications / commands / mandatory instructions.
   */
  _summariseManagementNotes: function(full) {
    var out = [];
    var insights = full.m2.insights || [];
    for (var i = 0; i < insights.length; i++) {
      var ins = insights[i];
      if (!ins.recommendation) continue;
      out.push({
        source: ins.combined === true ? (ins.patternId || 'COMBINED') : ins.metric,
        combined: ins.combined === true,
        severity: ins.severity,
        note: ins.recommendation
      });
    }
    return out;
  },

  /**
   * Data-quality WARNINGS for the SUMMARY (contract §21): surface the
   * EXISTING honesty signals from FULL's data-quality provenance. Pure
   * selection — never a new insight, severity, or ranking.
   */
  _summariseDataQuality: function(full) {
    var dq = full.provenance.dataQuality;
    var warnings = [];

    for (var i = 0; i < dq.m1.gaps.length; i++) {
      warnings.push({
        scope: 'M1',
        metric: dq.m1.gaps[i].metric,
        detail: dq.m1.gaps[i].status
      });
    }
    if (dq.m2.sourceFailure) {
      warnings.push({ scope: 'M2', metric: null, detail: 'SOURCE_FAILURE: ' + dq.m2.sourceFailure });
    }
    for (var j = 0; j < dq.m2.rateGaps.length; j++) {
      warnings.push({
        scope: 'M2_RATE',
        metric: dq.m2.rateGaps[j].metric,
        detail: dq.m2.rateGaps[j].status + (dq.m2.rateGaps[j].reason ? ' (' + dq.m2.rateGaps[j].reason + ')' : '')
      });
    }
    for (var k = 0; k < dq.m2.ruleNotes.length; k++) {
      warnings.push({
        scope: 'M2_RULE',
        metric: dq.m2.ruleNotes[k].metric,
        detail: dq.m2.ruleNotes[k].ruleStatus + (dq.m2.ruleNotes[k].reason ? ' (' + dq.m2.ruleNotes[k].reason + ')' : '')
      });
    }
    if (Array.isArray(dq.m2.conflicts) && dq.m2.conflicts.length > 0) {
      warnings.push({ scope: 'M2_COHORT', metric: null, detail: dq.m2.conflicts.length + ' in-period evidence conflict(s)' });
    }
    if (typeof dq.m2.unattributableRows === 'number' && dq.m2.unattributableRows > 0) {
      warnings.push({ scope: 'M2_COHORT', metric: null, detail: dq.m2.unattributableRows + ' unattributable evidence row(s)' });
    }
    if (dq.m2.trendAvailable === false && dq.m2.trendReason) {
      warnings.push({ scope: 'M2_TREND', metric: null, detail: 'trend unavailable (' + dq.m2.trendReason + ')' });
    }
    return warnings;
  },

  // ── Small helpers ──────────────────────────────────────────────

  /** Clinic-local wall-clock string via ReportPeriod (call-time). */
  _wallClock: function(instantMs) {
    return ReportPeriod.formatWallClock(instantMs);
  }
};
