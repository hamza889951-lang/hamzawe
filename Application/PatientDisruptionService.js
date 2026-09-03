/**
 * ═══════════════════════════════════════════════════════════════════════
 * CONTRACT — PatientDisruptionService (M4-F)
 * ═══════════════════════════════════════════════════════════════════════
 * HAMZAWE M4-F — Patient Disruption / Recovery.
 * Governed by: HAMZAWE_M4F_FROZEN_CONTRACT_v1_2026-09-03.md
 *              + HAMZAWE_M4F_CONTRACT_CLOSURE_ADDENDUM_v1.1_2026-09-03.md
 *
 * This is the ONE new application business boundary introduced by M4-F.
 *
 * GUARANTEES
 * - Consumes M4-E evidence as STALE-ABLE evidence only. Every mutation is
 *   preceded by a fresh read of the original slot, the proposal target slot,
 *   the Conversation proposal, and Clock.now().
 * - Candidate selection is delegated to the existing SlotSelection boundary
 *   (bounded to the clinic-day horizon). No selection policy lives here.
 * - Slot status transitions are delegated to StateMachine via
 *   Validators.validateTransition inside SlotRepository.atomicUpdate().
 * - Confirmed-appointment replacement is delegated to the existing
 *   ChangeService boundary (B6 + Calendar + patient-retention-first).
 * - Pre-confirmation (RESERVED) finalization reuses the existing booking
 *   appointment-finalization seam, including Calendar creation AFTER explicit
 *   confirmation.
 * - WhatsApp delivery goes through an injected send callback; this file never
 *   touches UrlFetchApp or provider details.
 * - Every business function returns Result. Failures are explicitly
 *   classified; nothing collapses into SLOT_NOT_FOUND or empty success.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SERIALIZATION MODEL — implementation finding (Closure Addendum §3)
 * ═══════════════════════════════════════════════════════════════════════
 * The addendum requires a bounded per-phone disruption serialization
 * mechanism. This implementation uses the EXISTING primitive
 * `Lock.runExclusive('disruption:' + phone, …)` — no second scheduler, state
 * machine or persistence engine is introduced.
 *
 * The critical constraint discovered during implementation is that
 * `Lock.runExclusive` backs onto the SAME global ScriptLock instance that
 * `SlotRepository.atomicUpdate()` acquires, and this project defines a nested
 * acquisition of that instance as CONTENTION, not reentrancy:
 *   - HardeningM0 / M0-E1 asserts that a second runExclusive issued while the
 *     first still holds the lock returns LOCK_TIMEOUT ("exactly one wins").
 *   - PROJECT_CONTEXT §11 records Apps Script ScriptLock reentrancy as
 *     UNVERIFIED (P2).
 * Therefore a per-phone lock MUST NOT be held across a slot mutation. The
 * critical section is consequently split:
 *
 *   Phase 1  [keyed lock, no slot mutation]  validate affected appointment,
 *                                            choose candidate
 *   Phase 2  [no outer lock]                 atomicUpdate(candidate) → RESERVED
 *   Phase 3  [keyed lock, no slot mutation]  re-verify + persist proposal
 *   Phase 4  [no lock]                       notify (never under lock)
 *
 * Durability of the reserve→persist window is closed by the Phase-3 guard:
 * the proposal is persisted only while (a) no proposal is pending and (b) the
 * original appointment still matches the Phase-1 snapshot. Otherwise the
 * reserved candidate is released and the outcome is an explicit refusal.
 *
 * The inbound response path holds the keyed lock only around the bounded
 * Conversation reads/writes — never around a slot mutation — and relies on
 * atomicUpdate ownership/transition checks for slot safety. This is why a
 * duplicate confirmation can never create a second appointment.
 *
 * The lock is never held during the 30-minute patient wait and never across
 * WhatsApp I/O.
 *
 * HARD BOUNDARIES — this file does NOT and MUST NOT:
 * - recompute EffectiveSchedule or read ScheduleChange records;
 * - mutate `is_available` (M4-D owns it);
 * - introduce a new Slot status;
 * - bypass StateMachine or SlotRepository.atomicUpdate();
 * - create a Calendar event before explicit patient confirmation;
 * - hold B6 ownership while waiting for the patient;
 * - become a second selector, lifecycle, scheduler, gateway, conversation
 *   engine, or appointment entity;
 * - write an unbounded journal or store patient transcripts.
 *
 * DEPENDENCIES (Application layer, per CAS)
 *   Result, Config, Clock, Utils/DateUtils, Utils/LegacySlotTimeParser,
 *   Utils/IdGenerator, Utils/PhoneUtils, Domain/Validators,
 *   Repositories/SlotRepository, ConversationRepository,
 *   Application/AffectedAppointmentDiscoveryService, SlotSelection,
 *   ChangeService, Application/BookingService (finalization seam),
 *   Infrastructure/Lock, LogRepository (diagnostics only).
 */

