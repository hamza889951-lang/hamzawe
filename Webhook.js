/**
 * Webhook.gs — Meta Cloud / B2 trusted ingress.
 * Temporary diagnostic trace: execution log only; never logs phone, payload,
 * message text, tokens, or other user data. Remove after incident closure.
 */
function webhookDoctorTrace(stage, startedAt, details) {
  try {
    console.log('[HAMZAWE_DOCTOR_TRACE] ' + JSON.stringify({
      component: 'Webhook',
      stage: stage,
      elapsedMs: startedAt ? Clock.now().getTime() - startedAt : null,
      details: details || null
    }));
  } catch (ignored) {}
}

function doPost(e) {
  var traceStartedAt = Clock.now().getTime();
  webhookDoctorTrace('POST_ENTER', traceStartedAt);
  try {
    webhookDoctorTrace('BEFORE_PARSE', traceStartedAt);
    const parsed = WhatsAppAdapter.parseIncomingPayload(e);
    webhookDoctorTrace('AFTER_PARSE', traceStartedAt, parsed ? {
      eventType: parsed.eventType || null,
      messageType: parsed.messageType || null,
      hasMessageId: !!parsed.messageId
    } : { parsed: false });

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

    if (parsed.messageType &&
        parsed.messageType !== 'TEXT' &&
        parsed.messageType !== 'BUTTON' &&
        parsed.messageType !== 'INTERACTIVE_BUTTON') {
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

    webhookDoctorTrace('BEFORE_CLAIM', traceStartedAt);
    var claimResult = ProcessedMessagesService.claim(
      parsed.messageId || null,
      parsed.phone,
      parsed.message
    );
    webhookDoctorTrace('AFTER_CLAIM', traceStartedAt, {
      ok: !!claimResult.ok,
      status: claimResult.data && claimResult.data.status || null,
      errorCode: claimResult.error && claimResult.error.code || null
    });

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

    webhookDoctorTrace('BEFORE_ROUTER_DISPATCH', traceStartedAt);
    const result = Router.dispatch({
      phone: parsed.phone,
      message: parsed.message,
      messageId: parsed.messageId,
      timestampMs: parsed.timestampMs
    });
    webhookDoctorTrace('AFTER_ROUTER_DISPATCH', traceStartedAt, {
      ok: !!result.ok,
      errorCode: result.error && result.error.code || null,
      hasReply: !!(result.data && result.data.reply)
    });

    if (typeof ConversationRepository !== 'undefined' &&
        typeof ConversationRepository.recordInboundMessage === 'function') {
      webhookDoctorTrace('BEFORE_INBOUND_METADATA', traceStartedAt);
      var inboundRecorded = ConversationRepository.recordInboundMessage(
        parsed.phone,
        parsed.messageId,
        parsed.timestampMs
      );
      webhookDoctorTrace('AFTER_INBOUND_METADATA', traceStartedAt, {
        ok: !!inboundRecorded.ok,
        errorCode: inboundRecorded.error && inboundRecorded.error.code || null
      });
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
      webhookDoctorTrace('BEFORE_SEND_REPLY', traceStartedAt);
      const sendResult = MessagingPolicyService.sendReply(
        parsed.phone,
        result.data.reply,
        result.data.deliveryOptions || null
      );
      webhookDoctorTrace('AFTER_SEND_REPLY', traceStartedAt, {
        ok: !!sendResult.ok,
        errorCode: sendResult.error && sendResult.error.code || null
      });
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
    webhookDoctorTrace('WEBHOOK_CATCH', traceStartedAt, {
      errorName: err && err.name || null,
      errorMessage: err && err.message ? String(err.message).slice(0, 180) : 'unknown'
    });
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
