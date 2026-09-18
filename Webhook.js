/**
 * Webhook.gs — Meta Cloud / B2 trusted ingress.
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

    if (parsed.eventType === 'STATUS') {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'WEBHOOK_STATUS_IGNORED',
        phone: '',
        slotId: '',
        stage: 'END',
        success: true,
        durationMs: null,
        error: null
      });
      return ContentService.createTextOutput('OK');
    }

    if (parsed.messageType && parsed.messageType !== 'TEXT') {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'WEBHOOK_UNSUPPORTED_MESSAGE',
        phone: parsed.phone || '',
        slotId: '',
        stage: 'END',
        success: true,
        durationMs: null,
        error: JSON.stringify({ messageType: parsed.messageType })
      });
      return ContentService.createTextOutput('OK');
    }

    var claimResult = ProcessedMessagesService.claim(
      parsed.messageId || null,
      parsed.phone,
      parsed.message
    );

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

    if (claimResult.data && claimResult.data.status === 'DUPLICATE') {
      return ContentService.createTextOutput('OK');
    }

    const result = Router.dispatch({
      phone: parsed.phone,
      message: parsed.message,
      messageId: parsed.messageId,
      timestampMs: parsed.timestampMs
    });

    if (typeof ConversationRepository !== 'undefined' &&
        typeof ConversationRepository.recordInboundMessage === 'function') {
      var inboundRecorded = ConversationRepository.recordInboundMessage(
        parsed.phone,
        parsed.messageId,
        parsed.timestampMs
      );
      if (!inboundRecorded.ok) {
        LogRepository.write({
          timestamp: Clock.now(),
          command: 'WEBHOOK_INBOUND_METADATA_FAILED',
          phone: parsed.phone,
          slotId: '',
          stage: 'METADATA',
          success: false,
          durationMs: null,
          error: JSON.stringify(inboundRecorded.error)
        });
      }
    }

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
      const sendResult = MessagingPolicyService.sendReply(parsed.phone, result.data.reply);
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
    } catch (logErr) {}
    return ContentService.createTextOutput('ERROR_LOGGED');
  }
}
