/**
 * Meta Cloud Runtime Send Diagnostic — controlled transport audit.
 *
 * PURPOSE
 * -------
 * Compare the production WhatsAppAdapter.sendText() runtime path with an
 * independent UrlFetchApp request built from the same Script Properties.
 *
 * This diagnostic is NOT part of the webhook/business path.
 * It performs two outbound test sends when explicitly run:
 *   1) WhatsAppAdapter.sendText()
 *   2) direct UrlFetchApp.fetch() using the same endpoint/auth/body contract
 *
 * SAFE OUTPUT
 * -----------
 * Never logs:
 * - META_ACCESS_TOKEN
 * - WHATSAPP_GATEWAY_SECRET
 * - message text
 * - Authorization header
 *
 * It logs only endpoint/version metadata, request-shape facts, HTTP status,
 * and provider response status/error code/message (without token material).
 *
 * RUN:
 *   runMetaCloudRuntimeSendDiagnostic('+964XXXXXXXXXX')
 *
 * The recipient must be a controlled test recipient.
 */
function runMetaCloudRuntimeSendDiagnostic(recipient) {
  var result = {
    diagnostic: 'META_CLOUD_RUNTIME_SEND_AUDIT_V2',
    ok: false,
    config: {},
    runtimeAdapter: {},
    adapterPath: {},
    directPath: {},
    comparison: {},
    error: null
  };

  try {
    if (!recipient || typeof recipient !== 'string') {
      throw new Error('A controlled test recipient is required');
    }

    var props = PropertiesService.getScriptProperties();
    var version = props.getProperty('META_GRAPH_API_VERSION') || '';
    var phoneNumberId = props.getProperty('META_PHONE_NUMBER_ID') || '';
    var accessToken = props.getProperty('META_ACCESS_TOKEN') || '';

    if (!version || !phoneNumberId || !accessToken) {
      throw new Error('Meta Cloud API Script Properties are incomplete');
    }

    var url =
      'https://graph.facebook.com/' +
      version +
      '/' +
      phoneNumberId +
      '/messages';

    var testText = 'HAMZAWE Meta runtime audit V2';
    var body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: {
        preview_url: false,
        body: testText
      }
    };

    result.config = {
      graphApiVersion: version,
      phoneNumberIdPresent: !!phoneNumberId,
      endpointSuffix: '/messages',
      method: 'post',
      contentType: 'application/json'
    };

    result.runtimeAdapter = {
      defined: typeof WhatsAppAdapter !== 'undefined',
      sendTextFunction: typeof WhatsAppAdapter !== 'undefined' &&
        typeof WhatsAppAdapter.sendText === 'function',
      postMessageFunction: typeof WhatsAppAdapter !== 'undefined' &&
        typeof WhatsAppAdapter._postMessage === 'function',
      propertyKeysPresent: typeof WhatsAppAdapter !== 'undefined' &&
        !!WhatsAppAdapter.PROPERTY_KEYS,
      messageTypesPresent: typeof WhatsAppAdapter !== 'undefined' &&
        !!WhatsAppAdapter.MESSAGE_TYPES
    };

    if (!result.runtimeAdapter.defined ||
        !result.runtimeAdapter.sendTextFunction ||
        !result.runtimeAdapter.postMessageFunction) {
      throw new Error('Expected WhatsAppAdapter runtime definition is unavailable');
    }

    /*
     * PATH A — exact production adapter entry point.
     * Result is captured without printing message text or token material.
     */
    var adapterResult = WhatsAppAdapter.sendText(recipient, testText);

    result.adapterPath = summarizeAdapterResult(adapterResult);

    /*
     * PATH B — independent direct request using the same Script Properties
     * and the same documented Meta Cloud API request shape.
     */
    var directResponse = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + accessToken
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    result.directPath = summarizeProviderResponse(
      directResponse.getResponseCode(),
      directResponse.getContentText() || ''
    );

    result.comparison = {
      adapterHttpCode: result.adapterPath.httpCode,
      directHttpCode: result.directPath.httpCode,
      adapterSuccess: result.adapterPath.success,
      directSuccess: result.directPath.success,
      sameHttpOutcome: result.adapterPath.httpCode === result.directPath.httpCode,
      directProviderAcceptedRequest:
        result.directPath.httpCode >= 200 &&
        result.directPath.httpCode < 300
    };

    result.ok =
      result.runtimeAdapter.defined &&
      result.runtimeAdapter.sendTextFunction &&
      result.runtimeAdapter.postMessageFunction &&
      result.directPath.success === true;

    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    result.error = err && err.message ? String(err.message) : String(err);
    console.log(JSON.stringify(result));
    return result;
  }
}

function summarizeAdapterResult(result) {
  var output = {
    resultPresent: !!result,
    success: false,
    errorCode: null,
    httpCode: null,
    providerMessageIdPresent: false,
    providerResponseErrorCode: null,
    providerResponseErrorType: null,
    providerResponseErrorMessage: null
  };

  if (!result) return output;

  output.success = result.ok === true;
  output.errorCode = result.error && result.error.code
    ? String(result.error.code)
    : null;

  var details = result.error && result.error.details
    ? result.error.details
    : null;

  if (details) {
    output.httpCode = Number(details.httpCode) || null;

    var raw = String(details.providerResponse || '');
    var parsed = safeParseJsonForDiagnostic(raw);
    var providerError = parsed && parsed.error ? parsed.error : null;

    if (providerError) {
      output.providerResponseErrorCode =
        providerError.code !== undefined
          ? Number(providerError.code) || null
          : null;
      output.providerResponseErrorType =
        providerError.type ? String(providerError.type) : null;
      output.providerResponseErrorMessage =
        providerError.message ? String(providerError.message) : null;
    }
  }

  if (result.data && result.data.providerMessageId) {
    output.providerMessageIdPresent = true;
  }

  return output;
}

function summarizeProviderResponse(httpCode, raw) {
  var parsed = safeParseJsonForDiagnostic(raw);
  var providerError = parsed && parsed.error ? parsed.error : null;

  return {
    httpCode: Number(httpCode) || null,
    success: Number(httpCode) >= 200 && Number(httpCode) < 300,
    providerMessageIdPresent:
      !!(parsed && parsed.messages && parsed.messages[0] && parsed.messages[0].id),
    providerResponseErrorCode:
      providerError && providerError.code !== undefined
        ? Number(providerError.code) || null
        : null,
    providerResponseErrorType:
      providerError && providerError.type
        ? String(providerError.type)
        : null,
    providerResponseErrorMessage:
      providerError && providerError.message
        ? String(providerError.message)
        : null
  };
}

function safeParseJsonForDiagnostic(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch (e) {
    return null;
  }
}
