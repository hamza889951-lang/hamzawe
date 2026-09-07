'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';
const OTHER_PHONE = '9647002222222';
const EVENT_ID = 'TEST_EVENT_001';
const OTHER_EVENT_ID = 'TEST_EVENT_002';
const ICAL_UID = EVENT_ID + '@google.com';
const OTHER_ICAL_UID = OTHER_EVENT_ID + '@google.com';
const SLOT_ID = 'SLT_TEST_001';
const OTHER_SLOT_ID = 'SLT_TEST_002';
const OPERATOR_EMAIL = 'doctor.test@hamzawe.clinic';
const OTHER_ACCOUNT_EMAIL = 'stranger.test@hamzawe.clinic';
const NOW_MS = 1770000000000;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const CARD_SERVICE_CONTRACT = {
  newCardBuilder: ['setHeader', 'addSection', 'addWidget', 'build'],
  newCardHeader: ['setTitle', 'setSubtitle'],
  newCardSection: ['setHeader', 'addWidget'],
  newTextParagraph: ['setText', 'setMaxLines'],
  newTextButton: ['setText', 'setOnClickAction', 'setDisabled'],
  newAction: ['setFunctionName', 'setParameters', 'addRequiredWidget', 'setAllWidgetsAreRequired'],
  newNavigation: ['updateCard', 'pushCard', 'popCard', 'popToRoot'],
  newActionResponseBuilder: ['setNavigation', 'setNotification', 'setOpenLink', 'setStateChanged', 'build']
};

function makeCardService() {
  function makeObject(factoryName) {
    if (!CARD_SERVICE_CONTRACT[factoryName]) throw new Error('UNKNOWN_CARD_API:' + factoryName);
    const state = { kind: factoryName, title: '', header: '', text: '', widgets: [], action: null, parameters: null, navigation: null, stateChanged: null };
    const obj = { state: state };
    CARD_SERVICE_CONTRACT[factoryName].forEach(function(method) {
      obj[method] = function() {
        const args = Array.prototype.slice.call(arguments);
        if (method === 'setHeader') state.header = args[0] && args[0].state ? args[0].state : args[0];
        else if (method === 'addSection' || method === 'addWidget') state.widgets.push(args[0].state);
        else if (method === 'setTitle') state.title = args[0];
        else if (method === 'setText') state.text = args[0];
        else if (method === 'setOnClickAction') state.action = args[0].state;
        else if (method === 'setFunctionName') state.functionName = args[0];
        else if (method === 'setParameters') state.parameters = args[0];
        else if (method === 'updateCard' || method === 'pushCard') state.navigationCard = args[0];
        else if (method === 'setNavigation') state.navigation = args[0].state;
        else if (method === 'setStateChanged') state.stateChanged = args[0];
        else if (method === 'build') {
          state.built = { kind: factoryName, title: state.title, header: state.header, text: state.text, widgets: state.widgets, navigation: state.navigation, stateChanged: state.stateChanged };
          return state.built;
        }
        return obj;
      };
    });
    return obj;
  }
  const service = {};
  Object.keys(CARD_SERVICE_CONTRACT).forEach(function(name) { service[name] = function() { return makeObject(name); }; });
  return service;
}

