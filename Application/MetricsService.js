/**
 * MetricsService — M1-A & M1-C (PHASE 1.2 & 1.4 — METRICS FOUNDATION & CAPACITY INTELLIGENCE)
 *
 * ONE metric definition → ONE calculation path → MANY consumers.
 * Daily/Weekly/Monthly reports and Doctor/Diagnostic consumers must
 * consume this foundation; they must never grow their own calculations.
 *
 * ─── FROZEN M1-A CONTRACT (preserved verbatim) ───
 *
 *  CONFIRMED_APPOINTMENTS
 *    source:        Availability (business slot source of truth)
 *    condition:     status === CONFIRMED
 *    aggregation:   COUNT (rows time-positioned by sort_key)
 *    semantics:     SNAPSHOT_CURRENT_STATE — Availability status is
 *                   mutable (CONFIRMED → COMPLETED / NO_SHOW / FREE),
 *                   so a closed period's historical confirmed count is
 *                   NOT provable from current state. Closed periods
 *                   (period.endMs <= asOfMs) return DEFERRED /
 *                   HISTORICAL_NOT_PROVABLE. No reconstruction, no
 *                   inference, no invention.
 *
 *  OFFICIAL_CANCELLATIONS
 *    source:        B6_LIFECYCLE (official Change/Cancel operations)
 *    condition:     lifecycle_state === RESOLVED_CANCEL AND
 *                   checkpoint === TERMINAL_CANCEL_PROVEN
 *    aggregation:   COUNT DISTINCT operation_id (checkpoint / recovery /
 *                   release rows never multiply one business operation)
 *    semantics:     HISTORICAL_EVIDENCE (append-only journal) — counted
 *                   by the terminal proof row's timestamp.
 *
 *  OFFICIAL_CHANGES
 *    source:        B6_LIFECYCLE
 *    condition:     lifecycle_state === RESOLVED_CHANGE AND
 *                   checkpoint === TERMINAL_CHANGE_PROVEN
 *    aggregation:   COUNT DISTINCT operation_id
 *    semantics:     HISTORICAL_EVIDENCE — same as cancellations.
 *
 *  COMPLETED_APPOINTMENTS
 *    source:        ATTENDANCE_AUDIT (read through AttendanceAuditReadRepository)
 *    condition:     outcome === APPLIED AND to_status === COMPLETED AND
 *                   timestamp >= ATTENDANCE_ACTIVATION_AT
 *    aggregation:   COUNT DISTINCT slot_id (ALREADY_APPLIED is not new
 *                   attendance and is never counted)
 *    semantics:     HISTORICAL_EVIDENCE — counted by the DECISION
 *                   timestamp, not by appointment start time.
 *
 *  NO_SHOW_APPOINTMENTS
 *    source:        ATTENDANCE_AUDIT
 *    condition:     outcome === APPLIED AND to_status === NO_SHOW AND
 *                   timestamp >= ATTENDANCE_ACTIVATION_AT
 *    aggregation:   COUNT DISTINCT slot_id
 *    semantics:     HISTORICAL_EVIDENCE.
 *
 *  BOOKABLE_SLOTS
 *    source:        Availability
 *    condition:     status === FREE AND isAvailable === true AND
 *                   slotStartMs >= asOfMs + MIN_BOOKING_LEAD_MINUTES
 *                   (the exact eligibility documented by
 *                   SlotSelection.findEarliestBookable)
 *    aggregation:   COUNT
 *    semantics:     SNAPSHOT_CURRENT_STATE — historical bookable counts
 *                   are not reconstructable; closed periods are DEFERRED.
 *
 * ─── FROZEN M1-C CONTRACT (CAPACITY & WORKING-SCHEDULE INTELLIGENCE) ───
 *
 *  CONFIGURED_WORKING_DAYS
 *    source:        Settings (read via SettingsRepository.getSettingsResult)
 *    condition:     SlotGenerator.isWorkingDay(date, settings) === true
 *                   (sunday..saturday flags)
 *    aggregation:   COUNT working days in period
 *    semantics:     SNAPSHOT_CURRENT_STATE — Historical schedule is not
 *                   provable without version history. Closed periods
 *                   (period.endMs <= asOfMs) and mixed periods containing
 *                   historical days (period.startMs < todayStartMs) return
 *                   DEFERRED (never retroactively applying current settings).
 *
 *  CONFIGURED_CAPACITY
 *    source:        Settings (SettingsRepository)
 *    condition:     For each working day in period:
 *                   floor((work_end - work_start) / slotDurationMinutes)
 *                   Closed days yield 0 (VALID ZERO).
 *    aggregation:   SUM daily configured capacity across period
 *    semantics:     SNAPSHOT_CURRENT_STATE — Closed and mixed historical
 *                   periods return DEFERRED.
 *    provenance:    Carries slotDurationSource ('CONFIGURED' vs
 *                   'DEFAULT_FALLBACK') directly from SettingsRepository.
 *                   30 configured ≠ 30 fallback.
 *
 *  OBSERVED_WORKING_DAYS
 *    source:        Availability (SlotRepository.queryResult)
 *    condition:     Distinct calendar dates having >= 1 generated slot
 *    aggregation:   COUNT DISTINCT date
 *    semantics:     SNAPSHOT_CURRENT_STATE (observation of generated reality).
 *                   Absence of rows does NOT prove closure.
 *                   Closed periods return DEFERRED.
 *
 *  OBSERVED_GENERATED_CAPACITY
 *    source:        Availability (SlotRepository.queryResult)
 *    condition:     All generated slot rows within the period
 *    aggregation:   COUNT
 *    semantics:     SNAPSHOT_CURRENT_STATE (observation of generated reality).
 *                   Closed periods return DEFERRED.
 *
 *  GENERATION_COMPLETENESS
 *    sources:       Availability + Settings
 *    formula:       (Observed Generated Capacity / Configured Capacity) * 100
 *    purpose:       INTERNAL / DIAGNOSTIC
 *    zero denom:    Configured Capacity 0 → UNAVAILABLE (ZERO_DENOMINATOR)
 *    semantics:     SNAPSHOT_CURRENT_STATE — Closed and mixed historical
 *                   periods return DEFERRED.
 *
 *  BOOKING_UTILIZATION
 *    sources:       Availability + Settings
 *    formula:       (Confirmed Appointments / Configured Capacity) * 100
 *    purpose:       DOCTOR-FACING KPI
 *    denominator:   Configured Capacity (planned capacity, not generated)
 *    zero denom:    Configured Capacity 0 → UNAVAILABLE (ZERO_DENOMINATOR)
 *    semantics:     SNAPSHOT_CURRENT_STATE — Closed and mixed historical
 *                   periods return DEFERRED.
 *
 * ─── THREE-WAY DISTINCTION (GOVERNING INVARIANT) ───
 *    Configured Capacity ≠ Observed Generated Capacity ≠ Bookable Eligibility
 *
 * ─── AUDIENCE SEPARATION (BUSINESS UX vs OPERATIONAL DIAGNOSTICS) ───
 *    Doctor-Facing:       Configured Capacity, Confirmed, Booking Utilization
 *    Internal Diagnostic: Observed Generated Capacity, Generation Completeness,
 *                         Bookable Now, Working Days, Fallback provenance
 *
 * ─── RESULT CONTRACT ───
 *  Result.fail codes:
 *    METRIC_REQUEST_INVALID    — invalid names array
 *    METRIC_UNKNOWN            — metric name not in registry
 *    METRIC_PERIOD_INVALID     — malformed/non-finite/inverted period
 *    METRIC_SOURCE_UNAVAILABLE — source read failure (NEVER a zero envelope)
 *    METRIC_EVIDENCE_INVALID   — data-contract violation in evidence
 *
 *  status:
 *    AVAILABLE   — proven number (0 is a VALID ZERO)
 *    UNAVAILABLE — value null (e.g. ZERO_DENOMINATOR)
 *    DEFERRED    — value null (HISTORICAL_NOT_PROVABLE for closed/mixed periods)
 *
 * Evaluation-order note: clasp evaluates project files alphabetically,
 * so this file loads BEFORE Config.js, Repositories, and SettingsRepository.
 * Every cross-module reference is resolved at CALL time.
 */
