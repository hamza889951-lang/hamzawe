/**
 * Meta Cloud Runtime Send Diagnostic — Meta authorization isolation audit.
 *
 * Controlled recipient: 9647824134670
 *
 * V4 PURPOSE
 * ----------
 * We already proved:
 * - the Apps Script token authenticates GET /{PHONE_NUMBER_ID};
 * - raw and trimmed tokens are identical;
 * - POST /messages fails with OAuthException code 100;
 * - the production adapter and independent UrlFetchApp path fail identically.
 *
 * V4 therefore isolates the remaining request-level variables:
 *   A) exact minimal Graph API Explorer-style JSON body;
 *   B) production body with recipient_type;
 *   C) Authorization: Bearer header;
 *   D) access_token query parameter (diagnostic only);
 *   E) GET /debug_token using the same token;
 *   F) full OAuth error fields, including subcode and trace id.
 *
 * SAFE OUTPUT
 * -----------
 * Never logs the access token, Authorization header, raw response body,
 * message text, or gateway secret.
 *
 * This diagnostic sends test messages only when a POST probe is accepted.
 * It stops trying POST variants after the first successful POST to avoid
 * duplicate successful messages.
 */

var META_RUNTIME_DIAGNOSTIC_RECIPIENT = '9647824134670';

function runMetaCloudRuntimeSendDiagnostic() {
  var result = {
    diagnostic: 'META_CLOUD_RUNTIME_SEND_AUDIT_V4',
    ok: false,
    config: {},
    tokenShape: {},
    tokenDebug: {},
    phoneAccess: {},
    postProbes: {},
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

    var debugTokenUrl =
      'https://graph.facebook.com/' +
      version +
      '/debug_token?input_token=' +
      encodeURIComponent(trimmedToken);

    /*
     * Body A deliberately matches the previously successful Graph API
     * Explorer request: no recipient_type field.
     */
    var minimalBody = {
      messaging_product: 'whatsapp',
      to: META_RUNTIME_DIAGNOSTIC_RECIPIENT,
      type: 'text',
      text: {
        preview_url: false,
        body: 'HAMZAWE Meta runtime audit V4'
      }
    };

    /*
     * Body B is the current production adapter shape.
     */
    var adapterBody = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: META_RUNTIME_DIAGNOSTIC_RECIPIENT,
      type: 'text',
      text: {
        preview_url: false,
        body: 'HAMZAWE Meta runtime audit V4'
      }
    };

    result.config = {
      graphApiVersion: version,
      phoneNumberIdPresent: !!phoneNumberId,
      messagesEndpoint: '/messages',
      debugTokenEndpoint: '/debug_token',
      method: 'post',
      contentType: 'application/json',
      recipientConfigured:
        META_RUNTIME_DIAGNOSTIC_RECIPIENT === '9647824134670'
    };

    result.tokenShape = {
      rawLength: rawToken.length,
      trimmedLength: trimmedToken.length,
      leadingWhitespacePresent:
        rawToken.length !== rawToken.replace(/^\s+/, '').length,
      trailingWhitespacePresent:
        rawToken.length !== rawToken.replace(/\s+$/, '').length,
      changedByTrim: rawToken !== trimmedToken
    };

    /*
     * PROBE 1 — GET phone object with the same Bearer token.
     * This is the already-proven authentication control.
     */
    result.phoneAccess = summarizeProviderResponse(
      UrlFetchApp.fetch(phoneUrl, {
        method: 'get',
        headers: {
          Authorization: 'Bearer ' + rawToken
        },
        muteHttpExceptions: true
      })
    );

    /*
     * PROBE 2 — Meta debug_token using the same token as both input token
     * and access token. We expose only safe metadata.
     */
    var debugResponse = UrlFetchApp.fetch(debugTokenUrl, {
      method: 'get',
      headers: {
        Authorization: 'Bearer ' + rawToken
      },
      muteHttpExceptions: true
    });

    result.tokenDebug = summarizeDebugTokenResponse(debugResponse);

    /*
     * POST PROBE A — exact minimal body used by the known successful
     * Graph API Explorer test, with Authorization header.
     */
    result.postProbes.minimalBearer = postProbe(
      messagesUrl,
      minimalBody,
      rawToken,
      'bearer_header_minimal_body'
    );

    /*
     * Only continue with further POST variants if no message was accepted.
     */
    if (!result.postProbes.minimalBearer.success) {
      /*
       * POST PROBE B — production adapter body, Authorization header.
       */
      result.postProbes.adapterBearer = postProbe(
        messagesUrl,
        adapterBody,
        rawToken,
        'bearer_header_adapter_body'
      );
    } else {
      result.postProbes.adapterBearer = {
        skipped: true,
        reason: 'minimalBearerSucceeded'
      };
    }

    if (!result.postProbes.minimalBearer.success &&
        (!result.postProbes.adapterBearer ||
         result.postProbes.adapterBearer.success !== true)) {
      /*
       * POST PROBE C — minimal body with access_token query parameter.
       * This is diagnostic only. It is NOT proposed as production code.
       */
      result.postProbes.queryToken = postProbeWithQueryToken(
        messagesUrl,
        minimalBody,
        rawToken
      );
    } else {
      result.postProbes.queryToken = {
        skipped: true,
        reason: 'previousPostProbeSucceeded'
      };
    }

    /*
     * Runtime adapter is tested last and only if all independent probes fail.
     * This preserves the causal comparison and avoids extra duplicate sends.
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
        result.runtimeAdapter.postMessageFunction &&
        !anyPostProbeSucceeded(result.postProbes)) {
      var adapterResult = WhatsAppAdapter.sendText(
        META_RUNTIME_DIAGNOSTIC_RECIPIENT,
        'HAMZAWE Meta runtime audit V4'
      );
      result.adapterPath = summarizeAdapterResult(adapterResult);
    } else if (anyPostProbeSucceeded(result.postProbes)) {
      result.adapterPath = {
        skipped: true,
        reason: 'independentPostProbeSucceeded'
      };
    } else {
      result.adapterPath = {
        skipped: true,
        reason: 'WhatsAppAdapter runtime definition unavailable'
      };
    }

    result.comparison = {
      phoneGetAccepted: result.phoneAccess.success === true,
      debugTokenAccepted: result.tokenDebug.httpCode === 200,
      minimalBearerAccepted:
        result.postProbes.minimalBearer.success === true,
      adapterBearerAccepted:
        result.postProbes.adapterBearer &&
        result.postProbes.adapterBearer.success === true,
      queryTokenAccepted:
        result.postProbes.queryToken &&
        result.postProbes.queryToken.success === true,
      adapterRuntimeAccepted:
        result.adapterPath.success === true,
      bodyShapeMatters:
        result.postProbes.minimalBearer.success === true &&
        result.postProbes.adapterBearer &&
        result.postProbes.adapterBearer.success === false,
      bearerVsQueryMatters:
        result.postProbes.minimalBearer.success === false &&
        result.postProbes.queryToken &&
        result.postProbes.queryToken.success === true,
      allPostFormsRejected:
        !anyPostProbeSucceeded(result.postProbes),
      tokenTrimChanged:
        result.tokenShape.changedByTrim,
      diagnosticConclusion:
        deriveConclusion(result)
    };

    result.ok =
      result.phoneAccess.success === true &&
      anyPostProbeSucceeded(result.postProbes);

    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    result.error = err && err.message ? String(err.message) : String(err);
    console.log(JSON.stringify(result));
    return result;
  }
}

function postProbe(url, body, token, label) {
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  var summary = summarizeProviderResponse(response);
  summary.probe = label;
  summary.requestBodyProfile =
    label === 'bearer_header_minimal_body'
      ? 'minimal_graph_api_explorer_shape'
      : 'production_adapter_shape';
  summary.authorizationTransport = 'bearer_header';
  return summary;
}

function postProbeWithQueryToken(url, body, token) {
  var separator = url.indexOf('?') === -1 ? '?' : '&';
  var response = UrlFetchApp.fetch(
    url + separator + 'access_token=' + encodeURIComponent(token),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    }
  );

  var summary = summarizeProviderResponse(response);
  summary.probe = 'query_token_minimal_body';
  summary.requestBodyProfile = 'minimal_graph_api_explorer_shape';
  summary.authorizationTransport = 'access_token_query_parameter';
  return summary;
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
    providerResponseErrorSubcode:
      providerError && providerError.error_subcode !== undefined
        ? Number(providerError.error_subcode) || null
        : null,
    providerResponseErrorType:
      providerError && providerError.type
        ? String(providerError.type)
        : null,
    providerResponseErrorMessage:
      providerError && providerError.message
        ? String(providerError.message)
        : null,
    providerTraceId:
      providerError && providerError.fbtrace_id
        ? String(providerError.fbtrace_id)
        : null,
    errorIsTransient:
      providerError && providerError.is_transient !== undefined
        ? providerError.is_transient === true
        : null,
    errorUserTitlePresent:
      !!(providerError && providerError.error_user_title),
    errorUserMessagePresent:
      !!(providerError && providerError.error_user_msg)
  };
}

function summarizeDebugTokenResponse(response) {
  var summary = summarizeProviderResponse(response);
  var raw = response.getContentText() || '';
  var parsed = safeParseJsonForDiagnostic(raw);
  var data = parsed && parsed.data ? parsed.data : null;

  summary.tokenDataPresent = !!data;

  if (data) {
    summary.tokenIsValid =
      data.is_valid !== undefined ? data.is_valid === true : null;
    summary.tokenAppIdPresent = !!data.app_id;
    summary.tokenType =
      data.type ? String(data.type) : null;
    summary.tokenExpiresAtPresent =
      data.expires_at !== undefined && data.expires_at !== null;
    summary.tokenDataAccessExpiresAtPresent =
      data.data_access_expiration_time !== undefined &&
      data.data_access_expiration_time !== null;
    summary.permissionsPresent =
      Array.isArray(data.scopes) && data.scopes.length > 0;
    summary.granularPermissionsPresent =
      Array.isArray(data.granular_scopes) && data.granular_scopes.length > 0;
  }

  return summary;
}

function anyPostProbeSucceeded(postProbes) {
  return !!(
    (postProbes.minimalBearer &&
      postProbes.minimalBearer.success === true) ||
    (postProbes.adapterBearer &&
      postProbes.adapterBearer.success === true) ||
    (postProbes.queryToken &&
      postProbes.queryToken.success === true)
  );
}

function deriveConclusion(result) {
  if (result.postProbes.minimalBearer &&
      result.postProbes.minimalBearer.success === true) {
    return 'MINIMAL_BEARER_ACCEPTED';
  }

  if (result.postProbes.adapterBearer &&
      result.postProbes.adapterBearer.success === true) {
    return 'ADAPTER_BODY_ACCEPTED';
  }

  if (result.postProbes.queryToken &&
      result.postProbes.queryToken.success === true) {
    return 'QUERY_TOKEN_ACCEPTED_BEARER_REJECTED';
  }

  if (result.phoneAccess.success === true &&
      result.tokenDebug.httpCode === 200) {
    return 'TOKEN_AUTHENTICATES_BUT_ALL_MESSAGES_POST_FORMS_REJECTED';
  }

  if (result.phoneAccess.success === true) {
    return 'PHONE_GET_ACCEPTS_TOKEN_BUT_TOKEN_DEBUG_OR_POST_FAILED';
  }

  return 'META_AUTHENTICATION_FAILED_AT_PHONE_GET';
}

function summarizeAdapterResult(result) {
  var output = {
    resultPresent: !!result,
    success: false,
    errorCode: null,
    httpCode: null,
    providerMessageIdPresent: false,
    providerResponseErrorCode: null,
    providerResponseErrorSubcode: null,
    providerResponseErrorType: null,
    providerResponseErrorMessage: null,
    providerTraceId: null
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
      output.providerResponseErrorSubcode =
        providerError.error_subcode !== undefined
          ? Number(providerError.error_subcode) || null
          : null;
      output.providerResponseErrorType =
        providerError.type ? String(providerError.type) : null;
      output.providerResponseErrorMessage =
        providerError.message ? String(providerError.message) : null;
      output.providerTraceId =
        providerError.fbtrace_id ? String(providerError.fbtrace_id) : null;
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
