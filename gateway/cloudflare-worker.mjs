/**
 * HAMZAWE WhatsApp Cloud Webhook Gateway — Cloudflare Worker runtime.
 *
 * This is the production external gateway boundary required by the
 * WHATSAPP-CLOUD-MIGRATION-P0-P2-v1 contract.
 *
 * Request flow:
 *   Meta -> Cloudflare Worker -> signed envelope -> Apps Script doPost
 *
 * Secrets:
 *   META_APP_SECRET
 *   META_WEBHOOK_VERIFY_TOKEN
 *   HAMZAWE_WEBHOOK_URL
 *   HAMZAWE_GATEWAY_SECRET
 */
const GATEWAY_VERSION = 'v1';
const GATEWAY_MAX_AGE_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function requiredConfig(env) {
  const missing = [];
  for (const key of [
    'META_APP_SECRET',
    'META_WEBHOOK_VERIFY_TOKEN',
    'HAMZAWE_WEBHOOK_URL',
    'HAMZAWE_GATEWAY_SECRET'
  ]) {
    if (!env || !env[key]) missing.push(key);
  }
  return missing;
}

function hexFromBytes(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map(function(byte) {
      return byte.toString(16).padStart(2, '0');
    })
    .join('');
}

function bytesFromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function importHmacKey(secret) {
  if (typeof secret !== 'string' || !secret) return null;
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function hmacHex(secret, value) {
  const key = await importHmacKey(secret);
  if (!key) throw new Error('HMAC secret is missing');
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : encoder.encode(String(value));
  const signature = await crypto.subtle.sign('HMAC', key, bytes);
  return hexFromBytes(signature);
}

async function verifyHmacHex(secret, value, expectedHex) {
  const key = await importHmacKey(secret);
  const expected = bytesFromHex(expectedHex);
  if (!key || !expected) return false;
  const bytes = value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : encoder.encode(String(value));
  return crypto.subtle.verify('HMAC', key, expected, bytes);
}

function verifyMetaWebhookChallenge(mode, verifyToken, expectedToken, challenge) {
  return mode === 'subscribe' &&
    verifyToken === expectedToken &&
    typeof challenge === 'string' &&
    challenge.length > 0;
}

async function verifyMetaSignature(rawBody, headerValue, appSecret) {
  if (!headerValue || !appSecret) return false;
  const prefix = 'sha256=';
  if (!headerValue.startsWith(prefix)) return false;
  return verifyHmacHex(appSecret, rawBody, headerValue.slice(prefix.length));
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

async function signNormalizedEvent(event, gatewaySecret) {
  return hmacHex(gatewaySecret, canonicalJson(event));
}

async function makeEnvelope(event, nowMs, gatewaySecret) {
  return {
    gatewayVersion: GATEWAY_VERSION,
    gatewayTimestampMs: nowMs,
    event: event,
    signature: await signNormalizedEvent(event, gatewaySecret)
  };
}

function mapMetaMessage(message) {
  const type = message && message.type
    ? String(message.type).toUpperCase()
    : 'UNKNOWN';

  const text = message &&
      message.type === 'text' &&
      message.text &&
      typeof message.text.body === 'string'
    ? message.text.body
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
    timestampMs: Number.isFinite(timestampSeconds)
      ? Math.round(timestampSeconds * 1000)
      : Date.now(),
    messageType: type,
    text: text
  };
}

function collectNormalizedEvents(payload) {
  const result = { messages: [], statuses: [] };
  const entries = Array.isArray(payload && payload.entry)
    ? payload.entry
    : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry && entry.changes)
      ? entry.changes
      : [];

    for (const change of changes) {
      const value = change && change.value ? change.value : {};

      const messages = Array.isArray(value.messages)
        ? value.messages
        : [];

      for (const message of messages) {
        result.messages.push(mapMetaMessage(message));
      }

      const statuses = Array.isArray(value.statuses)
        ? value.statuses
        : [];

      for (const status of statuses) {
        const timestampSeconds = status && status.timestamp !== undefined
          ? Number(status.timestamp)
          : NaN;

        result.statuses.push({
          channel: 'WHATSAPP',
          provider: 'META_CLOUD',
          eventType: 'STATUS',
          messageId: status && status.id ? String(status.id) : null,
          phone: status && status.recipient_id ? String(status.recipient_id) : null,
          timestampMs: Number.isFinite(timestampSeconds)
            ? Math.round(timestampSeconds * 1000)
            : Date.now(),
          status: status && status.status ? String(status.status) : null
        });
      }
    }
  }

  return result;
}

async function forwardEvent(event, env) {
  const envelope = await makeEnvelope(
    event,
    Date.now(),
    env.HAMZAWE_GATEWAY_SECRET
  );

  const response = await fetch(env.HAMZAWE_WEBHOOK_URL, {
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

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status: status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleWebhook(request, env) {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const verifyToken = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (!verifyMetaWebhookChallenge(
      mode,
      verifyToken,
      env.META_WEBHOOK_VERIFY_TOKEN,
      challenge
    )) {
      return new Response('VERIFICATION_FAILED', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'METHOD_NOT_ALLOWED' });
  }

  const rawBody = await request.arrayBuffer();
  const signature = request.headers.get('x-hub-signature-256');

  if (!await verifyMetaSignature(
    rawBody,
    signature,
    env.META_APP_SECRET
  )) {
    return jsonResponse(401, { error: 'INVALID_META_SIGNATURE' });
  }

  let payload;
  try {
    payload = JSON.parse(decoder.decode(rawBody));
  } catch (error) {
    return jsonResponse(400, { error: 'INVALID_JSON' });
  }

  const events = collectNormalizedEvents(payload);

  for (const event of events.messages) {
    if (!event.messageId || !event.phone) continue;
    await forwardEvent(event, env);
  }

  if (events.statuses.length) {
    console.log(JSON.stringify({
      event: 'META_STATUS_EVENTS_IGNORED',
      count: events.statuses.length
    }));
  }

  return jsonResponse(200, {
    ok: true,
    forwardedMessages: events.messages.filter(function(event) {
      return !!event.messageId && !!event.phone;
    }).length,
    ignoredStatuses: events.statuses.length
  });
}

export {
  GATEWAY_VERSION,
  GATEWAY_MAX_AGE_MS,
  requiredConfig,
  hexFromBytes,
  bytesFromHex,
  hmacHex,
  verifyHmacHex,
  verifyMetaWebhookChallenge,
  verifyMetaSignature,
  canonicalJson,
  signNormalizedEvent,
  makeEnvelope,
  mapMetaMessage,
  collectNormalizedEvents,
  forwardEvent,
  handleWebhook
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      const missing = requiredConfig(env);
      return jsonResponse(
        missing.length ? 503 : 200,
        { ok: missing.length === 0 }
      );
    }

    if (url.pathname !== '/webhook') {
      return jsonResponse(404, { error: 'NOT_FOUND' });
    }

    const missing = requiredConfig(env);
    if (missing.length) {
      console.error(JSON.stringify({
        event: 'GATEWAY_CONFIG_MISSING',
        count: missing.length
      }));
      return jsonResponse(503, { error: 'GATEWAY_NOT_CONFIGURED' });
    }

    try {
      return await handleWebhook(request, env);
    } catch (error) {
      console.error(error);
      return jsonResponse(502, {
        error: 'GATEWAY_FAILURE',
        message: error && error.message ? error.message : 'Gateway failure'
      });
    }
  }
};
