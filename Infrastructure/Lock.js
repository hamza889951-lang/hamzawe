/**
 * ═══════════════════════════════════════
 * CONTRACT — Lock
 * ═══════════════════════════════════════
 * يضمن:
 *   - تنفيذ fn() دون تداخل مع تنفيذ آخر متزامن على مستوى السكربت كله.
 *   - تمييز خطأ "فشل الحصول على القفل" عن "فشل داخل القفل".
 * لا يضمن:
 *   - قفلاً على مورد محدد (key توثيقي فقط حالياً، غير فعّال في Apps Script).
 *   - أي حد زمني غير القيمة الممرَّرة أو الافتراضية (5 ثوانٍ).
 */
/**
 * Lock
 * الملف الوحيد المسموح له بمعرفة LockService.
 * يُستدعى حصراً من Repositories، ولا يُستدعى أبداً من Application أو Domain.
 *
 * ملاحظة تقنية موثّقة سابقاً:
 * LockService.getScriptLock() يقفل تنفيذ السكربت بأكمله، وليس مورداً محدداً.
 * 'key' غير فعّال في هذا السلوك حالياً، لكنه موجود ليصبح فعلياً مستخدماً
 * (كقفل بمفتاح، شبيه بـ SELECT...FOR UPDATE) عند الانتقال لقاعدة بيانات حقيقية.
 */
const Lock = {
  /**
   * @param {string} key - معرف المورد المطلوب حمايته (توثيقي حالياً)
   * @param {Function} fn - يجب أن تعيد Result
   * @param {number} [timeoutMs=5000]
   * @returns {Result}
   */
  runExclusive(key, fn, timeoutMs) {
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(timeoutMs || 5000);
    } catch (e) {
      return Result.fail('LOCK_TIMEOUT', 'Could not acquire lock for ' + key, e.message);
    }
    try {
      return fn();
    } catch (e) {
      return Result.fail('UNEXPECTED_ERROR', e.message, e.stack);
    } finally {
      lock.releaseLock();
    }
  }
};