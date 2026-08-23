'use strict';

/**
 * HardeningM0.test.js — M0 Attendance Capture Foundation (REMEDIATED)
 *
 * Proves the M0 contract:
 *   A — CONFIRMED → COMPLETED (MARK_COMPLETED)
 *   B — CONFIRMED → NO_SHOW (MARK_NO_SHOW)
 *   C — invalid transitions rejected (FREE/RESERVED/NO_SHOW → COMPLETED,
 *       COMPLETED → NO_SHOW) + StateMachine table unchanged
 *   D — idempotent duplicates (deterministic no-op, no second record)
 *   E — concurrency: conflicting decisions cannot both win
 *   F — operator trust boundary: anonymous / unconfigured policy /
 *       untrusted identity rejected before any storage read; authority
 *       DERIVED by the service (never claimed by the caller)
 *   G — event correlation failure (unknown / ambiguous / invalid context /
 *       read failure) — no availability mutation
 *   H — persistence failure never produces a false COMPLETED / NO_SHOW
 *   I — Calendar Add-on callback (REAL-API-contract CardService, verified
 *       event-object shapes, trusted operator context, result display)
 *   MANIFEST — appsscript.json declares the verified Calendar Add-on
 *   M1 — activation boundary + PENDING ATTENDANCE derivation
 *   J — regression (B1–B6) executed separately against the same tree
 *
 * EVIDENCE CLASSIFICATION (M0 remediation — inherited PoC vs verified):
 *   - The CardService API contract below was VERIFIED against the official
 *     Apps Script reference (see CARD_SERVICE_CONTRACT sources). The mock
 *     implements ONLY that verified surface and THROWS on any other call —
 *     a mock cannot mask a non-existent production API.
 *   - The event-object structure e.calendarEventObject.calendar.{id,
 *     calendarId} and e.commonEventObject.parameters were VERIFIED against
 *     the official Workspace add-on event-object reference.
 *   - The LEGACY event shape (e.selectedEvent / e.calendar / top-level
 *     e.id / e.calendarId) is INHERITED PoC evidence (handed off from
 *     another engineer; not executed by this developer). It is supported
 *     as a documented fallback and tested as such — NOT claimed as
 *     self-proven live behavior.
 *   - Live Google Calendar execution (real deployment) is a separate
 *     owner-executed step; see the PR remediation report.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';
const OTHER_PHONE = '9647002222222';
const NOW_MS = 1770000000000;
const SLOT_ID = 'SLT_TEST_001';
const EVENT_ID = 'TEST_EVENT_001';
const OTHER_SLOT_ID = 'SLT_TEST_002';
const OTHER_EVENT_ID = 'TEST_EVENT_002';
const OPERATOR_EMAIL = 'doctor.test@hamzawe.clinic';
const OTHER_ACCOUNT_EMAIL = 'stranger.test@hamzawe.clinic';

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ═══════════════════════════════════════════════════════════════
// VERIFIED CardService contract (M0 remediation)
// ═══════════════════════════════════════════════════════════════
// Every factory and builder method below was verified against the
// OFFICIAL Apps Script reference at remediation time:
//   - developers.google.com/apps-script/reference/card-service
//     (CardService factories, ActionResponseBuilder, CardBuilder,
//      CardSection, TextParagraph, TextButton)
//   - developers.google.com/apps-script/reference/card-service/action
//     (Action: setFunctionName, setParameters, addRequiredWidget, ...)
//   - developers.google.com/workspace/add-ons/calendar/calendar-actions
//     (official Calendar add-on example: newTextButton().setText().
//      setOnClickAction(newAction().setFunctionName().setParameters()))
// The mock implements ONLY this surface. Any production call to a method
// outside it THROWS → the test fails. A mock therefore cannot pass a test
// for an API that does not exist in the real service.
const CARD_SERVICE_CONTRACT = {
  newCardBuilder: {
    state: 'cardBuilder',
    methods: ['setHeader', 'addSection', 'addWidget', 'build']
  },
  newCardHeader: {
    state: 'cardHeader',
    methods: ['setTitle', 'setSubtitle']
  },
  newCardSection: {
    state: 'cardSection',
    methods: ['setHeader', 'addWidget']
  },
  newTextParagraph: {
    state: 'textParagraph',
    methods: ['setText', 'setMaxLines']
  },
  newTextButton: {
    state: 'textButton',
    methods: ['setText', 'setOnClickAction', 'setDisabled']
  },
  newAction: {
    state: 'action',
    methods: ['setFunctionName', 'setParameters', 'addRequiredWidget', 'setAllWidgetsAreRequired']
  },
  newNavigation: {
    state: 'navigation',
    methods: ['updateCard', 'pushCard', 'popCard', 'popToRoot']
  },
  newActionResponseBuilder: {
    state: 'actionResponseBuilder',
    methods: ['setNavigation', 'setNotification', 'setOpenLink', 'setStateChanged', 'build']
  }
};

/**
 * Contract-faithful CardService mock. Validates every call against
 * CARD_SERVICE_CONTRACT and records structure for assertions.
 */
function makeContractCardService() {
  function makeObject(factoryName) {
    const spec = CARD_SERVICE_CONTRACT[factoryName];
    if (!spec) {
      throw new Error('CARD_SERVICE_CONTRACT_VIOLATION: CardService.' + factoryName + ' is not a verified real API');
    }
    const state = { factory: factoryName, kind: spec.state, title: '', subtitle: '', header: '', widgets: [], text: '', action: null, parameters: null, functionName: '', card: null, navigation: null, stateChanged: null, built: null };
    const object = { state: state };
    spec.methods.forEach(function(method) {
      object[method] = function() {
        const args = Array.prototype.slice.call(arguments);
        switch (method) {
          case 'setHeader': state.header = (args[0] && args[0].state) ? args[0].state : args[0]; break;
          case 'addSection': state.widgets.push(args[0].state); break;
          case 'addWidget': state.widgets.push(args[0].state); break;
          case 'setTitle': state.title = args[0]; break;
          case 'setSubtitle': state.subtitle = args[0]; break;
          case 'setText': state.text = args[0]; break;
          case 'setOnClickAction': state.action = args[0].state; break;
          case 'setFunctionName': state.functionName = args[0]; break;
          case 'setParameters': state.parameters = args[0]; break;
          case 'updateCard': state.card = args[0]; break;
          case 'pushCard': state.card = args[0]; break;
          case 'setNavigation': state.navigation = args[0].state; break;
          case 'setNotification': state.navigation = null; break;
          case 'setStateChanged': state.stateChanged = args[0]; break;
          case 'setDisabled': break;
          case 'build':
            state.built = { kind: spec.state, title: state.title, header: state.header, widgets: state.widgets, navigation: state.navigation, stateChanged: state.stateChanged };
            return state.built;
        }
        return object;
      };
    });
    return object;
  }

  const service = {};
  Object.keys(CARD_SERVICE_CONTRACT).forEach(function(factoryName) {
    service[factoryName] = function() {
      // The real factories take no arguments for this contract.
      if (arguments.length > 0) {
        throw new Error('CARD_SERVICE_CONTRACT_VIOLATION: CardService.' + factoryName + ' does not take arguments in the verified API');
      }
      return makeObject(factoryName);
    };
  });
  return service;
}

