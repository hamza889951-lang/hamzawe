'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const EVENT_ID = 'TEST_EVENT_001';
const ICAL_UID = EVENT_ID + '@google.com';
const SLOT_ID = 'SLT_TEST_001';
const OPERATOR_EMAIL = 'doctor.test@hamzawe.clinic';

function load(sandbox, relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, { filename: relativePath });
}

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    availabilityRows: [], auditRows: [], reads: 0, writes: 0,
    lockHeld: false, queryFailure: false, updateFailure: false,
    auditFailure: false, identityMode: 'success', identityCalls: [],
    identityMap: {}, properties: { ATTENDANCE_OPERATOR_EMAIL: OPERATOR_EMAIL }
  };
  const headers = ['slot_id','date','time','sort_key','status','is_available','patient_name','phone','calendar_event_id','Reminder_sent','whatsapp_message_id','reserved_until','reserved_until_unix'];

  sandbox.Clock = { now: function() { return new Date(1770000000000); } };
  sandbox.ULID = { generate: function() { return 'TEST_ULID'; } };
  sandbox.GoogleSheets = {
    queryRows: function(sheet, predicate) {
      if (sheet !== 'Availability') throw new Error('UNEXPECTED_SHEET');
      state.reads += 1;
      if (state.queryFailure) throw new Error('INJECTED_READ_FAILURE');
      return state.availabilityRows.filter(predicate).map(function(r) { return Object.assign({}, r); });
    },
    findRowByColumn: function(sheet, column, value) {
      if (sheet !== 'Availability') throw new Error('UNEXPECTED_SHEET');
      state.reads += 1;
      const row = state.availabilityRows.find(function(r) { return r[column] === value; });
      return row ? Object.assign({}, row) : null;
    },
    updateRowByColumn: function(sheet, column, value, fields) {
      if (sheet !== 'Availability') throw new Error('UNEXPECTED_SHEET');
      if (state.updateFailure) return false;
      const row = state.availabilityRows.find(function(r) { return r[column] === value; });
      if (!row) return false;
      Object.keys(fields).forEach(function(k) { if (headers.indexOf(k) !== -1) { row[k] = fields[k]; state.writes += 1; } });
      return true;
    },
    getOrCreateSheet: function(name) { if (name !== 'ATTENDANCE_AUDIT' && name !== 'SYSTEM_LOG') throw new Error('UNEXPECTED_SHEET'); },
    getHeaders: function(name) { if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET'); return sandbox.AttendanceAuditRepository.HEADERS.slice(); },
    appendRows: function(name, rows) {
      if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET');
      if (state.auditFailure) return sandbox.Result.fail('APPEND_FAILED', 'injected audit failure');
      rows.forEach(function(r) { state.auditRows.push(r.slice()); });
      return sandbox.Result.ok({ inserted: rows.length });
    },
    appendRow: function(name, row) { if (name !== 'SYSTEM_LOG') throw new Error('UNEXPECTED_SHEET'); }
  };
  sandbox.LockService = { getScriptLock: function() { return {
    waitLock: function() { if (state.lockHeld) throw new Error('LOCK_HELD'); state.lockHeld = true; },
    releaseLock: function() { state.lockHeld = false; }
  }; } };
  sandbox.Calendar = { Events: { get: function(calendarId, eventId) {
    state.identityCalls.push({ calendarId: calendarId, eventId: eventId });
    if (state.identityMode === 'throw') throw new Error('INJECTED_CALENDAR_FAILURE');
    if (state.identityMode === 'notFound') return null;
    if (state.identityMode === 'missingIcalUID') return { id: eventId };
    if (state.identityMode === 'mismatch') return { id: 'WRONG_ID', iCalUID: ICAL_UID };
    return { id: eventId, iCalUID: state.identityMap[eventId] || ICAL_UID };
  } } };
  sandbox.PropertiesService = { getScriptProperties: function() { return { getProperty: function(key) { return Object.prototype.hasOwnProperty.call(state.properties, key) ? state.properties[key] : null; } }; } };
  sandbox.Session = { getActiveUser: function() { return { getEmail: function() { return OPERATOR_EMAIL; } }; } };

  load(sandbox, 'Result.js', 'Result');
  load(sandbox, 'Config.js', 'Config');
  load(sandbox, 'StateMachine.js', 'StateMachine');
  load(sandbox, 'Domain/Validators.js', 'Validators');
  load(sandbox, 'Infrastructure/Lock.js', 'Lock');
  load(sandbox, 'Infrastructure/GoogleCalendar.js', 'GoogleCalendar');
  load(sandbox, 'Repositories/CalendarRepository.js', 'CalendarRepository');
  load(sandbox, 'Repositories/SlotRepository.js', 'SlotRepository');
  load(sandbox, 'Repositories/AttendanceAuditRepository.js', 'AttendanceAuditRepository');
  load(sandbox, 'LogRepository.js', 'LogRepository');
  load(sandbox, 'Application/AttendanceService.js', 'AttendanceService');

  function reset(status) {
    state.availabilityRows = [{ slot_id: SLOT_ID, date: '2026/09/07', time: '09:15', sort_key: '202609070915', status: status || 'CONFIRMED', is_available: true, patient_name: 'Test Patient', phone: '9647001111111', calendar_event_id: ICAL_UID, Reminder_sent: '', whatsapp_message_id: '', reserved_until: '', reserved_until_unix: '' }];
    state.auditRows = []; state.reads = 0; state.writes = 0; state.lockHeld = false;
    state.queryFailure = false; state.updateFailure = false; state.auditFailure = false;
    state.identityMode = 'success'; state.identityCalls = []; state.identityMap = {};
  }
  return { sandbox: sandbox, state: state, reset: reset };
}

