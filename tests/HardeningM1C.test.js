'use strict';

/**
 * HardeningM1C.test.js — M1-C (PHASE 1.4 — CAPACITY & WORKING-SCHEDULE INTELLIGENCE)
 *
 * Proves the M1-C contract:
 *   CWD — Configured Working Days (source: Settings, daily/weekly/monthly,
 *         closed day zero, historical DEFERRED, source failure)
 *   CC  — Configured Capacity (work_start/work_end/duration, closed day zero,
 *         no fixed 24, duration provenance CONFIGURED vs DEFAULT_FALLBACK,
 *         30 configured ≠ 30 fallback, historical DEFERRED, evidence validation)
 *   OGC — Observed Generated Capacity (all Availability rows counted regardless
 *         of status, valid zero, boundaries, historical DEFERRED, absence ≠ closed)
 *   OWD — Observed Working Days (distinct generated dates, valid zero,
 *         historical DEFERRED, source failure)
 *   GC  — Generation Completeness ((Observed / Configured) * 100, diagnostic,
 *         zero denominator N/A, valid zero numerator, historical DEFERRED)
 *   BU  — Booking Utilization ((Confirmed / Configured) * 100, doctor-facing KPI,
 *         denominator = Configured Capacity, zero denominator N/A,
 *         diagnostic mismatch case, historical DEFERRED)
 *   COB — Three-Way Governing Distinction (Configured ≠ Observed ≠ Bookable)
 *   PBP — Performance, Batching & Purity (calculateMany reads each source ONCE,
 *         fail fast, pure read-only with zero writes/locks/sheet creates)
 *   DVI — Doctor-Facing vs Internal Separation (getDoctorSummary vs getDiagnosticSummary)
 *   SCI — Structural & Constitutional Integrity (no fixed 24/7, no new Date( in Application,
 *         single-clinic, no settings history fabricated, clasp evaluation-order independence)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';

// ── Clinic-local wall-clock anchors (host-timezone independent, UTC+3) ──
const CLINIC_OFFSET_MS = 180 * 60000;
function CL(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour || 0, minute || 0) - CLINIC_OFFSET_MS;
}
const DAY_MS = 86400000;

// Frozen Clock: Monday 2026-08-24 12:00 clinic-local (Baghdad UTC+3)
const NOW_MS = CL(2026, 8, 24, 12, 0);

// Current day: Monday 2026-08-24 00:00 -> 2026-08-25 00:00 clinic-local
const CURRENT_DAY_P = {
  start: CL(2026, 8, 24, 0, 0),
  end: CL(2026, 8, 25, 0, 0)
};

// Current week: Sat 2026-08-22 00:00 -> Sat 2026-08-29 00:00 clinic-local
const CURRENT_WEEK_P = {
  start: CL(2026, 8, 22, 0, 0),
  end: CL(2026, 8, 29, 0, 0)
};

// Past closed period: 2026-08-10 00:00 -> 2026-08-11 00:00 clinic-local
const PAST_P = {
  start: CL(2026, 8, 10, 0, 0),
  end: CL(2026, 8, 11, 0, 0)
};

// Future period: 2026-09-01 00:00 -> 2026-09-08 00:00 clinic-local
const FUTURE_WEEK_P = {
  start: CL(2026, 9, 1, 0, 0),
  end: CL(2026, 9, 8, 0, 0)
};

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ═══════════════════════════════════════════════════════════════
// Sandbox — in-memory GoogleSheets seam + production stack
// ═══════════════════════════════════════════════════════════════

function createM1CSandbox() {
  const sandbox = vm.createContext({ console: console });

  function load(relativePath, globalName) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, {
      filename: relativePath
    });
  }

  const state = {
    nowMs: NOW_MS,
    sheets: {},
    failRead: {},
    queryCalls: {},
    headerCalls: {},
    writes: 0,
    sheetCreates: 0
  };

  sandbox.Clock = { now: function() { return new Date(state.nowMs); } };
  vm.runInContext('this.mkVmDate = function(ms) { return new Date(ms); };', sandbox);

  sandbox.GoogleSheets = {
    getHeaders: function(name) {
      state.headerCalls[name] = (state.headerCalls[name] || 0) + 1;
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
      return sheet.headers.slice();
    },
    queryRows: function(name, predicateFn) {
      state.queryCalls[name] = (state.queryCalls[name] || 0) + 1;
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
      return sheet.rows.map(function(r, idx) {
          return Object.assign({ _rowNumber: idx + 2 }, r);
        })
        .filter(predicateFn)
        .map(function(r) { return Object.assign({}, r); });
    },
    getAllRows: function(name) {
      return this.queryRows(name, function() { return true; });
    },
    getOrCreateSheet: function(name) {
      state.sheetCreates += 1;
      throw new Error('M1_METRICS_MUST_NOT_CREATE_SHEETS: ' + name);
    },
    appendRow: function(name) {
      state.writes += 1;
      throw new Error('M1_METRICS_MUST_NOT_WRITE: appendRow ' + name);
    },
    appendRows: function(name) {
      state.writes += 1;
      throw new Error('M1_METRICS_MUST_NOT_WRITE: appendRows ' + name);
    },
    updateRowByColumn: function(name) {
      state.writes += 1;
      throw new Error('M1_METRICS_MUST_NOT_WRITE: updateRowByColumn ' + name);
    },
    updateBatch: function(name) {
      state.writes += 1;
      throw new Error('M1_METRICS_MUST_NOT_WRITE: updateBatch ' + name);
    },
    deleteRowsByNumbers: function(name) {
      state.writes += 1;
      throw new Error('M1_METRICS_MUST_NOT_WRITE: deleteRowsByNumbers ' + name);
    }
  };

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('StateMachine.js', 'StateMachine');
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('Utils/ReportPeriod.js', 'ReportPeriod');
  load('SlotGenerator.js', 'SlotGenerator');
  load('SettingsRepository.js', 'SettingsRepository');
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('Repositories/AttendanceAuditRepository.js', 'AttendanceAuditRepository');
  load('Repositories/AttendanceAuditReadRepository.js', 'AttendanceAuditReadRepository');
  load('Repositories/B6LifecycleRepository.js', 'B6LifecycleRepository');
  load('Application/B6LifecycleService.js', 'B6LifecycleService');
  load('Application/MetricsService.js', 'MetricsService');

  return { sandbox: sandbox, state: state };
}

const core = createM1CSandbox();
const sandbox = core.sandbox;
const state = core.state;

// ── Helpers for seeding test stores ──────────────────────────────

const AV_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status',
  'is_available', 'patient_name', 'phone', 'calendar_event_id',
  'Reminder_sent', 'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];

const B6_HEADERS = [
  'operation_id', 'phone', 'command', 'old_slot_id', 'new_slot_id',
  'lifecycle_state', 'ownership_state', 'checkpoint', 'calendar_event_id',
  'calendar_correlation_id', 'calendar_id', 'recovery_state', 'recovery_case_id',
  'created_at', 'updated_at', 'timestamp', 'details'
];

const AUDIT_HEADERS = [
  'operator_id', 'calendar_event_id', 'calendar_id', 'slot_id',
  'decision', 'from_status', 'to_status', 'outcome', 'error_code', 'timestamp'
];

function reset() {
  state.nowMs = NOW_MS;
  state.sheets = {};
  state.failRead = {};
  state.queryCalls = {};
  state.headerCalls = {};
  state.writes = 0;
  state.sheetCreates = 0;

  // Default standard settings: 09:00 -> 17:00, 20 min, Sun..Thu open (5 days), Fri/Sat closed
  seedSettings({
    work_start: '09:00',
    work_end: '17:00',
    'Slot Duration (min)': '20',
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: false,
    slot_generation_days: '30'
  });

  seedAvailability([]);
  seedLifecycle([]);
  seedAttendance([]);
}

function seedSettings(settingsObj) {
  state.sheets['Settings'] = {
    headers: Object.keys(settingsObj),
    rows: [Object.assign({}, settingsObj)]
  };
}

function seedAvailability(rows) {
  state.sheets['Availability'] = {
    headers: AV_HEADERS.slice(),
    rows: rows ? rows.slice() : []
  };
}

function seedLifecycle(rows) {
  state.sheets['B6_LIFECYCLE'] = {
    headers: B6_HEADERS.slice(),
    rows: rows ? rows.slice() : []
  };
}

function seedAttendance(rows) {
  state.sheets['ATTENDANCE_AUDIT'] = {
    headers: AUDIT_HEADERS.slice(),
    rows: rows ? rows.slice() : []
  };
}

function mkSlot(id, opts) {
  const o = opts || {};
  return {
    slot_id: id,
    date: o.date || '2026/08/24',
    time: o.time || '16:00',
    sort_key: o.sortKey !== undefined ? o.sortKey : (o.sort_key !== undefined ? o.sort_key : CL(2026, 8, 24, 16, 0)),
    status: o.status || 'FREE',
    is_available: o.isAvailable !== undefined ? o.isAvailable : (o.is_available !== undefined ? o.is_available : true),
    patient_name: o.patient || (o.phone ? 'Patient ' + o.phone : ''),
    phone: o.phone || '',
    calendar_event_id: o.eventId || '',
    Reminder_sent: '',
    whatsapp_message_id: '',
    reserved_until: '',
    reserved_until_unix: ''
  };
}

// ═══════════════════════════════════════════════════════════════
// Test Runner
// ═══════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ─────────────────────────────────────────────────────────────
// 1. CONFIGURED_WORKING_DAYS
// ─────────────────────────────────────────────────────────────

test('CWD-1 — Daily period: open working day = 1, closed day = 0 (VALID ZERO)', function() {
  reset();
  // Monday 2026-08-24 is open
  const mon = sandbox.MetricsService.calculate('CONFIGURED_WORKING_DAYS', CURRENT_DAY_P);
  assert.strictEqual(mon.ok, true);
  assert.strictEqual(mon.data.status, 'AVAILABLE');
  assert.strictEqual(mon.data.value, 1);
  assert.strictEqual(mon.data.reason, null);

  // Friday 2026-08-28 (closed day)
  const friPeriod = {
    start: CL(2026, 8, 28, 0, 0),
    end: CL(2026, 8, 29, 0, 0)
  };
  const fri = sandbox.MetricsService.calculate('CONFIGURED_WORKING_DAYS', friPeriod);
  assert.strictEqual(fri.ok, true);
  assert.strictEqual(fri.data.status, 'AVAILABLE');
  assert.strictEqual(fri.data.value, 0);
  assert.strictEqual(fri.data.reason, null);
});

test('CWD-2 — Weekly period: counts configured working days in the week (5 open, 2 closed = 5)', function() {
  reset();
  const week = sandbox.MetricsService.calculate('CONFIGURED_WORKING_DAYS', CURRENT_WEEK_P);
  assert.strictEqual(week.ok, true);
  assert.strictEqual(week.data.status, 'AVAILABLE');
  assert.strictEqual(week.data.value, 5);
  assert.strictEqual(week.data.provenance.workingDaysCount, 5);
  assert.strictEqual(week.data.provenance.totalCalendarDaysInPeriod, 7);
});

test('CWD-3 — Dynamic schedule: 6-day work week is reflected without fixed 5 or 7 day assumption', function() {
  reset();
  seedSettings({
    work_start: '09:00',
    work_end: '17:00',
    'Slot Duration (min)': '20',
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: true // Saturday also open
  });

  const week = sandbox.MetricsService.calculate('CONFIGURED_WORKING_DAYS', CURRENT_WEEK_P);
  assert.strictEqual(week.data.value, 6);
});

test('CWD-4 — All-closed week yields VALID ZERO (status AVAILABLE, value 0)', function() {
  reset();
  seedSettings({
    work_start: '09:00',
    work_end: '17:00',
    'Slot Duration (min)': '20',
    sunday: false,
    monday: false,
    tuesday: false,
    wednesday: false,
    thursday: false,
    friday: false,
    saturday: false
  });

  const week = sandbox.MetricsService.calculate('CONFIGURED_WORKING_DAYS', CURRENT_WEEK_P);
  assert.strictEqual(week.data.status, 'AVAILABLE');
  assert.strictEqual(week.data.value, 0);
  assert.strictEqual(week.data.reason, null);
});

test('CWD-5 — Closed past period returns DEFERRED (HISTORICAL_NOT_PROVABLE, zero reads)', function() {
  reset();
  const past = sandbox.MetricsService.calculate('CONFIGURED_WORKING_DAYS', PAST_P);
  assert.strictEqual(past.ok, true);
  assert.strictEqual(past.data.status, 'DEFERRED');
  assert.strictEqual(past.data.value, null);
  assert.strictEqual(past.data.reason, 'HISTORICAL_NOT_PROVABLE');
  assert.strictEqual(state.queryCalls['Settings'] || 0, 0);
});

test('CWD-6 — Settings read failure propagates METRIC_SOURCE_UNAVAILABLE (never 0)', function() {
  reset();
  state.failRead['Settings'] = true;
  const result = sandbox.MetricsService.calculate('CONFIGURED_WORKING_DAYS', CURRENT_DAY_P);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'METRIC_SOURCE_UNAVAILABLE');
});

// ─────────────────────────────────────────────────────────────
// 2. CONFIGURED_CAPACITY
// ─────────────────────────────────────────────────────────────

test('CC-1 — Daily configured capacity: floor((work_end - work_start) / duration) for open day', function() {
  reset();
  // 09:00 -> 17:00 = 480 min / 20 min = 24 slots
  const mon = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(mon.ok, true);
  assert.strictEqual(mon.data.status, 'AVAILABLE');
  assert.strictEqual(mon.data.value, 24);
  assert.strictEqual(mon.data.provenance.dailyConfiguredCapacity, 24);
  assert.strictEqual(mon.data.provenance.workingMinutesPerDay, 480);
});

test('CC-2 — Daily configured capacity for closed day = 0 (VALID ZERO)', function() {
  reset();
  const friPeriod = {
    start: CL(2026, 8, 28, 0, 0),
    end: CL(2026, 8, 29, 0, 0)
  };
  const fri = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', friPeriod);
  assert.strictEqual(fri.ok, true);
  assert.strictEqual(fri.data.status, 'AVAILABLE');
  assert.strictEqual(fri.data.value, 0);
  assert.strictEqual(fri.data.reason, null);
});

test('CC-3 — Weekly configured capacity = sum of daily capacities (5 open days * 24 = 120)', function() {
  reset();
  const week = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_WEEK_P);
  assert.strictEqual(week.ok, true);
  assert.strictEqual(week.data.status, 'AVAILABLE');
  assert.strictEqual(week.data.value, 120);
});

test('CC-4 — Non-standard hours/duration proves NO fixed 24 slots assumption', function() {
  reset();
  // 08:30 -> 14:00 = 330 min / 25 min = 13 slots/day
  seedSettings({
    work_start: '08:30',
    work_end: '14:00',
    'Slot Duration (min)': '25',
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: false,
    friday: false,
    saturday: false
  });

  const daily = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(daily.data.value, 13);

  const weekly = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_WEEK_P);
  // 4 open days * 13 slots = 52 slots
  assert.strictEqual(weekly.data.value, 52);
});

test('CC-5 — Duration provenance = CONFIGURED when Slot Duration (min) is present and valid', function() {
  reset();
  const result = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.data.provenance.slotDurationSource, 'CONFIGURED');
  assert.strictEqual(result.data.provenance.slotDurationMinutes, 20);
});

test('CC-6 — Duration provenance = DEFAULT_FALLBACK when Slot Duration (min) is missing or invalid', function() {
  reset();
  // Settings without Slot Duration (min)
  seedSettings({
    work_start: '09:00',
    work_end: '17:00',
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: false
  });

  const result = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  // 480 / 30 fallback = 16 slots
  assert.strictEqual(result.data.value, 16);
  assert.strictEqual(result.data.provenance.slotDurationSource, 'DEFAULT_FALLBACK');
  assert.strictEqual(result.data.provenance.slotDurationMinutes, 30);
  assert.ok(result.data.provenance.fallbackPolicy.indexOf('operational fallback') !== -1);
});

test('CC-7 — 30 configured ≠ 30 fallback: provenance explicitly distinguishes them', function() {
  reset();
  // Case A: configured 30
  seedSettings({
    work_start: '09:00',
    work_end: '17:00',
    'Slot Duration (min)': '30',
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: false
  });
  const configured30 = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(configured30.data.value, 16);
  assert.strictEqual(configured30.data.provenance.slotDurationSource, 'CONFIGURED');

  // Case B: fallback 30
  seedSettings({
    work_start: '09:00',
    work_end: '17:00',
    'Slot Duration (min)': '', // empty -> triggers fallback
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: false
  });
  const fallback30 = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(fallback30.data.value, 16);
  assert.strictEqual(fallback30.data.provenance.slotDurationSource, 'DEFAULT_FALLBACK');
  assert.notStrictEqual(configured30.data.provenance.slotDurationSource, fallback30.data.provenance.slotDurationSource);
});

test('CC-8 — Closed past period returns DEFERRED (HISTORICAL_NOT_PROVABLE)', function() {
  reset();
  const past = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', PAST_P);
  assert.strictEqual(past.ok, true);
  assert.strictEqual(past.data.status, 'DEFERRED');
  assert.strictEqual(past.data.value, null);
  assert.strictEqual(past.data.reason, 'HISTORICAL_NOT_PROVABLE');
});

test('CC-9 — Settings read failure / missing sheet propagates METRIC_SOURCE_UNAVAILABLE', function() {
  reset();
  state.failRead['Settings'] = true;
  const result = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'METRIC_SOURCE_UNAVAILABLE');
});

test('CC-10 — Malformed work_start or work_end returns METRIC_EVIDENCE_INVALID', function() {
  reset();
  seedSettings({
    work_start: 'invalid_time',
    work_end: '17:00',
    'Slot Duration (min)': '20',
    monday: true
  });
  const result = sandbox.MetricsService.calculate('CONFIGURED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'METRIC_EVIDENCE_INVALID');
});

// ─────────────────────────────────────────────────────────────
// 3. OBSERVED_GENERATED_CAPACITY
// ─────────────────────────────────────────────────────────────

test('OGC-1 — Counts all Availability rows within period regardless of status', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'FREE', sortKey: CL(2026, 8, 24, 10, 0) }),
    mkSlot('S2', { status: 'RESERVED', sortKey: CL(2026, 8, 24, 11, 0) }),
    mkSlot('S3', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 12, 0) }),
    mkSlot('S4', { status: 'COMPLETED', sortKey: CL(2026, 8, 24, 13, 0) }),
    mkSlot('S5', { status: 'NO_SHOW', sortKey: CL(2026, 8, 24, 14, 0) }),
    mkSlot('S6', { status: 'EXPIRED', sortKey: CL(2026, 8, 24, 15, 0) }),
    mkSlot('S7', { status: 'FREE', sortKey: CL(2026, 8, 25, 10, 0) }) // outside day period
  ]);

  const result = sandbox.MetricsService.calculate('OBSERVED_GENERATED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 6);
  assert.strictEqual(result.data.provenance.aggregation, 'COUNT observed generated slot rows');
});

test('OGC-2 — Empty Availability in current/future period is a VALID ZERO (AVAILABLE 0)', function() {
  reset();
  seedAvailability([]);
  const result = sandbox.MetricsService.calculate('OBSERVED_GENERATED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 0);
  assert.strictEqual(result.data.reason, null);
  assert.ok(result.data.provenance.absencePolicy.indexOf('absence of generated rows does not prove clinic closure') !== -1);
});

test('OGC-3 — Start inclusive, end exclusive on slotStartMs', function() {
  reset();
  seedAvailability([
    mkSlot('S_START', { sortKey: CL(2026, 8, 24, 0, 0) }),  // exactly at day start -> included
    mkSlot('S_MID', { sortKey: CL(2026, 8, 24, 12, 0) }),    // mid day -> included
    mkSlot('S_END', { sortKey: CL(2026, 8, 25, 0, 0) })      // exactly at next day start -> excluded
  ]);

  const result = sandbox.MetricsService.calculate('OBSERVED_GENERATED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.data.value, 2);
});

test('OGC-4 — Unattributable rows (unparseable sort_key) surfaced in provenance, not counted', function() {
  reset();
  seedAvailability([
    mkSlot('VALID', { sortKey: CL(2026, 8, 24, 10, 0) }),
    mkSlot('INVALID_KEY', { sortKey: 'NOT_A_KEY' })
  ]);

  const result = sandbox.MetricsService.calculate('OBSERVED_GENERATED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.data.value, 1);
  assert.strictEqual(result.data.provenance.unattributableRows, 1);
});

test('OGC-5 — Closed past period returns DEFERRED (HISTORICAL_NOT_PROVABLE)', function() {
  reset();
  seedAvailability([mkSlot('OLD', { sortKey: CL(2026, 8, 10, 10, 0) })]);
  const result = sandbox.MetricsService.calculate('OBSERVED_GENERATED_CAPACITY', PAST_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'DEFERRED');
  assert.strictEqual(result.data.value, null);
  assert.strictEqual(result.data.reason, 'HISTORICAL_NOT_PROVABLE');
});

test('OGC-6 — Availability read failure propagates METRIC_SOURCE_UNAVAILABLE', function() {
  reset();
  state.failRead['Availability'] = true;
  const result = sandbox.MetricsService.calculate('OBSERVED_GENERATED_CAPACITY', CURRENT_DAY_P);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'METRIC_SOURCE_UNAVAILABLE');
});

// ─────────────────────────────────────────────────────────────
// 4. OBSERVED_WORKING_DAYS
// ─────────────────────────────────────────────────────────────

test('OWD-1 — Counts distinct clinic-local calendar dates with >= 1 observed generated slot', function() {
  reset();
  seedAvailability([
    // 3 slots on 2026-08-24
    mkSlot('S1', { sortKey: CL(2026, 8, 24, 10, 0) }),
    mkSlot('S2', { sortKey: CL(2026, 8, 24, 11, 0) }),
    mkSlot('S3', { sortKey: CL(2026, 8, 24, 12, 0) }),
    // 2 slots on 2026-08-25
    mkSlot('S4', { sortKey: CL(2026, 8, 25, 10, 0) }),
    mkSlot('S5', { sortKey: CL(2026, 8, 25, 11, 0) }),
    // 1 slot on 2026-08-26
    mkSlot('S6', { sortKey: CL(2026, 8, 26, 10, 0) })
  ]);

  const result = sandbox.MetricsService.calculate('OBSERVED_WORKING_DAYS', CURRENT_WEEK_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 3);
  assert.deepStrictEqual(Array.from(result.data.provenance.observedDates), ['2026-08-24', '2026-08-25', '2026-08-26']);
});

test('OWD-2 — Empty Availability yields VALID ZERO (AVAILABLE 0)', function() {
  reset();
  seedAvailability([]);
  const result = sandbox.MetricsService.calculate('OBSERVED_WORKING_DAYS', CURRENT_WEEK_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 0);
  assert.strictEqual(result.data.reason, null);
});

test('OWD-3 — Closed past period returns DEFERRED (HISTORICAL_NOT_PROVABLE)', function() {
  reset();
  const result = sandbox.MetricsService.calculate('OBSERVED_WORKING_DAYS', PAST_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'DEFERRED');
  assert.strictEqual(result.data.value, null);
});

// ─────────────────────────────────────────────────────────────
// 5. GENERATION_COMPLETENESS
// ─────────────────────────────────────────────────────────────

test('GC-1 — 100% completeness when Observed Generated Capacity equals Configured Capacity', function() {
  reset();
  // Configured = 24 slots for Monday 2026-08-24
  const slots = [];
  for (let h = 9; h < 17; h++) {
    for (let m = 0; m < 60; m += 20) {
      slots.push(mkSlot('S_' + h + '_' + m, { sortKey: CL(2026, 8, 24, h, m) }));
    }
  }
  assert.strictEqual(slots.length, 24);
  seedAvailability(slots);

  const result = sandbox.MetricsService.calculate('GENERATION_COMPLETENESS', CURRENT_DAY_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 100);
  assert.strictEqual(result.data.provenance.observedGeneratedCapacity, 24);
  assert.strictEqual(result.data.provenance.configuredCapacity, 24);
  assert.strictEqual(result.data.provenance.audience, 'INTERNAL_DIAGNOSTIC');
});

test('GC-2 — Partial completeness: 80% when Observed = 40 and Configured = 50', function() {
  reset();
  // Set up 50 configured capacity: 09:00 -> 14:00 (10 slots/day * 5 days = 50)
  seedSettings({
    work_start: '09:00',
    work_end: '14:00',
    'Slot Duration (min)': '30', // 300 min / 30 = 10 slots/day
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: false
  });

  // Seed 40 slots in Availability
  const slots = [];
  for (let i = 0; i < 40; i++) {
    slots.push(mkSlot('S' + i, { sortKey: CL(2026, 8, 24, 9, i) }));
  }
  seedAvailability(slots);

  const result = sandbox.MetricsService.calculate('GENERATION_COMPLETENESS', CURRENT_WEEK_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 80);
});

test('GC-3 — Valid zero numerator: Observed 0 / Configured 50 → AVAILABLE 0 (0%)', function() {
  reset();
  seedAvailability([]);
  const result = sandbox.MetricsService.calculate('GENERATION_COMPLETENESS', CURRENT_WEEK_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 0);
  assert.strictEqual(result.data.reason, null);
});

test('GC-4 — Zero denominator: Configured 0 → UNAVAILABLE (ZERO_DENOMINATOR, value null, never 0%)', function() {
  reset();
  // Closed day (Friday)
  const friPeriod = {
    start: CL(2026, 8, 28, 0, 0),
    end: CL(2026, 8, 29, 0, 0)
  };
  const result = sandbox.MetricsService.calculate('GENERATION_COMPLETENESS', friPeriod);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'UNAVAILABLE');
  assert.strictEqual(result.data.value, null);
  assert.strictEqual(result.data.reason, 'ZERO_DENOMINATOR');
});

test('GC-5 — Closed past period returns DEFERRED (HISTORICAL_NOT_PROVABLE)', function() {
  reset();
  const result = sandbox.MetricsService.calculate('GENERATION_COMPLETENESS', PAST_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'DEFERRED');
  assert.strictEqual(result.data.value, null);
});

// ─────────────────────────────────────────────────────────────
// 6. BOOKING_UTILIZATION
// ─────────────────────────────────────────────────────────────

test('BU-1 — Confirmed / Configured Capacity * 100 (e.g. 18 / 24 * 100 = 75%)', function() {
  reset();
  const slots = [];
  // 18 confirmed slots on 2026-08-24
  for (let i = 0; i < 18; i++) {
    slots.push(mkSlot('C' + i, { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 9, i), phone: PHONE }));
  }
  // 6 free slots
  for (let j = 18; j < 24; j++) {
    slots.push(mkSlot('F' + j, { status: 'FREE', sortKey: CL(2026, 8, 24, 9, j) }));
  }
  seedAvailability(slots);

  const result = sandbox.MetricsService.calculate('BOOKING_UTILIZATION', CURRENT_DAY_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 75);
  assert.strictEqual(result.data.provenance.confirmedAppointments, 18);
  assert.strictEqual(result.data.provenance.configuredCapacity, 24);
  assert.strictEqual(result.data.provenance.audience, 'DOCTOR_FACING');
});

test('BU-2 — Valid zero numerator: Confirmed 0 / Configured 24 → AVAILABLE 0 (0%)', function() {
  reset();
  seedAvailability([
    mkSlot('F1', { status: 'FREE', sortKey: CL(2026, 8, 24, 10, 0) })
  ]);
  const result = sandbox.MetricsService.calculate('BOOKING_UTILIZATION', CURRENT_DAY_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 0);
  assert.strictEqual(result.data.reason, null);
});

test('BU-3 — Zero denominator: Configured 0 → UNAVAILABLE (ZERO_DENOMINATOR, value null, never 0%)', function() {
  reset();
  const friPeriod = {
    start: CL(2026, 8, 28, 0, 0),
    end: CL(2026, 8, 29, 0, 0)
  };
  const result = sandbox.MetricsService.calculate('BOOKING_UTILIZATION', friPeriod);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'UNAVAILABLE');
  assert.strictEqual(result.data.value, null);
  assert.strictEqual(result.data.reason, 'ZERO_DENOMINATOR');
});

test('BU-4 — Diagnostic mismatch case: Configured 50, Generated 40, Confirmed 40 → BU = 80%, GC = 80%', function() {
  reset();
  // Set up 50 configured capacity (10/day * 5 days)
  seedSettings({
    work_start: '09:00',
    work_end: '14:00',
    'Slot Duration (min)': '30',
    sunday: true,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: false,
    saturday: false
  });

  // System generated 40 slots, all 40 are confirmed
  const slots = [];
  for (let i = 0; i < 40; i++) {
    slots.push(mkSlot('C' + i, { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 9, i), phone: PHONE }));
  }
  seedAvailability(slots);

  const bu = sandbox.MetricsService.calculate('BOOKING_UTILIZATION', CURRENT_WEEK_P);
  assert.strictEqual(bu.data.value, 80); // 40 / 50 * 100 = 80% (NOT 40/40 = 100%)

  const gc = sandbox.MetricsService.calculate('GENERATION_COMPLETENESS', CURRENT_WEEK_P);
  assert.strictEqual(gc.data.value, 80); // 40 / 50 * 100 = 80%

  assert.ok(bu.data.provenance.denominatorRationale.indexOf('Configured Capacity') !== -1);
});

test('BU-5 — Closed past period returns DEFERRED (HISTORICAL_NOT_PROVABLE)', function() {
  reset();
  const result = sandbox.MetricsService.calculate('BOOKING_UTILIZATION', PAST_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'DEFERRED');
  assert.strictEqual(result.data.value, null);
});

// ─────────────────────────────────────────────────────────────
// 7. THREE-WAY DISTINCTION: CONFIGURED ≠ OBSERVED ≠ BOOKABLE
// ─────────────────────────────────────────────────────────────

test('COB-1 — Three-way distinction: Configured 24 ≠ Generated 20 ≠ Bookable Now 12', function() {
  reset();
  // NOW is 12:00 -> lead cutoff is 13:00 (+60 min)
  const slots = [];
  // 4 morning slots (past/before lead cutoff): FREE (09:00, 10:00, 11:00, 12:00)
  slots.push(mkSlot('S1', { status: 'FREE', sortKey: CL(2026, 8, 24, 9, 0) }));
  slots.push(mkSlot('S2', { status: 'FREE', sortKey: CL(2026, 8, 24, 10, 0) }));
  slots.push(mkSlot('S3', { status: 'FREE', sortKey: CL(2026, 8, 24, 11, 0) }));
  slots.push(mkSlot('S4', { status: 'FREE', sortKey: CL(2026, 8, 24, 12, 0) }));
  // 4 confirmed afternoon slots (13:00, 13:30, 14:00, 14:30)
  slots.push(mkSlot('S5', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 13, 0), phone: PHONE }));
  slots.push(mkSlot('S6', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 13, 30), phone: PHONE }));
  slots.push(mkSlot('S7', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 14, 0), phone: PHONE }));
  slots.push(mkSlot('S8', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 14, 30), phone: PHONE }));
  // 12 free future slots >= 15:00 (eligible)
  for (let k = 0; k < 12; k++) {
    slots.push(mkSlot('F' + k, { status: 'FREE', sortKey: CL(2026, 8, 24, 15, k) }));
  }
  // Total generated = 4 + 4 + 12 = 20 slots
  seedAvailability(slots);

  const batch = sandbox.MetricsService.calculateMany([
    'CONFIGURED_CAPACITY',
    'OBSERVED_GENERATED_CAPACITY',
    'BOOKABLE_SLOTS',
    'CONFIRMED_APPOINTMENTS'
  ], CURRENT_DAY_P);

  assert.strictEqual(batch.ok, true);
  const res = batch.data.results;
  assert.strictEqual(res.CONFIGURED_CAPACITY.value, 24);         // Configured
  assert.strictEqual(res.OBSERVED_GENERATED_CAPACITY.value, 20); // Generated
  assert.strictEqual(res.BOOKABLE_SLOTS.value, 12);              // Bookable Now
  assert.strictEqual(res.CONFIRMED_APPOINTMENTS.value, 4);        // Confirmed

  // Provenance confirms different sources and conditions
  assert.strictEqual(res.CONFIGURED_CAPACITY.provenance.source, 'Settings');
  assert.strictEqual(res.OBSERVED_GENERATED_CAPACITY.provenance.source, 'Availability');
  assert.strictEqual(res.BOOKABLE_SLOTS.provenance.source, 'Availability');
});

// ─────────────────────────────────────────────────────────────
// 8. PERFORMANCE, BATCHING & PURITY (calculateMany)
// ─────────────────────────────────────────────────────────────

test('PBP-1 — calculateMany with all 6 M1-C metrics reads Settings ONCE and Availability ONCE', function() {
  reset();
  const m1cMetrics = [
    'CONFIGURED_WORKING_DAYS',
    'CONFIGURED_CAPACITY',
    'OBSERVED_WORKING_DAYS',
    'OBSERVED_GENERATED_CAPACITY',
    'GENERATION_COMPLETENESS',
    'BOOKING_UTILIZATION'
  ];

  const result = sandbox.MetricsService.calculateMany(m1cMetrics, CURRENT_DAY_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.queryCalls['Settings'], 1);
  assert.strictEqual(state.queryCalls['Availability'], 1);
  assert.strictEqual(Object.keys(result.data.results).length, 6);
});

test('PBP-2 — calculateMany with all 12 metrics reads each source at most ONCE', function() {
  reset();
  const all12 = Object.keys(sandbox.MetricsService.METRICS);
  assert.strictEqual(all12.length, 12);

  const result = sandbox.MetricsService.calculateMany(all12, CURRENT_DAY_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.queryCalls['Settings'], 1);
  assert.strictEqual(state.queryCalls['Availability'], 1);
  assert.strictEqual(state.queryCalls['B6_LIFECYCLE'], 1);
  assert.strictEqual(state.queryCalls['ATTENDANCE_AUDIT'], 1);
  assert.strictEqual(Object.keys(result.data.results).length, 12);
});

test('PBP-3 — calculateMany fails fast if any required source fails', function() {
  reset();
  state.failRead['Settings'] = true;
  const result = sandbox.MetricsService.calculateMany([
    'CONFIRMED_APPOINTMENTS',
    'CONFIGURED_CAPACITY'
  ], CURRENT_DAY_P);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'METRIC_SOURCE_UNAVAILABLE');
});

test('PBP-4 — Metrics calculations perform zero writes, zero locks, zero sheet creation', function() {
  reset();
  sandbox.MetricsService.calculateMany(Object.keys(sandbox.MetricsService.METRICS), CURRENT_DAY_P);
  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.sheetCreates, 0);
});

// ─────────────────────────────────────────────────────────────
// 9. DOCTOR-FACING VS INTERNAL SEPARATION
// ─────────────────────────────────────────────────────────────

test('DVI-1 — getDoctorSummary returns ONLY the 3 commercial metrics without diagnostic noise', function() {
  reset();
  seedAvailability([
    mkSlot('C1', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 10, 0), phone: PHONE }),
    mkSlot('C2', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 11, 0), phone: PHONE })
  ]);

  const summary = sandbox.MetricsService.getDoctorSummary(CURRENT_DAY_P);
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.data.audience, 'DOCTOR_FACING');
  assert.strictEqual(summary.data.configuredCapacity.value, 24);
  assert.strictEqual(summary.data.confirmedAppointments.value, 2);
  // 2 / 24 * 100 = 8.333333333333334%
  assert.strictEqual(Math.round(summary.data.bookingUtilization.value * 100) / 100, 8.33);

  // Does NOT contain diagnostic metrics
  assert.strictEqual(summary.data.observedGeneratedCapacity, undefined);
  assert.strictEqual(summary.data.generationCompleteness, undefined);
});

test('DVI-2 — getDiagnosticSummary surfaces full diagnostic view with provenance', function() {
  reset();
  const diag = sandbox.MetricsService.getDiagnosticSummary(CURRENT_DAY_P);
  assert.strictEqual(diag.ok, true);
  assert.strictEqual(diag.data.audience, 'INTERNAL_DIAGNOSTIC');
  assert.strictEqual(diag.data.slotDurationInfo.source, 'CONFIGURED');
  assert.strictEqual(diag.data.slotDurationInfo.minutes, 20);
  assert.ok(diag.data.metrics.OBSERVED_GENERATED_CAPACITY !== undefined);
  assert.ok(diag.data.metrics.GENERATION_COMPLETENESS !== undefined);
});

test('DVI-3 — Audience metadata correctly categorizes all metrics', function() {
  const docMetrics = Array.from(sandbox.MetricsService.DOCTOR_FACING_METRICS);
  const diagMetrics = Array.from(sandbox.MetricsService.INTERNAL_DIAGNOSTIC_METRICS);

  assert.deepStrictEqual(docMetrics, [
    'CONFIGURED_CAPACITY',
    'CONFIRMED_APPOINTMENTS',
    'BOOKING_UTILIZATION'
  ]);

  assert.deepStrictEqual(diagMetrics, [
    'CONFIGURED_WORKING_DAYS',
    'OBSERVED_WORKING_DAYS',
    'OBSERVED_GENERATED_CAPACITY',
    'GENERATION_COMPLETENESS',
    'BOOKABLE_SLOTS'
  ]);
});

// ─────────────────────────────────────────────────────────────
// 10. STRUCTURAL & CONSTITUTIONAL INTEGRITY
// ─────────────────────────────────────────────────────────────

test('SCI-1 — Structural: MetricsService does not reference forbidden globals or Date constructor', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'Application/MetricsService.js'), 'utf8'));

  ['SpreadsheetApp', 'CalendarApp', 'UrlFetchApp', 'new Date(', 'LockService',
   'PropertiesService', 'LogRepository', 'SYSTEM_LOG'].forEach(function(forbidden) {
    assert.strictEqual(src.indexOf(forbidden), -1, 'MetricsService must not reference ' + forbidden);
  });

  assert.ok(src.indexOf('Clock.now()') !== -1);
  assert.ok(src.indexOf('SettingsRepository.getSettingsResult') !== -1);
  assert.ok(src.indexOf('SlotRepository.queryResult') !== -1);
});

test('SCI-2 — Structural: No fixed 24 slots/day or 7 working days constants in MetricsService', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'Application/MetricsService.js'), 'utf8'));

  assert.strictEqual(src.indexOf('24 *'), -1, 'no fixed 24 slots/day formula');
  assert.strictEqual(src.indexOf('DEFAULT_CAPACITY = 24'), -1, 'no hardcoded 24 capacity');
  assert.strictEqual(src.indexOf('WORKING_DAYS = 7'), -1, 'no fixed 7 working days');
});

test('SCI-3 — SettingsRepository provides getSettingsResult and getSlotDurationInfo without breaking legacy', function() {
  reset();
  const res = sandbox.SettingsRepository.getSettingsResult();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.work_start, '09:00');

  const durInfo = sandbox.SettingsRepository.getSlotDurationInfo();
  assert.strictEqual(durInfo.source, 'CONFIGURED');
  assert.strictEqual(durInfo.minutes, 20);

  // Legacy methods continue to work
  assert.strictEqual(sandbox.SettingsRepository.getSlotDurationMinutes(), 20);
  assert.strictEqual(sandbox.SettingsRepository.get('work_start'), '09:00');
});

test('SCI-4 — Evaluation-order independence: MetricsService resolves dependencies at call time', function() {
  const isoSandbox = vm.createContext({ console: console });
  isoSandbox.Result = sandbox.Result;
  isoSandbox.Clock = sandbox.Clock;

  const msSource = fs.readFileSync(path.join(ROOT, 'Application/MetricsService.js'), 'utf8');
  assert.doesNotThrow(function() {
    vm.runInContext(msSource + '\nthis.MetricsService = MetricsService;', isoSandbox);
  }, 'MetricsService must evaluate cleanly before Config / Repositories are defined');
});

// ═══════════════════════════════════════════════════════════════
// Execution
// ═══════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

tests.forEach(function(t) {
  try {
    t.fn();
    passed++;
    console.log('PASS: ' + t.name);
  } catch (e) {
    failed++;
    console.error('FAIL: ' + t.name);
    console.error(e);
  }
});

console.log('\n' + passed + '/' + tests.length + ' tests passed' + (failed ? ' (' + failed + ' failed)' : ''));
if (failed > 0) process.exit(1);