function load(sandbox, relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, { filename: relativePath });
}

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    availabilityRows: [], auditRows: [], logEntries: [], nowMs: NOW_MS,
    queryReadFailure: false, updateRowFailure: false, auditAppendFailure: false,
    lockHeld: false, cellWrites: 0, storageReads: 0, identityCalls: [],
    identityMode: 'success', identityMap: {}, sessionEmail: OPERATOR_EMAIL,
    properties: { ATTENDANCE_OPERATOR_EMAIL: OPERATOR_EMAIL }
  };

  const AVAIL_HEADERS = ['slot_id', 'date', 'time', 'sort_key', 'status', 'is_available', 'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent', 'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'];

  sandbox.Clock = { now: function() { return new Date(state.nowMs); } };
  sandbox.ULID = { generate: function() { return 'TEST_ULID'; } };

  sandbox.GoogleSheets = {
    findRowByColumn: function(sheetName, columnName, value) {
      if (sheetName !== 'Availability') throw new Error('UNEXPECTED_SHEET:' + sheetName);
      state.storageReads += 1;
      const row = state.availabilityRows.find(function(r) { return r[columnName] === value; });
      return row ? Object.assign({}, row) : null;
    },
    queryRows: function(sheetName, predicateFn) {
      if (sheetName !== 'Availability') throw new Error('UNEXPECTED_SHEET:' + sheetName);
      state.storageReads += 1;
      if (state.queryReadFailure) throw new Error('INJECTED_SHEETS_READ_FAILURE');
      return state.availabilityRows.filter(predicateFn).map(function(r) { return Object.assign({}, r); });
    },
    updateRowByColumn: function(sheetName, columnName, value, fields) {
      if (sheetName !== 'Availability') throw new Error('UNEXPECTED_SHEET:' + sheetName);
      if (state.updateRowFailure) return false;
      const row = state.availabilityRows.find(function(r) { return r[columnName] === value; });
      if (!row) return false;
      Object.keys(fields).forEach(function(key) {
        if (AVAIL_HEADERS.indexOf(key) !== -1) { row[key] = fields[key]; state.cellWrites += 1; }
      });
      return true;
    },
    getOrCreateSheet: function(name) { if (name !== 'ATTENDANCE_AUDIT' && name !== 'SYSTEM_LOG') throw new Error('UNEXPECTED_SHEET:' + name); },
    getHeaders: function(name) { if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET:' + name); return sandbox.AttendanceAuditRepository.HEADERS.slice(); },
    appendRows: function(name, rows) {
      if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET:' + name);
      if (state.auditAppendFailure) return sandbox.Result.fail('APPEND_FAILED', 'injected audit failure');
      rows.forEach(function(row) { state.auditRows.push(row.slice()); });
      return sandbox.Result.ok({ inserted: rows.length });
    },
    appendRow: function(name, row) { if (name !== 'SYSTEM_LOG') throw new Error('UNEXPECTED_SHEET:' + name); state.logEntries.push(row); }
  };

  sandbox.LockService = { getScriptLock: function() { return {
    waitLock: function() { if (state.lockHeld) throw new Error('LOCK_HELD'); state.lockHeld = true; },
    releaseLock: function() { state.lockHeld = false; }
  }; } };

  sandbox.Calendar = { Events: { get: function(calendarId, eventId) {
    state.identityCalls.push({ calendarId: calendarId, eventId: eventId });
    if (state.identityMode === 'throw') throw new Error('INJECTED_CALENDAR_API_FAILURE');
    if (state.identityMode === 'notFound') return null;
    if (state.identityMode === 'missingIcalUID') return { id: eventId };
    return { id: eventId, iCalUID: Object.prototype.hasOwnProperty.call(state.identityMap, eventId) ? state.identityMap[eventId] : eventId + '@google.com' };
  } } };

  sandbox.CalendarApp = { getCalendarById: function() { return null; }, getDefaultCalendar: function() { return null; } };
  sandbox.PropertiesService = { getScriptProperties: function() { return { getProperty: function(key) { return Object.prototype.hasOwnProperty.call(state.properties, key) ? state.properties[key] : null; } }; } };
  sandbox.Session = { getActiveUser: function() { return { getEmail: function() { return state.sessionEmail; } }; } };
  sandbox.CardService = makeCardService();

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
  load(sandbox, 'AttendanceAddOn.js', 'AttendanceAddOn');

  state.auditHeaders = sandbox.AttendanceAuditRepository.HEADERS.slice();

  function reset() {
    state.availabilityRows = [{ slot_id: SLOT_ID, date: '2026/09/07', time: '09:15', sort_key: '202609070915', status: 'CONFIRMED', is_available: true, patient_name: 'Test Patient', phone: PHONE, calendar_event_id: ICAL_UID, Reminder_sent: '', whatsapp_message_id: '', reserved_until: '', reserved_until_unix: '' }];
    state.auditRows = []; state.logEntries = []; state.nowMs = NOW_MS;
    state.queryReadFailure = false; state.updateRowFailure = false; state.auditAppendFailure = false;
    state.lockHeld = false; state.cellWrites = 0; state.storageReads = 0; state.identityCalls = [];
    state.identityMode = 'success'; state.identityMap = {}; state.sessionEmail = OPERATOR_EMAIL;
    state.properties = { ATTENDANCE_OPERATOR_EMAIL: OPERATOR_EMAIL };
  }
  return { sandbox: sandbox, state: state, reset: reset };
}

