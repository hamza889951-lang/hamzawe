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
  sandbox.DateUtils = { formatDateDisplay: function() { return '2026-09-06'; } };
  vm.runInContext(source('Reminderservice.js') + '\nthis.ReminderService = ReminderService;', sandbox);
  return sandbox.ReminderService;
}

function loadChangeForPresentation(settings) {
  const sandbox = vm.createContext({});
  sandbox.Result = {
    ok: function(data) { return { ok: true, data: data }; },
    fail: function(code, message) { return { ok: false, error: { code: code, message: message } }; }
  };
  sandbox.SettingsRepository = { getAll: function() { return settings; } };
  vm.runInContext(source('Changeservice.js') + '\nthis.ChangeService = ChangeService;', sandbox);
  return sandbox.ChangeService;
}

test('PP-01 — ChangeService contains no patient-facing slot-time fallback', function() {
  const src = source('Changeservice.js');
  assert.strictEqual(src.indexOf("'الساعة ' + DateUtils.formatTimeDisplay(commandResult.data.time)"), -1);
  assert.strictEqual(src.indexOf("'الساعة ' + DateUtils.formatTimeDisplay(commandResult.data.time))"), -1);
  assert.ok(src.indexOf('يبدأ دوام العيادة الساعة') !== -1);
});

test('PP-02 — Change pre-confirm reply is bus/date/work-start only', function() {
  const src = source('Changeservice.js');
  assert.ok(src.indexOf("const preConfirmDisplay = 'بتاريخ ' + DateUtils.formatDateDisplay(commandResult.data.date)") !== -1);
  assert.ok(src.indexOf("'الباص رقم: ' + commandResult.data.busNumber") !== -1);
  assert.ok(src.indexOf("'\\nيبدأ دوام العيادة الساعة ' + commandResult.data.clinicWorkStartDisplay") !== -1);
  assert.strictEqual(src.indexOf("'الساعة ' + DateUtils.formatTimeDisplay(commandResult.data.time)"), -1);
});

test('PP-03 — Confirmed-change reply is bus/date/work-start only', function() {
  const src = source('Changeservice.js');
  assert.ok(src.indexOf("const confirmedDisplay = 'بتاريخ ' + DateUtils.formatDateDisplay(commandResult.data.date)") !== -1);
  assert.ok(src.indexOf("'\\nرقم الباص الجديد: ' + commandResult.data.busNumber") !== -1);
  assert.ok(src.indexOf("'\\nيبدأ دوام العيادة الساعة ' + commandResult.data.clinicWorkStartDisplay") !== -1);
  assert.strictEqual(src.indexOf("'الساعة ' + DateUtils.formatTimeDisplay(commandResult.data.time)"), -1);
});

test('PP-04 — Confirmed-change presentation failure enters unresolved before confirmation', function() {
  const src = source('Changeservice.js');
  const presentationFailure = src.indexOf("'PATIENT_PRESENTATION_UNAVAILABLE'");
  const confirmationUpdate = src.indexOf('const confirmResult = SlotRepository.atomicUpdate');
  assert.ok(presentationFailure !== -1);
  assert.ok(confirmationUpdate !== -1);
  assert.ok(presentationFailure < confirmationUpdate, 'presentation must be validated before NEW_SLOT confirmation');
});

test('PP-05 — ReminderService contains no slot.time patient fallback', function() {
  const src = source('Reminderservice.js');
  assert.strictEqual(src.indexOf('DateUtils.formatTimeDisplay(slot.time)'), -1);
  assert.ok(src.indexOf('رقم الباص:') !== -1);
  assert.ok(src.indexOf('يبدأ دوام العيادة الساعة') !== -1);
});

test('PP-06 — Reminder success shows date, bus number, and clinic work-start', function() {
  const reminder = loadReminder(
    { work_start: '16:00' },
    { ok: true, data: { busNumber: 1 } }
  );
  const message = reminder._buildReminderMessage({
    date: new Date('2026-09-06T13:00:00.000Z'),
    time: new Date('2026-09-06T13:00:00.000Z')
  });
  assert.ok(message.indexOf('بتاريخ 2026-09-06') !== -1);
  assert.ok(message.indexOf('رقم الباص: 1') !== -1);
  assert.ok(message.indexOf('يبدأ دوام العيادة الساعة 04:00 مساءً') !== -1);
  assert.strictEqual(message.indexOf('الساعة 16:00'), -1);
});

test('PP-07 — Reminder bus failure never falls back to exact slot time', function() {
  const reminder = loadReminder(
    { work_start: '16:00' },
    { ok: false, error: { code: 'BUS_NUMBER_UNAVAILABLE' } }
  );
  const message = reminder._buildReminderMessage({
    date: new Date('2026-09-06T13:00:00.000Z'),
    time: new Date('2026-09-06T13:00:00.000Z')
  });
  assert.strictEqual(message.indexOf('الساعة 16:00'), -1);
  assert.strictEqual(message.indexOf('16:00'), -1);
  assert.ok(message.indexOf('تعذّر تحديد رقم الباص') !== -1);
});

test('PP-08 — Change presentation helper renders clinic work-start without slot time', function() {
  const change = loadChangeForPresentation({ work_start: '16:00' });
  const result = change._getClinicWorkStartDisplay();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data, '04:00 مساءً');
});

test('PP-09 — Change presentation helper fails closed on invalid clinic work-start', function() {
  const change = loadChangeForPresentation({ work_start: 'not-a-time' });
  const result = change._getClinicWorkStartDisplay();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'PATIENT_PRESENTATION_UNAVAILABLE');
});

test('PP-10 — Reminder presentation helper fails closed on invalid clinic work-start', function() {
  const reminder = loadReminder(
    { work_start: 'not-a-time' },
    { ok: true, data: { busNumber: 1 } }
  );
  const result = reminder._getClinicWorkStartDisplay();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'PATIENT_PRESENTATION_UNAVAILABLE');
});

process.on('exit', function() {
  console.log('\nPatient presentation tests: ' + pass + '/' + (pass + fail) + ' PASS');
  if (fail > 0) process.exitCode = 1;
});
