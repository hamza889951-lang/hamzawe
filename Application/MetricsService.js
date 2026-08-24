/**
 * MetricsService — M1-A (PHASE 1.2 — METRICS FOUNDATION)
 *
 * ONE metric definition → ONE calculation path → MANY consumers.
 * Daily/Weekly/Monthly reports (M1-B+) must consume this foundation;
 * they must never grow their own calculations.
 *
 * ─── FROZEN M1 CONTRACT (implemented, never redefined here) ───
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
 *    source:        ATTENDANCE_AUDIT (attendance evidence, read through
 *                   AttendanceAuditReadRepository — the append-only
 *                   write contract is untouched)
 *    condition:     outcome === APPLIED AND to_status === COMPLETED AND
 *                   timestamp >= ATTENDANCE_ACTIVATION_AT
 *    aggregation:   COUNT DISTINCT slot_id (ALREADY_APPLIED is not new
 *                   attendance and is never counted)
 *    semantics:     HISTORICAL_EVIDENCE — counted by the DECISION
 *                   timestamp, not by appointment start time. Completed
 *                   is never inferred from appointment end, calendar
 *                   event end, or patient silence.
 *
 *  NO_SHOW_APPOINTMENTS
 *    source:        ATTENDANCE_AUDIT
 *    condition:     outcome === APPLIED AND to_status === NO_SHOW AND
 *                   timestamp >= ATTENDANCE_ACTIVATION_AT
 *    aggregation:   COUNT DISTINCT slot_id
 *    semantics:     HISTORICAL_EVIDENCE — never inferred from "no
 *                   reply" or "no cancellation".
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
 * ─── ATTENDANCE_ACTIVATION_AT ───
 *  Derived boundary consumed from M0, not redesigned: the timestamp of
 *  the first APPLIED attendance audit row. No new sheet column, no
 *  permanent Script Property. A readable audit store with zero APPLIED
 *  rows provably contains no attendance decisions, so attendance counts
 *  are a VALID ZERO with attendanceActivationAtMs = null.
 *
 * ─── RESULT CONTRACT (project Result — no parallel success system) ───
 *  Result.fail codes (operational failures):
 *    METRIC_UNKNOWN            — metric name not in the registry
 *    METRIC_PERIOD_INVALID     — malformed/non-finite/inverted period
 *    METRIC_SOURCE_UNAVAILABLE — source could not be read/proven
 *                                (details.error carries the boundary's
 *                                underlying failure). NEVER a zero.
 *  Result.ok envelope:
 *    {
 *      metric, status, value, reason,
 *      period: { startMs, endMs },     // canonical epoch ms
 *      evaluatedAt,                    // Clock.now() at calculation
 *      provenance: { source, fields, condition, periodFilter,
 *                    periodSemantics, aggregation, semantics,
 *                    asOfMs?, unattributableRows?, ... }
 *    }
 *  status:
 *    AVAILABLE   — value is a PROVEN number; value 0 is a VALID ZERO
 *                  (zero ≠ unavailable is the whole point)
 *    UNAVAILABLE — value null (reserved: e.g. ratio zero-denominator)
 *    DEFERRED    — value null; reason HISTORICAL_NOT_PROVABLE for
 *                  snapshot metrics over closed periods
 *
 * ─── TIME / RANGE CONTRACT ───
 *  Clock.now() is the ONLY current-time source. All period comparisons
 *  happen in canonical epoch milliseconds with one uniform
 *  interpretation: start INCLUSIVE, end EXCLUSIVE — identical for every
 *  metric, so Daily/Weekly/Monthly cannot diverge on boundaries or
 *  timezone. Period input: { start, end } where each is a Date or epoch
 *  ms number. Timezone becomes irrelevant at this layer: callers build
 *  wall-clock boundaries in the clinic timezone and pass instants.
 *
 * ─── LAYERING / SIDE EFFECTS ───
 *  Application layer: reaches storage ONLY through repositories
 *  (SlotRepository.queryResult, B6LifecycleRepository.queryResult,
 *  AttendanceAuditReadRepository.readAll). Never SpreadsheetApp /
 *  CalendarApp / UrlFetchApp. Never SYSTEM_LOG as a metric source.
 *  Pure read path: no locks, no writes, no booking/change/cancel/
 *  attendance/calendar mutation is possible from here.
 *
 * Evaluation-order note: clasp evaluates project files alphabetically,
 * so this file loads BEFORE Config.js and BEFORE
 * Repositories/AttendanceAuditRepository.js. Every cross-module
 * reference (Config, SlotRepository, B6LifecycleRepository,
 * B6LifecycleService terminal vocabulary, AttendanceAuditReadRepository)
 * is resolved at CALL time — same discipline as AttendanceService.
 */
