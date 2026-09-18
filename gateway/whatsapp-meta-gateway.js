/**
 * HAMZAWE WhatsApp Meta Webhook Gateway
 *
 * Runtime: Node.js 20+
 * Dependencies: Node.js standard library only.
 *
 * Responsibilities:
 * - Meta webhook verification (GET);
 * - Meta X-Hub-Signature-256 verification (POST);
 * - normalize WhatsApp Cloud API message events;
 * - sign each normalized event for HAMZAWE;
 * - forward the signed envelope to the deployed HAMZAWE Apps Script web app.
 *
 * This file deliberately contains no HAMZAWE business logic.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const CONFIG = {
  port: Number(process.env.PORT || 8080),
  metaAppSecret: process.env.META_APP_SECRET || '',
  metaVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || '',
  hamzaweWebhookUrl: process.env.HAMZAWE_WEBHOOK_URL || '',
  hamzaweGatewaySecret: process.env.HAMZAWE_GATEWAY_SECRET || ''
};

function requiredConfig() {
  const missing = [];
  if (!CONFIG.metaAppSecret) missing.push('META_APP_SECRET');
  if (!CONFIG.metaVerifyToken) missing.push('META_WEBHOOK_VERIFY_TOKEN');
  if (!CONFIG.hamzaweWebhookUrl) missing.push('HAMZAWE_WEBHOOK_URL');
  if (!CONFIG.hamzaweGatewaySecret) missing.push('HAMZAWE_GATEWAY_SECRET');
  return missing;
}

function hexHmacSha256(secret, body) {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifyMetaWebhookChallenge(mode, verifyToken, expectedToken, challenge) {
  return mode === 'subscribe' && verifyToken === expectedToken && typeof challenge === 'string' && challenge.length > 0;
}

function verifyMetaSignature(rawBody, headerValue, appSecret) {
  if (!headerValue || !appSecret) return false;
  const prefix = 'sha256=';
  if (headerValue.indexOf(prefix) !== 0) return false;
  const received = headerValue.slice(prefix.length);
  const expected = hexHmacSha256(appSecret, rawBody);
  return safeEqual(received, expected);
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function signNormalizedEvent(event, gatewaySecret) {
  return hexHmacSha256(gatewaySecret, canonicalJson(event));
}

function makeEnvelope(event, nowMs, gatewaySecret) {
  return {
    gatewayVersion: 'v1',
    gatewayTimestampMs: nowMs,
    event: event,
    signature: signNormalizedEvent(event, gatewaySecret)
  };
}

function mapMetaMessage(message) {
  const type = message && message.type ? String(message.type).toUpperCase() : 'UNKNOWN';
  const text = message && message.type === 'text' && message.text
    ? (typeof message.text.body === 'string' ? message.text.body : null)
    : null;
  const timestampSeconds = message && message.timestamp !== undefined
    ? Number(message.timestamp)
    : NaN;

  return {
    channel: 'WHATSAPP',
    provider: 'META_CLOUD',
    eventType: 'MESSAGE',
    messageId: message && message.id ? String(message.id) : null,
    phone: message && message.from ? String(message.from) : null,
    timestampMs: isFinite(timestampSeconds)
      ? Math.round(timestampSeconds * 1000)
      : Date.now(),
    messageType: type,
    text: text
  };
}

function collectNormalizedEvents(payload) {
  const result = { messages: [], statuses: [] };
  const entries = Array.isArray(payload && payload.entry) ? payload.entry : [];

  entries.forEach(function(entry) {
    const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
    changes.forEach(function(change) {
      const value = change && change.value ? change.value : {};

      const messages = Array.isArray(value.messages) ? value.messages : [];
      messages.forEach(function(message) {
        result.messages.push(mapMetaMessage(message));
      });

      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      statuses.forEach(function(status) {
        const timestampSeconds = status && status.timestamp !== undefined
          ? Number(status.timestamp)
          : NaN;
        result.statuses.push({
          channel: 'WHATSAPP',
          provider: 'META_CLOUD',
          eventType: 'STATUS',
          messageId: status && status.id ? String(status.id) : null,
          phone: status && status.recipient_id ? String(status.recipient_id) : null,
          timestampMs: isFinite(timestampSeconds)
            ? Math.round(timestampSeconds * 1000)
            : Date.now(),
          status: status && status.status ? String(status.status) : null
        });
      });
    });
  });

  return result;
}

async function forwardEvent(event) {
  const envelope = makeEnvelope(event, Date.now(), CONFIG.hamzaweGatewaySecret);
  const response = await fetch(CONFIG.hamzaweWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      'HAMZAWE_WEBHOOK_FORWARD_FAILED HTTP ' +
      response.status +
      ' ' +
      body.slice(0, 500)
    );
  }

  return response;
}

function readRequestBody(req) {
  return new Promise(function(resolve, reject) {
    const chunks = [];
    req.on('data', function(chunk) { chunks.push(chunk); });
    req.on('end', function() { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  if (requestUrl.pathname !== '/webhook') {
    return writeJson(res, 404, { error: 'NOT_FOUND' });
  }

  if (req.method === 'GET') {
    if (!verifyMetaWebhookChallenge(
        requestUrl.searchParams.get('hub.mode'),
        requestUrl.searchParams.get('hub.verify_token'),
        CONFIG.metaVerifyToken,
        requestUrl.searchParams.get('hub.challenge'))) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('VERIFICATION_FAILED');
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(requestUrl.searchParams.get('hub.challenge') || '');
  }

  if (req.method !== 'POST') {
    return writeJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  const rawBody = await readRequestBody(req);
  const signature = req.headers['x-hub-signature-256'];
  if (!verifyMetaSignature(rawBody, signature, CONFIG.metaAppSecret)) {
    return writeJson(res, 401, { error: 'INVALID_META_SIGNATURE' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return writeJson(res, 400, { error: 'INVALID_JSON' });
  }

  const events = collectNormalizedEvents(payload);

  for (const event of events.messages) {
    if (!event.messageId || !event.phone) continue;
    await forwardEvent(event);
  }

  if (events.statuses.length) {
    console.log(JSON.stringify({
      event: 'META_STATUS_EVENTS_IGNORED',
      count: events.statuses.length
    }));
  }

  return writeJson(res, 200, {
    ok: true,
    forwardedMessages: events.messages.filter(function(event) {
      return !!event.messageId && !!event.phone;
    }).length,
    ignoredStatuses: events.statuses.length
  });
}

function createServer() {
  const missing = requiredConfig();
  if (missing.length) {
    throw new Error('Missing gateway configuration: ' + missing.join(', '));
  }
  return http.createServer(function(req, res) {
    handleRequest(req, res).catch(function(err) {
      console.error(err);
      writeJson(res, 502, {
        error: 'GATEWAY_FAILURE',
        message: err.message
      });
    });
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(CONFIG.port, function() {
    console.log('HAMZAWE WhatsApp Meta gateway listening on port ' + CONFIG.port);
  });
}

module.exports = {
  hexHmacSha256,
  verifyMetaWebhookChallenge,
  verifyMetaSignature,
  canonicalJson,
  signNormalizedEvent,
  makeEnvelope,
  mapMetaMessage,
  collectNormalizedEvents
};
