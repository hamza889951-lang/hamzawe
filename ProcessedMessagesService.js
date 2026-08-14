/**
 * ProcessedMessagesService.gs — ADR-023 / B2
 * Webhook Idempotency — Atomic Claim
 *
 * ═══════════════════════════════════════
 * CONTRACT
 * ═══════════════════════════════════════
 *
 * يضمن:
 *   - claim(messageId, phone, message): عملية ذرية واحدة تجمع
 *     فحص وجود claim سابق + إنشاء claim جديد داخل Lock.runExclusive().
 *     لا يمكن لتنفيذين متزامنين لنفس المفتاح الحصول على ACQUIRED معًا.
 *
 *   - إرجاع Result:
 *       Result.ok({ status: 'ACQUIRED' })  — هذا execution يملك الرسالة
 *       Result.ok({ status: 'DUPLICATE' }) — execution آخر يملكها أو سبق له
 *       Result.fail(...)                    — فشل ذرية أو تخزين
 *
 * لا يضمن:
 *   - أي ذرية عبر موارد خارجية (Sheets, Calendar).
 *   - أي cleanup تلقائي للمفاتيح المنتهية.
 *   - أي منطق عمل — فقط idempotency ownership.
 *
 * ═══════════════════════════════════════
 * B2 — Atomicity Model
 * ═══════════════════════════════════════
 *
 *   Lock.runExclusive('idempotency')
 *     → read existing claim via ProcessedMessagesRepository
 *     → if valid claim exists → DUPLICATE
 *     → else → write new claim → ACQUIRED
 *     → release lock
 *
 *   Business processing happens OUTSIDE the lock (Webhook.js).
 *
 * ═══════════════════════════════════════
 * TTL / Expiration
 * ═══════════════════════════════════════
 *
 *   Claim صالح لمدة DUPLICATE_WINDOW_MS (300,000ms = 5 دقائق).
 *   هذه هي نفس النافذة المعتمدة في v1 (ADR-023).
 *   بعد انتهاء المدة يصبح المفتاح متاحًا لـ claim جديد (retry آمن).
 *   لا قيمة زمنية جديدة مُخترعة — B2-§11.
 */
const ProcessedMessagesService = {

  DUPLICATE_WINDOW_MS: 300000,

  /**
   * Atomic claim — يملك رسالة inbound ذريًا قبل دخول Router.
   *
   * @param {string|null} messageId - من UltraMsg payload (data.id)
   * @param {string} phone
   * @param {string} message
   * @returns {Result}
   *   ok({ status: 'ACQUIRED' })  — execution يملك الرسالة، يُسمح بدخول Router
   *   ok({ status: 'DUPLICATE' }) — execution آخر سبق، لا تدخل Router
   *   fail('LOCK_TIMEOUT', ...)   — لم يتمكن من الحصول على القفل
   *   fail('CLAIM_PERSISTENCE_FAILED', ...) — فشل تخزين claim
   */
  claim: function(messageId, phone, message) {
    var self = this;
    var key = this._buildKey(messageId, phone, message);

    return Lock.runExclusive('idempotency', function() {
      // ── read existing claim ──
      var storedMs = null;
      try {
        var stored = ProcessedMessagesRepository.read(key);
        if (stored) {
          storedMs = parseInt(stored, 10);
        }
      } catch (e) {
        return Result.fail(
          'CLAIM_READ_FAILED',
          'Failed to read idempotency claim',
          e.message
        );
      }

      // ── check if existing claim is still valid ──
      if (storedMs !== null && !isNaN(storedMs)) {
        var elapsed = Clock.now().getTime() - storedMs;
        if (elapsed < self.DUPLICATE_WINDOW_MS) {
          return Result.ok({ status: 'DUPLICATE' });
        }
        // expired — fall through to acquire
      }

      // ── establish ownership ──
      try {
        var nowMs = Clock.now().getTime();
        ProcessedMessagesRepository.write(key, String(nowMs));
      } catch (e) {
        return Result.fail(
          'CLAIM_PERSISTENCE_FAILED',
          'Failed to persist idempotency claim',
          e.message
        );
      }

      return Result.ok({ status: 'ACQUIRED' });
    });
  },

  // ─────────────────────────────────────
  // Legacy methods — retained for backward compatibility
  // (may have callers outside Webhook critical path)
  // B2-§10: Webhook critical path MUST use claim() instead.
  // ─────────────────────────────────────

  isDuplicate: function(messageId, phone, message) {
    try {
      var key = this._buildKey(messageId, phone, message);
      var stored = ProcessedMessagesRepository.read(key);
      if (!stored) return false;
      var elapsed = Clock.now().getTime() - parseInt(stored, 10);
      return elapsed < this.DUPLICATE_WINDOW_MS;
    } catch (e) {
      return false;
    }
  },

  markProcessed: function(messageId, phone, message) {
    try {
      var key = this._buildKey(messageId, phone, message);
      ProcessedMessagesRepository.write(key, String(Clock.now().getTime()));
    } catch (e) {
      // فشل التخزين ليس fatal
    }
  },

  // ─────────────────────────────────────
  // Key builder — unchanged from v1 (B2-§4: do not redesign fallback)
  // ─────────────────────────────────────

  _buildKey: function(messageId, phone, message) {
    if (messageId) return 'msg_' + messageId;
    var nowMs = Clock.now().getTime();
    var fingerprint = (phone || '') + '|' + (message || '') + '|' + Math.floor(nowMs / 60000);
    var hash = '';
    for (var i = 0; i < fingerprint.length; i++) {
      hash += fingerprint.charCodeAt(i).toString(36);
    }
    return 'msg_' + hash.substring(0, 30);
  }
};
