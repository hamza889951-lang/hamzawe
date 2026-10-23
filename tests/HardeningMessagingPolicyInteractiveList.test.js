'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../Application/MessagingPolicyService.js'),
  'utf8'
);

const calls = { list: 0, buttons: 0, text: 0, logs: 0 };
let listResult = { ok: true, data: { accepted: true } };

const context = {
  WhatsAppAdapter: {
    sendInteractiveList: function(phone, text, list) {
      calls.list += 1;
      calls.listArgs = { phone: phone, text: text, list: list };
      return listResult;
    },
    sendInteractiveButtons: function() {
      calls.buttons += 1;
      return { ok: true, data: {} };
    },
    sendText: function(phone, text) {
      calls.text += 1;
      calls.textArgs = { phone: phone, text: text };
      return { ok: true, data: { fallback: true } };
    }
  },
  LogRepository: {
    write: function() { calls.logs += 1; }
  },
  Clock: {
    now: function() { return new Date('2026-10-23T03:00:00Z'); }
  },
  console: console
};

vm.runInNewContext(
  source + '\nthis.__policy = MessagingPolicyService;',
  context
);

const policy = context.__policy;
const list = {
  buttonTitle: 'فتح القائمة',
  sections: [{
    title: 'لوحة الطبيب',
    rows: [
      { id: 'VIEW_SCHEDULE', title: 'عرض جدول الدوام' },
      { id: 'CHANGE_SCHEDULE', title: 'تغيير جدول الدوام' },
      { id: 'TEMPORARY_AVAILABILITY', title: 'إغلاق / فتح مؤقت' },
      { id: 'CANCEL_CHANGE', title: 'إلغاء تغيير مجدول' },
      { id: 'REPORTS', title: 'التقارير' }
    ]
  }]
};

const success = policy.sendReply('9647001111111', 'اختر من لوحة الطبيب', {
  interactiveList: list,
  fallbackToText: true
});
assert.strictEqual(success.ok, true);
assert.strictEqual(calls.list, 1);
assert.strictEqual(calls.buttons, 0);
assert.strictEqual(calls.text, 0);
assert.strictEqual(calls.listArgs.list.sections[0].rows.length, 5);

listResult = {
  ok: false,
  error: { code: 'WHATSAPP_INTERACTIVE_LIST_INVALID', message: 'invalid test list' }
};
const fallback = policy.sendReply('9647001111111', 'اختر من لوحة الطبيب', {
  interactiveList: list,
  fallbackToText: true
});
assert.strictEqual(fallback.ok, true);
assert.strictEqual(calls.list, 2);
assert.strictEqual(calls.text, 1);
assert.strictEqual(calls.logs, 1);
assert.strictEqual(calls.textArgs.text, 'اختر من لوحة الطبيب');

listResult = {
  ok: false,
  error: { code: 'WHATSAPP_INTERACTIVE_LIST_INVALID', message: 'invalid test list' }
};
const noFallback = policy.sendReply('9647001111111', 'اختر من لوحة الطبيب', {
  interactiveList: list,
  fallbackToText: false
});
assert.strictEqual(noFallback.ok, false);
assert.strictEqual(calls.text, 1, 'fallbackToText=false must not send text');
assert.strictEqual(calls.logs, 2);

console.log('PASS: interactive list messaging policy, structured failure logging, and fallback behavior');
