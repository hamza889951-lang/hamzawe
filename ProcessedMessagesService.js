/**
 * ProcessedMessagesService.gs — ADR-023 / B2
 * Webhook Idempotency — Atomic Claim
 *
 * ═══════════════════════════════════════
 * CONTRACT
 * ═══════════════════════════════════════
 *
 * يضمن:
 *   - claim(messageId, phone, message): يبني مفتاح الرسالة ويفوّض
 *     العملية الذرية إلى ProcessedMessagesRepository.claim().
 *     لا يعرف Service أي تفاصيل عن Lock أو PropertiesService.
 *
 *   - إرجاع Result:
 *       Result.ok({ status: 'ACQUIRED' })  — هذا execution يملك الرسالة
 *       Result.ok({ status: 'DUPLICATE' }) — execution آخر يملكها أو سبق له
 *       Result.fail(...)                    — فشل ذرية أو تخزين (من Repository)
 *
 * لا يضمن:
 *   - أي ذرية — مسؤولية ProcessedMessagesRepository.
 *   - أي تخزين — مسؤولية ProcessedMessagesRepository.
 *   - أي cleanup تلقائي للمفاتيح المنتهية.
 *   - أي منطق عمل — فقط idempotency ownership.
 *
 * ═══════════════════════════════════════
 * Layering (B2 Correction)
 * ═══════════════════════════════════════
 *
 *   ProcessedMessagesService.claim(messageId, phone, message)
 *       ↓ build key
 *   ProcessedMessagesRepository.claim(key, nowMs, windowMs)
 *       ↓ Lock.runExclusive + PropertiesService
 *
 *   Service owns: key building, policy (DUPLICATE_WINDOW_MS), contract.
 *   Repository owns: atomicity (Lock), persistence (PropertiesService).
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
   * يفوّض العملية الذرية بالكامل إلى ProcessedMessagesRepository.
   *
   * @param {string|null} messageId - من UltraMsg payload (data.id)
   * @param {string} phone
   * @param {string} message
   * @returns {Result}
   *   ok({ status: 'ACQUIRED' })  — execution يملك الرسالة، يُسمح بدخول Router
   *   ok({ status: 'DUPLICATE' }) — execution آخر سبق، لا تدخل Router
   *   fail(...)                    — فشل من Repository (lock/read/write)
   */
  claim: function(messageId, phone, message) {
    var key = this._buildKey(messageId, phone, message);
    var nowMs = Clock.now().getTime();
    return ProcessedMessagesRepository.claim(key, nowMs, this.DUPLICATE_WINDOW_MS);
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
