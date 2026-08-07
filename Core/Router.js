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
 * - إرجاع Result يحمل { reply, conversationState } من الخدمة
 *   المستهدفة — دون أي تعديل أو إثراء من Router.
 *
 * لا يضمن:
 * - أي منطق عمل — مجرد توجيه بناءً على جدول الحالات المعتمد.
 * - أي معرفة بـ Sheets أو Calendar أو UltraMsg.
 * - أي نصوص ردود — كل النصوص داخل الخدمات.
 *
 * ═══════════════════════════════════════
 * جدول التوجيه النهائي (معتمد من المشرف)
 * ═══════════════════════════════════════
 *
 * | الحالة               | الإدخال      | الإجراء                              |
 * |----------------------|-------------|--------------------------------------|
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
   * @returns {Result} data: { reply: string, conversationState: string }
   */
  dispatch(context) {

    var rawPhone = context.phone;
    var message = context.message;

    // ─────────────────────────────
    // 0. تطبيع رقم الهاتف (قرار مشرف)
    //    WhatsAppAdapter لا يطبّع الرقم حسب عقده، وRouter يعتمد على
    //    ConversationRepository.findByPhone() لتحديد حالة المحادثة.
    //    أي اختلاف في صيغة الرقم = توجيه خاطئ.
    // ─────────────────────────────
    var phone = PhoneUtils.normalize(rawPhone);

    // ─────────────────────────────
    // 1. تحديد حالة المحادثة الحالية
    // ─────────────────────────────
    var conversation = ConversationRepository.findByPhone(phone);
    var currentState = conversation ? conversation.state : null;

    var normalizedMessage = (message || '').trim();

    // ─────────────────────────────
    // 2. التوجيه حسب جدول الحالات
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
