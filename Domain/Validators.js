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
   * سياسة اسم المريض في مسار الحجز:
   * - ثلاثة مقاطع اسمية على الأقل.
   * - كل مقطع يتكون من حروف عربية فقط (مع السماح بعلامات التشكيل).
   * - كل مقطع يحتوي على حرفين أبجديين على الأقل.
   * - الأرقام، الأحرف اللاتينية، وعلامات الترقيم/الرموز مرفوضة.
   *
   * الـ Validator يتحقق فقط ولا يعيد تشكيل قيمة الاسم وفق CAS-013.
   * @param {string} name
   */
  validatePatientName(name) {
    if (!name || typeof name !== 'string') {
      return Result.fail('INVALID_NAME', 'Name is missing or malformed');
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return Result.fail('INVALID_NAME', 'Name is missing or malformed');
    }

    const words = trimmed.split(/\s+/u);
    if (words.length < 3) {
      return Result.fail('INVALID_NAME', 'Patient name must contain at least three words');
    }

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const lettersAndMarks = word.match(/[\p{L}\p{M}]/gu) || [];

      if (lettersAndMarks.length < 2) {
        return Result.fail('INVALID_NAME', 'Each name word must contain at least two letters');
      }

      if (!/^(?:(?=\p{L}|\p{M})\p{Script=Arabic})+$/u.test(word)) {
        return Result.fail('INVALID_NAME', 'Patient name must contain Arabic letters only');
      }
    }

    return Result.ok(trimmed);
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