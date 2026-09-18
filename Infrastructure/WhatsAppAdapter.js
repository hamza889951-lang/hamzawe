/**
 * WhatsAppAdapter — Meta WhatsApp Cloud API transport boundary.
 */
const WhatsAppAdapter = {
  GATEWAY_VERSION: 'v1',
  GATEWAY_MAX_AGE_MS: 5 * 60 * 1000,

  PROPERTY_KEYS: {
    GRAPH_API_VERSION: 'META_GRAPH_API_VERSION',
    PHONE_NUMBER_ID: 'META_PHONE_NUMBER_ID',
    ACCESS_TOKEN: 'META_ACCESS_TOKEN',
    GATEWAY_SECRET: 'WHATSAPP_GATEWAY_SECRET'
  },

  MESSAGE_TYPES: { TEXT: 'TEXT' },

  parseIncomingPayload: function(e) {
    try {
      const payload = JSON.parse(e.postData.contents || '');
      const envelope = payload && payload.event ? payload : null;
      if (!envelope) return null;

      const verify = this._verifyGatewayEnvelope(envelope);
      if (!verify.ok) return null;

      const event = envelope.event;
      if (!event || event.eventType !== 'MESSAGE') {
        return event && event.eventType === 'STATUS'
          ? { eventType: 'STATUS', status: event.status || null }
          : null;
      }

      const phone = PhoneUtils.normalize(event.phone);
      if (!phone || !event.messageId) return null;

      return {
        eventType: 'MESSAGE',
        channel: event.channel || 'WHATSAPP',
        provider: event.provider || 'META_CLOUD',
        phone: phone,
        message: event.messageType === this.MESSAGE_TYPES.TEXT
          ? (event.text || '')
          : '',
        messageType: event.messageType || 'UNKNOWN',
        messageId: event.messageId,
        timestampMs: Number(event.timestampMs)
      };
    } catch (err) {
      return null;
    }
  },

  sendMessage: function(phone, text) {
    return this.sendText(phone, text);
  },

  sendText: function(phone, text) {
    if (!phone || typeof phone !== 'string') {
      return Result.fail('WHATSAPP_RECIPIENT_INVALID', 'A recipient phone is required');
    }
    if (typeof text !== 'string' || !text) {
      return Result.fail('WHATSAPP_MESSAGE_INVALID', 'A non-empty text message is required');
    }

    return this._postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { preview_url: false, body: text }
    });
  },

  sendTemplate: function(phone, name, languageCode, parameters) {
    if (!phone || typeof phone !== 'string') {
      return Result.fail('WHATSAPP_RECIPIENT_INVALID', 'A recipient phone is required');
    }
    if (!name) {
      return Result.fail('WHATSAPP_TEMPLATE_INVALID', 'Template name is required');
    }

    const template = {
      name: name,
      language: { code: languageCode || 'ar' }
    };

    if (Array.isArray(parameters) && parameters.length > 0) {
      template.components = [{
        type: 'body',
        parameters: parameters.map(function(value) {
          return { type: 'text', text: String(value) };
        })
      }];
    }

    return this._postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: template
    });
  },

  _postMessage: function(body) {
    const props = PropertiesService.getScriptProperties();
    const version = props.getProperty(this.PROPERTY_KEYS.GRAPH_API_VERSION);
    const phoneNumberId = props.getProperty(this.PROPERTY_KEYS.PHONE_NUMBER_ID);
    const accessToken = props.getProperty(this.PROPERTY_KEYS.ACCESS_TOKEN);

    if (!version || !phoneNumberId || !accessToken) {
      return Result.fail('WHATSAPP_CONFIG_MISSING', 'Meta WhatsApp Cloud API configuration is incomplete');
    }

    const url = 'https://graph.facebook.com/' + version + '/' + phoneNumberId + '/messages';

    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + accessToken },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });

      const code = response.getResponseCode();
      const raw = response.getContentText() || '';
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) {}

      if (code >= 200 && code < 300) {
        return Result.ok({
          provider: 'META_CLOUD',
          phone: body.to,
          providerMessageId:
            parsed && parsed.messages && parsed.messages[0]
              ? parsed.messages[0].id
              : null
        });
      }

      return Result.fail(
        this._mapSendErrorCode(code, raw),
        'Meta WhatsApp send failed with HTTP ' + code,
        { httpCode: code, providerResponse: raw.slice(0, 2000) }
      );
    } catch (e) {
      return Result.fail('WHATSAPP_PROVIDER_UNAVAILABLE', e.message, e.stack);
    }
  },

  _mapSendErrorCode: function(httpCode, raw) {
    const body = String(raw || '').toLowerCase();
    if (httpCode === 401 || httpCode === 403) return 'WHATSAPP_AUTH_FAILED';
    if (httpCode === 429) return 'WHATSAPP_RATE_LIMITED';
    if (body.indexOf('template') !== -1) {
      return httpCode >= 400 && httpCode < 500
        ? 'WHATSAPP_TEMPLATE_INVALID'
        : 'WHATSAPP_TEMPLATE_REQUIRED';
    }
    if (body.indexOf('recipient') !== -1 || body.indexOf('phone') !== -1) {
      return 'WHATSAPP_RECIPIENT_INVALID';
    }
    return 'WHATSAPP_SEND_FAILED';
  },

  _verifyGatewayEnvelope: function(envelope) {
    if (envelope.gatewayVersion !== this.GATEWAY_VERSION) {
      return Result.fail('INVALID_GATEWAY_VERSION', 'Unsupported gateway envelope version');
    }

    const timestampMs = Number(envelope.gatewayTimestampMs);
    if (!isFinite(timestampMs) ||
        Math.abs(Clock.now().getTime() - timestampMs) > this.GATEWAY_MAX_AGE_MS) {
      return Result.fail('STALE_GATEWAY_EVENT', 'Gateway event is outside the accepted age window');
    }

    const secret = PropertiesService.getScriptProperties().getProperty(
      this.PROPERTY_KEYS.GATEWAY_SECRET
    );
    if (!secret || !envelope.signature || !envelope.event) {
      return Result.fail('GATEWAY_AUTH_CONFIG_MISSING', 'Gateway authentication material is incomplete');
    }

    const canonical = JSON.stringify(envelope.event);
    const digest = Utilities.computeHmacSha256Signature(canonical, secret);
    const expected = digest.map(function(byte) {
      const n = (byte + 256) % 256;
      const h = n.toString(16);
      return h.length === 1 ? '0' + h : h;
    }).join('');

    if (!this._constantTimeEqual(expected, String(envelope.signature))) {
      return Result.fail('INVALID_GATEWAY_SIGNATURE', 'Gateway signature verification failed');
    }

    return Result.ok({ verified: true });
  },

  _constantTimeEqual: function(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let different = 0;
    for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return different === 0;
  }
};
