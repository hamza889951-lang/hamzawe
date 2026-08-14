/**
 * Webhook.gs — ADR-023 / B2
 * استقبال ← تحليل ← claim ذري ← توجيه ← إرسال
 *
 * B2 — Atomic Webhook Idempotency:
 *   المسار الحرج يستخدم ProcessedMessagesService.claim() بدلاً من
 *   isDuplicate() + markProcessed() المنفصلتين.
 *   الـclaim عملية ذرية داخل Lock.runExclusive() — لا يمكن لتكرارين
 *   متزامنين لنفس messageId الدخول إلى Router معًا.
 */
function doPost(e) {
  try {
    const parsed = WhatsAppAdapter.parseIncomingPayload(e);

    if (!parsed) {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'WEBHOOK_PARSE_FAILED',
        phone: '',
        slotId: '',
        stage: 'END',
        success: false,
        durationMs: null,
        error: e && e.postData ? e.postData.contents : 'NO_POST_DATA'
      });
      return ContentService.createTextOutput('IGNORED');
    }

    // ─────────────────────────────────────────────────────────
    // B2: Atomic claim — idempotency ownership before Router
    // ─────────────────────────────────────────────────────────
    var msgId = parsed.messageId || null;
    var claimResult = ProcessedMessagesService.claim(msgId, parsed.phone, parsed.message);

    // فشلClaim (lock timeout / persistence failure) → لا تدخل business processing
    if (!claimResult.ok) {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'WEBHOOK_CLAIM_FAILED',
        phone: parsed.phone,
        slotId: '',
        stage: 'IDEMPOTENCY',
        success: false,
        durationMs: null,
        error: claimResult.error ? JSON.stringify(claimResult.error) : 'CLAIM_FAILED'
      });
      return ContentService.createTextOutput('OK');
    }

    // duplicate → أوقف فورًا، لا تدخل Router
    if (claimResult.data && claimResult.data.status === 'DUPLICATE') {
      return ContentService.createTextOutput('OK');
    }

    // ACQUIRED — امضِ إلى business processing
    const result = Router.dispatch({
      phone: parsed.phone,
      message: parsed.message
    });

    if (!result.ok) {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'WEBHOOK_ROUTER_FAILED',
        phone: parsed.phone,
        slotId: '',
        stage: 'END',
        success: false,
        durationMs: null,
        error: JSON.stringify(result.error)
      });
      return ContentService.createTextOutput('OK');
    }

    if (result.data && result.data.reply) {
      const sendResult = WhatsAppAdapter.sendMessage(
        parsed.phone,
        result.data.reply
      );

      if (!sendResult.ok) {
        LogRepository.write({
          timestamp: Clock.now(),
          command: 'WEBHOOK_SEND_FAILED',
          phone: parsed.phone,
          slotId: '',
          stage: 'END',
          success: false,
          durationMs: null,
          error: JSON.stringify(sendResult.error)
        });
      }
    }

    return ContentService.createTextOutput('OK');

  } catch (err) {
    try {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'WEBHOOK_CRASH',
        phone: '',
        slotId: '',
        stage: 'END',
        success: false,
        durationMs: null,
        error: err.message || 'Unknown error in doPost'
      });
    } catch (logErr) {
      // لا نرمي
    }
    return ContentService.createTextOutput('ERROR_LOGGED');
  }
}
