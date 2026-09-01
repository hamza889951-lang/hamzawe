/**
 * ═══════════════════════════════════════
 * CONTRACT — ChangeService
 * ═══════════════════════════════════════
 * يضمن:
 * - نقطتي دخول منفصلتين لعمليتين مختلفتين تمامًا في الأثر على النظام
 *   (قرار معماري صريح من المشرف):
 *
 *   1) changeReservation(rawPhone)
 *      تغيير حجز لم يُؤكَّد بعد (الحالة RESERVED). لا يوجد حدث تقويم،
 *      لا يوجد Appointment فعلي. العملية بأكملها على مورد واحد (Slot).
 *
 *   2) changeConfirmedAppointment(rawPhone)
 *      تغيير موعد مؤكَّد فعليًا (الحالة CONFIRMED). يوجد حدث تقويم،
 *      وتوجد نقطة فشل جزئي محتملة بين موردين (Slot + Calendar).
 *
 * - عدم استدعاء أي Service آخر إطلاقًا (ADR-013).
 * - يعيد كل من نقطتي الدخول Result يحمل { reply, conversationState }.
 *
 * لا يضمن:
 * - تحديد أي من نقطتي الدخول يجب استدعاؤها — هذا قرار طبقة أعلى
 *   (Router/Webhook مستقبلاً) بناءً على حالة المحادثة الحالية.
 * - اختيار المستخدم اليدوي لفتحة بديلة — يُعتمد دائمًا أقرب فتحة متاحة
 *   عبر SlotSelection.findEarliestBookable() (ADR-019).
 *
 * ═══════════════════════════════════════
 * سياسة الفشل الجزئي: Patient-retention-first (قرار مشرف مُلزم)
 * ═══════════════════════════════════════
 * — changeReservation —
 * الترتيب: حجز الجديد (RESERVED) ← ثم تحرير القديم (FREE).
 * إن فشل حجز الجديد: القديم يبقى سليمًا كما هو (لا ضرر).
 * إن نجح حجز الجديد وفشل تحرير القديم: يبقى للهاتف حجزان مؤقتان
 * (RESERVED) في آن واحد — أثر جانبي مقبول، MaintenanceService ينظفه.
 *
 * — changeConfirmedAppointment —
 * ═══ تمييز صريح بين "نجاح العملية الأساسية" و"تنظيف ما بعد الالتزام" ═══
 * (تعديل بقرار مشرف: كان التوثيق سابقًا يصف هذا الفصل لفظيًا فقط، دون
 * أن ينعكس فعليًا في الكود؛ هذه النسخة تُصلح التعارض).
 *
 * • الخطوات 1-6 = "نجاح العملية الأساسية" (Core Success):
 *     1. إيجاد الموعد القديم CONFIRMED
 *     2. إيجاد فتحة جديدة FREE (عبر SlotSelection)
 *     3. حجز الفتحة الجديدة → RESERVED
 *     4. تأكيد الفتحة الجديدة → CONFIRMED
 *     5. إنشاء Calendar Event جديد
 *     6. تخزين calendar_event_id على الفتحة الجديدة
 *   بمجرد نجاح الخطوة 6، الموعد الجديد هو الموعد الفعلي والصالح
 *   للمريض. هذه الخطوات الستة فقط هي ما يحدد نجاح/فشل CommandExecutor
 *   الرئيسي (CHANGE_APPOINTMENT) وما يُبنى عليه رد المستخدم.
 *
 * • الخطوتان 7-8 = "تنظيف ما بعد الالتزام" (Post-Commit Cleanup):
 *     7. حذف Calendar Event القديم
 *     8. تحرير الفتحة القديمة إلى FREE
 *   تُنفَّذان بعد إرجاع نتيجة النجاح الأساسية، عبر _cleanupOldAppointment.
 *   فشل أي منهما:
 *     - يُسجَّل بوضوح في LOG_SYSTEM (سجل CLEANUP_FAILED منفصل، عبر
 *       LogRepository مباشرة — وليس عبر فشل CommandExecutor الرئيسي).
 *     - لا يُحوَّل أبدًا إلى رسالة فشل للمستخدم. المستخدم يملك موعدًا
 *       جديدًا صالحًا بغض النظر عن نتيجة التنظيف.
 *   الأثر المتبقي عند فشل التنظيف: حدث تقويم قديم عالق و/أو فتحة قديمة
 *   CONFIRMED عالقة — يتطلب مراجعة يدوية لاحقة عبر LOG_SYSTEM، وهذا
 *   مقبول صراحةً لأنه لا يمس تجربة المريض إطلاقًا (يتوافق مع
 *   Patient-retention-first).
 *   ⚠️ إن فشل حذف حدث التقويم القديم تحديدًا (الخطوة 7)، لا تُنفَّذ
 *   الخطوة 8 (تحرير الفتحة): تحرير الفتحة سيمسح calendar_event_id
 *   المخزَّن، فيفقد أي مراجع لاحق القدرة على تتبع الحدث اليتيم في
 *   Google Calendar لحذفه يدويًا. تبقى الفتحة القديمة CONFIRMED عمدًا
 *   لحفظ هذا المرجع حتى المراجعة اليدوية.
 *
 * ═══════════════════════════════════════
 * فحص هوية المالك (قرار مشرف مُلزم — إصلاح ثغرة اتساق)
 * ═══════════════════════════════════════
 * كل عملية atomicUpdate تلمس فتحة "قديمة" أو "فتحة جديدة تخص هذا
 * الهاتف تحديدًا" تتحقق أولاً أن freshSlot.phone === phone الحالي،
 * وتفشل بوضوح (SLOT_OWNER_MISMATCH) قبل أي تنفيذ إن لم يتطابق.
 *
 * ═══════════════════════════════════════
 * قرارات المشرف المثبَّتة الأخرى
 * ═══════════════════════════════════════
 * - Command واحد فقط CHANGE_APPOINTMENT لكلا المسارين، ولعمليتي النجاح
 *   الأساسي والتنظيف كليهما (التنظيف يُسجَّل بمرحلة CLEANUP_FAILED
 *   تحت نفس اسم الأمر، لا Command جديد).
 * - اختيار الفتحة البديلة عبر SlotSelection.findEarliestBookable() فقط.
 * - مدة الفتحة عبر SettingsRepository.getSlotDurationMinutes() فقط.
 * - إصلاح عرض (بعد مراجعة الشيت الفعلي): date/time المستخدَمان في نص
 *   الرد يمران الآن عبر DateUtils.formatDateDisplay()/formatTimeDisplay()
 *   بدل دمج كائن Date الخام مباشرة (نفس الإصلاح في BookingService).
 * - أمر تنفيذ معماري (Separation of Internal Time Model and Patient
 *   Presentation): كلا الردين (قبل/بعد التأكيد) يعرضان الآن "رقم
 *   الباص" عبر Utils/BusNumberCalculator.gs بدل التاريخ/الوقت، مع
 *   تراجع احتياطي للتاريخ/الوقت إن تعذّر الحساب. عنوان/وصف حدث
 *   Google Calendar في changeConfirmedAppointment يعرضان رقم الباص
 *   أيضًا (Projection بحت — startTime/endTime لم يتغيّرا).
 */