/**
 * Builds the vm sandbox with the real production M0 stack:
 *   Result, Config, StateMachine, Validators, Lock, SlotRepository,
 *   AttendanceAuditRepository, LogRepository, AttendanceService
 * with deterministic in-memory GoogleSheets/LockService/Clock seams.
 */
function createCoreSandbox() {
  const sandbox = vm.createContext({ console: console });

  function load(relativePath, globalName) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, {
      filename: relativePath
    });
  }

  const state = {
    nowMs: NOW_MS,
    availabilityRows: [],
    auditRows: [],
    logEntries: [],
    auditAppendFailure: false,
    updateRowFailure: false,
    queryReadFailure: false,
    missingUnderLock: null,
    interleaveHook: null,
    storageReads: 0,
    cellWrites: 0,
    lockHeld: false,
    sessionEmail: OPERATOR_EMAIL,
    properties: {},
    loggerLines: []
  };

  sandbox.Clock = { now: function() { return new Date(state.nowMs); } };
  sandbox.ULID = { generate: function() { return 'M0_ULID'; } };

  const AVAILABILITY_HEADERS = [
    'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
    'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
    'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
  ];

  // ── GoogleSheets seam (in-memory, faithful to the production API surface) ──
  sandbox.GoogleSheets = {
    findRowByColumn: function(sheetName, columnName, value) {
      if (sheetName !== 'Availability') throw new Error('UNEXPECTED_SHEET:' + sheetName);
      state.storageReads += 1;
      if (state.missingUnderLock && columnName === 'slot_id' && value === state.missingUnderLock) {
        return null;
      }
      const found = state.availabilityRows.find(function(r) { return r[columnName] === value; });
      return found ? Object.assign({}, found) : null;
    },
    queryRows: function(sheetName, predicateFn) {
      if (sheetName !== 'Availability') throw new Error('UNEXPECTED_SHEET:' + sheetName);
      state.storageReads += 1;
      if (state.queryReadFailure) throw new Error('INJECTED_SHEETS_READ_FAILURE');
      return state.availabilityRows
        .filter(predicateFn)
        .map(function(r) { return Object.assign({}, r); });
    },
    updateRowByColumn: function(sheetName, columnName, value, fields) {
      if (sheetName !== 'Availability') throw new Error('UNEXPECTED_SHEET:' + sheetName);
      if (state.updateRowFailure) return false;
      const row = state.availabilityRows.find(function(r) { return r[columnName] === value; });
      if (!row) return false;
      Object.keys(fields).forEach(function(key) {
        if (AVAILABILITY_HEADERS.indexOf(key) !== -1) {
          row[key] = fields[key];
          state.cellWrites += 1;
        }
      });
      // Interleave point: A's write is committed but A still holds the
      // ScriptLock. A concurrent B started here observes the real lock.
      if (state.interleaveHook) {
        const hook = state.interleaveHook;
        state.interleaveHook = null;
        hook();
      }
      return true;
    },
    getOrCreateSheet: function(name) {
      if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET:' + name);
    },
    getHeaders: function(name) {
      if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET:' + name);
      return sandbox.AttendanceAuditRepository.HEADERS.slice();
    },
    appendRows: function(name, rows) {
      if (name !== 'ATTENDANCE_AUDIT') throw new Error('UNEXPECTED_SHEET:' + name);
      if (state.auditAppendFailure) {
        return sandbox.Result.fail('APPEND_FAILED', 'injected audit append failure');
      }
      rows.forEach(function(row) { state.auditRows.push(row.slice()); });
      return sandbox.Result.ok({ inserted: rows.length });
    },
    appendRow: function(name, entry) {
      if (name !== 'SYSTEM_LOG') throw new Error('UNEXPECTED_SHEET:' + name);
      state.logEntries.push(entry);
    }
  };

  // ── LockService seam: real mutual exclusion (second waitLock throws) ──
  sandbox.LockService = {
    getScriptLock: function() {
      return {
        waitLock: function(timeoutMs) {
          if (state.lockHeld) throw new Error('LOCK_HELD');
          state.lockHeld = true;
        },
        releaseLock: function() { state.lockHeld = false; }
      };
    }
  };

  // ── Logger seam (add-on diagnostic mode dumps the event-object shape) ──
  sandbox.Logger = { log: function(line) { state.loggerLines.push(String(line)); } };

  // ── PropertiesService seam (add-on surface reads the deployment policy) ──
  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(key) {
          return Object.prototype.hasOwnProperty.call(state.properties, key) ? state.properties[key] : null;
        },
        setProperty: function(key, value) { state.properties[key] = value; },
        deleteProperty: function(key) { delete state.properties[key]; }
      };
    }
  };

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('StateMachine.js', 'StateMachine');
  load('Domain/Validators.js', 'Validators');
  load('Infrastructure/Lock.js', 'Lock');
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('Repositories/AttendanceAuditRepository.js', 'AttendanceAuditRepository');
  load('LogRepository.js', 'LogRepository');
  load('Application/AttendanceService.js', 'AttendanceService');

  state.auditHeaders = sandbox.AttendanceAuditRepository.HEADERS.slice();

  function makeSlot(id, status, phone, eventId) {
    return {
      slot_id: id,
      date: '2026/08/24',
      time: '16:00',
      sort_key: '202608241600',
      status: status,
      is_available: true,
      patient_name: phone ? 'Test Patient' : '',
      phone: phone || '',
      calendar_event_id: eventId || '',
      Reminder_sent: '',
      whatsapp_message_id: '',
      reserved_until: '',
      reserved_until_unix: ''
    };
  }

  function reset() {
    state.nowMs = NOW_MS;
    state.availabilityRows = [makeSlot(SLOT_ID, 'CONFIRMED', PHONE, EVENT_ID)];
    state.auditRows = [];
    state.logEntries = [];
    state.auditAppendFailure = false;
    state.updateRowFailure = false;
    state.queryReadFailure = false;
    state.missingUnderLock = null;
    state.interleaveHook = null;
    state.storageReads = 0;
    state.cellWrites = 0;
    state.lockHeld = false;
    state.properties = { ATTENDANCE_OPERATOR_EMAIL: OPERATOR_EMAIL };
    state.loggerLines = [];
  }

  return { sandbox: sandbox, state: state, makeSlot: makeSlot, reset: reset };
}

/** Core stack (tests A–H, MANIFEST, M1-readiness, structural) */
const core = createCoreSandbox();
const sandbox = core.sandbox;
const state = core.state;
const Reset = core.reset;
const makeSlot = core.makeSlot;

