/**
 * ═══════════════════════════════════════
 * CONTRACT — Router
 * ═══════════════════════════════════════
 *
 * يضمن:
 * - dispatch(context): نقطة الدخول الوحيدة لتوجيه أي رسالة واردة
 *   إلى الخدمة المناسبة. يستلم context كائنًا يحتوي phone + message
 *   (وقابل للتوسع مستقبلًا: messageId, timestamp, senderName...)
 *   دون تغيير توقيع الدالة.
 * - تطبيع رقم الهاتف قبل قراءة المحادثة: WhatsAppAdapter لا يطبّع
 *   الرقم حسب عقده، لذلك Router مسؤول عن استدعاء
 *   PhoneUtils.normalize() داخليًا قبل ConversationRepository.findByPhone().
 *   هذا ضروري لأن Router يعتمد على حالة Conversation لتوجيه الطلب —
 *   فأي اختلاف في صيغة الرقم سيؤدي إلى توجيه خاطئ.
 * - M4-A Doctor Identity gate عبر DoctorAuthorizationService:
 *   Actor مصرح له فقط يدخل DoctorControlEntry؛ أي أخرى (unknown /
 *   unauthorized / identity failure) تنساب إلى patient routing الحالي.
 *   لا يتعامل Router مع أي Sheets أو Calendar أو Settings أو WhatsApp.
 * - BOOKED consistency gate: قبل توجيه أي رسالة من حالة BOOKED، يُستدعى
 *   ActiveAppointmentReconciliationService للتحقق من وجود موعد CONFIRMED
 *   authoritative. Router لا يقرأ Availability بنفسه ولا يقرر صلاحية الموعد.
 * - إرجاع Result من الخدمة المستهدفة — دون أي تعديل أو إثراء من Router.
 *
 * لا يضمن:
 * - أي منطق عمل — مجرد توجيه بناءً على جدول الحالات المعتمد وحد الـ
 *   authorization المحدد هويته خارجياً، مع hand-off لحدود Application
 *   المتخصصة عند الحاجة.
 * - أي معرفة بـ Sheets أو Calendar أو UltraMsg.
 * - تحديد من هو الطبيب business-wise — هذا من DoctorAuthorizationService.
 * - أي نصوص ردود — كل النصوص داخل الخدمات.
 *
 * ═══════════════════════════════════════
 * جدول التوجيه النهائي (معتمد من المشرف)
 * ═══════════════════════════════════════
 *
 * | الحالة               | الإدخال      | الإجراء                              |
 * |----------------------|-------------|--------------------------------------|
 * | Authorized Doctor    | أي رسالة    | DoctorControlEntry.enter              |
 * | NO_CONVERSATION      | أي رسالة    | BookingService.handleIncomingMessage |
 * | MENU_MAIN            | أي رسالة    | BookingService.handleIncomingMessage |
 * | WAITING_NAME         | أي رسالة    | BookingService.handleIncomingMessage |
 * | WAITING_CONFIRMATION | "1"         | BookingService.handleIncomingMessage |
 * | WAITING_CONFIRMATION | "2"         | ChangeService.changeReservation      |
 * | WAITING_CONFIRMATION | غير ذلك     | BookingService.handleIncomingMessage |
 * | BOOKED + active      | "2"         | ChangeService.changeConfirmed...     |
 * | BOOKED + active      | "3"         | CancelService.cancelAppointment       |
 * | BOOKED + active      | غير ذلك     | BookingService.handleIncomingMessage |
 * | BOOKED + stale       | أي رسالة    | ActiveAppointmentReconciliationService |
 *
 * ═══════════════════════════════════════
 * فلسفة التصميم
 * ═══════════════════════════════════════
 * Router يفحص محتوى الرسالة فقط عند الحاجة لتحديد الوجهة. في حالة BOOKED
 * توجد أولًا consistency gate واحدة لاختبار وجود موعد CONFIRMED فعلي؛ إذا
 * كانت الحالة stale، يقوم الحد المتخصص بإصلاح جلسة Conversation ويعيد الرد
 * مباشرة، ولا تصل الرسالة إلى Change/Cancel/B6.
 *
 * Router لا يتعامل مباشرة مع Availability أو Calendar أو B6.
 */
