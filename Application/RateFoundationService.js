/**
 * RateFoundationService — M2 (PHASE 1.5 — RATE FOUNDATION)
 *
 * FROZEN CONTRACT: M2-RATE-FOUNDATION-v2
 * Baseline:        0894028ce9d0b450d6a8a4ce049930f3383815da
 *
 * One authoritative foundation for the four management rates:
 *   CANCELLATION_RATE / CHANGE_RATE / COMPLETION_RATE / NO_SHOW_RATE
 * All four share ONE common denominator: CONFIRMED_APPOINTMENT_COHORT.
 *
 * ─── EPISODE MODEL (v2 §2–§5, §16) ───
 * The historical reporting unit is NOT slot_id. It is the APPOINTMENT
 * EPISODE: one confirmed lifecycle of one Availability slot row. The slot
 * row is reusable (FREE → RESERVED → CONFIRMED again, same slot_id), so
 * one slot may own multiple episodes:
 *
 *   E(S) = R(S) + F(S)
 *   R(S) = released episodes — one per DISTINCT B6 terminal operation
 *          (dedupe by operation_id, NEVER by old_slot_id) that released S
 *   F(S) = at most one final/current episode, proven by the slot's current
 *          status (CONFIRMED / COMPLETED / NO_SHOW) reconciled with
 *          APPLIED attendance evidence
 *
 *   CONFIRMED_APPOINTMENT_COHORT(P) = Σ E(S) over slots whose appointment
 *   start (slot_id → Availability.sort_key → LegacySlotTimeParser) falls
 *   inside P. All episodes of a slot share the slot's appointment start,
 *   so daily/weekly/monthly assignment is per-slot.
 *
 * ─── APPOINTMENT-DAY BASIS (v2 §6–§7) ───
 * Every rate belongs to the APPOINTMENT START day — never to the B6
 * operation timestamp, never to the attendance decision timestamp.
 * Periods are canonical (start inclusive / end exclusive, epoch ms) and
 * are built via ReportPeriod (clinic-local Asia/Baghdad).
 *
 * ─── EVIDENCE RULES (v2 §9–§13, §18) ───
 *   CANCELLED = COUNT DISTINCT operation_id
 *               (RESOLVED_CANCEL + TERMINAL_CANCEL_PROVEN)
 *   CHANGED   = COUNT DISTINCT operation_id
 *               (RESOLVED_CHANGE + TERMINAL_CHANGE_PROVEN)
 *   COMPLETED = COUNT DISTINCT slot_id
 *               (ATTENDANCE_AUDIT outcome=APPLIED, to_status=COMPLETED,
 *                ts ≥ ATTENDANCE_ACTIVATION_AT)
 *   NO_SHOW   = COUNT DISTINCT slot_id
 *               (outcome=APPLIED, to_status=NO_SHOW, ts ≥ activation)
 *
 *   new_slot_id is replacement reference / auditability ONLY — it is never
 *   counted into the old episode and never a period-assignment key
 *   (v2 §10–§11). A missing new_slot_id on a terminal change row does NOT
 *   disqualify the released old episode; it is surfaced in provenance
 *   (changeRowsMissingNewSlotId).
 *
 *   ATTENDANCE_ACTIVATION_AT reuses the M0/M1 derived boundary: timestamp
 *   of the FIRST APPLIED row in append order. No second boundary is
 *   created. If that row's timestamp is unparseable, the affected rates
 *   (completion / no-show) are withheld (RATE_EVIDENCE_INVALID) — the
 *   boundary is never redefined to a later row (M1 discipline).
 *
 *   ALREADY_APPLIED is not a new outcome and never creates a count.
 *
 *   A slot currently COMPLETED/NO_SHOW without any APPLIED row (audit
 *   persistence failure on the M0 success path) still proves its final
 *   episode via the terminal state (the only legal entry into those states
 *   is CONFIRMED → terminal); the numerator, however, is APPLIED-only
 *   (v2 §12–§13), so rates may sum to less than 100%.
 *
 *   UNATTRIBUTABLE evidence (missing/invalid identity, unparseable time,
 *   unresolvable slot join) → excluded from every count and surfaced in
 *   provenance (unattributableRows). It never invalidates the result and
 *   is never converted to zero.
 *
 *   CONFLICTING evidence (corruption) → the rates for the AFFECTED PERIOD
 *   are UNAVAILABLE / RATE_EVIDENCE_INVALID. Conflicts are period-scoped
 *   (an out-of-period conflict is counted, never fatal):
 *     K1  duplicate Availability rows for one slot_id (identity ambiguity)
 *     K2  APPLIED COMPLETED + APPLIED NO_SHOW for one slot
 *     K3  APPLIED evidence on a slot whose current status cannot be the
 *         matching terminal state (CONFIRMED / RESERVED / FREE / EXPIRED /
 *         CANCELLED)
 *     K4  one operation_id with two or more distinct resolvable old_slot_ids
 *     K5  one operation_id with both CANCEL and CHANGE terminal rows
 *   No "last row wins". NO chronological sort of B6 rows: episode
 *   reconstruction is structural (operation identity + slot evidence)
 *   because recovery can interleave journal timestamps (v2 §17).
 *
 * ─── RESULT / FAILURE SEMANTICS (v2 §19–§21) ───
 *   envelope: { metric, status, value, reason, period, evaluatedAt,
 *               asOfMs, provenance }
 *   status:   AVAILABLE | UNAVAILABLE   (M2 has NO DEFERRED)
 *   reasons:  ZERO_DENOMINATOR | RATE_EVIDENCE_INVALID
 *   call-level failure: Result.fail(RATE_SOURCE_UNAVAILABLE) — one read
 *   per source; ANY required source failure fails the WHOLE batch (shared
 *   denominator), never a zero, never a partially-healthy foundation.
 *   denominator 0 → UNAVAILABLE / ZERO_DENOMINATOR / value null — never
 *   0%.
 *   Reason precedence: RATE_EVIDENCE_INVALID > ZERO_DENOMINATOR.
 *
 * ─── READ BOUNDARIES (v2 §22–§24) ───
 *   Allowed (one read each, Result-based, read-only):
 *     SlotRepository.queryResult
 *     B6LifecycleRepository.queryResult
 *     AttendanceAuditReadRepository.readAll
 *   Forbidden in reporting:
 *     SlotRepository.findById / query / findByStatus  (swallow read
 *       failures — would convert SOURCE FAILURE into absence)
 *     B6LifecycleRepository.findBy* / latestBy*       (call ensureStore —
 *       could CREATE the journal)
 *   READ ONLY: no writes, no locks, no sheet creation, no calendar or
 *   attendance mutation, no recovery, no data repair.
 *
 * ─── AS-OF (v2 §25) ───
 *   The cohort observes the CURRENT state of Availability (final episodes),
 *   so historical rates can change after a day closes (delayed attendance,
 *   recovery proof). Counts are monotonic non-decreasing. Every result
 *   carries evaluatedAt + asOfMs.
 *
 * ─── M1 PRESERVATION (v2 §28) ───
 *   This foundation RE-DERIVES from the approved sources under the
 *   appointment-day basis. It does NOT consume M1 numeric envelopes and
 *   does NOT touch M1 metric definitions (M1 OFFICIAL_* / COMPLETED /
 *   NO_SHOW remain operation/decision-timestamp based — intentionally
 *   different metrics).
 *
 * Evaluation-order note (clasp alphabetical): this file is evaluated
 * BEFORE Config/Repositories/Utils. Every cross-module reference is
 * resolved at CALL time (same discipline as MetricsService).
 */