function auditObject(index) {
  const row = state.auditRows[index];
  const obj = {};
  state.auditHeaders.forEach(function(h, i) { obj[h] = row[i]; });
  return obj;
}
function outcomeCount(outcome) {
  const idx = state.auditHeaders.indexOf('outcome');
  return state.auditRows.filter(function(r) { return r[idx] === outcome; }).length;
}
function ctx(overrides) {
  const o = overrides || {};
  return {
    operator: o.operator === undefined ? { operatorId: OPERATOR_EMAIL } : o.operator,
    deployment: o.deployment === undefined ? { trustedOperatorEmail: OPERATOR_EMAIL } : o.deployment,
    calendarEvent: o.calendarEvent === undefined
      ? { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' }
      : o.calendarEvent
  };
}

/**
 * Add-on stack (test I): same production stack + contract CardService +
 * Session + the real AttendanceAddOn.js source.
 */
function createAddOnSandbox() {
  const c = createCoreSandbox();
  const s = c.sandbox;

  const cardService = makeContractCardService();
  s.CardService = cardService;

  s.Session = {
    getActiveUser: function() {
      return {
        getEmail: function() {
          if (!c.state.sessionEmail) throw new Error('SESSION_EMAIL_UNAVAILABLE');
          return c.state.sessionEmail;
        }
      };
    }
  };

  const addOnSource = fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8');
  vm.runInContext(
    addOnSource +
    '\nthis.onCalendarEventOpen = onCalendarEventOpen;' +
    '\nthis.onMarkCompleted = onMarkCompleted;' +
    '\nthis.onMarkNoShow = onMarkNoShow;',
    s,
    { filename: 'AttendanceAddOn.js' }
  );

  return { core: c, cardService: cardService };
}

/**
 * Verified CURRENT event-object shape (official Workspace add-on
 * event-object reference): the Calendar event object carries the metadata
 * fields calendar.id (event ID) and calendar.calendarId (calendar ID).
 */
function currentEventObject(eventId, calendarId) {
  return {
    commonEventObject: { platform: 'WEB', hostApp: 'CALENDAR', parameters: {} },
    calendarEventObject: {
      calendar: { id: eventId, calendarId: calendarId }
    }
  };
}

/**
 * INHERITED PoC evidence shape (handed off from another engineer; older
 * add-on runtime). Supported as a documented fallback — NOT self-proven.
 */
function legacyEventObject(eventId, calendarId) {
  return {
    id: eventId,
    calendarId: calendarId,
    calendar: { id: calendarId },
    selectedEvent: {
      id: eventId,
      title: 'TEST APPOINTMENT',
      startDate: new Date(NOW_MS)
    }
  };
}

/** Verified CURRENT action-parameters shape: e.commonEventObject.parameters */
function currentActionEvent(params) {
  return { action: { name: 'ATTENDANCE' }, commonEventObject: { parameters: params || {} } };
}

/** Deprecated (documented) top-level fallback shape: e.parameters */
function legacyActionEvent(params) {
  return { action: { name: 'ATTENDANCE' }, parameters: params || {} };
}

function cardText(card) {
  return JSON.stringify(card);
}
function sectionsOf(builtCard) {
  return builtCard.widgets; // cardBuilder state stores sections in widgets
}
function buttonsInSection(section) {
  return (section.widgets || []).filter(function(w) { return w.kind === 'textButton'; });
}
function sectionHeaderOf(section) {
  return section.header;
}
function responseCard(actionResponse) {
  return actionResponse.navigation ? actionResponse.navigation.card : null;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ── A — Normal Completion ─────────────────────────────────────

test('M0-A — CONFIRMED → MARK_COMPLETED → COMPLETED with derived authority + full audit', function() {
  Reset();
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.applied, true);
  assert.strictEqual(result.data.alreadyApplied, false);
  assert.strictEqual(result.data.decision, 'MARK_COMPLETED');
  assert.strictEqual(result.data.status, 'COMPLETED');
  assert.strictEqual(result.data.fromStatus, 'CONFIRMED');
  assert.strictEqual(result.data.slotId, SLOT_ID);
  assert.strictEqual(result.data.operatorId, OPERATOR_EMAIL);
  assert.strictEqual(result.data.authorizedAs, 'DOCTOR');
  assert.strictEqual(result.data.calendarEventId, EVENT_ID);
  assert.strictEqual(result.data.calendarId, 'CAL_DEFAULT');
  assert.strictEqual(result.data.auditRecorded, true);

  assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
  assert.strictEqual(state.availabilityRows[0].phone, PHONE);

  assert.strictEqual(state.auditRows.length, 1);
  const a = auditObject(0);
  assert.strictEqual(a.operator_id, OPERATOR_EMAIL);
  assert.strictEqual(a.calendar_event_id, EVENT_ID);
  assert.strictEqual(a.calendar_id, 'CAL_DEFAULT');
  assert.strictEqual(a.slot_id, SLOT_ID);
  assert.strictEqual(a.decision, 'MARK_COMPLETED');
  assert.strictEqual(a.from_status, 'CONFIRMED');
  assert.strictEqual(a.to_status, 'COMPLETED');
  assert.strictEqual(a.outcome, 'APPLIED');
  assert.strictEqual(a.error_code, '');
  assert.ok(a.timestamp instanceof Date);

  // observability: diagnostic log with operation/identities/result
  assert.strictEqual(state.logEntries.length, 1);
  assert.strictEqual(state.logEntries[0].command, 'ATTENDANCE_MARK_COMPLETED');
  assert.strictEqual(state.logEntries[0].success, true);
  assert.strictEqual(state.logEntries[0].slotId, SLOT_ID);
  const details = JSON.parse(state.logEntries[0].error);
  assert.strictEqual(details.operatorId, OPERATOR_EMAIL);
  assert.strictEqual(details.calendarEventId, EVENT_ID);
  assert.strictEqual(details.outcome, 'APPLIED');
});

// ── B — Normal No-show ────────────────────────────────────────

test('M0-B — CONFIRMED → MARK_NO_SHOW → NO_SHOW with full audit record', function() {
  Reset();
  const result = sandbox.AttendanceService.markNoShow(ctx());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.applied, true);
  assert.strictEqual(result.data.decision, 'MARK_NO_SHOW');
  assert.strictEqual(result.data.status, 'NO_SHOW');
  assert.strictEqual(result.data.authorizedAs, 'DOCTOR');
  assert.strictEqual(result.data.slotId, SLOT_ID);
  assert.strictEqual(state.availabilityRows[0].status, 'NO_SHOW');
  assert.strictEqual(state.auditRows.length, 1);
  const a = auditObject(0);
  assert.strictEqual(a.decision, 'MARK_NO_SHOW');
  assert.strictEqual(a.from_status, 'CONFIRMED');
  assert.strictEqual(a.to_status, 'NO_SHOW');
  assert.strictEqual(a.outcome, 'APPLIED');
  assert.strictEqual(state.logEntries[0].command, 'ATTENDANCE_MARK_NO_SHOW');
});

// ── C — Invalid state transitions ─────────────────────────────

