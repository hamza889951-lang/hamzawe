'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = vm.createContext({ console: console });

let eventPresent = true;
let staleReadsAfterDelete = 0;
let getCalendarCalls = 0;
let getEventCalls = 0;
let sleepCalls = [];

const operationId = 'B6_TEST_OPERATION';

const event = {
  getId: function() { return 'OLD_EVENT'; },
  getTag: function(key) { return key === 'operation_id' ? operationId : ''; },
  deleteEvent: function() { eventPresent = false; }
};

function calendarContext(calendarId) {
  getCalendarCalls += 1;
  return {
    getId: function() { return calendarId; },
    getEventById: function() {
      getEventCalls += 1;
      if (!eventPresent) {
        if (staleReadsAfterDelete > 0) {
          staleReadsAfterDelete -= 1;
          return event;
        }
        return null;
      }
      return event;
    }
  };
}

sandbox.CalendarApp = {
  getDefaultCalendar: function() { return calendarContext('CAL_DEFAULT'); },
  getCalendarById: function(calendarId) { return calendarContext(calendarId); }
};

sandbox.Utilities = {
  sleep: function(ms) { sleepCalls.push(ms); }
};

const source = fs.readFileSync(path.join(ROOT, 'Infrastructure/GoogleCalendar.js'), 'utf8');
vm.runInContext(source + '\nthis.GoogleCalendar = GoogleCalendar;', sandbox, {
  filename: 'Infrastructure/GoogleCalendar.js'
});

function reset() {
  eventPresent = true;
  staleReadsAfterDelete = 0;
  getCalendarCalls = 0;
  getEventCalls = 0;
  sleepCalls = [];
}

function testImmediateAbsence() {
  reset();
  const result = sandbox.GoogleCalendar.deleteLifecycleEvent(
    'OLD_EVENT',
    'CAL_DEFAULT',
    operationId
  );

  assert.strictEqual(result.status, 'ABSENCE_OBSERVED');
  assert.strictEqual(result.deleteConfirmed, true);
  assert.strictEqual(result.absenceObserved, true);
  assert.strictEqual(result.verificationAttempts, 1);
  assert.deepStrictEqual(sleepCalls, []);
  assert.strictEqual(getCalendarCalls, 3);
  assert.strictEqual(getEventCalls, 3);
}

function testTransientReadAfterDelete() {
  reset();
  staleReadsAfterDelete = 2;

  const result = sandbox.GoogleCalendar.deleteLifecycleEvent(
    'OLD_EVENT',
    'CAL_DEFAULT',
    operationId
  );

  assert.strictEqual(result.status, 'ABSENCE_OBSERVED');
  assert.strictEqual(result.deleteConfirmed, true);
  assert.strictEqual(result.absenceObserved, true);
  assert.strictEqual(result.verificationAttempts, 3);
  assert.deepStrictEqual(sleepCalls, [250, 500]);
  assert.strictEqual(getCalendarCalls, 5);
  assert.strictEqual(getEventCalls, 5);
}

function testExhaustedVerificationRemainsFailClosed() {
  reset();
  staleReadsAfterDelete = 99;

  const result = sandbox.GoogleCalendar.deleteLifecycleEvent(
    'OLD_EVENT',
    'CAL_DEFAULT',
    operationId
  );

  assert.strictEqual(result.status, 'DELETE_NOT_PROVEN');
  assert.strictEqual(result.deleteConfirmed, true);
  assert.strictEqual(result.absenceObserved, false);
  assert.strictEqual(result.verificationAttempts, 5);
  assert.deepStrictEqual(sleepCalls, [250, 500, 1000, 2000]);
  assert.strictEqual(getCalendarCalls, 7);
  assert.strictEqual(getEventCalls, 7);
}

function testCorrelationMismatchDoesNotDelete() {
  reset();
  const result = sandbox.GoogleCalendar.deleteLifecycleEvent(
    'OLD_EVENT',
    'CAL_DEFAULT',
    'B6_OTHER_OPERATION'
  );

  assert.strictEqual(result.status, 'CORRELATION_MISMATCH');
  assert.strictEqual(result.deleteConfirmed, false);
  assert.strictEqual(result.absenceObserved, false);
  assert.strictEqual(result.verificationAttempts, 0);
  assert.strictEqual(eventPresent, true);
  assert.deepStrictEqual(sleepCalls, []);
}

const tests = [
  ['immediate absence remains the fast path', testImmediateAbsence],
  ['transient read-after-delete is retried with fresh Calendar contexts', testTransientReadAfterDelete],
  ['verification exhaustion remains DELETE_NOT_PROVEN and fail-closed', testExhaustedVerificationRemainsFailClosed],
  ['correlation mismatch never reaches delete', testCorrelationMismatchDoesNotDelete]
];

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (error) {
    console.error('FAIL ' + name);
    console.error(error.stack || error.message);
    process.exitCode = 1;
    break;
  }
}

if (process.exitCode !== 1) {
  console.log('All ' + passed + ' tests passed.');
}
