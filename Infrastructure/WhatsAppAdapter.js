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

  MESSAGE_TYPES: { TEXT: 'TEXT', BUTTON: 'BUTTON', INTERACTIVE_BUTTON: 'INTERACTIVE_BUTTON', INTERACTIVE_LIST: 'INTERACTIVE_LIST' },

  // Provider-neutral Doctor Interaction Intent -> Meta transport ID.
  // The inverse mapping is applied on inbound callbacks below.
  DOCTOR_INTERACTIVE_INTENT_TO_META_ID: {
    VIEW_SCHEDULE: 'DOCTOR_VIEW_SCHEDULE',
    CHANGE_SCHEDULE: 'DOCTOR_CHANGE_SCHEDULE',
    TEMPORARY_AVAILABILITY: 'DOCTOR_TEMPORARY_AVAILABILITY',
    BACK_TO_MENU: 'DOCTOR_BACK_TO_MENU',
    MORE: 'DOCTOR_MORE',
    REPORTS: 'DOCTOR_REPORTS',
    REPORT_PERIOD_DAILY: 'DOCTOR_REPORT_PERIOD_DAILY',
    REPORT_PERIOD_WEEKLY: 'DOCTOR_REPORT_PERIOD_WEEKLY',
    REPORT_PERIOD_MONTHLY: 'DOCTOR_REPORT_PERIOD_MONTHLY',
    REPORT_RUN_DAILY_SUMMARY: 'DOCTOR_REPORT_RUN_DAILY_SUMMARY',
    REPORT_RUN_DAILY_FULL: 'DOCTOR_REPORT_RUN_DAILY_FULL',
    REPORT_RUN_WEEKLY_SUMMARY: 'DOCTOR_REPORT_RUN_WEEKLY_SUMMARY',
    REPORT_RUN_WEEKLY_FULL: 'DOCTOR_REPORT_RUN_WEEKLY_FULL',
    REPORT_RUN_MONTHLY_SUMMARY: 'DOCTOR_REPORT_RUN_MONTHLY_SUMMARY',
    REPORT_RUN_MONTHLY_FULL: 'DOCTOR_REPORT_RUN_MONTHLY_FULL',
    TEMPORARY_CLOSE: 'DOCTOR_TEMPORARY_CLOSE',
    TEMPORARY_OPEN: 'DOCTOR_EXCEPTION_OPEN',
    CANCEL_CHANGE: 'DOCTOR_CANCEL_CHANGE',
    CONFIRM: 'DOCTOR_CONFIRM',
    CANCEL: 'DOCTOR_CANCEL',

    // Guided Doctor Control UX — provider-neutral intents require explicit
    // transport IDs so outbound and inbound mappings remain symmetric.
    TEMP_CLOSE_FULL_DAY: 'DOCTOR_TEMP_CLOSE_FULL_DAY',
    TEMP_CLOSE_PERIOD: 'DOCTOR_TEMP_CLOSE_PERIOD',
    EDIT: 'DOCTOR_EDIT',
    EDIT_DAYS: 'DOCTOR_EDIT_DAYS',
    EDIT_TIMES: 'DOCTOR_EDIT_TIMES',
    EDIT_DATE: 'DOCTOR_EDIT_DATE'
  },

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

      var canonicalMessage = '';
      if (event.messageType === this.MESSAGE_TYPES.TEXT) {
        canonicalMessage = event.text || '';
      } else if (event.messageType === this.MESSAGE_TYPES.BUTTON ||
                 event.messageType === this.MESSAGE_TYPES.INTERACTIVE_BUTTON ||
                 event.messageType === this.MESSAGE_TYPES.INTERACTIVE_LIST) {
        var buttonMap = {
          HAMZAWE_CONFIRM: '1',
          HAMZAWE_CHANGE: '2',
          HAMZAWE_CANCEL: '3',
          HAMZAWE_DECLINE: '2',
          HAMZAWE_START_BOOKING: 'START_BOOKING',

          // Doctor Control — transport IDs map to provider-neutral
          // interaction intents. These intents are consumed by
          // DoctorControlInteractionService and are not domain commands.
          DOCTOR_VIEW_SCHEDULE: 'VIEW_SCHEDULE',
          DOCTOR_CHANGE_SCHEDULE: 'CHANGE_SCHEDULE',
          DOCTOR_TEMPORARY_AVAILABILITY: 'TEMPORARY_AVAILABILITY',
          DOCTOR_BACK_TO_MENU: 'BACK_TO_MENU',
          DOCTOR_MORE: 'MORE',
          DOCTOR_REPORTS: 'REPORTS',
          DOCTOR_REPORT_PERIOD_DAILY: 'REPORT_PERIOD_DAILY',
          DOCTOR_REPORT_PERIOD_WEEKLY: 'REPORT_PERIOD_WEEKLY',
          DOCTOR_REPORT_PERIOD_MONTHLY: 'REPORT_PERIOD_MONTHLY',
          DOCTOR_REPORT_RUN_DAILY_SUMMARY: 'REPORT_RUN_DAILY_SUMMARY',
          DOCTOR_REPORT_RUN_DAILY_FULL: 'REPORT_RUN_DAILY_FULL',
          DOCTOR_REPORT_RUN_WEEKLY_SUMMARY: 'REPORT_RUN_WEEKLY_SUMMARY',
          DOCTOR_REPORT_RUN_WEEKLY_FULL: 'REPORT_RUN_WEEKLY_FULL',
          DOCTOR_REPORT_RUN_MONTHLY_SUMMARY: 'REPORT_RUN_MONTHLY_SUMMARY',
          DOCTOR_REPORT_RUN_MONTHLY_FULL: 'REPORT_RUN_MONTHLY_FULL',
          DOCTOR_TEMPORARY_CLOSE: 'TEMPORARY_CLOSE',
          DOCTOR_EXCEPTION_OPEN: 'TEMPORARY_OPEN',
          DOCTOR_CANCEL_CHANGE: 'CANCEL_CHANGE',
          DOCTOR_CONFIRM: 'CONFIRM',
          DOCTOR_CANCEL: 'CANCEL',
          DOCTOR_TEMP_CLOSE_FULL_DAY: 'TEMP_CLOSE_FULL_DAY',
          DOCTOR_TEMP_CLOSE_PERIOD: 'TEMP_CLOSE_PERIOD',
          DOCTOR_EDIT: 'EDIT',
          DOCTOR_EDIT_DAYS: 'EDIT_DAYS',
          DOCTOR_EDIT_TIMES: 'EDIT_TIMES',
          DOCTOR_EDIT_DATE: 'EDIT_DATE',
          DOCTOR_DONE_DAYS: 'DONE_DAYS'
        };
        canonicalMessage = buttonMap[String(event.buttonPayload || '')];
        if (canonicalMessage === undefined) return null;
      }

      return {
        eventType: 'MESSAGE',
        channel: event.channel || 'WHATSAPP',
        provider: event.provider || 'META_CLOUD',
        phone: phone,
        message: canonicalMessage,
        messageType: event.messageType || 'UNKNOWN',
        buttonPayload: event.buttonPayload || null,
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

  sendTemplate: function(phone, name, languageCode, parameters, buttonPayloads) {
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

    if (Array.isArray(buttonPayloads) && buttonPayloads.length > 0) {
      template.components = template.components || [];
      buttonPayloads.forEach(function(payload, index) {
        template.components.push({
          type: 'button',
          sub_type: 'quick_reply',
          index: String(index),
          parameters: [{
            type: 'payload',
            payload: String(payload)
          }]
        });
      });
    }

    return this._postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: template
    });
  },

  sendInteractiveButtons: function(phone, text, buttons) {
    if (!phone || typeof phone !== 'string') {
      return Result.fail('WHATSAPP_RECIPIENT_INVALID', 'A recipient phone is required');
    }
    if (typeof text !== 'string' || !text) {
      return Result.fail('WHATSAPP_MESSAGE_INVALID', 'A non-empty text message is required');
    }
    if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 3) {
      return Result.fail(
        'WHATSAPP_INTERACTIVE_INVALID',
        'Interactive reply buttons must contain between one and three buttons'
      );
    }

    var doctorIntentMap = this.DOCTOR_INTERACTIVE_INTENT_TO_META_ID;
    const normalizedButtons = buttons.map(function(button) {
      if (!button || typeof button !== 'object' ||
          !button.id || !button.title) {
        return null;
      }
      const transportId = doctorIntentMap[String(button.id)] || String(button.id);
      return {
        type: 'reply',
        reply: {
          id: transportId,
          title: String(button.title)
        }
      };
    });

    if (normalizedButtons.some(function(button) { return button === null; })) {
      return Result.fail(
        'WHATSAPP_INTERACTIVE_INVALID',
        'Each interactive reply button requires id and title'
      );
    }

    return this._postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: text },
        action: { buttons: normalizedButtons }
      }
    });
  },

  /**
   * Send a WhatsApp interactive list. Meta reply-button messages are limited
   * to three buttons; a list is the supported transport for the five-option
   * Doctor Control menu. Validation is fail-closed before any network call.
   */
  sendInteractiveList: function(phone, text, list) {
    if (!phone || typeof phone !== 'string') {
      return Result.fail('WHATSAPP_RECIPIENT_INVALID', 'A recipient phone is required');
    }
    if (typeof text !== 'string' || !text || text.length > 1024) {
      return Result.fail('WHATSAPP_MESSAGE_INVALID', 'Interactive list body must contain 1-1024 characters');
    }
    if (!list || typeof list !== 'object' ||
        typeof list.buttonTitle !== 'string' ||
        !list.buttonTitle.trim() ||
        list.buttonTitle.length > 20 ||
        !Array.isArray(list.sections) ||
        list.sections.length < 1 ||
        list.sections.length > 10) {
      return Result.fail('WHATSAPP_INTERACTIVE_LIST_INVALID', 'Interactive list requires a button title and 1-10 sections');
    }

    var doctorIntentMap = this.DOCTOR_INTERACTIVE_INTENT_TO_META_ID;
    var seenIds = {};
    var totalRows = 0;
    var normalizedSections = [];

    for (var sectionIndex = 0; sectionIndex < list.sections.length; sectionIndex++) {
      var section = list.sections[sectionIndex];
      if (!section || typeof section !== 'object' ||
          typeof section.title !== 'string' ||
          !section.title.trim() ||
          section.title.length > 24 ||
          !Array.isArray(section.rows) ||
          section.rows.length < 1 ||
          section.rows.length > 10) {
        return Result.fail('WHATSAPP_INTERACTIVE_LIST_INVALID', 'Each section requires a title and 1-10 rows');
      }

      var normalizedRows = [];
      for (var rowIndex = 0; rowIndex < section.rows.length; rowIndex++) {
        var row = section.rows[rowIndex];
        if (!row || typeof row !== 'object' ||
            typeof row.id !== 'string' || !row.id.trim() || row.id.length > 200 ||
            typeof row.title !== 'string' || !row.title.trim() || row.title.length > 24 ||
            (row.description !== undefined &&
             (typeof row.description !== 'string' || row.description.length > 72))) {
          return Result.fail('WHATSAPP_INTERACTIVE_LIST_INVALID', 'Each row requires a valid id and a title of at most 24 characters');
        }

        var transportId = doctorIntentMap[row.id] || row.id;
        if (seenIds[transportId]) {
          return Result.fail('WHATSAPP_INTERACTIVE_LIST_INVALID', 'List row IDs must be unique after transport mapping');
        }
        seenIds[transportId] = true;
        totalRows++;
        normalizedRows.push({
          id: transportId,
          title: row.title,
          ...(row.description !== undefined ? { description: row.description } : {})
        });
      }
      normalizedSections.push({ title: section.title, rows: normalizedRows });
    }

    if (totalRows > 10) {
      return Result.fail('WHATSAPP_INTERACTIVE_LIST_INVALID', 'Interactive lists may contain at most ten rows total');
    }

    return this._postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: text },
        action: {
          button: list.buttonTitle,
          sections: normalizedSections
        }
      }
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
    const digest = Utilities.computeHmacSha256Signature(
      canonical,
      secret,
      Utilities.Charset.UTF_8
    );
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
