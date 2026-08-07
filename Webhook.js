/**
 * Webhook.gs — ADR-023
 * استقبال ← تحليل ← فحص تكرار (Idempotency) ← توجيه ← إرسال
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

    // ADR-023: Idempotency — منع تكرار الرسائل
    var msgId = parsed.messageId || null;
    if (ProcessedMessagesService.isDuplicate(msgId, parsed.phone, parsed.message)) {
      return ContentService.createTextOutput('OK');
    }
    ProcessedMessagesService.markProcessed(msgId, parsed.phone, parsed.message);

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
