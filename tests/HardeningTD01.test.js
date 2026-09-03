'use strict';

/**
 * HardeningTD01.test.js — TD-01 SlotRepository.atomicUpdate fresh-read semantics
 *
 * Debt Remediation Gate (Post M4-E / Pre M4-F, 2026-09-03).
 *
 * Proves the TD-01 contract:
 *   Case A — slot present: fresh read succeeds → decision executes → update succeeds
 *   Case B — slot absent:  fresh read succeeds → no row → SLOT_NOT_FOUND
 *   Case C — GoogleSheets fresh read throws → Result failure, NOT SLOT_NOT_FOUND
 *   Case D — decisionFn must NOT execute after a read failure
 *   Case E — the 'slot:' + slotId lock boundary remains active on every path
 *   Case F — existing successful/rejected/no-op/UPDATE_FAILED behavior unchanged
 *   Case G — existing callers (Reminder/Booking/Appointment/maintenance) work
 *
 * Real SlotRepository + real Lock over a controlled GoogleSheets mock with
 * source-level failure injection (same pattern as HardeningM4D/M4E).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_ISO = '2026-09-01T06:00:00.000Z'; // 09:00 Asia/Baghdad

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }

// Cross-vm-realm deep equality: the sandbox builds objects with its own
// Object.prototype, so deepStrictEqual's prototype check would false-fail.
function plainDeepStrictEqual(actual, expected, message) {
  assert.deepStrictEqual(jsonClone(actual), jsonClone(expected), message);
}

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    sheets: {},
    failRead: {},
    writes: [],
    updates: 0,
    deletes: 0,
    lockKeys: [],
    events: [],
    appendedRows: [],
    failUpdate: false,
    nowIso: NOW_ISO
  };

  sandbox.LockService = {
    getScriptLock: function() {
      return {
        waitLock: function() { state.events.push('lock:acquire'); },
        releaseLock: function() { state.events.push('lock:release'); }
      };
    }
  };

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(key) {
          if (key === 'DOCTOR_PHONE') return '9647001111111';
          return null;
        }
      };
    }
  };

  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sandbox.Utilities = { formatDate: function(date) { return String(date); } };

  function sheetStore(name) {
    if (!state.sheets[name]) { state.sheets[name] = { headers: [], rows: [] }; }
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
      state.events.push('read:' + name);
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
    appendRows: function(name, rowsArray) {
      const sheet = sheetStore(name);
      for (var i = 0; i < rowsArray.length; i++) {
        var rowObj = {};
        for (var j = 0; j < sheet.headers.length; j++) {
          rowObj[sheet.headers[j]] = rowsArray[i][j];
        }
        sheet.rows.push(rowObj);
        state.appendedRows.push(rowObj);
      }
      return { ok: true, data: { inserted: rowsArray.length } };
    },
    updateRowByColumn: function(name, columnName, value, fields) {
      state.updates += 1;
      state.events.push('update:' + name);
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      if (state.failUpdate) return false;
      for (let i = 0; i < sheet.rows.length; i++) {
        if (sheet.rows[i][columnName] === value) {
          Object.keys(fields).forEach(function(key) {
            if (sheet.headers.indexOf(key) !== -1) { sheet.rows[i][key] = fields[key]; }
          });
          return true;
        }
      }
      return false;
    },
    updateBatch: function() { throw new Error('TD01_MUST_NOT_UPDATE_BATCH'); },
    deleteRowsByNumbers: function() { state.deletes += 1; throw new Error('TD01_MUST_NOT_DELETE'); }
  };

  sandbox.GoogleCalendar = {
    createEvent: function() { throw new Error('TD01_MUST_NOT_CALENDAR'); },
    deleteEvent: function() { throw new Error('TD01_MUST_NOT_CALENDAR'); }
  };

  sandbox.WhatsAppAdapter = {
    sendMessage: function() { return sandbox.Result.ok({ sent: true }); }
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
  load('LogRepository.js', 'LogRepository');
  sandbox.LogRepository.write = function() {};
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('Slotselection.js', 'SlotSelection');
  load('Reminderservice.js', 'ReminderService');
  load('AppointmentRepository.js', 'AppointmentRepository');
  load('Application/BookingService.js', 'BookingService');

  // Deterministic sort_key interpretation for the test host (the real
  // parser builds Dates in the script timezone; production runs pinned to
  // Asia/Baghdad via appsscript.json). Same override as HardeningM4CC.
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
const REPO = sandbox.SlotRepository;
const Result = sandbox.Result;

const AVAIL_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];

function reset() {
  state.sheets = {};
  state.failRead = {};
  state.failUpdate = false;
  state.writes = [];
  state.updates = 0;
  state.deletes = 0;
  state.lockKeys = [];
  state.events = [];
  state.nowIso = NOW_ISO;
}

function seedSlot(fields) {
  if (!state.sheets['Availability']) {
    state.sheets['Availability'] = { headers: AVAIL_HEADERS.slice(), rows: [] };
  }
  const slot = Object.assign({
    slot_id: 'SLT_TEST_01',
    date: '2026/09/01',
    time: '10:00',
    sort_key: '202609011000',
    status: 'FREE',
    is_available: true,
    patient_name: '',
    phone: '',
    calendar_event_id: '',
    Reminder_sent: false,
    whatsapp_message_id: '',
    reserved_until: '',
    reserved_until_unix: ''
  }, fields);
  state.sheets['Availability'].rows.push(slot);
  return slot;
}

function availRow(idx) { return state.sheets['Availability'].rows[idx || 0]; }

// ══════════════════════════════════════════════════════════
// Case A — fresh read succeeds → decision executes → update succeeds
// ══════════════════════════════════════════════════════════

test('TD01-A1 — present slot: fresh read, decision executes, update succeeds', function() {
  reset();
  seedSlot({ slot_id: 'SLT_A1' });

  let decisionSaw = null;
  const result = REPO.atomicUpdate('SLT_A1', function(freshSlot) {
    decisionSaw = freshSlot.status;
    return Result.ok({ status: 'RESERVED', phone: '9647009999999' });
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(decisionSaw, 'FREE');
  assert.strictEqual(availRow().status, 'RESERVED');
  assert.strictEqual(availRow().phone, '9647009999999');
  assert.strictEqual(state.updates, 1);
  plainDeepStrictEqual(
    result.data,
    { slotId: 'SLT_A1', status: 'RESERVED', phone: '9647009999999' }
  );
});

test('TD01-A2 — decisionFn receives the fresh row, not a pre-lock snapshot', function() {
  reset();
  const row = seedSlot({ slot_id: 'SLT_A2' });

  // Simulate a concurrent writer landing before the atomic boundary.
  row.status = 'CONFIRMED';

  let saw = null;
  REPO.atomicUpdate('SLT_A2', function(freshSlot) {
    saw = freshSlot.status;
    return Result.ok({});
  });
  assert.strictEqual(saw, 'CONFIRMED', 'fresh read must see the post-snapshot state');
});

// ══════════════════════════════════════════════════════════
// Case B — successful read + missing row → SLOT_NOT_FOUND
// ══════════════════════════════════════════════════════════

test('TD01-B1 — missing row (read succeeds): SLOT_NOT_FOUND, no decision, no write', function() {
  reset();
  state.sheets['Availability'] = { headers: AVAIL_HEADERS.slice(), rows: [] };

  let called = 0;
  const result = REPO.atomicUpdate('SLT_MISSING', function() {
    called += 1;
    return Result.ok({ status: 'RESERVED' });
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'SLOT_NOT_FOUND');
  assert.strictEqual(result.error.message, 'Slot SLT_MISSING does not exist');
  assert.strictEqual(called, 0);
  assert.strictEqual(state.updates, 0);
});

// ══════════════════════════════════════════════════════════
// Case C — storage read failure → Result failure, NOT SLOT_NOT_FOUND
// ══════════════════════════════════════════════════════════

test('TD01-C1 — injected GoogleSheets read failure: Result.fail, not SLOT_NOT_FOUND', function() {
  reset();
  seedSlot({ slot_id: 'SLT_C1' });
  state.failRead['Availability'] = true;

  const result = REPO.atomicUpdate('SLT_C1', function() {
    return Result.ok({ status: 'RESERVED' });
  });

  assert.strictEqual(result.ok, false);
  assert.notStrictEqual(result.error.code, 'SLOT_NOT_FOUND');
  assert.strictEqual(result.error.code, 'SLOT_READ_FAILED');
  assert.strictEqual(state.updates, 0);
});

test('TD01-C2 — storage failure surfaces diagnostic evidence, not absence', function() {
  reset();
  seedSlot({ slot_id: 'SLT_C2' });
  state.failRead['Availability'] = true;

  const result = REPO.atomicUpdate('SLT_C2', function() {
    return Result.ok({ status: 'RESERVED' });
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.details.slotId, 'SLT_C2');
  assert.ok(
    String(result.error.details.message).indexOf('INJECTED_READ_FAILURE') !== -1,
    'underlying storage message must be preserved in details'
  );
  assert.ok(
    String(result.error.message).indexOf('storage failure, not absence') !== -1
  );
});

test('TD01-C3 — failure injection goes through the REAL repository read path', function() {
  // No repository monkey-patching: the failure is injected only at the
  // GoogleSheets layer (same standard as M4E-M15 source-level injection).
  reset();
  seedSlot({ slot_id: 'SLT_C3' });
  state.failRead['Availability'] = true;

  const direct = REPO.findByIdResult('SLT_C3');
  assert.strictEqual(direct.ok, false);
  assert.strictEqual(direct.error.code, 'SLOT_READ_FAILED');

  const legacy = REPO.findById('SLT_C3');
  assert.strictEqual(legacy, null, 'legacy findById contract stays unchanged');
});

// ══════════════════════════════════════════════════════════
// Case D — decisionFn must NOT execute after a read failure
// ══════════════════════════════════════════════════════════

test('TD01-D1 — read failure short-circuits before decisionFn', function() {
  reset();
  seedSlot({ slot_id: 'SLT_D1' });
  state.failRead['Availability'] = true;

  let called = 0;
  const result = REPO.atomicUpdate('SLT_D1', function() {
    called += 1;
    return Result.ok({ status: 'RESERVED' });
  });

  assert.strictEqual(called, 0, 'decisionFn must not run on a failed fresh read');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'SLOT_READ_FAILED');
});

// ══════════════════════════════════════════════════════════
// Case E — lock boundary remains active and correctly ordered
// ══════════════════════════════════════════════════════════

test('TD01-E1 — success path: acquire → read → update → release, key slot:<id>', function() {
  reset();
  seedSlot({ slot_id: 'SLT_E1' });

  REPO.atomicUpdate('SLT_E1', function() {
    return Result.ok({ status: 'RESERVED' });
  });

  assert.deepStrictEqual(state.lockKeys, ['slot:SLT_E1']);
  assert.deepStrictEqual(
    state.events,
    ['lock:acquire', 'read:Availability', 'update:Availability', 'lock:release']
  );
});

test('TD01-E2 — read failure path: lock still acquired and released, no leaked boundary', function() {
  reset();
  seedSlot({ slot_id: 'SLT_E2' });
  state.failRead['Availability'] = true;

  const result = REPO.atomicUpdate('SLT_E2', function() { return Result.ok({}); });

  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(state.lockKeys, ['slot:SLT_E2']);
  assert.deepStrictEqual(state.events, ['lock:acquire', 'lock:release']);
});

test('TD01-E3 — SLOT_NOT_FOUND path also runs inside the lock (no bypass)', function() {
  reset();
  state.sheets['Availability'] = { headers: AVAIL_HEADERS.slice(), rows: [] };

  REPO.atomicUpdate('SLT_E3_MISSING', function() { return Result.ok({}); });

  assert.deepStrictEqual(state.lockKeys, ['slot:SLT_E3_MISSING']);
  assert.ok(state.events[0] === 'lock:acquire');
  assert.ok(state.events[state.events.length - 1] === 'lock:release');
});

test('TD01-E4 — structural: atomicUpdate keeps Lock.runExclusive and drops legacy findById inside the boundary', function() {
  const src = fs.readFileSync(path.join(ROOT, 'Repositories/SlotRepository.js'), 'utf8');
  const body = src.slice(
    src.indexOf('atomicUpdate: function(slotId, decisionFn)'),
    src.indexOf('cleanupExpiredReservation:')
  );
  assert.ok(body.length > 100);
  assert.ok(
    body.indexOf("Lock.runExclusive('slot:' + slotId, function()") !== -1,
    'lock key/semantics must remain exactly "slot:" + slotId'
  );
  assert.ok(
    body.indexOf('SlotRepository.findByIdResult(slotId)') !== -1,
    'fresh read must go through the Result-based helper'
  );
  assert.ok(
    body.indexOf('SlotRepository.findById(slotId)') === -1,
    'legacy swallowing findById must no longer back the atomic fresh read'
  );
  assert.ok(
    body.indexOf("'SLOT_NOT_FOUND'") !== -1,
    'SLOT_NOT_FOUND must remain defined for genuine absence'
  );
  // Legacy read contract preserved untouched (backward compatibility).
  const repoSrc = src;
  assert.ok(repoSrc.indexOf("findById: function(slotId)") !== -1);
  assert.ok(repoSrc.indexOf('catch (e) {\n      return null;\n    }') !== -1);
});

// ══════════════════════════════════════════════════════════
// Case F — existing atomicUpdate behavior remains unchanged
// ══════════════════════════════════════════════════════════

test('TD01-F1 — decision rejection passes through verbatim, zero writes', function() {
  reset();
  seedSlot({ slot_id: 'SLT_F1', status: 'CONFIRMED' });

  const rejection = Result.fail('INVALID_TRANSITION', 'CONFIRMED cannot ReserveSlot', { x: 1 });
  const result = REPO.atomicUpdate('SLT_F1', function() { return rejection; });

  assert.strictEqual(result, rejection, 'rejection must pass through by reference');
  assert.strictEqual(state.updates, 0);
});

test('TD01-F2 — empty-patch decision is a verified no-op: ok({slotId}), zero writes', function() {
  reset();
  seedSlot({ slot_id: 'SLT_F2', status: 'COMPLETED' });

  const result = REPO.atomicUpdate('SLT_F2', function() { return Result.ok({}); });

  assert.strictEqual(result.ok, true);
  plainDeepStrictEqual(result.data, { slotId: 'SLT_F2' });
  assert.strictEqual(state.updates, 0);
});

test('TD01-F3 — write failure after a good read still yields UPDATE_FAILED', function() {
  reset();
  seedSlot({ slot_id: 'SLT_F3' });
  state.failUpdate = true; // row exists for the fresh read; the write itself fails

  const result = REPO.atomicUpdate('SLT_F3', function() {
    return Result.ok({ status: 'RESERVED' });
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'UPDATE_FAILED');
  plainDeepStrictEqual(result.error.details, {
    slotId: 'SLT_F3',
    data: { status: 'RESERVED' }
  });
});

test('TD01-F4 — success payload shape is exactly {slotId} + decision.data', function() {
  reset();
  seedSlot({ slot_id: 'SLT_F4' });

  const result = REPO.atomicUpdate('SLT_F4', function() {
    return Result.ok({ calendar_event_id: 'EVT_42' });
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(Object.keys(result.data).sort(), ['calendar_event_id', 'slotId']);
});

// ══════════════════════════════════════════════════════════
// Case G — existing callers continue to work (real atomic boundary)
// ══════════════════════════════════════════════════════════

test('TD01-G1 — ReminderService.markReminderSent writes through the fixed boundary', function() {
  reset();
  seedSlot({ slot_id: 'SLT_G1' });

  const result = sandbox.ReminderService.markReminderSent('SLT_G1');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(availRow().Reminder_sent, 'TRUE');
});

test('TD01-G2 — BookingService reserve flow reserves the earliest bookable slot', function() {
  reset();
  seedSlot({ slot_id: 'SLT_G2B', sort_key: '202609011200', time: '12:00' });
  seedSlot({ slot_id: 'SLT_G2A', sort_key: '202609011100', time: '11:00' });

  const result = sandbox.BookingService._reserveEarliestBookable(
    '9647002222222', 'Test Patient', new Date('2026-09-01T06:05:00.000Z')
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(availRow(1).slot_id, 'SLT_G2A'); // earliest chosen
  assert.strictEqual(availRow(1).status, 'RESERVED');
  assert.strictEqual(availRow(1).phone, '9647002222222');
  assert.strictEqual(availRow(0).status, 'FREE');
});

test('TD01-G3 — booking race loser still gets documented codes (retry + NO_SLOT_AVAILABLE)', function() {
  reset();
  seedSlot({ slot_id: 'SLT_G3' });

  // Race simulation: the candidate's row is taken right before the atomic
  // boundary — the real atomicUpdate fresh re-read must reject it.
  const original = sandbox.SlotRepository.atomicUpdate;
  let raced = false;
  sandbox.SlotRepository.atomicUpdate = function(slotId, decisionFn) {
    if (!raced && slotId === 'SLT_G3') {
      raced = true;
      availRow().status = 'RESERVED';
      availRow().phone = '9647003333333';
    }
    return original.call(sandbox.SlotRepository, slotId, decisionFn);
  };

  try {
    const result = sandbox.BookingService._reserveEarliestBookable(
      '9647002222222', 'Loser', new Date('2026-09-01T06:05:00.000Z')
    );
    assert.strictEqual(raced, true, 'the atomic boundary must have been exercised');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'NO_SLOT_AVAILABLE');
    assert.strictEqual(availRow(0).phone, '9647003333333', 'winner data untouched');
  } finally {
    sandbox.SlotRepository.atomicUpdate = original;
  }
});

test('TD01-G4 — M4-C §12 SLOT_UNAVAILABLE guard rejects stale candidates at the boundary', function() {
  reset();
  seedSlot({ slot_id: 'SLT_G4' });

  // The optimistic candidate turns is_available=false right before the
  // atomic boundary (e.g. materialization landed): the decision function
  // must reject it — inside the same fresh-read boundary.
  const original = sandbox.SlotRepository.atomicUpdate;
  let raced = false;
  sandbox.SlotRepository.atomicUpdate = function(slotId, decisionFn) {
    if (!raced && slotId === 'SLT_G4') {
      raced = true;
      availRow().is_available = false;
    }
    return original.call(sandbox.SlotRepository, slotId, decisionFn);
  };

  try {
    const result = sandbox.BookingService._reserveEarliestBookable(
      '9647002222222', 'Blocked', new Date('2026-09-01T06:05:00.000Z')
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'NO_SLOT_AVAILABLE');
    assert.notStrictEqual(availRow(0).status, 'RESERVED', 'guard must have rejected the reserve');
    assert.strictEqual(availRow(0).phone, '');
  } finally {
    sandbox.SlotRepository.atomicUpdate = original;
  }
});

test('TD01-G5 — AppointmentRepository.attachCalendarEvent stores event id', function() {
  reset();
  seedSlot({ slot_id: 'SLT_G5' });

  const result = sandbox.AppointmentRepository.attachCalendarEvent('SLT_G5', 'EVT_7');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(availRow().calendar_event_id, 'EVT_7');
});

test('TD01-G6 — maintenance cleanupExpiredReservation path unchanged (legacy contract)', function() {
  reset();
  seedSlot({
    slot_id: 'SLT_G6', status: 'RESERVED',
    phone: '9647002222222', patient_name: 'Old',
    reserved_until_unix: Date.parse(NOW_ISO) - 60000
  });

  const result = sandbox.SlotRepository.cleanupExpiredReservation(
    'SLT_G6', Date.parse(NOW_ISO)
  );

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'CLEANED');
  assert.strictEqual(availRow().status, 'FREE');
  assert.strictEqual(availRow().phone, '');
  assert.deepStrictEqual(state.lockKeys, ['maintenance']);
});

// ══════════════════════════════════════════════════════════
// M4-F readiness — the properties M4-F depends on
// ══════════════════════════════════════════════════════════

test('TD01-H1 — under a read failure a safe-mutation caller can distinguish failure from absence', function() {
  reset();
  seedSlot({ slot_id: 'SLT_H1' });
  state.failRead['Availability'] = true;

  const failure = REPO.atomicUpdate('SLT_H1', function() { return Result.ok({ status: 'RESERVED' }); });
  assert.strictEqual(failure.error.code, 'SLOT_READ_FAILED');

  reset();
  // A present sheet without the row is absence; a missing/unreadable sheet
  // is a storage failure — the two classifications must never collapse.
  state.sheets['Availability'] = { headers: AVAIL_HEADERS.slice(), rows: [] };
  const absence = REPO.atomicUpdate('SLT_H1', function() { return Result.ok({ status: 'RESERVED' }); });
  assert.strictEqual(absence.error.code, 'SLOT_NOT_FOUND');

  // The two outcomes must never be conflated by any consumer path.
  assert.notStrictEqual(failure.error.code, absence.error.code);
});

test('TD01-H2 — findByIdResult helper is Result-based, small, and backward compatible', function() {
  reset();
  seedSlot({ slot_id: 'SLT_H2' });

  const hit = REPO.findByIdResult('SLT_H2');
  assert.strictEqual(hit.ok, true);
  assert.strictEqual(hit.data.slot_id, 'SLT_H2');

  const miss = REPO.findByIdResult('SLT_H2_MISSING');
  assert.strictEqual(miss.ok, true);
  assert.strictEqual(miss.data, null, 'absence is a SUCCESSFUL read with no row');

  state.failRead['Availability'] = true;
  const failed = REPO.findByIdResult('SLT_H2');
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.error.code, 'SLOT_READ_FAILED');
});

// ── Runner ──

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
console.log('\n' + (tests.length - failures) + '/' + tests.length + ' tests passed');
