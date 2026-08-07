/**
 * Validators
 * قواعد عمل تخص صحة المدخلات فقط (Domain، لا Utils).
 *
 * التزام صريح بـ CAS-013 (بتوجيه المشرف G):
 * وظيفة أي Validator هنا هي "التحقق فقط" — قبول أو رفض.
 * ممنوع أن يقوم أي Validator بتنسيق أو تصحيح أو تعديل القيمة المُدخلة.
 * أي عملية تطبيع (Normalization) — مثل تنظيف رقم هاتف من رموز غير رقمية —
 * تعيش في مكوّن مستقل (مثل PhoneUtils المخطط له في المرحلة الثانية)،
 * لا هنا. كل دالة تعيد Result، تماشياً مع CAS-008.
 */
const Validators = {

  /**
   * تحقق أساسي فقط من الصحة، دون أي سياسة واجهة استخدام.
   * @param {string} phone
   */
  validatePhone(phone) {
    if (!phone || typeof phone !== 'string' || phone.trim().length < 8) {
      return Result.fail('INVALID_PHONE', 'Phone number is missing or malformed');
    }
    return Result.ok(phone.trim());
  },

  /**
   * تحقق أساسي فقط: القيمة موجودة وغير فارغة وذات طول معقول.
   * لا يفرض أي سياسة إضافية (مثل عدد الكلمات) — تلك مسؤولية Application
   * إذا احتاجها المشروع مستقبلاً، لا Domain.
   * @param {string} name
   */
  validatePatientName(name) {
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return Result.fail('INVALID_NAME', 'Name is missing or too short');
    }
    return Result.ok(name.trim());
  },

  /**
   * يتحقق أن الأمر مسموح تنفيذه من الحالة الحالية، دون تنفيذه.
   * @param {string} currentStatus
   * @param {string} command
   */
  validateTransition(currentStatus, command) {
    if (!StateMachine.canExecute(currentStatus, command)) {
      return Result.fail(
        'INVALID_TRANSITION',
        'Cannot execute ' + command + ' from status ' + currentStatus
      );
    }
    return Result.ok(true);
  }
};