const MetricsService = {

  METRICS: {
    // M1-A Metrics
    CONFIRMED_APPOINTMENTS: 'CONFIRMED_APPOINTMENTS',
    OFFICIAL_CANCELLATIONS: 'OFFICIAL_CANCELLATIONS',
    OFFICIAL_CHANGES: 'OFFICIAL_CHANGES',
    COMPLETED_APPOINTMENTS: 'COMPLETED_APPOINTMENTS',
    NO_SHOW_APPOINTMENTS: 'NO_SHOW_APPOINTMENTS',
    BOOKABLE_SLOTS: 'BOOKABLE_SLOTS',
    // M1-C Capacity & Working-Schedule Metrics
    CONFIGURED_WORKING_DAYS: 'CONFIGURED_WORKING_DAYS',
    CONFIGURED_CAPACITY: 'CONFIGURED_CAPACITY',
    OBSERVED_WORKING_DAYS: 'OBSERVED_WORKING_DAYS',
    OBSERVED_GENERATED_CAPACITY: 'OBSERVED_GENERATED_CAPACITY',
    GENERATION_COMPLETENESS: 'GENERATION_COMPLETENESS',
    BOOKING_UTILIZATION: 'BOOKING_UTILIZATION'
  },

  STATUS: {
    AVAILABLE: 'AVAILABLE',
    UNAVAILABLE: 'UNAVAILABLE',
    DEFERRED: 'DEFERRED'
  },

  REASONS: {
    HISTORICAL_NOT_PROVABLE: 'HISTORICAL_NOT_PROVABLE',
    ZERO_DENOMINATOR: 'ZERO_DENOMINATOR'
  },

  SOURCES: {
    AVAILABILITY: 'Availability',
    B6_LIFECYCLE: 'B6_LIFECYCLE',
    ATTENDANCE_AUDIT: 'ATTENDANCE_AUDIT',
    SETTINGS: 'Settings'
  },

  SEMANTICS: {
    SNAPSHOT_CURRENT_STATE: 'SNAPSHOT_CURRENT_STATE',
    HISTORICAL_EVIDENCE: 'HISTORICAL_EVIDENCE'
  },

  SLOT_DURATION_SOURCES: {
    CONFIGURED: 'CONFIGURED',
    DEFAULT_FALLBACK: 'DEFAULT_FALLBACK'
  },

  AUDIENCE: {
    DOCTOR_FACING: 'DOCTOR_FACING',
    INTERNAL_DIAGNOSTIC: 'INTERNAL_DIAGNOSTIC'
  },

  DOCTOR_FACING_METRICS: [
    'CONFIGURED_CAPACITY',
    'CONFIRMED_APPOINTMENTS',
    'BOOKING_UTILIZATION'
  ],

  INTERNAL_DIAGNOSTIC_METRICS: [
    'CONFIGURED_WORKING_DAYS',
    'OBSERVED_WORKING_DAYS',
    'OBSERVED_GENERATED_CAPACITY',
    'GENERATION_COMPLETENESS',
    'BOOKABLE_SLOTS'
  ],

  /** One uniform period interpretation for every metric. */
  PERIOD_SEMANTICS: 'start inclusive, end exclusive (canonical epoch ms)',

  /**
   * M0 attendance audit outcome vocabulary (frozen evidence contract).
   * ALREADY_APPLIED is NOT new attendance and never counts.
   */
  AUDIT_OUTCOMES: {
    APPLIED: 'APPLIED'
  },

  // ═══════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════

  /**
   * Calculates exactly one metric for one deterministic period.
   *
   * @param {string} metricName - one of MetricsService.METRICS
   * @param {{start: Date|number, end: Date|number}} period
   * @returns {Result} ok(metric envelope) |
   *                   fail(METRIC_UNKNOWN | METRIC_PERIOD_INVALID |
   *                        METRIC_SOURCE_UNAVAILABLE | METRIC_EVIDENCE_INVALID)
   */
  calculate: function(metricName, period) {
    var defResult = this._definition(metricName);
    if (!defResult.ok) return defResult;
    var def = defResult.data;

    var periodResult = this._canonicalPeriod(period);
    if (!periodResult.ok) return periodResult;
    var per = periodResult.data;

    var now = Clock.now();
    var nowMs = now.getTime();
    var todayStartMs = this._todayStartMs(nowMs);

    // Snapshot metrics over closed periods, and configured metrics over
    // mixed periods containing historical days (startMs < todayStartMs),
    // are not provable. Defer BEFORE reading any source.
    if ((def.deferPast && per.endMs <= nowMs) || (def.deferMixed && per.startMs < todayStartMs)) {
      return Result.ok(this._deferredEnvelope(metricName, def, per, now, nowMs));
    }

    if (def.isComposite) {
      var sourcesData = {};
      for (var s = 0; s < def.requiredSources.length; s++) {
        var srcName = def.requiredSources[s];
        var srcRead = this._readSource(srcName);
        if (!srcRead.ok) {
          return Result.fail(
            'METRIC_SOURCE_UNAVAILABLE',
            'Metric source could not be read for ' + metricName,
            { metric: metricName, source: srcName, error: srcRead.error }
          );
        }
        sourcesData[srcName] = srcRead.data;
      }
      return def.compute(sourcesData, per, nowMs, now);
    }

    var read = def.read();
    if (!read.ok) {
      return Result.fail(
        'METRIC_SOURCE_UNAVAILABLE',
        'Metric source could not be read for ' + metricName,
        { metric: metricName, source: def.source, error: read.error }
      );
    }

    // Computations return Result so a data-contract violation can
    // withhold the metric instead of silently producing a number.
    return def.compute(read.data, per, nowMs, now);
  },

  /**
   * Calculates many metrics for one period with ONE shared read per
   * source (no N × sheet reads). All-or-nothing: if any required source
   * fails, the whole call fails.
   *
   * @param {string[]} metricNames
   * @param {{start: Date|number, end: Date|number}} period
   * @returns {Result} ok({ period, evaluatedAt, results: {name: envelope} }) |
   *                   fail(METRIC_REQUEST_INVALID | METRIC_UNKNOWN |
   *                        METRIC_PERIOD_INVALID | METRIC_SOURCE_UNAVAILABLE)
   */
  calculateMany: function(metricNames, period) {
    if (!Array.isArray(metricNames) || metricNames.length === 0) {
      return Result.fail(
        'METRIC_REQUEST_INVALID',
        'calculateMany requires a non-empty array of metric names',
        { metricNames: metricNames }
      );
    }

    var defs = {};
    for (var i = 0; i < metricNames.length; i++) {
      var defResult = this._definition(metricNames[i]);
      if (!defResult.ok) return defResult;
      defs[metricNames[i]] = defResult.data;
    }

    var periodResult = this._canonicalPeriod(period);
    if (!periodResult.ok) return periodResult;
    var per = periodResult.data;

    var now = Clock.now();
    var nowMs = now.getTime();
    var todayStartMs = this._todayStartMs(nowMs);

    // Collect all distinct sources required by active (non-deferred) metrics
    // and map each source to the first metric requiring it (for precise error reporting)
    var requiredSources = {};
    var sourceFirstMetric = {};
    var names = Object.keys(defs);
    for (var k = 0; k < names.length; k++) {
      var mName = names[k];
      var mDef = defs[mName];
      if ((mDef.deferPast && per.endMs <= nowMs) || (mDef.deferMixed && per.startMs < todayStartMs)) {
        continue;
      }
      if (mDef.isComposite) {
        for (var cs = 0; cs < mDef.requiredSources.length; cs++) {
          var cSrc = mDef.requiredSources[cs];
          requiredSources[cSrc] = true;
          if (!sourceFirstMetric.hasOwnProperty(cSrc)) sourceFirstMetric[cSrc] = mName;
        }
      } else if (mDef.source) {
        requiredSources[mDef.source] = true;
        if (!sourceFirstMetric.hasOwnProperty(mDef.source)) sourceFirstMetric[mDef.source] = mName;
      }
    }

    // Read each required source exactly ONCE
    var rowsBySource = {};
    var sourceNames = Object.keys(requiredSources);
    for (var s = 0; s < sourceNames.length; s++) {
      var src = sourceNames[s];
      var readResult = this._readSource(src);
      if (!readResult.ok) {
        var failedMetricName = sourceFirstMetric[src] || names[0];
        return Result.fail(
          'METRIC_SOURCE_UNAVAILABLE',
          'Metric source could not be read for ' + failedMetricName,
          { metric: failedMetricName, source: src, error: readResult.error }
        );
      }
      rowsBySource[src] = readResult.data;
    }

    var results = {};
    for (var j = 0; j < names.length; j++) {
      var name = names[j];
      var def = defs[name];

      if ((def.deferPast && per.endMs <= nowMs) || (def.deferMixed && per.startMs < todayStartMs)) {
        results[name] = this._deferredEnvelope(name, def, per, now, nowMs);
        continue;
      }

      var computed;
      if (def.isComposite) {
        var compositeData = {};
        for (var r = 0; r < def.requiredSources.length; r++) {
          compositeData[def.requiredSources[r]] = rowsBySource[def.requiredSources[r]];
        }
        computed = def.compute(compositeData, per, nowMs, now);
      } else {
        computed = def.compute(rowsBySource[def.source], per, nowMs, now);
      }

      if (!computed.ok) return computed;
      results[name] = computed.data;
    }

    return Result.ok({
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: now,
      results: results
    });
  },

  /**
   * Deterministic ratio combinator over two already-registered metrics:
   * value = numerator.value / denominator.value.
   *
   * Zero-denominator policy: denominator 0 → N/A
   * (status UNAVAILABLE, reason ZERO_DENOMINATOR, value null) — NEVER 0%.
   *
   * @param {string} numeratorMetric
   * @param {string} denominatorMetric
   * @param {{start: Date|number, end: Date|number}} period
   * @returns {Result}
   */
  calculateRatio: function(numeratorMetric, denominatorMetric, period) {
    var numerator = this.calculate(numeratorMetric, period);
    if (!numerator.ok) return numerator;
    var denominator = this.calculate(denominatorMetric, period);
    if (!denominator.ok) return denominator;

    var n = numerator.data;
    var d = denominator.data;
    var now = Clock.now();

    var base = {
      metric: numeratorMetric + ' / ' + denominatorMetric,
      period: { startMs: n.period.startMs, endMs: n.period.endMs },
      evaluatedAt: now,
      provenance: {
        numerator: { metric: numeratorMetric, status: n.status, value: n.value },
        denominator: { metric: denominatorMetric, status: d.status, value: d.value },
        formula: 'numerator.value / denominator.value',
        zeroDenominatorPolicy: 'denominator 0 → N/A (null), never 0'
      }
    };

    if (n.status === MetricsService.STATUS.DEFERRED || d.status === MetricsService.STATUS.DEFERRED) {
      var deferredSide = n.status === MetricsService.STATUS.DEFERRED ? n : d;
      return Result.ok(Object.assign({}, base, {
        status: MetricsService.STATUS.DEFERRED,
        value: null,
        reason: deferredSide.reason
      }));
    }
    if (n.status === MetricsService.STATUS.UNAVAILABLE || d.status === MetricsService.STATUS.UNAVAILABLE) {
      var unavailableSide = n.status === MetricsService.STATUS.UNAVAILABLE ? n : d;
      return Result.ok(Object.assign({}, base, {
        status: MetricsService.STATUS.UNAVAILABLE,
        value: null,
        reason: unavailableSide.reason
      }));
    }

    if (d.value === 0) {
      return Result.ok(Object.assign({}, base, {
        status: MetricsService.STATUS.UNAVAILABLE,
        value: null,
        reason: MetricsService.REASONS.ZERO_DENOMINATOR
      }));
    }

    return Result.ok(Object.assign({}, base, {
      status: MetricsService.STATUS.AVAILABLE,
      value: n.value / d.value,
      reason: null
    }));
  },

  /**
   * Doctor-Facing Presentation Summary (M1-C §18, §34).
   * Extracts ONLY the 3 commercial metrics without diagnostic noise:
   *   - Configured Capacity
   *   - Confirmed Appointments
   *   - Booking Utilization
   *
   * @param {{start: Date|number, end: Date|number}} period
   * @returns {Result}
   */
  getDoctorSummary: function(period) {
    var batch = this.calculateMany(this.DOCTOR_FACING_METRICS.slice(), period);
    if (!batch.ok) return batch;

    var res = batch.data.results;
    return Result.ok({
      period: batch.data.period,
      evaluatedAt: batch.data.evaluatedAt,
      audience: MetricsService.AUDIENCE.DOCTOR_FACING,
      configuredCapacity: res[MetricsService.METRICS.CONFIGURED_CAPACITY],
      confirmedAppointments: res[MetricsService.METRICS.CONFIRMED_APPOINTMENTS],
      bookingUtilization: res[MetricsService.METRICS.BOOKING_UTILIZATION]
    });
  },

  /**
   * Internal Operational Diagnostic Summary (M1-C §19, §34).
   * Full diagnostic view for supervisors and system inspection:
   *   - Configured vs Observed Generated Capacity
   *   - Generation Completeness
   *   - Bookable Slots
   *   - Working Days breakdown (Configured vs Observed)
   *   - Booking Utilization
   *   - Slot duration provenance
   *
   * @param {{start: Date|number, end: Date|number}} period
   * @returns {Result}
   */
  getDiagnosticSummary: function(period) {
    var allMetrics = [
      this.METRICS.CONFIGURED_CAPACITY,
      this.METRICS.OBSERVED_GENERATED_CAPACITY,
      this.METRICS.GENERATION_COMPLETENESS,
      this.METRICS.BOOKABLE_SLOTS,
      this.METRICS.CONFIRMED_APPOINTMENTS,
      this.METRICS.BOOKING_UTILIZATION,
      this.METRICS.CONFIGURED_WORKING_DAYS,
      this.METRICS.OBSERVED_WORKING_DAYS
    ];

    var batch = this.calculateMany(allMetrics, period);
    if (!batch.ok) return batch;

    var res = batch.data.results;
    var cc = res[this.METRICS.CONFIGURED_CAPACITY];
    var durationSource = cc && cc.provenance ? cc.provenance.slotDurationSource : null;
    var durationMin = cc && cc.provenance ? cc.provenance.slotDurationMinutes : null;

    return Result.ok({
      period: batch.data.period,
      evaluatedAt: batch.data.evaluatedAt,
      audience: MetricsService.AUDIENCE.INTERNAL_DIAGNOSTIC,
      slotDurationInfo: {
        minutes: durationMin,
        source: durationSource
      },
      metrics: res
    });
  },

  // ═══════════════════════════════════════════════════════════
  // Metric definitions (registry)
  // ═══════════════════════════════════════════════════════════

  /**
   * @param {string} metricName
   * @returns {Result} ok({metric, source, semantics, deferPast, deferMixed, read, compute})
   */
  _definition: function(metricName) {
    var self = this;
    var M = MetricsService.METRICS;

    // ── M1-A Metrics ──

    if (metricName === M.CONFIRMED_APPOINTMENTS) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.AVAILABILITY,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
        deferMixed: false,
        read: function() {
          return SlotRepository.queryResult(function() { return true; });
        },
        compute: function(rows, per, nowMs, now) {
          return self._computeConfirmed(rows, per, nowMs, now);
        }
      });
    }

    if (metricName === M.BOOKABLE_SLOTS) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.AVAILABILITY,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
        deferMixed: false,
        read: function() {
          return SlotRepository.queryResult(function() { return true; });
        },
        compute: function(rows, per, nowMs, now) {
          return self._computeBookable(rows, per, nowMs, now);
        }
      });
    }

    if (metricName === M.OFFICIAL_CANCELLATIONS) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.B6_LIFECYCLE,
        semantics: MetricsService.SEMANTICS.HISTORICAL_EVIDENCE,
        deferPast: false,
        deferMixed: false,
        read: function() {
          return B6LifecycleRepository.queryResult(function() { return true; });
        },
        compute: function(rows, per, nowMs, now) {
          return self._computeLifecycleTerminal(
            rows, per, now,
            metricName,
            B6LifecycleService.LIFECYCLE_STATES.RESOLVED_CANCEL,
            B6LifecycleService.CHECKPOINTS.TERMINAL_CANCEL_PROVEN
          );
        }
      });
    }

    if (metricName === M.OFFICIAL_CHANGES) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.B6_LIFECYCLE,
        semantics: MetricsService.SEMANTICS.HISTORICAL_EVIDENCE,
        deferPast: false,
        deferMixed: false,
        read: function() {
          return B6LifecycleRepository.queryResult(function() { return true; });
        },
        compute: function(rows, per, nowMs, now) {
          return self._computeLifecycleTerminal(
            rows, per, now,
            metricName,
            B6LifecycleService.LIFECYCLE_STATES.RESOLVED_CHANGE,
            B6LifecycleService.CHECKPOINTS.TERMINAL_CHANGE_PROVEN
          );
        }
      });
    }

    if (metricName === M.COMPLETED_APPOINTMENTS || metricName === M.NO_SHOW_APPOINTMENTS) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.ATTENDANCE_AUDIT,
        semantics: MetricsService.SEMANTICS.HISTORICAL_EVIDENCE,
        deferPast: false,
        deferMixed: false,
        read: function() {
          return AttendanceAuditReadRepository.readAll();
        },
        compute: function(rows, per, nowMs, now) {
          var status = metricName === M.COMPLETED_APPOINTMENTS
            ? Config.VOCABULARY.STATUS.COMPLETED
            : Config.VOCABULARY.STATUS.NO_SHOW;
          return self._computeAttendance(rows, per, now, metricName, status);
        }
      });
    }

    // ── M1-C Capacity & Working-Schedule Metrics ──

    if (metricName === M.CONFIGURED_WORKING_DAYS) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.SETTINGS,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
        deferMixed: true,
        read: function() {
          return SettingsRepository.getSettingsResult();
        },
        compute: function(settings, per, nowMs, now) {
          return self._computeConfiguredWorkingDays(settings, per, nowMs, now);
        }
      });
    }

    if (metricName === M.CONFIGURED_CAPACITY) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.SETTINGS,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
        deferMixed: true,
        read: function() {
          return SettingsRepository.getSettingsResult();
        },
        compute: function(settings, per, nowMs, now) {
          return self._computeConfiguredCapacity(settings, per, nowMs, now);
        }
      });
    }

    if (metricName === M.OBSERVED_WORKING_DAYS) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.AVAILABILITY,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
        deferMixed: false,
        read: function() {
          return SlotRepository.queryResult(function() { return true; });
        },
        compute: function(rows, per, nowMs, now) {
          return self._computeObservedWorkingDays(rows, per, nowMs, now);
        }
      });
    }

    if (metricName === M.OBSERVED_GENERATED_CAPACITY) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.AVAILABILITY,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
        deferMixed: false,
        read: function() {
          return SlotRepository.queryResult(function() { return true; });
        },
        compute: function(rows, per, nowMs, now) {
          return self._computeObservedGeneratedCapacity(rows, per, nowMs, now);
        }
      });
    }

    if (metricName === M.GENERATION_COMPLETENESS) {
      return Result.ok({
        metric: metricName,
        isComposite: true,
        requiredSources: [MetricsService.SOURCES.AVAILABILITY, MetricsService.SOURCES.SETTINGS],
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
        deferMixed: true,
        compute: function(sourcesData, per, nowMs, now) {
          return self._computeGenerationCompleteness(
            sourcesData[MetricsService.SOURCES.AVAILABILITY],
            sourcesData[MetricsService.SOURCES.SETTINGS],
            per, nowMs, now
          );
        }
      });
    }

    if (metricName === M.BOOKING_UTILIZATION) {
      return Result.ok({
        metric: metricName,
        isComposite: true,
        requiredSources: [MetricsService.SOURCES.AVAILABILITY, MetricsService.SOURCES.SETTINGS],
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
        deferMixed: true,
        compute: function(sourcesData, per, nowMs, now) {
          return self._computeBookingUtilization(
            sourcesData[MetricsService.SOURCES.AVAILABILITY],
            sourcesData[MetricsService.SOURCES.SETTINGS],
            per, nowMs, now
          );
        }
      });
    }

    return Result.fail(
      'METRIC_UNKNOWN',
      'Unknown metric: ' + metricName,
      { requested: metricName, available: Object.keys(MetricsService.METRICS) }
    );
  },

  /** Helper to read any registered source by name. */
  _readSource: function(sourceName) {
    if (sourceName === MetricsService.SOURCES.AVAILABILITY) {
      return SlotRepository.queryResult(function() { return true; });
    }
    if (sourceName === MetricsService.SOURCES.SETTINGS) {
      return SettingsRepository.getSettingsResult();
    }
    if (sourceName === MetricsService.SOURCES.B6_LIFECYCLE) {
      return B6LifecycleRepository.queryResult(function() { return true; });
    }
    if (sourceName === MetricsService.SOURCES.ATTENDANCE_AUDIT) {
      return AttendanceAuditReadRepository.readAll();
    }
    return Result.fail('UNKNOWN_SOURCE', 'Unknown metric source: ' + sourceName);
  },

  // ═══════════════════════════════════════════════════════════
  // Computations
  // ═══════════════════════════════════════════════════════════

  /**
   * CONFIRMED_APPOINTMENTS — current-state snapshot over Availability.
   */
  _computeConfirmed: function(rows, per, nowMs, now) {
    var statusConfirmed = Config.VOCABULARY.STATUS.CONFIRMED;
    var count = 0;
    var unattributable = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.status !== statusConfirmed) continue;

      var slotStartMs = this._slotStartMs(row);
      if (slotStartMs === null) {
        unattributable += 1;
        continue;
      }
      if (slotStartMs >= per.startMs && slotStartMs < per.endMs) count += 1;
    }

    return Result.ok(this._availableEnvelope(
      MetricsService.METRICS.CONFIRMED_APPOINTMENTS,
      count,
      per,
      now,
      nowMs,
      {
        source: MetricsService.SOURCES.AVAILABILITY,
        fields: ['status', 'sort_key'],
        condition: "status === '" + statusConfirmed + "'",
        periodFilter: 'slotStartMs >= period.startMs AND slotStartMs < period.endMs (slotStartMs = LegacySlotTimeParser.toComparableTime(sort_key))',
        aggregation: 'COUNT',
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        audience: MetricsService.AUDIENCE.DOCTOR_FACING,
        asOfMs: nowMs,
        snapshotMeaning: 'slots currently CONFIRMED (as of asOfMs) whose start time falls inside the period',
        unattributableRows: unattributable
      }
    ));
  },

  /**
   * BOOKABLE_SLOTS — current/future bookable eligibility, mirroring
   * SlotSelection.findEarliestBookable exactly (status FREE +
   * is_available true + start >= now + MIN_BOOKING_LEAD_MINUTES).
   * Generated slots ≠ bookable slots.
   */
  _computeBookable: function(rows, per, nowMs, now) {
    var statusFree = Config.VOCABULARY.STATUS.FREE;
    var leadMinutes = Config.SYSTEM_POLICY.MIN_BOOKING_LEAD_MINUTES;
    var cutoffMs = nowMs + leadMinutes * 60000;
    var count = 0;
    var unattributable = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.status !== statusFree) continue;
      if (!this._isAvailableFlag(row.is_available)) continue;

      var slotStartMs = this._slotStartMs(row);
      if (slotStartMs === null) {
        unattributable += 1;
        continue;
      }
      if (slotStartMs < cutoffMs) continue;
      if (slotStartMs >= per.startMs && slotStartMs < per.endMs) count += 1;
    }

    return Result.ok(this._availableEnvelope(
      MetricsService.METRICS.BOOKABLE_SLOTS,
      count,
      per,
      now,
      nowMs,
      {
        source: MetricsService.SOURCES.AVAILABILITY,
        fields: ['status', 'is_available', 'sort_key'],
        condition: "status === 'FREE' AND is_available === true AND slotStartMs >= asOfMs + MIN_BOOKING_LEAD_MINUTES",
        periodFilter: 'slotStartMs >= period.startMs AND slotStartMs < period.endMs',
        aggregation: 'COUNT',
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        asOfMs: nowMs,
        leadMinutes: leadMinutes,
        eligibilityReference: 'SlotSelection.findEarliestBookable',
        eligibilityCutoffMs: cutoffMs,
        eligibilityMeaning: 'slots currently FREE and is_available whose start time is >= asOfMs + MIN_BOOKING_LEAD_MINUTES and falls inside the period (exact SlotSelection.findEarliestBookable contract)',
        unattributableRows: unattributable
      }
    ));
  },

  /**
   * OFFICIAL_CANCELLATIONS / OFFICIAL_CHANGES — terminal lifecycle journal rows.
   */
  _computeLifecycleTerminal: function(rows, per, now, metricName, targetState, targetCheckpoint) {
    var seenOperationIds = {};
    var count = 0;
    var unattributable = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.lifecycle_state !== targetState) continue;
      if (row.checkpoint !== targetCheckpoint) continue;

      if (!this._hasIdentity(row.operation_id)) {
        unattributable += 1;
        continue;
      }

      var rowTimeMs = this._rowMs(row.timestamp);
      if (rowTimeMs === null) {
        unattributable += 1;
        continue;
      }

      if (rowTimeMs >= per.startMs && rowTimeMs < per.endMs) {
        var opId = row.operation_id;
        if (!seenOperationIds.hasOwnProperty(opId)) {
          seenOperationIds[opId] = true;
          count += 1;
        }
      }
    }

    return Result.ok(this._availableEnvelope(
      metricName,
      count,
      per,
      now,
      null,
      {
        source: MetricsService.SOURCES.B6_LIFECYCLE,
        fields: ['lifecycle_state', 'checkpoint', 'operation_id', 'timestamp'],
        condition: "lifecycle_state === '" + targetState + "' AND checkpoint === '" + targetCheckpoint + "'",
        periodFilter: 'rowTimestampMs >= period.startMs AND rowTimestampMs < period.endMs',
        aggregation: 'COUNT DISTINCT operation_id',
        semantics: MetricsService.SEMANTICS.HISTORICAL_EVIDENCE,
        journalDiscipline: 'checkpoint / retry / recovery / release rows never multiply one business operation',
        identityPolicy: 'terminal rows without a valid non-empty operation_id are unattributable and never counted as operations',
        unattributableRows: unattributable
      }
    ));
  },

  /**
   * COMPLETED_APPOINTMENTS / NO_SHOW_APPOINTMENTS — official attendance.
   */
  _computeAttendance: function(rows, per, now, metricName, targetStatus) {
    var applied = MetricsService.AUDIT_OUTCOMES.APPLIED;

    var firstApplied = null;
    var firstAppliedOrder = null;
    for (var a = 0; a < rows.length; a++) {
      if (rows[a].outcome !== applied) continue;
      var order = this._rowOrder(rows[a], a);
      if (firstApplied === null || order < firstAppliedOrder) {
        firstApplied = rows[a];
        firstAppliedOrder = order;
      }
    }

    var activationMs = null;
    if (firstApplied !== null) {
      activationMs = this._rowMs(firstApplied.timestamp);
      if (activationMs === null) {
        return Result.fail(
          'METRIC_EVIDENCE_INVALID',
          'ATTENDANCE_ACTIVATION_AT cannot be established: the first APPLIED attendance audit row has an unparseable timestamp — attendance metrics are withheld instead of redefining the boundary to a later row',
          {
            metric: metricName,
            source: MetricsService.SOURCES.ATTENDANCE_AUDIT,
            rowNumber: typeof firstApplied._rowNumber === 'number' ? firstApplied._rowNumber : null,
            timestampValue: String(firstApplied.timestamp)
          }
        );
      }
    }

    var count = 0;
    var unattributable = 0;
    var seenSlotIds = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.outcome !== applied) continue;
      if (row.to_status !== targetStatus) continue;

      if (!this._hasIdentity(row.slot_id)) {
        unattributable += 1;
        continue;
      }

      var decisionMs = this._rowMs(row.timestamp);
      if (decisionMs === null) {
        unattributable += 1;
        continue;
      }
      if (activationMs !== null && decisionMs < activationMs) continue;

      if (decisionMs >= per.startMs && decisionMs < per.endMs) {
        var slotId = row.slot_id;
        if (!seenSlotIds.hasOwnProperty(slotId)) {
          seenSlotIds[slotId] = true;
          count += 1;
        }
      }
    }

    return Result.ok(this._availableEnvelope(
      metricName,
      count,
      per,
      now,
      null,
      {
        source: MetricsService.SOURCES.ATTENDANCE_AUDIT,
        fields: ['outcome', 'to_status', 'timestamp', 'slot_id'],
        condition: "outcome === 'APPLIED' AND to_status === '" + targetStatus + "' AND timestampMs >= ATTENDANCE_ACTIVATION_AT",
        periodFilter: 'decisionMs >= period.startMs AND decisionMs < period.endMs',
        aggregation: 'COUNT DISTINCT slot_id',
        semantics: MetricsService.SEMANTICS.HISTORICAL_EVIDENCE,
        attendanceActivationAtMs: activationMs,
        activationDerivation: "ATTENDANCE_ACTIVATION_AT = timestamp of the FIRST APPLIED attendance audit row in append order (M0 derived boundary; no sheet column, no Script Property). If that row's timestamp is unparseable the metric FAILS (METRIC_EVIDENCE_INVALID) — the boundary is never redefined to the next parsable row. null = no attendance decision has ever been applied, in which case a readable store provably yields a valid zero.",
        decisionTimestampBasis: 'attendance is counted by DECISION timestamp, not by appointment start time',
        alreadyAppliedPolicy: 'ALREADY_APPLIED is not new attendance and is never counted',
        identityPolicy: 'APPLIED rows without a valid non-empty slot_id are unattributable and never counted as appointments',
        unattributableRows: unattributable
      }
    ));
  },

  /**
   * CONFIGURED_WORKING_DAYS (M1-C)
   * Counts days in period considered working days by current clinic settings.
   */
  _computeConfiguredWorkingDays: function(settings, per, nowMs, now) {
    var days = this._enumerateDays(per);
    var count = 0;
    var dayBreakdown = [];

    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var isWorking = this._isWorkingDay(d.weekday, settings);
      if (isWorking) {
        count += 1;
      }
      dayBreakdown.push({
        date: d.dateStr,
        weekday: d.weekday,
        isWorkingDay: isWorking
      });
    }

    return Result.ok(this._availableEnvelope(
      MetricsService.METRICS.CONFIGURED_WORKING_DAYS,
      count,
      per,
      now,
      nowMs,
      {
        source: MetricsService.SOURCES.SETTINGS,
        fields: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
        condition: 'SlotGenerator.isWorkingDay(date, settings) === true',
        aggregation: 'COUNT working days in period',
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        audience: MetricsService.AUDIENCE.INTERNAL_DIAGNOSTIC,
        asOfMs: nowMs,
        workingDaysCount: count,
        totalCalendarDaysInPeriod: days.length,
        days: dayBreakdown,
        historicalPolicy: 'Historical configured working schedule is not provable without settings version history; closed and mixed past periods are DEFERRED.'
      }
    ));
  },

  /**
   * CONFIGURED_CAPACITY (M1-C)
   * Sums floor((work_end - work_start) / slotDuration) for each working day in the period.
   * Closed days yield 0 (a VALID ZERO).
   *
   * Single Source of Truth: Slot duration and its provenance are consumed
   * directly from SettingsRepository.getSlotDurationInfo(settings) without duplication.
   */
  _computeConfiguredCapacity: function(settings, per, nowMs, now) {
    var durationInfo = SettingsRepository.getSlotDurationInfo(settings);
    var slotDur = durationInfo.minutes;
    var slotDurSource = durationInfo.source;

    if (!settings || typeof settings.work_start !== 'string' || typeof settings.work_end !== 'string' ||
        !settings.work_start.trim() || !settings.work_end.trim()) {
      return Result.fail(
        'METRIC_EVIDENCE_INVALID',
        'Settings is missing work_start or work_end',
        { work_start: settings && settings.work_start, work_end: settings && settings.work_end }
      );
    }

    var startParts = String(settings.work_start).trim().split(':');
    var endParts = String(settings.work_end).trim().split(':');
    if (startParts.length < 2 || endParts.length < 2) {
      return Result.fail(
        'METRIC_EVIDENCE_INVALID',
        'Settings work_start or work_end format is invalid (expected HH:mm)',
        { work_start: settings.work_start, work_end: settings.work_end }
      );
    }

    var startMin = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    var endMin = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);
    if (isNaN(startMin) || isNaN(endMin) || endMin <= startMin) {
      return Result.fail(
        'METRIC_EVIDENCE_INVALID',
        'Settings work_start / work_end values are invalid or work_end <= work_start',
        { startMin: startMin, endMin: endMin, work_start: settings.work_start, work_end: settings.work_end }
      );
    }

    var workingMinutesPerDay = endMin - startMin;
    var dailySlotCount = Math.floor(workingMinutesPerDay / slotDur);

    var days = this._enumerateDays(per);
    var totalCapacity = 0;
    var workingDays = 0;
    var dayBreakdown = [];

    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var isWorking = this._isWorkingDay(d.weekday, settings);
      var dayCap = isWorking ? dailySlotCount : 0;
      if (isWorking) {
        workingDays += 1;
        totalCapacity += dayCap;
      }
      dayBreakdown.push({
        date: d.dateStr,
        weekday: d.weekday,
        isWorkingDay: isWorking,
        capacity: dayCap
      });
    }

    return Result.ok(this._availableEnvelope(
      MetricsService.METRICS.CONFIGURED_CAPACITY,
      totalCapacity,
      per,
      now,
      nowMs,
      {
        source: MetricsService.SOURCES.SETTINGS,
        fields: ['work_start', 'work_end', SettingsRepository.SLOT_DURATION_SETTINGS_KEY, 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
        condition: 'SlotGenerator.isWorkingDay(date, settings) ? floor((work_end - work_start) / slotDuration) : 0',
        aggregation: 'SUM daily configured capacity across period',
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        audience: MetricsService.AUDIENCE.DOCTOR_FACING,
        asOfMs: nowMs,
        work_start: settings.work_start,
        work_end: settings.work_end,
        workingMinutesPerDay: workingMinutesPerDay,
        dailyConfiguredCapacity: dailySlotCount,
        slotDurationMinutes: slotDur,
        slotDurationSource: slotDurSource,
        fallbackPolicy: slotDurSource === MetricsService.SLOT_DURATION_SOURCES.DEFAULT_FALLBACK
          ? 'DEFAULT_FALLBACK = 30 is an operational fallback, not configured clinical truth'
          : 'CONFIGURED slot duration from Settings',
        workingDaysInPeriod: workingDays,
        totalCalendarDaysInPeriod: days.length,
        days: dayBreakdown,
        historicalPolicy: 'Historical configured capacity is not provable without settings version history; closed and mixed past periods are DEFERRED.'
      }
    ));
  },

  /**
   * OBSERVED_GENERATED_CAPACITY (M1-C)
   * Counts all slot rows present in Availability within the period.
   */
  _computeObservedGeneratedCapacity: function(rows, per, nowMs, now) {
    var count = 0;
    var unattributable = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var slotStartMs = this._slotStartMs(row);
      if (slotStartMs === null) {
        unattributable += 1;
        continue;
      }
      if (slotStartMs >= per.startMs && slotStartMs < per.endMs) {
        count += 1;
      }
    }

    return Result.ok(this._availableEnvelope(
      MetricsService.METRICS.OBSERVED_GENERATED_CAPACITY,
      count,
      per,
      now,
      nowMs,
      {
        source: MetricsService.SOURCES.AVAILABILITY,
        fields: ['slot_id', 'sort_key', 'status', 'is_available'],
        condition: 'slotStartMs >= period.startMs AND slotStartMs < period.endMs',
        aggregation: 'COUNT observed generated slot rows',
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        audience: MetricsService.AUDIENCE.INTERNAL_DIAGNOSTIC,
        asOfMs: nowMs,
        snapshotMeaning: 'all slot rows currently present in Availability whose start time falls inside the period, regardless of status',
        absencePolicy: 'absence of generated rows does not prove clinic closure; may indicate missing generation, unreached horizon, or generation failure',
        unattributableRows: unattributable,
        historicalPolicy: 'Historical Availability generation completeness is not provable without generation snapshots; closed periods are DEFERRED.'
      }
    ));
  },

  /**
   * OBSERVED_WORKING_DAYS (M1-C)
   * Counts distinct clinic-local calendar dates with >= 1 observed generated slot in Availability.
   */
  _computeObservedWorkingDays: function(rows, per, nowMs, now) {
    var seenDates = {};
    var unattributable = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var slotStartMs = this._slotStartMs(row);
      if (slotStartMs === null) {
        unattributable += 1;
        continue;
      }
      if (slotStartMs >= per.startMs && slotStartMs < per.endMs) {
        var dateKey = this._slotDateKey(slotStartMs);
        seenDates[dateKey] = true;
      }
    }

    var count = Object.keys(seenDates).length;

    return Result.ok(this._availableEnvelope(
      MetricsService.METRICS.OBSERVED_WORKING_DAYS,
      count,
      per,
      now,
      nowMs,
      {
        source: MetricsService.SOURCES.AVAILABILITY,
        fields: ['slot_id', 'sort_key'],
        condition: 'slotStartMs >= period.startMs AND slotStartMs < period.endMs',
        aggregation: 'COUNT DISTINCT calendar date having >= 1 observed generated slot',
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        audience: MetricsService.AUDIENCE.INTERNAL_DIAGNOSTIC,
        asOfMs: nowMs,
        observedDates: Object.keys(seenDates).sort(),
        absencePolicy: 'absence of generated rows does not prove clinic closure; observed working days reflect generated reality, not official clinic schedule',
        unattributableRows: unattributable,
        historicalPolicy: 'Historical observed working days are not provable without generation snapshots; closed periods are DEFERRED.'
      }
    ));
  },

  /**
   * GENERATION_COMPLETENESS (M1-C)
   * (Observed Generated Capacity / Configured Capacity) * 100.
   * Internal / Diagnostic metric.
   */
  _computeGenerationCompleteness: function(availRows, settings, per, nowMs, now) {
    var observedResult = this._computeObservedGeneratedCapacity(availRows, per, nowMs, now);
    if (!observedResult.ok) return observedResult;
    var observed = observedResult.data;

    var configuredResult = this._computeConfiguredCapacity(settings, per, nowMs, now);
    if (!configuredResult.ok) return configuredResult;
    var configured = configuredResult.data;

    var base = {
      metric: MetricsService.METRICS.GENERATION_COMPLETENESS,
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: now,
      provenance: {
        sources: [MetricsService.SOURCES.AVAILABILITY, MetricsService.SOURCES.SETTINGS],
        formula: '(Observed Generated Capacity / Configured Capacity) * 100',
        periodSemantics: MetricsService.PERIOD_SEMANTICS,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        audience: MetricsService.AUDIENCE.INTERNAL_DIAGNOSTIC,
        purpose: 'Internal / Diagnostic indicator comparing generated slots to planned capacity',
        asOfMs: nowMs,
        observedGeneratedCapacity: observed.value,
        configuredCapacity: configured.value,
        zeroDenominatorPolicy: 'Configured Capacity = 0 → N/A (UNAVAILABLE / ZERO_DENOMINATOR), never 0%'
      }
    };

    if (configured.value === 0) {
      return Result.ok(Object.assign({}, base, {
        status: MetricsService.STATUS.UNAVAILABLE,
        value: null,
        reason: MetricsService.REASONS.ZERO_DENOMINATOR
      }));
    }

    var percentage = (observed.value / configured.value) * 100;
    return Result.ok(Object.assign({}, base, {
      status: MetricsService.STATUS.AVAILABLE,
      value: percentage,
      reason: null
    }));
  },

  /**
   * BOOKING_UTILIZATION (M1-C)
   * (Confirmed Appointments / Configured Capacity) * 100.
   * Doctor-facing business KPI.
   */
  _computeBookingUtilization: function(availRows, settings, per, nowMs, now) {
    var confirmedResult = this._computeConfirmed(availRows, per, nowMs, now);
    if (!confirmedResult.ok) return confirmedResult;
    var confirmed = confirmedResult.data;

    var configuredResult = this._computeConfiguredCapacity(settings, per, nowMs, now);
    if (!configuredResult.ok) return configuredResult;
    var configured = configuredResult.data;

    var base = {
      metric: MetricsService.METRICS.BOOKING_UTILIZATION,
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: now,
      provenance: {
        sources: [MetricsService.SOURCES.AVAILABILITY, MetricsService.SOURCES.SETTINGS],
        formula: '(Confirmed Appointments / Configured Capacity) * 100',
        denominatorRationale: 'Denominator is Configured Capacity (not Observed Generated, not Bookable) to ensure planning shortfalls are not masked',
        periodSemantics: MetricsService.PERIOD_SEMANTICS,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        audience: MetricsService.AUDIENCE.DOCTOR_FACING,
        asOfMs: nowMs,
        confirmedAppointments: confirmed.value,
        configuredCapacity: configured.value,
        zeroDenominatorPolicy: 'Configured Capacity = 0 → N/A (UNAVAILABLE / ZERO_DENOMINATOR), never 0%'
      }
    };

    if (configured.value === 0) {
      return Result.ok(Object.assign({}, base, {
        status: MetricsService.STATUS.UNAVAILABLE,
        value: null,
        reason: MetricsService.REASONS.ZERO_DENOMINATOR
      }));
    }

    var percentage = (confirmed.value / configured.value) * 100;
    return Result.ok(Object.assign({}, base, {
      status: MetricsService.STATUS.AVAILABLE,
      value: percentage,
      reason: null
    }));
  },

  // ═══════════════════════════════════════════════════════════
  // Envelopes / pure helpers
  // ═══════════════════════════════════════════════════════════

  _availableEnvelope: function(metricName, value, per, now, asOfMs, provenance) {
    return {
      metric: metricName,
      status: MetricsService.STATUS.AVAILABLE,
      value: value,
      reason: null,
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: now,
      provenance: Object.assign({ periodSemantics: MetricsService.PERIOD_SEMANTICS }, provenance)
    };
  },

  _deferredEnvelope: function(metricName, def, per, now, nowMs) {
    var todayStartMs = this._todayStartMs(nowMs);
    var isMixed = per.startMs < todayStartMs && per.endMs > nowMs;

    var policy = isMixed
      ? 'Mixed periods containing historical days (period.startMs < todayStartMs) cannot be proven for configured schedule metrics because SettingsRepository has no version history. Current settings cannot be retroactively applied to past days; mixed periods are DEFERRED.'
      : 'SNAPSHOT_CURRENT_STATE metrics are provable only while the period is not fully closed (period.endMs > asOfMs). Availability status is mutable, so a closed period cannot be reconstructed from current state; an event history would be required. No approximation, no inference, no invention.';

    return {
      metric: metricName,
      status: MetricsService.STATUS.DEFERRED,
      value: null,
      reason: MetricsService.REASONS.HISTORICAL_NOT_PROVABLE,
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: now,
      provenance: {
        source: def.source || (def.requiredSources ? def.requiredSources.join(', ') : null),
        semantics: def.semantics,
        periodSemantics: MetricsService.PERIOD_SEMANTICS,
        asOfMs: nowMs,
        todayStartMs: todayStartMs,
        isMixedPeriod: isMixed,
        historicalPolicy: policy
      }
    };
  },

  /**
   * Instant of 00:00:00 clinic local on the day containing nowMs.
   * Pure arithmetic with fixed Asia/Baghdad (+03:00 / 180 min) offset.
   */
  _todayStartMs: function(nowMs) {
    var offsetMs = 180 * 60000;
    var dayMs = 86400000;
    var nowWallMs = nowMs + offsetMs;
    var todayIndex = Math.floor(nowWallMs / dayMs);
    return todayIndex * dayMs - offsetMs;
  },

  /**
   * Canonicalizes {start, end} (Date or epoch ms) into epoch ms with
   * uniform semantics: start inclusive, end exclusive, start < end.
   */
  _canonicalPeriod: function(period) {
    if (!period || typeof period !== 'object') {
      return Result.fail(
        'METRIC_PERIOD_INVALID',
        'Period must be an object { start, end } of Date or epoch-ms values',
        { period: period }
      );
    }
    var startMs = this._toEpochMs(period.start);
    var endMs = this._toEpochMs(period.end);
    if (startMs === null || endMs === null) {
      return Result.fail(
        'METRIC_PERIOD_INVALID',
        'Period start/end must be Date or finite epoch-ms values',
        { start: period.start, end: period.end }
      );
    }
    if (!(startMs < endMs)) {
      return Result.fail(
        'METRIC_PERIOD_INVALID',
        'Period start must be strictly before end (start inclusive, end exclusive)',
        { startMs: startMs, endMs: endMs }
      );
    }
    return Result.ok({ startMs: startMs, endMs: endMs });
  },

  /** Date → epoch ms; finite number → as-is; anything else → null. */
  _toEpochMs: function(value) {
    if (value instanceof Date) {
      var ms = value.getTime();
      return isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number' && isFinite(value)) return value;
    return null;
  },

  /** Slot start time in epoch ms from sort_key (ADR-016). */
  _slotStartMs: function(row) {
    var comparable = LegacySlotTimeParser.toComparableTime(row && row.sort_key);
    if (typeof comparable !== 'number' || !isFinite(comparable)) return null;
    return comparable;
  },

  /** Evidence/journal timestamp in epoch ms. */
  _rowMs: function(value) {
    return this._toEpochMs(value);
  },

  /** Append-order key for evidence rows. */
  _rowOrder: function(row, arrayIndex) {
    var n = Number(row && row._rowNumber);
    if (typeof n === 'number' && isFinite(n) && n > 0) return n;
    return arrayIndex;
  },

  /** A valid business identity key for DISTINCT counting. */
  _hasIdentity: function(value) {
    return typeof value === 'string' && value.trim() !== '';
  },

  /** is_available eligibility normalization. */
  _isAvailableFlag: function(value) {
    if (value === true) return true;
    if (typeof value === 'string' && value.trim().toUpperCase() === 'TRUE') return true;
    return false;
  },

  /** Working day predicate matching SlotGenerator.isWorkingDay. */
  _isWorkingDay: function(weekday, settings) {
    if (!settings || typeof settings !== 'object') return false;
    var dayMapping = {
      0: settings.sunday,
      1: settings.monday,
      2: settings.tuesday,
      3: settings.wednesday,
      4: settings.thursday,
      5: settings.friday,
      6: settings.saturday
    };
    var val = dayMapping[weekday];
    if (val === true) return true;
    if (typeof val === 'string' && val.trim().toUpperCase() === 'TRUE') return true;
    return false;
  },

  /**
   * Pure civil calendar day-index to YYYY-MM-DD string conversion.
   * Howard Hinnant algorithm: zero Date objects, zero string guessing.
   */
  _dayIndexToDateStr: function(dayIndex) {
    var z = dayIndex + 719468;
    var era = Math.floor((z >= 0 ? z : z - 146096) / 146097);
    var doe = z - era * 146097;
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp + (mp < 10 ? 3 : -9);
    if (m <= 2) y += 1;
    return String(y) + '-' + (m < 10 ? '0' + m : String(m)) + '-' + (d < 10 ? '0' + d : String(d));
  },

  /**
   * Pure clinic-local calendar day enumerator for period [startMs, endMs).
   * Uses Asia/Baghdad fixed offset (+03:00 / 180 min) for total determinism.
   * Pure arithmetic: zero Date construction.
   */
  _enumerateDays: function(per) {
    var days = [];
    var offsetMs = 180 * 60000;
    var dayMs = 86400000;

    var startWallMs = per.startMs + offsetMs;
    var currentDayIndex = Math.floor(startWallMs / dayMs);
    var currentDayStartInstant = currentDayIndex * dayMs - offsetMs;

    while (currentDayStartInstant < per.endMs) {
      var dayIndex = Math.floor((currentDayStartInstant + offsetMs) / dayMs);
      var weekday = (dayIndex + 4) % 7;
      if (weekday < 0) weekday += 7;

      var dateStr = this._dayIndexToDateStr(dayIndex);

      days.push({
        startMs: currentDayStartInstant,
        endMs: currentDayStartInstant + dayMs,
        dateStr: dateStr,
        weekday: weekday
      });

      currentDayStartInstant += dayMs;
    }

    return days;
  },

  /** Clinic-local date key YYYY-MM-DD from instant via pure arithmetic. */
  _slotDateKey: function(slotStartMs) {
    var offsetMs = 180 * 60000;
    var dayMs = 86400000;
    var dayIndex = Math.floor((slotStartMs + offsetMs) / dayMs);
    return this._dayIndexToDateStr(dayIndex);
  }
};
