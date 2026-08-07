/**
 * ═══════════════════════════════════════
 * CONTRACT — CancelService
 * ═══════════════════════════════════════
 * يضمن:
 * - إلغاء الحجز المؤكد الوحيد المرتبط برقم هاتف معين (CONFIRMED → FREE
 *   عبر StateMachine)، وحذف حدث التقويم المرتبط، وإعادة ضبط المحادثة.
 * - الالتزام الكامل بـ ADR-013: لا يستدعي BookingService ولا أي Service
 *   آخر إطلاقاً.
 *
 * لا يضمن:
 * - أي خطوة تأكيد وسيطة ("أرسل 1 للتأكيد") قبل الإلغاء الفعلي.
 *
 * ═══════════════════════════════════════
 * قرار نطاق (تنفيذي، وليس معمارياً)
 * ═══════════════════════════════════════
 * الإلغاء هنا يتم بخطوة واحدة فور استدعاء cancelAppointment(). لم أُضِف
 * حالة محادثة وسيطة (مثل WAITING_CANCEL_CONFIRMATION) لأن ذلك يتطلب
 * تعديل Config.VOCABULARY.CONVERSATION_STATE، وهي "لغة النظام الأساسية"
 * الموصوفة في Config.gs بأنها "لا تتغير أبداً". توسيع هذا المعجم قرار
 * معماري يخص المشرف حصرياً، وليس شيئاً أفترضه بنفسي. من يستدعي هذه
 * الدالة (لاحقاً Router) هو من يقرر متى يُستدعى، وأي تأكيد نصي يريده
 * قبل ذلك يقع خارج نطاق هذا الـ Service.
 *
 * ديون معمارية موثّقة:
 * ADR-014: منطق تنفيذ CancelAppointment (تحقق الانتقال + التحديث
 * الذري) موجود هنا مباشرة، وليس Command مستقلاً — بنفس شرط ADR-015.
 *
 * ADR-006: حذف حدث التقويم وتحرير الفتحة عمليتان على موردين منفصلين
 * دون ذرّية كاملة. لتقليل أثر الفشل الجزئي: يُحذف حدث التقويم أولاً؛
 * إذا فشل الحذف، لا تُحرَّر الفتحة إطلاقاً (تبقى الحالة متسقة: حجز
 * مؤكد + حدث تقويم موجود). لا Rollback تلقائي إن فشلت الخطوة الثانية
 * بعد نجاح الأولى — يُسجَّل الفشل في LOG_SYSTEM فقط.
 */
const CancelService = {

  /**
   * نقطة الدخول الوحيدة لهذا الـ Service.
   * @param {string} rawPhone
   * @returns {Result} data: { reply: string, conversationState: string|null }
   */
  cancelAppointment(rawPhone) {
    const normalizedPhone = PhoneUtils.normalize(rawPhone);
    const phoneCheck = Validators.validatePhone(normalizedPhone);
    if (!phoneCheck.ok) return phoneCheck;
    const phone = phoneCheck.data;

    const appointment = AppointmentRepository.findActiveByPhone(phone);
    if (!appointment) {
      return Result.ok({
        reply: 'لا يوجد لديك حجز مؤكد حالياً لإلغائه.',
        conversationState: null
      });
    }

    const slotId = appointment.slot_id;

    // ── ADR-014: تنفيذ Command مباشر هنا، مؤقتاً، بموافقة المشرف ──
    const commandResult = CommandExecutor.execute(
      Config.VOCABULARY.COMMANDS.CANCEL_APPOINTMENT,
      { phone: phone, slotId: slotId },
      function() {
        const currentSlot = SlotRepository.findById(slotId);
        if (!currentSlot) {
          return Result.fail('SLOT_NOT_FOUND', 'Slot ' + slotId + ' no longer exists');
        }

        const preCheck = Validators.validateTransition(
          currentSlot.status,
          Config.VOCABULARY.COMMANDS.CANCEL_APPOINTMENT
        );
        if (!preCheck.ok) return preCheck;

        // حذف حدث التقويم أولاً — راجع تبرير الترتيب في رأس الملف (ADR-006)
        if (currentSlot.calendar_event_id) {
          const deleteResult = CalendarRepository.deleteAppointmentEvent(
            currentSlot.calendar_event_id
          );
          if (!deleteResult.ok) return deleteResult;
        }

        const updateResult = SlotRepository.atomicUpdate(slotId, function(freshSlot) {
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

        if (!updateResult.ok) return updateResult;

        return Result.ok({ slotId: slotId });
      }
    );

    if (!commandResult.ok) {
      return Result.ok({
        reply: 'تعذّر إلغاء الحجز حالياً. الرجاء المحاولة مرة أخرى أو التواصل مع العيادة.',
        conversationState: null
      });
    }

    ConversationRepository.resetToMenuMain(phone);

    return Result.ok({
      reply: 'تم إلغاء حجزك بنجاح. يمكنك حجز موعد جديد بإرسال أي رسالة.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
    });
  }
};