const env = createSandbox();
const sandbox = env.sandbox;
const state = env.state;
const Reset = env.reset;

function ctx(overrides) {
  const o = overrides || {};
  return {
    operator: o.operator === undefined ? { operatorId: OPERATOR_EMAIL } : o.operator,
    deployment: o.deployment === undefined ? { trustedOperatorEmail: OPERATOR_EMAIL } : o.deployment,
    calendarEvent: o.calendarEvent === undefined ? { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' } : o.calendarEvent
  };
}
function auditObject(index) {
  const row = state.auditRows[index]; const out = {};
  state.auditHeaders.forEach(function(h, i) { out[h] = row[i]; }); return out;
}
function cardText(card) { return JSON.stringify(card); }
function sectionByHeader(card, header) { return (card.widgets || []).find(function(s) { return s.header === header; }); }

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('M0-ID1 — Calendar API event.id resolves to canonical iCalUID with exact context', function() {
  Reset();
  const result = sandbox.CalendarRepository.resolveAppointmentEventIdentity(EVENT_ID, 'CAL_DEFAULT');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.data, { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT', iCalUID: ICAL_UID });
  assert.deepStrictEqual(state.identityCalls, [{ calendarId: 'CAL_DEFAULT', eventId: EVENT_ID }]);
});

test('M0-ID2 — Add-on event.id alone never equals the stored iCalUID fixture', function() {
  assert.notStrictEqual(EVENT_ID, ICAL_UID);
  assert.strictEqual(ICAL_UID, EVENT_ID + '@google.com');
});

test('M0-ID3 — resolved iCalUID correlates successfully to the stored appointment', function() {
  Reset();
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'COMPLETED');
  assert.strictEqual(result.data.calendarEventId, ICAL_UID);
  assert.strictEqual(result.data.calendarSourceEventId, EVENT_ID);
  assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
  assert.strictEqual(auditObject(0).calendar_event_id, ICAL_UID);
});

test('M0-ID4 — event not found fails closed with no state mutation', function() {
  Reset(); state.identityMode = 'notFound';
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_IDENTITY_RESOLUTION_FAILED');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED'); assert.strictEqual(state.cellWrites, 0); assert.strictEqual(state.auditRows.length, 0);
});

test('M0-ID5 — Calendar API read failure fails closed', function() {
  Reset(); state.identityMode = 'throw';
  const result = sandbox.AttendanceService.markNoShow(ctx());
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_IDENTITY_RESOLUTION_FAILED');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED'); assert.strictEqual(state.cellWrites, 0);
});

test('M0-ID6 — successful Calendar API response without iCalUID fails closed', function() {
  Reset(); state.identityMode = 'missingIcalUID';
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_IDENTITY_RESOLUTION_FAILED');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED'); assert.strictEqual(state.cellWrites, 0);
});

test('M0-ID7 — missing calendar context is rejected before API lookup', function() {
  Reset();
  const result = sandbox.AttendanceService.markCompleted(ctx({ calendarEvent: { eventId: EVENT_ID, calendarId: '' } }));
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'ATTENDANCE_CALENDAR_CONTEXT_INVALID');
  assert.strictEqual(state.identityCalls.length, 0); assert.strictEqual(state.cellWrites, 0);
});