const PatientDisruptionService = {

  // ─── Bounded vocabulary ───────────────────────────────────────────────
  NOTIFICATION: {
    PENDING: 'PENDING',
    SENT: 'SENT',
    FAILED: 'FAILED'
  },

  // Diagnostics vocabulary (Contract §17). Observability only.
  LOG: {
    PROPOSAL_CREATED: 'M4F_PROPOSAL_CREATED',
    NOTIFICATION_SENT: 'M4F_NOTIFICATION_SENT',
    NOTIFICATION_FAILED: 'M4F_NOTIFICATION_FAILED',
    PROPOSAL_CONFIRMED: 'M4F_PROPOSAL_CONFIRMED',
    PROPOSAL_DECLINED: 'M4F_PROPOSAL_DECLINED',
    PROPOSAL_EXPIRED: 'M4F_PROPOSAL_EXPIRED',
    CANDIDATE_RACE: 'M4F_CANDIDATE_RACE',
    ORIGINAL_RACE: 'M4F_ORIGINAL_RACE',
    NO_ALTERNATIVE: 'M4F_NO_ALTERNATIVE',
    B6_RECOVERY_REQUIRED: 'M4F_B6_RECOVERY_REQUIRED',
    RECOVERY_REQUIRED: 'M4F_PROPOSAL_CLEANUP_REQUIRED',
    RECOVERY_STALE_ABORTED: 'M4F_RECOVERY_STALE_ABORTED'
  },

  /**
   * Patient response vocabulary. Semantics are frozen (explicit confirmation
   * required); accepted tokens are presentation-level and mirror the
   * vocabulary the ordinary booking flow already accepts.
   */
  CONFIRM_KEYWORDS: ['1', 'تأكيد', 'تاكيد', 'نعم', 'confirm', 'yes', 'y', 'ok'],
  DECLINE_KEYWORDS: ['2', 'لا', 'رفض', 'إلغاء', 'الغاء', 'decline', 'no', 'n', 'cancel'],

  /**
   * Retryable notification states (Addendum §5, M4F-64).
   * FAILED  — a send attempt completed and failed.
   * PENDING — durable proposal exists but notification bookkeeping never
   *           completed (crash / interrupted run). Classified as retry
   *           UNCERTAINTY, never as permission for a second proposal.
   */
  RETRYABLE_NOTIFICATION_STATES: ['FAILED', 'PENDING'],

  /** Fields compared between Phase 1 and Phase 3 to detect a stale original. */
  ORIGINAL_SNAPSHOT_FIELDS: ['status', 'phone', 'is_available', 'reserved_until_unix', 'calendar_event_id'],

  // ═════════════════════════════════════════════════════════════════════
  // SCHEDULER STAGE
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Patient Disruption Processing stage (Contract §9). Runs after
   * Availability/Horizon materialization and before Reminders, inside the
   * existing single Scheduler. Retry-safe and idempotent.
   *
   * @param {Object} [options]
   * @param {Function} [options.sendFn] - (phone, text) => Result
   * @returns {Result} ok(summary) | fail('M4F_SOURCE_UNAVAILABLE')
   */
  processDisruptions: function(options) {
    const opts = (options !== null && typeof options === 'object') ? options : {};

    // The send callback is injected by the caller (the Scheduler, exactly as
    // it already does for Reminders). The Application layer therefore holds no
    // reference to the WhatsApp provider at all (CAS-001 / ADR-007), and there
    // is no second gateway seam.
    if (typeof opts.sendFn !== 'function') {
      return Result.fail(
        'M4F_INVALID_REQUEST',
        'Patient Disruption Processing requires an injected send callback'
      );
    }
    const sendFn = opts.sendFn;

    const startedAt = Clock.now();
    const now = startedAt;

    const summary = {
      evaluatedAt: now.toISOString(),
      evaluatedAtMs: now.getTime(),
      expired: [],
      created: [],
      notified: [],
      noAlternative: [],
      skipped: [],
      failures: []
    };

    // ── 1a. Recovery sweep ───────────────────────────────────────────────
    // Complete confirmations that were interrupted before the original
    // reservation could be released (finding #1). Runs before the timeout
    // sweep so a recovered proposal is never expired underneath.
    const recoverySweep = this._recoverPendingFinalizations();
    if (!recoverySweep.ok) {
      summary.failures.push({
        scope: 'RECOVERY_SWEEP',
        code: recoverySweep.error ? recoverySweep.error.code : 'UNKNOWN',
        message: recoverySweep.error ? recoverySweep.error.message : 'Recovery sweep failed'
      });
    } else {
      summary.recovered = recoverySweep.data;
    }

    // ── 1b. Timeout sweep ────────────────────────────────────────────────
    const expirySweep = this._expirePendingProposals(now);
    const expiredPhones = {};
    if (!expirySweep.ok) {
      summary.failures.push({
        scope: 'EXPIRY_SWEEP',
        code: expirySweep.error ? expirySweep.error.code : 'UNKNOWN',
        message: expirySweep.error ? expirySweep.error.message : 'Expiry sweep failed'
      });
    } else {
      summary.expired = expirySweep.data;
      // A proposal that expired in THIS run is not immediately re-offered to
      // the same patient in the same run: expiry exists so the patient is not
      // repeatedly notified about the same disruption. A later, independently
      // evaluated disruption event may propose again (Contract §8).
      summary.expired.forEach(function(entry) { expiredPhones[entry.phone] = true; });
    }

    // ── 2. Fresh evidence from M4-E ─────────────────────────────────────
    const windowDays = Config.SYSTEM_POLICY.DISRUPTION_DISCOVERY_WINDOW_DAYS;
    // Bounds are passed as epoch ms: M4-E validates them with
    // `value instanceof Date`, and a Date instance is the one value type that
    // does not survive a realm boundary.
    const discovery = AffectedAppointmentDiscoveryService.discoverAffected({
      from: now.getTime(),
      to: DateUtils.addMinutes(now, windowDays * 1440).getTime()
    });

    if (!discovery.ok) {
      // Source failure must never be reported as "no affected patients".
      return Result.fail(
        'M4F_SOURCE_UNAVAILABLE',
        'Disruption discovery source is unavailable; no disruption statement can be made',
        { cause: discovery.error, evaluatedAtMs: now.getTime() }
      );
    }

    // ── 3. CONFIRMED before RESERVED (Contract §2.2) ────────────────────
    const ordered = discovery.data.affectedConfirmed.concat(discovery.data.affectedReserved);
    const handledPhones = {};

    for (let i = 0; i < ordered.length; i++) {
      const item = ordered[i];

      // M4-E is PII-free by design; the phone is re-read here, at the
      // communication/mutation boundary only (Contract §11).
      const readResult = SlotRepository.findByIdResult(item.slotId);
      if (!readResult.ok) {
        summary.failures.push({
          slotId: item.slotId,
          code: readResult.error ? readResult.error.code : 'SLOT_READ_FAILED',
          message: readResult.error ? readResult.error.message : 'Original slot read failed'
        });
        continue;
      }
      const slot = readResult.data;
      if (!slot || !slot.phone) {
        summary.failures.push({
          slotId: item.slotId,
          code: 'M4F_STALE_ORIGINAL',
          message: 'Affected appointment no longer maps to a patient phone'
        });
        continue;
      }

      const phone = slot.phone;

      // One active booking per phone ⇒ at most one proposal per phone
      // (Contract §2.7, M4F-04, M4F-05). A phone whose proposal expired in
      // this run is also skipped, so expiry is not immediately undone.
      if (expiredPhones[phone]) {
        summary.skipped.push({ phone: phone, slotId: item.slotId, reason: 'PROPOSAL_EXPIRED_THIS_RUN' });
        continue;
      }
      if (handledPhones[phone]) {
        summary.skipped.push({ phone: phone, slotId: item.slotId, reason: 'PHONE_ALREADY_HANDLED' });
        continue;
      }
      handledPhones[phone] = true;

      const sessionResult = this._readSession(phone);
      if (!sessionResult.ok) {
        summary.failures.push({
          phone: phone,
          slotId: item.slotId,
          code: sessionResult.error ? sessionResult.error.code : 'DISRUPTION_SESSION_READ_FAILED',
          message: sessionResult.error ? sessionResult.error.message : 'Disruption session read failed'
        });
        continue;
      }

      if (sessionResult.data.pending) {
        // Never a second proposal. At most a bounded notification retry that
        // reuses the same proposal identity (Addendum §5, M4F-63).
        const retry = this._retryNotificationIfNeeded(phone, sessionResult.data, now, sendFn);
        summary.skipped.push({
          phone: phone,
          slotId: item.slotId,
          reason: 'M4F_PENDING_PROPOSAL_EXISTS',
          proposalId: sessionResult.data.proposal.disruption_proposal_id,
          notification: retry
        });
        continue;
      }

      const created = this._createProposal(phone, slot, now, sendFn);

      if (!created.ok) {
        summary.failures.push({
          phone: phone,
          slotId: item.slotId,
          code: created.error ? created.error.code : 'UNKNOWN',
          message: created.error ? created.error.message : 'Proposal creation failed'
        });
        continue;
      }

      if (created.data.outcome === 'NO_ALTERNATIVE') {
        summary.noAlternative.push({
          phone: phone,
          slotId: item.slotId,
          notification: created.data.notification
        });
        continue;
      }

      summary.created.push({
        phone: phone,
        originalSlotId: created.data.proposal.disruption_original_slot_id,
        proposalSlotId: created.data.proposal.disruption_proposal_slot_id,
        proposalId: created.data.proposal.disruption_proposal_id,
        kind: created.data.proposal.disruption_kind,
        expiresAtMs: created.data.proposal.disruption_expires_at_ms
      });
      summary.notified.push({
        phone: phone,
        proposalId: created.data.proposal.disruption_proposal_id,
        status: created.data.notification ? created.data.notification.status : 'UNKNOWN'
      });
    }

    summary.durationMs = Clock.now().getTime() - startedAt.getTime();

    // A missing Conversations schema is a deployment fault, not a row-level
    // outcome: it must be surfaced as a stage failure, never reported as a
    // successful run that simply found nothing to do.
    const schemaMissing = summary.failures.filter(function(f) {
      return f.code === 'M4F_SCHEMA_MISSING';
    });
    if (schemaMissing.length) {
      return Result.fail(
        'M4F_SCHEMA_MISSING',
        'M4-F Conversations schema is not provisioned; disruption processing is disabled until it is',
        { occurrences: schemaMissing }
      );
    }

    this._log(this.LOG.PROPOSAL_CREATED, '', null, true, {
      created: summary.created.length,
      expired: summary.expired.length,
      noAlternative: summary.noAlternative.length,
      failures: summary.failures.length
    });

    return Result.ok(summary);
  },

  // ═════════════════════════════════════════════════════════════════════
  // PATIENT RESPONSE (Router hand-off — Contract §10)
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Handles an inbound patient message while the conversation is in
   * WAITING_DISRUPTION_CONFIRMATION. Owns the disruption interaction
   * semantics; the Router only routes here.
   *
   * @param {string} phone
   * @param {string} message
   * @returns {Result} ok({ reply, conversationState })
   */
  handleIncomingMessage: function(phone, message) {
    return this._handle(PhoneUtils.normalize(phone), message);
  },

  _handle: function(phone, message) {
    const now = Clock.now();
    const sessionResult = this._readSession(phone);
    if (!sessionResult.ok) return sessionResult;

    const session = sessionResult.data;
    const disruptionState = Config.VOCABULARY.CONVERSATION_STATE.WAITING_DISRUPTION_CONFIRMATION;

    // No durable pending proposal → nothing to confirm or decline. Repair the
    // interaction state so the patient is never trapped in a pending state
    // that has no proposal behind it.
    if (!session.pending) {
      if (session.exists && session.state === disruptionState) {
        const repaired = this._clearSession(
          phone,
          Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
        );
        if (!repaired.ok) return repaired;
      }
      return Result.ok({
        reply: 'لا يوجد عرض موعد بديل قيد الانتظار حالياً.',
        conversationState: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
      });
    }

    const proposal = session.proposal;
    const expiresAtMs = Number(proposal.disruption_expires_at_ms);

    // ── Expired response (Contract §5.4) ────────────────────────────────
    if (!isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
      const expired = this._expire(phone, proposal, now);
      if (!expired.ok) {
        return Result.ok({
          reply: 'تعذّر تحديث عرض الموعد البديل حالياً. الرجاء المحاولة بعد قليل.',
          conversationState: disruptionState
        });
      }
      return Result.ok({
        reply: 'انتهت صلاحية الموعد البديل المقترح. لم يتم تغيير موعدك.',
        conversationState: expired.data.nextState,
        expired: true
      });
    }

    const normalizedMessage = String(message === undefined || message === null ? '' : message).trim();

    if (this._isConfirmation(normalizedMessage)) {
      const confirmed = this._confirm(phone, proposal, now);
      if (!confirmed.ok) return this._replyForFailure(confirmed, disruptionState, 'confirmation');
      return confirmed;
    }

    if (this._isDecline(normalizedMessage)) {
      const declined = this._decline(phone, proposal);
      if (!declined.ok) return this._replyForFailure(declined, disruptionState, 'decline');
      return declined;
    }

    // ── Invalid / unknown response (Contract §5.3) ──────────────────────
    // No mutation; the proposal stays pending while unexpired.
    return Result.ok({
      reply: 'الرجاء اختيار أحد الخيارين:\n' +
             '١️⃣ تأكيد الموعد البديل\n' +
             '٢️⃣ رفض الموعد البديل',
      conversationState: disruptionState,
      invalidResponse: true
    });
  },

  // ═════════════════════════════════════════════════════════════════════
  // PROPOSAL CREATION (Contract §5.1 / Addendum §4)
  // ═════════════════════════════════════════════════════════════════════

  _createProposal: function(phone, originalSlot, now, sendFn) {
    // ── Phase 1 — keyed, no slot mutation ───────────────────────────────
    const prepared = this._prepareProposal(phone, originalSlot, now);
    if (!prepared.ok) return prepared;

    if (prepared.data.outcome === 'NO_ALTERNATIVE') {
      // Notification happens outside every lock (Addendum §3.2).
      prepared.data.notification = this._notifyNoAlternative(phone, sendFn);
      return Result.ok(prepared.data);
    }

    const candidate = prepared.data.candidate;
    const holdUntil = DateUtils.addMinutes(
      now,
      Config.SYSTEM_POLICY.DISRUPTION_PROPOSAL_TIMEOUT_MINUTES
    );

    // ── Phase 2 — atomic reservation through the per-slot boundary ──────
    // No outer lock is held here: the per-phone keyed lock must never wrap a
    // slot mutation (see the serialization model in this file's header).
    const reserveResult = SlotRepository.atomicUpdate(candidate.slot_id, function(freshCandidate) {
      const check = Validators.validateTransition(
        freshCandidate.status,
        Config.VOCABULARY.COMMANDS.RESERVE_SLOT
      );
      if (!check.ok) return check;

      if (!SlotRepository.isOperationallyAvailable(freshCandidate.is_available)) {
        return Result.fail('SLOT_UNAVAILABLE', 'Candidate is no longer operationally available', {
          slotId: freshCandidate.slot_id
        });
      }

      return Result.ok({
        status: Config.VOCABULARY.STATUS.RESERVED,
        phone: phone,
        patient_name: prepared.data.original.patient_name || '',
        reserved_until: holdUntil,
        reserved_until_unix: holdUntil.getTime()
      });
    });

    if (!reserveResult.ok) {
      const code = reserveResult.error ? reserveResult.error.code : 'UNKNOWN';
      if (code === 'INVALID_TRANSITION' || code === 'SLOT_UNAVAILABLE' || code === 'SLOT_NOT_FOUND') {
        this._log(this.LOG.CANDIDATE_RACE, phone, candidate.slot_id, false, { cause: reserveResult.error });
        return Result.fail('M4F_STALE_CANDIDATE', 'Candidate was consumed or became unavailable before reservation', {
          slotId: candidate.slot_id, cause: reserveResult.error
        });
      }
      return reserveResult;
    }

    // ── Phase 3 — keyed persist, guarded by the Phase-1 snapshot ────────
    const persisted = this._persistProposal(phone, prepared.data, now);

    if (!persisted.ok) {
      // Addendum §4: never notify, always attempt ownership-checked cleanup,
      // and surface an explicit recovery-required failure if cleanup fails.
      const cleanup = this._releaseProposalTarget(phone, candidate.slot_id);
      if (!cleanup.ok) {
        this._log(this.LOG.RECOVERY_REQUIRED, phone, candidate.slot_id, false, {
          cause: cleanup.error, persistError: persisted.error
        });
        return Result.fail(
          'M4F_PROPOSAL_CLEANUP_REQUIRED',
          'Proposal persistence failed and the reserved candidate could not be released; manual recovery required',
          { candidateSlotId: candidate.slot_id, persistError: persisted.error, cleanupError: cleanup.error }
        );
      }
      // The reservation was released safely; the refusal stays explicit.
      if (persisted.error) persisted.error.details = persisted.error.details || {};
      return persisted;
    }

    // ── Phase 4 — notify outside every lock ─────────────────────────────
    const created = {
      outcome: 'PROPOSED',
      phone: phone,
      proposal: persisted.data.proposal,
      candidate: candidate,
      original: prepared.data.original,
      notification: this._notifyProposal(phone, persisted.data.proposal, candidate, sendFn)
    };

    this._log(this.LOG.PROPOSAL_CREATED, phone, candidate.slot_id, true, {
      proposalId: persisted.data.proposal.disruption_proposal_id,
      originalSlotId: persisted.data.proposal.disruption_original_slot_id,
      kind: persisted.data.proposal.disruption_kind
    });

    return Result.ok(created);
  },

  /**
   * Phase 1 — under the per-phone keyed lock, but performing NO slot
   * mutation: pending-proposal check, fresh validation of the affected
   * appointment, and candidate selection.
   */
  _prepareProposal: function(phone, originalSlot, now) {
    const self = this;
    return Lock.runExclusive(
      'disruption:' + phone,
      function() {
        // (a) one proposal per phone
        const sessionResult = ConversationRepository.getDisruptionSession(phone);
        if (!sessionResult.ok) return sessionResult;
        if (sessionResult.data.pending) {
          return Result.fail(
            'M4F_PENDING_PROPOSAL_EXISTS',
            'A disruption proposal is already pending for this phone',
            { phone: phone, proposalId: sessionResult.data.proposal.disruption_proposal_id }
          );
        }

        // (b) fresh validation of the affected appointment — stale M4-E
        //     evidence never authorizes a mutation.
        const freshResult = SlotRepository.findByIdResult(originalSlot.slot_id);
        if (!freshResult.ok) return freshResult;

        const fresh = freshResult.data;
        if (!fresh) {
          return Result.fail('M4F_STALE_ORIGINAL', 'Affected appointment no longer exists', { slotId: originalSlot.slot_id });
        }
        if (fresh.phone !== phone) {
          return Result.fail('M4F_STALE_ORIGINAL', 'Affected appointment no longer belongs to this phone', {
            slotId: fresh.slot_id, owner: fresh.phone, phone: phone
          });
        }
        const kind = fresh.status;
        if (kind !== Config.VOCABULARY.STATUS.CONFIRMED && kind !== Config.VOCABULARY.STATUS.RESERVED) {
          return Result.fail('M4F_STALE_ORIGINAL', 'Affected appointment is no longer in an actionable lifecycle state', {
            slotId: fresh.slot_id, currentStatus: fresh.status
          });
        }
        if (SlotRepository.isOperationallyAvailable(fresh.is_available)) {
          return Result.fail('M4F_STALE_ORIGINAL', 'Appointment is no longer affected (is_available became true)', {
            slotId: fresh.slot_id
          });
        }
        if (kind === Config.VOCABULARY.STATUS.RESERVED) {
          const untilMs = Number(fresh.reserved_until_unix);
          if (!isFinite(untilMs) || untilMs <= now.getTime()) {
            return Result.fail('M4F_STALE_ORIGINAL', 'Affected reservation is no longer active', { slotId: fresh.slot_id });
          }
        }

        // (c) candidate — existing selection policy only, bounded horizon
        const selection = SlotSelection.findEarliestWithinHorizon({
          excludedSlotIds: [fresh.slot_id],
          horizonDays: Config.SYSTEM_POLICY.DISRUPTION_CANDIDATE_HORIZON_DAYS
        });

        if (!selection.ok) {
          if (selection.error && selection.error.code === 'NO_SLOT_AVAILABLE') {
            // Contract §2.6 / Addendum §12: notify, no reservation, no mutation.
            self._log(self.LOG.NO_ALTERNATIVE, phone, fresh.slot_id, false, {
              horizonDays: Config.SYSTEM_POLICY.DISRUPTION_CANDIDATE_HORIZON_DAYS
            });
            return Result.ok({ outcome: 'NO_ALTERNATIVE', phone: phone, originalSlotId: fresh.slot_id });
          }
          return selection;
        }

        return Result.ok({
          outcome: 'CANDIDATE',
          phone: phone,
          original: fresh,
          candidate: selection.data,
          snapshot: self._snapshotOf(fresh)
        });
      },
      Config.SYSTEM_POLICY.DISRUPTION_LOCK_TIMEOUT_MS
    );
  },

  /**
   * Phase 3 — under the per-phone keyed lock, and again performing NO slot
   * mutation. Re-verifies that no proposal is pending and that the original
   * appointment still matches the Phase-1 snapshot, then persists.
   */
  _persistProposal: function(phone, prepared, now) {
    return Lock.runExclusive(
      'disruption:' + phone,
      function() {
        const self = PatientDisruptionService;

        const sessionResult = ConversationRepository.getDisruptionSession(phone);
        if (!sessionResult.ok) return sessionResult;
        if (sessionResult.data.pending) {
          return Result.fail('M4F_PENDING_PROPOSAL_EXISTS', 'A disruption proposal became pending before persistence', { phone: phone });
        }

        // Original must still match the snapshot taken in Phase 1: any
        // independent change (cancel / change / expiry / rebook) refuses the
        // proposal instead of mutating across appointments (Contract §6.4).
        const freshResult = SlotRepository.findByIdResult(prepared.original.slot_id);
        if (!freshResult.ok) return freshResult;
        const fresh = freshResult.data;
        if (!fresh) {
          return Result.fail('M4F_STALE_ORIGINAL', 'Original appointment disappeared before the proposal was persisted', {
            slotId: prepared.original.slot_id
          });
        }
        const drift = self._snapshotDrift(prepared.snapshot, fresh);
        if (drift !== null) {
          return Result.fail('M4F_STALE_ORIGINAL', 'Original appointment changed before the proposal was persisted', {
            slotId: fresh.slot_id, field: drift.field, before: drift.before, after: drift.after
          });
        }

        const proposalId = IdGenerator.generateDisruptionProposalId();
        const expiresAt = DateUtils.addMinutes(
          now,
          Config.SYSTEM_POLICY.DISRUPTION_PROPOSAL_TIMEOUT_MINUTES
        );

        const proposal = {
          disruption_original_slot_id: fresh.slot_id,
          disruption_proposal_slot_id: prepared.candidate.slot_id,
          disruption_kind: prepared.original.status,
          disruption_created_at_ms: String(now.getTime()),
          disruption_expires_at_ms: String(expiresAt.getTime()),
          disruption_proposal_id: proposalId,
          disruption_notification_status: self.NOTIFICATION.PENDING
        };

        const persist = ConversationRepository.setDisruptionSession(phone, proposal);
        if (!persist.ok) return persist;

        return Result.ok({ proposal: proposal });
      },
      Config.SYSTEM_POLICY.DISRUPTION_LOCK_TIMEOUT_MS
    );
  },

  // ═════════════════════════════════════════════════════════════════════
  // NOTIFICATION (Contract §2.1 / Addendum §5)
  // ═════════════════════════════════════════════════════════════════════

  _notifyProposal: function(phone, proposal, candidate, sendFn) {
    return this._sendAndRecord(phone, proposal.disruption_proposal_id, this._proposalMessage(candidate), sendFn);
  },

  _notifyNoAlternative: function(phone, sendFn) {
    try {
      const result = sendFn(phone, this._noAlternativeMessage());
      return { status: (result && result.ok) ? 'SENT' : 'FAILED', send: result, persisted: null };
    } catch (e) {
      return { status: 'FAILED', send: Result.fail('M4F_NOTIFICATION_FAILED', e.message, e.stack), persisted: null };
    }
  },

  _retryNotificationIfNeeded: function(phone, session, now, sendFn) {
    const proposal = session.proposal;

    const expiresAtMs = Number(proposal.disruption_expires_at_ms);
    if (isFinite(expiresAtMs) && expiresAtMs <= now.getTime()) {
      return { retried: false, reason: 'EXPIRED' };
    }

    if (this.RETRYABLE_NOTIFICATION_STATES.indexOf(proposal.disruption_notification_status) === -1) {
      return { retried: false, reason: 'NOT_RETRYABLE', status: proposal.disruption_notification_status };
    }

    // A retry may only describe a reservation this proposal still owns. If
    // the target cannot be freshly verified as RESERVED + owned, there is
    // nothing safe to offer the patient: sending anyway would produce a
    // truncated message offering an undefined slot (round 2, P2). The state
    // is classified for recovery instead of being notified.
    const readResult = SlotRepository.findByIdResult(proposal.disruption_proposal_slot_id);
    if (!readResult.ok) {
      this._log(this.LOG.NOTIFICATION_FAILED, phone, proposal.disruption_proposal_slot_id, false, {
        proposalId: proposal.disruption_proposal_id,
        reason: 'TARGET_READ_FAILED',
        code: readResult.error ? readResult.error.code : 'UNKNOWN'
      });
      return {
        retried: false,
        reason: 'TARGET_READ_FAILED',
        staleCandidate: true,
        proposalId: proposal.disruption_proposal_id,
        error: readResult.error
      };
    }

    const candidate = readResult.data;
    if (!candidate ||
        candidate.phone !== phone ||
        candidate.status !== Config.VOCABULARY.STATUS.RESERVED ||
        !SlotRepository.isOperationallyAvailable(candidate.is_available)) {
      this._log(this.LOG.NOTIFICATION_FAILED, phone, proposal.disruption_proposal_slot_id, false, {
        proposalId: proposal.disruption_proposal_id,
        reason: 'STALE_CANDIDATE',
        currentStatus: candidate ? candidate.status : null,
        owner: candidate ? candidate.phone : null
      });
      return {
        retried: false,
        reason: 'STALE_CANDIDATE',
        staleCandidate: true,
        proposalId: proposal.disruption_proposal_id,
        slotId: proposal.disruption_proposal_slot_id
      };
    }

    // Same proposal identity: no new reservation, no new proposal.
    const sent = this._notifyProposal(phone, proposal, candidate, sendFn);
    return {
      retried: true,
      reason: 'RETRY_SAME_PROPOSAL',
      status: sent.status,
      proposalId: proposal.disruption_proposal_id
    };
  },

  _sendAndRecord: function(phone, proposalId, text, sendFn) {
    let sendResult;
    try {
      sendResult = sendFn(phone, text);
    } catch (e) {
      sendResult = Result.fail('M4F_NOTIFICATION_FAILED', e.message, e.stack);
    }

    const delivered = !!(sendResult && sendResult.ok);
    const status = delivered ? this.NOTIFICATION.SENT : this.NOTIFICATION.FAILED;

    // Durable, ownership-checked bookkeeping of the notification lifecycle.
    const persisted = this._setNotificationStatus(phone, proposalId, status);

    this._log(
      delivered ? this.LOG.NOTIFICATION_SENT : this.LOG.NOTIFICATION_FAILED,
      phone, null, delivered,
      { proposalId: proposalId, persisted: !!(persisted && persisted.ok) }
    );

    if (!delivered) {
      return {
        status: status,
        send: sendResult,
        persisted: persisted,
        error: Result.fail('M4F_NOTIFICATION_FAILED', 'Disruption notification could not be delivered', {
          proposalId: proposalId, cause: sendResult ? sendResult.error : null
        })
      };
    }

    return { status: status, send: sendResult, persisted: persisted };
  },

  _setNotificationStatus: function(phone, proposalId, status) {
    return Lock.runExclusive(
      'disruption:' + phone,
      function() {
        const sessionResult = ConversationRepository.getDisruptionSession(phone);
        if (!sessionResult.ok) return sessionResult;
        if (!sessionResult.data.pending ||
            sessionResult.data.proposal.disruption_proposal_id !== proposalId) {
          return Result.fail('M4F_CONFLICTING_ACTION', 'Pending disruption proposal changed while recording notification status', {
            proposalId: proposalId
          });
        }
        const proposal = sessionResult.data.proposal;
        proposal.disruption_notification_status = status;
        return ConversationRepository.setDisruptionSession(phone, proposal);
      },
      Config.SYSTEM_POLICY.DISRUPTION_LOCK_TIMEOUT_MS
    );
  },

  // ═════════════════════════════════════════════════════════════════════
  // FINALIZATION — CONFIRM
  // ═════════════════════════════════════════════════════════════════════

  _confirm: function(phone, proposal, now) {
    // Common revalidation (Contract §6.1): fresh reads of the proposal, the
    // original, the target and the current time. Stale evidence alone never
    // mutates anything.
    const revalidated = this._revalidateForConfirmation(phone, proposal, now);
    if (!revalidated.ok) return revalidated;

    const current = revalidated.data.proposal;
    const target = revalidated.data.target;

    if (current.disruption_kind === Config.VOCABULARY.STATUS.CONFIRMED) {
      return this._confirmForConfirmedOriginal(phone, current, target);
    }
    return this._confirmForReservedOriginal(phone, current, target);
  },

  /**
   * Original was CONFIRMED — reuse the existing confirmed-change semantics
   * (B6 + Calendar + patient-retention-first). B6 is acquired by that
   * boundary at the final mutation only, never while waiting (M4F-25).
   */
  _confirmForConfirmedOriginal: function(phone, proposal, target) {
    const change = ChangeService.changeConfirmedAppointment(phone, {
      targetSlotId: proposal.disruption_proposal_slot_id
    });

    if (!change.ok) {
      return Result.fail('M4F_LIFECYCLE_MUTATION_FAILED', 'Confirmed disruption finalization failed', {
        proposalId: proposal.disruption_proposal_id,
        targetSlotId: proposal.disruption_proposal_slot_id,
        cause: change.error
      });
    }

    if (!change.data || change.data.status !== 'CHANGED') {
      // B6 / Calendar recovery-required outcome. The proposal is deliberately
      // left durable so the patient is not silently dropped and the case
      // stays observable for recovery.
      this._log(this.LOG.B6_RECOVERY_REQUIRED, phone, proposal.disruption_proposal_slot_id, false, {
        proposalId: proposal.disruption_proposal_id,
        changeStatus: change.data ? change.data.status : null
      });
      return Result.ok({
        reply: (change.data && change.data.reply) ||
          'تعذّر تغيير موعدك حالياً. الرجاء المحاولة مرة أخرى أو التواصل مع العيادة.',
        conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_DISRUPTION_CONFIRMATION,
        recoveryRequired: true
      });
    }

    // Clear pending disruption only AFTER the final outcome is durable.
    const cleared = this._clearSession(phone, Config.VOCABULARY.CONVERSATION_STATE.BOOKED);
    if (!cleared.ok) return cleared;

    this._log(this.LOG.PROPOSAL_CONFIRMED, phone, proposal.disruption_proposal_slot_id, true, {
      proposalId: proposal.disruption_proposal_id, kind: 'CONFIRMED'
    });

    return Result.ok({
      reply: change.data.reply,
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.BOOKED,
      confirmed: true
    });
  },

  /**
   * Original was RESERVED — a pre-confirmation hold. No B6 ownership is
   * required here (Addendum §7). The target is confirmed through the existing
   * appointment-finalization semantics (StateMachine ConfirmReservation +
   * Calendar creation after confirmation), and the original hold is released
   * only AFTER the target confirmation is secured.
   */
  _confirmForReservedOriginal: function(phone, proposal, target) {
    const finalized = BookingService.confirmReservedSlot(phone, proposal.disruption_proposal_slot_id);

    if (!finalized.ok) {
      return Result.fail('M4F_LIFECYCLE_MUTATION_FAILED', 'Reserved disruption finalization failed', {
        proposalId: proposal.disruption_proposal_id,
        targetSlotId: proposal.disruption_proposal_slot_id,
        cause: finalized.error
      });
    }

    // Release the original hold only after the new appointment is secured, so
    // the patient can never end with zero appointments because of M4-F
    // (Closure Addendum §7).
    const originalSlotId = proposal.disruption_original_slot_id;
    const released = this._releaseOriginalReservation(phone, originalSlotId);

    if (!released.ok) {
      // ⚠️ Supervisor review finding #1 — the outcome is NOT a success.
      // The target is CONFIRMED but the original is still held, i.e. the
      // patient would end with two active bookings. The pending interaction
      // is deliberately NOT cleared: clearing it would hide the unresolved
      // original and destroy the ownership evidence recovery depends on. A
      // later Scheduler run retries the release via
      // _recoverPendingFinalizations().
      this._log(this.LOG.RECOVERY_REQUIRED, phone, originalSlotId, false, {
        proposalId: proposal.disruption_proposal_id,
        stage: 'ORIGINAL_RESERVATION_RELEASE',
        targetSlotId: proposal.disruption_proposal_slot_id,
        cause: released.error
      });
      return Result.fail(
        'M4F_RECOVERY_REQUIRED',
        'The replacement appointment is confirmed but the original reservation could not be released; recovery required',
        {
          proposalId: proposal.disruption_proposal_id,
          originalSlotId: originalSlotId,
          targetSlotId: proposal.disruption_proposal_slot_id,
          cause: released.error
        }
      );
    }

    const cleared = this._clearSession(phone, Config.VOCABULARY.CONVERSATION_STATE.BOOKED);
    if (!cleared.ok) {
      // The appointment outcome is durable, but the interaction state is not:
      // keep the case visible instead of reporting a clean success.
      this._log(this.LOG.RECOVERY_REQUIRED, phone, proposal.disruption_proposal_slot_id, false, {
        proposalId: proposal.disruption_proposal_id,
        stage: 'SESSION_CLEAR',
        cause: cleared.error
      });
      return Result.fail('M4F_RECOVERY_REQUIRED', 'Confirmed disruption could not finalize the interaction state; recovery required', {
        proposalId: proposal.disruption_proposal_id,
        stage: 'SESSION_CLEAR',
        cause: cleared.error
      });
    }

    this._log(this.LOG.PROPOSAL_CONFIRMED, phone, proposal.disruption_proposal_slot_id, true, {
      proposalId: proposal.disruption_proposal_id, kind: 'RESERVED', originalReleased: released.data.released === true
    });

    const confirmedDisplay = this._slotDisplay(target);
    return Result.ok({
      reply: 'تم تأكيد موعدك الجديد.' +
        (confirmedDisplay ? '\n' + confirmedDisplay : '') +
        '\nيرجى الحضور ضمن وقت دوام العيادة.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.BOOKED,
      confirmed: true,
      originalReleased: released.data.released === true
    });
  },

  /**
   * Ownership-checked release of the ORIGINAL appointment hold.
   *
   * "Not owned by this proposal" is NOT a failure: the original may have been
   * released or expired through its own ordinary lifecycle, and mutating an
   * unrelated slot is forbidden (Contract §7). Only a genuine, still-owned
   * release failure escalates to M4F_RECOVERY_REQUIRED.
   */
  _releaseOriginalReservation: function(phone, slotId) {
    const readResult = SlotRepository.findByIdResult(slotId);
    if (!readResult.ok) return readResult;

    const slot = readResult.data;
    if (!slot || slot.phone !== phone || slot.status !== Config.VOCABULARY.STATUS.RESERVED) {
      return Result.ok({ released: false, reason: 'NOT_OWNED_BY_PROPOSAL' });
    }

    const released = this._releaseProposalTarget(phone, slotId);
    if (!released.ok) return released;
    return Result.ok({ released: true, reason: 'RELEASED' });
  },

  /**
   * Supervisor review finding #1 — bounded recovery sweep.
   *
   * Completes a confirmation that was interrupted between "target confirmed"
   * and "original released / session cleared": those rows are still in
   * WAITING_DISRUPTION_CONFIRMATION with a CONFIRMED proposal target. The
   * release is retried from the durable slot rows alone — no new journal, no
   * new schema field, no loss of ownership evidence.
   */
  _recoverPendingFinalizations: function() {
    var self = this;
    const rowsResult = ConversationRepository.findConversationsByState(
      Config.VOCABULARY.CONVERSATION_STATE.WAITING_DISRUPTION_CONFIRMATION
    );
    if (!rowsResult.ok) return rowsResult;

    const recovered = [];
    const rows = rowsResult.data;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const proposalId = row.disruption_proposal_id;
      const targetSlotId = row.disruption_proposal_slot_id;
      const originalSlotId = row.disruption_original_slot_id;
      if (!proposalId || !targetSlotId || !originalSlotId || !row.phone) continue;
      const phone = row.phone;

      // ── PHASE A — decide under the per-phone lock (fresh reads only) ────
      // The decision is taken while no concurrent inbound decision for the
      // same phone can interleave, so a stale sweep can never act on a
      // snapshot that an inbound confirmation has already moved past.
      const decision = Lock.runExclusive(
        'disruption:' + phone,
        function() { return self._decideRecovery(phone, proposalId, targetSlotId, originalSlotId); },
        Config.SYSTEM_POLICY.DISRUPTION_LOCK_TIMEOUT_MS
      );
      if (!decision.ok) continue;
      if (decision.data.action === 'SKIP') continue;

      // ── PHASE B — the slot mutation, outside the lock ──────────────────
      // The Addendum forbids holding the global ScriptLock across a mutation.
      // The release is ownership-checked by atomicUpdate, so it can only ever
      // free a slot still RESERVED to this phone.
      if (decision.data.action === 'RELEASE_AND_CLEAR') {
        const released = this._releaseProposalTarget(phone, originalSlotId);
        if (!released.ok) continue; // retry on the next run
      }

      // ── PHASE C — clear guarded by a FRESH identity re-check ───────────
      // Between phase A and here an inbound confirm/decline may have changed
      // or replaced the interaction. Re-reading the identity under the lock
      // is what makes a stale sweep unable to erase a newer decision: if the
      // pending proposal is no longer the one this sweep read, the sweep
      // abandons the clear entirely.
      const finalized = Lock.runExclusive(
        'disruption:' + phone,
        function() {
          const session = ConversationRepository.getDisruptionSession(phone);
          if (!session.ok) return session;
          if (!session.data.pending ||
              session.data.proposal.disruption_proposal_id !== proposalId) {
            return Result.ok({ cleared: false, reason: 'STALE_SWEEP_ABORTED' });
          }
          // Lock already held by this frame: call the repository directly.
          return ConversationRepository.clearDisruptionSession(
            phone, Config.VOCABULARY.CONVERSATION_STATE.BOOKED
          );
        },
        Config.SYSTEM_POLICY.DISRUPTION_LOCK_TIMEOUT_MS
      );
      if (!finalized.ok) continue;

      if (finalized.data && finalized.data.reason === 'STALE_SWEEP_ABORTED') {
        // A newer inbound decision owns this interaction now. Never erase it.
        recovered.push({
          phone: phone, proposalId: proposalId, outcome: 'STALE_SWEEP_ABORTED',
          releasedOriginal: decision.data.action === 'RELEASE_AND_CLEAR'
        });
        this._log(this.LOG.RECOVERY_STALE_ABORTED, phone, originalSlotId, false, {
          proposalId: proposalId,
          releasedOriginal: decision.data.action === 'RELEASE_AND_CLEAR'
        });
        continue;
      }

      recovered.push({
        phone: phone,
        proposalId: proposalId,
        outcome: decision.data.action === 'RELEASE_AND_CLEAR' ? 'RELEASED_AND_CLEARED' : 'CLEARED',
        releasedOriginal: decision.data.action === 'RELEASE_AND_CLEAR'
      });

      this._log(this.LOG.PROPOSAL_CONFIRMED, phone, targetSlotId, true, {
        proposalId: proposalId, kind: 'RESERVED', recovered: true,
        originalReleased: decision.data.action === 'RELEASE_AND_CLEAR'
      });
    }

    return Result.ok(recovered);
  },

  /**
   * Phase A of the recovery sweep: read the durable rows and classify the
   * interrupted confirmation. Executed under the per-phone lock, and it
   * performs READS ONLY — no mutation, no outbound I/O.
   *
   * @returns {Result} ok({ action:'SKIP'|'CLEAR_ONLY'|'RELEASE_AND_CLEAR' })
   */
  _decideRecovery: function(phone, proposalId, targetSlotId, originalSlotId) {
    const session = ConversationRepository.getDisruptionSession(phone);
    if (!session.ok) return session;

    // The interaction moved on (or was replaced by a newer proposal): this
    // sweep's snapshot is stale, so it must not decide anything at all.
    if (!session.data.pending ||
        session.data.proposal.disruption_proposal_id !== proposalId) {
      return Result.ok({ action: 'SKIP', reason: 'STALE_SWEEP' });
    }

    const targetResult = SlotRepository.findByIdResult(targetSlotId);
    if (!targetResult.ok) return targetResult;
    const target = targetResult.data;
    // Only a partially-completed confirmation reaches the sweep at all.
    if (!target || target.status !== Config.VOCABULARY.STATUS.CONFIRMED || target.phone !== phone) {
      return Result.ok({ action: 'SKIP', reason: 'NO_PARTIAL_CONFIRMATION' });
    }

    const originalResult = SlotRepository.findByIdResult(originalSlotId);
    if (!originalResult.ok) return originalResult;
    const original = originalResult.data;

    if (!original || original.phone !== phone ||
        original.status !== Config.VOCABULARY.STATUS.RESERVED) {
      // Nothing owned to release: the original already returned to its own
      // lifecycle. Finalize the interaction only.
      return Result.ok({ action: 'CLEAR_ONLY' });
    }

    return Result.ok({ action: 'RELEASE_AND_CLEAR' });
  },

  // ═════════════════════════════════════════════════════════════════════
  // FINALIZATION — DECLINE / TIMEOUT (Contract §7 / Addendum §8)
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Patient declined the proposed alternative (Contract §7 / Addendum §8).
   *
   * This is CLEANUP of the proposal target, not a move. The original
   * appointment's continued validity is deliberately NOT a precondition: if
   * the original reopened, was changed or was cancelled, the patient must
   * still be able to decline, and the reserved target must still be freed —
   * otherwise a slot stays reserved for a proposal nobody can ever cancel.
   * The original is never mutated here (Addendum §8).
   *
   * Note the absence of `now`: a decline is not an expiry decision either.
   * An already-expired proposal is still cleaned up, which is the safe
   * direction (release, never keep).
   */
  _decline: function(phone, proposal) {
    const revalidated = this._revalidateForCleanup(phone, proposal);
    if (!revalidated.ok) return revalidated;

    const current = revalidated.data.proposal;

    // Ownership-checked: a target the proposal no longer owns is left alone.
    const cleanup = this._cleanupProposalTarget(phone, current.disruption_proposal_slot_id);
    if (!cleanup.ok) return cleanup;

    const nextState = this._fallbackState(current.disruption_kind, current.disruption_original_slot_id, phone);
    const cleared = this._clearSession(phone, nextState);
    if (!cleared.ok) return cleared;

    this._log(this.LOG.PROPOSAL_DECLINED, phone, current.disruption_proposal_slot_id, true, {
      proposalId: current.disruption_proposal_id,
      released: cleanup.data.released,
      releaseReason: cleanup.data.reason
    });

    return Result.ok({
      reply: 'تم إلغاء الموعد البديل المقترح. لم يتم تغيير موعدك.',
      conversationState: nextState,
      declined: true,
      released: cleanup.data.released,
      releaseReason: cleanup.data.reason
    });
  },

  _expire: function(phone, proposal, now) {
    // Ownership-checked release of the proposal TARGET only. The original
    // appointment keeps its own lifecycle semantics (Addendum §8).
    const released = this._cleanupProposalTarget(phone, proposal.disruption_proposal_slot_id);
    if (!released.ok) return released;

    const nextState = this._fallbackState(proposal.disruption_kind, proposal.disruption_original_slot_id, phone);
    const cleared = this._clearSession(phone, nextState);
    if (!cleared.ok) return cleared;

    this._log(this.LOG.PROPOSAL_EXPIRED, phone, proposal.disruption_proposal_slot_id, true, {
      proposalId: proposal.disruption_proposal_id,
      released: released.data.released,
      releaseReason: released.data.reason
    });

    return Result.ok({
      expired: true,
      released: released.data.released === true,
      nextState: nextState,
      proposalId: proposal.disruption_proposal_id
    });
  },

  _expirePendingProposals: function(now) {
    const rowsResult = ConversationRepository.findConversationsByState(
      Config.VOCABULARY.CONVERSATION_STATE.WAITING_DISRUPTION_CONFIRMATION
    );
    if (!rowsResult.ok) return rowsResult;

    const expired = [];
    const rows = rowsResult.data;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const proposalId = row.disruption_proposal_id;
      if (!proposalId || !row.phone) continue;

      const expiresAtMs = Number(row.disruption_expires_at_ms);
      if (!isFinite(expiresAtMs) || expiresAtMs > now.getTime()) continue;

      const proposal = {
        disruption_proposal_id: proposalId,
        disruption_proposal_slot_id: row.disruption_proposal_slot_id,
        disruption_original_slot_id: row.disruption_original_slot_id,
        disruption_kind: row.disruption_kind,
        disruption_expires_at_ms: row.disruption_expires_at_ms
      };

      // No outer lock here: every mutation inside is a per-slot atomicUpdate.
      const result = this._expire(row.phone, proposal, now);
      if (result.ok) {
        expired.push({ phone: row.phone, proposalId: proposalId, nextState: result.data.nextState });
      }
      // Per-row failure is reported, not fatal: the row stays pending and the
      // next Scheduler run retries (retry-safe stage).
    }

    return Result.ok(expired);
  },

  // ═════════════════════════════════════════════════════════════════════
  // SHARED HELPERS
  // ═════════════════════════════════════════════════════════════════════

  /** Bounded Conversation read under the per-phone keyed lock. */
  _readSession: function(phone) {
    return Lock.runExclusive(
      'disruption:' + phone,
      function() { return ConversationRepository.getDisruptionSession(phone); },
      Config.SYSTEM_POLICY.DISRUPTION_LOCK_TIMEOUT_MS
    );
  },

  /** Bounded Conversation clear under the per-phone keyed lock. */
  _clearSession: function(phone, nextState) {
    return Lock.runExclusive(
      'disruption:' + phone,
      function() { return ConversationRepository.clearDisruptionSession(phone, nextState); },
      Config.SYSTEM_POLICY.DISRUPTION_LOCK_TIMEOUT_MS
    );
  },

  /**
   * CONFIRMATION-TIME revalidation (Contract §6.1).
   *
   * Supervisor review round 2 — the confirmation and the cleanup paths have
   * DIFFERENT semantics and must never share one guard:
   *
   *   confirmation  → the original MUST still exist, still belong to the
   *                   patient, still hold the status the proposal was built
   *                   from, AND still be operationally affected
   *                   (`is_available === false`). Otherwise moving the
   *                   appointment is unnecessary (Contract §1, §6.4).
   *   decline/timeout → cleanup of the PROPOSAL TARGET ONLY (Addendum §8).
   *                   The contract makes the original's continued validity a
   *                   precondition of *moving*, never of *cancelling the
   *                   proposal itself*. See _revalidateForCleanup().
   *
   * @returns {Result} ok({ proposal, original, target }) | fail(...)
   */
  _revalidateForConfirmation: function(phone, proposal, now) {
    const sessionResult = this._readSession(phone);
    if (!sessionResult.ok) return sessionResult;

    if (!sessionResult.data.pending ||
        sessionResult.data.proposal.disruption_proposal_id !== proposal.disruption_proposal_id) {
      return Result.fail('M4F_CONFLICTING_ACTION', 'The pending disruption proposal is no longer current', {
        proposalId: proposal.disruption_proposal_id
      });
    }

    const current = sessionResult.data.proposal;

    const expiresAtMs = Number(current.disruption_expires_at_ms);
    if (!isFinite(expiresAtMs)) {
      return Result.fail('M4F_INVALID_PROPOSAL_STATE', 'Pending disruption proposal has no readable expiry', {
        proposalId: current.disruption_proposal_id
      });
    }
    if (expiresAtMs <= now.getTime()) {
      return Result.fail('M4F_PROPOSAL_EXPIRED', 'Disruption proposal has expired', {
        proposalId: current.disruption_proposal_id, expiresAtMs: expiresAtMs
      });
    }

    const originalResult = SlotRepository.findByIdResult(current.disruption_original_slot_id);
    if (!originalResult.ok) return originalResult;
    const original = originalResult.data;
    if (!original) {
      return Result.fail('M4F_STALE_ORIGINAL', 'Original appointment no longer exists', {
        slotId: current.disruption_original_slot_id
      });
    }
    if (original.phone !== phone) {
      return Result.fail('M4F_STALE_ORIGINAL', 'Original appointment no longer belongs to this phone', {
        slotId: original.slot_id
      });
    }
    if (original.status !== current.disruption_kind) {
      return Result.fail('M4F_STALE_ORIGINAL', 'Original appointment lifecycle no longer matches the proposal', {
        slotId: original.slot_id,
        expectedStatus: current.disruption_kind,
        currentStatus: original.status
      });
    }
    // Supervisor review finding #4 — RESOLUTION: IMPLEMENTATION FIX APPLIED.
    // `Slot.is_available` is the operational availability gate and, per
    // Contract §3.5, the projection M4-F consumes as affectedness truth. If
    // the original became operationally available again, the disruption that
    // justified the proposal no longer exists: finalizing the move would be a
    // silent, no-longer-necessary appointment move (Contract §1, §6.4
    // "otherwise no longer matches the proposal's expected original slot").
    // The check is a FRESH read, never the Phase-1 snapshot.
    if (SlotRepository.isOperationallyAvailable(original.is_available)) {
      return Result.fail('M4F_STALE_ORIGINAL', 'Original appointment is no longer affected (is_available became true)', {
        slotId: original.slot_id
      });
    }

    const targetResult = SlotRepository.findByIdResult(current.disruption_proposal_slot_id);
    if (!targetResult.ok) return targetResult;
    const target = targetResult.data;
    if (!target) {
      return Result.fail('M4F_STALE_CANDIDATE', 'Proposal target no longer exists', {
        slotId: current.disruption_proposal_slot_id
      });
    }
    if (target.phone !== phone) {
      return Result.fail('M4F_STALE_CANDIDATE', 'Proposal target no longer belongs to this phone', {
        slotId: target.slot_id
      });
    }
    if (target.status !== Config.VOCABULARY.STATUS.RESERVED) {
      return Result.fail('M4F_STALE_CANDIDATE', 'Proposal target is no longer held as a reservation', {
        slotId: target.slot_id, currentStatus: target.status
      });
    }
    if (!SlotRepository.isOperationallyAvailable(target.is_available)) {
      return Result.fail('M4F_STALE_CANDIDATE', 'Proposal target is no longer operationally available', {
        slotId: target.slot_id
      });
    }

    return Result.ok({ proposal: current, original: original, target: target });
  },

  /**
   * CLEANUP-TIME revalidation (Addendum §8) — used by decline and timeout.
   *
   * Deliberately narrower than _revalidateForConfirmation(): it verifies that
   * the interaction the decision was taken against is still the current one,
   * and NOTHING about the original appointment. Cross-appointment mutation is
   * forbidden by the contract, but that forbids *touching* the original — it
   * does not make the original's validity a precondition for cancelling the
   * proposal. Making it one is what leaked a reserved slot (round 2, P1).
   *
   * Expiry is not a blocker either: cleaning up an already-expired proposal
   * is the safe direction, and the timeout path relies on exactly that.
   *
   * @returns {Result} ok({ proposal }) | fail(M4F_CONFLICTING_ACTION|…)
   */
  _revalidateForCleanup: function(phone, proposal) {
    const sessionResult = this._readSession(phone);
    if (!sessionResult.ok) return sessionResult;

    if (!sessionResult.data.pending ||
        sessionResult.data.proposal.disruption_proposal_id !== proposal.disruption_proposal_id) {
      return Result.fail('M4F_CONFLICTING_ACTION', 'The pending disruption proposal is no longer current', {
        proposalId: proposal.disruption_proposal_id
      });
    }

    const current = sessionResult.data.proposal;
    if (!current.disruption_proposal_slot_id) {
      return Result.fail('M4F_INVALID_PROPOSAL_STATE', 'Pending disruption proposal has no target slot', {
        proposalId: current.disruption_proposal_id
      });
    }

    return Result.ok({ proposal: current });
  },

  /**
   * Shared ownership-checked cleanup of a slot the proposal holds as RESERVED.
   *
   * Used by BOTH decline and timeout: the release itself is one semantic
   * (never mutate a slot the proposal does not own); only the *revalidation
   * guard* above it differs. "Not owned" is a classified clean outcome, not a
   * failure — the interaction must still be cleared so a stale session cannot
   * outlive its proposal.
   *
   * @returns {Result} ok({ released:boolean, reason:string }) | fail(...)
   */
  _cleanupProposalTarget: function(phone, slotId) {
    const readResult = SlotRepository.findByIdResult(slotId);
    if (!readResult.ok) return readResult;

    const target = readResult.data;
    if (!target) return Result.ok({ released: false, reason: 'TARGET_ABSENT' });

    if (target.phone !== phone || target.status !== Config.VOCABULARY.STATUS.RESERVED) {
      return Result.ok({ released: false, reason: 'NOT_OWNED_BY_PROPOSAL' });
    }

    const released = this._releaseProposalTarget(phone, slotId);
    if (!released.ok) return released;

    return Result.ok({ released: true, reason: 'RELEASED' });
  },

  /**
   * Ownership-checked release of a slot the proposal holds as RESERVED,
   * through the StateMachine-owned CleanupReservation transition.
   */
  _releaseProposalTarget: function(phone, slotId) {
    return SlotRepository.atomicUpdate(slotId, function(fresh) {
      if (fresh.phone !== phone) {
        return Result.fail('SLOT_OWNER_MISMATCH', 'Slot no longer belongs to this disruption proposal', {
          slotId: fresh.slot_id, owner: fresh.phone, phone: phone
        });
      }
      const check = Validators.validateTransition(
        fresh.status,
        Config.VOCABULARY.COMMANDS.CLEANUP_RESERVATION
      );
      if (!check.ok) return check;

      return Result.ok({
        status: Config.VOCABULARY.STATUS.FREE,
        patient_name: '',
        phone: '',
        reserved_until: '',
        reserved_until_unix: ''
      });
    });
  },

  _snapshotOf: function(slot) {
    const snapshot = {};
    this.ORIGINAL_SNAPSHOT_FIELDS.forEach(function(field) {
      snapshot[field] = slot[field] === undefined || slot[field] === null ? '' : String(slot[field]);
    });
    return snapshot;
  },

  /** @returns {Object|null} first drifted field, or null when unchanged */
  _snapshotDrift: function(snapshot, slot) {
    const fields = this.ORIGINAL_SNAPSHOT_FIELDS;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const current = slot[field] === undefined || slot[field] === null ? '' : String(slot[field]);
      if (current !== snapshot[field]) {
        return { field: field, before: snapshot[field], after: current };
      }
    }
    return null;
  },

  /**
   * State a cleared disruption interaction falls back to. The original
   * appointment is never mutated by this decision.
   */
  _fallbackState: function(kind, originalSlotId, phone) {
    const readResult = SlotRepository.findByIdResult(originalSlotId);
    if (readResult.ok && readResult.data && readResult.data.phone === phone) {
      const status = readResult.data.status;
      if (status === Config.VOCABULARY.STATUS.RESERVED) {
        return Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION;
      }
      if (status === Config.VOCABULARY.STATUS.CONFIRMED) {
        return Config.VOCABULARY.CONVERSATION_STATE.BOOKED;
      }
    }
    return Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN;
  },

  _replyForFailure: function(failed, disruptionState, action) {
    const code = failed.error ? failed.error.code : 'UNKNOWN';

    if (code === 'M4F_PROPOSAL_EXPIRED') {
      return Result.ok({
        reply: 'انتهت صلاحية الموعد البديل المقترح. لم يتم تغيير موعدك.',
        conversationState: disruptionState,
        expired: true
      });
    }

    // Finding #1 — a partially completed confirmation is NEVER reported to the
    // patient as a plain success, and the pending interaction is left intact
    // so the recovery sweep can complete it.
    if (code === 'M4F_RECOVERY_REQUIRED') {
      return Result.ok({
        reply: 'تم تأكيد الموعد البديل، لكن بقي حجز سابق بحاجة إلى معالجة من العيادة. ' +
               'سيتم إكمال المعالجة تلقائيًا، أو يرجى التواصل مع العيادة.',
        conversationState: disruptionState,
        recoveryRequired: true
      });
    }

    this._log(
      code === 'M4F_STALE_ORIGINAL' ? this.LOG.ORIGINAL_RACE : this.LOG.CANDIDATE_RACE,
      '', null, false,
      { action: action, cause: failed.error }
    );

    return Result.ok({
      reply: 'تعذّر إتمام ' + (action === 'confirmation' ? 'تأكيد' : 'إلغاء') +
             ' الموعد البديل حالياً. الرجاء المحاولة مرة أخرى أو التواصل مع العيادة.',
      conversationState: disruptionState,
      failureCode: code
    });
  },

  // ═════════════════════════════════════════════════════════════════════
  // PRESENTATION (wording is presentation-owned; semantics are frozen)
  // ═════════════════════════════════════════════════════════════════════

  _proposalMessage: function(candidate) {
    const display = this._slotDisplay(candidate);
    return 'تنبيه مهم بخصوص موعدك:\n' +
      'يوم/فترة موعدك الحالي مغلقة الآن ولم تعد متاحة.\n' +
      'الموعد البديل المقترح: ' + (display || 'غير محدد') + '\n' +
      'لم يتم تثبيت الموعد البديل بعد، ولن يتم تغيير موعدك إلا بعد تأكيدك.\n' +
      '١️⃣ تأكيد الموعد البديل\n' +
      '٢️⃣ رفض الموعد البديل\n' +
      'يبقى هذا العرض سارياً لمدة 30 دقيقة.';
  },

  _noAlternativeMessage: function() {
    return 'تنبيه: موعدك الحالي لم يعد متاحاً، ولا يتوفر موعد بديل خلال الأيام القادمة حالياً.\n' +
      'لم يتم تغيير موعدك.\n' +
      'يرجى إرسال أي رسالة لإعادة الحجز أو التواصل مع العيادة.';
  },

  /** @returns {string} human-readable day/time for a slot row */
  _slotDisplay: function(slot) {
    if (!slot) return '';
    const startMs = LegacySlotTimeParser.toComparableTime(slot.sort_key);
    const start = startMs !== null && isFinite(startMs) ? DateUtils.fromTimestamp(startMs) : null;
    if (!start) return '';
    return 'بتاريخ ' + DateUtils.formatDateDisplay(start) +
      ' الساعة ' + DateUtils.formatTimeDisplay(start);
  },

  // ═════════════════════════════════════════════════════════════════════
  // DIAGNOSTICS (Contract §17 — never a source of truth)
  // ═════════════════════════════════════════════════════════════════════

  _log: function(command, phone, slotId, success, details) {
    try {
      LogRepository.write({
        timestamp: Clock.now(),
        command: command,
        phone: phone || '',
        slotId: slotId || '',
        stage: 'END',
        success: success === true,
        durationMs: null,
        error: details ? JSON.stringify(details) : null
      });
    } catch (e) {
      // Diagnostics must never break the business flow.
    }
  },

  _isConfirmation: function(message) {
    const normalized = String(message === undefined || message === null ? '' : message).trim().toLowerCase();
    return this.CONFIRM_KEYWORDS.indexOf(normalized) !== -1;
  },

  _isDecline: function(message) {
    const normalized = String(message === undefined || message === null ? '' : message).trim().toLowerCase();
    return this.DECLINE_KEYWORDS.indexOf(normalized) !== -1;
  }
};
