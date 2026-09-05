/**
 * ═══════════════════════════════════════
 * CONTRACT — BookingService
 * ═══════════════════════════════════════
 *
 * يضمن:
 * - إدارة كامل رحلة الحجز داخل ملف واحد:
 *   MENU_MAIN → WAITING_NAME → WAITING_CONFIRMATION → BOOKED
 *   (قرار معماري صريح من المشرف: رفض ConversationOrchestrator في v1)
 * - عدم معرفة أي تفاصيل تخزين للمحادثة — يتعامل فقط مع عمليات
 *   ConversationRepository محددة المعنى (moveToWaitingName...)
 * - الالتزام الكامل بـ ADR-013: لا يستدعي أي Service آخر إطلاقًا.
 * - يعيد Result يحمل { reply, conversationState } فقط.
 *
 * لا يضمن:
 * - إرسال الرسالة عبر WhatsApp — مسؤولية Presentation (Webhook)
 *   الذي يستدعي WhatsAppAdapter.sendMessage() بعد استلام Result من هنا.
 * - أي تعامل مع BOOKED خارج الرد الإرشادي — التغيير/الإلغاء الفعلي
 *   خدمات مستقلة (CancelService/ChangeService) تُربط عبر Router
 *   مستقبلًا، وليس من هنا (ADR-013).
 *
 * ═══════════════════════════════════════
 * تعديل بقرار مراجعة معمارية من المشرف (بعد بناء ChangeService)
 * ═══════════════════════════════════════
 * - اختيار "أقرب فتحة قابلة للحجز" لم يعد منطقًا داخليًا خاصًا بهذا
 *   الملف. استُخرج إلى Application/SlotSelection.gs (ADR-019) لأن
 *   ChangeService احتاج نفس المنطق تمامًا؛ استمرار نسخه هنا كان
 *   يخالف CAS-005. الدالة الداخلية _findEarliestBookableSlot حُذفت،
 *   ويُستدعى بدلاً منها SlotSelection.findEarliestBookable() مباشرة.
 * - مدة الفتحة الزمنية (لحساب endTime عند التأكيد) لم تعد تُقرأ عبر
 *   ثابتين محليين (SETTINGS_KEY_SLOT_DURATION / DEFAULT_SLOT_DURATION_MINUTES)
 *   ولا عبر دالة داخلية خاصة. أصبحت SettingsRepository.getSlotDurationMinutes()
 *   مصدر الحقيقة الوحيد (قرار المشرف: هذا إعداد تشغيلي وليس ثابتًا،
 *   فمكانه Repository وليس Config ولا أي Service).
 * - هذان التعديلان داخليان بحتًا: توقيع handleIncomingMessage() وشكل
 *   الـ Result لم يتغيّرا إطلاقًا.
 * - إصلاح إضافي (قرار مشرف): نتيجة SlotRepository.atomicUpdate التي
 *   تخزّن calendar_event_id بعد إنشاء حدث التقويم لم تعد تُتجاهل —
 *   فشلها الآن يُعيد Result.fail بوضوح بدل المرور الصامت (نفس الإصلاح
 *   طُبّق في ChangeService.changeConfirmedAppointment).
 * - إصلاح اتساق (توصية مشرف غير مانعة): تحقق ملكية الهاتف
 *   (freshSlot.phone === phone) أُضيف داخل atomicUpdate عند تأكيد
 *   الحجز، بنفس نمط الفحص المعتمد في ChangeService — ليس لأن السيناريو
 *   متوقع هنا، بل لتوحيد القاعدة على كل عملية حساسة في النظام.
 * - إصلاح عرض (بعد مراجعة الشيت الفعلي): حقلا date/time القادمان من
 *   Google Sheets هما كائنا Date خام، فدمجهما مباشرة في نص الرد كان
 *   ينتج toString() افتراضيًا غير مقروء. أُضيفت
 *   DateUtils.formatDateDisplay()/formatTimeDisplay() دالتا عرض بحتتان
 *   لا تمسان أي منطق عمل وتُستخدمان الآن عند بناء نص الرد فقط.
 * - أمر تنفيذ معماري (Separation of Internal Time Model and Patient
 *   Presentation): رسائل الرد للمريض تعرض الآن رقم "الباص" (قيمة
 *   عرض مشتقة عبر Utils/BusNumberCalculator.gs، لا تُخزَّن في أي
 *   مكان) وبداية دوام العيادة من Settings.work_start. لا يوجد تراجع
 *   احتياطي يعرض slot.time للمريض إذا تعذّر حساب رقم الباص. وصف/عنوان
 *   حدث Google Calendar أيضًا يعرضان رقم الباص الآن (Projection بحت —
 *   startTime/endTime الحقيقيان لم يتغيّرا إطلاقًا.
 *
 * ═══════════════════════════════════════
 * ديون معمارية موثّقة (لا تُصلح الآن بقرار المشرف)
 * ═══════════════════════════════════════
 * ADR-014: منطق تنفيذ ReserveSlot و ConfirmReservation (التحقق من
 * الانتقال + التحديث الذري) موجود هنا مباشرة داخل الـ Service بدل أن
 * يكون Command مستقلاً حقيقيًا. مسموح مؤقتًا في v1. يُستخرج إلى
 * Command مستقل في Domain/Application فقط عند إعادة استخدامه من أكثر
 * من Service (ADR-015).
 *
 * ADR-016 / ملاحظة تنفيذية مؤقتة بخصوص sort_key:
 * تحويل sort_key إلى قيمة قابلة للمقارنة يمر عبر LegacySlotTimeParser
 * (ملف مؤقت بالكامل). أي منطق هنا يعتمد على شكل sort_key الحالي
 * يُعتبر مؤقتًا وقابلًا للحذف/التعديل فور اعتماد الـ Generator الجديد،
 * وليس مرجعًا تصميميًا دائمًا.
 *
 * ملاحظة توثيقية (ليست ACR) بخصوص ADR-006:
 * التأكيد يلمس موردين (Slot ثم Calendar) دون ذرّية كاملة بينهما. هذا
 * هو الشرط الذي حدده ADR-006 لبناء TransactionManager مستقبلًا.
 * التزامًا بتأجيل ذلك القرار وبساطة CAS-012، الفشل الجزئي هنا يُسجَّل
 * بوضوح في LOG_SYSTEM (عبر CommandExecutor) دون آلية Rollback تلقائية.
 *
 * ⚠️ افتراض بيانات يحتاج تأكيد المشرف مقابل البيانات الفعلية:
 * - شكل تخزين sort_key الفعلي (يُعالج عبر LegacySlotTimeParser).
 */