const ChangeService = {

  // ─────────────────────────────────────
  // المسار الأول: تغيير قبل التأكيد
  // ─────────────────────────────────────

  /**
   * يغيّر فتحة محجوزة (RESERVED) غير مؤكَّدة بعد إلى فتحة أخرى.
   * لا علاقة له بـ Google Calendar إطلاقًا.
   *
   * @param {string} rawPhone
   * @returns {Result} data: { reply: string, conversationState: string|null }
   */
  changeReservation(rawPhone) {
    const normalizedPhone = PhoneUtils.normalize(rawPhone);
    const phoneCheck = Validators.validatePhone(normalizedPhone);
    if (!phoneCheck.ok) return phoneCheck;
    const phone = phoneCheck.data;

    const oldSlot = SlotRepository.findByPhoneAndStatus(
      phone, Config.VOCABULARY.STATUS.RESERVED
    );
    if (!oldSlot) {
      return Result.ok({
        reply: 'لا يوجد لديك حجز غير مؤكَّد حاليًا لتغييره.',
        conversationState: null
      });
    }

    const commandResult = CommandExecutor.execute(
      Config.VOCABULARY.COMMANDS.CHANGE_APPOINTMENT,
      { phone: phone, slotId: oldSlot.slot_id },
      function() {
        const reservedUntil = DateUtils.addMinutes(
          Clock.now(),
          Config.SYSTEM_POLICY.RESERVATION_TIMEOUT_MINUTES
        );

        // ── حجز الجديدة أولاً — القديمة تبقى سليمة إن فشلت هذه ──
        const reserveResult = ChangeService._reserveAlternativeSlot(
          phone,
          oldSlot.patient_name,
          reservedUntil,
          oldSlot.slot_id
        );
        if (!reserveResult.ok) return reserveResult;

        const newSlot = reserveResult.data.slot;

        // ── تحرير القديمة — فقط بعد تأمين الجديدة ──
        const freeResult = SlotRepository.atomicUpdate(oldSlot.slot_id, function(freshOld) {
          if (freshOld.phone !== phone) {
            return Result.fail(
              'SLOT_OWNER_MISMATCH',
              'Slot no longer belongs to this phone',
              { slotId: freshOld.slot_id, phone: phone }
            );
          }
          const check = Validators.validateTransition(
            freshOld.status,
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
        if (!freeResult.ok) return freeResult;

        // ── أمر تنفيذ معماري: رقم الباص قيمة عرض مشتقة، تُحسب هنا فقط ──
        const busResult = BusNumberCalculator.fromSlot(newSlot);

        return Result.ok({
          slotId: newSlot.slot_id,
          date: newSlot.date,
          time: newSlot.time,
          busNumber: busResult.ok ? busResult.data.busNumber : null
        });
      }
    );

    if (!commandResult.ok) {
      return Result.ok({
        reply: 'تعذّر تغيير الحجز حاليًا. الرجاء المحاولة مرة أخرى.',
        conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION
      });
    }

    ConversationRepository.moveToWaitingConfirmation(
      phone, oldSlot.patient_name, commandResult.data.slotId
    );

    // ── قرار مالك المشروع: التاريخ يبقى ظاهرًا دائمًا مع رقم الباص ──
    const preConfirmDisplay = 'بتاريخ ' + DateUtils.formatDateDisplay(commandResult.data.date) +
      ' — ' + (commandResult.data.busNumber !== null
        ? 'الباص رقم: ' + commandResult.data.busNumber
        : 'الساعة ' + DateUtils.formatTimeDisplay(commandResult.data.time));

    return Result.ok({
      reply: 'تم تغيير موعدك المؤقت ' + preConfirmDisplay +
        '. أرسل "1" لتأكيد الحجز.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION
    });
  },

  // ─────────────────────────────────────
  // المسار الثاني: تغيير بعد التأكيد
  // ─────────────────────────────────────

  /**
   * يغيّر موعدًا مؤكَّدًا فعليًا (CONFIRMED) إلى فتحة أخرى.
   * نجاح العملية للمستخدم يُحدَّد بالكامل عبر الخطوات 1-6 (Core
   * Success). الخطوتان 7-8 تنظيف ما بعد الالتزام — راجع رأس الملف.
   *
   * @param {string} rawPhone
   * @returns {Result} data: { reply: string, conversationState: string|null }
   */
  /**
   * B6 confirmed-appointment Change. B4's legacy acquireChangeClaim/releaseChangeClaim
   * remains in AppointmentRepository for inventory/migration only; this runtime path
   * uses the shared B6 lifecycle fence also required by CancelService.
   */
  changeConfirmedAppointment(rawPhone) {
    const normalizedPhone = PhoneUtils.normalize(rawPhone);
    const phoneCheck = Validators.validatePhone(normalizedPhone);
    if (!phoneCheck.ok) return phoneCheck;
    const phone = phoneCheck.data;

    const lifecycleResult = B6LifecycleService.begin(
      phone,
      B6LifecycleService.COMMANDS.CHANGE
    );
    if (!lifecycleResult.ok) {
      if (lifecycleResult.error && lifecycleResult.error.code === 'NO_CONFIRMED_APPOINTMENT') {
        return ChangeService._b6NoActiveReply();
      }
      return ChangeService._b6FailureReply();
    }

    const ctx = lifecycleResult.data;
    const oldSlot = ctx.oldSlot;
    if (!oldSlot || !oldSlot.calendar_event_id) {
      B6LifecycleService.enterUnresolved(
        ctx,
        'AUTHORITATIVE_OLD_APPOINTMENT_INCOMPLETE',
        { oldSlotId: ctx.oldSlotId }
      );
      return ChangeService._b6FailureReply();
    }

    ctx.oldCalendarEventId = oldSlot.calendar_event_id;
    const oldCalendarInspection = CalendarRepository.inspectLifecycleAppointmentEvent(
      ctx.oldCalendarEventId,
      '',
      null
    );
    if (!oldCalendarInspection.ok || !oldCalendarInspection.data ||
      oldCalendarInspection.data.status !== 'MATCH' ||
      !oldCalendarInspection.data.contextResolved) {
      B6LifecycleService.enterUnresolved(
        ctx,
        'AUTHORITATIVE_OLD_CALENDAR_CONTEXT_UNAVAILABLE',
        oldCalendarInspection.ok ? oldCalendarInspection.data : oldCalendarInspection.error
      );
      return ChangeService._b6FailureReply();
    }
    ctx.oldCalendarId = oldCalendarInspection.data.calendarId;

    let checkpointResult = B6LifecycleService.recordCheckpoint(
      ctx,
      B6LifecycleService.LIFECYCLE_STATES.ACTIVE_PRE_EFFECT,
      B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
      B6LifecycleService.CHECKPOINTS.OLD_APPOINTMENT_VERIFIED,
      { details: JSON.stringify({ oldCalendarId: ctx.oldCalendarId, oldCalendarEventId: ctx.oldCalendarEventId }) }
    );
    if (!checkpointResult.ok) {
      B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
      return ChangeService._b6FailureReply();
    }

    const commandResult = CommandExecutor.execute(
      Config.VOCABULARY.COMMANDS.CHANGE_APPOINTMENT,
      { phone: phone, slotId: oldSlot.slot_id },
      function() {
        const reservedUntil = DateUtils.addMinutes(
          Clock.now(),
          Config.SYSTEM_POLICY.RESERVATION_TIMEOUT_MINUTES
        );

        const reserveResult = ChangeService._reserveAlternativeSlot(
          phone,
          oldSlot.patient_name,
          reservedUntil,
          oldSlot.slot_id
        );
        if (!reserveResult.ok) {
          if (reserveResult.error && reserveResult.error.code === 'NO_SLOT_AVAILABLE') {
            const rejected = B6LifecycleService.rejectNoEffect(
              ctx,
              'NO_SLOT_AVAILABLE',
              reserveResult.error
            );
            if (!rejected.ok) return rejected;
            return reserveResult;
          }
          return B6LifecycleService.enterUnresolved(
            ctx,
            'NEW_SLOT_RESERVATION_OUTCOME_UNKNOWN',
            reserveResult.error
          );
        }

        const newSlot = reserveResult.data.slot;
        ctx.newSlot = newSlot;
        ctx.newSlotId = newSlot.slot_id;
        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.NEW_SLOT_RESERVED,
          {}
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const confirmResult = SlotRepository.atomicUpdate(newSlot.slot_id, function(freshNew) {
          if (freshNew.phone !== phone) {
            return Result.fail(
              'SLOT_OWNER_MISMATCH',
              'Newly reserved Slot no longer belongs to this phone',
              { slotId: freshNew.slot_id, phone: phone }
            );
          }
          const check = Validators.validateTransition(
            freshNew.status,
            Config.VOCABULARY.COMMANDS.CONFIRM_RESERVATION
          );
          if (!check.ok) return check;
          return Result.ok({ status: Config.VOCABULARY.STATUS.CONFIRMED });
        });
        if (!confirmResult.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'NEW_SLOT_CONFIRMATION_OUTCOME_UNKNOWN',
            confirmResult.error
          );
        }

        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.NEW_SLOT_CONFIRMED,
          {}
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const startMs = LegacySlotTimeParser.toComparableTime(newSlot.sort_key);
        const startTime = startMs !== null ? DateUtils.fromTimestamp(startMs) : null;
        const endTime = startTime
          ? DateUtils.addMinutes(startTime, SettingsRepository.getSlotDurationMinutes())
          : null;
        if (!startTime || !endTime) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'CALENDAR_WINDOW_UNAVAILABLE',
            { slotId: newSlot.slot_id }
          );
        }

        const busResult = BusNumberCalculator.fromSlot(newSlot);
        const eventTitle = busResult.ok
          ? '#' + busResult.data.busNumber + ' | ' + (oldSlot.patient_name || phone)
          : (oldSlot.patient_name || phone);
        const eventDescription = 'رقم الهاتف: ' + phone +
          '\nالوقت الحقيقي: ' + DateUtils.formatTimeDisplay(startTime) +
          '\nslot_id: ' + newSlot.slot_id +
          '\noperation_id: ' + ctx.operationId;

        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.CALENDAR_CREATE_ATTEMPTED,
          {}
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const eventResult = CalendarRepository.createLifecycleAppointmentEvent({
          title: eventTitle,
          startTime: startTime,
          endTime: endTime,
          description: eventDescription,
          operationId: ctx.operationId
        });
        if (!eventResult.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'CALENDAR_CREATE_OUTCOME_UNKNOWN',
            eventResult.error
          );
        }

        ctx.calendarEventId = eventResult.data.eventId;
        ctx.calendarId = eventResult.data.calendarId;
        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.CALENDAR_CREATE_CONFIRMED,
          {
            calendar_event_id: ctx.calendarEventId,
            calendar_id: ctx.calendarId,
            calendar_correlation_id: ctx.operationId
          }
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const storeEventResult = SlotRepository.atomicUpdate(newSlot.slot_id, function(freshNew) {
          if (freshNew.phone !== phone || freshNew.status !== Config.VOCABULARY.STATUS.CONFIRMED) {
            return Result.fail(
              'SLOT_OWNER_MISMATCH',
              'Replacement Slot no longer belongs to this confirmed lifecycle',
              { slotId: freshNew.slot_id, phone: phone }
            );
          }
          return Result.ok({ calendar_event_id: ctx.calendarEventId });
        });
        if (!storeEventResult.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'CALENDAR_EVENT_ID_PERSISTENCE_UNKNOWN',
            storeEventResult.error
          );
        }

        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.CALENDAR_EVENT_ID_PERSISTED,
          { calendar_event_id: ctx.calendarEventId, calendar_id: ctx.calendarId }
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const replacementProof = B6LifecycleService.verifyReplacementAppointment(ctx);
        if (!replacementProof.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'REPLACEMENT_APPOINTMENT_NOT_PROVEN',
            replacementProof.error
          );
        }

        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.OLD_CALENDAR_DELETE_ATTEMPTED,
          { details: JSON.stringify({ oldCalendarId: ctx.oldCalendarId, oldCalendarEventId: ctx.oldCalendarEventId }) }
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const oldDeleteResult = CalendarRepository.deleteLifecycleAppointmentEvent(
          ctx.oldCalendarEventId,
          ctx.oldCalendarId,
          null
        );
        if (!oldDeleteResult.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'OLD_CALENDAR_DELETE_OUTCOME_UNKNOWN',
            oldDeleteResult.error
          );
        }
        ctx.oldCalendarDeleteResult = oldDeleteResult.data;

        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.OLD_CALENDAR_DELETE_CONFIRMED,
          {
            details: JSON.stringify({
              oldCalendarId: ctx.oldCalendarId,
              oldCalendarEventId: ctx.oldCalendarEventId,
              deleteConfirmed: ctx.oldCalendarDeleteResult.deleteConfirmed,
              absenceObserved: ctx.oldCalendarDeleteResult.absenceObserved
            })
          }
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const freeResult = SlotRepository.atomicUpdate(oldSlot.slot_id, function(freshOld) {
          if (freshOld.phone !== phone) {
            return Result.fail(
              'SLOT_OWNER_MISMATCH',
              'Old Slot no longer belongs to this phone',
              { slotId: freshOld.slot_id, phone: phone }
            );
          }
          const check = Validators.validateTransition(
            freshOld.status,
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
            'OLD_SLOT_FREE_PERSISTENCE_UNKNOWN',
            freeResult.error
          );
        }

        checkpointResult = B6LifecycleService.recordCheckpoint(
          ctx,
          B6LifecycleService.LIFECYCLE_STATES.ACTIVE_POST_EFFECT,
          B6LifecycleService.OWNERSHIP_STATES.HELD_ACTIVE,
          B6LifecycleService.CHECKPOINTS.OLD_SLOT_FREED,
          {}
        );
        if (!checkpointResult.ok) {
          return B6LifecycleService.enterUnresolved(ctx, 'CHECKPOINT_PERSISTENCE_UNKNOWN', checkpointResult.error);
        }

        const terminalProof = B6LifecycleService.verifyTerminalChange(ctx);
        if (!terminalProof.ok) {
          return B6LifecycleService.enterUnresolved(
            ctx,
            'TERMINAL_CHANGE_PROOF_FAILED',
            terminalProof.error
          );
        }

        const completion = B6LifecycleService.completeTerminalChange(ctx);
        if (!completion.ok) return completion;

        return Result.ok({
          slotId: newSlot.slot_id,
          date: newSlot.date,
          time: newSlot.time,
          calendarEventId: ctx.calendarEventId,
          busNumber: busResult.ok ? busResult.data.busNumber : null,
          releasePending: completion.data.releasePending === true
        });
      }
    );

    if (!commandResult.ok) return ChangeService._b6FailureReply();

    const confirmedDisplay = 'بتاريخ ' + DateUtils.formatDateDisplay(commandResult.data.date) +
      '\n' + (commandResult.data.busNumber !== null
        ? 'رقم الباص الجديد: ' + commandResult.data.busNumber
        : 'الساعة ' + DateUtils.formatTimeDisplay(commandResult.data.time));

    return Result.ok({
      reply: 'تم تغيير موعدك بنجاح.\n' + confirmedDisplay +
        '\nيرجى الحضور ضمن وقت دوام العيادة.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.BOOKED
    });
  },

  _b6NoActiveReply() {
    return Result.ok({
      reply: 'لا يوجد لديك حجز مؤكَّد حاليًا لتغييره.',
      conversationState: null
    });
  },

  _b6FailureReply() {
    return Result.ok({
      reply: 'تعذّر تغيير موعدك حاليًا. الرجاء المحاولة مرة أخرى أو التواصل مع العيادة.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.BOOKED
    });
  },

  // ─────────────────────────────────────
  // أدوات داخلية (Internal helpers)
  // ─────────────────────────────────────

  /**
   * Selects and atomically reserves an alternative slot. The old slot is
   * always excluded, and each race-lost candidate is excluded for this
   * operation only. One loop iteration is one reservation attempt.
   */
  _reserveAlternativeSlot(phone, patientName, reservedUntil, oldSlotId) {
    const excludedSlotIds = oldSlotId ? [oldSlotId] : [];

    for (let attempt = 0; attempt < 3; attempt++) {
      const selectionResult = SlotSelection.findEarliestBookable(excludedSlotIds);
      if (!selectionResult.ok) return selectionResult;

      const slot = selectionResult.data;
      const updateResult = SlotRepository.atomicUpdate(slot.slot_id, function(freshSlot) {
        const check = Validators.validateTransition(
          freshSlot.status,
          Config.VOCABULARY.COMMANDS.RESERVE_SLOT
        );
        if (!check.ok) return check;

        // M4-C Continuation §12: fresh re-verification inside the per-slot
        // atomic boundary — a stale optimistic candidate must not be
        // reserved after is_available became false. Covers BOTH callers:
        // changeReservation (pre-confirm) and changeConfirmedAppointment
        // (post-confirm replacement reservation).
        if (!SlotRepository.isOperationallyAvailable(freshSlot.is_available)) {
          return Result.fail(
            'SLOT_UNAVAILABLE',
            'Slot is no longer operationally available (is_available=false)',
            { slotId: freshSlot.slot_id }
          );
        }

        return Result.ok({
          status: Config.VOCABULARY.STATUS.RESERVED,
          phone: phone,
          patient_name: patientName,
          reserved_until: reservedUntil,
          reserved_until_unix: reservedUntil.getTime()
        });
      });

      if (updateResult.ok) return Result.ok({ slot: slot });

      if (updateResult.error &&
          (updateResult.error.code === 'INVALID_TRANSITION' ||
           updateResult.error.code === 'SLOT_UNAVAILABLE')) {
        excludedSlotIds.push(slot.slot_id);
        continue;
      }

      return updateResult;
    }

    return Result.fail('NO_SLOT_AVAILABLE', 'No bookable slot found');
  },

  /**
   * تنظيف ما بعد الالتزام (الخطوتان 7-8) لموعد قديم بعد نجاح تأمين
   * الموعد الجديد بالكامل. لا تُرجع Result، ولا يجوز لمستدعيها تحويل
   * فشلها إلى فشل معروض للمستخدم — راجع سياسة Patient-retention-first
   * في رأس الملف. كل فشل هنا يُسجَّل مباشرة في LOG_SYSTEM عبر
   * LogRepository (وليس عبر CommandExecutor، لأن هذا ليس Command
   * مستقلاً بل استمرار داخلي لأمر CHANGE_APPOINTMENT الذي نجح فعلاً).
   *
   * @param {string} phone
   * @param {Object} oldSlot - الفتحة القديمة كما قُرئت قبل بدء العملية
   */
  _cleanupOldConfirmedAppointment(phone, oldSlot) {
    const startedAt = Clock.now();

    try {
      // الخطوة 7: حذف Calendar Event القديم
      if (oldSlot.calendar_event_id) {
        const deleteResult = CalendarRepository.deleteAppointmentEvent(
          oldSlot.calendar_event_id
        );
        if (!deleteResult.ok) {
          LogRepository.write({
            timestamp: Clock.now(),
            command: Config.VOCABULARY.COMMANDS.CHANGE_APPOINTMENT,
            phone: phone,
            slotId: oldSlot.slot_id,
            stage: 'CLEANUP_FAILED',
            success: false,
            durationMs: Clock.now().getTime() - startedAt.getTime(),
            error: 'OLD_CALENDAR_EVENT_DELETE_FAILED: ' + JSON.stringify(deleteResult.error)
          });
          // ⚠️ نتوقف عمدًا هنا ولا ننفذ الخطوة 8: تحرير الفتحة سيمسح
          // calendar_event_id، فتُفقد القدرة على تتبع الحدث اليتيم
          // لحذفه يدويًا لاحقًا. تبقى الفتحة القديمة CONFIRMED عمدًا.
          return;
        }
      }

      // الخطوة 8: تحرير الفتحة القديمة إلى FREE (مع فحص الملكية)
      const freeResult = SlotRepository.atomicUpdate(oldSlot.slot_id, function(freshOld) {
        if (freshOld.phone !== phone) {
          return Result.fail(
            'SLOT_OWNER_MISMATCH',
            'Old slot no longer belongs to this phone',
            { slotId: freshOld.slot_id, phone: phone }
          );
        }
        const check = Validators.validateTransition(
          freshOld.status,
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
        LogRepository.write({
          timestamp: Clock.now(),
          command: Config.VOCABULARY.COMMANDS.CHANGE_APPOINTMENT,
          phone: phone,
          slotId: oldSlot.slot_id,
          stage: 'CLEANUP_FAILED',
          success: false,
          durationMs: Clock.now().getTime() - startedAt.getTime(),
          error: 'OLD_SLOT_RELEASE_FAILED: ' + JSON.stringify(freeResult.error)
        });
      }
    } catch (e) {
      // شبكة أمان: أي استثناء غير متوقع أثناء التنظيف يُسجَّل، ولا
      // يُسمح له بالتسرب ليؤثر على النتيجة التي استُلمها المستخدم بالفعل.
      LogRepository.write({
        timestamp: Clock.now(),
        command: Config.VOCABULARY.COMMANDS.CHANGE_APPOINTMENT,
        phone: phone,
        slotId: oldSlot.slot_id,
        stage: 'CLEANUP_EXCEPTION',
        success: false,
        durationMs: Clock.now().getTime() - startedAt.getTime(),
        error: e.message
      });
    }
  }
};
