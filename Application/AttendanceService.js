/**
 * AttendanceService — M0 (PHASE 1.1 — MANAGEMENT INTELLIGENCE)
 *
 * The trusted application boundary for human attendance capture.
 *
 *   Google Calendar Event (via Calendar Add-on)
 *     → trusted operator context + calendar event identity
 *       → AttendanceService.markCompleted(context) / markNoShow(context)
 *         → StateMachine transition (CAS-004 — the only source of slot transitions)
 *           → SlotRepository.atomicUpdate (ScriptLock + fresh re-read)
 *             → Availability status COMPLETED | NO_SHOW
 *
 * M0 contract:
 *   - Exactly two explicit decisions: MARK_COMPLETED, MARK_NO_SHOW.
 *     Free-form status strings are rejected before any side effect.
 *   - The only permitted slot transitions are the ones already defined in
 *     StateMachine: CONFIRMED → COMPLETED (CompleteAppointment) and
 *     CONFIRMED → NO_SHOW (MarkNoShow). This service never assigns a slot
 *     status directly; every decision goes through Validators.validateTransition
 *     (→ StateMachine) inside SlotRepository.atomicUpdate.
 *   - Operator trust boundary (M0 remediation): the context envelope
 *     carries TWO separate inputs —
 *       operator:   { operatorId }  — the Google user identity
 *                     (resolved server-side by the add-on from Session)
 *       deployment: { trustedOperatorEmail } — the deployment trust
 *                     policy (Script Property ATTENDANCE_OPERATOR_EMAIL,
 *                     set by the owner at deploy time)
 *     The identity alone is NOT authorization. This service derives the
 *     authority: the operator is authorized (and derives
 *     authorityType 'DOCTOR') if and only if the deployment policy is
 *     configured and the identity matches it exactly. This is the
 *     "trusted single-doctor deployment" boundary (documented M0
 *     decision). No authentication system is built; multi-operator
 *     support is a future Doctor Dashboard milestone. Calendar access
 *     alone is NOT business authorization; anonymous operations and
 *     untrusted identities are rejected before any storage read.
 *   - Event → appointment correlation uses a stable identifier only:
 *     the slot row's calendar_event_id must match the supplied eventId
 *     exactly once. Patient name, event title, and time are never
 *     correlation keys.
 *   - Idempotency: if the slot is already in the decision's target state,
 *     the operation is a deterministic no-op — Result.ok with
 *     { applied: false, alreadyApplied: true }, no cell write, no second
 *     attendance record. The audit trail marks it ALREADY_APPLIED.
 *   - Concurrency: the state decision executes inside
 *     SlotRepository.atomicUpdate (Lock.runExclusive → fresh re-read →
 *     transition check → single write). Two conflicting decisions for the
 *     same appointment can never both succeed; the loser re-reads the fresh
 *     terminal state and fails with INVALID_TRANSITION, or is rejected with
 *     LOCK_TIMEOUT while the winner holds the lock. Last-writer-wins is
 *     impossible on this path.
 *   - Audit: every decision that reaches the locked slot is recorded in the
 *     append-only ATTENDANCE_AUDIT store (operatorId, eventId, calendarId,
 *     slotId, decision, from/to status, outcome, timestamp).
 *     AttendanceAuditRepository is evidence, NOT the Availability source of
 *     truth, and it is append-only (no reads or deletes here).
 *   - Failure semantics: every failure is an explicit Result.fail with a
 *     stable code. A persistence or lock failure can never produce a false
 *     COMPLETED / NO_SHOW, and exceptions are never swallowed into success.
 *
 * Activation boundary (for M1 reporting): the timestamp of the first
 * APPLIED audit row is the official ATTENDANCE_ACTIVATION_AT. Before it,
 * there are no official attendance metrics; after it, APPLIED rows are the
 * official attendance data. No permanent setting is introduced by M0.
 */
