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

const doctorIntentCases = [
  ['DOCTOR_VIEW_SCHEDULE', 'VIEW_SCHEDULE'],
  ['DOCTOR_CHANGE_SCHEDULE', 'CHANGE_SCHEDULE'],
  ['DOCTOR_MORE', 'MORE'],
  ['DOCTOR_TEMPORARY_CLOSE', 'TEMPORARY_CLOSE'],
  ['DOCTOR_EXCEPTION_OPEN', 'TEMPORARY_OPEN'],
  ['DOCTOR_CANCEL_CHANGE', 'CANCEL_CHANGE'],
  ['DOCTOR_CONFIRM', 'CONFIRM'],
  ['DOCTOR_CANCEL', 'CANCEL']
];

doctorIntentCases.forEach(function(pair, index) {
  const doctorInbound = adapter.parseIncomingPayload({
    postData: {
      contents: JSON.stringify({
        gatewayVersion: 'v1',
        gatewayTimestampMs: Date.now(),
        event: {
          eventType: 'MESSAGE',
          channel: 'WHATSAPP',
          provider: 'META_CLOUD',
          phone: '9647001234567',
          messageId: 'wamid.doctor-intent-' + index,
          timestampMs: Date.now(),
          messageType: 'INTERACTIVE_BUTTON',
          text: 'presentation',
          buttonPayload: pair[0]
        },
        signature: 'test'
      })
    }
  });
  assert.strictEqual(doctorInbound.buttonPayload, pair[0]);
  assert.strictEqual(doctorInbound.message, pair[1]);
});

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

const doctorOutbound = adapter.sendInteractiveButtons(
  '9647001234567',
  'قائمة تحكم الطبيب',
  [{ id: 'VIEW_SCHEDULE', title: 'عرض الجدول' }]
);

assert.strictEqual(doctorOutbound.ok, true);
assert.strictEqual(sentBody.interactive.type, 'button');
assert.strictEqual(sentBody.interactive.action.buttons[0].reply.id, 'DOCTOR_VIEW_SCHEDULE');
assert.strictEqual(sentBody.interactive.action.buttons[0].reply.title, 'عرض الجدول');

console.log('PASS: WhatsAppAdapter — interactive welcome inbound mapping and outbound reply-button transport');