const RateFoundationService = {

  RATES: {
    CANCELLATION_RATE: 'CANCELLATION_RATE',
    CHANGE_RATE: 'CHANGE_RATE',
    COMPLETION_RATE: 'COMPLETION_RATE',
    NO_SHOW_RATE: 'NO_SHOW_RATE'
  },

  STATUS: {
    AVAILABLE: 'AVAILABLE',
    UNAVAILABLE: 'UNAVAILABLE'
  },

  REASONS: {
    ZERO_DENOMINATOR: 'ZERO_DENOMINATOR',
    RATE_EVIDENCE_INVALID: 'RATE_EVIDENCE_INVALID'
  },

  FAIL_CODES: {
    RATE_SOURCE_UNAVAILABLE: 'RATE_SOURCE_UNAVAILABLE',
    RATE_PERIOD_INVALID: 'RATE_PERIOD_INVALID'
  },

  SOURCES: {
    AVAILABILITY: 'Availability',
    B6_LIFECYCLE: 'B6_LIFECYCLE',
    ATTENDANCE_AUDIT: 'ATTENDANCE_AUDIT'
  },

  COHORT_PATHS: {
    PATH_A_STILL_CONFIRMED: 'pathA_stillConfirmed',
    PATH_B_COMPLETED: 'pathB_completed',
    PATH_C_NO_SHOW: 'pathC_noShow',
    PATH_D_CANCELLED: 'pathD_cancelled',
    PATH_E_CHANGED: 'pathE_changed'
  },

  PERIOD_SEMANTICS: 'start inclusive, end exclusive (canonical epoch ms)',

  APPOINTMENT_DAY_BASIS:
    'APPOINTMENT_START — slot_id → Availability.sort_key → LegacySlotTimeParser → epoch ms (clinic-local Asia/Baghdad wall clock)',

  // ═══════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════

  /**
   * One batched rate request for one period: ONE read per source
   * (Availability, B6_LIFECYCLE, ATTENDANCE_AUDIT), in-memory episode
   * reconstruction, then four envelopes over ONE shared
   * CONFIRMED_APPOINTMENT_COHORT.
   *
   * @param {{start: Date|number, end: Date|number}} period
   * @returns {Result}
   *   ok({
   *     period: { startMs, endMs },
   *     evaluatedAt: Date,
   *     asOfMs: number,
   *     cohort: { total, byPath, reusedSlots, reusedSlotEpisodes,
   *               unattributableRows, conflicts },
   *     rates: { CANCELLATION_RATE, CHANGE_RATE, COMPLETION_RATE,
   *              NO_SHOW_RATE }  (envelopes),
   *     provenance: { sources, readPolicy, sourceFailure, activationMs, ... }
   *   })
   *   | fail(RATE_PERIOD_INVALID | RATE_SOURCE_UNAVAILABLE)
   */
  calculateRates: function(period) {
    var periodResult = this._canonicalPeriod(period);
    if (!periodResult.ok) return periodResult;
    var per = periodResult.data;

    var sourcesResult = this._readAllSources();
    if (!sourcesResult.ok) return sourcesResult;

    var now = Clock.now();
    var nowMs = now.getTime();

    var built = this._buildEvidence(sourcesResult.data, per);

    var rates = {};
    var rateSpecs = [
      {
        name: this.RATES.CANCELLATION_RATE,
        numerator: built.cancelled,
        evidence: {
          source: this.SOURCES.B6_LIFECYCLE,
          fields: ['lifecycle_state', 'checkpoint', 'operation_id', 'old_slot_id', 'Availability.sort_key'],
          condition: "lifecycle_state === 'RESOLVED_CANCEL' AND checkpoint === 'TERMINAL_CANCEL_PROVEN' AND valid operation_id AND valid old_slot_id",
          aggregation: 'COUNT DISTINCT operation_id',
          periodFilter: 'old-slot appointmentStartMs >= period.startMs AND old-slot appointmentStartMs < period.endMs'
        }
      },
      {
        name: this.RATES.CHANGE_RATE,
        numerator: built.changed,
        evidence: {
          source: this.SOURCES.B6_LIFECYCLE,
          fields: ['lifecycle_state', 'checkpoint', 'operation_id', 'old_slot_id', 'Availability.sort_key'],
          condition: "lifecycle_state === 'RESOLVED_CHANGE' AND checkpoint === 'TERMINAL_CHANGE_PROVEN' AND valid operation_id AND valid old_slot_id",
          aggregation: 'COUNT DISTINCT operation_id',
          periodFilter: 'old-slot appointmentStartMs >= period.startMs AND old-slot appointmentStartMs < period.endMs',
          newSlotIdPolicy: 'new_slot_id is replacement reference/auditability only — never counted into the old episode, never a period-assignment key'
        }
      },
      {
        name: this.RATES.COMPLETION_RATE,
        numerator: built.completed,
        evidence: {
          source: this.SOURCES.ATTENDANCE_AUDIT,
          fields: ['outcome', 'to_status', 'timestamp', 'slot_id', 'Availability.sort_key'],
          condition: "outcome === 'APPLIED' AND to_status === 'COMPLETED' AND timestampMs >= ATTENDANCE_ACTIVATION_AT",
          aggregation: 'COUNT DISTINCT slot_id',
          periodFilter: 'slot appointmentStartMs >= period.startMs AND slot appointmentStartMs < period.endMs',
          attendanceActivationAtMs: built.activationMs,
          alreadyAppliedPolicy: 'ALREADY_APPLIED is not a new outcome and never counts'
        }
      },
      {
        name: this.RATES.NO_SHOW_RATE,
        numerator: built.noShow,
        evidence: {
          source: this.SOURCES.ATTENDANCE_AUDIT,
          fields: ['outcome', 'to_status', 'timestamp', 'slot_id', 'Availability.sort_key'],
          condition: "outcome === 'APPLIED' AND to_status === 'NO_SHOW' AND timestampMs >= ATTENDANCE_ACTIVATION_AT",
          aggregation: 'COUNT DISTINCT slot_id',
          periodFilter: 'slot appointmentStartMs >= period.startMs AND slot appointmentStartMs < period.endMs',
          attendanceActivationAtMs: built.activationMs,
          alreadyAppliedPolicy: 'ALREADY_APPLIED is not a new outcome and never counts'
        }
      }
    ];

    for (var i = 0; i < rateSpecs.length; i++) {
      var spec = rateSpecs[i];
      rates[spec.name] = this._rateEnvelope(spec.name, spec.numerator, built.cohortTotal, built, per, now, nowMs, spec.evidence);
    }

    return Result.ok({
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: now,
      asOfMs: nowMs,
      cohort: {
        total: built.cohortTotal,
        byPath: built.cohortByPath,
        reusedSlots: built.reusedSlots,
        reusedSlotEpisodes: built.reusedSlotEpisodes,
        unattributableRows: built.unattributableRows,
        conflicts: built.conflictsInPeriod
      },
      rates: rates,
      provenance: {
        sources: [this.SOURCES.AVAILABILITY, this.SOURCES.B6_LIFECYCLE, this.SOURCES.ATTENDANCE_AUDIT],
        readPolicy: 'one read per source per request (Result-based reporting boundaries only)',
        sourceFailure: null,
        activationMs: built.activationMs,
        activationError: built.activationError || null,
        periodSemantics: this.PERIOD_SEMANTICS,
        appointmentDayBasis: this.APPOINTMENT_DAY_BASIS
      }
    });
  },

  /**
   * Report-type convenience: the period is built via
   * ReportPeriod.periodFor(reportType, reference) — DAILY / WEEKLY
   * (Saturday-start reporting calendar) / MONTHLY, clinic-local
   * Asia/Baghdad, start inclusive / end exclusive. Delegates the whole
   * calculation to calculateRates (one read per source).
   *
   * @param {string} reportType 'DAILY' | 'WEEKLY' | 'MONTHLY'
   * @param {Date|number} [reference] instant inside the target period
   * @returns {Result} ok(report-shaped result with described period) |
   *                   fail(REPORT_TYPE_UNKNOWN | REPORT_PERIOD_INVALID |
   *                        RATE_PERIOD_INVALID | RATE_SOURCE_UNAVAILABLE)
   */
  calculateRatesForReport: function(reportType, reference) {
    var ReportPeriodRef = ReportPeriod; // call-time binding (clasp order)

    var periodResult = ReportPeriodRef.periodFor(reportType, reference);
    if (!periodResult.ok) return periodResult;
    var period = periodResult.data;

    var ratesResult = this.calculateRates({ start: period.startMs, end: period.endMs });
    if (!ratesResult.ok) return ratesResult;
    var data = ratesResult.data;

    return Result.ok({
      reportType: reportType,
      period: Object.assign(
        { startMs: period.startMs, endMs: period.endMs },
        ReportPeriodRef.describe(reportType, period)
      ),
      evaluatedAt: data.evaluatedAt,
      asOfMs: data.asOfMs,
      cohort: data.cohort,
      rates: data.rates,
      provenance: data.provenance
    });
  },

  // ═══════════════════════════════════════════════════════════
  // Internals
  // ═══════════════════════════════════════════════════════════

  /**
   * ONE read per source through the approved Result-based reporting
   * boundaries (v2 §22–§23). Any failure fails the WHOLE batch — the
   * shared denominator couples all four rates (v2 §21).
   */
  _readAllSources: function() {
    var SlotRepositoryRef = SlotRepository;                       // call-time
    var B6LifecycleRepositoryRef = B6LifecycleRepository;         // call-time
    var AttendanceAuditReadRepositoryRef = AttendanceAuditReadRepository; // call-time

    var availResult = SlotRepositoryRef.queryResult(function() { return true; });
    if (!availResult.ok) {
      return Result.fail(
        this.FAIL_CODES.RATE_SOURCE_UNAVAILABLE,
        'Required source could not be read: ' + this.SOURCES.AVAILABILITY,
        { source: this.SOURCES.AVAILABILITY, error: availResult.error }
      );
    }

    var b6Result = B6LifecycleRepositoryRef.queryResult(function() { return true; });
    if (!b6Result.ok) {
      return Result.fail(
        this.FAIL_CODES.RATE_SOURCE_UNAVAILABLE,
        'Required source could not be read: ' + this.SOURCES.B6_LIFECYCLE,
        { source: this.SOURCES.B6_LIFECYCLE, error: b6Result.error }
      );
    }

    var attResult = AttendanceAuditReadRepositoryRef.readAll();
    if (!attResult.ok) {
      return Result.fail(
        this.FAIL_CODES.RATE_SOURCE_UNAVAILABLE,
        'Required source could not be read: ' + this.SOURCES.ATTENDANCE_AUDIT,
        { source: this.SOURCES.ATTENDANCE_AUDIT, error: attResult.error }
      );
    }

    return Result.ok({
      availability: availResult.data,
      b6: b6Result.data,
      attendance: attResult.data
    });
  },

  /**
   * Builds the shared evidence model for one period (v2 §3, §8–§18).
   * Pure: no I/O, no clock, no mutation.
   */
  _buildEvidence: function(sources, per) {
    var unattributable = 0;
    var conflicts = []; // every conflict descriptor carries inPeriod

    // ── 1. Slot index (Availability) — one row per slot_id ──
    var rowsBySlotId = {};
    for (var i = 0; i < sources.availability.length; i++) {
      var row = sources.availability[i];
      var id = row.slot_id;
      if (!this._hasIdentity(id)) {
        unattributable += 1; // a row without identity anchors nothing
        continue;
      }
      if (!rowsBySlotId.hasOwnProperty(id)) rowsBySlotId[id] = [];
      rowsBySlotId[id].push(row);
    }

    var slots = [];             // single-row slots with parseable start
    var slotTime = {};          // slotId → appointmentStartMs (join key)
    var slotIdsPresent = {};    // every slot_id seen in Availability
    var duplicateSlotIds = {};  // slot_id → true (K1 candidates)
    var timeInvalidSlotIds = {}; // slot_id → true (counted once at slot level)
    var slotIds = Object.keys(rowsBySlotId);
    for (var s = 0; s < slotIds.length; s++) {
      var slotId = slotIds[s];
      var slotRows = rowsBySlotId[slotId];
      slotIdsPresent[slotId] = true;

      if (slotRows.length >= 2) {
        duplicateSlotIds[slotId] = true;
        var anyInPeriod = false;
        var anyParseable = false;
        for (var d = 0; d < slotRows.length; d++) {
          var dupMs = this._slotStartMs(slotRows[d]);
          if (dupMs === null) continue;
          anyParseable = true;
          if (dupMs >= per.startMs && dupMs < per.endMs) anyInPeriod = true;
        }
        conflicts.push({
          type: 'DUPLICATE_SLOT_ID',
          slotId: slotId,
          detail: 'Availability carries ' + slotRows.length + ' rows for one slot_id (identity ambiguity)',
          inPeriod: anyInPeriod
        });
        if (!anyParseable) unattributable += 1; // time-unattributable duplicate
        continue; // ambiguous identity — excluded from cohort construction
      }

      var startMs = this._slotStartMs(slotRows[0]);
      if (startMs === null) {
        timeInvalidSlotIds[slotId] = true;
        unattributable += 1;
        continue;
      }
      slotTime[slotId] = startMs;
      slots.push({
        slotId: slotId,
        startMs: startMs,
        status: slotRows[0].status || ''
      });
    }

    // ── 2. B6 terminal operations (structure, never chronological) ──
    var LIFECYCLE = B6LifecycleService.LIFECYCLE_STATES;          // call-time
    var CHECKPOINTS = B6LifecycleService.CHECKPOINTS;             // call-time

    var ops = {};   // opId → { opId, oldSlotIds: {}, types: {}, conflicted, inPeriod }
    var opList = [];
    var changeRowsMissingNewSlotId = 0;
    var b6 = sources.b6;
    for (var j = 0; j < b6.length; j++) {
      var r = b6[j];
      var type = null;
      if (r.lifecycle_state === LIFECYCLE.RESOLVED_CANCEL && r.checkpoint === CHECKPOINTS.TERMINAL_CANCEL_PROVEN) {
        type = 'CANCEL';
      } else if (r.lifecycle_state === LIFECYCLE.RESOLVED_CHANGE && r.checkpoint === CHECKPOINTS.TERMINAL_CHANGE_PROVEN) {
        type = 'CHANGE';
      }
      if (!type) continue; // non-terminal journal history — never counted

      if (!this._hasIdentity(r.operation_id)) { unattributable += 1; continue; }
      if (!this._hasIdentity(r.old_slot_id)) { unattributable += 1; continue; }
      if (type === 'CHANGE' && !this._hasIdentity(r.new_slot_id)) {
        changeRowsMissingNewSlotId += 1; // reference-only field; old episode stands
      }

      var op = ops[r.operation_id];
      if (!op) {
        op = { opId: r.operation_id, oldSlotIds: {}, types: {} };
        ops[r.operation_id] = op;
        opList.push(op);
      }
      op.oldSlotIds[r.old_slot_id] = true;
      op.types[type] = true;
    }

    // Operation-level identity conflicts (K4 / K5)
    for (var k = 0; k < opList.length; k++) {
      var op2 = opList[k];
      var oldIds = Object.keys(op2.oldSlotIds);
      var types = Object.keys(op2.types);
      if (oldIds.length >= 2 || types.length >= 2) {
        op2.conflicted = true;
        var opInPeriod = false;
        for (var m = 0; m < oldIds.length; m++) {
          var t = slotTime[oldIds[m]];
          if (typeof t === 'number' && t >= per.startMs && t < per.endMs) {
            opInPeriod = true;
            break;
          }
        }
        op2.inPeriod = opInPeriod;
        conflicts.push({
          type: 'OPERATION_IDENTITY_CONFLICT',
          operationId: op2.opId,
          oldSlotIds: oldIds,
          types: types,
          detail: 'One operation_id cannot release two instances or both cancel and change',
          inPeriod: opInPeriod
        });
      }
    }

    // Released episodes per slot — distinct operations, non-conflicted only
    var releasedBySlot = {}; // slotId → { cancel: n, change: n }
    for (var q = 0; q < opList.length; q++) {
      var op3 = opList[q];
      if (op3.conflicted) continue;
      var oldSlotId = Object.keys(op3.oldSlotIds)[0]; // exactly one (K4 excluded)
      var opType = Object.keys(op3.types)[0];         // exactly one (K5 excluded)
      if (slotTime.hasOwnProperty(oldSlotId)) {
        if (!releasedBySlot.hasOwnProperty(oldSlotId)) {
          releasedBySlot[oldSlotId] = { cancel: 0, change: 0 };
        }
        releasedBySlot[oldSlotId][opType === 'CANCEL' ? 'cancel' : 'change'] += 1;
      } else if (!timeInvalidSlotIds.hasOwnProperty(oldSlotId) &&
                 !duplicateSlotIds.hasOwnProperty(oldSlotId)) {
        unattributable += 1; // old_slot_id resolves to no Availability row
      }
      // time-invalid / duplicate slots were already accounted at slot level
    }

    // ── 3. Attendance evidence + M0/M1 activation boundary ──
    var attendance = sources.attendance;

    // ATTENDANCE_ACTIVATION_AT = timestamp of the FIRST APPLIED row in
    // append order (M0/M1 derived boundary — mirrored exactly, never a
    // second boundary).
    var activationMs = null;
    var activationError = null;
    var firstApplied = null;
    var firstAppliedOrder = Infinity;
    for (var a = 0; a < attendance.length; a++) {
      if (attendance[a].outcome !== 'APPLIED') continue;
      var order = this._rowOrder(attendance[a], a);
      if (order < firstAppliedOrder) {
        firstAppliedOrder = order;
        firstApplied = attendance[a];
      }
    }
    if (firstApplied !== null) {
      activationMs = this._rowMs(firstApplied.timestamp);
      if (activationMs === null) {
        activationError =
          'ATTENDANCE_ACTIVATION_AT cannot be established: the first APPLIED ' +
          'attendance audit row has an unparseable timestamp — the boundary ' +
          'is never redefined to a later row (M1 discipline)';
      }
    }

    var appliedBySlot = {}; // slotId → { COMPLETED: bool, NO_SHOW: bool }
    for (var b = 0; b < attendance.length; b++) {
      var ar = attendance[b];
      if (ar.outcome !== 'APPLIED') continue; // ALREADY_APPLIED / REJECTED_* — journal history

      if (!this._hasIdentity(ar.slot_id)) { unattributable += 1; continue; }
      if (!slotTime.hasOwnProperty(ar.slot_id)) {
        if (!timeInvalidSlotIds.hasOwnProperty(ar.slot_id) &&
            !duplicateSlotIds.hasOwnProperty(ar.slot_id)) {
          unattributable += 1; // slot row absent (or unjoined)
        }
        continue;
      }
      if (ar.to_status !== 'COMPLETED' && ar.to_status !== 'NO_SHOW') {
        unattributable += 1;
        continue;
      }
      var ats = this._rowMs(ar.timestamp);
      if (ats === null) { unattributable += 1; continue; }
      if (activationMs !== null && ats < activationMs) continue; // pre-activation (M1 filter)

      if (!appliedBySlot.hasOwnProperty(ar.slot_id)) {
        appliedBySlot[ar.slot_id] = { COMPLETED: false, NO_SHOW: false };
      }
      appliedBySlot[ar.slot_id][ar.to_status] = true;
    }

    // ── 4. Final-episode reconciliation + slot-level conflicts (K2/K3) ──
    var finalBySlot = {}; // slotId → 'STILL_CONFIRMED' | 'COMPLETED' | 'NO_SHOW' | null
    for (var p = 0; p < slots.length; p++) {
      var sl = slots[p];
      var att = appliedBySlot[sl.slotId];
      var appliedCompleted = !!(att && att.COMPLETED);
      var appliedNoShow = !!(att && att.NO_SHOW);
      var final = null;
      var inPeriod = sl.startMs >= per.startMs && sl.startMs < per.endMs;

      if (appliedCompleted && appliedNoShow) {
        conflicts.push({
          type: 'ATTENDANCE_OUTCOME_CONFLICT',
          slotId: sl.slotId,
          detail: 'APPLIED COMPLETED and APPLIED NO_SHOW both exist for one slot (absorbing states — corruption)',
          inPeriod: inPeriod
        });
      } else {
        switch (sl.status) {
          case 'CONFIRMED':
            if (appliedCompleted || appliedNoShow) {
              conflicts.push({
                type: 'APPLIED_VS_CURRENT_STATE',
                slotId: sl.slotId,
                status: sl.status,
                applied: appliedCompleted ? 'COMPLETED' : 'NO_SHOW',
                detail: 'APPLIED attendance evidence cannot coexist with a non-terminal current status (no legal path back)',
                inPeriod: inPeriod
              });
            } else {
              final = 'STILL_CONFIRMED';
            }
            break;
          case 'COMPLETED':
            if (appliedNoShow) {
              conflicts.push({
                type: 'APPLIED_VS_CURRENT_STATE',
                slotId: sl.slotId,
                status: sl.status,
                applied: 'NO_SHOW',
                detail: 'Slot is COMPLETED but APPLIED evidence says NO_SHOW',
                inPeriod: inPeriod
              });
            } else {
              final = 'COMPLETED'; // state proves the final episode (audit may be lost)
            }
            break;
          case 'NO_SHOW':
            if (appliedCompleted) {
              conflicts.push({
                type: 'APPLIED_VS_CURRENT_STATE',
                slotId: sl.slotId,
                status: sl.status,
                applied: 'COMPLETED',
                detail: 'Slot is NO_SHOW but APPLIED evidence says COMPLETED',
                inPeriod: inPeriod
              });
            } else {
              final = 'NO_SHOW';
            }
            break;
          default:
            // FREE / EXPIRED / RESERVED / CANCELLED — no live/final episode
            if (appliedCompleted || appliedNoShow) {
              conflicts.push({
                type: 'APPLIED_VS_CURRENT_STATE',
                slotId: sl.slotId,
                status: sl.status,
                applied: appliedCompleted ? 'COMPLETED' : 'NO_SHOW',
                detail: 'APPLIED attendance evidence on a slot that is no longer in the matching terminal state (manual reset or corruption)',
                inPeriod: inPeriod
              });
            }
            final = null;
            break;
        }
      }
      finalBySlot[sl.slotId] = final;
    }

    // ── 5. Period counting (appointment-day basis) ──
    var cohortTotal = 0;
    var byPath = {
      pathA_stillConfirmed: 0,
      pathB_completed: 0,
      pathC_noShow: 0,
      pathD_cancelled: 0,
      pathE_changed: 0
    };
    var cancelled = 0;
    var changed = 0;
    var completed = 0;
    var noShow = 0;
    var reusedSlots = 0;
    var reusedSlotEpisodes = 0;

    for (var c = 0; c < slots.length; c++) {
      var sp = slots[c];
      if (sp.startMs < per.startMs || sp.startMs >= per.endMs) continue;

      var rel = releasedBySlot[sp.slotId] || { cancel: 0, change: 0 };
      var fin = finalBySlot[sp.slotId];
      var episodes = rel.cancel + rel.change + (fin ? 1 : 0);
      if (episodes === 0) continue; // nothing provable for this slot in this period

      cohortTotal += episodes;
      byPath.pathD_cancelled += rel.cancel;
      byPath.pathE_changed += rel.change;
      if (fin === 'STILL_CONFIRMED') byPath.pathA_stillConfirmed += 1;
      if (fin === 'COMPLETED') byPath.pathB_completed += 1;
      if (fin === 'NO_SHOW') byPath.pathC_noShow += 1;

      cancelled += rel.cancel;
      changed += rel.change;

      var att2 = appliedBySlot[sp.slotId];
      if (fin === 'COMPLETED' && att2 && att2.COMPLETED) completed += 1;
      if (fin === 'NO_SHOW' && att2 && att2.NO_SHOW) noShow += 1;

      if (episodes >= 2) {
        reusedSlots += 1;
        reusedSlotEpisodes += episodes;
      }
    }

    var conflictsInPeriod = [];
    var outOfPeriodConflicts = 0;
    for (var f = 0; f < conflicts.length; f++) {
      if (conflicts[f].inPeriod) {
        conflictsInPeriod.push(conflicts[f]);
      } else {
        outOfPeriodConflicts += 1;
      }
    }

    return {
      cohortTotal: cohortTotal,
      cohortByPath: byPath,
      cancelled: cancelled,
      changed: changed,
      completed: completed,
      noShow: noShow,
      reusedSlots: reusedSlots,
      reusedSlotEpisodes: reusedSlotEpisodes,
      unattributableRows: unattributable,
      conflictsInPeriod: conflictsInPeriod,
      outOfPeriodConflicts: outOfPeriodConflicts,
      changeRowsMissingNewSlotId: changeRowsMissingNewSlotId,
      activationMs: activationMs,
      activationError: activationError
    };
  },

  /**
   * One rate envelope. Reason precedence:
   * RATE_EVIDENCE_INVALID (in-period conflict; unestablishable activation
   * boundary for the attendance-derived rates) > ZERO_DENOMINATOR.
   */
  _rateEnvelope: function(rateName, numerator, denominator, built, per, now, nowMs, evidence) {
    var base = {
      metric: rateName,
      period: { startMs: per.startMs, endMs: per.endMs },
      evaluatedAt: now,
      asOfMs: nowMs,
      provenance: Object.assign(
        {
          numerator: numerator,
          denominator: denominator,
          formula: 'numerator / denominator * 100',
          zeroDenominatorPolicy: 'denominator 0 → UNAVAILABLE (value null), never 0%',
          appointmentDayBasis: this.APPOINTMENT_DAY_BASIS,
          periodSemantics: this.PERIOD_SEMANTICS,
          cohortDefinition:
            'distinct provable confirmed appointment episodes: released episodes (one per DISTINCT B6 terminal operation_id per old_slot_id) plus at most one final/current episode per slot (current status reconciled with APPLIED attendance evidence)',
          cohortByPath: built.cohortByPath,
          reusedSlots: built.reusedSlots,
          reusedSlotEpisodes: built.reusedSlotEpisodes,
          unattributableRows: built.unattributableRows,
          outOfPeriodConflicts: built.outOfPeriodConflicts,
          changeRowsMissingNewSlotId: built.changeRowsMissingNewSlotId,
          sourceFailure: null,
          conflicts: built.conflictsInPeriod
        },
        { evidence: evidence }
      )
    };

    if (built.conflictsInPeriod.length > 0) {
      return Object.assign({}, base, {
        status: this.STATUS.UNAVAILABLE,
        value: null,
        reason: this.REASONS.RATE_EVIDENCE_INVALID
      });
    }

    var attendanceDerived = rateName === this.RATES.COMPLETION_RATE || rateName === this.RATES.NO_SHOW_RATE;
    if (attendanceDerived && built.activationError) {
      return Object.assign({}, base, {
        status: this.STATUS.UNAVAILABLE,
        value: null,
        reason: this.REASONS.RATE_EVIDENCE_INVALID,
        provenance: Object.assign({}, base.provenance, {
          activationBoundary: built.activationError
        })
      });
    }

    if (denominator === 0) {
      return Object.assign({}, base, {
        status: this.STATUS.UNAVAILABLE,
        value: null,
        reason: this.REASONS.ZERO_DENOMINATOR
      });
    }

    return Object.assign({}, base, {
      status: this.STATUS.AVAILABLE,
      value: (numerator / denominator) * 100,
      reason: null
    });
  },

  /**
   * Canonicalizes {start, end} (Date or epoch ms) into epoch ms with
   * uniform semantics: start inclusive, end exclusive, start < end.
   * Same discipline as M1 (METRIC_PERIOD_INVALID → RATE_PERIOD_INVALID).
   */
  _canonicalPeriod: function(period) {
    if (!period || typeof period !== 'object') {
      return Result.fail(
        this.FAIL_CODES.RATE_PERIOD_INVALID,
        'Period must be an object { start, end } of Date or epoch-ms values',
        { period: period }
      );
    }
    var startMs = this._toEpochMs(period.start);
    var endMs = this._toEpochMs(period.end);
    if (startMs === null || endMs === null) {
      return Result.fail(
        this.FAIL_CODES.RATE_PERIOD_INVALID,
        'Period start/end must be Date or finite epoch-ms values',
        { start: period.start, end: period.end }
      );
    }
    if (!(startMs < endMs)) {
      return Result.fail(
        this.FAIL_CODES.RATE_PERIOD_INVALID,
        'Period start must be strictly before end (start inclusive, end exclusive)',
        { startMs: startMs, endMs: endMs }
      );
    }
    return Result.ok({ startMs: startMs, endMs: endMs });
  },

  /** Slot start time in epoch ms from sort_key (ADR-016; clinic-local). */
  _slotStartMs: function(row) {
    var comparable = LegacySlotTimeParser.toComparableTime(row && row.sort_key);
    if (typeof comparable !== 'number' || !isFinite(comparable)) return null;
    return comparable;
  },

  /** Evidence/journal timestamp in epoch ms (Date or finite number). */
  _rowMs: function(value) {
    return this._toEpochMs(value);
  },

  /** Append-order key for evidence rows (sheet row order). */
  _rowOrder: function(row, arrayIndex) {
    var n = Number(row && row._rowNumber);
    if (typeof n === 'number' && isFinite(n) && n > 0) return n;
    return arrayIndex;
  },

  /** A valid business identity key for counting/joining. */
  _hasIdentity: function(value) {
    return typeof value === 'string' && value.trim() !== '';
  },

  /** Date → epoch ms; finite number → as-is; anything else → null. */
  _toEpochMs: function(value) {
    if (value instanceof Date) {
      var ms = value.getTime();
      return isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number' && isFinite(value)) return value;
    return null;
  }
};
