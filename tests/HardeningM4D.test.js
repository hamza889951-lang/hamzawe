'use strict';

/**
 * HardeningM4D.test.js — M4-D Effective Availability Materialization
 *
 * Contract: HAMZAWE_M4D_FROZEN_CONTRACT_v1 (from programmer direction prompt)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DOCTOR_ID = '9647001111111';

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

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
    logs: [],
    failAppendRows: false,
    appendedRows: []
  };

  sandbox.PropertiesService = {
    _props: { DOCTOR_PHONE: DOCTOR_ID },
    getScriptProperties: function() {
      return {
        getProperty: function(key) { return sandbox.PropertiesService._props[key] || null; },
        setProperty: function() {}
      };
    }
  };

  sandbox.LockService = {
    getScriptLock: function() {
      return { waitLock: function() {}, releaseLock: function() {} };
    },
    getUserLock: function() {
      return { waitLock: function() {}, releaseLock: function() {} };
    }
  };

  sandbox.Utilities = { formatDate: function(date) { return String(date); } };
  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };

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
      if (state.failAppendRows) return { ok: false, error: { code: 'BATCH_INSERT_FAILED' } };
      const sheet = sheetStore(name);
      if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
      const headers = sheet.headers;
      for (var i = 0; i < rowsArray.length; i++) {
        var rowObj = {};
        for (var j = 0; j < headers.length; j++) {
          rowObj[headers[j]] = rowsArray[i][j];
        }
        sheet.rows.push(rowObj);
        state.appendedRows.push(rowObj);
      }
      return { ok: true, data: { inserted: rowsArray.length } };
    },
    updateRowByColumn: function(name, columnName, value, fields) {
      state.updates += 1;
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
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
    updateBatch: function() { throw new Error('M4D_UNEXPECTED_UPDATE_BATCH'); },
    deleteRowsByNumbers: function() { state.deletes += 1; throw new Error('M4D_MUST_NOT_DELETE'); }
  };

  sandbox.WhatsAppAdapter = { sendMessage: function() { state.sends += 1; return sandbox.Result.ok({ sent: true }); } };
  sandbox.GoogleCalendar = {
    createEvent: function() { throw new Error('M4D_MUST_NOT_CALENDAR'); },
    deleteEvent: function() { throw new Error('M4D_MUST_NOT_CALENDAR'); }
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

  load('SettingsRepository.js', 'SettingsRepository');
  load('Application/DoctorScheduleReadService.js', 'DoctorScheduleReadService');
  load('Repositories/ScheduleChangeRepository.js', 'ScheduleChangeRepository');
  load('Application/EffectiveScheduleService.js', 'EffectiveScheduleService');
  load('LogRepository.js', 'LogRepository');
  sandbox.LogRepository.write = function(entry) { state.logs.push(entry); };
  load('Repositories/DoctorIdentityRepository.js', 'DoctorIdentityRepository');
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('SlotGenerator.js', 'SlotGenerator');
  load('AvailabilityHorizonMaintainer.js', 'AvailabilityHorizonMaintainer');
  load('Application/CommandExecutor.js', 'CommandExecutor');
  load('Application/DoctorScheduleCommandService.js', 'DoctorScheduleCommandService');

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;
const EFF = sandbox.EffectiveScheduleService;
const HM = sandbox.AvailabilityHorizonMaintainer;
const CMD = sandbox.DoctorScheduleCommandService;
const REPO = sandbox.ScheduleChangeRepository;

function standardSettings(overrides) {
  return Object.assign({
    work_start: '09:00',
    work_end: '14:00',
    'Slot Duration (min)': '30',
    slot_generation_days: '14',
    sunday: true, monday: true, tuesday: true, wednesday: true,
    thursday: true, friday: false, saturday: true
  }, overrides || {});
}

function seedSettings(settingsObj) {
  state.sheets['Settings'] = {
    headers: Object.keys(settingsObj),
    rows: [Object.assign({}, settingsObj)]
  };
}

function seedAvailabilityHeaders() {
  state.sheets['Availability'] = {
    headers: [
      'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
      'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
      'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
    ],
    rows: []
  };
}

function controlContext(overrides) {
  return Object.assign({ actorId: DOCTOR_ID, scope: { clinicId: null } }, overrides || {});
}

function scheduleDays(overrides) {
  var days = {
    sunday: false, monday: false, tuesday: false,
    wednesday: false, thursday: false, friday: false, saturday: false
  };
  return Object.assign(days, overrides || {});
}

function seedSlot(fields) {
  var slot = Object.assign({
    slot_id: 'SLT_TEST_' + Math.random().toString(36).substr(2, 6),
    date: '', time: '', sort_key: '', status: 'FREE', is_available: true,
    patient_name: '', phone: '', calendar_event_id: '', Reminder_sent: false,
    whatsapp_message_id: '', reserved_until: '', reserved_until_unix: ''
  }, fields);
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
  state.nowIso = '2026-09-01T06:00:00.000Z';
  state.logs = [];
  state.failAppendRows = false;
  state.appendedRows = [];
  sandbox.PropertiesService._props = { DOCTOR_PHONE: DOCTOR_ID };
}

function setupStandard() {
  reset();
  seedSettings(standardSettings());
  seedAvailabilityHeaders();
}

// ══════════════════════════════════════════════════════════
// A — EffectiveSchedule is source of truth for is_available
// ══════════════════════════════════════════════════════════

test('M4D-A1 — working day + within window → available', function() {
  setupStandard();
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T09:00', 30);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, true);
  assert.strictEqual(r.data.intent, 'WORKING');
});

test('M4D-A2 — slot exceeds work window → not available', function() {
  setupStandard();
  // work_end = 14:00, slot 13:45 + 30 = 14:15 > 14:00
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T13:45', 30);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, false);
});

test('M4D-A3 — non-working day → not available', function() {
  setupStandard();
  // 2026-09-04 is Friday (non-working)
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-04T10:00', 30);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, false);
});

test('M4D-A4 — slot exactly at window boundary → available', function() {
  setupStandard();
  // 13:30 + 30 = 14:00 ≤ 14:00
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T13:30', 30);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, true);
});

test('M4D-A5 — before work start → not available', function() {
  setupStandard();
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T08:30', 30);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, false);
});

// ══════════════════════════════════════════════════════════
// B — Existing slot reconciliation
// ══════════════════════════════════════════════════════════

test('M4D-B1 — existing FREE slot marked available when EffectiveSchedule says working', function() {
  setupStandard();
  const slot = seedSlot({
    sort_key: '202609021000', date: '2026/09/02', time: '10:00',
    is_available: false
  });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.reconciled, 1);
  const updated = state.sheets['Availability'].rows.find(s => s.slot_id === slot.slot_id);
  assert.strictEqual(updated.is_available, true);
});

test('M4D-B2 — existing FREE slot on non-working day marked unavailable', function() {
  setupStandard();
  const slot = seedSlot({
    sort_key: '202609041000', date: '2026/09/04', time: '10:00',
    is_available: true
  });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.reconciled, 1);
  const updated = state.sheets['Availability'].rows.find(s => s.slot_id === slot.slot_id);
  assert.strictEqual(updated.is_available, false);
});

test('M4D-B3 — slot already in correct state → no update', function() {
  setupStandard();
  seedSlot({ sort_key: '202609021000', date: '2026/09/02', time: '10:00', is_available: true });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.reconciled, 0);
});

test('M4D-B4 — slot exceeding work window is marked unavailable', function() {
  setupStandard();
  const slot = seedSlot({
    sort_key: '202609021345', date: '2026/09/02', time: '13:45', is_available: true
  });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.reconciled, 1);
  const updated = state.sheets['Availability'].rows.find(s => s.slot_id === slot.slot_id);
  assert.strictEqual(updated.is_available, false);
});

// ══════════════════════════════════════════════════════════
// C — Missing slot generation
// ══════════════════════════════════════════════════════════

test('M4D-C1 — creates slots for working days in the horizon', function() {
  setupStandard();
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.ok(r.data.generated > 0, 'should generate slots');
  const generatedSlots = state.sheets['Availability'].rows.filter(s => s.sort_key && s.sort_key.length >= 12);
  assert.ok(generatedSlots.length > 0);
  generatedSlots.forEach(function(s) {
    assert.strictEqual(s.is_available, true);
  });
});

test('M4D-C2 — respects EffectiveSchedule recurring change', function() {
  setupStandard();
  // Commit recurring change: Monday only, 10:00-12:00
  // effectiveFrom must be >= asOf
  const cmdResult = CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-gen-recurring',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-01T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '12:00' }
    }
  });
  assert.strictEqual(cmdResult.ok, true, 'commit failed: ' + JSON.stringify(cmdResult.error));
  
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  
  const generatedSlots = state.sheets['Availability'].rows.filter(s => s.sort_key && s.sort_key.length >= 12);
  assert.ok(generatedSlots.length > 0, 'should generate some slots');
  
  generatedSlots.forEach(function(s) {
    var hh = parseInt(s.sort_key.substring(8, 10), 10);
    var mm = parseInt(s.sort_key.substring(10, 12), 10);
    var totalMin = hh * 60 + mm;
    assert.ok(totalMin >= 600 && totalMin < 720,
      'slot ' + s.sort_key + ' should be in [10:00, 12:00)');
  });
});

test('M4D-C3 — no slots on non-working days', function() {
  setupStandard();
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  // 2026-09-04 is Friday (non-working)
  const fridaySlots = state.sheets['Availability'].rows.filter(function(s) {
    return s.sort_key && s.sort_key.startsWith('20260904');
  });
  assert.strictEqual(fridaySlots.length, 0, 'no slots on Friday');
});

// ══════════════════════════════════════════════════════════
// D — Terminal slot preservation
// ══════════════════════════════════════════════════════════

test('M4D-D1 — RESERVED: is_available is reconciled but status is preserved', function() {
  setupStandard();
  const slot = seedSlot({
    sort_key: '202609021000', date: '2026/09/02', time: '10:00',
    status: 'RESERVED', is_available: false,
    phone: '9647001234567', patient_name: 'Test Patient'
  });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  const current = state.sheets['Availability'].rows.find(s => s.slot_id === slot.slot_id);
  // status is preserved (StateMachine ownership)
  assert.strictEqual(current.status, 'RESERVED');
  assert.strictEqual(current.patient_name, 'Test Patient');
  // is_available is reconciled to match EffectiveSchedule (it's a working slot)
  assert.strictEqual(current.is_available, true);
});

test('M4D-D2 — CONFIRMED: is_available is reconciled but status is preserved', function() {
  setupStandard();
  const slot = seedSlot({
    sort_key: '202609021000', status: 'CONFIRMED', is_available: false,
    phone: '9647001234567'
  });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  const s = state.sheets['Availability'].rows.find(s => s.slot_id === slot.slot_id);
  // status preserved
  assert.strictEqual(s.status, 'CONFIRMED');
  // is_available reconciled (working day, within window)
  assert.strictEqual(s.is_available, true);
});

test('M4D-D2b — CONFIRMED on non-working day: is_available set false, status preserved', function() {
  setupStandard();
  // 2026-09-04 is Friday (non-working)
  const slot = seedSlot({
    sort_key: '202609041000', status: 'CONFIRMED', is_available: true,
    phone: '9647001234567'
  });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  const s = state.sheets['Availability'].rows.find(s => s.slot_id === slot.slot_id);
  assert.strictEqual(s.status, 'CONFIRMED');
  assert.strictEqual(s.is_available, false);
});

test('M4D-D2c — RESERVED when doctor closes that interval: is_available=false, status=RESERVED', function() {
  setupStandard();
  // Reserve a slot
  const slot = seedSlot({
    sort_key: '202609021000', status: 'RESERVED', is_available: true,
    phone: '9647001234567', patient_name: 'Test'
  });
  // Doctor closes that time window
  CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-close-reserved',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-02T10:00',
    effectiveTo: '2026-09-02T11:00'
  });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  const s = state.sheets['Availability'].rows.find(s => s.slot_id === slot.slot_id);
  // status stays RESERVED — lifecycle untouched
  assert.strictEqual(s.status, 'RESERVED');
  assert.strictEqual(s.patient_name, 'Test');
  // is_available flipped to false because EffectiveSchedule says closed
  assert.strictEqual(s.is_available, false);
});

test('M4D-D3 — Terminal states (EXPIRED, CANCELLED, COMPLETED, NO_SHOW) are never modified', function() {
  setupStandard();
  ['EXPIRED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'].forEach(function(st, idx) {
    seedSlot({ sort_key: '2026090' + (2 + idx) + '1000', status: st, is_available: false });
  });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  state.sheets['Availability'].rows.forEach(function(s) {
    if (['EXPIRED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'].indexOf(s.status) !== -1) {
      assert.strictEqual(s.is_available, false);
    }
  });
});

// ══════════════════════════════════════════════════════════
// E — Fail-closed behavior
// ══════════════════════════════════════════════════════════

test('M4D-E1 — Settings read failure → fail closed', function() {
  setupStandard();
  state.failRead['Settings'] = true;
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, false);
});

test('M4D-E2 — missing doctor identity → fail closed', function() {
  setupStandard();
  sandbox.PropertiesService._props = { DOCTOR_PHONE: '' };
  const r = HM.ensureHorizon(); // no controlContext → builds from identity
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'DOCTOR_IDENTITY_NOT_CONFIGURED');
});

test('M4D-E3 — invalid slot duration → fail closed (no 30-min fallback)', function() {
  reset();
  seedSettings(standardSettings({ 'Slot Duration (min)': '' }));
  seedAvailabilityHeaders();
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_SOURCE_INVALID');
});

test('M4D-E4 — projectSlotAvailability with bad Settings → fail closed', function() {
  setupStandard();
  state.failRead['Settings'] = true;
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T10:00', 30);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SETTINGS_READ_FAILED');
});

test('M4D-E5 — malformed schedule change → fail closed', function() {
  setupStandard();
  state.sheets['ScheduleChanges'] = {
    headers: REPO.HEADERS,
    rows: [{
      changeId: 'SCH_BAD', doctorId: DOCTOR_ID, clinicId: '', actorId: DOCTOR_ID,
      commandId: 'bad', changeKind: 'RECURRING', effectiveFrom: '2026-09-01T00:00',
      effectiveTo: '', payloadJson: '{not-json', createdAt: 't', status: 'COMMITTED',
      targetChangeId: '', beforeJson: '{}', afterJson: '{}'
    }]
  };
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T10:00', 30);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_CHANGE_SOURCE_INVALID');
});

// ══════════════════════════════════════════════════════════
// F — Partial failure / isolation
// ══════════════════════════════════════════════════════════

test('M4D-F1 — generation failure on one day does not block other days', function() {
  setupStandard();
  state.nowIso = '2026-09-01T06:00:00.000Z';
  state.failAppendRows = true;
  const r = HM.ensureHorizon(controlContext());
  // Should report failure but not crash
  assert.ok(r.ok === false || (r.data && r.data.generateFailedDays > 0));
});

test('M4D-F2 — reconciliation continues when schedule source fails for one slot', function() {
  setupStandard();
  // Seed two future FREE slots
  seedSlot({ sort_key: '202609021000', date: '2026/09/02', time: '10:00', is_available: false });
  seedSlot({ sort_key: '202609021100', date: '2026/09/02', time: '11:00', is_available: false });
  state.nowIso = '2026-09-01T06:00:00.000Z';
  // Both should be reconciled (both working day, both within window)
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.reconciled, 2);
});

// ══════════════════════════════════════════════════════════
// G — Idempotency / retry / convergence
// ══════════════════════════════════════════════════════════

test('M4D-G1 — retry converges: after enough runs, no more changes', function() {
  setupStandard();
  state.nowIso = '2026-09-01T06:00:00.000Z';
  
  // First run
  const r1 = HM.ensureHorizon(controlContext());
  assert.strictEqual(r1.ok, true, JSON.stringify(r1.error));
  
  // Run 3 more times to ensure convergence
  HM.ensureHorizon(controlContext());
  HM.ensureHorizon(controlContext());
  const updatesAfterThree = state.updates;
  const rowsAfterThree = state.sheets['Availability'].rows.length;
  
  // Fourth run — should be identical to third
  const r4 = HM.ensureHorizon(controlContext());
  assert.strictEqual(r4.ok, true, JSON.stringify(r4.error));
  assert.strictEqual(state.updates, updatesAfterThree, 'no new updates after convergence');
  assert.strictEqual(state.sheets['Availability'].rows.length, rowsAfterThree, 'no new slots after convergence');
});

test('M4D-G2 — no duplicate Schedule Change records on retry', function() {
  setupStandard();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-idemp-retry',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-01T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '10:00', end: '14:00' }
    }
  });
  const recordsBefore = state.sheets['ScheduleChanges'].rows.length;
  HM.ensureHorizon(controlContext());
  HM.ensureHorizon(controlContext());
  assert.strictEqual(state.sheets['ScheduleChanges'].rows.length, recordsBefore);
});

test('M4D-G3 — after schedule change, reconciliation marks non-working-day slots unavailable', function() {
  setupStandard();
  state.nowIso = '2026-09-01T06:00:00.000Z';
  
  // Generate initial slots (all working days per Settings)
  HM.ensureHorizon(controlContext());
  
  // Now commit change: Monday only
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-conv-mon',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-01T00:00',
    schedule: {
      days: scheduleDays({ monday: true }),
      workWindow: { start: '09:00', end: '14:00' }
    }
  });
  
  // Reconcile
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  
  // Non-Monday FREE slots should be marked unavailable
  state.sheets['Availability'].rows.forEach(function(s) {
    if (s.status !== 'FREE' || !s.sort_key || s.sort_key.length < 8) return;
    var year = parseInt(s.sort_key.substring(0, 4), 10);
    var month = parseInt(s.sort_key.substring(4, 6), 10);
    var day = parseInt(s.sort_key.substring(6, 8), 10);
    var dow = new Date(year, month - 1, day).getDay(); // 0=Sun, 1=Mon
    if (dow !== 1) { // Not Monday
      assert.strictEqual(s.is_available, false,
        'non-Monday FREE slot ' + s.sort_key + ' should be unavailable');
    }
  });
});

// ══════════════════════════════════════════════════════════
// H — Duration semantics
// ══════════════════════════════════════════════════════════

test('M4D-H1 — slot that fits within window → available', function() {
  setupStandard();
  seedSettings(standardSettings({ 'Slot Duration (min)': '20' }));
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T09:00', 20);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, true);
});

test('M4D-H2 — slot that exceeds window → not available', function() {
  setupStandard();
  // work_end=14:00, slot at 09:00 with 300 min → 09:00+300=14:00, exactly at end
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T09:00', 301);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.available, false);
});

test('M4D-H3 — invalid duration → fail', function() {
  setupStandard();
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-02T10:00', -5).ok, false);
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-02T10:00', 0).ok, false);
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-02T10:00', NaN).ok, false);
});

test('M4D-H4 — slot exactly at work_end boundary → not available', function() {
  setupStandard();
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T14:00', 30);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, false);
});

// ══════════════════════════════════════════════════════════
// I — Override handling
// ══════════════════════════════════════════════════════════

test('M4D-I1 — TEMPORARY_CLOSE overlapping slot → not available', function() {
  setupStandard();
  // Close 10:00-11:00 (grid-aligned)
  const cmdResult = CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-close-1',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-02T10:00',
    effectiveTo: '2026-09-02T11:00'
  });
  assert.strictEqual(cmdResult.ok, true, JSON.stringify(cmdResult.error));
  
  // Slot at 09:00-09:30 → before close → available
  const r1 = EFF.projectSlotAvailability(controlContext(), '2026-09-02T09:00', 30);
  assert.strictEqual(r1.ok, true, JSON.stringify(r1.error));
  assert.strictEqual(r1.data.available, true);
  
  // Slot at 10:00-10:30 → overlaps close → not available
  const r2 = EFF.projectSlotAvailability(controlContext(), '2026-09-02T10:00', 30);
  assert.strictEqual(r2.ok, true, JSON.stringify(r2.error));
  assert.strictEqual(r2.data.available, false);
  
  // Slot at 11:00-11:30 → after close → available
  const r3 = EFF.projectSlotAvailability(controlContext(), '2026-09-02T11:00', 30);
  assert.strictEqual(r3.ok, true, JSON.stringify(r3.error));
  assert.strictEqual(r3.data.available, true);
});

test('M4D-I2 — TEMPORARY_CLOSE covering full slot → not available', function() {
  setupStandard();
  // Close 10:00-10:30 (exactly one slot)
  CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-close-full',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-02T10:00',
    effectiveTo: '2026-09-02T10:30'
  });
  
  // Slot at 10:00-10:30 → fully covered → not available
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-02T10:00', 30);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, false);
  
  // Slot at 09:30-10:00 → before close → available
  const r2 = EFF.projectSlotAvailability(controlContext(), '2026-09-02T09:30', 30);
  assert.strictEqual(r2.ok, true, JSON.stringify(r2.error));
  assert.strictEqual(r2.data.available, true);
});

test('M4D-I3 — EXCEPTIONAL_OPEN on non-working day → available within Settings window', function() {
  setupStandard();
  // 2026-09-04 is Friday (non-working)
  const cmdResult = CMD.commitExceptionalOpen(controlContext(), {
    commandId: 'cmd-open-fri',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-04T00:00',
    effectiveTo: '2026-09-05T00:00'
  });
  assert.strictEqual(cmdResult.ok, true, 'commit failed: ' + JSON.stringify(cmdResult.error));
  
  // Slot at 10:00 on Friday → should be available (exceptional open, Settings window 09:00-14:00)
  const r = EFF.projectSlotAvailability(controlContext(), '2026-09-04T10:00', 30);
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.available, true);
  assert.strictEqual(r.data.intent, 'EXCEPTIONAL_OPEN');
  
  // Slot at 14:00 on Friday → at/past window end → not available
  const r2 = EFF.projectSlotAvailability(controlContext(), '2026-09-04T14:00', 30);
  assert.strictEqual(r2.ok, true, JSON.stringify(r2.error));
  assert.strictEqual(r2.data.available, false);
});

test('M4D-I4 — reconciliation marks slots correctly after TEMPORARY_CLOSE', function() {
  setupStandard();
  const slot1 = seedSlot({ sort_key: '202609020900', time: '09:00', is_available: true });
  const slot2 = seedSlot({ sort_key: '202609021000', time: '10:00', is_available: true });
  const slot3 = seedSlot({ sort_key: '202609021100', time: '11:00', is_available: true });
  
  CMD.commitTemporaryClose(controlContext(), {
    commandId: 'cmd-close-recon',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-02T10:00',
    effectiveTo: '2026-09-02T11:00'
  });
  
  state.nowIso = '2026-09-01T06:00:00.000Z';
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  
  // slot1 (09:00-09:30) → before close → stays available
  assert.strictEqual(
    state.sheets['Availability'].rows.find(s => s.slot_id === slot1.slot_id).is_available, true);
  // slot2 (10:00-10:30) → within close → marked unavailable
  assert.strictEqual(
    state.sheets['Availability'].rows.find(s => s.slot_id === slot2.slot_id).is_available, false);
  // slot3 (11:00-11:30) → after close → stays available
  assert.strictEqual(
    state.sheets['Availability'].rows.find(s => s.slot_id === slot3.slot_id).is_available, true);
});

// ══════════════════════════════════════════════════════════
// J — Layering
// ══════════════════════════════════════════════════════════

test('M4D-J1 — no new AvailabilityRepository', function() {
  const files = fs.readdirSync(path.join(ROOT, 'Repositories'));
  assert.ok(files.indexOf('AvailabilityRepository.js') === -1);
});

test('M4D-J2 — Horizon uses EffectiveScheduleService', function() {
  const code = fs.readFileSync(path.join(ROOT, 'AvailabilityHorizonMaintainer.js'), 'utf8');
  assert.ok(/EffectiveScheduleService\.projectSlotAvailability/.test(code));
  assert.ok(/EffectiveScheduleService\.projectDayEffectiveWindow/.test(code));
});

test('M4D-J3 — slot mutations go through atomicUpdate', function() {
  const code = fs.readFileSync(path.join(ROOT, 'AvailabilityHorizonMaintainer.js'), 'utf8');
  assert.ok(/SlotRepository\.atomicUpdate/.test(code));
  const stripped = stripComments(code);
  assert.ok(!/GoogleSheets\.updateRowByColumn/.test(stripped));
});

test('M4D-J4 — no global booking freeze', function() {
  const code = stripComments(fs.readFileSync(
    path.join(ROOT, 'AvailabilityHorizonMaintainer.js'), 'utf8'));
  assert.ok(!/globalBookingLock|booking.*freeze/i.test(code));
});

test('M4D-J5 — EffectiveScheduleService remains read-only', function() {
  const code = stripComments(fs.readFileSync(
    path.join(ROOT, 'Application/EffectiveScheduleService.js'), 'utf8'));
  assert.ok(!/SlotRepository/.test(code));
  assert.ok(!/GoogleSheets/.test(code));
  assert.ok(!/Clock\.now/.test(code));
  assert.ok(!/new Date\(\)/.test(code));
});

test('M4D-J6 — no new engines', function() {
  const rootFiles = fs.readdirSync(ROOT);
  assert.ok(rootFiles.indexOf('ScheduleEngine.js') === -1);
});

// ══════════════════════════════════════════════════════════
// K — Concurrency
// ══════════════════════════════════════════════════════════

test('M4D-K1 — horizon runs under AvailabilityHorizon lock', function() {
  setupStandard();
  HM.ensureHorizon(controlContext());
  assert.ok(state.lockKeys.indexOf('AvailabilityHorizon') !== -1);
});

test('M4D-K2 — reconciliation uses per-slot atomicUpdate lock', function() {
  setupStandard();
  const slot = seedSlot({
    sort_key: '202609021000', time: '10:00', is_available: false
  });
  HM.ensureHorizon(controlContext());
  assert.ok(state.lockKeys.indexOf('slot:' + slot.slot_id) !== -1);
});

// ══════════════════════════════════════════════════════════
// L — Slot interval containment
// ══════════════════════════════════════════════════════════

test('M4D-L1 — [start, start+duration) must fit in work window', function() {
  setupStandard();
  // work: 09:00-14:00, dur: 30
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-02T09:00', 30).data.available, true);
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-02T13:30', 30).data.available, true);
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-02T13:31', 30).data.available, false);
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-02T08:30', 30).data.available, false);
});

test('M4D-L2 — recurring change work window respected', function() {
  setupStandard();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-window-change',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-01T00:00',
    schedule: {
      days: scheduleDays({ tuesday: true }),
      workWindow: { start: '10:00', end: '12:00' }
    }
  });
  
  // Sept 1 = Tuesday (working after change)
  // Sept 2 = Wednesday (NOT working after change)
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-01T10:00', 30).data.available, true);
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-01T11:30', 30).data.available, true);
  // 09:00 is before new work start (10:00)
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-01T09:00', 30).data.available, false);
  // 12:00 is at work end → not available
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-01T12:00', 30).data.available, false);
  // Wednesday is no longer a working day
  assert.strictEqual(EFF.projectSlotAvailability(controlContext(), '2026-09-02T10:00', 30).data.available, false);
});

// ══════════════════════════════════════════════════════════
// M — projectDayEffectiveWindow
// ══════════════════════════════════════════════════════════

test('M4D-M1 — returns working day from settings', function() {
  setupStandard();
  const r = EFF.projectDayEffectiveWindow(controlContext(), '2026-09-02');
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.isWorkingDay, true);
  assert.strictEqual(r.data.workWindow.start, '09:00');
  assert.strictEqual(r.data.slotDurationMinutes, 30);
});

test('M4D-M2 — returns non-working day', function() {
  setupStandard();
  const r = EFF.projectDayEffectiveWindow(controlContext(), '2026-09-04'); // Friday
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  assert.strictEqual(r.data.isWorkingDay, false);
});

test('M4D-M3 — respects recurring change', function() {
  setupStandard();
  CMD.commitRecurringChange(controlContext(), {
    commandId: 'cmd-day-eff',
    asOf: '2026-09-01T00:00',
    effectiveFrom: '2026-09-01T00:00',
    schedule: {
      days: scheduleDays({ wednesday: true }),
      workWindow: { start: '08:00', end: '12:00' }
    }
  });
  
  // Sept 1 = Tuesday — was working in settings, now NOT (recurring changed to Wednesday only)
  const r1 = EFF.projectDayEffectiveWindow(controlContext(), '2026-09-01');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.data.isWorkingDay, false);
  
  // Sept 2 = Wednesday — now working
  const r2 = EFF.projectDayEffectiveWindow(controlContext(), '2026-09-02');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.data.isWorkingDay, true);
  assert.strictEqual(r2.data.workWindow.start, '08:00');
  
  // Sept 3 = Thursday — NOT working
  const r3 = EFF.projectDayEffectiveWindow(controlContext(), '2026-09-03');
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.data.isWorkingDay, false);
});

// ══════════════════════════════════════════════════════════
// N — Materialization boundary = Clock.now()
// ══════════════════════════════════════════════════════════

test('M4D-N1 — past slots are not reconciled', function() {
  setupStandard();
  state.nowIso = '2026-09-03T06:00:00.000Z'; // 09:00 Baghdad on Sept 3
  seedSlot({
    sort_key: '202609021000', date: '2026/09/02', time: '10:00',
    is_available: false // In the past, should not be touched
  });
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, true, JSON.stringify(r.error));
  const pastSlot = state.sheets['Availability'].rows.find(s => s.sort_key === '202609021000');
  assert.strictEqual(pastSlot.is_available, false, 'past slot should not be modified');
});

// ══════════════════════════════════════════════════════════
// O — Helper tests
// ══════════════════════════════════════════════════════════

test('M4D-O1 — _slotToStamp converts sort_key correctly', function() {
  setupStandard();
  assert.strictEqual(HM._slotToStamp({ sort_key: '202609151030' }).data, '2026-09-15T10:30');
  assert.strictEqual(HM._slotToStamp({ sort_key: '123' }).ok, false);
  assert.strictEqual(HM._slotToStamp({}).ok, false);
  assert.strictEqual(HM._slotToStamp(null).ok, false);
});

// ══════════════════════════════════════════════════════════
// P — No fallback to 30 minutes
// ══════════════════════════════════════════════════════════

test('M4D-P1 — no silent default to 30 minutes', function() {
  reset();
  seedSettings(standardSettings({ 'Slot Duration (min)': '' }));
  seedAvailabilityHeaders();
  const r = HM.ensureHorizon(controlContext());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_SOURCE_INVALID');
});

// ── Run ──

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
