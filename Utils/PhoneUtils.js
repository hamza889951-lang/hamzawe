/**
 * ═══════════════════════════════════════
 * CONTRACT — PhoneUtils
 * ═══════════════════════════════════════
 * يضمن:
 * - تطبيع (Normalization) رقم الهاتف فقط: إزالة "@c.us"، إزالة "+"،
 *   إزالة المسافات.
 * لا يضمن:
 * - أي تحقق من صحة الرقم (ذلك من مسؤولية Validators — CAS-013).
 * - أي سياسة عمل (طول الرقم، رمز الدولة...).
 *
 * قرار: أُنشئ هذا الملف بتوجيه صريح من المشرف بتاريخ اعتماد BookingService،
 * وبنطاق محدود جدًا كما اشترط.
 */
const PhoneUtils = {
  /**
   * @param {string} rawPhone
   * @returns {string}
   */
  normalize(rawPhone) {
    if (!rawPhone || typeof rawPhone !== 'string') return rawPhone;
    let result = rawPhone.trim();
    result = result.replace('@c.us', '');
    result = result.replace(/^\+/, '');
    result = result.replace(/\s+/g, '');
    return result;
  }
};