const BookingService = {

  /**
   * نقطة الدخول الوحيدة لهذا الـ Service.
   * @param {string} rawPhone
   * @param {string} rawMessage
   * @returns {Result} data: { reply: string, conversationState: string }
   */
  handleIncomingMessage(rawPhone, rawMessage) {
    const normalizedPhone = PhoneUtils.normalize(rawPhone);
    const phoneCheck = Validators.validatePhone(normalizedPhone);
    if (!phoneCheck.ok) return phoneCheck;
    const phone = phoneCheck.data;

    const conversation = ConversationRepository.findByPhone(phone);

    if (!conversation) {
      return this._handleFirstContact(phone);
    }

    switch (conversation.state) {
      case Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN:
        return this._handleMenuMain(phone);

      case Config.VOCABULARY.CONVERSATION_STATE.WAITING_NAME:
        return this._handleWaitingName(phone, rawMessage);

      case Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION:
        return this._handleWaitingConfirmation(phone, rawMessage, conversation);

      case Config.VOCABULARY.CONVERSATION_STATE.BOOKED:
        return this._handleBooked();

      default:
        return this._handleUnknownState(phone);
    }
  },

  // ─────────────────────────────────────
  // معالجات كل حالة (Internal — لا تُستدعى من خارج الملف)
  // ─────────────────────────────────────

  _handleFirstContact(phone) {
    ConversationRepository.startNew(phone);

    let clinicName = '';
    try {
      clinicName = SettingsRepository.get('clinic_name') || '';
    } catch (e) {
      clinicName = '';
    }

    const text = 'أهلاً بك' + (clinicName ? ' في ' + clinicName : '') +
      '. للبدء بحجز موعد، أرسل أي رسالة.';

    return Result.ok({
      reply: text,
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
    });
  },

  _handleMenuMain(phone) {
    ConversationRepository.moveToWaitingName(phone);
    return Result.ok({
      reply: 'الرجاء إرسال اسمك الثلاثي لإكمال الحجز.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_NAME
    });
  },

  _handleWaitingName(phone, rawMessage) {
    const nameCheck = Validators.validatePatientName(rawMessage);
    if (!nameCheck.ok) {
      return Result.ok({
        reply: 'الاسم غير صالح، الرجاء إرسال اسمك الثلاثي كاملاً.',
        conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_NAME
      });
    }
    const patientName = nameCheck.data;

    // ── ADR-014: تنفيذ Command مباشر هنا، مؤقتًا، بموافقة المشرف ──
    const commandResult = CommandExecutor.execute(
      Config.VOCABULARY.COMMANDS.RESERVE_SLOT,
      { phone: phone },
      function() {
        const reservedUntil = DateUtils.addMinutes(
          Clock.now(),
          Config.SYSTEM_POLICY.RESERVATION_TIMEOUT_MINUTES
        );

        const reservationResult = BookingService._reserveEarliestBookable(
          phone,
          patientName,
          reservedUntil
        );
        if (!reservationResult.ok) return reservationResult;

        const slot = reservationResult.data.slot;

        // ── أمر تنفيذ معماري: رقم الباص قيمة عرض مشتقة، تُحسب هنا فقط ──
        const busResult = BusNumberCalculator.fromSlot(slot);
        if (!busResult.ok) return busResult;

        const workStartResult = BookingService._getClinicWorkStartDisplay();
        if (!workStartResult.ok) return workStartResult;

        return Result.ok({
          slotId: slot.slot_id,
          date: slot.date,
          time: slot.time,
          busNumber: busResult.data.busNumber,
          clinicWorkStartDisplay: workStartResult.data
        });
      }
    );

    if (!commandResult.ok) {
      if (commandResult.error && commandResult.error.code === 'NO_SLOT_AVAILABLE') {
        return Result.ok({
          reply: 'عذرًا، لا توجد مواعيد متاحة حاليًا. الرجاء المحاولة لاحقًا.',
          conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_NAME
        });
      }
      return commandResult;
    }

    ConversationRepository.moveToWaitingConfirmation(
      phone, patientName, commandResult.data.slotId
    );

    // ── قرار مالك المشروع: التاريخ يبقى ظاهرًا دائمًا مع رقم الباص ──
    // (رقم الباص وحده لا يخبر المريض بأي يوم هو الموعد)
    const preConfirmDisplay = 'بتاريخ ' + DateUtils.formatDateDisplay(commandResult.data.date) +
      ' — رقم الباص: ' + commandResult.data.busNumber +
      ' — يبدأ دوام العيادة الساعة ' + commandResult.data.clinicWorkStartDisplay;

    return Result.ok({
      reply: 'تم إيجاد موعد ' + preConfirmDisplay + '.\n' +
             '١️⃣ تأكيد الحجز\n' +
             '٢️⃣ تغيير الموعد\n' +
             'أرسل رقم الخيار المطلوب.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION
    });
  },

  _handleWaitingConfirmation(phone, rawMessage, conversation) {
    if (!this._isConfirmationKeyword(rawMessage)) {
      return Result.ok({
        reply: 'تم إيجاد موعد لك.\n' +
               '١️⃣ تأكيد الحجز\n' +
               '٢️⃣ تغيير الموعد\n' +
               'أرسل رقم الخيار المطلوب.',
        conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION
      });
    }

    const slotId = conversation.slot_id;
    if (!slotId) {
      ConversationRepository.resetToMenuMain(phone);
      return Result.ok({
        reply: 'حدث خطأ في بيانات الحجز، تم إعادة الضبط. أرسل أي رسالة للبدء من جديد.',
        conversationState: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
      });
    }

    // ── ADR-014: تنفيذ Command مباشر هنا، مؤقتًا، بموافقة المشرف ──
    // M4-F: the confirmation body is shared through confirmReservedSlot() so the
    // RESERVED disruption finalization reuses the EXISTING final-appointment
    // semantics instead of duplicating Calendar handling (CAS-005).
    const commandResult = BookingService.confirmReservedSlot(phone, slotId);

    if (!commandResult.ok) {
      return Result.ok({
        reply: 'تعذّر تأكيد الحجز حاليًا. الرجاء المحاولة مرة أخرى.',
        conversationState: Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION
      });
    }

    ConversationRepository.moveToBooked(phone);

    const confirmedDisplay = 'بتاريخ ' + DateUtils.formatDateDisplay(commandResult.data.date) +
      '\nرقم الباص: ' + commandResult.data.busNumber +
      '\nيبدأ دوام العيادة الساعة ' + commandResult.data.clinicWorkStartDisplay + '.';

    return Result.ok({
      reply: 'تم تأكيد حجزك بنجاح.\n' + confirmedDisplay +
        '\nيرجى الحضور ضمن وقت دوام العيادة.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.BOOKED
    });
  },

  /**
   * M4-F seam — the EXISTING appointment-finalization semantics for a
   * RESERVED slot: the StateMachine-owned ConfirmReservation transition,
   * Calendar event creation, and calendar_event_id persistence, with the
   * ADR-006 partial-failure policy preserved (a Calendar event that cannot
   * be created or stored fails the command).
   *
   * Extracted verbatim from _handleWaitingConfirmation so the M4-F RESERVED
   * disruption finalization can reuse this logic instead of duplicating
   * Calendar handling (CAS-005 / ADR-015). The ordinary booking flow is
   * behaviourally unchanged: it now simply calls this seam.
   *
   * @param {string} phone
   * @param {string} slotId
   * @returns {Result} ok({ slotId, calendarEventId, date, time, busNumber })
   */
  confirmReservedSlot(phone, slotId) {
    // ── ADR-014: تنفيذ Command مباشر هنا، مؤقتًا، بموافقة المشرف ──
    return CommandExecutor.execute(
      Config.VOCABULARY.COMMANDS.CONFIRM_RESERVATION,
      { phone: phone, slotId: slotId },
      function() {
        var confirmedBusNumber = null;
        var clinicWorkStartDisplay = null;

        const updateResult = SlotRepository.atomicUpdate(slotId, function(freshSlot) {
          if (freshSlot.phone !== phone) {
            return Result.fail(
              'SLOT_OWNER_MISMATCH',
              'Slot no longer belongs to this phone',
              { slotId: freshSlot.slot_id, phone: phone }
            );
          }
          const check = Validators.validateTransition(
            freshSlot.status,
            Config.VOCABULARY.COMMANDS.CONFIRM_RESERVATION
          );
          if (!check.ok) return check;

          const busResult = BusNumberCalculator.fromSlot(freshSlot);
          if (!busResult.ok) return busResult;
          const workStartResult = BookingService._getClinicWorkStartDisplay();
          if (!workStartResult.ok) return workStartResult;

          confirmedBusNumber = busResult.data.busNumber;
          clinicWorkStartDisplay = workStartResult.data;

          return Result.ok({ status: Config.VOCABULARY.STATUS.CONFIRMED });
        });

        if (!updateResult.ok) return updateResult;

        const slot = SlotRepository.findById(slotId);
        if (!slot) {
          return Result.fail(
            'SLOT_NOT_FOUND_AFTER_UPDATE',
            'Slot disappeared right after ConfirmReservation'
          );
        }

        // ⚠️ مؤقت — راجع ملاحظة sort_key في رأس الملف (ADR-016)
        const startMs = LegacySlotTimeParser.toComparableTime(slot.sort_key);
        const startTime = startMs !== null ? DateUtils.fromTimestamp(startMs) : null;
        // ── مدة الفتحة عبر SettingsRepository (مصدر الحقيقة الوحيد) ──
        const endTime = startTime
          ? DateUtils.addMinutes(startTime, SettingsRepository.getSlotDurationMinutes())
          : null;

        // ── أمر تنفيذ معماري: عرض رقم الباص للعيادة في التقويم ──
        // Presentation فقط — startTime/endTime الحقيقيان لم يتغيّرا،
        // لا تخزين لرقم الباص في أي Repository (يُحسب هنا فقط للعرض)
        const eventTitle = '#' + confirmedBusNumber + ' | ' + (slot.patient_name || phone);
        const eventDescription = 'رقم الهاتف: ' + phone +
          '\nالوقت الحقيقي: ' + DateUtils.formatTimeDisplay(startTime) +
          '\nslot_id: ' + slot.slot_id;

        // ─── نقطة الفشل الجزئي الموثّقة في رأس الملف (راجع ADR-006) ───
        const eventResult = CalendarRepository.createAppointmentEvent({
          title: eventTitle,
          startTime: startTime,
          endTime: endTime,
          description: eventDescription
        });

        if (!eventResult.ok) {
          return eventResult;
        }

        // ⚠️ نتيجة هذه الخطوة تُفحص إلزاميًا (قرار مشرف) — لا يجوز
        // تجاهلها: فشل صامت هنا يعني حدث تقويم بلا event_id مخزَّن،
        // ولن يستطيع CancelService/ChangeService حذفه لاحقًا، ولن
        // يُسجَّل الفشل في LOG_SYSTEM إن تم تجاهله.
        const storeEventResult = SlotRepository.atomicUpdate(slotId, function(freshSlot) {
          return Result.ok({ calendar_event_id: eventResult.data.eventId });
        });
        if (!storeEventResult.ok) return storeEventResult;

        return Result.ok({
          slotId: slotId,
          calendarEventId: eventResult.data.eventId,
          date: slot.date,
          time: slot.time,
          busNumber: confirmedBusNumber,
          clinicWorkStartDisplay: clinicWorkStartDisplay
        });
      }
    );
  },

  _handleBooked() {
    return Result.ok({
      reply: 'لديك حجز مؤكد حالياً.\n' +
             '٢️⃣ تغيير الموعد\n' +
             '٣️⃣ إلغاء الموعد\n' +
             'أرسل رقم الخيار المطلوب.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.BOOKED
    });
  },

  _handleUnknownState(phone) {
    ConversationRepository.resetToMenuMain(phone);
    return Result.ok({
      reply: 'حدث خطأ غير متوقع، تم إعادة ضبط محادثتك. أرسل أي رسالة للبدء من جديد.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
    });
  },

  // ─────────────────────────────────────
  // أدوات داخلية (Internal helpers)
  // ─────────────────────────────────────

  _getClinicWorkStartDisplay() {
    try {
      const settings = SettingsRepository.getAll();
      const parsed = BookingService._parseHourMinuteText(settings.work_start);
      if (!parsed) {
        return Result.fail('BOOKING_PRESENTATION_ERROR', 'Invalid work_start in Settings');
      }
      return Result.ok(BookingService._formatArabicClinicTime(parsed.hour, parsed.minute));
    } catch (e) {
      return Result.fail(
        'BOOKING_PRESENTATION_ERROR',
        e.message || 'Unable to read clinic work_start for booking presentation'
      );
    }
  },

  _parseHourMinuteText(text) {
    if (typeof text !== 'string') return null;
    const match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    if (isNaN(hour) || isNaN(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour: hour, minute: minute };
  },

  _formatArabicClinicTime(hour, minute) {
    const suffix = hour < 12 ? 'صباحًا' : 'مساءً';
    let displayHour = hour % 12;
    if (displayHour === 0) displayHour = 12;
    const hh = displayHour < 10 ? '0' + displayHour : String(displayHour);
    const mm = minute < 10 ? '0' + minute : String(minute);
    return hh + ':' + mm + ' ' + suffix;
  },

  _isConfirmationKeyword(message) {
    if (!message || typeof message !== 'string') return false;
    const normalized = message.trim();
    return normalized === '1' || normalized === 'تأكيد' || normalized === 'نعم';
  },

  /**
   * Selects and atomically reserves one candidate. A race loss excludes that
   * candidate for this operation only. One loop iteration equals one
   * reservation atomicUpdate, with at most three attempts.
   */
  _reserveEarliestBookable(phone, patientName, reservedUntil) {
    const excludedSlotIds = [];

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
        // reserved after is_available became false.
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
  }
};
