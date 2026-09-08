'use strict';

/**
 * HardeningM0CriticalCoverage.test.js
 *
 * Focused companion suite for the M0 Attendance hardening boundary.
 * The existing HardeningM0 suite covers the new identity/UI contract; this
 * companion suite deliberately restores the critical legacy acceptance areas
 * that must remain protected during the identity repair: operator trust,
 * lifecycle rejection/idempotency, lock/atomic persistence failure, exact
 * correlation failure behavior, Calendar identity fail-closed behavior, and
 * manifest/CardService boundaries.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';
const EVENT_ID = 'TEST_EVENT_001';
const ICAL_UID = EVENT_ID + '@google.com';
const OTHER_ICAL_UID = 'OTHER_EVENT_002@google.com';
const SLOT_ID = 'SLT_TEST_001';
const OPERATOR_EMAIL = 'doctor.test@hamzawe.clinic';
const NOW_MS = 1770000000000;

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
    const methods = CARD_SERVICE_CONTRACT[factoryName];
    const state = { kind: factoryName, title: '', header: '', text: '', widgets: [], action: null, parameters: null, navigation: null, stateChanged: null };
    const object = { state: state };
    methods.forEach(function(method) {
      object[method] = function() {
        const args = Array.prototype.slice.call(arguments);
        if (method === 'setHeader') state.header = args[0] && args[0].state ? args[0].state : args[0];
        else if (method === 'addSection' || method === 'addWidget') state.widgets.push(args[0].state);
        else if (method === 'setTitle') state.title = args[0];
        else if (method === 'setSubtitle') state.subtitle = args[0];
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
        return object;
      };
    });
    return object;
  }
  const service = {};
  Object.keys(CARD_SERVICE_CONTRACT).forEach(function(name) {
    service[name] = function() { return makeObject(name); };
  });
  return service;
}

function load(sandbox, relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, { filename: relativePath });
}

function loadAddOn(sandbox) {
  const source = fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8');
  vm.runInContext(source + '\nthis.onCalendarEventOpen = onCalendarEventOpen;\nthis.onMarkCompleted = onMarkCompleted;\nthis.onMarkNoShow = onMarkNoShow;', sandbox, { filename: 'AttendanceAddOn.js' });
}

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    availabilityRows: [],
    auditRows: [],
    logEntries: [],
    nowMs: NOW_MS,
    queryReadFailure: false,
    updateRowFailure: false,
    auditAppendFailure: false,
    lockHeld: false,
    cellWrites: 0,
    storageReads: 0,
    identityCalls: [],
    identityMode: 'success',
    identityMap: {},
    sessionEmail: OPERATOR_EMAIL,
    properties: { ATTENDANCE_OPERATOR_EMAIL: OPERATOR_EMAIL }
  };

  const AVAIL_HEADERS = [
    'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
    'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
    'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
  ];

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
        if (AVAIL_HEADERS.indexOf(key) !== -1) {
          row[key] = fields[key];
          state.cellWrites += 1;
        }
      });
      return true;
    },
    getOrCreateSheet: function(name) {
      if (name !== 'ATTENDANCE_AUDIT' && name !== 'SYSTEM_LOG') throw new Error('UNEXPECTED_SHEET:' + name);
    },
    getHeaders: function(name) {
      if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET:' + name);
      return sandbox.AttendanceAuditRepository.HEADERS.slice();
    },
    appendRows: function(name, rows) {
      if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET:' + name);
      if (state.auditAppendFailure) return sandbox.Result.fail('APPEND_FAILED', 'injected audit failure');
      rows.forEach(function(row) { state.auditRows.push(row.slice()); });
      return sandbox.Result.ok({ inserted: rows.length });
    },
    appendRow: function(name, row) {
      if (name !== 'SYSTEM_LOG') throw new Error('UNEXPECTED_SHEET:' + name);
      state.logEntries.push(row);
    }
  };

  sandbox.LockService = {
    getScriptLock: function() {
      return {
        waitLock: function() {
          if (state.lockHeld) throw new Error('LOCK_HELD');
          state.lockHeld = true;
        },
        releaseLock: function() { state.lockHeld = false; }
      };
    }
  };

  sandbox.Calendar = {
    Events: {
      get: function(calendarId, eventId) {
        state.identityCalls.push({ calendarId: calendarId, eventId: eventId });
        if (state.identityMode === 'throw') throw new Error('INJECTED_CALENDAR_API_FAILURE');
        if (state.identityMode === 'notFound') return null;
        if (state.identityMode === 'missingIcalUID') return { id: eventId };
        if (state.identityMode === 'mismatch') return { id: 'DIFFERENT_ID', iCalUID: ICAL_UID };
        return { id: eventId, iCalUID: Object.prototype.hasOwnProperty.call(state.identityMap, eventId) ? state.identityMap[eventId] : ICAL_UID };
      }
    }
  };
  sandbox.CalendarApp = { getCalendarById: function() { return null; }, getDefaultCalendar: function() { return null; } };
  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(key) { return Object.prototype.hasOwnProperty.call(state.properties, key) ? state.properties[key] : null; }
      };
    }
  };
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
  loadAddOn(sandbox);

  function reset() {
    state.availabilityRows = [{
      slot_id: SLOT_ID,
      date: '2026/09/07',
      time: '09:15',
      sort_key: '202609070915',
      status: 'CONFIRMED',
      is_available: true,
      patient_name: 'Test Patient',
      phone: PHONE,
      calendar_event_id: ICAL_UID,
      Reminder_sent: '',
      whatsapp_message_id: '',
      reserved_until: '',
      reserved_until_unix: ''
    }];
    state.auditRows = [];
    state.logEntries = [];
    state.nowMs = NOW_MS;
    state.queryReadFailure = false;
    state.updateRowFailure = false;
    state.auditAppendFailure = false;
    state.lockHeld = false;
    state.cellWrites = 0;
    state.storageReads = 0;
    state.identityCalls = [];
    state.identityMode = 'success';
    state.identityMap = {};
    state.sessionEmail = OPERATOR_EMAIL;
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

function test(name, fn) { return { name: name, fn: fn }; }

const tests = [
  test('M0-CRIT-01 — anonymous operator rejected before any storage or Calendar read', function() {
    Reset();
    const result = sandbox.AttendanceService.markCompleted(ctx({ operator: null }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_OPERATOR_INVALID');
    assert.strictEqual(state.storageReads, 0);
    assert.strictEqual(state.identityCalls.length, 0);
    assert.strictEqual(state.cellWrites, 0);
  }),

  test('M0-CRIT-02 — unconfigured trust policy is fail-closed before any storage read', function() {
    Reset();
    const result = sandbox.AttendanceService.markCompleted(ctx({ deployment: {} }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_TRUST_POLICY_UNCONFIGURED');
    assert.strictEqual(state.storageReads, 0);
    assert.strictEqual(state.identityCalls.length, 0);
  }),

  test('M0-CRIT-03 — untrusted operator is rejected before Calendar resolution', function() {
    Reset();
    const result = sandbox.AttendanceService.markCompleted(ctx({ operator: { operatorId: 'other@example.com' } }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_OPERATOR_UNAUTHORIZED');
    assert.strictEqual(state.storageReads, 0);
    assert.strictEqual(state.identityCalls.length, 0);
  }),

  test('M0-CRIT-04 — unsupported attendance decision is rejected without side effects', function() {
    Reset();
    const result = sandbox.AttendanceService._applyAttendance('MARK_UNKNOWN', ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_DECISION_INVALID');
    assert.strictEqual(state.storageReads, 0);
    assert.strictEqual(state.identityCalls.length, 0);
    assert.strictEqual(state.cellWrites, 0);
  }),

  test('M0-CRIT-05 — CONFIRMED → COMPLETED is performed through the existing StateMachine path', function() {
    Reset();
    const result = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.status, 'COMPLETED');
    assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
    assert.strictEqual(state.cellWrites > 0, true);
    assert.strictEqual(sandbox.StateMachine.resolve('CONFIRMED', 'CompleteAppointment'), 'COMPLETED');
  }),

  test('M0-CRIT-06 — CONFIRMED → NO_SHOW remains supported', function() {
    Reset();
    const result = sandbox.AttendanceService.markNoShow(ctx());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.status, 'NO_SHOW');
    assert.strictEqual(state.availabilityRows[0].status, 'NO_SHOW');
    assert.strictEqual(sandbox.StateMachine.resolve('CONFIRMED', 'MarkNoShow'), 'NO_SHOW');
  }),

  test('M0-CRIT-07 — terminal COMPLETED → NO_SHOW is rejected and does not write', function() {
    Reset();
    const first = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(first.ok, true);
    const writes = state.cellWrites;
    const result = sandbox.AttendanceService.markNoShow(ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
    assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
    assert.strictEqual(state.cellWrites, writes);
  }),

  test('M0-CRIT-08 — non-CONFIRMED status cannot be promoted to COMPLETED', function() {
    Reset();
    state.availabilityRows[0].status = 'FREE';
    const result = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
    assert.strictEqual(state.availabilityRows[0].status, 'FREE');
    assert.strictEqual(state.cellWrites, 0);
    assert.strictEqual(state.auditRows.length, 1);
  }),

  test('M0-CRIT-09 — duplicate decision is idempotent with no second cell write', function() {
    Reset();
    const first = sandbox.AttendanceService.markCompleted(ctx());
    const writes = state.cellWrites;
    const auditCount = state.auditRows.length;
    const second = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.data.alreadyApplied, true);
    assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
    assert.strictEqual(state.cellWrites, writes);
    assert.strictEqual(state.auditRows.length, auditCount + 1);
  }),

  test('M0-CRIT-10 — ScriptLock contention fails closed as LOCK_TIMEOUT', function() {
    Reset();
    state.lockHeld = true;
    const result = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
    assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
    assert.strictEqual(state.cellWrites, 0);
    state.lockHeld = false;
  }),

  test('M0-CRIT-11 — Availability write failure never yields false success', function() {
    Reset();
    state.updateRowFailure = true;
    const result = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'UPDATE_FAILED');
    assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
    assert.strictEqual(state.cellWrites, 0);
  }),

  test('M0-CRIT-12 — audit append failure is surfaced without falsely changing the slot result', function() {
    Reset();
    state.auditAppendFailure = true;
    const result = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.status, 'COMPLETED');
    assert.strictEqual(result.data.auditRecorded, false);
    assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
  }),

  test('M0-CRIT-13 — authoritative Availability read failure is fail-closed before mutation', function() {
    Reset();
    state.queryReadFailure = true;
    const result = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_CORRELATION_READ_FAILED');
    assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
    assert.strictEqual(state.cellWrites, 0);
    assert.strictEqual(state.auditRows.length, 0);
  }),

  test('M0-CRIT-14 — no canonical correlation is rejected without mutation', function() {
    Reset();
    state.identityMap[EVENT_ID] = 'UNKNOWN_ICAL_UID@google.com';
    const result = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_NOT_CORRELATED');
    assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
    assert.strictEqual(state.cellWrites, 0);
  }),

  test('M0-CRIT-15 — canonical ambiguity is rejected before atomic mutation', function() {
    Reset();
    state.availabilityRows.push(Object.assign({}, state.availabilityRows[0], { slot_id: 'SLT_TEST_002' }));
    const result = sandbox.AttendanceService.markCompleted(ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_AMBIGUOUS');
    assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
    assert.strictEqual(state.availabilityRows[1].status, 'CONFIRMED');
    assert.strictEqual(state.cellWrites, 0);
  }),

  test('M0-CRIT-16 — TOCTOU correlation loss is rejected inside atomicUpdate', function() {
    Reset();
    const original = sandbox.SlotRepository.atomicUpdate;
    sandbox.SlotRepository.atomicUpdate = function(slotId, callback) {
      state.availabilityRows[0].calendar_event_id = OTHER_ICAL_UID;
      return original.call(this, slotId, callback);
    };
    const result = sandbox.AttendanceService.markCompleted(ctx());
    sandbox.SlotRepository.atomicUpdate = original;
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_CORRELATION_LOST');
    assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
    assert.strictEqual(state.cellWrites, 0);
  }),

  test('M0-CRIT-17 — Calendar identity resolver rejects malformed event identity', function() {
    Reset();
    const result = sandbox.CalendarRepository.resolveAppointmentEventIdentity('', 'CAL_DEFAULT');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'CALENDAR_EVENT_IDENTITY_RESOLUTION_FAILED');
    assert.strictEqual(state.identityCalls.length, 0);
  }),

  test('M0-CRIT-18 — Calendar Advanced API failure is fail-closed', function() {
    Reset();
    state.identityMode = 'throw';
    const result = sandbox.AttendanceService.markNoShow(ctx());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_IDENTITY_RESOLUTION_FAILED');
    assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
    assert.strictEqual(state.cellWrites, 0);
  }),

  test('M0-CRIT-19 — Calendar resolver rejects API event-id mismatch', function() {
    Reset();
    state.identityMode = 'mismatch';
    const result = sandbox.CalendarRepository.resolveAppointmentEventIdentity(EVENT_ID, 'CAL_DEFAULT');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'CALENDAR_EVENT_IDENTITY_RESOLUTION_FAILED');
    assert.strictEqual(state.identityCalls.length, 1);
  }),

  test('M0-CRIT-20 — Add-on card preserves exact Arabic buttons and handler mapping', function() {
    Reset();
    const card = sandbox.onCalendarEventOpen({ calendarEventObject: { calendar: { id: EVENT_ID, calendarId: 'CAL_DEFAULT' } } });
    assert.strictEqual(card.header.title, 'تسجيل حضور الموعد');
    const section = (card.widgets || []).find(function(w) { return w.header === 'تسجيل الحضور'; });
    assert.ok(section);
    const buttons = section.widgets.filter(function(w) { return w.kind === 'newTextButton'; });
    assert.deepStrictEqual(buttons.map(function(b) { return b.text; }), ['حضر ✅', 'لم يحضر ❌']);
    assert.deepStrictEqual(buttons.map(function(b) { return b.action.functionName; }), ['onMarkCompleted', 'onMarkNoShow']);
  }),

  test('M0-CRIT-21 — Add-on callback receives operator identity from Session rather than caller-supplied operator data', function() {
    const src = fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8');
    assert.strictEqual(src.indexOf('ATTENDANCE_OPERATOR_EMAIL'), -1);
    assert.ok(src.indexOf('Session.getActiveUser') !== -1);
  }),

  test('M0-CRIT-22 — manifest retains Calendar Add-on and Calendar Advanced Service configuration', function() {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
    assert.ok(manifest.addOns && manifest.addOns.calendar);
    assert.ok(manifest.dependencies && Array.isArray(manifest.dependencies.enabledAdvancedServices));
    assert.ok(manifest.dependencies.enabledAdvancedServices.some(function(service) { return service.userSymbol === 'Calendar'; }));
  }),

  test('M0-CRIT-23 — protected StateMachine/atomic repository boundaries remain structurally present', function() {
    const stateMachineSrc = fs.readFileSync(path.join(ROOT, 'StateMachine.js'), 'utf8');
    const slotRepoSrc = fs.readFileSync(path.join(ROOT, 'Repositories/SlotRepository.js'), 'utf8');
    assert.ok(stateMachineSrc.indexOf("'CONFIRMED'") !== -1);
    assert.ok(stateMachineSrc.indexOf('CompleteAppointment') !== -1);
    assert.ok(stateMachineSrc.indexOf('MarkNoShow') !== -1);
    assert.ok(slotRepoSrc.indexOf('atomicUpdate') !== -1);
  })
];

let failures = 0;
tests.forEach(function(entry) {
  try {
    Reset();
    entry.fn();
    console.log('PASS:', entry.name);
  } catch (error) {
    failures += 1;
    console.error('FAIL:', entry.name);
    console.error(error.stack || error.message);
  }
});

if (failures > 0) process.exit(1);
console.log('\n' + (tests.length - failures) + '/' + tests.length + ' tests passed');
