'use strict';

/**
 * HardeningWhatsAppAdapterInteractive.test.js
 *
 * Verifies the Doctor Control interactive transport round-trip:
 * provider-neutral intent -> Meta transport ID -> inbound provider-neutral intent.
 *
 * This closes the gap where Application-level interactive tests passed while
 * the WhatsApp transport mapping could still drop a guided UX button.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../Infrastructure/WhatsAppAdapter.js'),
  'utf8'
);

const sentBodies = [];

const context = {
  Result: {
    ok: data => ({ ok: true, data: data }),
    fail: (code, message, details) => ({
      ok: false,
      error: { code: code, message: message, details: details }
    })
  },
  PhoneUtils: {
    normalize: value => String(value || '')
  },
  Clock: {
    now: function() { return new Date('2026-10-04T08:00:00Z'); }
  },
  PropertiesService: {
    getScriptProperties: function() {
      return {
        getProperty: function() { return 'TEST'; }
      };
    }
  },
  Utilities: {
    Charset: { UTF_8: 'UTF-8' },
    computeHmacSha256Signature: function() { return []; }
  },
  console: console
};

vm.runInNewContext(
  source + '\nthis.__adapter = WhatsAppAdapter;',
  context
);

const adapter = context.__adapter;

// Capture the exact Meta request without making a network call.
adapter._postMessage = function(body) {
  sentBodies.push(body);
  return context.Result.ok({ captured: true });
};

// Skip cryptographic verification here; this test is specifically the
// transport ID round-trip, while signature verification has its own coverage.
adapter._verifyGatewayEnvelope = function() {
  return context.Result.ok({ verified: true });
};

const expected = {
  VIEW_SCHEDULE: 'DOCTOR_VIEW_SCHEDULE',
  CHANGE_SCHEDULE: 'DOCTOR_CHANGE_SCHEDULE',
  MORE: 'DOCTOR_MORE',
  TEMPORARY_CLOSE: 'DOCTOR_TEMPORARY_CLOSE',
  TEMPORARY_OPEN: 'DOCTOR_EXCEPTION_OPEN',
  CANCEL_CHANGE: 'DOCTOR_CANCEL_CHANGE',
  CONFIRM: 'DOCTOR_CONFIRM',
  CANCEL: 'DOCTOR_CANCEL',
  TEMP_CLOSE_FULL_DAY: 'DOCTOR_TEMP_CLOSE_FULL_DAY',
  TEMP_CLOSE_PERIOD: 'DOCTOR_TEMP_CLOSE_PERIOD',
  EDIT: 'DOCTOR_EDIT',
  EDIT_DAYS: 'DOCTOR_EDIT_DAYS',
  EDIT_TIMES: 'DOCTOR_EDIT_TIMES',
  EDIT_DATE: 'DOCTOR_EDIT_DATE'
};

Object.keys(expected).forEach(function(intent) {
  sentBodies.length = 0;

  const send = adapter.sendInteractiveButtons(
    '9647001111111',
    'اختبار',
    [{ id: intent, title: 'اختبار' }]
  );

  assert.strictEqual(send.ok, true, 'Outbound send failed for ' + intent);
  assert.strictEqual(sentBodies.length, 1, 'Expected one Meta request for ' + intent);

  const body = sentBodies[0];
  const metaId = body.interactive.action.buttons[0].reply.id;

  assert.strictEqual(
    metaId,
    expected[intent],
    'Outbound mapping mismatch for ' + intent
  );

  const parsed = adapter.parseIncomingPayload({
    postData: {
      contents: JSON.stringify({
        gatewayVersion: 'v1',
        gatewayTimestampMs: Date.now(),
        event: {
          channel: 'WHATSAPP',
          provider: 'META_CLOUD',
          eventType: 'MESSAGE',
          messageId: 'wamid.TEST.' + intent,
          phone: '9647001111111',
          timestampMs: Date.now(),
          messageType: 'INTERACTIVE_BUTTON',
          text: 'اختبار',
          buttonPayload: metaId
        },
        signature: 'TEST'
      })
    }
  });

  assert.ok(parsed, 'Inbound parser rejected ' + intent);
  assert.strictEqual(
    parsed.message,
    intent,
    'Inbound mapping mismatch for ' + intent
  );
});

console.log(
  'PASS: Doctor Control interactive transport round-trip — ' +
  Object.keys(expected).length + ' intents verified'
);
