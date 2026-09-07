/**
 * ═══════════════════════════════════════
 * CONTRACT — ProcessedMessagesRepository
 * ═══════════════════════════════════════
 *
 * يضمن:
 *   - claim(key, nowMs, duplicateWindowMs): عملية ذرية واحدة تجمع
 *     قراءة claim موجود + فحص صلاحيته + cleanup محدود للمفاتيح المنتهية
 *     + كتابة claim جديد داخل Lock.runExclusive('idempotency'). لا يمكن
 *     لتنفيذين متزامنين لنفس المفتاح الحصول على ACQUIRED معًا.
 *   - read(key): قراءة قيمة مخزّنة (للاستخدام legacy).
 *   - write(key, value): كتابة قيمة (للاستخدام legacy).
 *   - عزل طبقة Service عن PropertiesService و Lock.
 *
 * لا يضمن:
 *   - أي ذرية عبر موارد خارجية (Sheets, Calendar).
 *   - cleanup غير محدود أو حذف قيم msg_* غير القابلة للتفسير كـtimestamp.
 *
 * ملاحظة معمارية:
 *   هذا الملف هو الحدود الوحيدة المسموح لها بمعرفة PropertiesService
 *   و Lock في سياق idempotency الرسائل. لا يجوز لـ Service أو
 *   Application استدعاء أي منهما مباشرة.
 */
const ProcessedMessagesRepository = {

  // B2 storage hardening: housekeeping is intentionally small and deterministic.
  // PropertiesService only exposes a full snapshot for key discovery; therefore
  // we separately cap our in-memory inspection work and never sort the snapshot.
  CLEANUP_MAX_PER_CLAIM: 20,
  CLEANUP_MAX_INSPECTED_PER_CLAIM: 100,

  /**
   * Atomic claim — عملية ذرية واحدة داخل Lock.
   *
   * @param {string} key - مفتاح الرسالة (من Service._buildKey)
   * @param {number} nowMs - الوقت الحالي بالميلي ثانية (من Service)
   * @param {number} duplicateWindowMs - نافذة الصلاحية بالميلي ثانية (من Service)
   * @returns {Result}
   *   ok({ status: 'ACQUIRED' })  — تم امتلاك المفتاح
   *   ok({ status: 'DUPLICATE' }) — claim صالح موجود مسبقًا
   *   fail('LOCK_TIMEOUT', ...)              — فشل الحصول على القفل
   *   fail('CLAIM_READ_FAILED', ...)         — فشل قراءة claim موجود
   *   fail('CLAIM_PERSISTENCE_FAILED', ...)  — فشل كتابة claim جديد
   */
  claim: function(key, nowMs, duplicateWindowMs) {
    return Lock.runExclusive('idempotency', function() {
      // ── read existing claim ──
      var stored = null;
      try {
        var props = PropertiesService.getScriptProperties();
        var raw = props.getProperty(key);
        stored = (raw !== undefined && raw !== null) ? raw : null;
      } catch (e) {
        return Result.fail(
          'CLAIM_READ_FAILED',
          'Failed to read idempotency claim',
          e.message
        );
      }

      // ── check if existing claim is still valid ──
      if (stored !== null) {
        var storedMs = parseInt(stored, 10);
        if (!isNaN(storedMs)) {
          var elapsed = nowMs - storedMs;
          if (elapsed < duplicateWindowMs) {
            return Result.ok({ status: 'DUPLICATE' });
          }
          // expired — fall through to acquire
        }
      }

      // ── best-effort bounded cleanup of expired B2 claims ──
      // Cleanup is housekeeping, not an ownership precondition. Any failure
      // here is intentionally swallowed so a valid current claim can proceed.
      try {
        var allProperties = PropertiesService.getScriptProperties().getProperties();
        var removed = 0;
        var keys = Object.keys(allProperties);
        var inspected = 0;

        for (var i = 0;
             i < keys.length &&
             inspected < this.CLEANUP_MAX_INSPECTED_PER_CLAIM &&
             removed < this.CLEANUP_MAX_PER_CLAIM;
             i++) {
          inspected++;
          var candidateKey = keys[i];
          if (candidateKey === key || candidateKey.indexOf('msg_') !== 0) {
            continue;
          }

          var candidateRaw = allProperties[candidateKey];
          if (typeof candidateRaw !== 'string' || !/^\d+$/.test(candidateRaw)) {
            continue;
          }

          var candidateMs = Number(candidateRaw);
          if (!isFinite(candidateMs) || Math.floor(candidateMs) !== candidateMs || candidateMs > nowMs) {
            continue;
          }

          if (nowMs - candidateMs >= duplicateWindowMs) {
            PropertiesService.getScriptProperties().deleteProperty(candidateKey);
            removed++;
          }
        }
      } catch (e) {
        // Best-effort housekeeping must not turn an otherwise valid claim into failure.
      }

      // ── establish ownership ──
      try {
        var props = PropertiesService.getScriptProperties();
        props.setProperty(key, String(nowMs));
      } catch (e) {
        return Result.fail(
          'CLAIM_PERSISTENCE_FAILED',
          'Failed to persist idempotency claim',
          e.message
        );
      }

      return Result.ok({ status: 'ACQUIRED' });
    }.bind(this));
  },

  /**
   * قراءة القيمة المخزّنة لمفتاح idempotency (legacy).
   * @param {string} key
   * @returns {string|null}
   */
  read: function(key) {
    var props = PropertiesService.getScriptProperties();
    var value = props.getProperty(key);
    return (value !== undefined && value !== null) ? value : null;
  },

  /**
   * كتابة قيمة لمفتاح idempotency (legacy).
   * @param {string} key
   * @param {string} value
   * @returns {boolean}
   */
  write: function(key, value) {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(key, value);
    return true;
  }
};
