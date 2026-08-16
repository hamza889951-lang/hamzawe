/**
 * CancelService
 *
 * B6 routes confirmed-appointment cancellation through the same durable
 * lifecycle ownership boundary used by confirmed Change. No public recovery
 * endpoint or authentication system is introduced here.
 */
const CancelService = {

  cancelAppointment(rawPhone) {
    const normalizedPhone = PhoneUtils.normalize(rawPhone);
    const phoneCheck = Validators.validatePhone(normalizedPhone);
    if (!phoneCheck.ok) return phoneCheck;
    const phone = phoneCheck.data;

    const lifecycleResult = B6LifecycleService.begin(
      phone,
      B6LifecycleService.COMMANDS.CANCEL
    );
    if (!lifecycleResult.ok) return CancelService._b6FailureReply();

    const ctx = lifecycleResult.data;
    const targetSlot = ctx.oldSlot;
    if (!targetSlot || !targetSlot.calendar_event_id) {
      B6LifecycleService.enterUnresolved(
        ctx,
        'AUTHORITATIVE_TARGET_APPOINTMENT_INCOMPLETE',
        { oldSlotId: ctx.oldSlotId }
      );
      return CancelService._b6FailureReply();
    }

    ctx.oldCalendarEventId = targetSlot.calendar_event_id;
    const targetCalendarInspection = CalendarRepository.inspectLifecycleAppointmentEvent(
      ctx.oldCalendarEventId,
      '',
      null
    );
    if (!targetCalendarInspection.ok || !targetCalendarInspection.data ||
      targetCalendarInspection.data.status !== 'MATCH' ||
      !targetCalendarInspection.data.contextResolved) {
      B6LifecycleService.enterUnresolved(
        ctx,
        'AUTHORITATIVE_TARGET_CALENDAR_CONTEXT_UNAVAILABLE',
        targetCalendarInspection.ok ? targetCalendarInspection.data : targetCalendarInspection.error
      );
      return CancelService._b6FailureReply();
    }
    ctx.oldCalendarId = targetCalendarInspection.data.calendarId;

    let checkpointResult = B6LifecycleService.recordCheckpoint(
      ctx,
      B6LifecycleService.LIFECYCLE_STATES.ACTIVE_PRE_EFFECT,
      B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
      B6LifecycleService.CHECKPOINTS.TARGET_APPOINTMENT_VERIFIED,
      { details: JSON.stringify({ oldCalendarId: ctx.oldCalendarId }) }
    );
    if (!checkpointResult.ok) {
      B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
      return CancelService._b6FailureReply();
    }

    const commandResult = CommandExecutor.execute(
      Config.VOCABULARY.COMMANDS.CANCEL_APPOINTMENT,
      { phone: phone, slotId: targetSlot.slot_id },
      function() {
        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.CALENDAR_DELETE_ATTEMPTED,
          {}
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const deleteResult = CalendarRepository.deleteLifecycleAppointmentEvent(
          ctx.oldCalendarEventId,
          ctx.oldCalendarId || '',
          null
        );
        if (!deleteResult.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'TARGET_CALENDAR_DELETE_OUTCOME_UNKNOWN',
            deleteResult.error
          );
        }
        ctx.oldCalendarDeleteResult = deleteResult.data;
        ctx.oldCalendarId = deleteResult.data.calendarId;

        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.CALENDAR_DELETE_CONFIRMED,
          { calendar_id: ctx.oldCalendarId }
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const freeResult = SlotRepository.atomicUpdate(targetSlot.slot_id, function(freshSlot) {
          if (freshSlot.phone !== phone) {
            return Result.fail(
              'SLOT_OWNER_MISMATCH',
              'Target Slot no longer belongs to this phone',
              { slotId: freshSlot.slot_id, phone: phone }
            );
          }
          const check = Validators.validateTransition(
            freshSlot.status,
            Config.VOCABULARY.COMMANDS.CANCEL_APPOINTMENT
          );
          if (!check.ok) return check;

          return Result.ok({
            status: Config.VOCABULARY.STATUS.FREE,
            patient_name: '',
            phone: '',
            calendar_event_id: '',
            reserved_until: '',
            reserved_until_unix: ''
          });
        });
        if (!freeResult.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'TARGET_SLOT_FREE_PERSISTENCE_UNKNOWN',
            freeResult.error
          );
        }

        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.SLOT_FREED,
          {}
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const terminalProof = B6LifecycleService.verifyTerminalCancel(ctx);
        if (!terminalProof.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'TERMINAL_CANCEL_PROOF_FAILED',
            terminalProof.error
          );
        }

        return B6LifecycleService.completeTerminalCancel(ctx);
      }
    );

    if (!commandResult.ok) return CancelService._b6FailureReply();

    ConversationRepository.resetToMenuMain(phone);
    return Result.ok({
      reply: 'تم إلغاء حجزك بنجاح. يمكنك حجز موعد جديد بإرسال أي رسالة.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
    });
  },

  _b6FailureReply() {
    return Result.ok({
      reply: 'تعذّر إلغاء الحجز حالياً. الرجاء المحاولة مرة أخرى أو التواصل مع العيادة.',
      conversationState: null
    });
  }
};
