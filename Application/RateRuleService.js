/**
 * RateRuleService — M2 (PHASE 1.6 — RULE / INSIGHT)
 *
 * FROZEN CONTRACT: M2-RULE-INSIGHT-v1
 * Baseline:        0894028ce9d0b450d6a8a4ce049930f3383815da
 * Dependency:      M2-RATE-FOUNDATION-v2 (CLOSED) — the ONLY rates source
 *
 * ─── LAYERING (v2 contract §3, §31, §43) ───
 *   RateFoundationService  →  the ONLY source of the four rates
 *   ReportPeriod           →  period arithmetic (clinic-local Asia/Baghdad)
 *   RateRuleService        →  THIS FILE: rule evaluation + insight generation
 *
 * This layer NEVER re-derives cancellation/change/completion/no-show
 * episodes, appointment-day attribution, or the confirmed cohort from raw
 * repositories. It consumes foundation output exclusively. If a needed
 * field is missing from the foundation: STOP + REPORT GAP (contract §43),
 * never recompute it here.
 *
 * ─── EVALUATION PIPELINE (per metric, v2 contract §8) ───
 *   1 input validation            (§20 — structural check of the envelope)
 *   2 foundation validity         (UNAVAILABLE → NOT_EVALUABLE, foundation
 *                                  reason preserved VERBATIM:
 *                                  ZERO_DENOMINATOR / RATE_EVIDENCE_INVALID)
   * 3 sample sufficiency          (denominator < MINIMUM_COHORT →
 *                                  INSUFFICIENT_SAMPLE — the value stays
 *                                  reported; NO severity, NO zeroing.
 *                                  MINIMUM_COHORT = 10 is a FROZEN
 *                                  business decision (contract §56): the
 *                                  sample gate ALWAYS uses the constant
 *                                  and is evaluated BEFORE any threshold
 *                                  policy is consulted — a policy can
 *                                  never raise or lower the floor.)
 *   4 threshold evaluation        (approved policy → band severity
 *                                  NORMAL/WATCH/HIGH/CRITICAL;
 *                                  no approved policy → NOT_EVALUABLE /
 *                                  RULE_NOT_CONFIGURED — never a default,
 *                                  never a magic number, contract §10/§12;
 *                                  a policy that contradicts the frozen
 *                                  sample floor → NOT_EVALUABLE /
 *                                  RULE_POLICY_INVALID, contract §46:
 *                                  a conflicting governance input is
 *                                  neither silently applied nor silently
 *                                  ignored)
 *   5 severity + confidence       (deterministic, contract §23)
 *
 * ─── THRESHOLD GOVERNANCE (v2 contract §10–§12) ───
 *   THE PROGRAMMER HAS NO AUTHORITY TO INVENT THRESHOLD VALUES.
 *   THRESHOLD_POLICY.policies is EMPTY: no approved threshold values exist
 *   in Config or Contract yet. Until business authorization provides them,
 *   a metric that is AVAILABLE with a sufficient sample evaluates to
 *   NOT_EVALUABLE / RULE_NOT_CONFIGURED. The policy store is data-driven
 *   (thresholdId, metric, direction, threshold bands, minimumSample) so an
 *   approved policy can be added WITHOUT rewriting the engine; effective-
 *   date extension is the documented next step (contract §11).
 *
 * ─── DIRECTION / POLARITY (v2 contract §14) ───
 *   Direction is RULE METADATA, not a hardcoded assumption:
 *     CANCELLATION_RATE  ABOVE  (rising = more cancellations)
 *     CHANGE_RATE        ABOVE  (rising = more rescheduling)
 *     NO_SHOW_RATE       ABOVE  (rising = more no-shows)
 *     COMPLETION_RATE    BELOW  (falling = worse completion behavior)
 *   An approved policy may carry its own direction; the policy's direction
 *   wins (approved data overrides default metadata).
 *
 * ─── SEVERITY (v2 contract §8–§9, BALANCED mode) ───
 *   Band evaluation over the approved policy (per metric):
 *     direction ABOVE: the most severe band with threshold ≤ value
 *     direction BELOW: the most severe band with threshold ≥ value
 *     no band hit → NORMAL
 *   "Exactly at threshold" belongs to the band (inclusive).
 *   CRITICAL is a strong OPERATIONAL signal — it is NOT a system failure,
 *   individual failure, patient failure, or medical quality failure
 *   statement (contract §9).
 *
 * ─── TREND (v2 contract §17, §38) ───
 *   Separate engine, optional (options.includeTrend). Compares the current
 *   foundation batch against ONE previous comparable period derived
 *   DETERMINISTICALLY — never "now - 7 days":
 *     report-type periods  → same ReportPeriod constructor with
 *                            reference = period.startMs - 1 (previous
 *                            clinic-local day / reporting week / month)
 *     raw {start,end}      → the immediately preceding equal-length window
 *                            [start - (end-start), start)
 *   Previous batch comes from the SAME foundation (read-only, one batch
 *   per source). Trend reports TREND_UP / TREND_FLAT / TREND_DOWN per
 *   metric. Trend NEVER alters severity in this version (no approved
 *   trend-severity policy) and NEVER masks an unavailable input (per-metric
 *   availability + reason are preserved).
 *
 * ─── CONFIDENCE (v2 contract §22–§23) ───
 *   Deterministic, explainable, NO statistical formula. The contract names
 *   the factors: foundation validity, sample sufficiency, provenance
 *   completeness, comparison availability. The mapping is:
 *     foundation not AVAILABLE        → null   (invalid evidence is never
 *                                           covered by LOW, contract §22)
 *     INSUFFICIENT_SAMPLE             → LOW    (the value is real; the
 *                                           sample is small)
 *     RULE_NOT_CONFIGURED / EVALUATED → HIGH, downgraded deterministically:
 *                                           provenance incomplete → LOW
 *                                           includeTrend && that metric's
 *                                           comparison unavailable → MEDIUM
 *
 * ─── RULE RESULT STATES (v2 contract §39, §40) ───
 *   NOT_EVALUABLE        (reason: RATE_SOURCE_UNAVAILABLE |
 *                          RATE_EVIDENCE_INVALID | ZERO_DENOMINATOR |
 *                          RULE_NOT_CONFIGURED | RULE_INPUT_INVALID)
 *   INSUFFICIENT_SAMPLE  (value + numerator + denominator preserved)
 *   EVALUATED            (severity: NORMAL | WATCH | HIGH | CRITICAL)
 *   Data availability is NEVER mixed with business severity, and no
 *   silent fallback exists (contract §46): nothing is converted to 0 /
 *   NORMAL / LOW.
 *
 * ─── INSIGHTS (v2 contract §21, §27, §28) ───
 *   One insight per metric (always — including NOT_EVALUABLE ones, so a
 *   report can show WHY a rate is absent) + combined insights fired only
 *   from reliable inputs (all involved metrics EVALUATED with severity
 *   HIGH or CRITICAL):
 *     ATTENDANCE_BEHAVIOR_PATTERN  = cancellation + no-show elevated
 *     RESCHEDULING_PATTERN         = cancellation + change elevated
 *     MULTI_METRIC_ELEVATION       = 3+ metrics elevated
 *   Insight text is informational, non-causal, non-blaming,
 *   non-patient-specific, non-automatic (contract §15, §16, §24–§27):
 *   it describes an operational pattern and suggests a management
 *   REVIEW — it never assigns cause or fault, names no patient,
 *   triggers no action, and no individual-facing surface exists here.
 *   Combined confidence = the minimum of the input confidences
 *   (deterministic).
 *
 * ─── RECOMMENDATION SCOPE (v2 contract §24) ───
 *   MANAGEMENT-ONLY / INFORMATIONAL. Static, testable templates per
 *   (metric, severity). Never automatic, never causal, never medical,
 *   never patient-specific, never individual-facing.
 *
 * ─── READ-ONLY (v2 contract §30) ───
 *   NO writes, NO locks, NO sheet creation, NO external service calls,
 *   NO recovery, NO data repair. No repository method is added or called
 *   from this layer; the only data path is RateFoundationService (which
 *   itself is a read-only, one-read-per-source boundary).
 *
 * ─── DETERMINISM (v2 contract §29) ───
 *   Same input → same output. No random values, no wall-clock use in this
 *   layer: evaluatedAt / asOfMs are inherited VERBATIM from the foundation
 *   batch (the approved runtime semantics), including the trend batch's
 *   own asOfMs recorded in trend provenance.
 *
 * ─── EVALUATION-ORDER NOTE (clasp alphabetical) ───
 *   All cross-module references (RateFoundationService, ReportPeriod,
 *   Result) are resolved at CALL time — the same discipline as the
 *   other Application-level services.
 */
