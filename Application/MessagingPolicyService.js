/**
 * MessagingPolicyService
 *
 * Provider-neutral outbound messaging policy.
 *
 * Responsibilities:
 * - distinguish conversational replies from proactive notifications;
 * - use the last verified inbound message timestamp for the WhatsApp
 *   service-window decision;
 * - use plain text only when policy permits;
 * - require an explicitly configured WhatsApp template outside that window;
 * - never know Graph API URLs, tokens, or provider payload details.
 */
const MessagingPolicyService = {
  WINDOW_MS: 24 * 60 * 60 * 1000,

  KINDS: {
    REMINDER: 'REMINDER',
    REMINDER_NO_BUS: 'REMINDER_NO_BUS',
    DISRUPTION_PROPOSAL: 'DISRUPTION_PROPOSAL',
    DISRUPTION_NO_ALTERNATIVE: 'DISRUPTION_NO_ALTERNATIVE',
    OPS_LIVENESS: 'OPS_LIVENESS',
    B6_RECOVERY: 'B6_RECOVERY',
    GENERIC_PROACTIVE: 'GENERIC_PROACTIVE'
  },

  sendReply: function(phone, text) {
    return WhatsAppAdapter.sendText(phone, text);
  },

  sendProactive: function(phone, text, options) {
    options = options || {};
    var kind = options.kind || this.KINDS.GENERIC_PROACTIVE;
    var nowMs = Clock.now().getTime();

    var conversation = null;
    try {
      conversation = ConversationRepository.findByPhone(phone);
    } catch (e) {
      return Result.fail(
        'WHATSAPP_MESSAGING_POLICY_READ_FAILED',
        'Unable to inspect inbound-message timing before proactive send',
        e.message || String(e)
      );
    }

    var lastInboundMs = conversation && conversation.last_inbound_at_ms !== ''
      ? Number(conversation.last_inbound_at_ms)
      : NaN;

    if (isFinite(lastInboundMs) &&
        lastInboundMs > 0 &&
        lastInboundMs <= nowMs &&
        nowMs - lastInboundMs < this.WINDOW_MS) {
      return WhatsAppAdapter.sendText(phone, text);
    }

    var templateResult = WhatsAppTemplateRepository.getTemplate(kind, options);
    if (!templateResult.ok) return templateResult;

    return WhatsAppAdapter.sendTemplate(
      phone,
      templateResult.data.name,
      templateResult.data.language,
      templateResult.data.parameters
    );
  },

};
