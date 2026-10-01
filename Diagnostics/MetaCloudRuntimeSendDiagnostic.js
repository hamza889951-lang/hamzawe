/**
 * Meta Cloud Runtime Send Diagnostic — credential/runtime isolation audit.
 *
 * PURPOSE
 * -------
 * Isolate the current Meta HTTP 400 / OAuthException code 100 by testing:
 *   1) the raw Script Property token;
 *   2) the same token after trim();
 *   3) GET access to the configured Phone Number object;
 *   4) POST /messages using the raw token;
 *   5) POST /messages using the trimmed token ONLY if raw POST fails.
 *
 * The diagnostic recipient is intentionally fixed to the controlled test
 * recipient supplied for this investigation.
 *
 * SAFE OUTPUT
 * -----------
 * Never logs:
 * - META_ACCESS_TOKEN
 * - WHATSAPP_GATEWAY_SECRET
 * - Authorization header
 * - message text
 * - raw provider response
 *
 * It logs only non-secret token shape metadata, HTTP status, and provider
 * error code/type/message.
 *
 * IMPORTANT
 * ---------
 * This diagnostic can send at most one successful test message from the
 * direct POST probe, plus the production WhatsAppAdapter probe. The adapter
 * probe is performed only after credential probes complete.
 */

var META_RUNTIME_DIAGNOSTIC_RECIPIENT = '9647824134670';

function runMetaCloudRuntimeSendDiagnostic() {
  var result = {
    diagnostic: 'META_CLOUD_RUNTIME_SEND_AUDIT_V3',
    ok: false,
    config: {},
    tokenShape: {},
    phoneAccess: {},
    directRawPath: {},
    directTrimmedPath: {},
    runtimeAdapter: {},
    adapterPath: {},
    comparison: {},
    error: null
  };

  try {
    var props = PropertiesService.getScriptProperties();
    var version = props.getProperty('META_GRAPH_API_VERSION') || '';
    var phoneNumberId = props.getProperty('META_PHONE_NUMBER_ID') || '';
    var rawToken = props.getProperty('META_ACCESS_TOKEN') || '';
    var trimmedToken = rawToken.trim();

    if (!version || !phoneNumberId || !rawToken) {
      throw new Error('Meta Cloud API Script Properties are incomplete');
    }

    var messagesUrl =
      'https://graph.facebook.com/' +
      version +
      '/' +
      phoneNumberId +
      '/messages';

    var phoneUrl =
      'https://graph.facebook.com/' +
      version +
      '/' +
      phoneNumberId;

    var testText = 'HAMZAWE Meta runtime audit V3';

    var body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: META_RUNTIME_DIAGNOSTIC_RECIPIENT,
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
      contentType: 'application/json',
      recipientConfigured: META_RUNTIME_DIAGNOSTIC_RECIPIENT === '9647824134670'
    };

    result.tokenShape = {
      rawLength: rawToken.length,
      trimmedLength: trimmedToken.length,
      leadingWhitespacePresent: rawToken.length !== rawToken.replace(/^\\s+/, '').length,
      trailingWhitespacePresent: rawToken.length !== rawToken.replace(/\\s+$/, '').length,
      changedByTrim: rawToken !== trimmedToken
    };

    /*
     * PROBE A/B — token validity from inside Apps Script.
     *
     * If GET with raw token fails but trimmed succeeds, the Script Property
     * contains leading/trailing whitespace and that is the immediate cause.
     */
    result.phoneAccess.raw = summarizeProviderResponse(
      fetchPhoneObject(phoneUrl, rawToken)
    );

    result.phoneAccess.trimmed = summarizeProviderResponse(
      fetchPhoneObject(phoneUrl, trimmedToken)
    );

    /*
     * PROBE C — POST with the exact stored token.
     */
    var rawPostResponse = UrlFetchApp.fetch(messagesUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + rawToken
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    result.directRawPath = summarizeProviderResponse(
      rawPostResponse
    );

    /*
     * PROBE D — only if raw POST failed, retry with trim() and the SAME body.
     * This avoids an unnecessary second successful message when raw already
     * works.
     */
    if (!result.directRawPath.success) {
      var trimmedPostResponse = UrlFetchApp.fetch(messagesUrl, {
        method: 'post',
        contentType: 'application/json',
        headers: {
          Authorization: 'Bearer ' + trimmedToken
        },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });

      result.directTrimmedPath = summarizeProviderResponse(
        trimmedPostResponse
      );
    } else {
      result.directTrimmedPath = {
        skipped: true,
        reason: 'rawPostSucceeded'
      };
    }

    /*
     * PROBE E — production adapter runtime.
     *
     * This remains after the credential probes so the result can be correlated
     * with the exact runtime token behavior.
     */
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

    if (result.runtimeAdapter.defined &&
        result.runtimeAdapter.sendTextFunction &&
        result.runtimeAdapter.postMessageFunction) {
      var adapterResult = WhatsAppAdapter.sendText(
        META_RUNTIME_DIAGNOSTIC_RECIPIENT,
        testText
      );
      result.adapterPath = summarizeAdapterResult(adapterResult);
    } else {
      result.adapterPath = {
        skipped: true,
        reason: 'WhatsAppAdapter runtime definition unavailable'
      };
    }

    result.comparison = {
      rawTokenPhoneGetAccepted:
        result.phoneAccess.raw.success === true,
      trimmedTokenPhoneGetAccepted:
        result.phoneAccess.trimmed.success === true,
      rawTokenPostAccepted:
        result.directRawPath.success === true,
      trimmedTokenPostAccepted:
        result.directTrimmedPath.success === true ||
        result.directTrimmedPath.skipped === true &&
        result.directRawPath.success === true,
      adapterAccepted:
        result.adapterPath.success === true,
      trimChangedToken:
        result.tokenShape.changedByTrim,
      likelyWhitespaceIssue:
        result.tokenShape.changedByTrim === true &&
        result.phoneAccess.raw.success === false &&
        result.phoneAccess.trimmed.success === true,
      likelyHeaderOrRawTokenIssue:
        result.directRawPath.success === false &&
        result.directTrimmedPath.success === true,
      likelySharedRuntimeCredentialIssue:
        result.phoneAccess.raw.success === false &&
        result.phoneAccess.trimmed.success === false &&
        result.directRawPath.success === false,
      likelyAdapterSpecificIssue:
        result.directTrimmedPath.success === true &&
        result.adapterPath.success === false
    };

    result.ok =
      result.phoneAccess.trimmed.success === true &&
      (
        result.directRawPath.success === true ||
        result.directTrimmedPath.success === true
      );

    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    result.error = err && err.message ? String(err.message) : String(err);
    console.log(JSON.stringify(result));
    return result;
  }
}

function fetchPhoneObject(url, token) {
  return UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token
    },
    muteHttpExceptions: true
  });
}

function summarizeProviderResponse(response) {
  var httpCode = Number(response.getResponseCode()) || null;
  var raw = response.getContentText() || '';
  var parsed = safeParseJsonForDiagnostic(raw);
  var providerError = parsed && parsed.error ? parsed.error : null;

  return {
    httpCode: httpCode,
    success: httpCode >= 200 && httpCode < 300,
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

function safeParseJsonForDiagnostic(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch (e) {
    return null;
  }
}
