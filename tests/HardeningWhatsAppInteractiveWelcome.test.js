const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(
  require.resolve('../Infrastructure/WhatsAppAdapter.js'),
  'utf8'
);

const context = {
  Result: {
    ok: data => ({ ok: true, data: data }),
    fail: (code, message, details) => ({
      ok: false,
      error: { code: code, message: message, details: details }
    })
  },
  PhoneUtils: { normalize: value => String(value) },
  Clock: { now: () => new Date() },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: () => 'test-value'
    })
  },
  Utilities: {
    Charset: { UTF_8: 'UTF-8' },
    computeHmacSha256Signature: () => []
  },
  console: console
};

vm.runInNewContext(source + '\nthis.__adapter = WhatsAppAdapter;', context);
const adapter = context.__adapter;

adapter._verifyGatewayEnvelope = function() {
  return context.Result.ok({ verified: true });
};

const inbound = adapter.parseIncomingPayload({
  postData: {
    contents: JSON.stringify({
      gatewayVersion: 'v1',
      gatewayTimestampMs: Date.now(),
      event: {
        eventType: 'MESSAGE',
        channel: 'WHATSAPP',
        provider: 'META_CLOUD',
        phone: '9647001234567',
        messageId: 'wamid.interactive-test',
        timestampMs: Date.now(),
        messageType: 'INTERACTIVE_BUTTON',
        text: 'حجز موعد',
        buttonPayload: 'HAMZAWE_START_BOOKING'
      },
      signature: 'test'
    })
  }
});

assert.strictEqual(inbound.message, 'START_BOOKING');
assert.strictEqual(inbound.buttonPayload, 'HAMZAWE_START_BOOKING');

let sentBody = null;
adapter._postMessage = function(body) {
  sentBody = body;
  return context.Result.ok({ provider: 'META_CLOUD' });
};

const outbound = adapter.sendInteractiveButtons(
  '9647001234567',
  'أهلاً بك في العيادة.',
  [{ id: 'HAMZAWE_START_BOOKING', title: 'حجز موعد' }]
);

assert.strictEqual(outbound.ok, true);
assert.strictEqual(sentBody.type, 'interactive');
assert.strictEqual(sentBody.interactive.type, 'button');
assert.strictEqual(sentBody.interactive.action.buttons.length, 1);
assert.strictEqual(sentBody.interactive.action.buttons[0].type, 'reply');
assert.strictEqual(sentBody.interactive.action.buttons[0].reply.id, 'HAMZAWE_START_BOOKING');
assert.strictEqual(sentBody.interactive.action.buttons[0].reply.title, 'حجز موعد');

console.log('PASS: WhatsAppAdapter — interactive welcome inbound mapping and outbound reply-button transport');