test('M0-C1 — FREE slot (carrying an event id) → MARK_COMPLETED rejected, row untouched', function() {
  Reset();
  state.availabilityRows[0].status = 'FREE';
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
  assert.strictEqual(result.error.details.fromStatus, 'FREE');
  assert.strictEqual(state.availabilityRows[0].status, 'FREE');
  assert.strictEqual(state.auditRows.length, 1);
  assert.strictEqual(auditObject(0).outcome, 'REJECTED_INVALID_TRANSITION');
  assert.strictEqual(auditObject(0).from_status, 'FREE');
  assert.strictEqual(auditObject(0).to_status, '');
  assert.strictEqual(auditObject(0).error_code, 'INVALID_TRANSITION');
});

test('M0-C2 — RESERVED slot → MARK_COMPLETED rejected, row untouched', function() {
  Reset();
  state.availabilityRows[0].status = 'RESERVED';
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
  assert.strictEqual(state.availabilityRows[0].status, 'RESERVED');
  assert.strictEqual(auditObject(0).outcome, 'REJECTED_INVALID_TRANSITION');
});

test('M0-C3 — NO_SHOW slot → MARK_COMPLETED rejected (no resurrection)', function() {
  Reset();
  state.availabilityRows[0].status = 'NO_SHOW';
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
  assert.strictEqual(state.availabilityRows[0].status, 'NO_SHOW');
  assert.strictEqual(outcomeCount('APPLIED'), 0);
});

test('M0-C4 — COMPLETED slot → MARK_NO_SHOW rejected (conflicting terminal decision)', function() {
  Reset();
  state.availabilityRows[0].status = 'COMPLETED';
  const result = sandbox.AttendanceService.markNoShow(ctx());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
  assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
  assert.strictEqual(outcomeCount('APPLIED'), 0);
});

test('M0-C5 — structural: StateMachine table is unchanged and complete for M0', function() {
  const sm = sandbox.StateMachine;
  ['FREE', 'RESERVED', 'CANCELLED', 'COMPLETED', 'NO_SHOW', 'EXPIRED'].forEach(function(s) {
    assert.strictEqual(sm.resolve(s, 'CompleteAppointment'), null, s + ' → COMPLETED must not exist');
    assert.strictEqual(sm.resolve(s, 'MarkNoShow'), null, s + ' → NO_SHOW must not exist');
  });
  assert.strictEqual(sm.resolve('CONFIRMED', 'CompleteAppointment'), 'COMPLETED');
  assert.strictEqual(sm.resolve('CONFIRMED', 'MarkNoShow'), 'NO_SHOW');
  assert.deepStrictEqual(Object.keys(sm.transitions.COMPLETED), []);
  assert.deepStrictEqual(Object.keys(sm.transitions.NO_SHOW), []);
  assert.deepStrictEqual(
    Object.keys(sm.transitions).sort(),
    ['CANCELLED', 'COMPLETED', 'CONFIRMED', 'EXPIRED', 'FREE', 'NO_SHOW', 'RESERVED']
  );
});

// ── D — Idempotency ───────────────────────────────────────────

test('M0-D1 — duplicate MARK_COMPLETED is a deterministic no-op (no second record, no write)', function() {
  Reset();
  const first = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(first.data.applied, true);
  const writesAfterFirst = state.cellWrites;
  assert.strictEqual(writesAfterFirst, 1);

  const second = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.data.applied, false);
  assert.strictEqual(second.data.alreadyApplied, true);
  assert.strictEqual(second.data.status, 'COMPLETED');
  assert.strictEqual(second.data.auditRecorded, true);

  const third = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(third.ok, true);
  assert.strictEqual(third.data.alreadyApplied, true);

  // no duplicate cell write, no corruption
  assert.strictEqual(state.cellWrites, writesAfterFirst);
  assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');

  // no second attendance record pretending to be a new completion
  assert.strictEqual(outcomeCount('APPLIED'), 1);
  assert.strictEqual(outcomeCount('ALREADY_APPLIED'), 2);
  assert.strictEqual(state.auditRows.length, 3);
  assert.strictEqual(auditObject(1).outcome, 'ALREADY_APPLIED');
  assert.strictEqual(auditObject(1).to_status, 'COMPLETED');
});

test('M0-D2 — duplicate MARK_NO_SHOW is a deterministic no-op', function() {
  Reset();
  const first = sandbox.AttendanceService.markNoShow(ctx());
  assert.strictEqual(first.data.applied, true);
  const writesAfterFirst = state.cellWrites;
  const second = sandbox.AttendanceService.markNoShow(ctx());
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.data.alreadyApplied, true);
  assert.strictEqual(state.cellWrites, writesAfterFirst);
  assert.strictEqual(state.availabilityRows[0].status, 'NO_SHOW');
  assert.strictEqual(outcomeCount('APPLIED'), 1);
  assert.strictEqual(outcomeCount('ALREADY_APPLIED'), 1);
});

// ── E — Concurrency ───────────────────────────────────────────

test('M0-E1 — interleaved MARK_NO_SHOW while MARK_COMPLETED holds the lock: exactly one wins', function() {
  Reset();
  let bResult;
  state.interleaveHook = function() {
    // B starts while A still holds the ScriptLock (mid-write commit point)
    bResult = sandbox.AttendanceService.markNoShow(ctx());
  };
  const aResult = sandbox.AttendanceService.markCompleted(ctx());

  assert.strictEqual(aResult.ok, true);
  assert.strictEqual(aResult.data.applied, true);
  assert.strictEqual(bResult.ok, false);
  assert.strictEqual(bResult.error.code, 'LOCK_TIMEOUT');

  // exactly one terminal outcome, no last-writer-wins
  assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
  assert.strictEqual(outcomeCount('APPLIED'), 1);
  assert.strictEqual(auditObject(0).decision, 'MARK_COMPLETED');
  assert.strictEqual(state.lockHeld, false); // lock released on both paths
});

test('M0-E2 — stale read: B observed CONFIRMED, A wins, B re-reads fresh state and fails deterministically', function() {
  Reset();
  // B reads current state (stale observation: CONFIRMED)
  const bObserved = sandbox.SlotRepository.findById(SLOT_ID);
  assert.strictEqual(bObserved.status, 'CONFIRMED');

  // A wins
  const aResult = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(aResult.ok, true);
  assert.strictEqual(aResult.data.applied, true);

  // B now executes its full attempt — the fresh re-read under the lock sees COMPLETED
  const bResult = sandbox.AttendanceService.markNoShow(ctx());
  assert.strictEqual(bResult.ok, false);
  assert.strictEqual(bResult.error.code, 'INVALID_TRANSITION');
  assert.strictEqual(bResult.error.details.fromStatus, 'COMPLETED');

  assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
  assert.strictEqual(outcomeCount('APPLIED'), 1);
  assert.strictEqual(state.auditRows.length, 2);
  assert.strictEqual(auditObject(1).outcome, 'REJECTED_INVALID_TRANSITION');
  assert.strictEqual(auditObject(1).decision, 'MARK_NO_SHOW');
});

// ── F — Operator trust boundary ───────────────────────────────

