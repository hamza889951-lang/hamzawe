'use strict';

/**
 * HardeningM0.test.js — M0 Attendance Capture Foundation
 *
 * Proves the M0 contract:
 *   A — CONFIRMED → COMPLETED (MARK_COMPLETED)
 *   B — CONFIRMED → NO_SHOW (MARK_NO_SHOW)
 *   C — invalid transitions rejected (FREE/RESERVED/NO_SHOW → COMPLETED,
 *       COMPLETED → NO_SHOW) + StateMachine table unchanged
 *   D — idempotent duplicates (deterministic no-op, no second record)
 *   E — concurrency: conflicting decisions cannot both win
 *       (E1: interleaved attempt under the held lock → LOCK_TIMEOUT;
 *        E2: stale read → A wins → B re-reads fresh state → INVALID_TRANSITION)
 *   F — untrusted/missing operator context rejected before any storage read
 *   G — event correlation failure (unknown / ambiguous / invalid context /
 *       read failure) — no availability mutation
 *   H — persistence failure never produces a false COMPLETED / NO_SHOW
 *   I — Calendar Add-on callback reaches AttendanceService with the trusted
 *       operator context and displays the Result
 *   J — regression (B1–B6) is executed separately against the same tree
 *
 * The harness loads the REAL production SlotRepository, Lock, and
 * AttendanceAuditRepository (only LockService/GoogleSheets/Clock are
 * mocked), so the atomic-update path under test is the production path.
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
const OPERATOR = { operatorId: OPERATOR_EMAIL, authorityType: 'DOCTOR' };

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Builds a vm sandbox with the real production M0 stack:
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
    sessionEmail: OPERATOR_EMAIL
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
  }

  return { sandbox: sandbox, state: state, makeSlot: makeSlot, reset: reset };
}

/** Core stack (tests A–H, M1-readiness, structural) */
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
    operator: o.operator === undefined ? OPERATOR : o.operator,
    calendarEvent: o.calendarEvent === undefined
      ? { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT' }
      : o.calendarEvent
  };
}

/** Add-on stack (test I): same production stack + CardService/Session seams */
function createAddOnSandbox() {
  const c = createCoreSandbox();
  const s = c.sandbox;

  let capture = null;
  s.CardService = {
    newCardBuilder: function() {
      const cardState = { title: '', sections: [] };
      capture = cardState;
      const builder = {
        setTitle: function(t) { cardState.title = t; return this; },
        setSection: function(sec) { cardState.sections.push(sec.state); return this; },
        build: function() { return cardState; }
      };
      builder.state = cardState;
      return builder;
    },
    newSection: function() {
      const stateObj = { header: '', widgets: [] };
      const section = {
        setHeaderTitle: function(h) { stateObj.header = h; return this; },
        addWidget: function(w) { stateObj.widgets.push(w.state); return this; }
      };
      section.state = stateObj;
      return section;
    },
    newTextParagraph: function() {
      const stateObj = { text: '' };
      const para = { setText: function(t) { stateObj.text = t; return this; } };
      para.state = stateObj;
      return para;
    },
    newTextButton: function() {
      const stateObj = { text: '', action: null };
      const button = {
        setText: function(t) { stateObj.text = t; return this; },
        setOnClickAction: function(a) { stateObj.action = a.state; return this; }
      };
      button.state = stateObj;
      return button;
    },
    newAction: function() {
      const stateObj = { functionName: '', params: {} };
      const action = {
        setFunctionName: function(f) { stateObj.functionName = f; return this; },
        setParams: function(p) { stateObj.params = p; return this; }
      };
      action.state = stateObj;
      return action;
    },
    newActionResponse: function() {
      const stateObj = { card: null };
      const response = {
        setRenderCard: function(card) { stateObj.card = card; return this; },
        build: function() { return stateObj; }
      };
      response.state = stateObj;
      return response;
    }
  };

  s.Session = {
    getActiveUser: function() {
      return { getEmail: function() { return c.state.sessionEmail; } };
    }
  };

  const addOnSource = fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8');
  vm.runInContext(
    addOnSource +
    '\nthis.onOpen = onOpen;' +
    '\nthis.onMarkCompleted = onMarkCompleted;' +
    '\nthis.onMarkNoShow = onMarkNoShow;',
    s,
    { filename: 'AttendanceAddOn.js' }
  );

  return { core: c, getCard: function() { return capture; } };
}