const env = createSandbox();
const sandbox = env.sandbox;
const state = env.state;
const Reset = env.reset;
function context(overrides) {
  const o = overrides || {};
  return {
    operator: o.operator === undefined ? { operatorId: OPERATOR_EMAIL } : o.operator,
    deployment: o.deployment === undefined ? { trustedOperatorEmail: OPERATOR_EMAIL } : o.deployment,
    calendarEvent: o.calendarEvent === undefined ? { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' } : o.calendarEvent
  };
}

const tests = [
  ['M0-CRIT-01 — operator trust boundary precedes all Calendar/Availability access', function() {
    Reset();
    let r = sandbox.AttendanceService.markCompleted(context({ operator: null }));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'ATTENDANCE_OPERATOR_INVALID');
    assert.strictEqual(state.reads, 0); assert.strictEqual(state.identityCalls.length, 0); assert.strictEqual(state.writes, 0);
    Reset(); r = sandbox.AttendanceService.markCompleted(context({ deployment: {} }));
    assert.strictEqual(r.error.code, 'ATTENDANCE_TRUST_POLICY_UNCONFIGURED'); assert.strictEqual(state.reads, 0); assert.strictEqual(state.identityCalls.length, 0);
    Reset(); r = sandbox.AttendanceService.markCompleted(context({ operator: { operatorId: 'other@example.com' } }));
    assert.strictEqual(r.error.code, 'ATTENDANCE_OPERATOR_UNAUTHORIZED'); assert.strictEqual(state.reads, 0); assert.strictEqual(state.identityCalls.length, 0);
  }],
  ['M0-CRIT-02 — unsupported attendance decision is rejected without side effects', function() {
    Reset();
    const r = sandbox.AttendanceService._applyAttendance('UNKNOWN', context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'ATTENDANCE_DECISION_INVALID');
    assert.strictEqual(state.reads, 0); assert.strictEqual(state.identityCalls.length, 0); assert.strictEqual(state.writes, 0);
  }],
  ['M0-CRIT-03 — lifecycle transitions remain StateMachine-authoritative', function() {
    Reset();
    let r = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(r.ok, true); assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
    const writes = state.writes;
    r = sandbox.AttendanceService.markNoShow(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'INVALID_TRANSITION');
    assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED'); assert.strictEqual(state.writes, writes);
    Reset('FREE'); r = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'INVALID_TRANSITION'); assert.strictEqual(state.writes, 0);
    assert.strictEqual(sandbox.StateMachine.resolve('CONFIRMED', 'CompleteAppointment'), 'COMPLETED');
    assert.strictEqual(sandbox.StateMachine.resolve('CONFIRMED', 'MarkNoShow'), 'NO_SHOW');
  }],
  ['M0-CRIT-04 — idempotent duplicate is a no-op while preserving the audit trail', function() {
    Reset();
    let first = sandbox.AttendanceService.markCompleted(context());
    const writes = state.writes; const auditCount = state.auditRows.length;
    const second = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(first.ok, true); assert.strictEqual(second.ok, true); assert.strictEqual(second.data.alreadyApplied, true);
    assert.strictEqual(state.writes, writes); assert.strictEqual(state.auditRows.length, auditCount + 1);
  }],
  ['M0-CRIT-05 — lock/write/read failures are fail-closed', function() {
    Reset(); state.lockHeld = true;
    let r = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'LOCK_TIMEOUT'); assert.strictEqual(state.writes, 0); state.lockHeld = false;
    Reset(); state.updateFailure = true;
    r = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'UPDATE_FAILED'); assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
    Reset(); state.queryFailure = true;
    r = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'ATTENDANCE_CORRELATION_READ_FAILED'); assert.strictEqual(state.writes, 0);
  }],
  ['M0-CRIT-06 — canonical correlation failure and ambiguity never mutate Availability', function() {
    Reset(); state.identityMap[EVENT_ID] = 'UNKNOWN_UID@google.com';
    let r = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'ATTENDANCE_EVENT_NOT_CORRELATED'); assert.strictEqual(state.writes, 0);
    Reset(); state.availabilityRows.push(Object.assign({}, state.availabilityRows[0], { slot_id: 'SLT_TEST_002' }));
    r = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'ATTENDANCE_EVENT_AMBIGUOUS'); assert.strictEqual(state.writes, 0);
  }],
  ['M0-CRIT-07 — Calendar identity boundary fails closed on malformed API outcomes', function() {
    Reset(); let r = sandbox.CalendarRepository.resolveAppointmentEventIdentity('', 'CAL_DEFAULT');
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'CALENDAR_EVENT_IDENTITY_RESOLUTION_FAILED'); assert.strictEqual(state.identityCalls.length, 0);
    Reset(); state.identityMode = 'throw'; r = sandbox.AttendanceService.markNoShow(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'ATTENDANCE_EVENT_IDENTITY_RESOLUTION_FAILED'); assert.strictEqual(state.writes, 0);
    Reset(); state.identityMode = 'missingIcalUID'; r = sandbox.AttendanceService.markCompleted(context());
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'ATTENDANCE_EVENT_IDENTITY_RESOLUTION_FAILED'); assert.strictEqual(state.writes, 0);
    Reset(); state.identityMode = 'mismatch'; r = sandbox.CalendarRepository.resolveAppointmentEventIdentity(EVENT_ID, 'CAL_DEFAULT');
    assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'CALENDAR_EVENT_IDENTITY_RESOLUTION_FAILED');
  }],
  ['M0-CRIT-08 — Add-on derives operator identity server-side and does not accept caller operatorId', function() {
    const src = fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8');
    assert.ok(src.indexOf('Session.getActiveUser') !== -1);
    assert.ok(src.indexOf('_resolveOperatorContext()') !== -1);
    assert.strictEqual(src.indexOf('params.operatorId'), -1);
    assert.strictEqual(src.indexOf('parameters.operatorId'), -1);
  }],
  ['M0-CRIT-09 — CardService contract, Arabic labels, handler mapping, and manifest remain protected', function() {
    const addOn = fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8');
    assert.ok(addOn.indexOf("setText('حضر ✅')") !== -1); assert.ok(addOn.indexOf("setText('لم يحضر ❌')") !== -1);
    assert.ok(addOn.indexOf("_attendanceAction('onMarkCompleted'") !== -1); assert.ok(addOn.indexOf("_attendanceAction('onMarkNoShow'") !== -1);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
    assert.ok(manifest.addOns && manifest.addOns.calendar);
    assert.ok(manifest.dependencies && Array.isArray(manifest.dependencies.enabledAdvancedServices));
    assert.ok(manifest.dependencies.enabledAdvancedServices.some(function(s) { return s.userSymbol === 'Calendar'; }));
  }],
  ['M0-CRIT-10 — production boundaries contain no heuristic event-id conversion', function() {
    const service = fs.readFileSync(path.join(ROOT, 'Application/AttendanceService.js'), 'utf8');
    const calendar = fs.readFileSync(path.join(ROOT, 'Infrastructure/GoogleCalendar.js'), 'utf8');
    const repository = fs.readFileSync(path.join(ROOT, 'Repositories/CalendarRepository.js'), 'utf8');
    assert.ok(service.indexOf('CalendarRepository.resolveAppointmentEventIdentity') !== -1);
    assert.strictEqual(service.indexOf('CalendarApp'), -1); assert.strictEqual(service.indexOf("+ '@google.com'"), -1);
    assert.ok(calendar.indexOf('Calendar.Events.get') !== -1); assert.strictEqual(calendar.indexOf("+ '@google.com'"), -1);
    assert.ok(repository.indexOf('GoogleCalendar.resolveAppointmentEventIdentity') !== -1);
  }]
];

let failures = 0;
tests.forEach(function(entry) {
  try { entry[1](); console.log('PASS:', entry[0]); }
  catch (e) { failures += 1; console.error('FAIL:', entry[0]); console.error(e.stack || e.message); }
});
if (failures) process.exit(1);
console.log('\n' + (tests.length - failures) + '/' + tests.length + ' tests passed');