const Router = {

  /**
   * نقطة الدخول الوحيدة لتوجيه أي رسالة واردة.
   *
   * @param {Object} context - { phone: string, message: string }
   *        (قابل للتوسع مستقبلًا: messageId, timestamp, senderName...)
   * @returns {Result} data: من الخدمة الفرعية المستهدفة —patient paths
   *   تعيد { reply, conversationState }، وDoctorControlEntry يعيد
   *   { entryStatus, controlContext }.
   */
  dispatch(context) {

    // ─────────────────────────────
    // 0. Robustness — ممنوع الـRouter أن يرمي على Context فاسد.
    // ─────────────────────────────
    if (!context || typeof context !== 'object') {
      return Result.fail('INVALID_CONTEXT', 'Router context is required');
    }

    var rawPhone = context.phone;
    var message = context.message;
    if (typeof rawPhone !== 'string' || !rawPhone) {
      return Result.fail('INVALID_CONTEXT', 'Router context requires a phone');
    }

    // ─────────────────────────────
    // 1. تطبيع رقم الهاتف (قرار مشرف)
    //    WhatsAppAdapter لا يطبّع الرقم حسب عقده، وRouter يعتمد على
    //    ConversationRepository.findByPhone() لتحديد حالة المحادثة.
    //    أي اختلاف في صيغة الرقم = توجيه خاطئ.
    // ─────────────────────────────
    var phone = PhoneUtils.normalize(rawPhone);

    // ─────────────────────────────
    // 2. M4-A Doctor Identity & Authorization gate
    //    Fail-closed: authorized doctor فقط يصل إلى DoctorControlEntry.
    //    أي fail/unavailable/unauthorized ينساب إلى patient routing
    //    الحالي — لا يوجد أي fallback إلى DOCTOR.
    //    ملاحظة: typeof guard تعني أن عدم وجود الـM4-A boundary (أثناء
    //    تشغيل bundles قديمة / جزئية) لا يرمي ReferenceError، وإنما
    //    fail-closed إلى patient flow.
    // ─────────────────────────────
    if (typeof DoctorAuthorizationService !== 'undefined' &&
        typeof DoctorControlEntry !== 'undefined') {
      var doctorAuth = DoctorAuthorizationService.authorizeDoctor(phone);
      if (doctorAuth.ok && doctorAuth.data && doctorAuth.data.authorized === true) {
        var entryResult = DoctorControlEntry.enter(doctorAuth.data);
        if (!entryResult.ok) return entryResult;
        // M4-C Continuation: routing-only hand-off of the accepted entry
        // context + raw message to the doctor interaction boundary. Router
        // parses nothing; typeof guard keeps older/partial bundles
        // fail-closed on the read-only M4-A entry result.
        if (typeof DoctorControlInteractionService !== 'undefined') {
          return DoctorControlInteractionService.handle(
            entryResult.data.controlContext,
            message
          );
        }
        return entryResult;
      }
    }

    // ─────────────────────────────
    // 3. تحديد حالة المحادثة الحالية
    // ─────────────────────────────
    var conversation = ConversationRepository.findByPhone(phone);
    var currentState = conversation ? conversation.state : null;

    var normalizedMessage = (message || '').trim();

    // ─────────────────────────────
    // 4. BOOKED consistency gate
    //    Conversation.state is not authoritative proof of an active
    //    appointment. The Application reconciliation boundary checks the
    //    authoritative Availability rows before any BOOKED dispatch.
    //    A typeof guard preserves fail-closed operation of older/partial
    //    bundles that do not contain the new boundary yet.
    // ─────────────────────────────
    if (currentState === Config.VOCABULARY.CONVERSATION_STATE.BOOKED &&
        typeof ActiveAppointmentReconciliationService !== 'undefined') {
      var reconciliationResult = ActiveAppointmentReconciliationService.reconcileBookedConversation(phone);
      if (!reconciliationResult.ok) return reconciliationResult;

      if (reconciliationResult.data && reconciliationResult.data.staleCleared === true) {
        return Result.ok({
          reply: reconciliationResult.data.reply,
          conversationState: reconciliationResult.data.conversationState
        });
      }
    }

    // ─────────────────────────────
    // 5. التوجيه حسب جدول الحالات
    // ─────────────────────────────

    // --- M4-F: WAITING_DISRUPTION_CONFIRMATION → PatientDisruptionService ---
    // Routing-only hand-off. The Router does not inspect expiry, does not
    // parse the response, does not mutate Slots/Calendar/B6, and does not
    // send WhatsApp. PatientDisruptionService owns the interaction semantics.
    // Reached only by patient rows: the M4-A doctor gate returns earlier, and
    // doctor states are disjoint from this one.
    if (currentState === Config.VOCABULARY.CONVERSATION_STATE.WAITING_DISRUPTION_CONFIRMATION) {
      if (typeof PatientDisruptionService !== 'undefined') {
        return PatientDisruptionService.handleIncomingMessage(phone, message);
      }
      // Boundary absent (partial/older bundle) — fail closed to the ordinary
      // patient flow rather than throwing on the webhook entry point.
    }

    // --- WAITING_CONFIRMATION + "2" → تغيير قبل التأكيد ---
    if (currentState === Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION
        && normalizedMessage === '2') {
      return ChangeService.changeReservation(phone);
    }

    // --- BOOKED + "2" → تغيير بعد التأكيد ---
    if (currentState === Config.VOCABULARY.CONVERSATION_STATE.BOOKED
        && normalizedMessage === '2') {
      return ChangeService.changeConfirmedAppointment(phone);
    }

    // --- BOOKED + "3" → إلغاء ---
    if (currentState === Config.VOCABULARY.CONVERSATION_STATE.BOOKED
        && normalizedMessage === '3') {
      return CancelService.cancelAppointment(phone);
    }

    // --- كل شيء آخر → BookingService ---
    return BookingService.handleIncomingMessage(phone, message);
  }
};
