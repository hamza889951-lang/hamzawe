/**
 * WhatsApp Gateway Parse Diagnostic — read-only investigation aid.
 *
 * PURPOSE
 * -------
 * Diagnose the last WEBHOOK_PARSE_FAILED envelope without changing the
 * production webhook path and without exposing secrets/signatures.
 *
 * This function is intentionally standalone so it can be synchronized to
 * Apps Script with clasp and executed manually from the Apps Script editor.
 *
 * SAFE OUTPUT
 * -----------
 * The diagnostic reports only boolean/structural facts:
 *   - whether a parse-failure row was found
 *   - envelope/version/timestamp validity
 *   - whether the gateway secret exists
 *   - whether a signature exists and matches HMAC-SHA256
 *   - basic non-sensitive event metadata
 *
 * It NEVER logs:
 *   - WHATSAPP_GATEWAY_SECRET
 *   - the computed/expected HMAC
 *   - the received HMAC
 *   - access tokens or other credentials
 *
 * It does NOT write to SYSTEM_LOG, Conversations, or any business sheet.
 *
 * RUN:
 * ----
 * runWhatsAppGatewayParseDiagnostic()
 */
function runWhatsAppGatewayParseDiagnostic() {
  var result = {
    diagnostic: 'WHATSAPP_GATEWAY_PARSE',
    ok: false,
    source: null,
    checks: {},
    event: {},
    error: null
  };

  try {
    var props = PropertiesService.getScriptProperties();
    var sheetId = props.getProperty('SPREADSHEET_ID');
    var spreadsheet = sheetId
      ? SpreadsheetApp.openById(sheetId)
      : SpreadsheetApp.getActiveSpreadsheet();

    var sheet = spreadsheet.getSheetByName(
      (typeof Config !== 'undefined' &&
       Config.VOCABULARY &&
       Config.VOCABULARY.SHEETS &&
       Config.VOCABULARY.SHEETS.SYSTEM_LOG)
        ? Config.VOCABULARY.SHEETS.SYSTEM_LOG
        : 'SYSTEM_LOG'
    );

    if (!sheet) {
      throw new Error('SYSTEM_LOG sheet not found');
    }

    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) {
      throw new Error('SYSTEM_LOG contains no data rows');
    }

    var headers = values[0];
    var commandIndex = headers.indexOf('command');
    var errorIndex = headers.indexOf('error');
    var timestampIndex = headers.indexOf('timestamp');

    if (commandIndex === -1 || errorIndex === -1) {
      throw new Error('SYSTEM_LOG is missing command/error columns');
    }

    var failureRow = null;

    for (var i = values.length - 1; i >= 1; i--) {
      if (String(values[i][commandIndex] || '') === 'WEBHOOK_PARSE_FAILED') {
        failureRow = values[i];
        result.source = {
          rowNumber: i + 1,
          timestamp: timestampIndex === -1 ? null : String(failureRow[timestampIndex] || '')
        };
        break;
      }
    }

    if (!failureRow) {
      result.error = 'No WEBHOOK_PARSE_FAILED row found in SYSTEM_LOG';
      console.log(JSON.stringify(result));
      return result;
    }

    var rawEnvelope = String(failureRow[errorIndex] || '');
    var envelope;

    try {
      envelope = JSON.parse(rawEnvelope);
    } catch (e) {
      result.error = 'Latest WEBHOOK_PARSE_FAILED error field is not valid JSON';
      console.log(JSON.stringify(result));
      return result;
    }

    var event = envelope && envelope.event ? envelope.event : null;
    var gatewayVersion = envelope ? envelope.gatewayVersion : null;
    var gatewayTimestampMs = envelope ? Number(envelope.gatewayTimestampMs) : NaN;
    var signature = envelope && envelope.signature
      ? String(envelope.signature)
      : '';

    var nowMs = (typeof Clock !== 'undefined' &&
                 Clock &&
                 typeof Clock.now === 'function')
      ? Clock.now().getTime()
      : new Date().getTime();

    var maxAgeMs = (typeof WhatsAppAdapter !== 'undefined' &&
                    WhatsAppAdapter &&
                    isFinite(Number(WhatsAppAdapter.GATEWAY_MAX_AGE_MS)))
      ? Number(WhatsAppAdapter.GATEWAY_MAX_AGE_MS)
      : 5 * 60 * 1000;

    var timestampValid =
      isFinite(gatewayTimestampMs) &&
      Math.abs(nowMs - gatewayTimestampMs) <= maxAgeMs;

    var secret = props.getProperty('WHATSAPP_GATEWAY_SECRET') || '';

    result.checks = {
      envelopePresent: !!envelope,
      gatewayVersionValid: gatewayVersion === 'v1',
      timestampPresent: isFinite(gatewayTimestampMs),
      timestampValid: timestampValid,
      secretPresent: secret.length > 0,
      signaturePresent: signature.length > 0,
      signatureShapeValid: /^([0-9a-f]{64})$/i.test(signature)
    };

    if (event) {
      result.event = {
        eventType: event.eventType || null,
        channel: event.channel || null,
        provider: event.provider || null,
        messageIdPresent: !!event.messageId,
        phonePresent: !!event.phone,
        messageType: event.messageType || null,
        textPresent: typeof event.text === 'string',
        timestampMsPresent: isFinite(Number(event.timestampMs))
      };
    }

    var signatureMatches = false;

    if (event && secret && signature) {
      var canonical = JSON.stringify(event);
      var digest = Utilities.computeHmacSha256Signature(canonical, secret);
      var expected = digest.map(function(byte) {
        var n = (byte + 256) % 256;
        var h = n.toString(16);
        return h.length === 1 ? '0' + h : h;
      }).join('');

      signatureMatches = constantTimeEqualForDiagnostic(
        expected,
        signature
      );
    }

    result.checks.hmacSignatureMatches = signatureMatches;

    result.ok =
      result.checks.envelopePresent &&
      result.checks.gatewayVersionValid &&
      result.checks.timestampValid &&
      result.checks.secretPresent &&
      result.checks.signaturePresent &&
      result.checks.signatureShapeValid &&
      result.checks.hmacSignatureMatches;

    console.log(JSON.stringify(result));
    return result;
  } catch (err) {
    result.error = err && err.message
      ? err.message
      : String(err);
    console.log(JSON.stringify(result));
    return result;
  }
}

/**
 * Constant-time string comparison for diagnostic use only.
 * No secrets/signatures are returned.
 */
function constantTimeEqualForDiagnostic(a, b) {
  if (typeof a !== 'string' ||
      typeof b !== 'string' ||
      a.length !== b.length) {
    return false;
  }

  var different = 0;
  for (var i = 0; i < a.length; i++) {
    different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return different === 0;
}
