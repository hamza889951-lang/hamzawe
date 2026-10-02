/**
 * Meta Cloud Runtime Send Diagnostic — FINAL SEND-PATH ISOLATION
 * Diagnostic-only. Never merge.
 * Never prints access tokens, Authorization values, gateway secrets,
 * message text, raw provider responses, or full recipient numbers.
 *
 * The actual adapter path is executed FIRST. If it fails, controlled direct
 * requests are executed with the same Script Properties for causal comparison.
 */
var META_RUNTIME_DIAGNOSTIC_RECIPIENT = '9647824134670';

function runMetaCloudRuntimeSendDiagnostic() {
  var result = {
    diagnostic: 'META_CLOUD_RUNTIME_SEND_ROOT_CAUSE_AUDIT_V6',
    ok: false,
    phase: 'INIT',
    config: {},
    runtimeFingerprint: {},
    tokenShape: {},
    tokenDebug: {},
    phoneAccess: {},
    actualAdapterPath: {},
    directComparisons: {},
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
      'https://graph.facebook.com/' + version + '/' +
      phoneNumberId + '/messages';
    var phoneUrl =
      'https://graph.facebook.com/' + version + '/' + phoneNumberId;
    var debugTokenUrl =
      'https://graph.facebook.com/' + version +
      '/debug_token?input_token=' + encodeURIComponent(trimmedToken);

    var adapterBody = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: META_RUNTIME_DIAGNOSTIC_RECIPIENT,
      type: 'text',
      text: {
        preview_url: false,
        body: 'HAMZAWE Meta runtime root-cause audit V6'
      }
    };
    var minimalBody = {
      messaging_product: 'whatsapp',
      to: META_RUNTIME_DIAGNOSTIC_RECIPIENT,
      type: 'text',
      text: {
        preview_url: false,
        body: 'HAMZAWE Meta runtime root-cause audit V6'
      }
    };

    result.config = {
      graphApiVersion: version,
      phoneNumberIdPresent: !!phoneNumberId,
      phoneNumberIdFingerprint: safeFingerprint(phoneNumberId),
      messagesEndpointFingerprint: safeFingerprint(messagesUrl),
      expectedMessagesSuffixPresent: /\/messages$/.test(messagesUrl),
      method: 'post',
      contentType: 'application/json',
      recipientPresent: !!META_RUNTIME_DIAGNOSTIC_RECIPIENT,
      recipientFingerprint: safeFingerprint(META_RUNTIME_DIAGNOSTIC_RECIPIENT)
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
    result.runtimeFingerprint = fingerprintAdapterRuntime();

    result.phase = 'META_CONTROLS';
    result.phoneAccess = summarizeProviderResponse(
      UrlFetchApp.fetch(phoneUrl, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + rawToken },
        muteHttpExceptions: true
      })
    );
    var debugResponse = UrlFetchApp.fetch(debugTokenUrl, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + rawToken },
      muteHttpExceptions: true
    });
    result.tokenDebug = summarizeDebugTokenResponse(debugResponse);

    result.phase = 'ACTUAL_ADAPTER';
    if (!result.runtimeFingerprint.sendTextFunction) {
      result.actualAdapterPath = {
        invoked: false,
        success: false,
        rootCause: 'ADAPTER_SENDTEXT_NOT_AVAILABLE_IN_RUNTIME'
      };
    } else {
      var adapterResult = WhatsAppAdapter.sendText(
        META_RUNTIME_DIAGNOSTIC_RECIPIENT,
        adapterBody.text.body
      );
      result.actualAdapterPath = summarizeAdapterResultV6(adapterResult);
    }

    if (result.actualAdapterPath.success === true) {
      result.directComparisons = {
        skipped: true,
        reason: 'ACTUAL_ADAPTER_PATH_SUCCEEDED'
      };
      result.comparison = {
        actualAdapterAccepted: true,
        directMinimalAccepted: null,
        directAdapterBodyAccepted: null,
        rootCause:
          'NO_CURRENT_SEND_FAILURE_REPRODUCED; ACTUAL_ADAPTER_PATH_SUCCEEDED'
      };
      result.ok = true;
      result.phase = 'COMPLETE';
      console.log(JSON.stringify(result));
      return result;
    }

    result.phase = 'DIRECT_COMPARISON';
    result.directComparisons.adapterBody = postProbeV6(
      messagesUrl, adapterBody, rawToken, 'DIRECT_ADAPTER_BODY'
    );

    if (!result.directComparisons.adapterBody.success) {
      result.directComparisons.minimalBody = postProbeV6(
        messagesUrl, minimalBody, rawToken, 'DIRECT_MINIMAL_BODY'
      );
    } else {
      result.directComparisons.minimalBody = {
        skipped: true,
        reason: 'DIRECT_ADAPTER_BODY_SUCCEEDED'
      };
    }

    result.comparison = deriveRootCauseV6(result);
    result.ok =
      result.phoneAccess.success === true &&
      result.comparison.rootCause !== 'UNDETERMINED';
    result.phase = 'COMPLETE';
    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    result.error = {
      message: err && err.message ? String(err.message) : String(err),
      phase: result.phase
    };
    console.log(JSON.stringify(result));
    return result;
  }
}