const MetricsService = {

  METRICS: {
    CONFIRMED_APPOINTMENTS: 'CONFIRMED_APPOINTMENTS',
    OFFICIAL_CANCELLATIONS: 'OFFICIAL_CANCELLATIONS',
    OFFICIAL_CHANGES: 'OFFICIAL_CHANGES',
    COMPLETED_APPOINTMENTS: 'COMPLETED_APPOINTMENTS',
    NO_SHOW_APPOINTMENTS: 'NO_SHOW_APPOINTMENTS',
    BOOKABLE_SLOTS: 'BOOKABLE_SLOTS'
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
    ATTENDANCE_AUDIT: 'ATTENDANCE_AUDIT'
  },

  SEMANTICS: {
    SNAPSHOT_CURRENT_STATE: 'SNAPSHOT_CURRENT_STATE',
    HISTORICAL_EVIDENCE: 'HISTORICAL_EVIDENCE'
  },

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
   *                        METRIC_SOURCE_UNAVAILABLE)
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

    // Snapshot metrics over closed periods are not provable from current
    // state. Defer BEFORE reading any source: an unprovable metric must
    // not even imply the source was consulted.
    if (def.deferPast && per.endMs <= nowMs) {
      return Result.ok(this._deferredEnvelope(metricName, def, per, now, nowMs));
    }

    var read = def.read();
    if (!read.ok) {
      return Result.fail(
        'METRIC_SOURCE_UNAVAILABLE',
        'Metric source could not be read for ' + metricName,
        { metric: metricName, source: def.source, error: read.error }
      );
    }

    return Result.ok(def.compute(read.data, per, nowMs, now));
  },

  /**
   * Calculates many metrics for one period with ONE shared read per
   * source (no N × sheet reads). All-or-nothing: if any required source
   * fails, the whole call fails — a partial batch could be mistaken for
   * a complete one.
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

    // One lazy read per source, shared by every metric on that source.
    var rowsBySource = {};
    var results = {};

    var names = Object.keys(defs);
    for (var j = 0; j < names.length; j++) {
      var name = names[j];
      var def = defs[name];

      if (def.deferPast && per.endMs <= nowMs) {
        results[name] = this._deferredEnvelope(name, def, per, now, nowMs);
        continue;
      }

      if (!rowsBySource.hasOwnProperty(def.source)) {
        var read = def.read(); // identical per source by construction
        if (!read.ok) {
          return Result.fail(
            'METRIC_SOURCE_UNAVAILABLE',
            'Metric source could not be read for ' + name,
            { metric: name, source: def.source, error: read.error }
          );
        }
        rowsBySource[def.source] = read.data;
      }

      results[name] = def.compute(rowsBySource[def.source], per, nowMs, now);
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
   * Zero-denominator policy (M1 contract §16): denominator 0 → N/A
   * (status UNAVAILABLE, reason ZERO_DENOMINATOR, value null) — NEVER
   * 0%. A valid zero numerator over a positive denominator IS 0.
   *
   * This is an extensible foundation combinator only: no business ratio
   * (Attendance Rate, Utilization, ...) is registered as a metric by
   * M1-A, because their historical provability is not established.
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

    // Propagate the worst status: a ratio over a not-provable input is
    // itself not provable; a ratio over an unavailable input is N/A.
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

  // ═══════════════════════════════════════════════════════════
  // Metric definitions (registry)
  // ═══════════════════════════════════════════════════════════

  /**
   * @param {string} metricName
   * @returns {Result} ok({metric, source, semantics, deferPast, read, compute})
   */
  _definition: function(metricName) {
    var self = this;
    var M = MetricsService.METRICS;

    if (metricName === M.CONFIRMED_APPOINTMENTS) {
      return Result.ok({
        metric: metricName,
        source: MetricsService.SOURCES.AVAILABILITY,
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        deferPast: true,
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
        read: function() {
          return B6LifecycleRepository.queryResult(function() { return true; });
        },
        compute: function(rows, per, nowMs, now) {
          // Terminal vocabulary resolved at call time (frozen B6 contract).
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
        read: function() {
          return AttendanceAuditReadRepository.readAll();
        },
        compute: function(rows, per, nowMs, now) {
          // Vocabulary resolved at call time (Config is evaluated after
          // Application files in clasp order).
          var status = metricName === M.COMPLETED_APPOINTMENTS
            ? Config.VOCABULARY.STATUS.COMPLETED
            : Config.VOCABULARY.STATUS.NO_SHOW;
          return self._computeAttendance(rows, per, now, metricName, status);
        }
      });
    }

    return Result.fail(
      'METRIC_UNKNOWN',
      'Unknown metric: ' + metricName,
      { requested: metricName, available: Object.keys(MetricsService.METRICS) }
    );
  },

  // ═══════════════════════════════════════════════════════════
  // Computations (one per family)
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
        unattributable += 1; // matched the state condition but cannot be time-positioned; surfaced, never guessed
        continue;
      }
      if (slotStartMs >= per.startMs && slotStartMs < per.endMs) count += 1;
    }

    return this._availableEnvelope(
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
        asOfMs: nowMs,
        snapshotMeaning: 'slots currently CONFIRMED (as of asOfMs) whose start time falls inside the period',
        unattributableRows: unattributable
      }
    );
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
      if (slotStartMs >= cutoffMs &&
          slotStartMs >= per.startMs &&
          slotStartMs < per.endMs) {
        count += 1;
      }
    }

    return this._availableEnvelope(
      MetricsService.METRICS.BOOKABLE_SLOTS,
      count,
      per,
      now,
      nowMs,
      {
        source: MetricsService.SOURCES.AVAILABILITY,
        fields: ['status', 'is_available', 'sort_key'],
        condition: "status === '" + statusFree + "' AND isAvailable === true AND slotStartMs >= (asOfMs + MIN_BOOKING_LEAD_MINUTES)",
        periodFilter: 'slotStartMs >= period.startMs AND slotStartMs < period.endMs',
        aggregation: 'COUNT',
        semantics: MetricsService.SEMANTICS.SNAPSHOT_CURRENT_STATE,
        asOfMs: nowMs,
        leadMinutes: leadMinutes,
        eligibilityCutoffMs: cutoffMs,
        eligibilityReference: 'SlotSelection.findEarliestBookable',
        unattributableRows: unattributable
      }
    );
  },

  /**
   * OFFICIAL_CANCELLATIONS / OFFICIAL_CHANGES — terminal-proof counting
   * over the append-only B6 lifecycle journal. One terminal operation =
   * one Change / one Cancellation, regardless of checkpoint, retry,
   * recovery, or release rows.
   */
  _computeLifecycleTerminal: function(rows, per, now, metricName, resolvedState, terminalCheckpoint) {
    var count = 0;
    var unattributable = 0;
    var seenOperationIds = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.lifecycle_state !== resolvedState) continue;
      if (row.checkpoint !== terminalCheckpoint) continue;

      var terminalMs = this._rowMs(row.timestamp);
      if (terminalMs === null) {
        unattributable += 1; // terminal row whose proof time cannot be positioned; surfaced, never guessed
        continue;
      }
      if (terminalMs >= per.startMs && terminalMs < per.endMs) {
        var operationId = row.operation_id;
        if (!seenOperationIds.hasOwnProperty(operationId)) {
          seenOperationIds[operationId] = true;
          count += 1;
        }
      }
    }

    return this._availableEnvelope(
      metricName,
      count,
      per,
      now,
      null,
      {
        source: MetricsService.SOURCES.B6_LIFECYCLE,
        fields: ['lifecycle_state', 'checkpoint', 'operation_id', 'timestamp'],
        condition: "lifecycle_state === '" + resolvedState + "' AND checkpoint === '" + terminalCheckpoint + "'",
        periodFilter: 'terminalProofMs >= period.startMs AND terminalProofMs < period.endMs (terminalProofMs = the terminal checkpoint row timestamp, i.e. when terminal proof was recorded)',
        aggregation: 'COUNT DISTINCT operation_id',
        semantics: MetricsService.SEMANTICS.HISTORICAL_EVIDENCE,
        journalDiscipline: 'checkpoint / retry / recovery / release rows never multiply one business operation',
        unattributableRows: unattributable
      }
    );
  },

  /**
   * COMPLETED_APPOINTMENTS / NO_SHOW_APPOINTMENTS — official attendance
   * over the append-only ATTENDANCE_AUDIT evidence store, bounded by the
   * derived ATTENDANCE_ACTIVATION_AT (timestamp of the first APPLIED
   * row). ALREADY_APPLIED is not new attendance and never counts.
   */
  _computeAttendance: function(rows, per, now, metricName, targetStatus) {
    var applied = MetricsService.AUDIT_OUTCOMES.APPLIED;

    // ATTENDANCE_ACTIVATION_AT = min timestamp across ALL APPLIED rows
    // (first applied attendance decision, any decision type).
    var activationMs = null;
    for (var a = 0; a < rows.length; a++) {
      if (rows[a].outcome !== applied) continue;
      var candidateMs = this._rowMs(rows[a].timestamp);
      if (candidateMs === null) continue;
      if (activationMs === null || candidateMs < activationMs) activationMs = candidateMs;
    }

    var count = 0;
    var unattributable = 0;
    var seenSlotIds = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.outcome !== applied) continue;
      if (row.to_status !== targetStatus) continue;

      var decisionMs = this._rowMs(row.timestamp);
      if (decisionMs === null) {
        unattributable += 1; // APPLIED evidence row that cannot be time-positioned; surfaced, never guessed
        continue;
      }
      // Explicit activation-boundary guard (frozen contract). By
      // construction no APPLIED row precedes the first APPLIED row; the
      // guard is kept so the boundary can never be silently violated.
      if (activationMs !== null && decisionMs < activationMs) continue;

      if (decisionMs >= per.startMs && decisionMs < per.endMs) {
        var slotId = row.slot_id;
        if (!seenSlotIds.hasOwnProperty(slotId)) {
          seenSlotIds[slotId] = true;
          count += 1;
        }
      }
    }

    return this._availableEnvelope(
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
        activationDerivation: 'ATTENDANCE_ACTIVATION_AT = timestamp of the first APPLIED attendance audit row (M0 derived boundary; no sheet column, no Script Property). null = no attendance decision has ever been applied, in which case a readable store provably yields a valid zero.',
        decisionTimestampBasis: 'attendance is counted by DECISION timestamp, not by appointment start time',
        alreadyAppliedPolicy: 'ALREADY_APPLIED is not new attendance and is never counted',
        unattributableRows: unattributable
      }
    );
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
    return {
      metric: metricName,
      status: MetricsService.STATUS.DEFERRED,
      value: null,
      reason: MetricsService.REASONS.HISTORICAL_NOT_PROVABLE,
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: now,
      provenance: {
        source: def.source,
        semantics: def.semantics,
        periodSemantics: MetricsService.PERIOD_SEMANTICS,
        asOfMs: nowMs,
        historicalPolicy: 'SNAPSHOT_CURRENT_STATE metrics are provable only while the period is not fully closed (period.endMs > asOfMs). Availability status is mutable, so a closed period cannot be reconstructed from current state; an event history would be required. No approximation, no inference, no invention.'
      }
    };
  },

  /**
   * Canonicalizes {start, end} (Date or epoch ms) into epoch ms with
   * uniform semantics: start inclusive, end exclusive, start < end.
   * Strings are rejected: no ambiguous parsing, ever.
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

  /**
   * Slot start time in epoch ms from sort_key, via the documented
   * legacy bridge (ADR-016). null = the row cannot be time-positioned.
   */
  _slotStartMs: function(row) {
    var comparable = LegacySlotTimeParser.toComparableTime(row && row.sort_key);
    if (typeof comparable !== 'number' || !isFinite(comparable)) return null;
    return comparable;
  },

  /**
   * Evidence/journal timestamp in epoch ms. Date cells come back as
   * Date instances; epoch numbers pass through. Strings are NOT parsed
   * (no guessing): such rows become unattributable and are surfaced in
   * provenance instead of being silently mis-dated.
   */
  _rowMs: function(value) {
    return this._toEpochMs(value);
  },

  /**
   * is_available eligibility normalization — identical semantics to
   * SlotSelection._isAvailable / SlotRepository._isAvailable (boolean
   * true or the string 'TRUE', case-insensitive after trim).
   */
  _isAvailableFlag: function(value) {
    if (value === true) return true;
    if (typeof value === 'string' && value.trim().toUpperCase() === 'TRUE') return true;
    return false;
  }
};