const RateRuleService = {

  // ── Approved business decision (v2 contract §56 — FROZEN) ─────────
  MINIMUM_COHORT: 10,

  RULE_STATES: {
    NOT_EVALUABLE: 'NOT_EVALUABLE',
    INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
    EVALUATED: 'EVALUATED'
  },

  SEVERITIES: {
    NORMAL: 'NORMAL',
    WATCH: 'WATCH',
    HIGH: 'HIGH',
    CRITICAL: 'CRITICAL'
  },

  SEVERITY_RANK: { WATCH: 1, HIGH: 2, CRITICAL: 3 },

  DIRECTIONS: {
    ABOVE: 'ABOVE',
    BELOW: 'BELOW'
  },

  CONFIDENCE: {
    HIGH: 'HIGH',
    MEDIUM: 'MEDIUM',
    LOW: 'LOW'
  },

  CONFIDENCE_RANK: { LOW: 1, MEDIUM: 2, HIGH: 3 },

  TREND_DIRECTIONS: {
    TREND_UP: 'TREND_UP',
    TREND_FLAT: 'TREND_FLAT',
    TREND_DOWN: 'TREND_DOWN'
  },

  REASONS: {
    RATE_SOURCE_UNAVAILABLE: 'RATE_SOURCE_UNAVAILABLE',
    RATE_EVIDENCE_INVALID: 'RATE_EVIDENCE_INVALID',
    ZERO_DENOMINATOR: 'ZERO_DENOMINATOR',
    INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
    RULE_NOT_CONFIGURED: 'RULE_NOT_CONFIGURED',
    RULE_INPUT_INVALID: 'RULE_INPUT_INVALID',
    RULE_POLICY_INVALID: 'RULE_POLICY_INVALID'
  },

  /**
   * Threshold policy store (v2 contract §10–§12).
   *
   * EMPTY by design: no approved threshold values exist yet. The engine
   * is fully data-driven; an authorized policy is added as a plain
   * object — no engine change required. Shape of an approved entry:
   *   {
   *     thresholdId: string,          stable id
   *     metric: 'CANCELLATION_RATE' | 'CHANGE_RATE' | 'COMPLETION_RATE' | 'NO_SHOW_RATE',
   *     direction: 'ABOVE' | 'BELOW',
   *     minimumSample: number,        OPTIONAL — must equal the frozen
   *                                    MINIMUM_COHORT when present; a
   *                                    conflicting value invalidates the
   *                                    policy (RULE_POLICY_INVALID).
   *                                    Re-deciding the sample floor is a
   *                                    contract-level change (updating
   *                                    the frozen constant), never a
   *                                    policy-level one (contract §56).
   *     thresholds: [ { threshold: number, severity: 'WATCH'|'HIGH'|'CRITICAL' }, ... ]
   *   }
   * Band semantics: ABOVE → most severe band with threshold ≤ value;
   * BELOW → most severe band with threshold ≥ value; no hit → NORMAL.
   * Inclusive at the band value ("exactly at threshold" belongs to the
   * band). Future extension: effective-date fields per entry.
   */
  THRESHOLD_POLICY: {
    source: 'NONE — no approved threshold values exist yet (business authorization required); until a policy is approved, rules report RULE_NOT_CONFIGURED',
    policies: []
  },

  /**
   * Per-metric rule metadata (v2 contract §13, §14): one rule per metric,
   * direction as DATA. labelAr is used only in human explanation text
   * (machine fields stay English / metric-named).
   */
  METRIC_RULES: [
    { ruleId: 'RULE-CANCELLATION', metric: 'CANCELLATION_RATE', direction: 'ABOVE', labelAr: 'الإلغاءات' },
    { ruleId: 'RULE-CHANGE', metric: 'CHANGE_RATE', direction: 'ABOVE', labelAr: 'تغييرات المواعيد' },
    { ruleId: 'RULE-COMPLETION', metric: 'COMPLETION_RATE', direction: 'BELOW', labelAr: 'إنجاز المواعيد' },
    { ruleId: 'RULE-NO_SHOW', metric: 'NO_SHOW_RATE', direction: 'ABOVE', labelAr: 'عدم الحضور' }
  ],

  /**
   * Combined-insight patterns (v2 contract §19). A pattern fires only
   * when EVERY involved metric is a reliable input: rule status
   * EVALUATED with severity HIGH or CRITICAL. The general pattern fires
   * at 3+ elevated metrics. No pattern may exceed input validity.
   */
  COMBINED_PATTERNS: [
    { patternId: 'ATTENDANCE_BEHAVIOR_PATTERN', metrics: ['CANCELLATION_RATE', 'NO_SHOW_RATE'] },
    { patternId: 'RESCHEDULING_PATTERN', metrics: ['CANCELLATION_RATE', 'CHANGE_RATE'] },
    { patternId: 'MULTI_METRIC_ELEVATION', metrics: null, minimumElevated: 3 }
  ],

  ELEVATED_SEVERITIES: ['HIGH', 'CRITICAL'],

  TREND_EPSILON_MS: 1e-9,

  // ═══════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════

  /**
   * Evaluate the four rate rules for one period.
   *
   * @param {{start: Date|number, end: Date|number}} period — same
   *   canonical contract as RateFoundationService (start inclusive,
   *   end exclusive). Period validation is DELEGATED to the foundation
   *   (single source of period semantics — never redefined here).
   * @param {{includeTrend?: boolean}} [options] — includeTrend requests
   *   the previous-comparable-period comparison (one extra foundation
   *   batch). Default false. No other options in this version.
   * @returns {Result}
   *   ok({ period, evaluatedAt, asOfMs, rules, cohort, minimumCohort,
   *        thresholdPolicy, trend, provenance })
   *   | fail(RATE_PERIOD_INVALID | RATE_SOURCE_UNAVAILABLE)  — the
   *     foundation failure propagates VERBATIM (shared-source semantics:
   *     one failing source fails the whole batch, never a partial result)
   */
  evaluateRules: function(period, options) {
    var RFSRef = RateFoundationService; // call-time (clasp order)
    var periodResult = RFSRef._canonicalPeriod(period);
    if (!periodResult.ok) return periodResult;
    return this._evaluateRulesInternal(periodResult.data, options, null);
  },

  /**
   * Report-type convenience: the period comes from
   * ReportPeriod.periodFor(reportType, reference) — DAILY / WEEKLY
   * (Saturday-start reporting calendar) / MONTHLY, clinic-local
   * Asia/Baghdad. The whole evaluation delegates to the same internal
   * path (never a different rate calculation — contract §37).
   *
   * @returns {Result} ok(report-shaped result with described period) |
   *                   fail(REPORT_TYPE_UNKNOWN | REPORT_PERIOD_INVALID |
   *                        RATE_PERIOD_INVALID | RATE_SOURCE_UNAVAILABLE)
   */
  evaluateRulesForReport: function(reportType, reference, options) {
    var RPRef = ReportPeriod; // call-time (clasp order)
    var periodResult = RPRef.periodFor(reportType, reference);
    if (!periodResult.ok) return periodResult;
    var per = periodResult.data;

    var result = this._evaluateRulesInternal(per, options, reportType);
    if (!result.ok) return result;

    result.data.period = Object.assign(
      { startMs: per.startMs, endMs: per.endMs },
      RPRef.describe(reportType, per)
    );
    return result;
  },

  /**
   * Generate the full insight set for one period: one insight per metric
   * (always — including NOT_EVALUABLE ones) + combined insights fired
   * from reliable inputs only. Delegates evaluation to evaluateRules
   * (one foundation batch; a second batch only when includeTrend=true).
   *
   * @returns {Result} ok({ ...evaluateRules result, insights: [...] })
   */
  generateInsights: function(period, options) {
    var rulesResult = this.evaluateRules(period, options);
    if (!rulesResult.ok) return rulesResult;
    return Result.ok(this._withInsights(rulesResult.data));
  },

  /**
   * Report-type convenience for generateInsights (same delegation
   * discipline as evaluateRulesForReport).
   */
  generateInsightsForReport: function(reportType, reference, options) {
    var rulesResult = this.evaluateRulesForReport(reportType, reference, options);
    if (!rulesResult.ok) return rulesResult;
    return Result.ok(this._withInsights(rulesResult.data));
  },

  // ═══════════════════════════════════════════════════════════════
  // Evaluation pipeline internals
  // ═══════════════════════════════════════════════════════════════

  /**
   * Shared evaluation path for canonical periods. `reportType` is set
   * only on the report-type path (it drives previous-period derivation
   * for trend via ReportPeriod — never invented arithmetic).
   */
  _evaluateRulesInternal: function(per, options, reportType) {
    var RFSRef = RateFoundationService; // call-time
    var opt = options || {};
    var includeTrend = !!opt.includeTrend;

    // ONE foundation batch (read-only, one read per source). The
    // foundation failure propagates VERBATIM — the shared denominator
    // couples all four rules; no partial-healthy rule set is exposed
    // (contract §17, §45).
    var currentResult = RFSRef.calculateRates({ start: per.startMs, end: per.endMs });
    if (!currentResult.ok) return currentResult;
    var current = currentResult.data;

    var trend = includeTrend
      ? this._buildTrend(RFSRef, per, current, reportType)
      : null;

    var ctx = { current: current, trend: trend, includeTrend: includeTrend };
    var rules = {};
    for (var i = 0; i < this.METRIC_RULES.length; i++) {
      var meta = this.METRIC_RULES[i];
      rules[meta.metric] = this._evaluateMetricRule(meta, current.rates[meta.metric], ctx);
    }

    return Result.ok({
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: current.evaluatedAt,
      asOfMs: current.asOfMs,
      rules: rules,
      cohort: current.cohort,
      minimumCohort: this.MINIMUM_COHORT,
      thresholdPolicy: {
        source: this.THRESHOLD_POLICY.source,
        configuredMetrics: this._configuredMetrics()
      },
      trend: trend,
      provenance: {
        layer: 'M2 RULE / INSIGHT — read-only, over RateFoundationService output only',
        readPolicy: 'raw repository reads: NONE — the four rates come exclusively from RateFoundationService (one batch per source; a second batch only when includeTrend=true)',
        sourceFailure: current.provenance.sourceFailure,
        foundation: current.provenance
      }
    });
  },

  /**
   * One metric rule (v2 contract §13, §20, §39). Each metric has its own
   * rule entry with its own direction metadata; the pipeline steps are
   * shared so semantics stay uniform.
   */
  _evaluateMetricRule: function(meta, env, ctx) {
    var self = this;
    var base = {
      ruleId: meta.ruleId,
      metric: meta.metric,
      direction: meta.direction,
      minimumSample: this.MINIMUM_COHORT,
      value: null,
      numerator: null,
      denominator: null,
      threshold: null,
      thresholdId: null,
      status: null,
      severity: null,
      reason: null,
      confidence: null,
      period: ctx.current.period,
      trend: this._trendFor(meta.metric, ctx),
      provenance: {
        foundationStatus: env && env.status !== undefined ? env.status : null,
        foundationReason: env && env.reason !== undefined ? env.reason : null,
        foundationProvenance: env && env.provenance !== undefined ? env.provenance : null,
        thresholdPolicySource: this.THRESHOLD_POLICY.source
      }
    };

    // 1 — input validation (contract §20). Structural defects are a
    // technical rule-level failure, never a silent fallback.
    if (!env || typeof env !== 'object' || env.metric !== meta.metric) {
      return this._sealRule(base, this.RULE_STATES.NOT_EVALUABLE, null, this.REASONS.RULE_INPUT_INVALID, null);
    }
    if (env.status !== 'AVAILABLE' && env.status !== 'UNAVAILABLE') {
      return this._sealRule(base, this.RULE_STATES.NOT_EVALUABLE, null, this.REASONS.RULE_INPUT_INVALID, null);
    }
    var prov = env.provenance;
    var num = prov ? prov.numerator : null;
    var den = prov ? prov.denominator : null;
    if (!this._isNonNegativeInt(num) || !this._isNonNegativeInt(den)) {
      return this._sealRule(base, this.RULE_STATES.NOT_EVALUABLE, null, this.REASONS.RULE_INPUT_INVALID, null);
    }
    if (!env.period || typeof env.period.startMs !== 'number' || !isFinite(env.period.startMs) ||
        typeof env.period.endMs !== 'number' || !isFinite(env.period.endMs) || !(env.period.startMs < env.period.endMs)) {
      return this._sealRule(base, this.RULE_STATES.NOT_EVALUABLE, null, this.REASONS.RULE_INPUT_INVALID, null);
    }

    base.numerator = num;
    base.denominator = den;
    base.value = env.status === 'AVAILABLE' ? env.value : null;

    // 2 — foundation validity: UNAVAILABLE stays UNAVAILABLE. The
    // foundation reason is preserved verbatim (contract §6, §20, §40).
    if (env.status !== 'AVAILABLE') {
      return this._sealRule(base, this.RULE_STATES.NOT_EVALUABLE, null, env.reason, null);
    }
    if (typeof base.value !== 'number' || !isFinite(base.value)) {
      return this._sealRule(base, this.RULE_STATES.NOT_EVALUABLE, null, this.REASONS.RULE_INPUT_INVALID, null);
    }

    // 3 — sample sufficiency (contract §7, §56): the rate stays
    // reported (value + numerator + denominator), but NO severity is
    // assigned. The floor is the FROZEN MINIMUM_COHORT constant — a
    // threshold policy can never override it, and this gate runs BEFORE
    // any policy is consulted (contract §8 pipeline order).
    base.minimumSample = this.MINIMUM_COHORT;
    if (den < this.MINIMUM_COHORT) {
      return this._sealRule(base, this.RULE_STATES.INSUFFICIENT_SAMPLE, null, this.REASONS.INSUFFICIENT_SAMPLE, this.CONFIDENCE.LOW);
    }

    // 4 — threshold policy (contract §10–§12, §46): no approved policy
    // for this metric → NOT_EVALUABLE / RULE_NOT_CONFIGURED. The value
    // is known and reported; only the classification is withheld.
    var policy = this._policyFor(meta.metric);
    if (!policy) {
      return this._sealRule(base, this.RULE_STATES.NOT_EVALUABLE, null, this.REASONS.RULE_NOT_CONFIGURED,
        this._confidenceFor(env, ctx, meta));
    }

    // A policy must agree with the frozen sample floor. A declared
    // minimumSample that differs from MINIMUM_COHORT (or is malformed)
    // conflicts with an approved business decision: the policy is
    // rejected for this metric — not silently applied, not silently
    // ignored (contract §46). Re-deciding the floor is a contract-level
    // change (updating the frozen constant), never a policy-level one.
    var policyConflict = this._policySampleConflict(policy);
    if (policyConflict) {
      base.provenance.policyConflict = policyConflict;
      return this._sealRule(base, this.RULE_STATES.NOT_EVALUABLE, null, this.REASONS.RULE_POLICY_INVALID,
        this._confidenceFor(env, ctx, meta));
    }

    var band = this._applyPolicy(policy, meta, base.value);
    base.severity = band.severity;
    base.threshold = band.threshold;
    base.thresholdId = policy.thresholdId;
    return this._sealRule(base, this.RULE_STATES.EVALUATED, band.severity, null,
      this._confidenceFor(env, ctx, meta));
  },

  /**
   * Frozen-floor governance check (contract §56). Returns a conflict
   * description, or null when the policy is consistent with the frozen
   * MINIMUM_COHORT (absent field = consistent).
   */
  _policySampleConflict: function(policy) {
    if (policy.minimumSample === undefined) return null;
    if (!this._isNonNegativeInt(policy.minimumSample)) {
      return 'policy minimumSample ' + String(policy.minimumSample) +
        ' is malformed (must be a non-negative integer)';
    }
    if (policy.minimumSample !== this.MINIMUM_COHORT) {
      return 'policy minimumSample ' + policy.minimumSample +
        ' conflicts with the frozen MINIMUM_COHORT = ' + this.MINIMUM_COHORT +
        ' (approved business decision — a threshold policy cannot raise or lower the sample floor)';
    }
    return null;
  },

  /** Fills the terminal fields of a rule result (single exit discipline). */
  _sealRule: function(base, status, severity, reason, confidence) {
    base.status = status;
    base.severity = severity === undefined ? null : severity;
    base.reason = reason === undefined ? null : reason;
    base.confidence = confidence === undefined ? null : confidence;
    return base;
  },

  /** The approved policy for a metric (at most one per metric in v1). */
  _policyFor: function(metric) {
    var policies = this.THRESHOLD_POLICY.policies;
    for (var i = 0; i < policies.length; i++) {
      if (policies[i] && policies[i].metric === metric) return policies[i];
    }
    return null;
  },

  _configuredMetrics: function() {
    var out = [];
    var policies = this.THRESHOLD_POLICY.policies;
    for (var i = 0; i < policies.length; i++) {
      if (policies[i] && policies[i].metric && out.indexOf(policies[i].metric) === -1) {
        out.push(policies[i].metric);
      }
    }
    return out;
  },

  /**
   * Deterministic band evaluation (contract §8, §9). direction: the
   * policy's approved direction wins; otherwise the rule metadata.
   */
  _applyPolicy: function(policy, meta, value) {
    var direction = this._isDirection(policy.direction) ? policy.direction : meta.direction;
    var bands = policy.thresholds || [];
    var best = null;
    for (var i = 0; i < bands.length; i++) {
      var band = bands[i];
      if (!band || typeof band.threshold !== 'number' || !isFinite(band.threshold)) continue;
      if (!this.SEVERITY_RANK.hasOwnProperty(band.severity)) continue;
      var hit = direction === this.DIRECTIONS.BELOW
        ? value <= band.threshold
        : value >= band.threshold;
      if (!hit) continue;
      if (best === null || this.SEVERITY_RANK[band.severity] > this.SEVERITY_RANK[best.severity]) {
        best = band;
      }
    }
    if (!best) return { severity: this.SEVERITIES.NORMAL, threshold: null };
    return { severity: best.severity, threshold: best.threshold };
  },

  /**
   * Deterministic confidence (contract §22–§23). NO statistical formula —
   * a transparent mapping over the contract-named factors: foundation
   * validity (gated upstream: invalid → null), sample sufficiency (gated
   * upstream: insufficient → LOW), provenance completeness, comparison
   * availability.
   */
  _confidenceFor: function(env, ctx, meta) {
    if (!this._provenanceComplete(env, meta)) return this.CONFIDENCE.LOW;
    if (ctx.includeTrend) {
      var t = this._trendFor(meta.metric, ctx);
      if (!t || t.available !== true) return this.CONFIDENCE.MEDIUM;
    }
    return this.CONFIDENCE.HIGH;
  },

  /**
   * Provenance completeness of a foundation envelope (contract §27,
   * §28): the WHOLE minimum walkable chain must be present and
   * well-typed before the "provenance completeness" confidence factor
   * can hold — a partial check could overstate confidence when
   * important provenance parts are lost. Every field of the foundation
   * envelope's provenance minimum is enforced:
   *
   *   envelope level : metric (matches the rule's metric), status,
   *                    value/status consistency, period, asOfMs,
   *                    evaluatedAt
   *   provenance level: numerator, denominator, formula,
   *                    appointmentDayBasis, periodSemantics,
   *                    cohortDefinition, cohortByPath, reusedSlots,
   *                    reusedSlotEpisodes, unattributableRows,
   *                    outOfPeriodConflicts, changeRowsMissingNewSlotId,
   *                    sourceFailure (present, null on a healthy batch),
   *                    conflicts (array), evidence block (source,
   *                    non-empty fields, aggregation, periodFilter)
   */
  _provenanceComplete: function(env, meta) {
    if (!env || typeof env !== 'object') return false;
    if (env.metric !== meta.metric) return false;
    if (env.status !== 'AVAILABLE' && env.status !== 'UNAVAILABLE') return false;
    if (env.status === 'AVAILABLE') {
      if (typeof env.value !== 'number' || !isFinite(env.value) || env.value < 0) return false;
    } else if (env.value !== null) {
      return false;
    }
    if (typeof env.asOfMs !== 'number' || !isFinite(env.asOfMs)) return false;
    if (!env.evaluatedAt) return false;
    if (!env.period || typeof env.period.startMs !== 'number' || !isFinite(env.period.startMs) ||
        typeof env.period.endMs !== 'number' || !isFinite(env.period.endMs) ||
        !(env.period.startMs < env.period.endMs)) return false;

    var prov = env.provenance;
    if (!prov || typeof prov !== 'object') return false;
    if (!this._isNonNegativeInt(prov.numerator)) return false;
    if (!this._isNonNegativeInt(prov.denominator)) return false;
    if (typeof prov.formula !== 'string' || prov.formula.trim() === '') return false;
    if (typeof prov.appointmentDayBasis !== 'string' || prov.appointmentDayBasis.trim() === '') return false;
    if (typeof prov.periodSemantics !== 'string' || prov.periodSemantics.trim() === '') return false;
    if (typeof prov.cohortDefinition !== 'string' || prov.cohortDefinition.trim() === '') return false;
    if (!prov.cohortByPath || typeof prov.cohortByPath !== 'object') return false;
    if (!this._isNonNegativeInt(prov.reusedSlots)) return false;
    if (!this._isNonNegativeInt(prov.reusedSlotEpisodes)) return false;
    if (!this._isNonNegativeInt(prov.unattributableRows)) return false;
    if (!this._isNonNegativeInt(prov.outOfPeriodConflicts)) return false;
    if (!this._isNonNegativeInt(prov.changeRowsMissingNewSlotId)) return false;
    // sourceFailure must be PRESENT and null on a healthy batch envelope
    if (!Object.prototype.hasOwnProperty.call(prov, 'sourceFailure')) return false;
    if (prov.sourceFailure !== null) return false;
    if (!Array.isArray(prov.conflicts)) return false;

    var ev = prov.evidence;
    if (!ev || typeof ev !== 'object') return false;
    if (typeof ev.source !== 'string' || ev.source.trim() === '') return false;
    if (!Array.isArray(ev.fields) || ev.fields.length === 0) return false;
    if (typeof ev.aggregation !== 'string' || ev.aggregation.trim() === '') return false;
    if (typeof ev.periodFilter !== 'string' || ev.periodFilter.trim() === '') return false;
    return true;
  },

  _trendFor: function(metric, ctx) {
    if (!ctx.trend) return null;
    return ctx.trend.metrics.hasOwnProperty(metric) ? ctx.trend.metrics[metric] : null;
  },

  // ═══════════════════════════════════════════════════════════════
  // Trend engine (separate from absolute evaluation — contract §17)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Previous-comparable-period comparison via ONE extra foundation batch
   * (read-only). The previous period is derived DETERMINISTICALLY:
   *   report-type path → the same ReportPeriod constructor at
   *                      reference = current.startMs - 1
   *   raw period path  → the immediately preceding equal-length window
   * Trend never alters severity in this version and never masks an
   * unavailable input: per-metric availability + reason are preserved.
   */
  _buildTrend: function(RFSRef, per, current, reportType) {
    var prevPeriod = null;

    if (reportType) {
      var RPRef = ReportPeriod; // call-time
      var pr = RPRef.periodFor(reportType, per.startMs - 1);
      if (!pr.ok) {
        return this._unavailableTrend(null, pr.error.code);
      }
      prevPeriod = { startMs: pr.data.startMs, endMs: pr.data.endMs };
    } else {
      var len = per.endMs - per.startMs;
      prevPeriod = { startMs: per.startMs - len, endMs: per.startMs };
    }

    var prevResult = RFSRef.calculateRates({ start: prevPeriod.startMs, end: prevPeriod.endMs });
    if (!prevResult.ok) {
      return this._unavailableTrend(prevPeriod, prevResult.error.code);
    }
    var prev = prevResult.data;

    var metrics = {};
    var self = this;
    this.METRIC_RULES.forEach(function(meta) {
      var cEnv = current.rates[meta.metric];
      var pEnv = prev.rates[meta.metric];
      var cOk = cEnv.status === 'AVAILABLE' && typeof cEnv.value === 'number' && isFinite(cEnv.value);
      var pOk = pEnv.status === 'AVAILABLE' && typeof pEnv.value === 'number' && isFinite(pEnv.value);
      if (!cOk || !pOk) {
        metrics[meta.metric] = {
          available: false,
          direction: null,
          reason: !cOk ? cEnv.reason : pEnv.reason,
          current: cEnv.value,
          previous: pEnv.value
        };
        return;
      }
      var diff = cEnv.value - pEnv.value;
      var direction = Math.abs(diff) <= self.TREND_EPSILON_MS
        ? self.TREND_DIRECTIONS.TREND_FLAT
        : (diff > 0 ? self.TREND_DIRECTIONS.TREND_UP : self.TREND_DIRECTIONS.TREND_DOWN);
      metrics[meta.metric] = {
        available: true,
        direction: direction,
        reason: null,
        current: cEnv.value,
        previous: pEnv.value,
        previousDenominator: pEnv.provenance.denominator
      };
    });

    return {
      available: true,
      reason: null,
      basis: 'PREVIOUS_COMPARABLE_PERIOD',
      period: { startMs: prevPeriod.startMs, endMs: prevPeriod.endMs },
      asOfMs: prev.asOfMs,
      metrics: metrics
    };
  },

  _unavailableTrend: function(period, reason) {
    var metrics = {};
    var self = this;
    this.METRIC_RULES.forEach(function(meta) {
      metrics[meta.metric] = { available: false, direction: null, reason: reason, current: null, previous: null };
    });
    return {
      available: false,
      reason: reason,
      basis: 'PREVIOUS_COMPARABLE_PERIOD',
      period: period ? { startMs: period.startMs, endMs: period.endMs } : null,
      asOfMs: null,
      metrics: metrics
    };
  },

  // ═══════════════════════════════════════════════════════════════
  // Insight generation (contract §19, §21, §27–§29, §41–§42)
  // ═══════════════════════════════════════════════════════════════

  _withInsights: function(data) {
    var insights = [];
    var self = this;
    this.METRIC_RULES.forEach(function(meta) {
      insights.push(self._buildMetricInsight(meta, data.rules[meta.metric], data));
    });
    var combined = this._buildCombinedInsights(data);
    for (var i = 0; i < combined.length; i++) insights.push(combined[i]);
    return Object.assign({}, data, { insights: insights });
  },

  _buildMetricInsight: function(meta, rule, data) {
    var p = rule.provenance;
    return {
      insightId: 'M2I-' + meta.metric + '-' + data.period.startMs,
      ruleId: meta.ruleId,
      metric: meta.metric,
      combined: false,
      status: rule.status,
      severity: rule.severity,
      value: rule.value,
      numerator: rule.numerator,
      denominator: rule.denominator,
      period: data.period,
      confidence: rule.confidence,
      reason: rule.reason,
      explanation: this._explanationFor(meta, rule, data),
      recommendation: this._recommendationFor(meta, rule),
      provenance: {
        period: data.period,
        evaluatedAt: data.evaluatedAt,
        asOfMs: data.asOfMs,
        numerator: rule.numerator,
        denominator: rule.denominator,
        sources: data.provenance.foundation.sources,
        cohort: data.cohort,
        foundationStatus: p.foundationStatus,
        foundationReason: p.foundationReason,
        foundationProvenance: p.foundationProvenance
      }
    };
  },

  /**
   * Combined insights (contract §19): fired ONLY from reliable inputs —
   * every involved metric must be EVALUATED with severity HIGH or
   * CRITICAL. No pattern may exceed input validity. Text is
   * informational and non-causal (contract §15, §16).
   */
  _buildCombinedInsights: function(data) {
    var self = this;
    var elevated = {};
    this.METRIC_RULES.forEach(function(meta) {
      var r = data.rules[meta.metric];
      if (r.status === self.RULE_STATES.EVALUATED &&
          self.ELEVATED_SEVERITIES.indexOf(r.severity) !== -1) {
        elevated[meta.metric] = r;
      }
    });
    var elevatedCount = Object.keys(elevated).length;

    var out = [];
    this.COMBINED_PATTERNS.forEach(function(pattern) {
      var involved = null;
      if (pattern.metrics) {
        var all = pattern.metrics.every(function(m) { return elevated.hasOwnProperty(m); });
        if (!all) return;
        involved = pattern.metrics.slice();
      } else {
        if (elevatedCount < pattern.minimumElevated) return;
        involved = self.METRIC_RULES.map(function(m) { return m.metric; })
          .filter(function(m) { return elevated.hasOwnProperty(m); });
      }
      out.push(self._buildCombinedInsight(pattern.patternId, involved, elevated, data));
    });
    return out;
  },

  _buildCombinedInsight: function(patternId, involved, elevated, data) {
    var self = this;
    var inputs = involved.map(function(m) {
      var r = elevated[m];
      return {
        metric: m,
        ruleId: r.ruleId,
        status: r.status,
        severity: r.severity,
        value: r.value,
        numerator: r.numerator,
        denominator: r.denominator,
        foundationStatus: r.provenance.foundationStatus,
        foundationReason: r.provenance.foundationReason
      };
    });
    // Combined confidence = the minimum of the input confidences
    // (deterministic; all inputs are reliable by construction).
    var worst = null;
    inputs.forEach(function(inp) {
      var c = elevated[inp.metric].confidence;
      if (!c) return;
      if (worst === null || self.CONFIDENCE_RANK[c] < self.CONFIDENCE_RANK[worst]) worst = c;
    });
    var texts = this._combinedTexts(patternId, inputs.length);
    return {
      insightId: 'M2I-COMBO-' + patternId + '-' + data.period.startMs,
      ruleId: null,
      metric: null,
      combined: true,
      patternId: patternId,
      metrics: involved.slice(),
      status: this.RULE_STATES.EVALUATED,
      severity: null, // no approved combined-severity policy in this version
      value: null,
      numerator: null,
      denominator: null,
      period: data.period,
      confidence: worst,
      reason: null,
      explanation: texts.explanation,
      recommendation: texts.recommendation,
      provenance: {
        period: data.period,
        evaluatedAt: data.evaluatedAt,
        asOfMs: data.asOfMs,
        sources: data.provenance.foundation.sources,
        cohort: data.cohort,
        inputs: inputs
      }
    };
  },

  // ── Human text (informational / non-causal / non-blaming /
  //    non-patient-specific / non-automatic — contract §24–§27, §41) ──

  _fmtPct: function(value) {
    return String(Math.round(value * 100) / 100);
  },

  _concernPhrase: function(direction) {
    return direction === this.DIRECTIONS.BELOW ? 'أدنى من الحد المعتمد' : 'أعلى من الحد المعتمد';
  },

  _trendSuffix: function(rule) {
    if (!rule.trend || rule.trend.available !== true) return '';
    var map = {
      TREND_UP: 'صاعد',
      TREND_DOWN: 'هابط',
      TREND_FLAT: 'مستقر'
    };
    return 'الاتجاه مقارنة بالفترة السابقة المقابلة: ' + map[rule.trend.direction] + '.';
  },

  _explanationFor: function(meta, rule, data) {
    var label = meta.labelAr;
    var min = this.MINIMUM_COHORT;
    var text;
    switch (rule.status) {
      case this.RULE_STATES.EVALUATED:
        if (rule.severity === this.SEVERITIES.NORMAL) {
          text = 'معدل ' + label + ' (' + this._fmtPct(rule.value) + '%) ضمن الحد المعتمد خلال الفترة، على عينة من ' +
            rule.denominator + ' appointment episode.';
        } else {
          text = 'معدل ' + label + ' (' + this._fmtPct(rule.value) + '%) ' + this._concernPhrase(rule.direction) +
            ' خلال الفترة، على عينة من ' + rule.denominator + ' appointment episode';
          if (rule.severity === this.SEVERITIES.WATCH) {
            text += ' — إشارة تستحق المتابعة.';
          } else if (rule.severity === this.SEVERITIES.HIGH) {
            text += ' — إشارة تشغيلية تستحق مراجعة إدارية.';
          } else {
            text += ' — إشارة تشغيلية قوية تستحق انتباهًا إداريًا واضحًا.';
          }
        }
        break;
      case this.RULE_STATES.INSUFFICIENT_SAMPLE:
        text = 'معدل ' + label + ' (' + this._fmtPct(rule.value) + '%) محسوب على عينة من ' + rule.denominator +
          ' appointment episode، أقل من الحد الأدنى المعتمد (' + min + ') — لا يُصنَّف severity.';
        break;
      case this.RULE_STATES.NOT_EVALUABLE:
      default:
        if (rule.reason === this.REASONS.ZERO_DENOMINATOR) {
          text = 'لا توجد أي appointment episode قابلة للإثبات في الفترة — المعدل غير محدد (ZERO_DENOMINATOR).';
        } else if (rule.reason === this.REASONS.RATE_EVIDENCE_INVALID) {
          text = 'أدلة الفترة المتوفرة متضاربة أو تالفة — لا يمكن تقييم المعدل (RATE_EVIDENCE_INVALID).';
        } else if (rule.reason === this.REASONS.RULE_NOT_CONFIGURED) {
          text = 'المعدل متاح والعينة كافية (' + rule.denominator + ')، لكن لا يوجد threshold policy معتمد لهذا المقياس — لا يُصنَّف (RULE_NOT_CONFIGURED).';
        } else if (rule.reason === this.REASONS.RULE_POLICY_INVALID) {
          text = 'سياسة الـ threshold المتاحة لهذا المقياس تتعارض مع قرار إداري مجمد (حد العينة الأدنى المعتمد) — لا يُصنَّف (RULE_POLICY_INVALID).';
        } else if (rule.reason === this.REASONS.RATE_SOURCE_UNAVAILABLE) {
          text = 'المصدر الأساسي للمعدل غير قابل للقراءة — لا يمكن تقييم القاعدة (RATE_SOURCE_UNAVAILABLE).';
        } else {
          text = 'إدخال غير صالح من طبقة الأساس — لا يمكن تقييم القاعدة (RULE_INPUT_INVALID).';
        }
        break;
    }
    return text + this._trendSuffix(rule);
  },

  /**
   * Static recommendation templates per (metric, severity) — testable
   * (contract §42), management-only, informational, non-automatic,
   * non-causal, non-medical, non-patient-specific (contract §24, §27).
   * No recommendation for NORMAL / NOT_EVALUABLE (nothing to review).
   */
  _recommendationFor: function(meta, rule) {
    var label = meta.labelAr;
    switch (rule.status) {
      case this.RULE_STATES.EVALUATED:
        if (rule.severity === this.SEVERITIES.WATCH) {
          return 'تتبع معدل ' + label + ' في الفترات القادمة ومقارنته بالفترات السابقة.';
        }
        if (rule.severity === this.SEVERITIES.HIGH) {
          return 'مراجعة نمط ' + label + ' خلال الفترة، ومقارنته بالفترات السابقة، ومراجعة السياق التشغيلي.';
        }
        if (rule.severity === this.SEVERITIES.CRITICAL) {
          return 'مراجعة إدارية عاجلة لنمط ' + label + ' خلال الفترة، مع مقارنة بالفترات السابقة ومراجعة السياق التشغيلي.';
        }
        return null;
      case this.RULE_STATES.INSUFFICIENT_SAMPLE:
        return 'متابعة العينة في الفترات القادمة قبل تصنيف الحد.';
      default:
        return null;
    }
  },

  _combinedTexts: function(patternId, elevatedCount) {
    if (patternId === 'ATTENDANCE_BEHAVIOR_PATTERN') {
      return {
        explanation: 'نشاط الإلغاءات وعدم الحضور مرتفع معًا خلال الفترة — نمط سلوك تشغيلي يستحق المراجعة الإدارية (بدون استنتاج سببي).',
        recommendation: 'مراجعة نمط الالتزام بالمواعيد خلال الفترة، ومقارنته بالفترات السابقة، ومراجعة السياق التشغيلي.'
      };
    }
    if (patternId === 'RESCHEDULING_PATTERN') {
      return {
        explanation: 'نشاط الإلغاءات وتغييرات المواعيد مرتفع معًا خلال الفترة — نمط إعادة جدولة يستحق المراجعة الإدارية (بدون استنتاج سببي).',
        recommendation: 'مراجعة نمط إعادة جدولة المواعيد خلال الفترة ومقارنته بالفترات السابقة.'
      };
    }
    // MULTI_METRIC_ELEVATION
    return {
      explanation: elevatedCount + ' معدلات تشغيلية مرتفعة معًا خلال الفترة — يستحق المراجعة الإدارية الشاملة (بدون استنتاج سببي).',
      recommendation: 'مراجعة شاملة للنمط التشغيلي خلال الفترة ومقارنته بالفترات السابقة.'
    };
  },

  // ── Small helpers ──────────────────────────────────────────────

  _isNonNegativeInt: function(v) {
    return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0;
  },

  _isDirection: function(v) {
    return v === this.DIRECTIONS.ABOVE || v === this.DIRECTIONS.BELOW;
  }
};