function fingerprintAdapterRuntime() {
  var out = {
    adapterDefined: typeof WhatsAppAdapter !== 'undefined',
    sendTextFunction: false,
    postMessageFunction: false,
    propertyKeysPresent: false,
    messageTypesPresent: false,
    sendTextSourceFingerprint: null,
    postMessageSourceFingerprint: null,
    mapSendErrorSourceFingerprint: null,
    sendTextExpectedMarkersPresent: false,
    postMessageExpectedMarkersPresent: false
  };
  if (typeof WhatsAppAdapter === 'undefined') return out;

  out.sendTextFunction = typeof WhatsAppAdapter.sendText === 'function';
  out.postMessageFunction = typeof WhatsAppAdapter._postMessage === 'function';
  out.propertyKeysPresent = !!WhatsAppAdapter.PROPERTY_KEYS;
  out.messageTypesPresent = !!WhatsAppAdapter.MESSAGE_TYPES;

  if (out.sendTextFunction) {
    var sendSource = String(WhatsAppAdapter.sendText);
    out.sendTextSourceFingerprint = safeFingerprint(sendSource);
    out.sendTextExpectedMarkersPresent =
      sendSource.indexOf('_postMessage') !== -1 &&
      sendSource.indexOf('messaging_product') !== -1 &&
      sendSource.indexOf('recipient_type') !== -1;
  }
  if (out.postMessageFunction) {
    var postSource = String(WhatsAppAdapter._postMessage);
    out.postMessageSourceFingerprint = safeFingerprint(postSource);
    out.postMessageExpectedMarkersPresent =
      postSource.indexOf('graph.facebook.com') !== -1 &&
      postSource.indexOf('/messages') !== -1 &&
      postSource.indexOf('Authorization') !== -1 &&
      postSource.indexOf('UrlFetchApp.fetch') !== -1;
  }
  if (typeof WhatsAppAdapter._mapSendErrorCode === 'function') {
    out.mapSendErrorSourceFingerprint =
      safeFingerprint(String(WhatsAppAdapter._mapSendErrorCode));
  }
  return out;
}

function postProbeV6(url, body, token, label) {
  var payload = JSON.stringify(body);
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: payload,
    muteHttpExceptions: true
  });
  var summary = summarizeProviderResponse(response);
  summary.probe = label;
  summary.payloadFingerprint = safeFingerprint(payload);
  summary.payloadProfile = label === 'DIRECT_ADAPTER_BODY'
    ? 'same_shape_as_production_adapter'
    : 'minimal_graph_api_explorer_shape';
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
      !!(parsed && parsed.messages && parsed.messages[0] &&
         parsed.messages[0].id),
    providerResponseErrorCode:
      providerError && providerError.code !== undefined
        ? Number(providerError.code) || null : null,
    providerResponseErrorSubcode:
      providerError && providerError.error_subcode !== undefined
        ? Number(providerError.error_subcode) || null : null,
    providerResponseErrorType:
      providerError && providerError.type
        ? String(providerError.type) : null,
    providerResponseErrorMessage:
      providerError && providerError.message
        ? String(providerError.message) : null,
    providerTraceId:
      providerError && providerError.fbtrace_id
        ? String(providerError.fbtrace_id) : null
  };
}

function summarizeDebugTokenResponse(response) {
  var summary = summarizeProviderResponse(response);
  var parsed = safeParseJsonForDiagnostic(response.getContentText() || '');
  var data = parsed && parsed.data ? parsed.data : null;
  summary.tokenDataPresent = !!data;
  if (data) {
    summary.tokenIsValid =
      data.is_valid !== undefined ? data.is_valid === true : null;
    summary.tokenAppIdPresent = !!data.app_id;
    summary.tokenType = data.type ? String(data.type) : null;
    summary.permissionsPresent =
      Array.isArray(data.scopes) && data.scopes.length > 0;
    summary.granularPermissionsPresent =
      Array.isArray(data.granular_scopes) &&
      data.granular_scopes.length > 0;
  }
  return summary;
}

