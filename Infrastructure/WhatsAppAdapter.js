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

    const payload = JSON.stringify(body);
    const url = 'https://graph.facebook.com/' + version + '/' + phoneNumberId + '/messages';

    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + accessToken },
        payload: payload,
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

      const mappedCode = this._mapSendErrorCode(code, raw);
      const diagnostic = this._buildSendDiagnostic({
        body: body,
        payload: payload,
        url: url,
        version: version,
        phoneNumberId: phoneNumberId,
        accessToken: accessToken,
        httpCode: code,
        raw: raw,
        parsed: parsed,
        mappedCode: mappedCode
      });

      return Result.fail(
        mappedCode,
        'Meta WhatsApp send failed with HTTP ' + code,
        {
          httpCode: code,
          providerResponse: raw.slice(0, 2000),
          diagnostic: diagnostic
        }
      );
    } catch (e) {
      return Result.fail('WHATSAPP_PROVIDER_UNAVAILABLE', e.message, {
        diagnostic: {
          classification: 'PROVIDER_REQUEST_EXCEPTION',
          exceptionType: e && e.name ? e.name : 'UNKNOWN',
          message: e && e.message ? String(e.message).slice(0, 500) : 'Unknown provider request exception'
        }
      });
    }
  },

  _buildSendDiagnostic: function(args) {
    const error = args.parsed && args.parsed.error ? args.parsed.error : null;
    const errorData = error && error.error_data ? error.error_data : null;

    return {
      diagnosticVersion: 'SEND-FAILURE-v1',
      classification: this._classifySendFailure(args.httpCode, error),
      request: {
        graphApiVersion: args.version,
        phoneNumberIdFingerprint: this._sha256(args.phoneNumberId),
        endpointFingerprint: this._sha256(args.url),
        method: 'post',
        contentType: 'application/json',
        bodyFingerprint: this._sha256(args.payload),
        bodyByteLength: args.payload.length,
        recipientFingerprint: this._sha256(args.body && args.body.to ? String(args.body.to) : ''),
        messageType: args.body && args.body.type ? args.body.type : null
      },
      runtime: {
        adapter: 'WhatsAppAdapter._postMessage',
        tokenLength: String(args.accessToken || '').length,
        tokenFingerprint: this._sha256(args.accessToken)
      },
      provider: {
        httpCode: args.httpCode,
        errorCode: error && error.code != null ? error.code : null,
        errorSubcode: error && error.error_subcode != null ? error.error_subcode : null,
        errorType: error && error.type ? error.type : null,
        errorMessage: error && error.message ? String(error.message).slice(0, 1000) : null,
        errorDataDetails: errorData && errorData.details
          ? String(errorData.details).slice(0, 1000)
          : null,
        traceId: error && error.fbtrace_id ? error.fbtrace_id : null
      },
      mapping: {
        mappedErrorCode: args.mappedCode
      }
    };
  },

  _classifySendFailure: function(httpCode, error) {
    const code = error && error.code != null ? Number(error.code) : null;
    const subcode = error && error.error_subcode != null ? Number(error.error_subcode) : null;

    if (httpCode === 401 || httpCode === 403) return 'AUTHORIZATION_HTTP_REJECTION';
    if (httpCode === 429) return 'RATE_LIMIT_HTTP_REJECTION';
    if (code === 130429) return 'RATE_LIMIT_OR_THROUGHPUT_REJECTION';
    if (code === 131056) return 'PAIR_RATE_LIMIT_REJECTION';
    if (code === 131047) return 'OUTSIDE_CUSTOMER_SERVICE_WINDOW';
    if (code === 131026) return 'MESSAGE_UNDELIVERABLE';
    if (code === 131031) return 'ACCOUNT_OR_PHONE_RESTRICTED';
    if (code === 100 && subcode != null) return 'META_CODE_100_WITH_SUBCODE';
    if (code === 100) return 'META_CODE_100_GENERAL_REJECTION';
    return 'UNCLASSIFIED_META_SEND_FAILURE';
  },

  _sha256: function(value) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      String(value == null ? '' : value),
      Utilities.Charset.UTF_8
    );
    return bytes.map(function(byte) {
      const n = (byte + 256) % 256;
      const h = n.toString(16);
      return h.length === 1 ? '0' + h : h;
    }).join('');
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
