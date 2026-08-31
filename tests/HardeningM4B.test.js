'use strict';

/**
 * HardeningM4B.test.js — M4-B (DOCTOR SCHEDULE READ / EFFECTIVE SCHEDULE)
 *
 * Proves the M4-B read-only boundary over the REAL SettingsRepository
 * and DoctorScheduleReadService:
 *
 *   M4-A controlContext
 *       → DoctorScheduleReadService.readCurrentEffectiveSchedule
 *       → SettingsRepository.getSettingsResult / getSlotDurationInfo
 *       → application Effective Schedule model
 *
 * Contract points proven:
 *   H  — happy path (configured Settings → Result.ok(schedule))
 *   D  — disabled days stay disabled; all-closed is a valid schedule
 *   W  — work_start / work_end preserved, not reinterpreted
 *   S  — slot duration from existing SettingsRepository source of truth
 *   M  — missing / unreadable / malformed / unconfigured duration fail
 *        explicitly (never closed / empty / healthy / silent 30)
 *   N  — no mutation; forbidden dependencies; no current-time semantics
 *   DET — same Settings → same model
 *   SC — scope from M4-A context; no identity lookup; v1 clinicId null
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
    writes: 0,
    sheetCreates: 0,
    sends: 0
  };

  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
  }

  sandbox.GoogleSheets = {
    getAllRows: function(name) {
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
      return sheet.rows.map(function(r) { return Object.assign({}, r); });
    },
    getOrCreateSheet: function(name) {
      state.sheetCreates += 1;
      throw new Error('M4B_MUST_NOT_CREATE_SHEETS: ' + name);
    },
    appendRow: function(name) {
      state.writes += 1;
      throw new Error('M4B_MUST_NOT_WRITE: appendRow ' + name);
    },
    appendRows: function(name) {
      state.writes += 1;
      throw new Error('M4B_MUST_NOT_WRITE: appendRows ' + name);
    },
    updateRowByColumn: function(name) {
      state.writes += 1;
      throw new Error('M4B_MUST_NOT_WRITE: updateRowByColumn ' + name);
    },
    updateBatch: function(name) {
      state.writes += 1;
      throw new Error('M4B_MUST_NOT_WRITE: updateBatch ' + name);
    },
    deleteRowsByNumbers: function(name) {
      state.writes += 1;
      throw new Error('M4B_MUST_NOT_WRITE: deleteRowsByNumbers ' + name);
    }
  };

  sandbox.WhatsAppAdapter = {
    sendMessage: function() {
      state.sends += 1;
      throw new Error('M4B_MUST_NOT_SEND_WHATSAPP');
    }
  };

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('SettingsRepository.js', 'SettingsRepository');
  load('Application/DoctorScheduleReadService.js', 'DoctorScheduleReadService');

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;
const SVC = sandbox.DoctorScheduleReadService;
const SettingsRepository = sandbox.SettingsRepository;

function seedSettings(settingsObj) {
  state.sheets['Settings'] = {
    headers: Object.keys(settingsObj),
    rows: [Object.assign({}, settingsObj)]
  };
}

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
    saturday: true,
    slot_generation_days: '30',
    clinic_name: 'Test Clinic'
  }, overrides || {});
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
  state.writes = 0;
  state.sheetCreates = 0;
  state.sends = 0;
  seedSettings(standardSettings());
}

function read(ctx) {
  return SVC.readCurrentEffectiveSchedule(ctx || controlContext());
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ─────────────────────────────────────────────────────────────
// HAPPY PATH
// ─────────────────────────────────────────────────────────────

test('M4B-H1 — configured Settings map to Result.ok effective schedule model', function() {
  reset();
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.source, 'SETTINGS');
  assert.strictEqual(r.data.recurrence, 'WEEKLY');
  assert.strictEqual(r.data.timezone, 'Asia/Baghdad');
  assert.strictEqual(r.data.slotDurationMinutes, 30);
  assert.strictEqual(r.data.workWindow.start, '09:00');
  assert.strictEqual(r.data.workWindow.end, '14:00');
  assert.strictEqual(r.data.scope.doctorId, DOCTOR_ID);
  assert.strictEqual(r.data.scope.clinicId, null);
});

test('M4B-H2 — string TRUE day flags are working days (SlotGenerator semantics)', function() {
  reset();
  seedSettings(standardSettings({
    sunday: 'TRUE',
    monday: 'true',
    tuesday: 'FALSE'
  }));
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.days.sunday, true);
  assert.strictEqual(r.data.days.monday, true);
  assert.strictEqual(r.data.days.tuesday, false);
});

test('M4B-H3 — model is semantic, not a raw Settings row', function() {
  reset();
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.hasOwnProperty('work_start'), false);
  assert.strictEqual(r.data.hasOwnProperty('Slot Duration (min)'), false);
  assert.strictEqual(r.data.hasOwnProperty('slot_generation_days'), false);
  assert.strictEqual(r.data.hasOwnProperty('clinic_name'), false);
  assert.ok(r.data.days);
  assert.ok(r.data.workWindow);
  assert.strictEqual(typeof r.data.slotDurationMinutes, 'number');
});

// ─────────────────────────────────────────────────────────────
// DISABLED DAYS
// ─────────────────────────────────────────────────────────────

test('M4B-D1 — disabled days stay disabled and are not auto-converted to working days', function() {
  reset();
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.days.sunday, true);
  assert.strictEqual(r.data.days.monday, true);
  assert.strictEqual(r.data.days.tuesday, false);
  assert.strictEqual(r.data.days.wednesday, true);
  assert.strictEqual(r.data.days.thursday, true);
  assert.strictEqual(r.data.days.friday, false);
  assert.strictEqual(r.data.days.saturday, true);
});

test('M4B-D2 — all-closed week is a valid schedule (not fabricated empty/failure)', function() {
  reset();
  seedSettings(standardSettings({
    sunday: false,
    monday: false,
    tuesday: false,
    wednesday: false,
    thursday: false,
    friday: false,
    saturday: false
  }));
  const r = read();
  assert.strictEqual(r.ok, true);
  Object.keys(r.data.days).forEach(function(day) {
    assert.strictEqual(r.data.days[day], false, day + ' must stay disabled');
  });
});

test('M4B-D3 — FALSE / empty / 0 day flags stay disabled', function() {
  reset();
  seedSettings(standardSettings({
    friday: 'FALSE',
    saturday: '',
    tuesday: 0
  }));
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.days.friday, false);
  assert.strictEqual(r.data.days.saturday, false);
  assert.strictEqual(r.data.days.tuesday, false);
});

// ─────────────────────────────────────────────────────────────
// WORK WINDOW
// ─────────────────────────────────────────────────────────────

test('M4B-W1 — work_start and work_end are preserved without reinterpretation', function() {
  reset();
  seedSettings(standardSettings({
    work_start: '16:00',
    work_end: '20:30'
  }));
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.workWindow.start, '16:00');
  assert.strictEqual(r.data.workWindow.end, '20:30');
});

test('M4B-W2 — non-padded configured clock text is kept as stored, not rewritten', function() {
  reset();
  seedSettings(standardSettings({
    work_start: '8:05',
    work_end: '13:00'
  }));
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.workWindow.start, '8:05');
  assert.strictEqual(r.data.workWindow.end, '13:00');
});

// ─────────────────────────────────────────────────────────────
// SLOT DURATION
// ─────────────────────────────────────────────────────────────

test('M4B-S1 — slot duration comes from SettingsRepository.getSlotDurationInfo CONFIGURED', function() {
  reset();
  seedSettings(standardSettings({ 'Slot Duration (min)': '20' }));
  const info = SettingsRepository.getSlotDurationInfo();
  assert.strictEqual(info.source, 'CONFIGURED');
  assert.strictEqual(info.minutes, 20);
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.slotDurationMinutes, info.minutes);
});

test('M4B-S2 — configured 30 is accepted and is not treated as fallback', function() {
  reset();
  seedSettings(standardSettings({ 'Slot Duration (min)': '30' }));
  const info = SettingsRepository.getSlotDurationInfo();
  assert.strictEqual(info.source, 'CONFIGURED');
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.slotDurationMinutes, 30);
});

// ─────────────────────────────────────────────────────────────
// MISSING / MALFORMED / UNAVAILABLE
// ─────────────────────────────────────────────────────────────

test('M4B-M1 — missing Settings sheet/row fails SETTINGS_NOT_CONFIGURED (not empty schedule)', function() {
  reset();
  state.sheets['Settings'] = { headers: [], rows: [] };
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SETTINGS_NOT_CONFIGURED');
  assert.strictEqual(r.data, null);
});

test('M4B-M2 — Settings read failure fails SETTINGS_READ_FAILED (not healthy/closed)', function() {
  reset();
  state.failRead['Settings'] = true;
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SETTINGS_READ_FAILED');
  assert.strictEqual(r.data, null);
});

test('M4B-M3 — malformed work_start fails SCHEDULE_SOURCE_INVALID', function() {
  reset();
  seedSettings(standardSettings({ work_start: 'invalid' }));
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_SOURCE_INVALID');
});

test('M4B-M4 — malformed work_end fails SCHEDULE_SOURCE_INVALID', function() {
  reset();
  seedSettings(standardSettings({ work_end: '25:99' }));
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_SOURCE_INVALID');
});

test('M4B-M5 — missing slot duration fails; does not silently become 30', function() {
  reset();
  seedSettings({
    work_start: '09:00',
    work_end: '14:00',
    sunday: true,
    monday: true,
    tuesday: false,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: true
  });
  const info = SettingsRepository.getSlotDurationInfo();
  assert.strictEqual(info.source, 'DEFAULT_FALLBACK');
  assert.strictEqual(info.minutes, 30);
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_SOURCE_INVALID');
  assert.strictEqual(r.data, null);
});

test('M4B-M6 — invalid slot duration fails; does not use silent default', function() {
  reset();
  seedSettings(standardSettings({ 'Slot Duration (min)': '0' }));
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_SOURCE_INVALID');
});

test('M4B-M7 — inverted work window fails rather than fabricating a closed clinic', function() {
  reset();
  seedSettings(standardSettings({ work_start: '14:00', work_end: '09:00' }));
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_SOURCE_INVALID');
});

test('M4B-M8 — non-string work_start (Date-like object) fails, not converted via new Date', function() {
  reset();
  seedSettings(standardSettings({ work_start: { hour: 9 } }));
  const r = read();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'SCHEDULE_SOURCE_INVALID');
});

// ─────────────────────────────────────────────────────────────
// SCOPE / M4-A CONTEXT
// ─────────────────────────────────────────────────────────────

test('M4B-SC1 — v1 scope uses doctorId from controlContext and clinicId null', function() {
  reset();
  const r = read(controlContext());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.scope.doctorId, DOCTOR_ID);
  assert.strictEqual(r.data.scope.clinicId, null);
});

test('M4B-SC2 — clinicId is passed through from M4-A scope without persistence', function() {
  reset();
  const r = read(controlContext({
    actorId: DOCTOR_ID,
    scope: { clinicId: 'clinic-future' }
  }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.scope.clinicId, 'clinic-future');
});

test('M4B-SC3 — missing/invalid control context fails INVALID_CONTROL_CONTEXT', function() {
  reset();
  [null, {}, { scope: { clinicId: null } }, { actorId: '' }].forEach(function(ctx) {
    const r = SVC.readCurrentEffectiveSchedule(ctx);
    assert.strictEqual(r.ok, false, 'expected fail for ' + JSON.stringify(ctx));
    assert.strictEqual(r.error.code, 'INVALID_CONTROL_CONTEXT');
  });
});

test('M4B-SC4 — schedule read does not consult identity properties', function() {
  reset();
  const code = stripComments(fs.readFileSync(
    path.join(ROOT, 'Application/DoctorScheduleReadService.js'),
    'utf8'
  ));
  assert.strictEqual(/DOCTOR_PHONE/.test(code), false);
  assert.strictEqual(/ADMIN_PHONE/.test(code), false);
  assert.strictEqual(/DoctorIdentityRepository/.test(code), false);
  assert.strictEqual(/DoctorAuthorizationService/.test(code), false);
  assert.strictEqual(/PropertiesService/.test(code), false);
});

// ─────────────────────────────────────────────────────────────
// DETERMINISM
// ─────────────────────────────────────────────────────────────

test('M4B-DET1 — same Settings + same context produce identical schedule model', function() {
  reset();
  const a = jsonClone(read());
  const b = jsonClone(read());
  const c = jsonClone(read());
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
  assert.strictEqual(a.ok, true);
});

test('M4B-DET2 — output has no current-time / evaluatedAt fields', function() {
  reset();
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.hasOwnProperty('evaluatedAt'), false);
  assert.strictEqual(r.data.hasOwnProperty('asOfMs'), false);
  assert.strictEqual(r.data.hasOwnProperty('generatedAt'), false);
  assert.strictEqual(r.data.hasOwnProperty('effectiveFrom'), false);
  assert.strictEqual(r.data.hasOwnProperty('overrides'), false);
});

// ─────────────────────────────────────────────────────────────
// READ-ONLY / ARCHITECTURE
// ─────────────────────────────────────────────────────────────

test('M4B-N1 — schedule read performs zero writes and zero WhatsApp sends', function() {
  reset();
  const r = read();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.sheetCreates, 0);
  assert.strictEqual(state.sends, 0);
});

test('M4B-N2 — forbidden dependency scan on DoctorScheduleReadService', function() {
  const code = stripComments(fs.readFileSync(
    path.join(ROOT, 'Application/DoctorScheduleReadService.js'),
    'utf8'
  ));
  [
    /WhatsAppAdapter/, /ultramsg|ultraMsg/i, /UrlFetchApp/,
    /GoogleCalendar/, /CalendarApp/, /GoogleSheets/, /SpreadsheetApp/,
    /PropertiesService/, /LockService/, /Lock\.runExclusive/,
    /CommandExecutor/, /SlotRepository/, /AppointmentRepository/,
    /AvailabilityHorizonMaintainer/, /SlotSelection/, /BookingService/,
    /ChangeService/, /CancelService/, /Router/, /Webhook/,
    /MetricsService/, /Clock\.now/, /new Date\s*\(/
  ].forEach(function(rx) {
    assert.strictEqual(rx.test(code), false, 'must not reference ' + rx);
  });
  assert.ok(/SettingsRepository/.test(code), 'must read via SettingsRepository');
  assert.ok(/getSettingsResult/.test(code), 'must use getSettingsResult');
  assert.ok(/getSlotDurationInfo/.test(code), 'must use getSlotDurationInfo');
  assert.strictEqual(/getSlotDurationMinutes\s*\(/.test(code), false,
    'must not use silent getSlotDurationMinutes fallback');
});

test('M4B-N3 — Application does not mention is_available or EXPIRED/CANCELLED schedule meaning', function() {
  const code = stripComments(fs.readFileSync(
    path.join(ROOT, 'Application/DoctorScheduleReadService.js'),
    'utf8'
  ));
  assert.strictEqual(/is_available/.test(code), false);
  assert.strictEqual(/EXPIRED/.test(code), false);
  assert.strictEqual(/CANCELLED/.test(code), false);
});

test('M4B-N4 — SettingsRepository is unchanged as the Settings boundary (no new store)', function() {
  const code = fs.readFileSync(path.join(ROOT, 'SettingsRepository.js'), 'utf8');
  assert.ok(/getSettingsResult/.test(code));
  assert.ok(/getSlotDurationInfo/.test(code));
  assert.strictEqual(/DoctorScheduleReadService/.test(code), false);
});

test('M4B-N5 — M4-A files are untouched by M4-B schedule mapping', function() {
  const files = [
    'Application/DoctorAuthorizationService.js',
    'Application/DoctorControlEntry.js',
    'Repositories/DoctorIdentityRepository.js',
    'Core/Router.js'
  ];
  files.forEach(function(rel) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.strictEqual(/DoctorScheduleReadService/.test(code), false, rel);
    assert.strictEqual(/readCurrentEffectiveSchedule/.test(code), false, rel);
  });
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
