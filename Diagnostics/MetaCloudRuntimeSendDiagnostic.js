/**
 * Meta Cloud Runtime Send Diagnostic — Meta authorization isolation audit.
 *
 * Controlled recipient: 9647824134670
 *
 * V5 PURPOSE
 * ----------
 * V4 proved that:
 * - the System User token is valid;
 * - GET /{PHONE_NUMBER_ID} succeeds;
 * - debug_token succeeds;
 * - three materially different POST authorization/body forms all fail
 *   with OAuthException code 100 from Apps Script;
 * - the same token/phone/recipient previously succeeded from Graph API
 *   Explorer.
 *
 * V5 is the final request-context differential audit. It does NOT rotate
 * credentials and does NOT modify production behavior.
 *
 * It inspects the exact request object Apps Script constructs via
 * UrlFetchApp.getRequest(), with Authorization values redacted, and compares
 * safe fingerprints of payload serialization, Content-Type construction,
 * Authorization header construction, endpoint construction, and request
 * options.
 *
 * It then performs only the minimum controlled POST variants required to
 * determine whether the failure is caused by UrlFetch request construction.
 *
 * SAFE OUTPUT
 * -----------
 * Never logs the access token, Authorization header, raw response body,
 * message text, or gateway secret.
 *
 * This diagnostic sends test messages only when a POST probe is accepted.
 * It stops after the first successful POST to avoid duplicate successful
 * messages.
 */

var META_RUNTIME_DIAGNOSTIC_RECIPIENT = '9647824134670';

function runMetaCloudRuntimeSendDiagnostic() {
  var result = {
    diagnostic: 'META_CLOUD_RUNTIME_SEND_AUDIT_V5',
    ok: false,
    config: {},
    tokenShape: {},
    tokenDebug: {},
    phoneAccess: {},
    postProbes: {},
    requestAudit: {},
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
    result.requestAudit = buildRequestAudit(messagesUrl, minimalBody, rawToken);

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
      result.postProbes.explicitContentType = postProbeExplicitContentType(
        messagesUrl,
        minimalBody,
        rawToken
      );
    } else {
      result.postProbes.explicitContentType = {
        skipped: true,
        reason: 'previousPostProbeSucceeded'
      };
    }

    if (!anyPostProbeSucceeded(result.postProbes)) {
      result.postProbes.blobPayload = postProbeBlobPayload(
        messagesUrl,
        minimalBody,
        rawToken
      );
    } else {
      result.postProbes.blobPayload = {
        skipped: true,
        reason: 'previousPostProbeSucceeded'
      };
    }

    if (!anyPostProbeSucceeded(result.postProbes)) {
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
      explicitContentTypeAccepted:
        result.postProbes.explicitContentType &&
        result.postProbes.explicitContentType.success === true,
      blobPayloadAccepted:
        result.postProbes.blobPayload &&
        result.postProbes.blobPayload.success === true,
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

function buildRequestAudit(url, body, token) {
  var payload = JSON.stringify(body);

  var paramsViaContentType = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token
    },
    payload: payload,
    muteHttpExceptions: true,
    followRedirects: false,
    escaping: false
  };

  var paramsViaExplicitHeader = {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    payload: payload,
    muteHttpExceptions: true,
    followRedirects: false,
    escaping: false
  };

  return {
    payload: {
      byteLength: Utilities.newBlob(payload).getBytes().length,
      charLength: payload.length,
      sha256Present: true,
      sha256: sha256Hex(payload)
    },
    endpoint: {
      urlLength: url.length,
      urlSha256: sha256Hex(url),
      expectedSuffixPresent: /\/messages$/.test(url)
    },
    contentTypeOption: sanitizeRequest(
      UrlFetchApp.getRequest(url, paramsViaContentType)
    ),
    explicitHeaderOption: sanitizeRequest(
      UrlFetchApp.getRequest(url, paramsViaExplicitHeader)
    ),
    equivalence: {
      payloadSame: payload === paramsViaExplicitHeader.payload,
      endpointSame: true,
      methodSame: true
    }
  };
}

function sanitizeRequest(request) {
  var safe = {};
  Object.keys(request || {}).forEach(function(key) {
    if (key === 'headers') {
      safe.headers = summarizeHeaders(request.headers || {});
      return;
    }
    if (key === 'payload') {
      var payloadText = typeof request.payload === 'string'
        ? request.payload
        : String(request.payload || '');
      safe.payload = {
        type: typeof request.payload,
        byteLength: Utilities.newBlob(payloadText).getBytes().length,
        sha256: sha256Hex(payloadText)
      };
      return;
    }
    safe[key] = request[key];
  });
  return safe;
}

function summarizeHeaders(headers) {
  var result = {};
  Object.keys(headers || {}).forEach(function(key) {
    var lower = String(key).toLowerCase();
    if (lower === 'authorization') {
      result[key] = 'REDACTED';
    } else {
      result[key] = String(headers[key]);
    }
  });
  return result;
}