function summarizeAdapterResultV6(result) {
  var out = {
    invoked: true,
    success: !!(result && result.ok === true),
    resultErrorCode: null,
    httpCode: null,
    providerMessageIdPresent: false,
    providerResponseErrorCode: null,
    providerResponseErrorSubcode: null,
    providerResponseErrorType: null,
    providerResponseErrorMessage: null,
    providerTraceId: null
  };
  if (!result) {
    out.resultErrorCode = 'NO_RESULT';
    return out;
  }
  if (result.ok === true) {
    out.providerMessageIdPresent =
      !!(result.data && result.data.providerMessageId);
    return out;
  }
  if (result.error && result.error.code) {
    out.resultErrorCode = String(result.error.code);
  }
  var details = result.error && result.error.details
    ? result.error.details : null;
  if (!details) return out;

  out.httpCode = Number(details.httpCode) || null;
  var parsed = safeParseJsonForDiagnostic(
    String(details.providerResponse || '')
  );
  var providerError = parsed && parsed.error ? parsed.error : null;
  if (providerError) {
    out.providerResponseErrorCode =
      providerError.code !== undefined
        ? Number(providerError.code) || null : null;
    out.providerResponseErrorSubcode =
      providerError.error_subcode !== undefined
        ? Number(providerError.error_subcode) || null : null;
    out.providerResponseErrorType =
      providerError.type ? String(providerError.type) : null;
    out.providerResponseErrorMessage =
      providerError.message ? String(providerError.message) : null;
    out.providerTraceId =
      providerError.fbtrace_id ? String(providerError.fbtrace_id) : null;
  }
  return out;
}

function deriveRootCauseV6(result) {
  var adapter = result.actualAdapterPath;
  var directAdapter = result.directComparisons.adapterBody;
  var directMinimal = result.directComparisons.minimalBody;

  if (!adapter || adapter.success !== false) {
    return {
      rootCause: 'UNDETERMINED',
      reason: 'Actual adapter failure was not reproduced'
    };
  }
  if (directAdapter && directAdapter.success === true) {
    return {
      rootCause: 'ADAPTER_RUNTIME_PATH_DIFFERS_FROM_DIRECT_EQUIVALENT_REQUEST',
      decisiveEvidence:
        'WhatsAppAdapter.sendText() failed while an equivalent direct request succeeded'
    };
  }
  if (directAdapter && directAdapter.success === false &&
      directMinimal && directMinimal.success === true) {
    return {
      rootCause: 'PRODUCTION_ADAPTER_REQUEST_SHAPE_OR_SERIALIZATION',
      decisiveEvidence:
        'Direct production-shaped request failed but minimal Graph API body succeeded'
    };
  }
  if (directAdapter && directAdapter.success === false &&
      directMinimal && directMinimal.success === false) {
    if (sameProviderFailure(adapter, directAdapter, directMinimal)) {
      return {
        rootCause: 'META_REJECTS_THE_CURRENT_REQUEST_CONTEXT',
        decisiveEvidence:
          'Actual adapter and both direct request forms receive the same Meta failure'
      };
    }
    return {
      rootCause: 'INCONSISTENT_PROVIDER_RESPONSE_REQUIRES_TRACE_CORRELATION',
      decisiveEvidence:
        'Adapter and direct probes fail differently; compare provider trace IDs'
    };
  }
  return {
    rootCause: 'UNDETERMINED',
    reason: 'Insufficient differential evidence'
  };
}

function sameProviderFailure(a, b, c) {
  return a && b && c &&
    a.providerResponseErrorCode === b.providerResponseErrorCode &&
    b.providerResponseErrorCode === c.providerResponseErrorCode &&
    a.providerResponseErrorMessage === b.providerResponseErrorMessage &&
    b.providerResponseErrorMessage === c.providerResponseErrorMessage;
}

function safeFingerprint(value) {
  return sha256Hex(String(value || ''));
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

function safeParseJsonForDiagnostic(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch (e) {
    return null;
  }
}

/* Existing inbound parse audit retained unchanged in purpose. */
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
    var normalized = PhoneUtils.normalize(event.phone);
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