test('M0-F1 — untrusted/missing operator inputs fail before any storage access', function() {
  const cases = [
    ['missing context', undefined, 'ATTENDANCE_CONTEXT_INVALID'],
    ['missing operator', { operator: null, deployment: { trustedOperatorEmail: OPERATOR_EMAIL }, calendarEvent: { eventId: EVENT_ID } }, 'ATTENDANCE_OPERATOR_INVALID'],
    ['empty operatorId', { operator: { operatorId: '   ' }, deployment: { trustedOperatorEmail: OPERATOR_EMAIL }, calendarEvent: { eventId: EVENT_ID } }, 'ATTENDANCE_OPERATOR_INVALID'],
    ['non-string operatorId', { operator: { operatorId: 42 }, deployment: { trustedOperatorEmail: OPERATOR_EMAIL }, calendarEvent: { eventId: EVENT_ID } }, 'ATTENDANCE_OPERATOR_INVALID']
  ];
  cases.forEach(function(c) {
    Reset();
    const result = c[1] === undefined
      ? sandbox.AttendanceService.markCompleted(undefined)
      : sandbox.AttendanceService.markNoShow(c[1]);
    assert.strictEqual(result.ok, false, c[0]);
    assert.strictEqual(result.error.code, c[2], c[0]);
    // zero side effects: no storage read, no audit row, no state change
    assert.strictEqual(state.storageReads, 0, c[0] + ' must not touch storage');
    assert.strictEqual(state.auditRows.length, 0, c[0]);
    assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED', c[0]);
    assert.strictEqual(state.cellWrites, 0, c[0]);
  });
});

test('M0-F2 — unconfigured trust policy disables attendance capture explicitly', function() {
  Reset();
  const missingDeployment = sandbox.AttendanceService.markCompleted(ctx({ deployment: null }));
  assert.strictEqual(missingDeployment.ok, false);
  assert.strictEqual(missingDeployment.error.code, 'ATTENDANCE_TRUST_POLICY_UNCONFIGURED');
  assert.strictEqual(state.storageReads, 0);
  assert.strictEqual(state.auditRows.length, 0);
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');

  Reset();
  const nullDeployment = sandbox.AttendanceService.markCompleted(ctx({
    operator: { operatorId: OPERATOR_EMAIL },
    deployment: null,
    calendarEvent: { eventId: EVENT_ID }
  }));
  assert.strictEqual(nullDeployment.ok, false);
  assert.strictEqual(nullDeployment.error.code, 'ATTENDANCE_TRUST_POLICY_UNCONFIGURED');
  const emptyPolicy = sandbox.AttendanceService.markCompleted(ctx({ deployment: { trustedOperatorEmail: '  ' } }));
  assert.strictEqual(emptyPolicy.ok, false);
  assert.strictEqual(emptyPolicy.error.code, 'ATTENDANCE_TRUST_POLICY_UNCONFIGURED');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
});

test('M0-F3 — identity present but not the configured trusted operator → UNAUTHORIZED (no authority claim possible)', function() {
  Reset();
  const stranger = sandbox.AttendanceService.markCompleted(ctx({
    operator: { operatorId: OTHER_ACCOUNT_EMAIL },
    deployment: { trustedOperatorEmail: OPERATOR_EMAIL }
  }));
  assert.strictEqual(stranger.ok, false);
  assert.strictEqual(stranger.error.code, 'ATTENDANCE_OPERATOR_UNAUTHORIZED');
  assert.strictEqual(state.storageReads, 0);
  assert.strictEqual(state.auditRows.length, 0);
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');

  // and a caller cannot "claim" DOCTOR: the envelope has no authority
  // field; only the service derivation grants it.
  Reset();
  const claimed = sandbox.AttendanceService.markCompleted(ctx({
    operator: { operatorId: OTHER_ACCOUNT_EMAIL, authorityType: 'DOCTOR' },
    deployment: { trustedOperatorEmail: OPERATOR_EMAIL }
  }));
  assert.strictEqual(claimed.ok, false);
  assert.strictEqual(claimed.error.code, 'ATTENDANCE_OPERATOR_UNAUTHORIZED');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
});

test('M0-F4 — trusted identity + configured policy → authority DERIVED (recorded in result)', function() {
  Reset();
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.operatorId, OPERATOR_EMAIL);
  assert.strictEqual(result.data.authorizedAs, 'DOCTOR');
  assert.strictEqual(result.data.applied, true);
});

// ── G — Event correlation failures ────────────────────────────

test('M0-G1 — unknown calendar event fails with no availability mutation', function() {
  Reset();
  const result = sandbox.AttendanceService.markCompleted(ctx({
    calendarEvent: { eventId: 'UNKNOWN_EVENT', calendarId: 'CAL_DEFAULT' }
  }));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_NOT_CORRELATED');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
  assert.strictEqual(state.auditRows.length, 0);
  assert.strictEqual(state.cellWrites, 0);
});

test('M0-G2 — ambiguous correlation (two slots, one event) fails with no mutation', function() {
  Reset();
  state.availabilityRows.push(makeSlot(OTHER_SLOT_ID, 'CONFIRMED', OTHER_PHONE, EVENT_ID));
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'ATTENDANCE_EVENT_AMBIGUOUS');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
  assert.strictEqual(state.availabilityRows[1].status, 'CONFIRMED');
  assert.strictEqual(state.auditRows.length, 0);
  assert.strictEqual(state.cellWrites, 0);
});

test('M0-G3 — invalid event context and correlation read failure fail safely', function() {
  Reset();
  const r1 = sandbox.AttendanceService.markNoShow(ctx({ calendarEvent: {} }));
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.error.code, 'ATTENDANCE_EVENT_CONTEXT_INVALID');

  Reset();
  const r2 = sandbox.AttendanceService.markNoShow(ctx({ calendarEvent: null }));
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.error.code, 'ATTENDANCE_EVENT_CONTEXT_INVALID');

  Reset();
  state.queryReadFailure = true;
  const r3 = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.error.code, 'ATTENDANCE_CORRELATION_READ_FAILED');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED');
  assert.strictEqual(state.auditRows.length, 0);
});

// ── H — Persistence failure ───────────────────────────────────

test('M0-H1 — write failure produces no false COMPLETED and no false audit record', function() {
  Reset();
  state.updateRowFailure = true;
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'UPDATE_FAILED');
  assert.strictEqual(state.availabilityRows[0].status, 'CONFIRMED'); // unchanged
  assert.strictEqual(state.auditRows.length, 0); // no false attendance record
  assert.strictEqual(outcomeCount('APPLIED'), 0);
});

test('M0-H2 — slot missing under the lock fails with SLOT_NOT_FOUND, no audit', function() {
  Reset();
  state.missingUnderLock = SLOT_ID;
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'SLOT_NOT_FOUND');
  assert.strictEqual(state.auditRows.length, 0);
});

test('M0-H3 — audit persistence failure is explicit (never silent, never blocks truth)', function() {
  Reset();
  state.auditAppendFailure = true;
  const applied = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(applied.data.applied, true);
  assert.strictEqual(applied.data.auditRecorded, false); // explicit, not swallowed
  assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');

  Reset();
  state.availabilityRows[0].status = 'FREE';
  state.auditAppendFailure = true;
  const rejected = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.error.code, 'INVALID_TRANSITION');
  assert.strictEqual(rejected.error.details.auditRecorded, false);
  assert.strictEqual(state.availabilityRows[0].status, 'FREE');
});