const addOn = createAddOnSandbox();
const addOnSandbox = addOn.core.sandbox;
const addOnState = addOn.core.state;

function cardText(card) {
  return JSON.stringify(card);
}
function decisionButtons(card) {
  const section = card.sections.find(function(sec) { return sec.header === 'Attendance decision'; });
  return section ? section.widgets.filter(function(w) { return w.action; }) : [];
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ── A — Normal Completion ─────────────────────────────────────

test('M0-A — CONFIRMED → MARK_COMPLETED → COMPLETED with full audit record', function() {
  Reset();
  const result = sandbox.AttendanceService.markCompleted(ctx());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.applied, true);
  assert.strictEqual(result.data.alreadyApplied, false);
  assert.strictEqual(result.data.decision, 'MARK_COMPLETED');
  assert.strictEqual(result.data.status, 'COMPLETED');
  assert.strictEqual(result.data.fromStatus, 'CONFIRMED');
  assert.strictEqual(result.data.slotId, SLOT_ID);
  assert.strictEqual(result.data.operatorId, OPERATOR.operatorId);
  assert.strictEqual(result.data.calendarEventId, EVENT_ID);
  assert.strictEqual(result.data.calendarId, 'CAL_DEFAULT');
  assert.strictEqual(result.data.auditRecorded, true);

  assert.strictEqual(state.availabilityRows[0].status, 'COMPLETED');
  assert.strictEqual(state.availabilityRows[0].phone, PHONE);

  assert.strictEqual(state.auditRows.length, 1);
  const a = auditObject(0);
  assert.strictEqual(a.operator_id, OPERATOR.operatorId);
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
  assert.strictEqual(details.operatorId, OPERATOR.operatorId);
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

// ── F — Operator context ──────────────────────────────────────

test('M0-F — untrusted/missing operator context fails before any storage access', function() {
  const cases = [
    ['missing context', undefined, 'ATTENDANCE_CONTEXT_INVALID'],
    ['missing operator', { operator: null, calendarEvent: { eventId: EVENT_ID } }, 'ATTENDANCE_OPERATOR_INVALID'],
    ['empty operatorId', { operator: { operatorId: '   ', authorityType: 'DOCTOR' }, calendarEvent: { eventId: EVENT_ID } }, 'ATTENDANCE_OPERATOR_INVALID'],
    ['non-string operatorId', { operator: { operatorId: 42, authorityType: 'DOCTOR' }, calendarEvent: { eventId: EVENT_ID } }, 'ATTENDANCE_OPERATOR_INVALID'],
    ['non-Doctor authority', { operator: { operatorId: 'x@y.z', authorityType: 'ADMIN' }, calendarEvent: { eventId: EVENT_ID } }, 'ATTENDANCE_OPERATOR_INVALID'],
    ['missing authorityType', { operator: { operatorId: 'x@y.z' }, calendarEvent: { eventId: EVENT_ID } }, 'ATTENDANCE_OPERATOR_INVALID']
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

// ── I — Calendar Add-on callback ──────────────────────────────

test('M0-I1 — Add-on action reaches AttendanceService with trusted context and transitions Availability', function() {
  addOn.core.reset();
  addOnState.sessionEmail = 'operator.live@hamzawe.clinic';

  let capturedContext = null;
  const original = addOnSandbox.AttendanceService.markCompleted;
  addOnSandbox.AttendanceService.markCompleted = function(context) {
    capturedContext = context;
    return original.call(this, context);
  };

  const response = addOnSandbox.onMarkCompleted({
    params: { eventId: EVENT_ID, calendarId: 'CAL_DEFAULT', eventTitle: 'TEST APPOINTMENT' }
  });

  addOnSandbox.AttendanceService.markCompleted = original;

  // service received the exact trusted context
  assert.ok(capturedContext, 'AttendanceService.markCompleted must be invoked');
  assert.strictEqual(capturedContext.operator.operatorId, 'operator.live@hamzawe.clinic');
  assert.strictEqual(capturedContext.operator.authorityType, 'DOCTOR');
  assert.strictEqual(capturedContext.calendarEvent.eventId, EVENT_ID);
  assert.strictEqual(capturedContext.calendarEvent.calendarId, 'CAL_DEFAULT');

  // end-to-end effect: actual Availability transition happened
  assert.strictEqual(addOnState.availabilityRows[0].status, 'COMPLETED');
  assert.strictEqual(addOnState.auditRows.length, 1);

  // result displayed on the card (explicit success with identities)
  assert.ok(cardText(response.card).indexOf('Recorded: COMPLETED') !== -1);
  assert.ok(cardText(response.card).indexOf('operator.live@hamzawe.clinic') !== -1);
});

test('M0-I2 — Add-on onOpen card carries stable event identity and exactly two explicit decisions', function() {
  addOn.core.reset();
  const card = addOnSandbox.onOpen({
    calendar: { getId: function() { return 'CAL_DEFAULT'; } },
    selectedEvent: {
      getId: function() { return EVENT_ID; },
      getTitle: function() { return 'TEST APPOINTMENT'; },
      getStartDate: function() { return new Date(NOW_MS); }
    }
  });

  assert.strictEqual(card.title, 'Attendance Capture');
  const contextSection = card.sections.find(function(s) { return s.header === 'Event context'; });
  assert.ok(contextSection, 'event context section required');
  assert.ok(cardText(contextSection).indexOf('TEST APPOINTMENT') !== -1); // display only
  assert.ok(cardText(contextSection).indexOf(EVENT_ID) !== -1);

  const buttons = decisionButtons(card);
  assert.strictEqual(buttons.length, 2);
  assert.deepStrictEqual(
    buttons.map(function(b) { return b.action.functionName; }).sort(),
    ['onMarkCompleted', 'onMarkNoShow']
  );
  buttons.forEach(function(b) {
    assert.strictEqual(b.action.params.eventId, EVENT_ID);
    assert.strictEqual(b.action.params.calendarId, 'CAL_DEFAULT');
  });
});

test('M0-I3 — Add-on event without stable identity: no decisions offered, safe failure display', function() {
  addOn.core.reset();
  const card = addOnSandbox.onOpen({
    calendar: { getId: function() { return 'CAL_DEFAULT'; } },
    selectedEvent: { getId: function() { return ''; }, getTitle: function() { return 'X'; } }
  });
  assert.strictEqual(decisionButtons(card).length, 0);

  // missing params on action → explicit failure card, no state change
  const response = addOnSandbox.onMarkNoShow({ params: {} });
  assert.ok(cardText(response.card).indexOf('FAILED: ADDON_EVENT_IDENTITY_MISSING') !== -1);
  assert.strictEqual(addOnState.availabilityRows[0].status, 'CONFIRMED');

  // unknown event through the full path → FAILED card (not success)
  const response2 = addOnSandbox.onMarkNoShow({ params: { eventId: 'UNKNOWN_EVENT', calendarId: 'CAL_DEFAULT' } });
  assert.ok(cardText(response2.card).indexOf('FAILED: ATTENDANCE_EVENT_NOT_CORRELATED') !== -1);
  assert.strictEqual(addOnState.availabilityRows[0].status, 'CONFIRMED');
});

test('M0-I4 — structural: Add-on has no business/storage/calendar-mutation dependencies', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'AttendanceAddOn.js'), 'utf8'));
  ['SpreadsheetApp', 'GoogleSheets', 'CalendarApp', 'StateMachine',
   'SlotRepository', 'atomicUpdate', 'updateRow', 'LockService', 'PropertiesService'].forEach(function(forbidden) {
    assert.strictEqual(src.indexOf(forbidden), -1, 'Add-on must not reference ' + forbidden);
  });
  assert.ok(src.indexOf('AttendanceService.markCompleted') !== -1);
  assert.ok(src.indexOf('AttendanceService.markNoShow') !== -1);
  assert.ok(src.indexOf('Session.getActiveUser') !== -1);
  assert.ok(src.indexOf('CardService') !== -1);
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

// ── Runner ───────────────────────────────────────────────────

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
