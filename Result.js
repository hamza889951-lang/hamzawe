/**
 * Result
 * الشكل الوحيد المسموح لأي Service بإرجاعه (CAS-008).
 * ممنوع إرجاع true/false/null من أي دالة عمل في النظام.
 */
const Result = {
  /** @param {*} data - أي بيانات نتيجة النجاح */
  ok(data) {
    return { ok: true, data: data !== undefined ? data : null, error: null };
  },

  /**
   * @param {string} code - رمز خطأ ثابت يُستخدم برمجياً (مثل 'SLOT_NOT_FOUND')
   * @param {string} message - رسالة قابلة للقراءة البشرية
   * @param {*} [details] - أي معلومة إضافية تفيد التشخيص
   */
  fail(code, message, details) {
    return {
      ok: false,
      data: null,
      error: { code: code, message: message, details: details || null }
    };
  }
};