// ── I — Calendar Add-on callback (contract-faithful) ──────────

const addOn = createAddOnSandbox();
const addOnSandbox = addOn.core.sandbox;
const addOnState = addOn.core.state;

test('M0-I1 — Add-on action (verified event object) reaches AttendanceService and transitions Availability', function() {
  addOn.core.reset();
  addOnState.sessionEmail = OPERATOR_EMAIL;
  addOnState.properties.ATTENDANCE_OPERATOR_EMAIL = OPERATOR_EMAIL;

  let capturedContext = null;
  const original = addOnSandbox.AttendanceService.markCompleted;
  addOnSandbox.AttendanceService.markCompleted = function(context) {
    capturedContext = context;
    return original.call(this, context);
  };

  const response = addOnSandbox.onMarkCompleted(
    currentActionEvent({ eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' })
  );

  addOnSandbox.AttendanceService.markCompleted = original;

  // the service received the exact envelope: identity + policy + event
  assert.ok(capturedContext, 'AttendanceService.markCompleted must be invoked');
  assert.strictEqual(capturedContext.operator.operatorId, OPERATOR_EMAIL);
  assert.strictEqual(capturedContext.deployment.trustedOperatorEmail, OPERATOR_EMAIL);
  assert.strictEqual(capturedContext.calendarEvent.eventId, EVENT_ID);
  assert.strictEqual(capturedContext.calendarEvent.calendarId, 'CAL_DEFAULT');
  // the envelope carries NO authority claim
  assert.strictEqual(capturedContext.operator.authorityType, undefined);

  // end-to-end effect: actual Availability transition happened
  assert.strictEqual(addOnState.availabilityRows[0].status, 'COMPLETED');
  assert.strictEqual(addOnState.auditRows.length, 1);

  // result displayed on the re-rendered card (explicit success + identities)
  const card = responseCard(response);
  assert.ok(card, 'action response must re-render a card');
  assert.ok(cardText(card).indexOf('Recorded: COMPLETED') !== -1);
  assert.ok(cardText(card).indexOf(OPERATOR_EMAIL) !== -1);
  assert.ok(cardText(card).indexOf('Authority: DOCTOR') !== -1);
});

test('M0-I2 — Add-on eventOpen card: verified event object → stable identity + exactly two explicit decisions', function() {
  addOn.core.reset();
  const card = addOnSandbox.onCalendarEventOpen(
    currentEventObject(EVENT_ID, 'CAL_DEFAULT')
  );

  // CardBuilder.setHeader(newCardHeader().setTitle(...)) — verified API
  assert.strictEqual(card.kind, 'cardBuilder');
  assert.strictEqual(card.header.kind, 'cardHeader');
  assert.strictEqual(card.header.title, 'Attendance Capture');

  const sections = sectionsOf(card);
  assert.strictEqual(sections.length, 2);
  const contextSection = sections.find(function(s) { return sectionHeaderOf(s) === 'Event context'; });
  const decisionSection = sections.find(function(s) { return sectionHeaderOf(s) === 'Attendance decision'; });
  assert.ok(contextSection, 'event context section required');
  assert.ok(decisionSection, 'attendance decision section required');

  // stable identity displayed (event title/start are NOT in the event
  // object at any access level — verified against the official field table)
  assert.ok(cardText(contextSection).indexOf('Event ID: ' + EVENT_ID) !== -1);
  assert.ok(cardText(contextSection).indexOf('Calendar ID: CAL_DEFAULT') !== -1);
  assert.ok(cardText(contextSection).indexOf('TEST APPOINTMENT') === -1, 'title must not come from the event object');

  const buttons = buttonsInSection(decisionSection);
  assert.strictEqual(buttons.length, 2);
  assert.deepStrictEqual(
    buttons.map(function(b) { return b.action.functionName; }).sort(),
    ['onMarkCompleted', 'onMarkNoShow']
  );
  buttons.forEach(function(b) {
    // verified API: Action.setParameters
    assert.strictEqual(b.action.parameters.eventId, EVENT_ID);
    assert.strictEqual(b.action.parameters.calendarId, 'CAL_DEFAULT');
    // display text only — never a correlation key
    assert.ok(b.text.indexOf('MARK') !== -1);
  });
});

test('M0-I3 — legacy event object shape (INHERITED PoC evidence) is handled by the documented fallback', function() {
  addOn.core.reset();
  const card = addOnSandbox.onCalendarEventOpen(
    legacyEventObject(EVENT_ID, 'CAL_DEFAULT')
  );
  const sections = sectionsOf(card);
  const contextSection = sections.find(function(s) { return sectionHeaderOf(s) === 'Event context'; });
  assert.ok(cardText(contextSection).indexOf('Event ID: ' + EVENT_ID) !== -1);
  assert.ok(cardText(contextSection).indexOf('Calendar ID: CAL_DEFAULT') !== -1);

  // legacy parameter location (deprecated top-level e.parameters) fallback
  addOn.core.reset();
  const response = addOnSandbox.onMarkNoShow(
    legacyActionEvent({ eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' })
  );
  const resultCard = responseCard(response);
  assert.ok(cardText(resultCard).indexOf('Recorded: NO_SHOW') !== -1);
  assert.strictEqual(addOnState.availabilityRows[0].status, 'NO_SHOW');
});

test('M0-I4 — Add-on fail-safe: no identity → no decisions; missing/unknown params → explicit FAILED card', function() {
  addOn.core.reset();

  // event without stable identity (no current shape, no legacy shape)
  const emptyCard = addOnSandbox.onCalendarEventOpen({ commonEventObject: {} });
  const emptySections = sectionsOf(emptyCard);
  const emptyDecision = emptySections.find(function(s) { return sectionHeaderOf(s) === 'Attendance decision'; });
  assert.strictEqual(buttonsInSection(emptyDecision).length, 0);

  // missing params on action → explicit failure card, no state change
  addOn.core.reset();
  const missing = addOnSandbox.onMarkNoShow(currentActionEvent({}));
  assert.ok(cardText(responseCard(missing)).indexOf('FAILED: ADDON_EVENT_IDENTITY_MISSING') !== -1);
  assert.strictEqual(addOnState.availabilityRows[0].status, 'CONFIRMED');

  // unknown event through the full path → FAILED card (not success)
  addOn.core.reset();
  const unknown = addOnSandbox.onMarkNoShow(currentActionEvent({ eventId: 'UNKNOWN_EVENT', calendarId: 'CAL_DEFAULT' }));
  assert.ok(cardText(responseCard(unknown)).indexOf('FAILED: ATTENDANCE_EVENT_NOT_CORRELATED') !== -1);
  assert.strictEqual(addOnState.availabilityRows[0].status, 'CONFIRMED');
});

test('M0-I5 — Add-on operator boundary: untrusted / unconfigured → explicit FAILED, no state change', function() {
  // untrusted identity (Session account ≠ configured policy)
  addOn.core.reset();
  addOnState.sessionEmail = OTHER_ACCOUNT_EMAIL;
  addOnState.properties.ATTENDANCE_OPERATOR_EMAIL = OPERATOR_EMAIL;
  const unauthorized = addOnSandbox.onMarkCompleted(currentActionEvent({ eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' }));
  assert.ok(cardText(responseCard(unauthorized)).indexOf('FAILED: ATTENDANCE_OPERATOR_UNAUTHORIZED') !== -1);
  assert.strictEqual(addOnState.availabilityRows[0].status, 'CONFIRMED');
  assert.strictEqual(addOnState.auditRows.length, 0);
  assert.strictEqual(addOnState.cellWrites, 0);

  // unconfigured deployment policy
  addOn.core.reset();
  addOnState.properties.ATTENDANCE_OPERATOR_EMAIL = '';
  const unconfigured = addOnSandbox.onMarkCompleted(currentActionEvent({ eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' }));
  assert.ok(cardText(responseCard(unconfigured)).indexOf('FAILED: ATTENDANCE_TRUST_POLICY_UNCONFIGURED') !== -1);
  assert.strictEqual(addOnState.availabilityRows[0].status, 'CONFIRMED');
  assert.strictEqual(addOnState.auditRows.length, 0);
});

test('M0-I7 — debug mode dumps the live event-object shape (for runtime shape verification)', function() {
  addOn.core.reset();
  addOnState.properties.ATTENDANCE_DEBUG = 'true';
  const card = addOnSandbox.onCalendarEventOpen(
    currentEventObject(EVENT_ID, 'CAL_DEFAULT')
  );
  const diag = sectionsOf(card).find(function(s) { return sectionHeaderOf(s) === 'DIAGNOSTIC (event object)'; });
  assert.ok(diag, 'diagnostic section present when ATTENDANCE_DEBUG=true');
  const text = cardText(diag);
  assert.ok(text.indexOf('Top keys: [commonEventObject, calendarEventObject]') !== -1);
  assert.ok(text.indexOf('calendarEventObject keys: [calendar] | .calendar keys: [id, calendarId]') !== -1);
  assert.ok(text.indexOf('Extracted: eventId=' + EVENT_ID) !== -1);
  // full JSON was captured in the execution log for offline inspection
  const idx = addOnState.loggerLines.indexOf('M0_DIAG_EVENT_OBJECT_BEGIN');
  assert.ok(idx !== -1, 'diagnostic dump markers logged');
  assert.ok(addOnState.loggerLines[idx + 1].indexOf(EVENT_ID) !== -1, 'full JSON contains the event id');
  assert.strictEqual(addOnState.loggerLines[idx + 2], 'M0_DIAG_EVENT_OBJECT_END');

  // debug OFF by default → no diagnostic section
  addOn.core.reset();
  const card2 = addOnSandbox.onCalendarEventOpen(
    currentEventObject(EVENT_ID, 'CAL_DEFAULT')
  );
  const diag2 = sectionsOf(card2).find(function(s) { return sectionHeaderOf(s) === 'DIAGNOSTIC (event object)'; });
  assert.ok(!diag2, 'no diagnostic section when ATTENDANCE_DEBUG is not set');
});

test('M0-I6 — structural: Add-on uses ONLY verified CardService factories and no forbidden references', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8'));

  // every CardService factory used in the source is in the verified contract
  const factoryRefs = src.match(/CardService\.(\w+)\s*\(/g) || [];
  assert.ok(factoryRefs.length > 0, 'Add-on must use CardService');
  factoryRefs.forEach(function(ref) {
    const name = ref.match(/CardService\.(\w+)/)[1];
    assert.ok(
      CARD_SERVICE_CONTRACT.hasOwnProperty(name),
      'CardService.' + name + ' is NOT in the verified real API contract'
    );
  });

  // APIs verified REMOVED/absent from the current CardService reference
  ['CardService.newSection(', 'setHeaderTitle(', 'setSection(', 'CardService.newActionResponse(',
   'setRenderCard(', '.setParams('].forEach(function(forbidden) {
    assert.strictEqual(src.indexOf(forbidden), -1, 'Add-on must not use removed/unknown API: ' + forbidden);
  });
  // newTextButton takes no arguments in the verified API
  assert.ok(!/newTextButton\(\s*[^)\s]/.test(src), 'newTextButton() takes no arguments');

  // no business/storage/calendar-mutation dependencies
  ['SpreadsheetApp', 'GoogleSheets', 'CalendarApp', 'StateMachine',
   'SlotRepository', 'atomicUpdate', 'updateRow', 'LockService'].forEach(function(forbidden) {
    assert.strictEqual(src.indexOf(forbidden), -1, 'Add-on must not reference ' + forbidden);
  });
  assert.ok(src.indexOf('AttendanceService.markCompleted') !== -1);
  assert.ok(src.indexOf('AttendanceService.markNoShow') !== -1);
  assert.ok(src.indexOf('Session.getActiveUser') !== -1);
  // the Entry layer never asserts authority
  assert.strictEqual(src.indexOf('authorityType'), -1, 'Entry layer must not claim authorityType');
});

// ── MANIFEST — appsscript.json (verified Calendar Add-on integration) ──

test('M0-MANIFEST — appsscript.json declares the verified Calendar Add-on configuration', function() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
  const addOnSrc = fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8');

  // trigger wiring: object form with runFunction (verified manifest reference)
  assert.ok(manifest.addOns && manifest.addOns.calendar, 'addOns.calendar required');
  assert.strictEqual(manifest.addOns.calendar.eventOpenTrigger.runFunction, 'onCalendarEventOpen');
  assert.ok(addOnSrc.indexOf('function onCalendarEventOpen') !== -1, 'trigger function must exist in source');
  // addOns.common: name + logoUrl are REQUIRED by the real Apps Script API
  // (verified against the live manifest validation — push error:
  //  "Missing required field: addOns.common.logoUrl")
  assert.strictEqual(manifest.addOns.common.name, 'HAMZAWE Attendance');
  assert.ok(typeof manifest.addOns.common.logoUrl === 'string' && manifest.addOns.common.logoUrl.length > 0, 'addOns.common.logoUrl required by the real API');

  // event access mode: READ — empirically required (M0 live capture
  // evidence): at METADATA the runtime delivers e.calendar.{id, calendarId,
  // organizer, capabilities} but NOT the opened event's ID (no
  // selectedEvent / calendarEventObject / top-level id). READ is the
  // documented level providing "all provided event fields including the
  // metadata" and its documented scope requirement is
  // calendar.addons.current.event.read (read-only: no write scope, no
  // READ_WRITE, no event mutation).
  assert.strictEqual(manifest.addOns.calendar.currentEventAccess, 'READ');

  // scopes: the documented Calendar scopes are present (metadata +
  // current-event read, empirically required); no current-event WRITE scope.
  const scopes = manifest.oauthScopes.slice().sort();
  assert.deepStrictEqual(scopes, [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.addons.current.event.read',
    'https://www.googleapis.com/auth/calendar.addons.execute',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email'
  ]);
  assert.strictEqual(scopes.indexOf('https://www.googleapis.com/auth/calendar.addons.current.event.write'), -1);

  // production webapp (v7) configuration untouched
  assert.deepStrictEqual(manifest.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  assert.strictEqual(manifest.timeZone, 'Asia/Baghdad');
  assert.strictEqual(manifest.runtimeVersion, 'V8');
});

// ── M1 readiness + structural boundaries ──────────────────────

test('M0-M1 — activation boundary and reporting derivation are deterministic', function() {
  Reset();
  // a second confirmed slot that will stay PENDING ATTENDANCE
  state.availabilityRows.push(makeSlot(OTHER_SLOT_ID, 'CONFIRMED', OTHER_PHONE, OTHER_EVENT_ID));

  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.data.applied, true);

  // ATTENDANCE_ACTIVATION_AT := timestamp of the first APPLIED audit row
  const applied = state.auditRows
    .map(function(row, i) { return auditObject(i); })
    .filter(function(a) { return a.outcome === 'APPLIED'; });
  assert.strictEqual(applied.length, 1);
  assert.ok(applied[0].timestamp instanceof Date);

  // PENDING ATTENDANCE = CONFIRMED slot with no APPLIED attendance decision
  // (derived; not a new Slot state)
  function pendingAttendance(slotRows, auditObjs) {
    return slotRows
      .filter(function(s) {
        return s.status === 'CONFIRMED' &&
          !auditObjs.some(function(a) { return a.slot_id === s.slot_id && a.outcome === 'APPLIED'; });
      })
      .map(function(s) { return s.slot_id; });
  }
  assert.deepStrictEqual(
    pendingAttendance(state.availabilityRows, state.auditRows.map(function(row, i) { return auditObject(i); })),
    [OTHER_SLOT_ID]
  );

  // deterministic metric inputs for M1 (counts by decision outcome)
  assert.strictEqual(outcomeCount('APPLIED'), 1);
  assert.strictEqual(state.availabilityRows.filter(function(s) { return s.status === 'COMPLETED'; }).length, 1);
  assert.strictEqual(state.availabilityRows.filter(function(s) { return s.status === 'NO_SHOW'; }).length, 0);
});

test('M0-S1 — structural: AttendanceService stays in the Application layer', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'Application/AttendanceService.js'), 'utf8'));
  ['SpreadsheetApp', 'CalendarApp', 'GoogleSheets', 'LockService',
   'PropertiesService', 'CardService', 'Session.'].forEach(function(forbidden) {
    assert.strictEqual(src.indexOf(forbidden), -1, 'AttendanceService must not reference ' + forbidden);
  });
  // transitions go through the StateMachine via Validators; writes through the atomic path
  assert.ok(src.indexOf('Validators.validateTransition') !== -1);
  assert.ok(src.indexOf('SlotRepository.atomicUpdate') !== -1);
  assert.ok(src.indexOf('AttendanceAuditRepository.append') !== -1);
  assert.ok(src.indexOf('Clock.now()') !== -1);
  // authority is derived from identity + deployment policy
  assert.ok(src.indexOf('ATTENDANCE_TRUST_POLICY_UNCONFIGURED') !== -1);
  assert.ok(src.indexOf('ATTENDANCE_OPERATOR_UNAUTHORIZED') !== -1);
});

test('M0-S3 — file-evaluation order independence (clasp alphabetical order: AttendanceService BEFORE Config)', function() {
  // Reproduces the live add-on runtime failure: the Apps Script V8 runtime
  // evaluates project files in project file order; a clasp-pushed project
  // orders them alphabetically, so Application/AttendanceService.js is
  // evaluated BEFORE Config.js. The service file must therefore be
  // evaluable with Config not yet bound (no top-level Config reference),
  // and the decision mapping must still resolve from Config at call time.
  const sb = vm.createContext({ console: console });

  // 1) Evaluate AttendanceService.js FIRST (before Config exists) — must not throw
  const svcSrc = fs.readFileSync(path.join(ROOT, 'Application/AttendanceService.js'), 'utf8');
  vm.runInContext(svcSrc + '\nthis.AttendanceService = AttendanceService;', sb, {
    filename: 'Application/AttendanceService.js'
  });

  // 2) Now evaluate Config.js (as the runtime would, later in file order)
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'Config.js'), 'utf8');
  vm.runInContext(cfgSrc + '\nthis.Config = Config;', sb, { filename: 'Config.js' });

  // 3) The decision → StateMachine-vocabulary mapping resolves at call time
  assert.strictEqual(sb.AttendanceService._decisionCommand('MARK_COMPLETED'), 'CompleteAppointment');
  assert.strictEqual(sb.AttendanceService._decisionTarget('MARK_COMPLETED'), 'COMPLETED');
  assert.strictEqual(sb.AttendanceService._decisionCommand('MARK_NO_SHOW'), 'MarkNoShow');
  assert.strictEqual(sb.AttendanceService._decisionTarget('MARK_NO_SHOW'), 'NO_SHOW');
  // unknown decision → falsy (rejected as ATTENDANCE_DECISION_INVALID)
  assert.ok(!sb.AttendanceService._decisionCommand('FREE_FORM'));
  assert.ok(!sb.AttendanceService._decisionTarget('FREE_FORM'));
});

test('M0-S2 — structural: audit store is append-only; Config and StateMachine untouched by M0', function() {
  const repo = sandbox.AttendanceAuditRepository;
  assert.deepStrictEqual(
    Object.keys(repo).filter(function(k) { return k.charAt(0) !== '_'; }),
    ['SHEET_NAME', 'HEADERS', 'ensureStore', 'append']
  );
  const repoSrc = stripComments(fs.readFileSync(path.join(ROOT, 'Repositories/AttendanceAuditRepository.js'), 'utf8'));
  ['findBy', 'delete', 'remove', 'updateRow'].forEach(function(forbidden) {
    assert.strictEqual(repoSrc.indexOf(forbidden), -1, 'audit store must stay append-only');
  });

  const configSrc = fs.readFileSync(path.join(ROOT, 'Config.js'), 'utf8');
  assert.strictEqual(configSrc.indexOf('ATTENDANCE'), -1, 'Config vocabulary must stay untouched');
  const smSrc = fs.readFileSync(path.join(ROOT, 'StateMachine.js'), 'utf8');
  assert.strictEqual(smSrc.indexOf('ATTENDANCE'), -1, 'StateMachine must stay untouched');
});

// ── Runner ──────────────────────────────────────────────────

let failures = 0;
tests.forEach(function(entry) {
  try {
    entry.fn();
    console.log('PASS:', entry.name);
  } catch (error) {
    failures += 1;
    console.error('FAIL:', entry.name);
    console.error(error.stack || error.message);
  }
});

if (failures > 0) process.exit(1);
console.log('\n' + tests.length + '/' + tests.length + ' tests passed');
