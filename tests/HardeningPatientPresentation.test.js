'use strict';

/**
 * Patient-facing presentation regression tests.
 * The exact appointment slot time must never be used as a patient-facing
 * fallback in Booking/Change/Reminder flows.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
    pass += 1;
  } catch (e) {
    console.error('FAIL: ' + name);
    console.error(e && e.stack ? e.stack : e);
    fail += 1;
  }
}

function source(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadReminder(settings, busResult) {
  const sandbox = vm.createContext({});
  sandbox.Result = {
    ok: function(data) { return { ok: true, data: data }; },
    fail: function(code, message) { return { ok: false, error: { code: code, message: message } }; }
  };
  sandbox.Config = { VOCABULARY: { STATUS: { CONFIRMED: 'CONFIRMED' } } };
  sandbox.SettingsRepository = { getAll: function() { return settings; } };
  sandbox.BusNumberCalculator = { fromSlot: function() { return busResult; } };
  sandbox.DateUtils = { formatDateDisplay: function(value) { return '2026-09-06'; } };
  vm.runInContext(source('Reminderservice.js') + '\nthis.ReminderService = ReminderService;', sandbox);
  return sandbox.ReminderService;
}

test('PP-01 — ChangeService contains no patient-facing slot-time fallback', function() {
  const src = source('Changeservice.js');
  assert.strictEqual(src.indexOf("'الساعة ' + DateUtils.formatTimeDisplay(commandResult.data.time)") , -1);
  assert.strictEqual(src.indexOf("'الساعة ' + DateUtils.formatTimeDisplay(commandResult.data.time))"), -1);
  assert.ok(src.indexOf('يبدأ دوام العيادة الساعة') !== -1);
});

test('PP-02 — ReminderService contains no slot.time patient fallback', function() {
  const src = source('Reminderservice.js');
  assert.strictEqual(src.indexOf('DateUtils.formatTimeDisplay(slot.time)'), -1);
  assert.ok(src.indexOf('رقم الباص:') !== -1);
  assert.ok(src.indexOf('يبدأ دوام العيادة الساعة') !== -1);
});

test('PP-03 — Reminder success shows date, bus number, and clinic work-start', function() {
  const reminder = loadReminder(
    { work_start: '16:00' },
    { ok: true, data: { busNumber: 1 } }
  );
  const message = reminder._buildReminderMessage({ date: new Date('2026-09-06T13:00:00.000Z'), time: new Date('2026-09-06T13:00:00.000Z') });
  assert.ok(message.indexOf('بتاريخ 2026-09-06') !== -1);
  assert.ok(message.indexOf('رقم الباص: 1') !== -1);
  assert.ok(message.indexOf('يبدأ دوام العيادة الساعة 04:00 مساءً') !== -1);
  assert.strictEqual(message.indexOf('الساعة 16:00'), -1);
});

test('PP-04 — Reminder bus failure never falls back to exact slot time', function() {
  const reminder = loadReminder(
    { work_start: '16:00' },
    { ok: false, error: { code: 'BUS_NUMBER_UNAVAILABLE' } }
  );
  const message = reminder._buildReminderMessage({ date: new Date('2026-09-06T13:00:00.000Z'), time: new Date('2026-09-06T13:00:00.000Z') });
  assert.strictEqual(message.indexOf('الساعة 16:00'), -1);
  assert.strictEqual(message.indexOf('16:00'), -1);
  assert.ok(message.indexOf('تعذّر تحديد رقم الباص') !== -1);
});

process.on('exit', function() {
  console.log('\nPatient presentation tests: ' + pass + '/' + (pass + fail) + ' PASS');
  if (fail > 0) process.exitCode = 1;
});