test('M0-ID8 — ambiguous canonical iCalUID correlation remains rejected', function() {
  Reset();
  state.availabilityRows.push(Object.assign({}, state.availabilityRows[0], { slot_id: OTHER_SLOT_ID, phone: OTHER_PHONE, patient_name: 'Other Patient' }));
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_AMBIGUOUS');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED'); assert.strictEqual(state.availabilityRows[1].status, 'CONFIRMED'); assert.strictEqual(state.cellWrites, 0);
});

test('M0-ATT1 — valid API event resolves then MARK_NO_SHOW reaches existing lifecycle', function() {
  Reset(); const result = sandbox.AttendanceService.markNoShow(ctx());
  assert.strictEqual(result.ok, true); assert.strictEqual(result.data.status, 'NO_SHOW'); assert.strictEqual(result.data.calendarEventId, ICAL_UID); assert.strictEqual(state.availabilityRows[0].status, 'NO_SHOW');
});

test('M0-ATT2 — existing transition rules remain authoritative', function() {
  Reset(); sandbox.AttendanceService.markCompleted(ctx()); const beforeWrites = state.cellWrites;
  const result = sandbox.AttendanceService.markNoShow(ctx());
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'INVALID_TRANSITION'); assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED'); assert.strictEqual(state.cellWrites, beforeWrites);
});

test('M0-ATT3 — idempotent duplicate remains a deterministic no-op', function() {
  Reset(); const first = sandbox.AttendanceService.markCompleted(ctx()); const writes = state.cellWrites; const second = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(first.ok, true); assert.strictEqual(second.ok, true); assert.strictEqual(second.data.alreadyApplied, true); assert.strictEqual(state.cellWrites, writes); assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
});

test('M0-ATT4 — correlation loss after fresh read remains fail-closed', function() {
  Reset(); const originalUpdate = sandbox.SlotRepository.atomicUpdate;
  sandbox.SlotRepository.atomicUpdate = function(slotId, decisionFn) { state.availabilityRows[0].calendar_event_id = OTHER_ICAL_UID; return originalUpdate.call(this, slotId, decisionFn); };
  const result = sandbox.AttendanceService.markCompleted(ctx()); sandbox.SlotRepository.atomicUpdate = originalUpdate;
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_CORRELATION_LOST'); assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
});

test('M0-ATT5 — write failure cannot produce false success', function() {
  Reset(); state.updateRowFailure = true; const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'UPDATE_FAILED'); assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
});

test('M0-ATT6 — lock contention preserves existing concurrency boundary', function() {
  Reset(); state.lockHeld = true; const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false); assert.strictEqual(result.error.code, 'LOCK_TIMEOUT'); assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED'); state.lockHeld = false;
});

test('M0-UI1 — card uses the requested Arabic attendance buttons and existing handlers', function() {
  Reset();
  const card = sandbox.onCalendarEventOpen({ calendarEventObject: { calendar: { id: EVENT_ID, calendarId: 'CAL_DEFAULT' } } });
  assert.strictEqual(card.title, 'تسجيل حضور الموعد');
  const decisionSection = sectionByHeader(card, 'تسجيل الحضور'); assert.ok(decisionSection);
  const uiButtons = decisionSection.widgets.filter(function(w) { return w.kind === 'newTextButton'; });
  assert.strictEqual(uiButtons.length, 2); assert.deepStrictEqual(uiButtons.map(function(b) { return b.text; }), ['حضر ✅', 'لم يحضر ❌']);
  assert.deepStrictEqual(uiButtons.map(function(b) { return b.action.functionName; }), ['onMarkCompleted', 'onMarkNoShow']);
});

