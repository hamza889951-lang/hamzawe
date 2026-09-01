'use strict';

/**
 * HardeningM4C.test.js — M4-C Schedule Intent Management
 *
 * Real Application + repository boundaries over a controlled GoogleSheets mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DOCTOR_ID = '9647001111111';
const OTHER_DOCTOR = '9647009999999';

function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    sheets: {},
    failRead: {},
    writes: [],
    updates: 0,
    deletes: 0,
    sends: 0,
    calendar: 0,
    lockKeys: [],
    nowIso: '2026-09-01T06:00:00.000Z',
    logs: []
  };

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      throw new Error('M4C_MUST_NOT_READ_PROPERTIES');
    }
  };

  sandbox.LockService = {
    getScriptLock: function() {
      return {
        waitLock: function() {},
        releaseLock: function() {}
      };
    }
  };

  function sheetStore(name) {
    if (!state.sheets[name]) {
      state.sheets[name] = { headers: [], rows: [] };
    }
    return state.sheets[name];
  }

  sandbox.GoogleSheets = {
    getOrCreateSheet: function(name, headers) {
      const sheet = sheetStore(name);
      if (!sheet.headers.length && headers) sheet.headers = headers.slice();
      return sheet;
    },
    getAllRows: function(name) {
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
      return sheet.rows.map(function(r) { return Object.assign({}, r); });
    },
    queryRows: function(name, predicateFn) {
      return sandbox.GoogleSheets.getAllRows(name).filter(predicateFn);
    },
    findRowByColumn: function(name, columnName, value) {
      const rows = sandbox.GoogleSheets.queryRows(name, function(row) {
        return row[columnName] === value;
      });
      return rows.length ? rows[0] : null;
    },
    appendRow: function(name, rowObject) {
      const sheet = sheetStore(name);
      if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
      sheet.rows.push(Object.assign({}, rowObject));
      state.writes.push({ name: name, row: Object.assign({}, rowObject) });
    },
    appendRows: function(name) {
      state.writes.push({ name: name, batch: true });
      throw new Error('M4C_UNEXPECTED_APPEND_ROWS');
    },
    updateRowByColumn: function(name) {
      state.updates += 1;
      throw new Error('M4C_MUST_NOT_UPDATE: ' + name);
    },
    updateBatch: function(name) {
      state.updates += 1;
      throw new Error('M4C_MUST_NOT_UPDATE_BATCH: ' + name);
    },
    deleteRowsByNumbers: function(name) {
      state.deletes += 1;
      throw new Error('M4C_MUST_NOT_DELETE: ' + name);
    }
  };

  sandbox.WhatsAppAdapter = {
    sendMessage: function() {
      state.sends += 1;
      throw new Error('M4C_MUST_NOT_SEND_WHATSAPP');
    }
  };
  sandbox.GoogleCalendar = {
    createEvent: function() {
      state.calendar += 1;
      throw new Error('M4C_MUST_NOT_CALENDAR');
    },
    deleteEvent: function() {
      state.calendar += 1;
      throw new Error('M4C_MUST_NOT_CALENDAR');
    }
  };

  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
  }

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('Clock.js', 'Clock');
  sandbox.Clock.now = function() { return new Date(state.nowIso); };

  load('Utils/ULID.js', 'ULID');
  load('Utils/IdGenerator.js', 'IdGenerator');
  load('Infrastructure/Lock.js', 'Lock');
  const originalLock = sandbox.Lock.runExclusive;
  sandbox.Lock.runExclusive = function(key, fn, timeoutMs) {
    state.lockKeys.push(key);
    return originalLock.call(sandbox.Lock, key, fn, timeoutMs);
  };

  load('SettingsRepository.js', 'SettingsRepository');
  load('Application/DoctorScheduleReadService.js', 'DoctorScheduleReadService');
  load('Repositories/ScheduleChangeRepository.js', 'ScheduleChangeRepository');
  load('Application/EffectiveScheduleService.js', 'EffectiveScheduleService');
  load('LogRepository.js', 'LogRepository');
  sandbox.LogRepository.write = function(entry) {
    state.logs.push(entry);
  };
  load('Application/CommandExecutor.js', 'CommandExecutor');
  load('Application/DoctorScheduleCommandService.js', 'DoctorScheduleCommandService');

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;
const CMD = sandbox.DoctorScheduleCommandService;
const EFF = sandbox.EffectiveScheduleService;
const REPO = sandbox.ScheduleChangeRepository;

function standardSettings(overrides) {
  return Object.assign({
    work_start: '09:00',
    work_end: '14:00',
    'Slot Duration (min)': '30',
    sunday: true,
    monday: true,
    tuesday: false,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: true
  }, overrides || {});
}

function seedSettings(settingsObj) {
  state.sheets['Settings'] = {
    headers: Object.keys(settingsObj),
    rows: [Object.assign({}, settingsObj)]
  };
}

function controlContext(overrides) {
  return Object.assign({
    actorId: DOCTOR_ID,
    scope: { clinicId: null }
  }, overrides || {});
}

function reset() {
  state.sheets = {};
  state.failRead = {};
  state.writes = [];
  state.updates = 0;
  state.deletes = 0;
  state.sends = 0;
  state.calendar = 0;
  state.lockKeys = [];
  state.logs = [];
  seedSettings(standardSettings());
  state.sheets['ScheduleChanges'] = {
    headers: sandbox.ScheduleChangeRepository.HEADERS.slice(),
    rows: []
  };
}

function scheduleDays(map) {
  return Object.assign({
    sunday: false,
    monday: false,
    tuesday: false,
    wednesday: false,
    thursday: false,
    friday: false,
    saturday: false
  }, map);
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ── Recurring ────────────────────────────────────────────────

test('M4C-R1 — valid future recurring change commits an immutable record', function() {
  reset();
  const r = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-rec-1',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ sunday: true, monday: true, wednesday: true, thursday: true, saturday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.status, 'COMMITTED');
  assert.strictEqual(r.data.record.changeKind, 'RECURRING');
  assert.strictEqual(r.data.record.effectiveFrom, '2026-09-15T00:00');
  assert.strictEqual(r.data.record.scope.doctorId, DOCTOR_ID);
  assert.strictEqual(r.data.record.scope.clinicId, null);
  assert.strictEqual(state.sheets['Settings'].rows[0].work_start, '09:00');
  assert.strictEqual(state.updates, 0);
  assert.strictEqual(state.deletes, 0);
});

test('M4C-R2 — recurring change does not apply before effectiveFrom', function() {
  reset();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-rec-2',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  const before = EFF.projectAt(controlContext(), '2026-09-14T10:00');
  assert.strictEqual(before.ok, true);
  assert.strictEqual(before.data.source, 'SETTINGS');
  assert.strictEqual(before.data.workWindow.start, '09:00');
  const after = EFF.projectAt(controlContext(), '2026-09-15T00:00');
  assert.strictEqual(after.ok, true);
  assert.strictEqual(after.data.source, 'RECURRING_CHANGE');
  assert.strictEqual(after.data.workWindow.start, '10:00');
  assert.strictEqual(after.data.slotDurationMinutes, 30);
});

test('M4C-R3 — later recurring change supersedes earlier one from its effectiveFrom', function() {
  reset();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-rec-3a',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-rec-3b',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-10-01T00:00',
    schedule: {
      days: scheduleDays({ monday: true, tuesday: true }),
      workWindow: { start: '08:00', end: '12:00' },
    }
  });
  const mid = EFF.projectAt(controlContext(), '2026-09-20T10:00');
  assert.strictEqual(mid.data.workWindow.start, '10:00');
  const late = EFF.projectAt(controlContext(), '2026-10-01T00:00');
  assert.strictEqual(late.data.workWindow.start, '08:00');
  assert.strictEqual(late.data.days.tuesday, true);
});

test('M4C-R4 — recurring change with effectiveFrom in the past fails', function() {
  reset();
  const r = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-rec-past',
    asOf: '2026-09-15T08:00',
    effectiveFrom: '2026-09-14T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CHANGE_EFFECTIVE_IN_PAST');
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4C-R5 — two recurring changes at the same effectiveFrom conflict', function() {
  reset();
  const first = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-rec-same-a',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  assert.strictEqual(first.ok, true);
  const second = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-rec-same-b',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ tuesday: true }),
      workWindow: { start: '11:00', end: '15:00' },
    }
  });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error.code, 'SCHEDULE_INTENT_CONFLICT');
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 1);
});

// ── Temporary ────────────────────────────────────────────────

test('M4C-T1 — valid temporary close does not mutate recurring baseline', function() {
  reset();
  const r = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-close-1',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.record.changeKind, 'TEMPORARY_CLOSE');
  const settings = EFF.projectAt(controlContext(), '2026-09-21T10:00');
  assert.strictEqual(settings.data.source, 'SETTINGS');
  assert.strictEqual(settings.data.workWindow.start, '09:00');
});

test('M4C-T2 — temporary close covers only its bounded half-open interval', function() {
  reset();
  CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-close-2',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  const inside = EFF.projectAt(controlContext(), '2026-09-20T11:00');
  assert.strictEqual(inside.data.interval.intent, 'CLOSED');
  const atEnd = EFF.projectAt(controlContext(), '2026-09-20T12:00');
  assert.strictEqual(atEnd.data.interval.intent, 'WORKING');
  const after = EFF.projectAt(controlContext(), '2026-09-20T12:30');
  assert.strictEqual(after.data.interval.intent, 'WORKING');
});

test('M4C-T3 — exceptional open on a closed recurring day', function() {
  reset();
  // Tuesday is closed in baseline. v1 exceptional open takes the date only
  // and reuses the regular Settings working window (09:00–14:00).
  const r = CMD.commitExceptionalOpen(controlContext(), {
    commandId: 'cmd-open-1',
    asOf: '2026-09-01T08:00',
    date: '2026-09-22'
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.record.effectiveFrom, '2026-09-22T00:00');
  assert.strictEqual(r.data.record.effectiveTo, '2026-09-23T00:00');
  assert.strictEqual(r.data.record.payload.workWindow.start, '09:00');
  assert.strictEqual(r.data.record.payload.workWindow.end, '14:00');
  assert.strictEqual(r.data.record.payload.workWindowSource, 'SETTINGS');
  // 2026-09-22 is Tuesday
  const at = EFF.projectAt(controlContext(), '2026-09-22T10:00');
  assert.strictEqual(at.ok, true, JSON.stringify(at.error));
  assert.strictEqual(at.data.days.tuesday, false);
  assert.strictEqual(at.data.interval.intent, 'EXCEPTIONAL_OPEN');
  const outside = EFF.projectAt(controlContext(), '2026-09-22T14:00');
  assert.strictEqual(outside.data.interval.intent, 'CLOSED');
});

test('M4C-T4 — overlapping temporary overrides conflict at command time', function() {
  reset();
  const a = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-ov-a',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  assert.strictEqual(a.ok, true);
  const b = CMD.commitExceptionalOpen(controlContext(), {
    commandId: 'cmd-ov-b',
    asOf: '2026-09-01T08:00',
    date: '2026-09-20'
  });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.error.code, 'SCHEDULE_INTENT_CONFLICT');
});

test('M4C-T5 — overlapping same-kind closes also conflict (no silent merge)', function() {
  reset();
  CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-close-a',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  const b = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-close-b',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T11:00',
    effectiveTo: '2026-09-20T13:00'
  });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.error.code, 'SCHEDULE_INTENT_CONFLICT');
});

test('M4C-T6 — abutting half-open intervals [10,12) and [12,13) do not conflict', function() {
  reset();
  const a = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-abut-a',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  assert.strictEqual(a.ok, true, JSON.stringify(a.error));
  const b = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-abut-b',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T12:00',
    effectiveTo: '2026-09-20T13:00'
  });
  assert.strictEqual(b.ok, true, JSON.stringify(b.error));
  assert.strictEqual(EFF.projectAt(controlContext(), '2026-09-20T11:59').data.interval.intent, 'CLOSED');
  assert.strictEqual(
    EFF.projectAt(controlContext(), '2026-09-20T12:00').data.interval.appliedOverrideChangeId,
    b.data.record.changeId
  );
});

test('M4C-T7 — zero-length interval effectiveFrom == effectiveTo is rejected', function() {
  reset();
  const r = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-zero',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T10:00'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_EFFECTIVE_INTERVAL');
});

// ── EffectiveSchedule mix ────────────────────────────────────

test('M4C-E1 — baseline only is M4-B equivalent at a weekday instant', function() {
  reset();
  const r = EFF.projectAt(controlContext(), '2026-09-07T10:00'); // Monday
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.source, 'SETTINGS');
  assert.strictEqual(r.data.interval.intent, 'WORKING');
  assert.strictEqual(r.data.timezone, 'Asia/Baghdad');
});

test('M4C-E2 — recurring + temporary close at same instant', function() {
  reset();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-mix-r',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ sunday: true, monday: true, wednesday: true, thursday: true, saturday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-mix-c',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  const closed = EFF.projectAt(controlContext(), '2026-09-20T11:00'); // Sunday
  assert.strictEqual(closed.data.source, 'RECURRING_CHANGE');
  assert.strictEqual(closed.data.interval.intent, 'CLOSED');
  const open = EFF.projectAt(controlContext(), '2026-09-20T12:30');
  assert.strictEqual(open.data.interval.intent, 'WORKING');
});

test('M4C-E3 — projection is deterministic and read-only', function() {
  reset();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-det',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  const writesBefore = state.writes.length;
  const a = jsonClone(EFF.projectAt(controlContext(), '2026-09-21T10:00'));
  const b = jsonClone(EFF.projectAt(controlContext(), '2026-09-21T10:00'));
  assert.deepStrictEqual(a, b);
  assert.strictEqual(state.writes.length, writesBefore);
  assert.strictEqual(state.sends, 0);
  assert.strictEqual(state.calendar, 0);
});

test('M4C-E4 — Tuesday baseline remains closed without exceptional open', function() {
  reset();
  const r = EFF.projectAt(controlContext(), '2026-09-22T10:00');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.days.tuesday, false);
  assert.strictEqual(r.data.interval.intent, 'CLOSED');
});

// ── Cancellation ─────────────────────────────────────────────

test('M4C-C1 — cancelling a future change appends CANCEL and restores projection', function() {
  reset();
  const committed = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-can-1',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  const cancel = CMD.cancelChange(controlContext(), {
    commandId: 'cmd-can-1-cancel',
    asOf: '2026-09-01T08:00',
    targetChangeId: committed.data.record.changeId
  });
  assert.strictEqual(cancel.ok, true, JSON.stringify(cancel.error));
  assert.strictEqual(cancel.data.record.changeKind, 'CANCEL');
  assert.strictEqual(state.deletes, 0);
  assert.strictEqual(state.updates, 0);
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 2);
  const after = EFF.projectAt(controlContext(), '2026-09-15T10:00');
  assert.strictEqual(after.data.source, 'SETTINGS');
  assert.strictEqual(after.data.slotDurationMinutes, 30);
});

test('M4C-C2 — unknown target fails', function() {
  reset();
  const r = CMD.cancelChange(controlContext(), {
    commandId: 'cmd-can-missing',
    asOf: '2026-09-01T08:00',
    targetChangeId: 'SCH_DOES_NOT_EXIST'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CHANGE_TARGET_NOT_FOUND');
});

test('M4C-C3 — wrong scope fails', function() {
  reset();
  const committed = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-can-scope',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  const r = CMD.cancelChange(controlContext({ actorId: OTHER_DOCTOR, scope: { clinicId: null } }), {
    commandId: 'cmd-can-wrong-scope',
    asOf: '2026-09-01T08:00',
    targetChangeId: committed.data.record.changeId
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'CHANGE_TARGET_NOT_FOUND');
});

test('M4C-C4 — CANCEL is temporal: past instants keep the target, later instants exclude it', function() {
  reset();
  const committed = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-can-started',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  const r = CMD.cancelChange(controlContext(), {
    commandId: 'cmd-can-late',
    asOf: '2026-09-18T08:00',
    targetChangeId: committed.data.record.changeId
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.record.effectiveFrom, '2026-09-18T08:00');

  const beforeEffective = EFF.projectAt(controlContext(), '2026-09-14T10:00');
  assert.strictEqual(beforeEffective.ok, true);
  assert.strictEqual(beforeEffective.data.source, 'SETTINGS');

  const afterEffectiveBeforeCancel = EFF.projectAt(controlContext(), '2026-09-16T10:00');
  assert.strictEqual(afterEffectiveBeforeCancel.ok, true);
  assert.strictEqual(afterEffectiveBeforeCancel.data.source, 'RECURRING_CHANGE');
  assert.strictEqual(afterEffectiveBeforeCancel.data.slotDurationMinutes, 30);

  const atCancel = EFF.projectAt(controlContext(), '2026-09-18T08:00');
  assert.strictEqual(atCancel.ok, true);
  assert.strictEqual(atCancel.data.source, 'SETTINGS');
  assert.strictEqual(atCancel.data.slotDurationMinutes, 30);
});

test('M4C-C5 — double cancel fails CHANGE_ALREADY_CANCELLED', function() {
  reset();
  const committed = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-can-d1',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  const first = CMD.cancelChange(controlContext(), {
    commandId: 'cmd-can-d2',
    asOf: '2026-09-01T08:00',
    targetChangeId: committed.data.record.changeId
  });
  assert.strictEqual(first.ok, true);
  const second = CMD.cancelChange(controlContext(), {
    commandId: 'cmd-can-d3',
    asOf: '2026-09-01T08:00',
    targetChangeId: committed.data.record.changeId
  });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error.code, 'CHANGE_ALREADY_CANCELLED');
});

// ── Idempotency / concurrency ────────────────────────────────

test('M4C-I1 — same commandId replays without a duplicate record', function() {
  reset();
  const payload = {
    commandId: 'cmd-idemp',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  };
  const a = CMD.commitRecurringChange(controlContext(), payload);
  const b = CMD.commitRecurringChange(controlContext(), payload);
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.data.status, 'IDEMPOTENT_REPLAY');
  assert.strictEqual(a.data.record.changeId, b.data.record.changeId);
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 1);
});

test('M4C-I2 — lock key is schedule-scope not global/slot', function() {
  reset();
  CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-lock',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  assert.ok(state.lockKeys.some(function(k) {
    return k === 'schedule-intent:' + DOCTOR_ID + ':';
  }));
  assert.strictEqual(state.lockKeys.some(function(k) { return k.indexOf('slot:') === 0; }), false);
});

test('M4C-I3 — sequential commands see fresh records (no stale overwrite)', function() {
  reset();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-fresh-1',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  const second = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-fresh-2',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ tuesday: true }),
      workWindow: { start: '11:00', end: '15:00' },
    }
  });
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error.code, 'SCHEDULE_INTENT_CONFLICT');
});

test('M4C-I4 — CommandExecutor writes audit START/END for committed mutation', function() {
  reset();
  CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-audit',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  const commands = state.logs.map(function(l) { return l.command + ':' + l.stage; });
  assert.ok(commands.indexOf('CommitTemporaryCloseOverride:START') !== -1);
  assert.ok(commands.indexOf('CommitTemporaryCloseOverride:END') !== -1);
  const record = REPO.findByCommandIdResult(DOCTOR_ID, null, 'cmd-audit');
  assert.strictEqual(record.ok, true);
  assert.ok(record.data.before);
  assert.ok(record.data.after);
  assert.strictEqual(record.data.actorId, DOCTOR_ID);
});

// ── Data honesty ─────────────────────────────────────────────

test('M4C-H1 — malformed Settings fail command and projection', function() {
  reset();
  seedSettings(standardSettings({ work_start: 'nope' }));
  const cmd = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-bad-settings',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  assert.strictEqual(cmd.ok, false);
  assert.strictEqual(cmd.error.code, 'SCHEDULE_SOURCE_INVALID');
  const proj = EFF.projectAt(controlContext(), '2026-09-15T10:00');
  assert.strictEqual(proj.ok, false);
  assert.strictEqual(proj.error.code, 'SCHEDULE_SOURCE_INVALID');
});

test('M4C-H2 — unavailable Settings fail explicitly', function() {
  reset();
  state.failRead['Settings'] = true;
  const proj = EFF.projectAt(controlContext(), '2026-09-15T10:00');
  assert.strictEqual(proj.ok, false);
  assert.strictEqual(proj.error.code, 'SETTINGS_READ_FAILED');
});

test('M4C-H3 — malformed existing change payload fails projection', function() {
  reset();
  state.sheets['ScheduleChanges'].rows.push({
    changeId: 'SCH_BAD',
    doctorId: DOCTOR_ID,
    clinicId: '',
    actorId: DOCTOR_ID,
    commandId: 'bad',
    changeKind: 'RECURRING',
    effectiveFrom: '2026-09-15T00:00',
    effectiveTo: '',
    payloadJson: '{not-json',
    createdAt: 't',
    status: 'COMMITTED',
    targetChangeId: '',
    beforeJson: '{}',
    afterJson: '{}'
  });
  const proj = EFF.projectAt(controlContext(), '2026-09-16T10:00');
  assert.strictEqual(proj.ok, false);
  assert.strictEqual(proj.error.code, 'SCHEDULE_CHANGE_SOURCE_INVALID');
});

test('M4C-H4 — missing control context fails', function() {
  reset();
  const r = EFF.projectAt(null, '2026-09-16T10:00');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_CONTROL_CONTEXT');
});

test('M4C-H6 — non-boolean recurring day flags are rejected, not coerced', function() {
  reset();
  const cases = ['FALSE', 'false', 'garbage', 0, null];
  cases.forEach(function(value, idx) {
    const days = scheduleDays({ monday: true });
    days.tuesday = value;
    const r = CMD.commitRecurringChange(controlContext(), {
      commandId: 'cmd-day-bad-' + idx,
      asOf: '2026-09-01T08:00',
      effectiveFrom: '2026-09-15T00:00',
      schedule: {
        days: days,
        workWindow: { start: '10:00', end: '14:00' },
      }
    });
    assert.strictEqual(r.ok, false, 'expected fail for ' + JSON.stringify(value));
    assert.strictEqual(r.error.code, 'INVALID_SCHEDULE_COMMAND');
  });
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4C-H5 — missing commandId fails', function() {
  reset();
  const r = CMD.commitTemporaryClose(controlContext(), {
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_SCHEDULE_COMMAND');
});

// ── Scope ────────────────────────────────────────────────────

test('M4C-S1 — clinicId null v1 is stored and projected, not a global singleton', function() {
  reset();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-scope-null',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' },
    }
  });
  CMD.commitRecurringChange(controlContext({ actorId: OTHER_DOCTOR, scope: { clinicId: null } }), {
    commandId: 'cmd-scope-other',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ friday: true }),
      workWindow: { start: '08:00', end: '09:00' },
    }
  });
  const a = EFF.projectAt(controlContext(), '2026-09-15T10:00');
  const b = EFF.projectAt(controlContext({ actorId: OTHER_DOCTOR, scope: { clinicId: null } }), '2026-09-15T08:00');
  assert.strictEqual(a.data.workWindow.start, '10:00');
  assert.strictEqual(b.data.workWindow.start, '08:00');
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 2);
});

test('M4C-S2 — future clinicId is carried on the record', function() {
  reset();
  const r = CMD.commitTemporaryClose(controlContext({
    actorId: DOCTOR_ID,
    scope: { clinicId: 'clinic-future' }
  }), {
    commandId: 'cmd-clinic',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T12:00'
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.record.scope.clinicId, 'clinic-future');
  assert.ok(state.lockKeys.indexOf('schedule-intent:' + DOCTOR_ID + ':clinic-future') !== -1);
});

// ── Layering ─────────────────────────────────────────────────

test('M4C-L1 — Application files do not call SpreadsheetApp / Calendar / WhatsApp / Availability', function() {
  const files = [
    'Application/EffectiveScheduleService.js',
    'Application/DoctorScheduleCommandService.js'
  ];
  files.forEach(function(rel) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    [
      /SpreadsheetApp/, /GoogleSheets/, /CalendarApp/, /GoogleCalendar/,
      /WhatsAppAdapter/, /ultramsg|ultraMsg/i, /UrlFetchApp/,
      /is_available/, /SlotRepository/, /AppointmentRepository/,
      /DOCTOR_PHONE/, /ADMIN_PHONE/, /DoctorIdentityRepository/,
      /DoctorAuthorizationService/, /Clock\.now/
    ].forEach(function(rx) {
      assert.strictEqual(rx.test(code), false, rel + ' must not reference ' + rx);
    });
  });
});

test('M4C-L2 — repository is append-only (no update/delete APIs)', function() {
  const code = stripComments(fs.readFileSync(
    path.join(ROOT, 'Repositories/ScheduleChangeRepository.js'),
    'utf8'
  ));
  assert.strictEqual(/updateRowByColumn/.test(code), false);
  assert.strictEqual(/deleteRowsByNumbers/.test(code), false);
  assert.ok(/appendRow/.test(code));
  assert.ok(/Lock\.runExclusive/.test(code));
});

test('M4C-L3 — M4-A / M4-B / Router / Availability files are not rewritten by M4-C commands', function() {
  const files = [
    'Application/DoctorAuthorizationService.js',
    'Application/DoctorControlEntry.js',
    'Application/DoctorScheduleReadService.js',
    'Core/Router.js',
    'Repositories/SlotRepository.js',
    'StateMachine.js'
  ];
  files.forEach(function(rel) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.strictEqual(/DoctorScheduleCommandService/.test(code), false, rel);
    assert.strictEqual(/ScheduleChangeRepository/.test(code), false, rel);
  });
});

test('M4C-L4 — projection does not use current time; asOf is explicit', function() {
  const code = stripComments(fs.readFileSync(
    path.join(ROOT, 'Application/EffectiveScheduleService.js'),
    'utf8'
  ));
  assert.strictEqual(/Clock/.test(code), false);
  assert.strictEqual(/new Date\s*\(/.test(code), false);
});

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
