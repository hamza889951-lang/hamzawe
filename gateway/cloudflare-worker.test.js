const assert = require('assert');

(async function main() {
  const workerModule = await import('./cloudflare-worker.mjs');
  const worker = workerModule.default;

  const env = {
    META_APP_SECRET: 'meta-app-secret',
    META_WEBHOOK_VERIFY_TOKEN: 'verify-123',
    HAMZAWE_WEBHOOK_URL: 'https://example.test/apps-script',
    HAMZAWE_GATEWAY_SECRET: 'gateway-secret'
  };

  const originalFetch = globalThis.fetch;
  const forwarded = [];

  globalThis.fetch = async function(input, init) {
    assert.strictEqual(String(input), env.HAMZAWE_WEBHOOK_URL);
    forwarded.push(JSON.parse(init.body));
    return new Response('OK', { status: 200 });
  };

  try {
    const health = await worker.fetch(
      new Request('https://gateway.example/healthz'),
      env
    );
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(await health.json(), { ok: true });

    const challenge = await worker.fetch(
      new Request(
        'https://gateway.example/webhook' +
        '?hub.mode=subscribe' +
        '&hub.verify_token=verify-123' +
        '&hub.challenge=challenge-abc'
      ),
      env
    );
    assert.strictEqual(challenge.status, 200);
    assert.strictEqual(await challenge.text(), 'challenge-abc');

    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            messages: [{
              from: '9647001234567',
              id: 'wamid.worker-test-1',
              timestamp: '1779000000',
              type: 'text',
              text: { body: 'مرحبا من Worker' }
            }]
          }
        }]
      }]
    });

    const validSignature =
      'sha256=' +
      await workerModule.hmacHex(
        env.META_APP_SECRET,
        new TextEncoder().encode(body)
      );

    const validPost = await worker.fetch(
      new Request('https://gateway.example/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSignature
        },
        body: body
      }),
      env
    );

    assert.strictEqual(validPost.status, 200);
    assert.deepStrictEqual(await validPost.json(), {
      ok: true,
      forwardedMessages: 1,
      ignoredStatuses: 0
    });

    assert.strictEqual(forwarded.length, 1);
    assert.strictEqual(forwarded[0].gatewayVersion, 'v1');
    assert.strictEqual(forwarded[0].event.messageId, 'wamid.worker-test-1');
    assert.strictEqual(forwarded[0].event.messageType, 'TEXT');
    assert.strictEqual(
      await workerModule.verifyHmacHex(
        env.HAMZAWE_GATEWAY_SECRET,
        JSON.stringify(forwarded[0].event),
        forwarded[0].signature
      ),
      true
    );

    const badPost = await worker.fetch(
      new Request('https://gateway.example/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': validSignature + '00'
        },
        body: body
      }),
      env
    );
    assert.strictEqual(badPost.status, 401);
    assert.deepStrictEqual(await badPost.json(), {
      error: 'INVALID_META_SIGNATURE'
    });

    const statusBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            statuses: [{
              id: 'wamid.status-1',
              status: 'delivered',
              recipient_id: '9647001234567',
              timestamp: '1779000001'
            }]
          }
        }]
      }]
    });

    const statusSignature =
      'sha256=' +
      await workerModule.hmacHex(
        env.META_APP_SECRET,
        new TextEncoder().encode(statusBody)
      );

    const statusPost = await worker.fetch(
      new Request('https://gateway.example/webhook', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': statusSignature
        },
        body: statusBody
      }),
      env
    );
    assert.strictEqual(statusPost.status, 200);
    assert.deepStrictEqual(await statusPost.json(), {
      ok: true,
      forwardedMessages: 0,
      ignoredStatuses: 1
    });
    assert.strictEqual(forwarded.length, 1);

    console.log('PASS: Cloudflare Worker gateway — health, Meta verification, signature, forwarding, HMAC envelope, and status isolation');
  } finally {
    globalThis.fetch = originalFetch;
  }
})().catch(function(error) {
  console.error('FAIL: Cloudflare Worker gateway — ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
