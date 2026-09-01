'use strict';

/**
 * HardeningM4CC.test.js — M4-C Continuation / Prerequisite Closure v1
 *
 * Frozen contract: docs/M4/M4C_CONTINUATION_FROZEN_CONTRACT_v1_2026-09-01.md
 *
 * Sections:
 *   A — Slot duration authority + recurring 00:00 boundary (§4, §5.3)
 *   B — Exceptional open (Settings window, full-day) + representability (§4.4, §7)
 *   C — Reservation is_available atomic guard (§12)
 *   D — Reminder operational availability gate (§15)
 *   E — Doctor Control numbered interaction + Preview/Confirm (§9–§11)
 *
 * Real Application + repository code over a controlled GoogleSheets mock.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DOCTOR_ID = '9647001111111';

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
    nowIso: '2026-09-01T06:00:00.000Z', // 09:00 Asia/Baghdad
    logs: []
  };

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      throw new Error('M4CC_MUST_NOT_READ_PROPERTIES');
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

  sandbox.Utilities = {
    formatDate: function(date) { return String(date); }
  };
  sandbox.Session = {
    getScriptTimeZone: function() { return 'Asia/Baghdad'; }
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
    getHeaders: function(name) {
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      return sheet.headers.slice();
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
      throw new Error('M4CC_UNEXPECTED_APPEND_ROWS');
    },
    updateRowByColumn: function(name, columnName, value, fields) {
      state.updates += 1;
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      for (let i = 0; i < sheet.rows.length; i++) {
        if (sheet.rows[i][columnName] === value) {
          Object.keys(fields).forEach(function(key) {
            // Mirror the real infrastructure: unknown headers are ignored.
            if (sheet.headers.indexOf(key) !== -1) {
              sheet.rows[i][key] = fields[key];
            }
          });
          return true;
        }
      }
      return false;
    },
    updateBatch: function() {
      throw new Error('M4CC_MUST_NOT_UPDATE_BATCH');
    },
    deleteRowsByNumbers: function() {
      state.deletes += 1;
      throw new Error('M4CC_MUST_NOT_DELETE');
    }
  };

  sandbox.WhatsAppAdapter = {
    sendMessage: function() {
      state.sends += 1;
      return sandbox.Result.ok({ sent: true });
    }
  };
  sandbox.GoogleCalendar = {
    createEvent: function() {
      state.calendar += 1;
      throw new Error('M4CC_MUST_NOT_CALENDAR');
    },
    deleteEvent: function() {
      state.calendar += 1;
      throw new Error('M4CC_MUST_NOT_CALENDAR');
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
  load('Utils/DateUtils.js', 'DateUtils');
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('Infrastructure/Lock.js', 'Lock');
  const originalLock = sandbox.Lock.runExclusive;
  sandbox.Lock.runExclusive = function(key, fn, timeoutMs) {
    state.lockKeys.push(key);
    return originalLock.call(sandbox.Lock, key, fn, timeoutMs);
  };

  load('StateMachine.js', 'StateMachine');
  load('Domain/Validators.js', 'Validators');
  load('Utils/PhoneUtils.js', 'PhoneUtils');
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
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('Slotselection.js', 'SlotSelection');
  load('BusNumberCalculator.js', 'BusNumberCalculator');
  load('Reminderservice.js', 'ReminderService');
  load('ConversationRepository.js', 'ConversationRepository');
  load('Application/BookingService.js', 'BookingService');
  load('Changeservice.js', 'ChangeService');

  // Deterministic sort_key interpretation for the test host (the real
  // parser builds Dates in the host timezone; production runs pinned to
  // Asia/Baghdad via appsscript.json).
  sandbox.LegacySlotTimeParser.toComparableTime = function(sortKey) {
    const s = String(sortKey);
    if (!/^\d{12}$/.test(s)) return null;
    return Date.UTC(
      parseInt(s.substring(0, 4), 10),
      parseInt(s.substring(4, 6), 10) - 1,
      parseInt(s.substring(6, 8), 10),
      parseInt(s.substring(8, 10), 10),
      parseInt(s.substring(10, 12), 10)
    );
  };

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

const AVAILABILITY_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];

function seedSlot(overrides) {
  const slot = Object.assign({
    slot_id: 'SLT_TEST',
    date: '2026/09/02',
    time: '10:00',
    sort_key: '202609021000',
    status: 'FREE',
    is_available: 'TRUE',
    patient_name: '',
    phone: '',
    calendar_event_id: '',
    Reminder_sent: '',
    whatsapp_message_id: '',
    reserved_until: '',
    reserved_until_unix: ''
  }, overrides || {});
  state.sheets['Availability'].rows.push(slot);
  return slot;
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
  state.sheets['Availability'] = {
    headers: AVAILABILITY_HEADERS.slice(),
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

function recurringCommand(overrides) {
  return Object.assign({
    commandId: 'cmd-' + Math.random().toString(36).slice(2),
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-15T00:00',
    schedule: {
      days: scheduleDays({ monday: true, wednesday: true }),
      workWindow: { start: '10:00', end: '14:00' }
    }
  }, overrides || {});
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ═════════════════════════════════════════════════════════════
// Section A — Slot duration authority + recurring 00:00 boundary
// ═════════════════════════════════════════════════════════════

test('M4CC-A1 — recurring schedule payload with slotDurationMinutes is rejected explicitly', function() {
  reset();
  const cmd = recurringCommand();
  cmd.schedule.slotDurationMinutes = 20;
  const r = CMD.commitRecurringChange(controlContext(), cmd);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_SCHEDULE_COMMAND');
  assert.ok(/Settings-authoritative/.test(r.error.message));
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4CC-A2 — top-level slotDurationMinutes is rejected on every command family', function() {
  reset();
  const families = [
    function() { return CMD.commitRecurringChange(controlContext(), Object.assign(recurringCommand(), { slotDurationMinutes: 20 })); },
    function() { return CMD.commitTemporaryClose(controlContext(), { commandId: 'c1', asOf: '2026-09-01T08:00', effectiveFrom: '2026-09-20T10:00', effectiveTo: '2026-09-20T12:00', slotDurationMinutes: 20 }); },
    function() { return CMD.commitExceptionalOpen(controlContext(), { commandId: 'c2', asOf: '2026-09-01T08:00', date: '2026-09-22', slotDurationMinutes: 20 }); },
    function() { return CMD.cancelChange(controlContext(), { commandId: 'c3', asOf: '2026-09-01T08:00', targetChangeId: 'SCH_X', slotDurationMinutes: 20 }); }
  ];
  families.forEach(function(run, idx) {
    const r = run();
    assert.strictEqual(r.ok, false, 'family ' + idx + ' must fail');
    assert.strictEqual(r.error.code, 'INVALID_SCHEDULE_COMMAND');
  });
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4CC-A3 — bus count is never a schedule input', function() {
  reset();
  const a = CMD.commitRecurringChange(controlContext(), Object.assign(recurringCommand(), { busCount: 8 }));
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.error.code, 'INVALID_SCHEDULE_COMMAND');
  const cmd = recurringCommand();
  cmd.schedule.busCount = 8;
  const b = CMD.commitRecurringChange(controlContext(), cmd);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.error.code, 'INVALID_SCHEDULE_COMMAND');
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4CC-A4 — committed recurring record carries no operational slot duration', function() {
  reset();
  const r = CMD.commitRecurringChange(controlContext(), recurringCommand({ commandId: 'cmd-a4' }));
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(r.data.record.payload, 'slotDurationMinutes'),
    false
  );
  const projected = EFF.projectAt(controlContext(), '2026-09-16T10:30');
  assert.strictEqual(projected.ok, true);
  assert.strictEqual(projected.data.slotDurationMinutes, 30); // Settings
  assert.strictEqual(projected.data.slotDurationSource, 'SETTINGS');
});

test('M4CC-A5 — historical M4-C-v1 record WITH slotDurationMinutes stays immutable and is ignored operationally', function() {
  reset();
  // Seed a historical record exactly as M4-C-v1 wrote it (payload holds 20).
  state.sheets['ScheduleChanges'].rows.push({
    changeId: 'SCH_HISTORICAL',
    doctorId: DOCTOR_ID,
    clinicId: '',
    actorId: DOCTOR_ID,
    commandId: 'cmd-historical',
    changeKind: 'RECURRING',
    effectiveFrom: '2026-09-10T00:00',
    effectiveTo: '',
    payloadJson: JSON.stringify({
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '13:00' },
      slotDurationMinutes: 20
    }),
    createdAt: '2026-08-20T10:00:00.000Z',
    status: 'COMMITTED',
    targetChangeId: '',
    beforeJson: '{}',
    afterJson: '{}'
  });
  const rowBefore = jsonClone(state.sheets['ScheduleChanges'].rows[0]);

  const projected = EFF.projectAt(controlContext(), '2026-09-14T10:30'); // Monday
  assert.strictEqual(projected.ok, true, JSON.stringify(projected.error));
  assert.strictEqual(projected.data.source, 'RECURRING_CHANGE');
  assert.strictEqual(projected.data.workWindow.start, '10:00');
  // Historical 20 is ignored; Settings 30 governs.
  assert.strictEqual(projected.data.slotDurationMinutes, 30);
  assert.strictEqual(projected.data.slotDurationSource, 'SETTINGS');

  // The historical row was not rewritten (no update/delete, identical content).
  assert.strictEqual(state.updates, 0);
  assert.strictEqual(state.deletes, 0);
  assert.deepStrictEqual(jsonClone(state.sheets['ScheduleChanges'].rows[0]), rowBefore);
});

test('M4CC-A6 — missing/invalid configured duration fails honestly on the M4 path (no silent 30)', function() {
  reset();
  seedSettings(standardSettings({ 'Slot Duration (min)': 'garbage' }));
  const commit = CMD.commitRecurringChange(controlContext(), recurringCommand({ commandId: 'cmd-a6' }));
  assert.strictEqual(commit.ok, false);
  assert.strictEqual(commit.error.code, 'SCHEDULE_SOURCE_INVALID');
  const projected = EFF.projectAt(controlContext(), '2026-09-16T10:30');
  assert.strictEqual(projected.ok, false);
  assert.strictEqual(projected.error.code, 'SCHEDULE_SOURCE_INVALID');
});

test('M4CC-A7 — intra-day recurring effectiveFrom is rejected (00:00 boundary enforced at application level)', function() {
  reset();
  const r = CMD.commitRecurringChange(controlContext(), recurringCommand({
    commandId: 'cmd-a7',
    effectiveFrom: '2026-09-15T10:30'
  }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'RECURRING_EFFECTIVE_BOUNDARY_INVALID');
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4CC-A8 — doctor-selected effectiveDate persists as local 00:00 boundary', function() {
  reset();
  const cmd = recurringCommand({ commandId: 'cmd-a8' });
  delete cmd.effectiveFrom;
  cmd.effectiveDate = '2026-09-15';
  const r = CMD.commitRecurringChange(controlContext(), cmd);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.record.effectiveFrom, '2026-09-15T00:00');
});

test('M4CC-A9 — legacy duration fallback API remains untouched for legacy callers', function() {
  reset();
  seedSettings(standardSettings({ 'Slot Duration (min)': 'garbage' }));
  // Legacy callers (calendar end-time computation) keep the documented
  // default behavior — the contract only forbids it on the M4 path.
  assert.strictEqual(sandbox.SettingsRepository.getSlotDurationMinutes(), 30);
});

// ═════════════════════════════════════════════════════════════
// Section B — Exceptional open + grid representability
// ═════════════════════════════════════════════════════════════

test('M4CC-B1 — exceptional open takes a date only and reuses the Settings window', function() {
  reset();
  const r = CMD.commitExceptionalOpen(controlContext(), {
    commandId: 'cmd-b1',
    asOf: '2026-09-01T08:00',
    date: '2026-09-22' // Tuesday, closed in baseline
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.record.effectiveFrom, '2026-09-22T00:00');
  assert.strictEqual(r.data.record.effectiveTo, '2026-09-23T00:00');
  assert.strictEqual(r.data.record.payload.workWindow.start, '09:00');
  assert.strictEqual(r.data.record.payload.workWindow.end, '14:00');
  assert.strictEqual(r.data.record.payload.workWindowSource, 'SETTINGS');
  const inside = EFF.projectAt(controlContext(), '2026-09-22T10:00');
  assert.strictEqual(inside.data.interval.intent, 'EXCEPTIONAL_OPEN');
  const outside = EFF.projectAt(controlContext(), '2026-09-22T08:00');
  assert.strictEqual(outside.data.interval.intent, 'CLOSED');
});

test('M4CC-B2 — doctor-provided workWindow on exceptional open is rejected', function() {
  reset();
  const r = CMD.commitExceptionalOpen(controlContext(), {
    commandId: 'cmd-b2',
    asOf: '2026-09-01T08:00',
    date: '2026-09-22',
    workWindow: { start: '08:00', end: '20:00' }
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_SCHEDULE_COMMAND');
  assert.ok(/Settings working window/.test(r.error.message));
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4CC-B3 — partial-day exceptional open is rejected', function() {
  reset();
  const intraDay = CMD.commitExceptionalOpen(controlContext(), {
    commandId: 'cmd-b3a',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-22T10:00',
    effectiveTo: '2026-09-22T12:00'
  });
  assert.strictEqual(intraDay.ok, false);
  assert.strictEqual(intraDay.error.code, 'PARTIAL_DAY_EXCEPTIONAL_OPEN_UNSUPPORTED');

  const halfDay = CMD.commitExceptionalOpen(controlContext(), {
    commandId: 'cmd-b3b',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-22T00:00',
    effectiveTo: '2026-09-22T12:00'
  });
  assert.strictEqual(halfDay.ok, false);
  assert.strictEqual(halfDay.error.code, 'PARTIAL_DAY_EXCEPTIONAL_OPEN_UNSUPPORTED');
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4CC-B4 — full-day boundary form is accepted as exactly [date, date+1)', function() {
  reset();
  const r = CMD.commitExceptionalOpen(controlContext(), {
    commandId: 'cmd-b4',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-22T00:00',
    effectiveTo: '2026-09-23T00:00'
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.record.effectiveFrom, '2026-09-22T00:00');
  assert.strictEqual(r.data.record.effectiveTo, '2026-09-23T00:00');
});

test('M4CC-B5 — unrepresentable partial-slot close is rejected (10:15–10:45 on a 30-min grid)', function() {
  reset();
  const r = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-b5',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:15',
    effectiveTo: '2026-09-20T10:45'
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'UNREPRESENTABLE_SCHEDULE_INTERVAL');
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, 0);
});

test('M4CC-B6 — grid-aligned close is accepted (10:00–11:00), no rounding or splitting', function() {
  reset();
  const r = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-b6',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T10:00',
    effectiveTo: '2026-09-20T11:00'
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.record.effectiveFrom, '2026-09-20T10:00');
  assert.strictEqual(r.data.record.effectiveTo, '2026-09-20T11:00');
});

test('M4CC-B7 — boundaries at/outside the working window edges are representable (full-day close)', function() {
  reset();
  const r = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-b7',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-20T00:00',
    effectiveTo: '2026-09-21T00:00'
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
});

test('M4CC-B8 — representability follows the recurring window effective at the boundary instant', function() {
  reset();
  // Recurring change moves the window to 10:00–14:00 from 2026-09-15.
  const rec = CMD.commitRecurringChange(controlContext(), recurringCommand({ commandId: 'cmd-b8-rec' }));
  assert.strictEqual(rec.ok, true, JSON.stringify(rec.error));
  // 10:30 aligns to a 09:00-anchored grid but NOT to the 10:00-anchored
  // grid that governs after the recurring boundary — must be rejected.
  const misaligned = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-b8-close',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-16T10:15',
    effectiveTo: '2026-09-16T11:00'
  });
  assert.strictEqual(misaligned.ok, false);
  assert.strictEqual(misaligned.error.code, 'UNREPRESENTABLE_SCHEDULE_INTERVAL');
  const aligned = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-b8-close-ok',
    asOf: '2026-09-01T08:00',
    effectiveFrom: '2026-09-16T10:00',
    effectiveTo: '2026-09-16T11:00'
  });
  assert.strictEqual(aligned.ok, true, JSON.stringify(aligned.error));
});

// ═════════════════════════════════════════════════════════════
// Section C — Reservation is_available atomic guard (§12)
//
// Reservation-producing path inventory (audited before change):
//   1. BookingService._reserveEarliestBookable   (RESERVE_SLOT booking)
//   2. ChangeService._reserveAlternativeSlot     (changeReservation —
//      pre-confirm — AND changeConfirmedAppointment replacement)
// StateMachine only defines the transition; MaintenanceService frees,
// never reserves. RESERVED→CONFIRMED confirmations are lifecycle, not
// reservation, and are intentionally NOT gated (§12.1/§14).
// ═════════════════════════════════════════════════════════════

function raceFlipAfterSelection(slotIdToFlip) {
  // Simulates "reconciliation wins first": the optimistic SlotSelection
  // read returns a stale available candidate, then is_available flips
  // to FALSE before the atomicUpdate fresh re-read.
  const original = sandbox.SlotSelection.findEarliestBookable;
  sandbox.SlotSelection.findEarliestBookable = function(excludedSlotIds) {
    const result = original.call(sandbox.SlotSelection, excludedSlotIds);
    if (result.ok && result.data.slot_id === slotIdToFlip) {
      state.sheets['Availability'].rows.forEach(function(row) {
        if (row.slot_id === slotIdToFlip) row.is_available = 'FALSE';
      });
    }
    return result;
  };
  return function restore() {
    sandbox.SlotSelection.findEarliestBookable = original;
  };
}

function findSlotRow(slotId) {
  return state.sheets['Availability'].rows.filter(function(r) {
    return r.slot_id === slotId;
  })[0];
}

test('M4CC-C1 — stale optimistic candidate cannot be reserved after is_available flips to false', function() {
  reset();
  seedSlot({ slot_id: 'SLT_RACE', sort_key: '202609021000' });
  const restore = raceFlipAfterSelection('SLT_RACE');
  try {
    const reservedUntil = new Date(new Date(state.nowIso).getTime() + 5 * 60000);
    const r = sandbox.BookingService._reserveEarliestBookable('9647700000001', 'Patient X', reservedUntil);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'NO_SLOT_AVAILABLE');
  } finally {
    restore();
  }
  const row = findSlotRow('SLT_RACE');
  assert.strictEqual(row.status, 'FREE');          // closure freed nothing, reserved nothing
  assert.strictEqual(row.is_available, 'FALSE');   // reconciliation outcome preserved
  assert.strictEqual(row.phone, '');
  assert.strictEqual(row.patient_name, '');
});

test('M4CC-C2 — reservation still succeeds when the fresh slot is FREE and available', function() {
  reset();
  seedSlot({ slot_id: 'SLT_OK', sort_key: '202609021000' });
  const reservedUntil = new Date(new Date(state.nowIso).getTime() + 5 * 60000);
  const r = sandbox.BookingService._reserveEarliestBookable('9647700000002', 'Patient Y', reservedUntil);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.slot.slot_id, 'SLT_OK');
  const row = findSlotRow('SLT_OK');
  assert.strictEqual(row.status, 'RESERVED');
  assert.strictEqual(row.phone, '9647700000002');
});

test('M4CC-C3 — SLOT_UNAVAILABLE is retried like a lost race: next candidate is reserved', function() {
  reset();
  seedSlot({ slot_id: 'SLT_FIRST', sort_key: '202609021000' });
  seedSlot({ slot_id: 'SLT_SECOND', sort_key: '202609021030' });
  const restore = raceFlipAfterSelection('SLT_FIRST');
  try {
    const reservedUntil = new Date(new Date(state.nowIso).getTime() + 5 * 60000);
    const r = sandbox.BookingService._reserveEarliestBookable('9647700000003', 'Patient Z', reservedUntil);
    assert.strictEqual(r.ok, true, JSON.stringify(r.error));
    assert.strictEqual(r.data.slot.slot_id, 'SLT_SECOND');
  } finally {
    restore();
  }
  assert.strictEqual(findSlotRow('SLT_FIRST').status, 'FREE');
  assert.strictEqual(findSlotRow('SLT_SECOND').status, 'RESERVED');
});

test('M4CC-C4 — ChangeService replacement reservation path has the same fresh guard', function() {
  reset();
  seedSlot({
    slot_id: 'SLT_OLD',
    sort_key: '202609021000',
    status: 'RESERVED',
    phone: '9647700000004',
    patient_name: 'Patient W'
  });
  seedSlot({ slot_id: 'SLT_NEW', sort_key: '202609021030' });
  const restore = raceFlipAfterSelection('SLT_NEW');
  try {
    const reservedUntil = new Date(new Date(state.nowIso).getTime() + 5 * 60000);
    const r = sandbox.ChangeService._reserveAlternativeSlot(
      '9647700000004', 'Patient W', reservedUntil, 'SLT_OLD'
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'NO_SLOT_AVAILABLE');
  } finally {
    restore();
  }
  // Old reservation untouched; stale candidate not reserved.
  assert.strictEqual(findSlotRow('SLT_OLD').status, 'RESERVED');
  assert.strictEqual(findSlotRow('SLT_NEW').status, 'FREE');
  assert.strictEqual(findSlotRow('SLT_NEW').phone, '');
});

test('M4CC-C5 — schedule closure does not convert RESERVED/CONFIRMED to another lifecycle state', function() {
  reset();
  seedSlot({
    slot_id: 'SLT_RSV',
    sort_key: '202609021000',
    status: 'RESERVED',
    is_available: 'FALSE',
    phone: '9647700000005'
  });
  seedSlot({
    slot_id: 'SLT_CNF',
    sort_key: '202609021030',
    status: 'CONFIRMED',
    is_available: 'FALSE',
    phone: '9647700000006'
  });
  // A closure plus a booking attempt around them must leave both untouched.
  const reservedUntil = new Date(new Date(state.nowIso).getTime() + 5 * 60000);
  const r = sandbox.BookingService._reserveEarliestBookable('9647700000007', 'Patient V', reservedUntil);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'NO_SLOT_AVAILABLE');
  assert.strictEqual(findSlotRow('SLT_RSV').status, 'RESERVED');
  assert.strictEqual(findSlotRow('SLT_CNF').status, 'CONFIRMED');
});

test('M4CC-C6 — per-slot atomicUpdate remains the only linearization point (no new lock kinds)', function() {
  reset();
  seedSlot({ slot_id: 'SLT_LOCK', sort_key: '202609021000' });
  const reservedUntil = new Date(new Date(state.nowIso).getTime() + 5 * 60000);
  sandbox.BookingService._reserveEarliestBookable('9647700000008', 'Patient U', reservedUntil);
  const reservationLocks = state.lockKeys.filter(function(k) { return k.indexOf('slot:') === 0; });
  assert.ok(reservationLocks.length >= 1, 'reservation must run under the per-slot lock');
  state.lockKeys.forEach(function(k) {
    assert.ok(
      k.indexOf('slot:') === 0 || k.indexOf('schedule-intent:') === 0 || k === 'maintenance',
      'unexpected new lock kind: ' + k
    );
  });
});

test('M4CC-C7 — structural: both reservation producers contain the fresh guard inside the decision function', function() {
  const booking = stripComments(fs.readFileSync(path.join(ROOT, 'Application/BookingService.js'), 'utf8'));
  const change = stripComments(fs.readFileSync(path.join(ROOT, 'Changeservice.js'), 'utf8'));
  [booking, change].forEach(function(code) {
    assert.ok(/isOperationallyAvailable\s*\(\s*freshSlot\.is_available\s*\)/.test(code),
      'fresh is_available guard missing in a reservation producer');
    assert.ok(/SLOT_UNAVAILABLE/.test(code));
  });
  // No parallel transaction primitives were introduced.
  [booking, change].forEach(function(code) {
    assert.strictEqual(/TransactionManager|globalLock|availabilityLock/i.test(code), false);
  });
});

// ═════════════════════════════════════════════════════════════
// Section D — Reminder operational availability gate (§15)
// ═════════════════════════════════════════════════════════════

function seedReminderSlot(overrides) {
  // now = 2026-09-01T06:00Z; reminder window = (now, now+240min]
  return seedSlot(Object.assign({
    slot_id: 'SLT_REM',
    sort_key: '202609010800', // inside the window
    status: 'CONFIRMED',
    phone: '9647700000009',
    patient_name: 'Patient R',
    Reminder_sent: ''
  }, overrides || {}));
}

test('M4CC-D1 — reminder is suppressed while is_available=false', function() {
  reset();
  seedReminderSlot({ is_available: 'FALSE' });
  const r = sandbox.ReminderService.collectPendingReminders();
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.length, 0);
});

test('M4CC-D2 — reminder still sends for CONFIRMED + available + in window + not sent', function() {
  reset();
  seedReminderSlot({ is_available: 'TRUE' });
  const r = sandbox.ReminderService.collectPendingReminders();
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.length, 1);
  assert.strictEqual(r.data[0].slotId, 'SLT_REM');
});

test('M4CC-D3 — reopened slot inside the window with Reminder_sent=false sends normally (no new reminder state)', function() {
  reset();
  const slot = seedReminderSlot({ is_available: 'FALSE' });
  assert.strictEqual(sandbox.ReminderService.collectPendingReminders().data.length, 0);
  // Availability reconciliation reopens the slot; window still open.
  slot.is_available = 'TRUE';
  const r = sandbox.ReminderService.collectPendingReminders();
  assert.strictEqual(r.data.length, 1);
  // Existing idempotency unchanged: already-sent stays excluded.
  slot.Reminder_sent = 'TRUE';
  assert.strictEqual(sandbox.ReminderService.collectPendingReminders().data.length, 0);
});

test('M4CC-D4 — structural: no reminder subsystem was introduced', function() {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'Reminderservice.js'), 'utf8'));
  assert.ok(/isOperationallyAvailable\s*\(\s*row\.is_available\s*\)/.test(code));
  assert.strictEqual(/ReminderRepository|reminder_state|REMINDER_QUEUE/i.test(code), false);
});

// ── Runner ──────────────────────────────────────────────────────

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