function sha256Hex(value) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
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

function postProbeExplicitContentType(url, body, token) {
  var payload = JSON.stringify(body);
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    payload: payload,
    muteHttpExceptions: true,
    followRedirects: false,
    escaping: false
  });

  var summary = summarizeProviderResponse(response);
  summary.probe = 'bearer_header_explicit_content_type';
  summary.requestBodyProfile = 'minimal_graph_api_explorer_shape';
  summary.authorizationTransport = 'bearer_header';
  summary.contentTypeConstruction = 'explicit_header';
  return summary;
}

function postProbeBlobPayload(url, body, token) {
  var payload = JSON.stringify(body);
  var blob = Utilities.newBlob(payload, 'application/json', 'payload.json');
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + token
    },
    payload: blob,
    muteHttpExceptions: true,
    followRedirects: false,
    escaping: false
  });

  var summary = summarizeProviderResponse(response);
  summary.probe = 'bearer_header_blob_payload';
  summary.requestBodyProfile = 'minimal_graph_api_explorer_shape';
  summary.authorizationTransport = 'bearer_header';
  summary.payloadConstruction = 'blob';
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
    (postProbes.explicitContentType &&
      postProbes.explicitContentType.success === true) ||
    (postProbes.blobPayload &&
      postProbes.blobPayload.success === true) ||
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

  if (result.postProbes.explicitContentType &&
      result.postProbes.explicitContentType.success === true) {
    return 'EXPLICIT_CONTENT_TYPE_ACCEPTED';
  }

  if (result.postProbes.blobPayload &&
      result.postProbes.blobPayload.success === true) {
    return 'BLOB_PAYLOAD_ACCEPTED';
  }

  if (result.postProbes.queryToken &&
      result.postProbes.queryToken.success === true) {
    return 'QUERY_TOKEN_ACCEPTED_BEARER_REJECTED';
  }

  if (result.phoneAccess.success === true &&
      result.tokenDebug.httpCode === 200) {
    return 'REQUEST_REACHES_META_BUT_MESSAGES_OPERATION_REJECTED';
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


/**
 * Read-only audit of current WEBHOOK_PARSE_FAILED rows.
 * Never prints secrets, signatures, message text, or raw log payloads.
 */
function runWhatsAppGatewayParseFailureDiagnostic() {
  var out = {
    diagnostic: 'WHATSAPP_GATEWAY_PARSE_FAILURE_AUDIT_V1',
    ok: false,
    source: { sheet: 'SYSTEM_LOG', matchingRows: 0, rowsInspected: 0 },
    recent: [],
    error: null
  };
  try {
    if (typeof GoogleSheets === 'undefined' ||
        typeof GoogleSheets.getAllRows !== 'function') {
      throw new Error('GoogleSheets runtime is unavailable');
    }
    var rows = GoogleSheets.getAllRows('SYSTEM_LOG').filter(function(row) {
      return String(row.command || '') === 'WEBHOOK_PARSE_FAILED';
    });
    out.source.matchingRows = rows.length;
    rows.sort(function(a, b) {
      return Number(b._rowNumber || 0) - Number(a._rowNumber || 0);
    });
    rows.slice(0, 5).forEach(function(row) {
      out.recent.push(auditWebhookParseFailureRow(row));
    });
    out.source.rowsInspected = out.recent.length;
    out.ok = true;
    console.log(JSON.stringify(out));
    return out;
  } catch (err) {
    out.error = err && err.message ? String(err.message) : String(err);
    console.log(JSON.stringify(out));
    return out;
  }
}

function auditWebhookParseFailureRow(row) {
  var r = {
    rowNumber: Number(row._rowNumber) || null,
    jsonValid: false,
    gatewayVersion: null,
    gatewayVersionValid: false,
    gatewayTimestampValid: false,
    gatewayAgeMs: null,
    gatewayAgeWithinFiveMinutes: false,
    signaturePresent: false,
    signatureLength: null,
    signatureFormatValid: false,
    gatewaySecretPresent: false,
    hmacMatches: false,
    eventType: null,
    messageIdPresent: false,
    phonePresent: false,
    phoneNormalized: null,
    messageType: null,
    eventTimestampValid: false,
    likelyFailureStage: null
  };

  var raw = row.error;
  if (raw === null || raw === undefined || raw === '') {
    r.likelyFailureStage = 'NO_PAYLOAD_IN_LOG_ROW';
    return r;
  }

  var envelope;
  try {
    envelope = JSON.parse(String(raw));
    r.jsonValid = true;
  } catch (e) {
    r.likelyFailureStage = 'JSON_PARSE';
    return r;
  }

  if (!envelope || typeof envelope !== 'object') {
    r.likelyFailureStage = 'ROOT_NOT_OBJECT';
    return r;
  }
  if (!envelope.event) {
    r.likelyFailureStage = 'EVENT_MISSING';
    return r;
  }

  r.gatewayVersion = envelope.gatewayVersion === undefined
    ? null : String(envelope.gatewayVersion);
  r.gatewayVersionValid = envelope.gatewayVersion === 'v1';
  if (!r.gatewayVersionValid) {
    r.likelyFailureStage = 'GATEWAY_VERSION';
    return r;
  }

  var gatewayTimestampMs = Number(envelope.gatewayTimestampMs);
  r.gatewayTimestampValid = isFinite(gatewayTimestampMs);
  if (!r.gatewayTimestampValid) {
    r.likelyFailureStage = 'GATEWAY_TIMESTAMP_INVALID';
    return r;
  }

  r.gatewayAgeMs = new Date().getTime() - gatewayTimestampMs;
  r.gatewayAgeWithinFiveMinutes =
    Math.abs(r.gatewayAgeMs) <= 5 * 60 * 1000;
  if (!r.gatewayAgeWithinFiveMinutes) {
    r.likelyFailureStage = 'GATEWAY_TIMESTAMP_STALE';
    return r;
  }

  var signature = String(envelope.signature || '');
  r.signaturePresent = signature.length > 0;
  r.signatureLength = signature.length;
  r.signatureFormatValid = /^[0-9a-f]{64}$/i.test(signature);
  if (!r.signaturePresent || !r.signatureFormatValid) {
    r.likelyFailureStage = 'SIGNATURE_MISSING_OR_MALFORMED';
    return r;
  }

  var secret = '';
  try {
    secret = PropertiesService.getScriptProperties()
      .getProperty('WHATSAPP_GATEWAY_SECRET') || '';
  } catch (e) {
    r.likelyFailureStage = 'SECRET_PROPERTY_READ_EXCEPTION';
    return r;
  }
  r.gatewaySecretPresent = secret.length > 0;
  if (!secret) {
    r.likelyFailureStage = 'GATEWAY_SECRET_MISSING';
    return r;
  }

  try {
    var canonical = JSON.stringify(envelope.event);
    var digest = Utilities.computeHmacSha256Signature(canonical, secret);
    var expected = digest.map(function(byte) {
      var n = (byte + 256) % 256;
      var h = n.toString(16);
      return h.length === 1 ? '0' + h : h;
    }).join('');
    r.hmacMatches = diagnosticConstantTimeEqual(expected, signature);
  } catch (e) {
    r.likelyFailureStage = 'HMAC_COMPUTATION_EXCEPTION';
    return r;
  }

  if (!r.hmacMatches) {
    r.likelyFailureStage = 'GATEWAY_SIGNATURE_MISMATCH';
    return r;
  }

  var event = envelope.event;
  r.eventType = event.eventType === undefined ? null : String(event.eventType);
  r.messageIdPresent = !!(event.messageId !== undefined &&
    event.messageId !== null && String(event.messageId) !== '');
  r.phonePresent = !!(event.phone !== undefined &&
    event.phone !== null && String(event.phone) !== '');
  r.messageType = event.messageType === undefined ? null : String(event.messageType);
  r.eventTimestampValid = isFinite(Number(event.timestampMs));

  if (typeof PhoneUtils === 'undefined' ||
      typeof PhoneUtils.normalize !== 'function') {
    r.likelyFailureStage = 'PHONE_UTILS_UNAVAILABLE';
    return r;
  }

  try {
    var rawPhone = event.phone;
    var normalized = PhoneUtils.normalize(rawPhone);
    r.phoneNormalized = normalized === undefined || normalized === null
      ? null : String(normalized);
    if (!normalized) {
      r.likelyFailureStage = 'PHONE_NORMALIZATION';
      return r;
    }
  } catch (e) {
    r.likelyFailureStage = 'PHONE_NORMALIZATION_EXCEPTION';
    return r;
  }

  if (event.eventType === 'MESSAGE' && !r.messageIdPresent) {
    r.likelyFailureStage = 'MESSAGE_ID_MISSING';
    return r;
  }
  if (event.eventType !== 'MESSAGE' && event.eventType !== 'STATUS') {
    r.likelyFailureStage = 'UNSUPPORTED_EVENT_TYPE';
    return r;
  }

  /*
   * All visible rejection gates in current main's parseIncomingPayload()
   * passed. If this row was nevertheless logged as WEBHOOK_PARSE_FAILED,
   * the strongest remaining hypothesis is Apps Script runtime source
   * mismatch/stale deployment or a runtime-only exception not reproduced here.
   */
  r.likelyFailureStage = 'NO_VISIBLE_PARSE_FAILURE_IN_CURRENT_MAIN_CODE';
  return r;
}

function diagnosticConstantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' ||
      a.length !== b.length) return false;
  var different = 0;
  for (var i = 0; i < a.length; i++) {
    different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return different === 0;
}
