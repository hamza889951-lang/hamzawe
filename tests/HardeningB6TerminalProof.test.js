'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, {
    filename: relativePath
  });
}

load('Result.js', 'Result');
load('Config.js', 'Config');

let inspectCalls = 0;
let activeSlots = [];
let oldSlot = null;

sandbox.CalendarRepository = {
  inspectLifecycleAppointmentEvent: function() {
    inspectCalls += 1;
    return sandbox.Result.ok({
      status: 'MATCH',
      eventId: 'OLD_EVENT@google.com',
      calendarId: 'CAL_DEFAULT',
      contextResolved: true
    });
  }
};

sandbox.SlotRepository = {
  queryResult: function(predicateFn) {
    return sandbox.Result.ok(activeSlots.filter(predicateFn));
  }
};

sandbox.B6LifecycleRepository = {};
sandbox.AppointmentRepository = {};
sandbox.Clock = { now: function() { return new Date(1770000000000); } };
sandbox.LogRepository = { write: function() {} };
sandbox.ULID = { generate: function() { return 'ULID'; } };

load('Application/B6LifecycleService.js', 'B6LifecycleService');

function reset() {
  inspectCalls = 0;
  oldSlot = {
    slot_id: 'OLD',
    status: sandbox.Config.VOCABULARY.STATUS.FREE,
    phone: '',
    patient_name: '',
    calendar_event_id: '',
    reserved_until: '',
    reserved_until_unix: ''
  };
  activeSlots = [
    { slot_id: 'NEW', status: sandbox.Config.VOCABULARY.STATUS.CONFIRMED, phone: '9647001111111', calendar_event_id: 'NEW_EVENT' }
  ];
  sandbox.B6LifecycleService._getSlotById = function(slotId) {
    if (slotId === 'OLD') return sandbox.Result.ok(oldSlot);
    if (slotId === 'NEW') return sandbox.Result.ok(activeSlots[0]);
    return sandbox.Result.fail('MISSING', 'missing slot');
  };
  sandbox.B6LifecycleService.verifyReplacementAppointment = function() {
    return sandbox.Result.ok(activeSlots[0]);
  };
}

function validDeleteProof() {
  return {
    status: 'ABSENCE_OBSERVED',
    eventId: 'OLD_EVENT@google.com',
    calendarId: 'CAL_DEFAULT',
    deleteConfirmed: true,
    absenceObserved: true,
    matchingEventCount: 0,
    verificationAttempts: 1
  };
}

function testChangeUsesExistingDeletionProof() {
  reset();
  const ctx = {
    phone: '9647001111111',
    oldSlotId: 'OLD',
    newSlotId: 'NEW',
    oldCalendarEventId: 'OLD_EVENT@google.com',
    oldCalendarId: 'CAL_DEFAULT',
    calendarId: 'CAL_DEFAULT',
    oldCalendarDeleteResult: validDeleteProof()
  };

  const result = sandbox.B6LifecycleService.verifyTerminalChange(ctx);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(inspectCalls, 0);
}

function testCancelUsesExistingDeletionProof() {
  reset();
  activeSlots = [];
  const ctx = {
    phone: '9647001111111',
    oldSlotId: 'OLD',
    oldCalendarEventId: 'OLD_EVENT@google.com',
    oldCalendarId: 'CAL_DEFAULT',
    calendarId: 'CAL_DEFAULT',
    oldCalendarDeleteResult: validDeleteProof()
  };

  const result = sandbox.B6LifecycleService.verifyTerminalCancel(ctx);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(inspectCalls, 0);
}

function testIncompleteDeletionProofRemainsFailClosed() {
  reset();
  const ctx = {
    phone: '9647001111111',
    oldSlotId: 'OLD',
    newSlotId: 'NEW',
    oldCalendarEventId: 'OLD_EVENT@google.com',
    oldCalendarId: 'CAL_DEFAULT',
    calendarId: 'CAL_DEFAULT',
    oldCalendarDeleteResult: {
      status: 'DELETE_NOT_PROVEN',
      eventId: 'OLD_EVENT@google.com',
      calendarId: 'CAL_DEFAULT',
      deleteConfirmed: true,
      absenceObserved: false,
      matchingEventCount: 1,
      verificationAttempts: 1
    }
  };

  const result = sandbox.B6LifecycleService.verifyTerminalChange(ctx);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'B6_OLD_CALENDAR_ABSENCE_NOT_PROVEN');
  assert.strictEqual(inspectCalls, 0);
}

function testMismatchedDeletionProofRemainsFailClosed() {
  reset();
  const proof = validDeleteProof();
  proof.eventId = 'OTHER_EVENT@google.com';
  const ctx = {
    phone: '9647001111111',
    oldSlotId: 'OLD',
    newSlotId: 'NEW',
    oldCalendarEventId: 'OLD_EVENT@google.com',
    oldCalendarId: 'CAL_DEFAULT',
    calendarId: 'CAL_DEFAULT',
    oldCalendarDeleteResult: proof
  };

  const result = sandbox.B6LifecycleService.verifyTerminalChange(ctx);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'B6_OLD_CALENDAR_ABSENCE_NOT_PROVEN');
  assert.strictEqual(inspectCalls, 0);
}

testChangeUsesExistingDeletionProof();
testCancelUsesExistingDeletionProof();
testIncompleteDeletionProofRemainsFailClosed();
testMismatchedDeletionProofRemainsFailClosed();
console.log('HardeningB6TerminalProof.test.js: 4/4 PASS');
