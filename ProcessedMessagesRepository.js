/**
 * ═══════════════════════════════════════
 * CONTRACT — ProcessedMessagesRepository
 * ═══════════════════════════════════════
 *
 * يضمن:
 *   - قراءة قيمة مخزّنة لمفتاح idempotency (read).
 *   - كتابة قيمة لمفتاح idempotency (write).
 *   - عزل طبقة Application/Service عن تفاصيل PropertiesService.
 *
 * لا يضمن:
 *   - أي ذرية بين read و write — مسؤولية ProcessedMessagesService
 *     عبر Lock.runExclusive().
 *   - أي cleanup أو expiration تلقائي للمفاتيح.
 *   - أي قراءة متعددة أو بحث.
 *
 * ملاحظة معمارية:
 *   هذا الملف هو الحدود الوحيدة المسموح لها بمعرفة PropertiesService
 *   في سياق idempotency الرسائل. لا يجوز لـ Application أو Domain
 *   استدعاء PropertiesService مباشرة (CAS-006 / B2-§15).
 */
const ProcessedMessagesRepository = {

  /**
   * قراءة القيمة المخزّنة لمفتاح idempotency.
   * @param {string} key - مفتاح الرسالة (msg_<messageId> أو fallback)
   * @returns {string|null} القيمة المخزّنة (timestamp as string) أو null
   */
  read: function(key) {
    var props = PropertiesService.getScriptProperties();
    var value = props.getProperty(key);
    return value !== undefined ? value : null;
  },

  /**
   * كتابة قيمة لمفتاح idempotency.
   * @param {string} key - مفتاح الرسالة
   * @param {string} value - القيمة المراد تخزينها (timestamp as string)
   * @returns {boolean} true إذا نجحت الكتابة
   */
  write: function(key, value) {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(key, value);
    return true;
  }
};
