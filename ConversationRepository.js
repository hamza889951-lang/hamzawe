/**
 * ═══════════════════════════════════════
 * CONTRACT — ConversationRepository
 * ═══════════════════════════════════════
 * يضمن:
 * - إيجاد محادثة، وبدء محادثة جديدة، والانتقال بين حالاتها عبر عمليات
 *   محددة الاسم والمعنى (startNew, moveToWaitingName...) بحيث لا يحتاج
 *   المستدعي معرفة أسماء الحقول الداخلية (temp_name, slot_id, updated_at).
 * لا يضمن:
 * - صحة انتقال الحالة — StateMachine الخاصة بالمحادثة (إن وُجدت مستقبلاً)
 *   ليست هنا ولا حاجة لها في v1.
 *
 * ── تعديل بقرار مراجعة معمارية من المشرف ──
 * سابقاً كان BookingService يبني كائن الحقول بنفسه (temp_name, slot_id,
 * updated_at) ويمرره لـ updateState() العامة. هذا كان يخالف CAS-003
 * لأن أي تغيير في بنية ورقة Conversations كان سيفرض تعديل BookingService.
 * الآن BookingService يطلب "انتقل إلى WAITING_NAME" فقط، ولا يعرف كيف
 * يُخزَّن ذلك فعلياً.
 */
const ConversationRepository = {

  findByPhone(phone) {
    return GoogleSheets.findRowByColumn(
      Config.VOCABULARY.SHEETS.CONVERSATIONS, 'phone', phone
    );
  },

  /** @returns {Object} السجل المُنشأ */
  startNew(phone) {
    const record = {
      conversation_id: IdGenerator.generateConversationId(),
      phone: phone,
      state: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN,
      temp_name: '',
      slot_id: '',
      updated_at: Clock.now()
    };
    GoogleSheets.appendRow(Config.VOCABULARY.SHEETS.CONVERSATIONS, record);
    return record;
  },

  moveToWaitingName(phone) {
    this._updateState(phone, Config.VOCABULARY.CONVERSATION_STATE.WAITING_NAME, {});
  },

  /**
   * @param {string} phone
   * @param {string} patientName
   * @param {string} slotId
   */
  moveToWaitingConfirmation(phone, patientName, slotId) {
    this._updateState(phone, Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION, {
      temp_name: patientName,
      slot_id: slotId
    });
  },

  moveToBooked(phone) {
    this._updateState(phone, Config.VOCABULARY.CONVERSATION_STATE.BOOKED, {});
  },

  /** إعادة ضبط كاملة عند حدوث خطأ أو حالة غير معروفة */
  resetToMenuMain(phone) {
    this._updateState(phone, Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN, {
      temp_name: '',
      slot_id: ''
    });
  },

  /**
   * دالة داخلية عامة — لا تُستدعى من خارج هذا الملف (راجع Checklist في
   * GoogleSheets.gs بخصوص دوال "_").
   */
  _updateState(phone, newState, extraFields) {
    const fields = Object.assign(
      { state: newState, updated_at: Clock.now() },
      extraFields || {}
    );
    GoogleSheets.updateRowByColumn(
      Config.VOCABULARY.SHEETS.CONVERSATIONS, 'phone', phone, fields
    );
  }
};