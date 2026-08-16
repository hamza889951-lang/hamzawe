/**
 * B6LifecycleService
 *
 * B6 application boundary for durable lifecycle ownership, checkpoints,
 * terminal proof, unresolved classification, recovery audit, and the internal
 * trusted-recovery seam. It is not a public endpoint and does not implement
 * Doctor Dashboard authentication.
 */
const B6LifecycleService = {
  COMMANDS: {
    CHANGE: 'CHANGE',
    CANCEL: 'CANCEL'
  },

  LIFECYCLE_STATES: {
    REJECTED_NO_EFFECT: 'REJECTED_NO_EFFECT',
    ACTIVE_PRE_EFFECT: 'ACTIVE_PRE_EFFECT',
    ACTIVE_POST_EFFECT: 'ACTIVE_POST_EFFECT',
    UNRESOLVED: 'UNRESOLVED',
    RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
    RESOLVED_CHANGE: 'RESOLVED_CHANGE',
    RESOLVED_CANCEL: 'RESOLVED_CANCEL',
    RELEASE_PENDING: 'RELEASE_PENDING',
    RELEASED: 'RELEASED'
  },

  OWNERSHIP_STATES: {
    NONE: 'NONE',
    HELD_ACTIVE: 'HELD_ACTIVE',
    HELD_UNRESOLVED: 'HELD_UNRESOLVED',
    HELD_RECOVERY: 'HELD_RECOVERY',
    RELEASE_PENDING: 'RELEASE_PENDING',
    RELEASED: 'RELEASED'
  },

  CHECKPOINTS: {
    OWNERSHIP_ACQUIRED: 'OWNERSHIP_ACQUIRED',
    OLD_APPOINTMENT_VERIFIED: 'OLD_APPOINTMENT_VERIFIED',
    NEW_SLOT_RESERVED: 'NEW_SLOT_RESERVED',
    NEW_SLOT_CONFIRMED: 'NEW_SLOT_CONFIRMED',
    CALENDAR_CREATE_ATTEMPTED: 'CALENDAR_CREATE_ATTEMPTED',
    CALENDAR_CREATE_CONFIRMED: 'CALENDAR_CREATE_CONFIRMED',
    CALENDAR_EVENT_ID_PERSISTED: 'CALENDAR_EVENT_ID_PERSISTED',
    OLD_CALENDAR_DELETE_ATTEMPTED: 'OLD_CALENDAR_DELETE_ATTEMPTED',
    OLD_CALENDAR_DELETE_CONFIRMED: 'OLD_CALENDAR_DELETE_CONFIRMED',
    OLD_SLOT_FREED: 'OLD_SLOT_FREED',
    TARGET_APPOINTMENT_VERIFIED: 'TARGET_APPOINTMENT_VERIFIED',
    CALENDAR_DELETE_ATTEMPTED: 'CALENDAR_DELETE_ATTEMPTED',
    CALENDAR_DELETE_CONFIRMED: 'CALENDAR_DELETE_CONFIRMED',
    SLOT_FREED: 'SLOT_FREED',
    TERMINAL_CHANGE_PROVEN: 'TERMINAL_CHANGE_PROVEN',
    TERMINAL_CANCEL_PROVEN: 'TERMINAL_CANCEL_PROVEN',
    RELEASE_PENDING: 'RELEASE_PENDING',
    RELEASED: 'RELEASED'
  },

  begin: function(phone, command) {
    var storesResult = this._ensureStores();
    if (!storesResult.ok) return storesResult;

    var latestResult = B6LifecycleRepository.latestByPhone(phone);
    if (!latestResult.ok) return latestResult;
    if (this._isBlockingJournalRecord(latestResult.data)) {
      return Result.fail(
        'B6_LIFECYCLE_JOURNAL_BLOCKED',
        'A prior B6 lifecycle record remains unresolved or release-pending',
        { phone: phone, operationId: latestResult.data.operation_id || '' }
      );
    }

    var ownershipResult = AppointmentRepository.acquireB6LifecycleOwnership(phone, command);
    if (!ownershipResult.ok) {
      this._diagnostic('B6_OWNERSHIP_BLOCKED', phone, '', ownershipResult.error);
      return ownershipResult;
    }

    var data = ownershipResult.data;
    var ctx = {
      operationId: data.operationId,
      ownerToken: data.ownerToken,
      phone: data.phone,
      command: command,
      oldSlot: data.appointment || null,
      oldSlotId: data.appointment ? data.appointment.slot_id : '',
      newSlot: null,
      newSlotId: '',
      calendarEventId: '',
      calendarId: '',
      calendarCorrelationId: data.operationId,
      recoveryCaseId: '',
      lifecycleState: this.LIFECYCLE_STATES.ACTIVE_PRE_EFFECT,
      ownershipState: data.ownershipState,
      lastCheckpoint: '',
      createdAt: Clock.now(),
      oldCalendarDeleteResult: null
    };

    if (data.status === 'RECOVERY_REQUIRED') {
      return this.enterUnresolved(
        ctx,
        'AMBIGUOUS_ACTIVE_APPOINTMENT',
        { activeCount: data.activeCount }
      );
    }

    var checkpointResult = this.recordCheckpoint(
      ctx,
      this.LIFECYCLE_STATES.ACTIVE_PRE_EFFECT,
      this.OWNERSHIP_STATES.HELD_ACTIVE,
      this.CHECKPOINTS.OWNERSHIP_ACQUIRED,
      {}
    );
    if (!checkpointResult.ok) {
      return this.enterUnresolved(
        ctx,
        'CHECKPOINT_PERSISTENCE_UNKNOWN',
        checkpointResult.error
      );
    }

    return Result.ok(ctx);
  },

  recordCheckpoint: function(ctx, lifecycleState, ownershipState, checkpoint, patch) {
    var record = this._buildRecord(ctx, lifecycleState, ownershipState, checkpoint, patch || {});
    var result = B6LifecycleRepository.appendCheckpoint(record);
    if (!result.ok) return result;

    ctx.lifecycleState = lifecycleState;
    ctx.ownershipState = ownershipState;
    ctx.lastCheckpoint = checkpoint;
    this._applyPatch(ctx, patch || {});
    return Result.ok(ctx);
  },

  enterUnresolved: function(ctx, reason, details) {
    if (!ctx.recoveryCaseId) ctx.recoveryCaseId = 'RCV_' + ULID.generate();

    var ownershipResult = AppointmentRepository.setB6LifecycleOwnershipState(
      ctx.phone,
      ctx.ownerToken,
      this.OWNERSHIP_STATES.HELD_UNRESOLVED,
      { recoveryCaseId: ctx.recoveryCaseId, unresolvedReason: reason }
    );

    var ownershipState = ownershipResult.ok
      ? this.OWNERSHIP_STATES.HELD_UNRESOLVED
      : this.OWNERSHIP_STATES.HELD_UNRESOLVED;

    var lifecycleRecord = this._buildRecord(
      ctx,
      this.LIFECYCLE_STATES.UNRESOLVED,
      ownershipState,
      ctx.lastCheckpoint || this.CHECKPOINTS.OWNERSHIP_ACQUIRED,
      {
        recovery_state: this.LIFECYCLE_STATES.RECOVERY_REQUIRED,
        recovery_case_id: ctx.recoveryCaseId,
        details: this._details({ reason: reason, details: details || null })
      }
    );

    var lifecycleResult = B6LifecycleRepository.appendCheckpoint(lifecycleRecord);
    var auditResult = B6RecoveryAuditRepository.append({
      recovery_case_id: ctx.recoveryCaseId,
      operation_id: ctx.operationId,
      operator_id: '',
      phone: ctx.phone,
      old_slot_id: ctx.oldSlotId,
      new_slot_id: ctx.newSlotId,
      initial_state: ctx.lifecycleState || this.LIFECYCLE_STATES.ACTIVE_PRE_EFFECT,
      evidence_summary: this._details({ reason: reason, details: details || null }),
      decision: this.LIFECYCLE_STATES.RECOVERY_REQUIRED,
      verification_result: lifecycleResult.ok ? 'RECOVERY_STATE_RECORDED' : 'LIFECYCLE_RECORD_AMBIGUOUS',
      release_result: 'OWNERSHIP_RETAINED'
    });

    var alertResult = B6RecoveryAlertRepository.notifyRecoveryRequired({
      operationId: ctx.operationId,
      recoveryCaseId: ctx.recoveryCaseId,
      reason: reason
    });

    this._diagnostic('B6_RECOVERY_REQUIRED', ctx.phone, ctx.oldSlotId, {
      reason: reason,
      operationId: ctx.operationId,
      recoveryCaseId: ctx.recoveryCaseId,
      ownershipResult: ownershipResult.ok ? null : ownershipResult.error,
      lifecycleResult: lifecycleResult.ok ? null : lifecycleResult.error,
      auditResult: auditResult.ok ? null : auditResult.error,
      alertResult: alertResult.ok ? null : alertResult.error
    });

    ctx.lifecycleState = this.LIFECYCLE_STATES.UNRESOLVED;
    ctx.ownershipState = this.OWNERSHIP_STATES.HELD_UNRESOLVED;

    return Result.fail(
      'RECOVERY_REQUIRED',
      'B6 lifecycle entered recovery-required state',
      {
        operationId: ctx.operationId,
        recoveryCaseId: ctx.recoveryCaseId,
        reason: reason,
        lifecycleRecorded: lifecycleResult.ok,
        auditRecorded: auditResult.ok,
        alertSent: alertResult.ok
      }
    );
  },

  rejectNoEffect: function(ctx, reason, details) {
    var rejected = this.recordCheckpoint(
      ctx,
      this.LIFECYCLE_STATES.REJECTED_NO_EFFECT,
      this.OWNERSHIP_STATES.HELD_ACTIVE,
      ctx.lastCheckpoint || this.CHECKPOINTS.OWNERSHIP_ACQUIRED,
      { details: this._details({ reason: reason, details: details || null }) }
    );
    if (!rejected.ok) {
      return this.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', rejected.error);
    }

    return this._releaseAfterTerminal(
      ctx,
      this.LIFECYCLE_STATES.REJECTED_NO_EFFECT,
      ctx.lastCheckpoint || this.CHECKPOINTS.OWNERSHIP_ACQUIRED
    );
  },

  completeTerminalChange: function(ctx) {
    return this._releaseAfterTerminal(
      ctx,
      this.LIFECYCLE_STATES.RESOLVED_CHANGE,
      this.CHECKPOINTS.TERMINAL_CHANGE_PROVEN
    );
  },

  completeTerminalCancel: function(ctx) {
    return this._releaseAfterTerminal(
      ctx,
      this.LIFECYCLE_STATES.RESOLVED_CANCEL,
      this.CHECKPOINTS.TERMINAL_CANCEL_PROVEN
    );
  },

  _releaseAfterTerminal: function(ctx, terminalState, terminalCheckpoint) {
    var terminal = this.recordCheckpoint(
      ctx,
      terminalState,
      this.OWNERSHIP_STATES.HELD_ACTIVE,
      terminalCheckpoint,
      {}
    );
    if (!terminal.ok) return this.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', terminal.error);

    // A recovery case identity is checkpointed before the final Properties
    // release boundary. If the post-release journal append is ambiguous, a
    // trusted recovery caller has a durable case reference and normal admission
    // remains blocked by the RELEASE_PENDING journal entry.
    if (!ctx.recoveryCaseId) ctx.recoveryCaseId = 'RCV_' + ULID.generate();

    var stateResult = AppointmentRepository.setB6LifecycleOwnershipState(
      ctx.phone,
      ctx.ownerToken,
      this.OWNERSHIP_STATES.RELEASE_PENDING,
      { terminalState: terminalState, recoveryCaseId: ctx.recoveryCaseId }
    );
    if (!stateResult.ok) {
      return this.enterUnresolved(ctx, 'RELEASE_PENDING_PERSISTENCE_UNKNOWN', stateResult.error);
    }

    var pending = this.recordCheckpoint(
      ctx,
      this.LIFECYCLE_STATES.RELEASE_PENDING,
      this.OWNERSHIP_STATES.RELEASE_PENDING,
      this.CHECKPOINTS.RELEASE_PENDING,
      {}
    );
    if (!pending.ok) return this.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', pending.error);

    var releaseResult = AppointmentRepository.releaseB6LifecycleOwnership(ctx.phone, ctx.ownerToken);
    if (!releaseResult.ok) {
      B6RecoveryAuditRepository.append({
        recovery_case_id: ctx.recoveryCaseId || '',
        operation_id: ctx.operationId,
        operator_id: '',
        phone: ctx.phone,
        old_slot_id: ctx.oldSlotId,
        new_slot_id: ctx.newSlotId,
        initial_state: terminalState,
        evidence_summary: 'Terminal proof exists; ownership release did not complete.',
        decision: this.LIFECYCLE_STATES.RELEASE_PENDING,
        verification_result: 'TERMINAL_PROVEN',
        release_result: 'RELEASE_FAILED'
      });
      this._diagnostic('B6_RELEASE_FAILED', ctx.phone, ctx.oldSlotId, releaseResult.error);
      return Result.ok({
        terminalState: terminalState,
        releasePending: true,
        releaseError: releaseResult.error
      });
    }

    var released = this.recordCheckpoint(
      ctx,
      this.LIFECYCLE_STATES.RELEASED,
      this.OWNERSHIP_STATES.RELEASED,
      this.CHECKPOINTS.RELEASED,
      {}
    );
    if (!released.ok) {
      // Properties ownership is already absent. The prior RELEASE_PENDING
      // journal entry intentionally blocks a later normal admission until a
      // trusted recovery inspection records the missing release evidence.
      B6RecoveryAuditRepository.append({
        recovery_case_id: ctx.recoveryCaseId,
        operation_id: ctx.operationId,
        operator_id: '',
        phone: ctx.phone,
        old_slot_id: ctx.oldSlotId,
        new_slot_id: ctx.newSlotId,
        initial_state: terminalState,
        evidence_summary: 'Ownership release succeeded but RELEASED checkpoint persistence is ambiguous.',
        decision: this.LIFECYCLE_STATES.RECOVERY_REQUIRED,
        verification_result: 'TERMINAL_PROVEN_RELEASE_CHECKPOINT_UNKNOWN',
        release_result: 'PROPERTY_RELEASED_JOURNAL_UNCONFIRMED'
      });
      B6RecoveryAlertRepository.notifyRecoveryRequired({
        operationId: ctx.operationId,
        recoveryCaseId: ctx.recoveryCaseId,
        reason: 'RELEASE_CHECKPOINT_PERSISTENCE_UNKNOWN'
      });
      this._diagnostic('B6_RELEASE_CHECKPOINT_UNKNOWN', ctx.phone, ctx.oldSlotId, released.error);
      return Result.ok({
        terminalState: terminalState,
        released: true,
        releaseCheckpointUnknown: true,
        recoveryCaseId: ctx.recoveryCaseId
      });
    }

    return Result.ok({ terminalState: terminalState, released: true });
  },

  verifyReplacementAppointment: function(ctx) {
    var replacementResult = this._getSlotById(ctx.newSlotId);
    if (!replacementResult.ok) return replacementResult;
    var replacement = replacementResult.data;

    if (!replacement || replacement.status !== Config.VOCABULARY.STATUS.CONFIRMED ||
      replacement.phone !== ctx.phone || !replacement.calendar_event_id) {
      return Result.fail('B6_REPLACEMENT_PROOF_FAILED', 'Replacement Slot is not a proven confirmed appointment');
    }

    var inspection = CalendarRepository.inspectLifecycleAppointmentEvent(
      replacement.calendar_event_id,
      ctx.calendarId,
      ctx.operationId
    );
    if (!inspection.ok || !inspection.data || inspection.data.status !== 'MATCH') {
      return Result.fail(
        'B6_REPLACEMENT_CALENDAR_PROOF_FAILED',
        'Replacement Calendar event is not proven',
        inspection.ok ? inspection.data : inspection.error
      );
    }

    var windowResult = this._calendarWindowForSlot(replacement);
    if (!windowResult.ok) return windowResult;
    var matchesResult = CalendarRepository.findLifecycleEventsByOperationId(
      ctx.operationId,
      windowResult.data.start,
      windowResult.data.end,
      ctx.calendarId
    );
    if (!matchesResult.ok) return matchesResult;

    var matches = matchesResult.data.matches || [];
    if (matches.length !== 1 || matches[0].eventId !== replacement.calendar_event_id) {
      return Result.fail(
        'B6_CALENDAR_CORRELATION_AMBIGUOUS',
        'Operation correlation did not produce exactly one replacement event',
        { count: matches.length, expectedEventId: replacement.calendar_event_id }
      );
    }

    ctx.newSlot = replacement;
    ctx.newSlotId = replacement.slot_id;
    ctx.calendarEventId = replacement.calendar_event_id;
    return Result.ok(replacement);
  },

  verifyTerminalChange: function(ctx) {
    var replacementResult = this.verifyReplacementAppointment(ctx);
    if (!replacementResult.ok) return replacementResult;

    if (!ctx.oldCalendarDeleteResult || !ctx.oldCalendarDeleteResult.deleteConfirmed ||
      !ctx.oldCalendarDeleteResult.absenceObserved) {
      return Result.fail('B6_OLD_CALENDAR_ABSENCE_NOT_PROVEN', 'Old Calendar absence has not been proven');
    }

    var oldAbsence = CalendarRepository.inspectLifecycleAppointmentEvent(
      ctx.oldCalendarEventId,
      ctx.oldCalendarId || ctx.calendarId,
      null
    );
    if (!oldAbsence.ok || !oldAbsence.data || oldAbsence.data.status !== 'NOT_FOUND' ||
      !oldAbsence.data.contextResolved) {
      return Result.fail(
        'B6_OLD_CALENDAR_ABSENCE_NOT_PROVEN',
        'Old Calendar event absence observation is not sufficient',
        oldAbsence.ok ? oldAbsence.data : oldAbsence.error
      );
    }

    var oldResult = this._getSlotById(ctx.oldSlotId);
    if (!oldResult.ok) return oldResult;
    if (!this._isFullFreeSlot(oldResult.data)) {
      return Result.fail('B6_OLD_SLOT_RECONCILIATION_FAILED', 'Old Slot is not fully reconciled to FREE');
    }

    var activeResult = SlotRepository.queryResult(function(slot) {
      return slot.phone === ctx.phone && slot.status === Config.VOCABULARY.STATUS.CONFIRMED;
    });
    if (!activeResult.ok) return activeResult;
    if (activeResult.data.length !== 1 || activeResult.data[0].slot_id !== ctx.newSlotId) {
      return Result.fail(
        'B6_TERMINAL_CHANGE_PROOF_FAILED',
        'Exactly one replacement confirmed Slot was not proven',
        { activeCount: activeResult.data.length }
      );
    }

    return Result.ok({ oldSlot: oldResult.data, replacementSlot: replacementResult.data });
  },

  verifyTerminalCancel: function(ctx) {
    if (!ctx.oldCalendarDeleteResult || !ctx.oldCalendarDeleteResult.deleteConfirmed ||
      !ctx.oldCalendarDeleteResult.absenceObserved) {
      return Result.fail('B6_TARGET_CALENDAR_ABSENCE_NOT_PROVEN', 'Target Calendar absence has not been proven');
    }

    var absence = CalendarRepository.inspectLifecycleAppointmentEvent(
      ctx.oldCalendarEventId,
      ctx.oldCalendarId || ctx.calendarId,
      null
    );
    if (!absence.ok || !absence.data || absence.data.status !== 'NOT_FOUND' ||
      !absence.data.contextResolved) {
      return Result.fail(
        'B6_TARGET_CALENDAR_ABSENCE_NOT_PROVEN',
        'Target Calendar absence observation is not sufficient',
        absence.ok ? absence.data : absence.error
      );
    }

    var targetResult = this._getSlotById(ctx.oldSlotId);
    if (!targetResult.ok) return targetResult;
    if (!this._isFullFreeSlot(targetResult.data)) {
      return Result.fail('B6_TARGET_SLOT_RECONCILIATION_FAILED', 'Target Slot is not fully reconciled to FREE');
    }

    var activeResult = SlotRepository.queryResult(function(slot) {
      return slot.phone === ctx.phone && slot.status === Config.VOCABULARY.STATUS.CONFIRMED;
    });
    if (!activeResult.ok) return activeResult;
    if (activeResult.data.length !== 0) {
      return Result.fail(
        'B6_CANCEL_TARGET_AMBIGUOUS',
        'A confirmed appointment remains after target cancellation',
        { activeCount: activeResult.data.length }
      );
    }

    return Result.ok({ targetSlot: targetResult.data });
  },

  recoverRecoveryCase: function(recoveryCaseId, authorizationContext) {
    if (!authorizationContext || !authorizationContext.operatorId ||
      authorizationContext.authorityType !== 'DOCTOR') {
      return Result.fail(
        'B6_RECOVERY_AUTHORIZATION_REQUIRED',
        'Recovery requires a trusted Doctor authorization context'
      );
    }

    var lifecycleResult = B6LifecycleRepository.latestByRecoveryCaseId(recoveryCaseId);
    if (!lifecycleResult.ok) return lifecycleResult;
    var lifecycle = lifecycleResult.data;
    if (!lifecycle) {
      return Result.fail('B6_RECOVERY_CASE_NOT_FOUND', 'Recovery case does not exist');
    }

    var recoveryOwnership = AppointmentRepository.beginB6RecoveryOwnership(
      lifecycle.phone,
      recoveryCaseId,
      lifecycle.operation_id
    );
    if (!recoveryOwnership.ok) return recoveryOwnership;

    var recoveryCheckpoint = B6LifecycleRepository.appendCheckpoint({
      operation_id: lifecycle.operation_id,
      phone: lifecycle.phone,
      command: lifecycle.command,
      old_slot_id: lifecycle.old_slot_id,
      new_slot_id: lifecycle.new_slot_id,
      lifecycle_state: this.LIFECYCLE_STATES.RECOVERY_REQUIRED,
      ownership_state: this.OWNERSHIP_STATES.HELD_RECOVERY,
      checkpoint: lifecycle.checkpoint,
      calendar_event_id: lifecycle.calendar_event_id,
      calendar_correlation_id: lifecycle.calendar_correlation_id,
      calendar_id: lifecycle.calendar_id,
      recovery_state: this.LIFECYCLE_STATES.RECOVERY_REQUIRED,
      recovery_case_id: recoveryCaseId,
      created_at: lifecycle.created_at,
      details: this._details({ trustedOperator: authorizationContext.operatorId })
    });
    if (!recoveryCheckpoint.ok) {
      return Result.fail(
        'B6_CHECKPOINT_PERSISTENCE_UNKNOWN',
        'Recovery checkpoint write is ambiguous; ownership remains retained',
        recoveryCheckpoint.error
      );
    }

    var evidenceResult = this._collectRecoveryEvidence(lifecycle);
    var evidence = evidenceResult.ok
      ? evidenceResult.data
      : { collectionError: evidenceResult.error };

    var auditResult = B6RecoveryAuditRepository.append({
      recovery_case_id: recoveryCaseId,
      operation_id: lifecycle.operation_id,
      operator_id: authorizationContext.operatorId,
      phone: lifecycle.phone,
      old_slot_id: lifecycle.old_slot_id,
      new_slot_id: lifecycle.new_slot_id,
      initial_state: lifecycle.lifecycle_state,
      evidence_summary: this._details({
        recoveryBoundary: 'INTERNAL_ONLY',
        calendarEvidence: evidence,
        automaticReconciliation: false
      }),
      decision: this.LIFECYCLE_STATES.RECOVERY_REQUIRED,
      verification_result: evidenceResult.ok ? 'EVIDENCE_COLLECTED_MANUAL_DECISION_REQUIRED' : 'EVIDENCE_COLLECTION_INCOMPLETE',
      release_result: 'OWNERSHIP_RETAINED'
    });

    if (!auditResult.ok) {
      return Result.fail(
        'B6_RECOVERY_AUDIT_PERSISTENCE_UNKNOWN',
        'Recovery audit write is ambiguous; ownership remains retained',
        auditResult.error
      );
    }

    this._diagnostic('B6_RECOVERY_INSPECTED', lifecycle.phone, lifecycle.old_slot_id, {
      recoveryCaseId: recoveryCaseId,
      operationId: lifecycle.operation_id,
      operatorId: authorizationContext.operatorId
    });

    return Result.ok({
      recoveryCaseId: recoveryCaseId,
      operationId: lifecycle.operation_id,
      lifecycleState: this.LIFECYCLE_STATES.RECOVERY_REQUIRED,
      ownershipState: this.OWNERSHIP_STATES.HELD_RECOVERY,
      automaticResolution: false
    });
  },

  _collectRecoveryEvidence: function(lifecycle) {
    var evidence = {
      knownEvent: null,
      correlation: null
    };

    if (lifecycle.calendar_event_id) {
      var known = CalendarRepository.inspectLifecycleAppointmentEvent(
        lifecycle.calendar_event_id,
        lifecycle.calendar_id || '',
        lifecycle.calendar_correlation_id || null
      );
      evidence.knownEvent = known.ok ? known.data : { lookupError: known.error };
    }

    if (lifecycle.calendar_correlation_id) {
      var candidateSlotId = lifecycle.new_slot_id || lifecycle.old_slot_id;
      var slotResult = this._getSlotById(candidateSlotId);
      if (!slotResult.ok) {
        evidence.correlation = { slotEvidenceError: slotResult.error };
      } else {
        var windowResult = this._calendarWindowForSlot(slotResult.data);
        if (!windowResult.ok) {
          evidence.correlation = { windowEvidenceError: windowResult.error };
        } else {
          var matches = CalendarRepository.findLifecycleEventsByOperationId(
            lifecycle.calendar_correlation_id,
            windowResult.data.start,
            windowResult.data.end,
            lifecycle.calendar_id || ''
          );
          if (!matches.ok) {
            evidence.correlation = { lookupError: matches.error };
          } else {
            var count = (matches.data.matches || []).length;
            evidence.correlation = {
              matchCount: count,
              result: count === 0 ? 'ZERO_MATCH_UNRESOLVED' :
                (count === 1 ? 'ONE_CANDIDATE_EVIDENCE' : 'MANY_MATCHES_UNRESOLVED'),
              matches: matches.data.matches || []
            };
          }
        }
      }
    }

    return Result.ok(evidence);
  },

  _ensureStores: function() {
    var lifecycle = B6LifecycleRepository.ensureStore();
    if (!lifecycle.ok) return lifecycle;
    return B6RecoveryAuditRepository.ensureStore();
  },

  _isBlockingJournalRecord: function(record) {
    if (!record) return false;
    var lifecycleState = record.lifecycle_state;
    var ownershipState = record.ownership_state;
    return lifecycleState === this.LIFECYCLE_STATES.ACTIVE_PRE_EFFECT ||
      lifecycleState === this.LIFECYCLE_STATES.ACTIVE_POST_EFFECT ||
      lifecycleState === this.LIFECYCLE_STATES.UNRESOLVED ||
      lifecycleState === this.LIFECYCLE_STATES.RECOVERY_REQUIRED ||
      lifecycleState === this.LIFECYCLE_STATES.RELEASE_PENDING ||
      ownershipState === this.OWNERSHIP_STATES.HELD_ACTIVE ||
      ownershipState === this.OWNERSHIP_STATES.HELD_UNRESOLVED ||
      ownershipState === this.OWNERSHIP_STATES.HELD_RECOVERY ||
      ownershipState === this.OWNERSHIP_STATES.RELEASE_PENDING;
  },

  _buildRecord: function(ctx, lifecycleState, ownershipState, checkpoint, patch) {
    var patchData = patch || {};
    return {
      operation_id: ctx.operationId,
      phone: ctx.phone,
      command: ctx.command,
      old_slot_id: ctx.oldSlotId || '',
      new_slot_id: ctx.newSlotId || '',
      lifecycle_state: lifecycleState,
      ownership_state: ownershipState,
      checkpoint: checkpoint,
      calendar_event_id: patchData.calendar_event_id || ctx.calendarEventId || '',
      calendar_correlation_id: patchData.calendar_correlation_id || ctx.calendarCorrelationId || '',
      calendar_id: patchData.calendar_id || ctx.calendarId || '',
      recovery_state: patchData.recovery_state || '',
      recovery_case_id: patchData.recovery_case_id || ctx.recoveryCaseId || '',
      created_at: ctx.createdAt || Clock.now(),
      details: patchData.details || ''
    };
  },

  _applyPatch: function(ctx, patch) {
    if (!patch) return;
    if (patch.calendar_event_id) ctx.calendarEventId = patch.calendar_event_id;
    if (patch.calendar_id) ctx.calendarId = patch.calendar_id;
    if (patch.recovery_case_id) ctx.recoveryCaseId = patch.recovery_case_id;
  },

  _getSlotById: function(slotId) {
    var queryResult = SlotRepository.queryResult(function(slot) {
      return slot.slot_id === slotId;
    });
    if (!queryResult.ok) return queryResult;
    if (queryResult.data.length !== 1) {
      return Result.fail('B6_SLOT_IDENTITY_NOT_PROVEN', 'Expected exactly one Slot for ' + slotId);
    }
    return Result.ok(queryResult.data[0]);
  },

  _isFullFreeSlot: function(slot) {
    if (!slot || slot.status !== Config.VOCABULARY.STATUS.FREE) return false;
    return this._isBlank(slot.phone) &&
      this._isBlank(slot.patient_name) &&
      this._isBlank(slot.calendar_event_id) &&
      this._isBlank(slot.reserved_until) &&
      this._isBlank(slot.reserved_until_unix);
  },

  _isBlank: function(value) {
    return value === '' || value === null || value === undefined;
  },

  _calendarWindowForSlot: function(slot) {
    var startMs = LegacySlotTimeParser.toComparableTime(slot && slot.sort_key);
    if (startMs === null) {
      return Result.fail('B6_CALENDAR_WINDOW_UNAVAILABLE', 'Slot sort_key cannot establish Calendar lookup window');
    }

    var start = DateUtils.fromTimestamp(startMs);
    start.setHours(0, 0, 0, 0);
    var end = DateUtils.addMinutes(start, 24 * 60);
    return Result.ok({ start: start, end: end });
  },

  _details: function(value) {
    try {
      return JSON.stringify(value || {});
    } catch (e) {
      return '{"serialization":"failed"}';
    }
  },

  _diagnostic: function(command, phone, slotId, details) {
    try {
      LogRepository.write({
        timestamp: Clock.now(),
        command: command,
        phone: phone || '',
        slotId: slotId || '',
        stage: 'END',
        success: false,
        durationMs: null,
        error: this._details(details || {})
      });
    } catch (e) {
      // SYSTEM_LOG is diagnostic only; it never authorizes release.
    }
  }
};