const AttendanceService = {

  DECISIONS: {
    MARK_COMPLETED: 'MARK_COMPLETED',
    MARK_NO_SHOW: 'MARK_NO_SHOW'
  },

  /**
   * The authority label DERIVED (not claimed) when the operator identity
   * is validated against the deployment trust policy.
   */
  OPERATOR_AUTHORITY: 'DOCTOR',

  /**
   * Mapping from attendance decision → existing StateMachine command and
   * existing vocabulary target status. No new command or status is
   * introduced; Config.VOCABULARY is untouched.
   *
   * RESOLVED LAZILY (at call time, inside functions) — deliberately NOT as
   * top-level object-initializer values. The Apps Script V8 runtime
   * evaluates project files in the project's file order; in clasp-pushed
   * projects that order is alphabetical, which places
   * Application/AttendanceService.js BEFORE Config.js. A top-level
   * reference to `Config` would then hit a not-yet-evaluated binding
   * (ReferenceError at add-on runtime). Resolving inside functions means
   * every file has been evaluated before any attendance call executes, so
   * the service is independent of project file order.
   */
  _decisionCommand: function(decision) {
    // Closed set: only the two explicit decisions map to commands.
    if (decision === AttendanceService.DECISIONS.MARK_COMPLETED) {
      return Config.VOCABULARY.COMMANDS.COMPLETE_APPOINTMENT;
    }
    if (decision === AttendanceService.DECISIONS.MARK_NO_SHOW) {
      return Config.VOCABULARY.COMMANDS.MARK_NO_SHOW;
    }
    return null;
  },

  _decisionTarget: function(decision) {
    // Closed set: only the two explicit decisions map to target statuses.
    if (decision === AttendanceService.DECISIONS.MARK_COMPLETED) {
      return Config.VOCABULARY.STATUS.COMPLETED;
    }
    if (decision === AttendanceService.DECISIONS.MARK_NO_SHOW) {
      return Config.VOCABULARY.STATUS.NO_SHOW;
    }
    return null;
  },

  _AUDIT_OUTCOMES: {
    APPLIED: 'APPLIED',
    ALREADY_APPLIED: 'ALREADY_APPLIED',
    REJECTED_INVALID_TRANSITION: 'REJECTED_INVALID_TRANSITION',
    REJECTED_CORRELATION_LOST: 'REJECTED_CORRELATION_LOST'
  },

  /**
   * MARK_COMPLETED — CONFIRMED → COMPLETED.
   * @param {{operator: {operatorId: string},
   *          deployment: {trustedOperatorEmail: string},
   *          calendarEvent: {eventId: string, calendarId?: string}}} context
   * @returns {Result}
   */
  markCompleted: function(context) {
    return this._applyAttendance(this.DECISIONS.MARK_COMPLETED, context);
  },

  /**
   * MARK_NO_SHOW — CONFIRMED → NO_SHOW.
   * @returns {Result}
   */
  markNoShow: function(context) {
    return this._applyAttendance(this.DECISIONS.MARK_NO_SHOW, context);
  },

  /**
   * Single decision pipeline (shared by both public entry points):
   *   validate operator → validate event identity → correlate slot
   *   → atomic decision under ScriptLock → audit → Result
   */
  _applyAttendance: function(decision, context) {
    var logCommand = 'ATTENDANCE_' + decision;

    // 1) Explicit decision only — no free-form status accepted.
    var command = this._decisionCommand(decision);
    var target = this._decisionTarget(decision);
    if (!command || !target) {
      return Result.fail(
        'ATTENDANCE_DECISION_INVALID',
        'Only MARK_COMPLETED and MARK_NO_SHOW are accepted attendance decisions',
        { decision: decision }
      );
    }

    // 2) Operator trust boundary — before ANY storage access.
    //    Identity (who) + deployment policy (who is trusted) are separate
    //    inputs; the authority is DERIVED here, never claimed by a caller.
    var operatorCheck = this._validateOperator(context);
    if (!operatorCheck.ok) {
      this._diagnostic(logCommand, '', operatorCheck, null, null);
      return operatorCheck;
    }
    var operator = operatorCheck.data;

    // 3) Calendar event identity (stable identifier only).
    var eventCheck = this._validateEventContext(context);
    if (!eventCheck.ok) {
      this._diagnostic(logCommand, '', eventCheck, operator, null);
      return eventCheck;
    }
    var event = eventCheck.data;

    // 4) Correlation: exactly one slot row carries this calendar event id.
    var correlation = SlotRepository.queryResult(function(row) {
      return row.calendar_event_id === event.eventId;
    });
    if (!correlation.ok) {
      this._diagnostic(logCommand, '', correlation, operator, event);
      return Result.fail(
        'ATTENDANCE_CORRELATION_READ_FAILED',
        'Failed to read authoritative availability for event correlation',
        {
          decision: decision,
          operatorId: operator.operatorId,
          calendarEventId: event.eventId,
          error: correlation.error
        }
      );
    }
    if (correlation.data.length === 0) {
      this._diagnostic(logCommand, '', correlation, operator, event);
      return Result.fail(
        'ATTENDANCE_EVENT_NOT_CORRELATED',
        'Calendar event is not correlated with any HAMZAWE appointment',
        {
          decision: decision,
          operatorId: operator.operatorId,
          calendarEventId: event.eventId,
          matchCount: 0
        }
      );
    }
    if (correlation.data.length > 1) {
      this._diagnostic(logCommand, '', correlation, operator, event);
      return Result.fail(
        'ATTENDANCE_EVENT_AMBIGUOUS',
        'Calendar event is correlated with more than one slot row',
        {
          decision: decision,
          operatorId: operator.operatorId,
          calendarEventId: event.eventId,
          matchCount: correlation.data.length
        }
      );
    }

    var slotId = correlation.data[0].slot_id;

    // 5) Atomic decision: ScriptLock → fresh re-read → identity re-check →
    //    StateMachine transition → single write. Closure variables capture
    //    the under-lock observation for the audit trail and the Result.
    var outcome = null;
    var freshStatus = null;
    var updateResult = SlotRepository.atomicUpdate(slotId, function(freshSlot) {
      freshStatus = freshSlot.status;

      // Identity re-verification under the lock (TOCTOU guard): the fresh
      // row must still carry exactly this calendar event.
      if (freshSlot.calendar_event_id !== event.eventId) {
        return Result.fail(
          'ATTENDANCE_EVENT_CORRELATION_LOST',
          'Slot no longer carries the supplied calendar event identity',
          { slotId: slotId, calendarEventId: event.eventId, freshStatus: freshSlot.status }
        );
      }

      // Idempotency: already in the decision's target state → verified
      // no-op. An empty patch writes zero cells (see
      // GoogleSheets.updateRowByColumn); nothing is duplicated.
      if (freshSlot.status === target) {
        outcome = AttendanceService._AUDIT_OUTCOMES.ALREADY_APPLIED;
        return Result.ok({});
      }

      // The only source of truth for the transition (CAS-004).
      var transition = Validators.validateTransition(freshSlot.status, command);
      if (!transition.ok) return transition;

      outcome = AttendanceService._AUDIT_OUTCOMES.APPLIED;
      return Result.ok({ status: target });
    });

    // 6) Rejected decision — explicit failure, never converted to success.
    if (!updateResult.ok) {
      var code = updateResult.error ? updateResult.error.code : 'UNEXPECTED_ERROR';

      // Audit only the rejections observed on the fresh row under the lock.
      // Failures outside the verified state (SLOT_NOT_FOUND, UPDATE_FAILED,
      // LOCK_TIMEOUT, UNEXPECTED_ERROR) produce a diagnostic log only.
      var auditRecorded = false;
      var auditFailure = null;
      if (code === 'INVALID_TRANSITION' || code === 'ATTENDANCE_EVENT_CORRELATION_LOST') {
        var auditResult = AttendanceAuditRepository.append({
          operator_id: operator.operatorId,
          calendar_event_id: event.eventId,
          calendar_id: event.calendarId,
          slot_id: slotId,
          decision: decision,
          from_status: freshStatus || '',
          to_status: '',
          outcome: code === 'INVALID_TRANSITION'
            ? AttendanceService._AUDIT_OUTCOMES.REJECTED_INVALID_TRANSITION
            : AttendanceService._AUDIT_OUTCOMES.REJECTED_CORRELATION_LOST,
          error_code: code
        });
        auditRecorded = auditResult.ok;
        if (!auditResult.ok) {
          // Evidence write failed; the rejection itself still stands.
          auditFailure = auditResult.error;
        }
      }

      var failure = Result.fail(
        code,
        updateResult.error ? updateResult.error.message : 'Attendance decision failed',
        {
          decision: decision,
          operatorId: operator.operatorId,
          calendarEventId: event.eventId,
          slotId: slotId,
          fromStatus: freshStatus || null,
          auditRecorded: auditRecorded
        }
      );
      AttendanceService._diagnostic(logCommand, slotId, failure, operator, event, {
        auditFailure: auditFailure
      });
      return failure;
    }

    // 7) Success paths (APPLIED / ALREADY_APPLIED) — audit after the
    //    verified outcome. Audit evidence never rewrites availability.
    var successAudit = AttendanceAuditRepository.append({
      operator_id: operator.operatorId,
      calendar_event_id: event.eventId,
      calendar_id: event.calendarId,
      slot_id: slotId,
      decision: decision,
      from_status: outcome === AttendanceService._AUDIT_OUTCOMES.ALREADY_APPLIED ? target : (freshStatus || ''),
      to_status: target,
      outcome: outcome,
      error_code: ''
    });

    var success = Result.ok({
      applied: outcome === AttendanceService._AUDIT_OUTCOMES.APPLIED,
      alreadyApplied: outcome === AttendanceService._AUDIT_OUTCOMES.ALREADY_APPLIED,
      decision: decision,
      slotId: slotId,
      fromStatus: freshStatus || null,
      status: target,
      operatorId: operator.operatorId,
      authorizedAs: operator.authorityType,
      calendarEventId: event.eventId,
      calendarId: event.calendarId,
      auditRecorded: successAudit.ok
    });

    AttendanceService._diagnostic(logCommand, slotId, success, operator, event, {
      auditFailure: successAudit.ok ? null : successAudit.error
    });
    return success;
  },

  /**
   * Operator trust boundary (derived authority — trusted single-doctor
   * deployment). Inputs are deliberately separate:
   *   - operator.identity: the Google user identity (WHO acted)
   *   - deployment policy: the configured trusted operator (WHO is trusted)
   * The authority label 'DOCTOR' is DERIVED only when the policy is
   * configured and the identity matches it exactly (trimmed, exact).
   * No caller can claim authority; Calendar access alone is not
   * authorization. Fails before any storage read.
   */
  _validateOperator: function(context) {
    if (!context || typeof context !== 'object') {
      return Result.fail(
        'ATTENDANCE_CONTEXT_INVALID',
        'Attendance context is required',
        null
      );
    }

    // 1) Identity (who) — anonymous operations are rejected.
    var operator = context.operator;
    if (!operator || typeof operator !== 'object') {
      return Result.fail(
        'ATTENDANCE_OPERATOR_INVALID',
        'Operator identity context is required',
        null
      );
    }
    if (typeof operator.operatorId !== 'string' || operator.operatorId.trim() === '') {
      return Result.fail(
        'ATTENDANCE_OPERATOR_INVALID',
        'operatorId is required — anonymous attendance operations are not permitted',
        null
      );
    }
    var operatorId = operator.operatorId.trim();

    // 2) Deployment trust policy (who is trusted).
    var deployment = context.deployment;
    var trustedEmail = deployment && typeof deployment.trustedOperatorEmail === 'string'
      ? deployment.trustedOperatorEmail.trim()
      : '';
    if (!trustedEmail) {
      return Result.fail(
        'ATTENDANCE_TRUST_POLICY_UNCONFIGURED',
        'The ATTENDANCE_OPERATOR_EMAIL deployment property is not configured — attendance capture is disabled until the owner configures it',
        null
      );
    }

    // 3) Authorization decision: identity must match the configured
    //    trusted operator exactly. Mismatch is an explicit failure, never
    //    a silent downgrade.
    if (operatorId !== trustedEmail) {
      return Result.fail(
        'ATTENDANCE_OPERATOR_UNAUTHORIZED',
        'Operator identity is not the configured trusted operator for this deployment',
        { operatorId: operatorId }
      );
    }

    // 4) Authority DERIVED from the validated identity + policy.
    return Result.ok({
      operatorId: operatorId,
      authorityType: AttendanceService.OPERATOR_AUTHORITY
    });
  },

  /**
   * Calendar event identity validation. Only stable identifiers are
   * accepted; the event title is never part of the contract.
   */
  _validateEventContext: function(context) {
    var event = context.calendarEvent;
    if (!event || typeof event !== 'object') {
      return Result.fail(
        'ATTENDANCE_EVENT_CONTEXT_INVALID',
        'calendarEvent context is required',
        null
      );
    }
    if (typeof event.eventId !== 'string' || event.eventId.trim() === '') {
      return Result.fail(
        'ATTENDANCE_EVENT_CONTEXT_INVALID',
        'calendarEvent.eventId (stable identifier) is required',
        null
      );
    }
    var calendarId = typeof event.calendarId === 'string' ? event.calendarId.trim() : '';
    return Result.ok({ eventId: event.eventId.trim(), calendarId: calendarId });
  },

  /**
   * Diagnostic-only log (SYSTEM_LOG is never a source of truth).
   * Carries operation, event identity, slot identity, operator identity,
   * decision, and result — without patient PII.
   */
  _diagnostic: function(logCommand, slotId, result, operator, event, extra) {
    try {
      var details = {
        decision: logCommand,
        operatorId: operator ? operator.operatorId : '',
        calendarEventId: event ? event.eventId : '',
        outcome: result && result.ok ? (result.data ? (result.data.applied ? 'APPLIED' : 'ALREADY_APPLIED') : 'OK') : (result && result.error ? result.error.code : 'UNKNOWN'),
        auditRecorded: result && result.ok && result.data ? (result.data.auditRecorded === true) : null
      };
      if (extra) {
        Object.keys(extra).forEach(function(key) {
          if (extra[key] !== null && extra[key] !== undefined) details[key] = extra[key];
        });
      }
      LogRepository.write({
        timestamp: Clock.now(),
        command: logCommand,
        phone: '',
        slotId: slotId || '',
        stage: 'END',
        success: !!(result && result.ok),
        durationMs: null,
        error: JSON.stringify(details)
      });
    } catch (e) {
      // Diagnostics must never alter the attendance outcome.
    }
  }
};