test('M0-UI2 — operator email is absent from success and failure cards', function() {
  Reset();
  const success = sandbox.onMarkCompleted({ commonEventObject: { parameters: { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' } } });
  assert.strictEqual(cardText(success.navigation.card).indexOf(OPERATOR_EMAIL), -1);

  Reset(); state.identityMode = 'notFound';
  const failure = sandbox.onMarkCompleted({ commonEventObject: { parameters: { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' } } });
  assert.strictEqual(cardText(failure.navigation.card).indexOf(OPERATOR_EMAIL), -1);
});

test('M0-UI3 — failed identity is visibly FAILED and does not look successful', function() {
  Reset(); state.identityMode = 'notFound';
  const response = sandbox.onMarkNoShow({ commonEventObject: { parameters: { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' } } });
  const text = cardText(response.navigation.card);
  assert.ok(text.indexOf('FAILED: ATTENDANCE_EVENT_IDENTITY_RESOLUTION_FAILED') !== -1); assert.strictEqual(text.indexOf('تم تسجيل عدم الحضور بنجاح'), -1); assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
});

test('M0-UI4 — missing event identity renders no decision buttons', function() {
  Reset(); const card = sandbox.onCalendarEventOpen({ commonEventObject: {} }); const decisionSection = sectionByHeader(card, 'تسجيل الحضور');
  const uiButtons = decisionSection.widgets.filter(function(w) { return w.kind === 'newTextButton'; }); assert.strictEqual(uiButtons.length, 0);
});

test('M0-UI5 — UI source preserves internal decision constants and removes operator email rendering', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8'));
  assert.ok(src.indexOf("ATTENDANCE_DECISION_MARK_COMPLETED = 'MARK_COMPLETED'") !== -1);
  assert.ok(src.indexOf("ATTENDANCE_DECISION_MARK_NO_SHOW = 'MARK_NO_SHOW'") !== -1);
  assert.ok(src.indexOf("setOnClickAction(_attendanceAction('onMarkCompleted'") !== -1);
  assert.ok(src.indexOf("setOnClickAction(_attendanceAction('onMarkNoShow'") !== -1);
  assert.strictEqual(src.indexOf("Operator: ' +"), -1);
  assert.strictEqual(src.indexOf("setText('MARK COMPLETED')"), -1);
  assert.strictEqual(src.indexOf("setText('MARK NO-SHOW')"), -1);
});

test('M0-ARCH1 — AttendanceService uses the existing CalendarRepository boundary and no CalendarApp/suffix heuristic', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'Application/AttendanceService.js'), 'utf8'));
  assert.ok(src.indexOf('CalendarRepository.resolveAppointmentEventIdentity') !== -1);
  assert.strictEqual(src.indexOf('CalendarApp'), -1);
  assert.strictEqual(src.indexOf('@google.com'), -1);
});

test('M0-ARCH2 — GoogleCalendar resolver uses Calendar.Events.get without suffix conversion', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'Infrastructure/GoogleCalendar.js'), 'utf8'));
  assert.ok(src.indexOf('Calendar.Events.get') !== -1); assert.strictEqual(src.indexOf("+ '@google.com'"), -1); assert.strictEqual(src.indexOf('getEventById(requestedEventId)'), -1);
});

test('M0-ARCH3 — protected StateMachine and SlotRepository atomic boundary remain present', function() {
  assert.strictEqual(sandbox.StateMachine.resolve('CONFIRMED', 'CompleteAppointment'), 'COMPLETED');
  assert.strictEqual(sandbox.StateMachine.resolve('CONFIRMED', 'MarkNoShow'), 'NO_SHOW');
  assert.ok(fs.readFileSync(path.join(ROOT, 'Repositories/SlotRepository.js'), 'utf8').indexOf('atomicUpdate') !== -1);
});

let failures = 0;
tests.forEach(function(entry) {
  try { entry.fn(); console.log('PASS:', entry.name); }
  catch (error) { failures += 1; console.error('FAIL:', entry.name); console.error(error.stack || error.message); }
});
if (failures > 0) process.exit(1);
console.log('\n' + (tests.length - failures) + '/' + tests.length + ' tests passed');
