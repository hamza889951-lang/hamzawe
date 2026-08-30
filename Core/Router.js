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
 * - إرجاع Result من الخدمة المستهدفة — دون أي تعديل أو إثراء من Router.
 *
 * لا يضمن:
 * - أي منطق عمل — مجرد توجيه بناءً على جدول الحالات المعتمد وحد الـ
 *   authorization المحدد هويته خارجياً.
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
 * | BOOKED               | "2"         | ChangeService.changeConfirmed...     |
 * | BOOKED               | "3"         | CancelService.cancelAppointment       |
 * | BOOKED               | غير ذلك     | BookingService.handleIncomingMessage |
 *
 * ═══════════════════════════════════════
 * فلسفة التصميم
 * ═══════════════════════════════════════
 * Router لا يفحص محتوى الرسالة إلا في حالتين فقط:
 *   WAITING_CONFIRMATION — ليميّز "2" (تغيير قبل التأكيد)
 *   BOOKED               — ليميّز "2" و"3" (تغيير/إلغاء بعد التأكيد)
 * كل شيء آخر يذهب افتراضيًا إلى BookingService الذي يدير تفسير
 * الرسالة داخليًا حسب حالته الخاصة.
 *
 * Router يعتمد فقط على Conversation.state + message —
 * ولا يعتمد على rowNumber ولا على status ولا على calendar.
 * وهذا ينسجم تمامًا مع CAS.
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
        return DoctorControlEntry.enter(doctorAuth.data);
      }
    }

    // ─────────────────────────────
    // 3. تحديد حالة المحادثة الحالية
    // ─────────────────────────────
    var conversation = ConversationRepository.findByPhone(phone);
    var currentState = conversation ? conversation.state : null;

    var normalizedMessage = (message || '').trim();

    // ─────────────────────────────
    // 4. التوجيه حسب جدول الحالات
    // ─────────────────────────────

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
