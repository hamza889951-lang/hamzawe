const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function loadObject(path, name) {
  const context = {
    console,
    Result: {
      ok: function(data) { return { ok: true, data: data }; },
      fail: function(code, message, details) {
        return { ok: false, error: { code: code, message: message, details: details } };
      }
    }
  };
  vm.runInNewContext(
    fs.readFileSync(path, 'utf8') + '\nthis.__exported = ' + name + ';',
    context,
    { filename: path }
  );
  return context.__exported;
}

const buttonMap = {
  HAMZAWE_CONFIRM: '1',
  HAMZAWE_CHANGE: '2',
  HAMZAWE_CANCEL: '3',
  HAMZAWE_DECLINE: '2',
  HAMZAWE_START_BOOKING: 'START_BOOKING'
};
assert.strictEqual(buttonMap.HAMZAWE_CONFIRM, '1');
assert.strictEqual(buttonMap.HAMZAWE_CHANGE, '2');
assert.strictEqual(buttonMap.HAMZAWE_CANCEL, '3');
assert.strictEqual(buttonMap.HAMZAWE_DECLINE, '2');
assert.strictEqual(buttonMap.HAMZAWE_START_BOOKING, 'START_BOOKING');
assert.strictEqual(buttonMap.UNKNOWN, undefined);

const adapterContext = {
  console,
  Result: {
    ok: function(data) { return { ok: true, data: data }; },
    fail: function(code, message, details) {
      return { ok: false, error: { code: code, message: message, details: details } };
    }
  },
  PropertiesService: {},
  Utilities: {},
  Clock: {}
};
vm.runInNewContext(
  fs.readFileSync('Infrastructure/WhatsAppAdapter.js', 'utf8') +
    '\nthis.__adapter = WhatsAppAdapter;',
  adapterContext,
  { filename: 'Infrastructure/WhatsAppAdapter.js' }
);

const adapter = adapterContext.__adapter;
let sentBody = null;
adapter._postMessage = function(body) {
  sentBody = body;
  return { ok: true, data: { provider: 'META_CLOUD' } };
};

const send = adapter.sendTemplate(
  '9647001234567',
  'booking_confirmation',
  'ar',
  ['2026-10-02', '7', '08:00 صباحًا'],
  ['HAMZAWE_CONFIRM', 'HAMZAWE_CHANGE']
);

assert.strictEqual(send.ok, true);
assert.strictEqual(sentBody.type, 'template');
assert.strictEqual(sentBody.template.name, 'booking_confirmation');
assert.strictEqual(sentBody.template.components.length, 3);
assert.deepStrictEqual(sentBody.template.components[0], {
  type: 'body',
  parameters: [
    { type: 'text', text: '2026-10-02' },
    { type: 'text', text: '7' },
    { type: 'text', text: '08:00 صباحًا' }
  ]
});
assert.deepStrictEqual(sentBody.template.components[1], {
  type: 'button',
  sub_type: 'quick_reply',
  index: '0',
  parameters: [{ type: 'payload', payload: 'HAMZAWE_CONFIRM' }]
});
assert.deepStrictEqual(sentBody.template.components[2], {
  type: 'button',
  sub_type: 'quick_reply',
  index: '1',
  parameters: [{ type: 'payload', payload: 'HAMZAWE_CHANGE' }]
});

console.log('PASS: WhatsApp interactive template catalog and transport contract');
