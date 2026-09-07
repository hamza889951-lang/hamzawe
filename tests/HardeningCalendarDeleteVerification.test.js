'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = vm.createContext({ console: console });

let eventPresent = true;
let apiItems = [];
let calendarCalls = 0;
let eventLookupCalls = 0;
let deleteCalls = 0;
let apiListCalls = 0;
let lastApiListArgs = null;

const operationId = 'B6_TEST_OPERATION';

const event = {
  getId: function() { return 'OLD_EVENT@google.com'; },
  getTag: function(key) { return key === 'operation_id' ? operationId : ''; },
  deleteEvent: function() {
    deleteCalls += 1;
    eventPresent = false;
  }
};

function calendarContext(calendarId) {
  calendarCalls += 1;
  return {
    getId: function() { return calendarId; },
    getEventById: function() {
      eventLookupCalls += 1;
      // Deliberately keep returning the deleted CalendarEvent object. This
      // reproduces the observed false-negative verifier behavior while the
      // authoritative API below reports the actual server-side state.
      return event;
    }
  };
}

sandbox.CalendarApp = {
  getDefaultCalendar: function() { return calendarContext('CAL_DEFAULT'); },
  getCalendarById: function(calendarId) { return calendarContext(calendarId); }
};

function installCalendarApiMock() {
  sandbox.Calendar = {
    Events: {
      list: function(calendarId, args) {
        apiListCalls += 1;
        lastApiListArgs = { calendarId: calendarId, args: args };
        return { items: apiItems.slice() };
      }
    }
  };
}

installCalendarApiMock();

const source = fs.readFileSync(path.join(ROOT, 'Infrastructure/GoogleCalendar.js'), 'utf8');
vm.runInContext(source + '\nthis.GoogleCalendar = GoogleCalendar;', sandbox, {
  filename: 'Infrastructure/GoogleCalendar.js'
});

function reset() {
  eventPresent = true;
  apiItems = [];
  calendarCalls = 0;
  eventLookupCalls = 0;
  deleteCalls = 0;
  apiListCalls = 0;
  lastApiListArgs = null;
  installCalendarApiMock();
}

function testAuthoritativeAbsenceIgnoresStaleCalendarAppObservation() {
  reset();
  apiItems = [];

  const result = sandbox.GoogleCalendar.deleteLifecycleEvent(
    'OLD_EVENT@google.com',
    'CAL_DEFAULT',
    operationId
  );

  assert.strictEqual(result.status, 'ABSENCE_OBSERVED');
  assert.strictEqual(result.deleteConfirmed, true);
  assert.strictEqual(result.absenceObserved, true);
  assert.strictEqual(result.matchingEventCount, 0);
  assert.strictEqual(result.verificationAttempts, 1);
  assert.strictEqual(deleteCalls, 1);
  assert.strictEqual(eventLookupCalls, 2);
  assert.strictEqual(apiListCalls, 1);
  assert.strictEqual(lastApiListArgs.calendarId, 'CAL_DEFAULT');
  assert.strictEqual(lastApiListArgs.args.iCalUID, 'OLD_EVENT@google.com');
  assert.strictEqual(lastApiListArgs.args.showDeleted, false);
}

function testApiEvidenceStillPresentRemainsFailClosed() {
  reset();
  apiItems = [{ id: 'api-event-id', iCalUID: 'OLD_EVENT@google.com', status: 'confirmed' }];

  const result = sandbox.GoogleCalendar.deleteLifecycleEvent(
    'OLD_EVENT@google.com',
    'CAL_DEFAULT',
    operationId
  );

  assert.strictEqual(result.status, 'DELETE_NOT_PROVEN');
  assert.strictEqual(result.deleteConfirmed, true);
  assert.strictEqual(result.absenceObserved, false);
  assert.strictEqual(result.matchingEventCount, 1);
  assert.strictEqual(result.verificationAttempts, 1);
  assert.strictEqual(deleteCalls, 1);
  assert.strictEqual(apiListCalls, 1);
}

function testMissingAdvancedServiceThrowsAtInfrastructureBoundary() {
  reset();
  sandbox.Calendar = undefined;

  assert.throws(function() {
    sandbox.GoogleCalendar.deleteLifecycleEvent(
      'OLD_EVENT@google.com',
      'CAL_DEFAULT',
      operationId
    );
  }, /CALENDAR_ADVANCED_SERVICE_UNAVAILABLE/);

  assert.strictEqual(deleteCalls, 1);
  installCalendarApiMock();
}

function testCorrelationMismatchNeverDeletesOrCallsApi() {
  reset();

  const result = sandbox.GoogleCalendar.deleteLifecycleEvent(
    'OLD_EVENT@google.com',
    'CAL_DEFAULT',
    'B6_OTHER_OPERATION'
  );

  assert.strictEqual(result.status, 'CORRELATION_MISMATCH');
  assert.strictEqual(result.deleteConfirmed, false);
  assert.strictEqual(result.absenceObserved, false);
  assert.strictEqual(result.verificationAttempts, 0);
  assert.strictEqual(deleteCalls, 0);
  assert.strictEqual(apiListCalls, 0);
  assert.strictEqual(eventPresent, true);
}

const tests = [
  ['authoritative absence ignores stale CalendarApp observation', testAuthoritativeAbsenceIgnoresStaleCalendarAppObservation],
  ['authoritative API still present remains DELETE_NOT_PROVEN', testApiEvidenceStillPresentRemainsFailClosed],
  ['missing advanced service fails at the infrastructure proof boundary', testMissingAdvancedServiceThrowsAtInfrastructureBoundary],
  ['correlation mismatch never deletes or queries authoritative API', testCorrelationMismatchNeverDeletesOrCallsApi]
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
