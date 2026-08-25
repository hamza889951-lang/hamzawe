'use strict';

/**
 * HardeningM1B.test.js — M1-B (PHASE 1.3 — REPORT CONSUMERS)
 *
 * Proves the M1-B contract on top of the frozen M1-A foundation:
 *   A — Reporting calendar vs clinic working schedule (M1-B
 *       correction): REPORT_WEEK_START = Saturday is ONLY how a
 *       Weekly report splits the calendar — never a working-day or
 *       capacity statement. The clinic schedule/capacity reality is
 *       produced by Settings → Slot Generation → Availability and is
 *       read, never invented; historical schedule must be provable
 *       or DEFERRED.
 *   D — Daily periods (clinic-local day; start inclusive / end
 *       exclusive; month-crossing day boundaries)
 *   W — Weekly periods (explicit frozen Saturday start; week grid;
 *       week transitions; contiguity; week start is a day start)
 *   M — Monthly periods (first-of-month → first-of-next-month; month
 *       and YEAR transitions; February length)
 *   T — Timezone determinism (explicit Asia/Baghdad UTC+3, host-locale
 *       independence by construction) + reference validation
 *   C — Consumption (calculateMany is THE single path — one batched
 *       call, all six M1-A metrics, the report's exact period passed
 *       through; zero independent calculate() calls)
 *   S — Status semantics (all AVAILABLE → COMPLETE; §32 closed
 *       historical period → CONFIRMED/BOOKABLE DEFERRED while the four
 *       evidence metrics stay AVAILABLE → PARTIAL, never
 *       confirmed=0; §33 current period snapshots AVAILABLE; §34
 *       source failure fails generation verbatim — never zero, never
 *       an empty report; UNAVAILABLE and future statuses → PARTIAL)
 *   Z — Zero semantics (AVAILABLE 0 = valid measured zero ≠ DEFERRED
 *       null ≠ UNAVAILABLE null, distinguished within one report)
 *   V — Provenance (metric envelopes survive composition verbatim —
 *       full provenance chain Report → Metric → Source → Period)
 *   B — Behavioural boundaries through reports (start inclusive /
 *       end exclusive proven end-to-end for day / week / month / year
 *       transitions via official cancellations)
 *   R — Renderer (presentation only: prints DTO, never recomputes,
 *       honest DEFERRED/N/A lines, no ratios — no '%')
 *   X — Side effects & architecture (read-only; structural source
 *       scan of the three new files; clasp alphabetical
 *       evaluation-order independence with call-time bindings)
 *
 * All test anchors are clinic-local wall clocks materialized through
 * an EXPLICIT fixed +03:00 offset (Asia/Baghdad, frozen M1-B
 * contract) and Date.UTC cross-checks — the file never depends on the
 * host timezone (verifiable by running it under different TZ values).
 *
 * Regression (M0 + B1–B6 + M1-A = 192/192) is executed from the
 * existing Hardening*.test.js files against the same tree.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';

// ── Clinic-local wall-clock anchors (host-timezone independent) ──
// CL(2026, 8, 24, 12, 0) = 2026-08-24 12:00 Asia/Baghdad (+03:00)
//                                    = 2026-08-24T09:00:00Z
const CLINIC_OFFSET_MS = 180 * 60000;
function CL(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour || 0, minute || 0) - CLINIC_OFFSET_MS;
}
const DAY_MS = 86400000;

// Frozen Clock: Monday 2026-08-24 12:00 clinic-local.
const NOW_MS = CL(2026, 8, 24, 12, 0);

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Realm/prototype-agnostic structural clone for deep comparisons. */
function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ═══════════════════════════════════════════════════════════════
// Sandbox — production M1-B stack over an in-memory GoogleSheets seam
// ═══════════════════════════════════════════════════════════════

function createReportSandbox() {
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

  // Single V8 realm discipline (same as M1 tests): sheet Dates are
  // created inside the sandbox realm.
  vm.runInContext('this.mkVmDate = function(ms) { return new Date(ms); };', sandbox);

  // Faithful production GoogleSheets read surface; every mutation is
  // instrumented to FAIL the test if report generation ever touches it.
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
    getOrCreateSheet: function(name) {
      state.sheetCreates += 1;
      throw new Error('M1B_REPORTS_MUST_NOT_CREATE_SHEETS: ' + name);
    },
    appendRow: function(name) {
      state.writes += 1;
      throw new Error('M1B_REPORTS_MUST_NOT_WRITE: appendRow ' + name);
    },
    appendRows: function(name) {
      state.writes += 1;
      throw new Error('M1B_REPORTS_MUST_NOT_WRITE: appendRows ' + name);
    },
    updateRowByColumn: function(name) {
      state.writes += 1;
      throw new Error('M1B_REPORTS_MUST_NOT_WRITE: updateRowByColumn ' + name);
    },
    updateBatch: function(name) {
      state.writes += 1;
      throw new Error('M1B_REPORTS_MUST_NOT_WRITE: updateBatch ' + name);
    },
    deleteRowsByNumbers: function(name) {
      state.writes += 1;
      throw new Error('M1B_REPORTS_MUST_NOT_WRITE: deleteRowsByNumbers ' + name);
    }
  };

  // Production stack (all cross-module references resolve at call time).
  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('StateMachine.js', 'StateMachine');
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('Repositories/AttendanceAuditRepository.js', 'AttendanceAuditRepository');
  load('Repositories/AttendanceAuditReadRepository.js', 'AttendanceAuditReadRepository');
  load('Repositories/B6LifecycleRepository.js', 'B6LifecycleRepository');
  load('Application/B6LifecycleService.js', 'B6LifecycleService');
  load('Application/MetricsService.js', 'MetricsService');
  load('Utils/ReportPeriod.js', 'ReportPeriod');
  load('Application/ReportService.js', 'ReportService');
  load('Application/ReportRenderer.js', 'ReportRenderer');

  return { sandbox: sandbox, state: state };
}

const core = createReportSandbox();
const sandbox = core.sandbox;
const state = core.state;

// ── Sheet seeding helpers ────────────────────────────────────────

const AV_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];

/**
 * Availability row. sortKey is a 13-digit EPOCH number on purpose:
 * LegacySlotTimeParser passes those through verbatim, so the row's
 * position is the exact clinic-local instant the test chose —
 * independent of the host timezone (12-digit YYYYMMDDHHmm sort keys
 * would be interpreted through the executing realm's locale).
 */
function mkSlot(id, opts) {
  const o = opts || {};
  return {
    slot_id: id,
    date: '2026/08/24',
    time: '16:00',
    sort_key: o.sortKey,
    status: o.status || 'FREE',
    is_available: o.isAvailable !== undefined ? o.isAvailable : true,
    patient_name: o.patient || (o.phone ? 'Patient ' + o.phone : ''),
    phone: o.phone || '',
    calendar_event_id: o.eventId || '',
    Reminder_sent: '',
    whatsapp_message_id: '',
    reserved_until: '',
    reserved_until_unix: ''
  };
}

function seedAvailability(rows) {
  state.sheets['Availability'] = { headers: AV_HEADERS.slice(), rows: rows || [] };
}

function mkLifecycle(opId, lifecycleState, checkpoint, tsMs, opts) {
  const o = opts || {};
  const ts = sandbox.mkVmDate(tsMs);
  return {
    operation_id: opId,
    phone: o.phone || PHONE,
    command: o.command || 'CANCEL',
    old_slot_id: o.oldSlotId || ('OLD_' + opId),
    new_slot_id: o.newSlotId || '',
    lifecycle_state: lifecycleState,
    ownership_state: o.ownershipState || 'RELEASED',
    checkpoint: checkpoint,
    calendar_event_id: '',
    calendar_correlation_id: opId,
    calendar_id: '',
    recovery_state: o.recoveryState || '',
    recovery_case_id: o.recoveryCaseId || '',
    created_at: sandbox.mkVmDate(tsMs - 3600000),
    updated_at: ts,
    timestamp: ts,
    details: ''
  };
}

/** Terminal-proof cancellation row at tsMs. */
function mkCancel(opId, tsMs) {
  return mkLifecycle(
    opId,
    sandbox.B6LifecycleService.LIFECYCLE_STATES.RESOLVED_CANCEL,
    sandbox.B6LifecycleService.CHECKPOINTS.TERMINAL_CANCEL_PROVEN,
    tsMs
  );
}

/** Terminal-proof change row at tsMs. */
function mkChange(opId, tsMs) {
  return mkLifecycle(
    opId,
    sandbox.B6LifecycleService.LIFECYCLE_STATES.RESOLVED_CHANGE,
    sandbox.B6LifecycleService.CHECKPOINTS.TERMINAL_CHANGE_PROVEN,
    tsMs,
    { command: 'CHANGE' }
  );
}

function seedLifecycle(rows) {
  state.sheets['B6_LIFECYCLE'] = {
    headers: sandbox.B6LifecycleRepository.HEADERS.slice(),
    rows: rows || []
  };
}

function mkAudit(slotId, decision, toStatus, outcome, tsMs) {
  return {
    operator_id: 'doctor.test@hamzawe.clinic',
    calendar_event_id: 'EV_' + slotId,
    calendar_id: 'CAL_DEFAULT',
    slot_id: slotId,
    decision: decision,
    from_status: outcome === 'APPLIED' ? 'CONFIRMED' : toStatus,
    to_status: toStatus,
    outcome: outcome,
    error_code: outcome === 'APPLIED' ? '' : 'SOME_CODE',
    timestamp: sandbox.mkVmDate(tsMs)
  };
}

function mkCompleted(slotId, tsMs) {
  return mkAudit(slotId, 'MARK_COMPLETED', sandbox.Config.VOCABULARY.STATUS.COMPLETED, 'APPLIED', tsMs);
}

function mkNoShow(slotId, tsMs) {
  return mkAudit(slotId, 'MARK_NO_SHOW', sandbox.Config.VOCABULARY.STATUS.NO_SHOW, 'APPLIED', tsMs);
}

function seedAttendance(rows) {
  state.sheets['ATTENDANCE_AUDIT'] = {
    headers: sandbox.AttendanceAuditRepository.HEADERS.slice(),
    rows: rows || []
  };
}

function seedAllEmpty() {
  seedAvailability([]);
  seedLifecycle([]);
  seedAttendance([]);
}

function reset() {
  state.nowMs = NOW_MS;
  state.sheets = {};
  state.failRead = {};
  state.queryCalls = {};
  state.headerCalls = {};
  state.writes = 0;
  state.sheetCreates = 0;
}

/**
 * Instruments MetricsService.calculateMany (and calculate) so tests can
 * prove ReportService uses the batched foundation path with the exact
 * period. Restores the originals via .restore().
 */
function spyMetrics() {
  const originalMany = sandbox.MetricsService.calculateMany;
  const originalSingle = sandbox.MetricsService.calculate;
  const calls = { many: [], single: 0 };
  sandbox.MetricsService.calculateMany = function(names, period) {
    calls.many.push({
      names: Array.from(names).map(String),
      start: period.start,
      end: period.end
    });
    return originalMany.apply(sandbox.MetricsService, arguments);
  };
  sandbox.MetricsService.calculate = function() {
    calls.single += 1;
    return originalSingle.apply(sandbox.MetricsService, arguments);
  };
  return {
    calls: calls,
    restore: function() {
      sandbox.MetricsService.calculateMany = originalMany;
      sandbox.MetricsService.calculate = originalSingle;
    }
  };
}

const SIX_METRICS = [
  'CONFIRMED_APPOINTMENTS',
  'OFFICIAL_CANCELLATIONS',
  'OFFICIAL_CHANGES',
  'COMPLETED_APPOINTMENTS',
  'NO_SHOW_APPOINTMENTS',
  'BOOKABLE_SLOTS'
];

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ── D — Daily periods ───────────────────────────────────────────

test('M1B-D1 — Daily boundaries: one clinic-local day, start inclusive / end exclusive, UTC cross-check', function() {
  reset();
  seedAllEmpty();
  const result = sandbox.ReportService.generateDaily(CL(2026, 8, 24, 12, 34));
  assert.strictEqual(result.ok, true);
  const period = result.data.period;
  // 2026-08-24 clinic day = [2026-08-23T21:00Z, 2026-08-24T21:00Z)
  assert.strictEqual(period.startMs, Date.UTC(2026, 7, 23, 21, 0));
  assert.strictEqual(period.endMs, Date.UTC(2026, 7, 24, 21, 0));
  assert.strictEqual(period.endMs - period.startMs, DAY_MS);
  // metadata: frozen clinic timezone, explicit offset, no 23:59:59.999
  assert.strictEqual(period.timeZone, 'Asia/Baghdad');
  assert.strictEqual(period.utcOffsetMinutes, 180);
  assert.strictEqual(period.startWallClock, '2026-08-24T00:00:00+03:00');
  assert.strictEqual(period.endWallClock, '2026-08-25T00:00:00+03:00');
  assert.ok(period.periodSemantics.indexOf('start inclusive, end exclusive') !== -1);
  assert.strictEqual(period.wallClock.start.day, 24);
  assert.strictEqual(period.wallClock.end.day, 25);
});

test('M1B-D2 — Daily: reference exactly at day start belongs to that day; last ms of the day stays in it', function() {
  reset();
  seedAllEmpty();
  const atStart = sandbox.ReportService.generateDaily(CL(2026, 8, 24, 0, 0));
  assert.strictEqual(atStart.data.period.startMs, Date.UTC(2026, 7, 23, 21, 0));
  const atLastMs = sandbox.ReportService.generateDaily(CL(2026, 8, 24, 23, 59) + 59999);
  assert.strictEqual(atLastMs.data.period.startMs, atStart.data.period.startMs);
  assert.strictEqual(atLastMs.data.period.endMs, atStart.data.period.endMs);
  // reference exactly at the END boundary is the NEXT day (end exclusive)
  const nextDay = sandbox.ReportService.generateDaily(CL(2026, 8, 25, 0, 0));
  assert.strictEqual(nextDay.data.period.startMs, atStart.data.period.endMs);
});

test('M1B-D3 — Daily across month boundary: 2026-09-01 clinic day spans the August→September instant', function() {
  reset();
  seedAllEmpty();
  const result = sandbox.ReportService.generateDaily(CL(2026, 9, 1, 0, 30));
  assert.strictEqual(result.data.period.startMs, Date.UTC(2026, 7, 31, 21, 0)); // Sep 1 00:00 +03
  assert.strictEqual(result.data.period.endMs, Date.UTC(2026, 7, 31, 21, 0) + DAY_MS);
  assert.strictEqual(result.data.period.startWallClock, '2026-09-01T00:00:00+03:00');
  assert.strictEqual(result.data.period.endWallClock, '2026-09-02T00:00:00+03:00');
});

// ── W — Weekly periods ──────────────────────────────────────────

test('M1B-W1 — Weekly: explicit frozen REPORT_WEEK_START = Saturday (reporting calendar; Mon 2026-08-24 → week Sat 08-22 .. Sat 08-29)', function() {
  reset();
  seedAllEmpty();
  const result = sandbox.ReportService.generateWeekly(CL(2026, 8, 24, 12, 0));
  assert.strictEqual(result.ok, true);
  const period = result.data.period;
  assert.strictEqual(period.startMs, Date.UTC(2026, 7, 21, 21, 0)); // Sat 2026-08-22 00:00 clinic
  assert.strictEqual(period.endMs, Date.UTC(2026, 7, 21, 21, 0) + 7 * DAY_MS); // Sat 2026-08-29
  assert.strictEqual(period.endMs - period.startMs, 7 * DAY_MS);
  assert.strictEqual(period.reportWeekStart, 6); // reporting calendar convention — NOT a working week
  assert.strictEqual(period.startWallClock, '2026-08-22T00:00:00+03:00');
  assert.strictEqual(period.endWallClock, '2026-08-29T00:00:00+03:00');
});

test('M1B-W2 — Weekly grid: Friday late night stays in the Saturday-start week; Saturday morning rolls to the next week', function() {
  reset();
  seedAllEmpty();
  const fridayNight = sandbox.ReportService.generateWeekly(CL(2026, 8, 28, 23, 30));
  assert.strictEqual(fridayNight.data.period.startMs, Date.UTC(2026, 7, 21, 21, 0));
  const saturdayMorning = sandbox.ReportService.generateWeekly(CL(2026, 8, 29, 0, 30));
  assert.strictEqual(saturdayMorning.data.period.startMs, Date.UTC(2026, 7, 28, 21, 0)); // Sat 08-29
  assert.strictEqual(saturdayMorning.data.period.endMs, Date.UTC(2026, 7, 28, 21, 0) + 7 * DAY_MS); // Sat 09-05
});

test('M1B-W3 — Weekly transition contiguity: no gap and no overlap at the Saturday boundary', function() {
  reset();
  seedAllEmpty();
  const lastInstantOfWeek = sandbox.ReportPeriod.weeklyPeriod(CL(2026, 8, 28, 23, 59) + 59999);
  const firstInstantOfNextWeek = sandbox.ReportPeriod.weeklyPeriod(CL(2026, 8, 29, 0, 0));
  assert.strictEqual(lastInstantOfWeek.data.endMs, firstInstantOfNextWeek.data.startMs);
  assert.strictEqual(firstInstantOfNextWeek.data.startMs, Date.UTC(2026, 7, 28, 21, 0));
});

test('M1B-W4 — Weekly/ daily grid consistency: the week start is itself a clinic-local day start', function() {
  reset();
  seedAllEmpty();
  const week = sandbox.ReportPeriod.weeklyPeriod(CL(2026, 8, 26, 15, 0));
  const itsSaturday = sandbox.ReportPeriod.dailyPeriod(week.data.startMs + 1);
  assert.strictEqual(week.data.startMs, itsSaturday.data.startMs);
  // Every day of the week starts on the same wall-clock grid (UTC+3).
  for (var i = 0; i < 7; i++) {
    const day = sandbox.ReportPeriod.dailyPeriod(week.data.startMs + i * DAY_MS + 1);
    assert.strictEqual(day.data.startMs, week.data.startMs + i * DAY_MS);
  }
});

// ── M — Monthly periods ─────────────────────────────────────────

test('M1B-M1 — Monthly: August 2026 = [Aug 1, Sep 1) clinic-local, never last-day 23:59:59.999', function() {
  reset();
  seedAllEmpty();
  const result = sandbox.ReportService.generateMonthly(CL(2026, 8, 15, 10, 0));
  const period = result.data.period;
  // Aug 1 00:00 +03:00 = Jul 31 21:00 UTC (month index 6)
  assert.strictEqual(period.startMs, Date.UTC(2026, 6, 31, 21, 0));
  assert.strictEqual(period.endMs, Date.UTC(2026, 6, 31, 21, 0) + 31 * DAY_MS); // Sep 1 00:00 +03
  assert.strictEqual(period.startWallClock, '2026-08-01T00:00:00+03:00');
  assert.strictEqual(period.endWallClock, '2026-09-01T00:00:00+03:00');
  assert.strictEqual(period.wallClock.start.day, 1);
  assert.strictEqual(period.wallClock.end.day, 1);
  assert.strictEqual(period.wallClock.end.month, 9);
});

test('M1B-M2 — Monthly contiguity: July.end === August.start (month transition, no gap/overlap)', function() {
  reset();
  seedAllEmpty();
  const july = sandbox.ReportPeriod.monthlyPeriod(CL(2026, 7, 15, 0, 0));
  const august = sandbox.ReportPeriod.monthlyPeriod(CL(2026, 8, 15, 0, 0));
  assert.strictEqual(july.data.endMs, august.data.startMs);
  assert.strictEqual(july.data.endMs, Date.UTC(2026, 6, 31, 21, 0)); // Aug 1 00:00 +03
});

test('M1B-M3 — Monthly year transition: December 2026 ends at 2027-01-01 clinic-local', function() {
  reset();
  seedAllEmpty();
  const result = sandbox.ReportService.generateMonthly(CL(2026, 12, 20, 12, 0));
  const period = result.data.period;
  assert.strictEqual(period.startMs, Date.UTC(2026, 10, 30, 21, 0)); // Dec 1 00:00 +03
  assert.strictEqual(period.endMs, Date.UTC(2026, 11, 31, 21, 0));   // Jan 1 2027 00:00 +03
  assert.strictEqual(period.startWallClock, '2026-12-01T00:00:00+03:00');
  assert.strictEqual(period.endWallClock, '2027-01-01T00:00:00+03:00');
});

test('M1B-M4 — Monthly: February 2026 (non-leap) is exactly 28 days', function() {
  reset();
  seedAllEmpty();
  const feb = sandbox.ReportPeriod.monthlyPeriod(CL(2026, 2, 14, 0, 0));
  assert.strictEqual(feb.data.endMs - feb.data.startMs, 28 * DAY_MS);
});

// ── T — Timezone determinism + validation ───────────────────────

test('M1B-T1 — Timezone determinism: wall fields via explicit +03:00 arithmetic, round-trip stable, no host locale', function() {
  reset();
  const RP = sandbox.ReportPeriod;
  assert.strictEqual(RP.CLINIC_TIME_ZONE, 'Asia/Baghdad');
  assert.strictEqual(RP.CLINIC_UTC_OFFSET_MINUTES, 180);
  // NOW = Monday 2026-08-24 12:00 clinic — independent of host timezone
  const fields = RP.wallFields(NOW_MS);
  assert.strictEqual(fields.year, 2026);
  assert.strictEqual(fields.month, 8);
  assert.strictEqual(fields.day, 24);
  assert.strictEqual(fields.hour, 12);
  assert.strictEqual(fields.minute, 0);
  assert.strictEqual(fields.weekday, 1); // Monday
  // round trip: instant → wall → instant is identity
  assert.strictEqual(RP.fromWallMs(RP.toWallMs(NOW_MS)), NOW_MS);
  // composition law: instantOf(wallFields(x)) === x
  assert.strictEqual(RP.instantOf(fields.year, fields.month, fields.day, fields.hour, fields.minute), NOW_MS);
  // wall-clock string carries the explicit fixed offset
  assert.strictEqual(RP.formatWallClock(CL(2026, 1, 1, 0, 0)), '2026-01-01T00:00:00+03:00');
});

test('M1B-T2 — Reference validation: strings/NaN/Infinity/invalid Date rejected, no ambiguous parsing', function() {
  reset();
  const RP = sandbox.ReportPeriod;
  ['2026-08-24', '', NaN, Infinity, -Infinity, null, {}, undefined].forEach(function(bad) {
    const result = RP.dailyPeriod(bad);
    assert.strictEqual(result.ok, false, String(bad));
    assert.strictEqual(result.error.code, 'REPORT_PERIOD_INVALID');
  });
  const invalidDate = new Date(NaN);
  assert.strictEqual(RP.weeklyPeriod(invalidDate).ok, false);
  assert.strictEqual(RP.monthlyPeriod(invalidDate).ok, false);
  // valid forms accepted
  assert.strictEqual(RP.dailyPeriod(CL(2026, 8, 24, 12, 0)).ok, true);
  assert.strictEqual(RP.dailyPeriod(sandbox.mkVmDate(CL(2026, 8, 24, 12, 0))).ok, true);
});

test('M1B-T3 — ReportService validation: unknown type and invalid reference fail cleanly', function() {
  reset();
  seedAllEmpty();
  const unknownType = sandbox.ReportService.generate('HOURLY', CL(2026, 8, 24, 12, 0));
  assert.strictEqual(unknownType.ok, false);
  assert.strictEqual(unknownType.error.code, 'REPORT_TYPE_UNKNOWN');

  const badRef = sandbox.ReportService.generateDaily('2026-08-24');
  assert.strictEqual(badRef.ok, false);
  assert.strictEqual(badRef.error.code, 'REPORT_REFERENCE_INVALID');

  const badRef2 = sandbox.ReportService.generateWeekly(NaN);
  assert.strictEqual(badRef2.error.code, 'REPORT_REFERENCE_INVALID');

  // dispatcher and convenience methods produce the same reportType
  const viaDispatch = sandbox.ReportService.generate('MONTHLY', CL(2026, 8, 15, 0, 0));
  const viaMethod = sandbox.ReportService.generateMonthly(CL(2026, 8, 15, 0, 0));
  assert.strictEqual(viaDispatch.data.reportType, 'MONTHLY');
  assert.strictEqual(viaMethod.data.reportType, 'MONTHLY');
  assert.strictEqual(viaDispatch.data.period.startMs, viaMethod.data.period.startMs);
});

// ── A — Reporting calendar vs clinic working schedule (M1-B correction) ──
// Availability rows below stand in for the OUTPUT of the frozen
// pipeline Settings → Slot Generation → Availability: varying them
// simulates different real clinic schedules (open/closed days,
// slots/day). M1-B itself never reads Settings and never invents a
// schedule — it only reads the produced reality through MetricsService.
// NOTE: BOOKABLE_SLOTS is NOT raw capacity and NOT the generated-slot
// count — it counts the M1-A eligibility (FREE + is_available +
// slotStart >= now + 60 minutes) exactly as defined by M1-A.

test('M1B-A1 — REPORT_WEEK_START = Saturday does NOT mean Saturday is a working day', function() {
  reset();
  // Clinic reality for the current week: Saturday CLOSED (zero slots
  // on Saturday); slots exist only on some other days.
  const rows = [
    mkSlot('SUN', { status: 'FREE', sortKey: CL(2026, 8, 23, 14, 0) }),
    mkSlot('MON', { status: 'FREE', sortKey: CL(2026, 8, 24, 14, 0) }),
    mkSlot('TUE', { status: 'FREE', sortKey: CL(2026, 8, 25, 14, 0) }),
    mkSlot('THU', { status: 'FREE', sortKey: CL(2026, 8, 27, 14, 0) })
  ];
  seedAvailability(rows);
  seedLifecycle([]);
  seedAttendance([]);

  const result = sandbox.ReportService.generateWeekly(CL(2026, 8, 24, 12, 0));
  assert.strictEqual(result.ok, true);
  const report = result.data;
  // The reporting calendar is independent of the working schedule:
  // the week still starts Saturday even though Saturday provably has
  // zero slots in the produced Availability.
  assert.strictEqual(report.period.reportWeekStart, 6);
  assert.strictEqual(report.period.startWallClock, '2026-08-22T00:00:00+03:00');
  assert.strictEqual(report.period.endWallClock, '2026-08-29T00:00:00+03:00');
  // Metric VALUES come from the actual data (Sun 14:00 is before the
  // bookable cutoff; Mon/Tue/Thu pass it) — data decides values,
  // never the calendar boundary.
  assert.strictEqual(report.metrics.BOOKABLE_SLOTS.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.BOOKABLE_SLOTS.value, 3);
  assert.strictEqual(report.status, 'COMPLETE'); // open week: snapshots provable
});

test('M1B-A2 — Clinic schedule change (Monday CLOSED, other days OPEN) does not move the Weekly report period', function() {
  reset();
  // Scenario 1: every day of the reporting week produced slots.
  const weekDays = [22, 23, 24, 25, 26, 27, 28];
  seedAvailability(weekDays.map(function(day) {
    return mkSlot('OPEN' + day, { status: 'FREE', sortKey: CL(2026, 8, day, 15, 0) });
  }));
  seedLifecycle([]);
  seedAttendance([]);
  const withMonday = sandbox.ReportService.generateWeekly(CL(2026, 8, 26, 10, 0));
  assert.strictEqual(withMonday.ok, true);

  // Scenario 2: the SAME week, but the produced Availability shows
  // Monday CLOSED (no Monday slots at all).
  seedAvailability(weekDays.filter(function(day) {
    return day !== 24; // drop Monday 2026-08-24
  }).map(function(day) {
    return mkSlot('NOMON' + day, { status: 'FREE', sortKey: CL(2026, 8, day, 15, 0) });
  }));
  const withoutMonday = sandbox.ReportService.generateWeekly(CL(2026, 8, 26, 10, 0));
  assert.strictEqual(withoutMonday.ok, true);

  // IDENTICAL reporting period: period ≠ schedule (now = Mon 12:00,
  // cutoff 13:00 → Mon..Fri 15:00 slots pass; Sat/Sun are past).
  assert.strictEqual(withoutMonday.data.period.startMs, withMonday.data.period.startMs);
  assert.strictEqual(withoutMonday.data.period.endMs, withMonday.data.period.endMs);
  assert.strictEqual(withoutMonday.data.period.startWallClock, '2026-08-22T00:00:00+03:00');
  assert.strictEqual(withoutMonday.data.period.endWallClock, '2026-08-29T00:00:00+03:00');
  // Metric VALUES differ — they measure the produced reality:
  assert.strictEqual(withMonday.data.metrics.BOOKABLE_SLOTS.value, 5);
  assert.strictEqual(withoutMonday.data.metrics.BOOKABLE_SLOTS.value, 4);
});

test('M1B-A3 — BOOKABLE_SLOTS follows its ACTUAL M1-A eligibility (FREE + is_available + start ≥ now+60m) — not raw capacity / generated-slot count', function() {
  reset();
  // 50 generated FREE slots on Thursday 2026-08-27, 09:00 + 10-minute
  // steps (09:00 … 17:10). 50 is the RAW GENERATED count only — it is
  // NOT the bookable count and NOT "capacity": BOOKABLE_SLOTS applies
  // the frozen M1-A eligibility filter (SlotSelection.findEarliestBookable
  // semantics: FREE + is_available + slotStart >= now + 60 minutes).
  const rows = [];
  for (var i = 0; i < 50; i++) {
    rows.push(mkSlot('GEN' + i, { status: 'FREE', sortKey: CL(2026, 8, 27, 9, 0) + i * 10 * 60000 }));
  }
  seedAvailability(rows);
  seedLifecycle([]);
  seedAttendance([]);
  assert.strictEqual(rows.length, 50); // raw generated slots on that day

  // "now" = Thursday 12:00 (same day) → booking lead cutoff 13:00.
  // Every slot starting BEFORE 13:00 fails the lead-time eligibility;
  // the slots 13:00 … 17:10 pass it. The slot at exactly 13:00 IS
  // eligible (cutoff is inclusive: >= now + 60m).
  state.nowMs = CL(2026, 8, 27, 12, 0);

  const weekly = sandbox.ReportService.generateWeekly(CL(2026, 8, 27, 12, 0));
  assert.strictEqual(weekly.ok, true);
  assert.strictEqual(weekly.data.metrics.BOOKABLE_SLOTS.status, 'AVAILABLE');
  // exactly the eligible subset (13:00…17:10) — neither the raw
  // generated count (50) nor any fixed constant:
  assert.strictEqual(weekly.data.metrics.BOOKABLE_SLOTS.value, 26);
  assert.notStrictEqual(weekly.data.metrics.BOOKABLE_SLOTS.value, rows.length); // ≠ generated count
  assert.strictEqual(weekly.data.status, 'COMPLETE'); // open week (ends Saturday)

  const daily = sandbox.ReportService.generateDaily(CL(2026, 8, 27, 12, 0));
  assert.strictEqual(daily.ok, true);
  assert.strictEqual(daily.data.metrics.BOOKABLE_SLOTS.value, 26);
  assert.strictEqual(daily.data.period.startWallClock, '2026-08-27T00:00:00+03:00');

  // Explicit eligibility proof on the same seed: a slot ONE minute
  // before the cutoff is NOT bookable; a slot AT the cutoff IS.
  seedAvailability(rows.concat([
    mkSlot('EDGE_BEFORE', { status: 'FREE', sortKey: CL(2026, 8, 27, 12, 59) }),
    mkSlot('EDGE_AT', { status: 'FREE', sortKey: CL(2026, 8, 27, 13, 0) })
  ]));
  const withEdges = sandbox.ReportService.generateDaily(CL(2026, 8, 27, 12, 0));
  assert.strictEqual(withEdges.ok, true);
  assert.strictEqual(withEdges.data.metrics.BOOKABLE_SLOTS.value, 27); // 26 + EDGE_AT only
});

test('M1B-A4 — Structural: ReportPeriod (and the reporting layer) is schedule-agnostic — no Settings/SlotGenerator/Availability references, no fixed capacity', function() {
  const rp = stripComments(fs.readFileSync(path.join(ROOT, 'Utils/ReportPeriod.js'), 'utf8'));
  ['Settings', 'SettingsRepository', 'SlotGenerator', 'SlotSelection', 'Availability'].forEach(function(token) {
    assert.strictEqual(rp.indexOf(token), -1, 'ReportPeriod must not reference ' + token);
  });
  // no working-schedule / capacity vocabulary in ReportPeriod code
  assert.strictEqual(/\bwork(ing)?[-_ ]?day/i.test(rp), false);
  assert.strictEqual(/\bwork(ing)?[-_ ]?hours/i.test(rp), false);
  assert.strictEqual(/\bcapacity\b/i.test(rp), false);
  assert.strictEqual(/\bslots?[-_ ]?per[-_ ]?day/i.test(rp), false);

  // the rest of the reporting layer is equally schedule-agnostic
  const rs = stripComments(fs.readFileSync(path.join(ROOT, 'Application/ReportService.js'), 'utf8'));
  const rr = stripComments(fs.readFileSync(path.join(ROOT, 'Application/ReportRenderer.js'), 'utf8'));
  [rs, rr].forEach(function(src, index) {
    ['Settings', 'SettingsRepository', 'SlotGenerator', 'SlotSelection', 'Availability'].forEach(function(token) {
      assert.strictEqual(src.indexOf(token), -1,
        (index === 0 ? 'ReportService' : 'ReportRenderer') + ' must not reference ' + token);
    });
    assert.strictEqual(/\bcapacity\b/i.test(src), false);
  });

  // no fixed daily-capacity constant (e.g. 24 slots/day) anywhere in
  // the three production files of M1-B
  [rp, rs, rr].forEach(function(src) {
    assert.strictEqual(/\b24\b/.test(src), false, 'no fixed 24-per-day capacity assumption in M1-B code');
  });
});

test('M1B-A5 — Structural: the separation + historical-schedule rules are documented contract (anchors)', function() {
  // Anchors are checked on the FULL sources (documentation included):
  // the correction order makes the separation an explicit contract.
  const rpFull = fs.readFileSync(path.join(ROOT, 'Utils/ReportPeriod.js'), 'utf8');
  assert.ok(rpFull.indexOf('REPORTING CALENDAR ≠ CLINIC WORKING SCHEDULE') !== -1);
  assert.ok(rpFull.indexOf('REPORT_WEEK_START = 6') !== -1);
  assert.ok(rpFull.indexOf('NOT a clinic working week') !== -1);
  assert.ok(rpFull.indexOf('NOT a statement that Saturday') !== -1);
  assert.ok(rpFull.indexOf('Settings → Slot Generation → Availability') !== -1);
  assert.ok(rpFull.indexOf('HISTORICAL SCHEDULE') !== -1);
  assert.ok(rpFull.indexOf('DEFERRED') !== -1);
  assert.ok(rpFull.indexOf('Average Patients Per Working Day') !== -1); // documented as NOT implemented here

  const rsFull = fs.readFileSync(path.join(ROOT, 'Application/ReportService.js'), 'utf8');
  assert.ok(rsFull.indexOf('REPORTING CALENDAR ≠ CLINIC WORKING SCHEDULE') !== -1);
  assert.ok(rsFull.indexOf('never guessed from current settings') !== -1 || rsFull.indexOf('NEVER assumed or hardcoded') !== -1);
});

// ── C — Consumption (the ONE metrics path) ──────────────────────

test('M1B-C1 — Consumption: exactly ONE calculateMany call per report, all six M1-A metrics, the report period passed through', function() {
  reset();
  seedAllEmpty();
  const spy = spyMetrics();
  try {
    const result = sandbox.ReportService.generateDaily();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(spy.calls.many.length, 1);
    const call = spy.calls.many[0];
    assert.deepStrictEqual(call.names, SIX_METRICS);
    // the exact same period the report exposes was passed to the foundation
    assert.strictEqual(call.start, result.data.period.startMs);
    assert.strictEqual(call.end, result.data.period.endMs);
    // every metric envelope echoes the same period
    SIX_METRICS.forEach(function(name) {
      assert.strictEqual(result.data.metrics[name].period.startMs, call.start, name);
      assert.strictEqual(result.data.metrics[name].period.endMs, call.end, name);
    });
  } finally {
    spy.restore();
  }
});

test('M1B-C2 — Daily/Weekly/Monthly differ ONLY in the period: identical metric set, identical path', function() {
  reset();
  seedAllEmpty();
  const spy = spyMetrics();
  try {
    const ref = CL(2026, 8, 24, 12, 0); // open day/week/month → all three read everything
    const daily = sandbox.ReportService.generateDaily(ref);
    const weekly = sandbox.ReportService.generateWeekly(ref);
    const monthly = sandbox.ReportService.generateMonthly(ref);
    [daily, weekly, monthly].forEach(function(r) { assert.strictEqual(r.ok, true); });

    assert.strictEqual(spy.calls.many.length, 3);
    const nameSets = spy.calls.many.map(function(c) { return c.names.join(','); });
    assert.strictEqual(nameSets[0], nameSets[1]);
    assert.strictEqual(nameSets[1], nameSets[2]);
    assert.deepStrictEqual(spy.calls.many[0].names, SIX_METRICS);

    // periods differ exactly as ReportPeriod prescribes for each type
    assert.strictEqual(spy.calls.many[0].start, sandbox.ReportPeriod.dailyPeriod(ref).data.startMs);
    assert.strictEqual(spy.calls.many[1].start, sandbox.ReportPeriod.weeklyPeriod(ref).data.startMs);
    assert.strictEqual(spy.calls.many[2].start, sandbox.ReportPeriod.monthlyPeriod(ref).data.startMs);

    // same open-period semantics: all three are COMPLETE over empty stores
    assert.strictEqual(daily.data.status, 'COMPLETE');
    assert.strictEqual(weekly.data.status, 'COMPLETE');
    assert.strictEqual(monthly.data.status, 'COMPLETE');
  } finally {
    spy.restore();
  }
});

test('M1B-C3 — The report carries exactly the six M1-A metrics, in canonical order, no more no fewer', function() {
  reset();
  seedAllEmpty();
  const result = sandbox.ReportService.generateWeekly();
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(Array.from(result.data.requestedMetrics), SIX_METRICS);
  assert.deepStrictEqual(Object.keys(result.data.metrics), SIX_METRICS);
});

test('M1B-C4 — calculateMany is THE path: zero independent MetricsService.calculate calls while generating reports', function() {
  reset();
  seedAllEmpty();
  const spy = spyMetrics();
  try {
    sandbox.ReportService.generateDaily();
    sandbox.ReportService.generateWeekly();
    sandbox.ReportService.generateMonthly();
    assert.strictEqual(spy.calls.single, 0);
    assert.strictEqual(spy.calls.many.length, 3);
  } finally {
    spy.restore();
  }
});

// ── S — Status semantics ────────────────────────────────────────

test('M1B-S1 — §33 Current period: CONFIRMED and BOOKABLE stay AVAILABLE and the report is COMPLETE', function() {
  reset();
  // now = 2026-08-24 12:00 clinic; bookable cutoff = 13:00
  seedAvailability([
    mkSlot('C1', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 10, 0), phone: PHONE }),
    mkSlot('B1', { status: 'FREE', sortKey: CL(2026, 8, 24, 14, 0) })      // bookable (≥ 13:00)
  ]);
  seedLifecycle([]);
  seedAttendance([]);

  const result = sandbox.ReportService.generateDaily(); // reference = Clock.now()
  assert.strictEqual(result.ok, true);
  const report = result.data;
  assert.strictEqual(report.status, 'COMPLETE');
  assert.strictEqual(report.statusReason, null);

  assert.strictEqual(report.metrics.CONFIRMED_APPOINTMENTS.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.CONFIRMED_APPOINTMENTS.value, 1);
  assert.strictEqual(report.metrics.BOOKABLE_SLOTS.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.BOOKABLE_SLOTS.value, 1);
  // evidence metrics over an empty evidence store = valid zeros, AVAILABLE
  assert.strictEqual(report.metrics.COMPLETED_APPOINTMENTS.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.COMPLETED_APPOINTMENTS.value, 0);
  assert.strictEqual(report.metrics.NO_SHOW_APPOINTMENTS.value, 0);
  assert.strictEqual(report.metrics.OFFICIAL_CANCELLATIONS.value, 0);
  assert.strictEqual(report.metrics.OFFICIAL_CHANGES.value, 0);

  assert.deepStrictEqual(Array.from(report.statusBreakdown.AVAILABLE), SIX_METRICS);
});

test('M1B-S2 — §32 THE historical test: closed day → CONFIRMED/BOOKABLE DEFERRED, four evidence metrics AVAILABLE → PARTIAL, never confirmed=0', function() {
  reset();
  // Closed clinic-local day: Thursday 2026-08-20 (end 2026-08-21 00:00 < now)
  seedAvailability([
    mkSlot('OLD1', { status: 'COMPLETED', sortKey: CL(2026, 8, 20, 10, 0), phone: PHONE }),
    mkSlot('OLD2', { status: 'FREE', sortKey: CL(2026, 8, 20, 11, 0) })
  ]);
  seedLifecycle([
    mkCancel('OP1', CL(2026, 8, 20, 9, 0)),
    mkCancel('OP2', CL(2026, 8, 20, 10, 30)),
    mkCancel('OP2_RETRY_EXTRA_ROW', CL(2026, 8, 20, 10, 45)), // distinct op id — counted
    mkChange('CH1', CL(2026, 8, 20, 11, 0))
  ]);
  seedAttendance([
    mkCompleted('OLD1', CL(2026, 8, 20, 13, 0)),
    mkCompleted('OLD2', CL(2026, 8, 20, 13, 30)),
    mkNoShow('OLD3', CL(2026, 8, 20, 14, 0))
  ]);

  const result = sandbox.ReportService.generateDaily(CL(2026, 8, 20, 15, 0));
  assert.strictEqual(result.ok, true);
  const report = result.data;

  // snapshot semantics reach the report untouched
  assert.strictEqual(report.metrics.CONFIRMED_APPOINTMENTS.status, 'DEFERRED');
  assert.strictEqual(report.metrics.CONFIRMED_APPOINTMENTS.value, null); // NOT 0
  assert.notStrictEqual(report.metrics.CONFIRMED_APPOINTMENTS.value, 0);
  assert.strictEqual(report.metrics.CONFIRMED_APPOINTMENTS.reason, 'HISTORICAL_NOT_PROVABLE');
  assert.strictEqual(report.metrics.BOOKABLE_SLOTS.status, 'DEFERRED');
  assert.strictEqual(report.metrics.BOOKABLE_SLOTS.value, null);

  // append-only evidence metrics stay AVAILABLE with their proven counts
  assert.strictEqual(report.metrics.OFFICIAL_CANCELLATIONS.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.OFFICIAL_CANCELLATIONS.value, 3);
  assert.strictEqual(report.metrics.OFFICIAL_CHANGES.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.OFFICIAL_CHANGES.value, 1);
  assert.strictEqual(report.metrics.COMPLETED_APPOINTMENTS.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.COMPLETED_APPOINTMENTS.value, 2);
  assert.strictEqual(report.metrics.NO_SHOW_APPOINTMENTS.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.NO_SHOW_APPOINTMENTS.value, 1);

  // overall status: PARTIAL, gaps named — never hidden
  assert.strictEqual(report.status, 'PARTIAL');
  assert.ok(report.statusReason.indexOf('CONFIRMED_APPOINTMENTS=DEFERRED') !== -1);
  assert.ok(report.statusReason.indexOf('BOOKABLE_SLOTS=DEFERRED') !== -1);
  assert.deepStrictEqual(Array.from(report.statusBreakdown.DEFERRED),
    ['CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS']);
  assert.strictEqual(report.statusBreakdown.AVAILABLE.length, 4);
});

test('M1B-S3 — Closed WEEK: identical honest semantics through generateWeekly', function() {
  reset();
  // Closed week Sat 2026-08-15 .. Sat 2026-08-22 (< now)
  seedAvailability([mkSlot('X1', { status: 'CONFIRMED', sortKey: CL(2026, 8, 17, 10, 0), phone: PHONE })]);
  seedLifecycle([mkCancel('WOP1', CL(2026, 8, 17, 9, 0))]);
  seedAttendance([mkCompleted('X1', CL(2026, 8, 17, 12, 0))]);

  const result = sandbox.ReportService.generateWeekly(CL(2026, 8, 18, 12, 0));
  assert.strictEqual(result.ok, true);
  const report = result.data;
  assert.strictEqual(report.reportType, 'WEEKLY');
  assert.strictEqual(report.period.startMs, Date.UTC(2026, 7, 14, 21, 0)); // Sat 08-15
  assert.strictEqual(report.metrics.CONFIRMED_APPOINTMENTS.status, 'DEFERRED');
  assert.strictEqual(report.metrics.CONFIRMED_APPOINTMENTS.value, null);
  assert.strictEqual(report.metrics.OFFICIAL_CANCELLATIONS.status, 'AVAILABLE');
  assert.strictEqual(report.metrics.OFFICIAL_CANCELLATIONS.value, 1);
  assert.strictEqual(report.metrics.COMPLETED_APPOINTMENTS.value, 1);
  assert.strictEqual(report.status, 'PARTIAL');
});

test('M1B-S4 — Closed MONTH (July 2026): identical honest semantics through generateMonthly', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([mkCancel('MOP1', CL(2026, 7, 10, 9, 0)), mkCancel('MOP2', CL(2026, 7, 31, 23, 0))]);
  seedAttendance([mkNoShow('Q1', CL(2026, 7, 5, 12, 0))]);

  const result = sandbox.ReportService.generateMonthly(CL(2026, 7, 15, 0, 0));
  assert.strictEqual(result.ok, true);
  const report = result.data;
  assert.strictEqual(report.reportType, 'MONTHLY');
  assert.strictEqual(report.metrics.BOOKABLE_SLOTS.status, 'DEFERRED');
  assert.strictEqual(report.metrics.OFFICIAL_CANCELLATIONS.value, 2);
  assert.strictEqual(report.metrics.NO_SHOW_APPOINTMENTS.value, 1);
  assert.strictEqual(report.status, 'PARTIAL');
  assert.deepStrictEqual(Array.from(report.statusBreakdown.DEFERRED),
    ['CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS']);
});

test('M1B-S5 — UNAVAILABLE envelope (composition): report is PARTIAL, envelope preserved verbatim, value never invented', function() {
  reset();
  seedAllEmpty();
  // Composition-level test: a synthetic foundation envelope with the
  // reserved UNAVAILABLE status must surface honestly. The M1-A
  // foundation itself is untouched.
  const originalMany = sandbox.MetricsService.calculateMany;
  const unavailableEnvelope = {
    metric: 'OFFICIAL_CANCELLATIONS',
    status: 'UNAVAILABLE',
    value: null,
    reason: 'ZERO_DENOMINATOR',
    period: { startMs: CL(2026, 8, 24, 0, 0), endMs: CL(2026, 8, 25, 0, 0) },
    evaluatedAt: sandbox.mkVmDate(NOW_MS),
    provenance: { source: 'SYNTHETIC', periodSemantics: 'test' }
  };
  sandbox.MetricsService.calculateMany = function(names, period) {
    const data = originalMany.call(sandbox.MetricsService, names, period);
    data.data.results.OFFICIAL_CANCELLATIONS = unavailableEnvelope;
    return data;
  };
  try {
    const result = sandbox.ReportService.generateDaily();
    sandbox.MetricsService.calculateMany = originalMany; // restore before asserts
    assert.strictEqual(result.ok, true);
    const report = result.data;
    assert.strictEqual(report.status, 'PARTIAL');
    assert.strictEqual(report.metrics.OFFICIAL_CANCELLATIONS, unavailableEnvelope); // verbatim, same envelope object
    assert.strictEqual(report.metrics.OFFICIAL_CANCELLATIONS.value, null);
    assert.notStrictEqual(report.metrics.OFFICIAL_CANCELLATIONS.value, 0);
    assert.ok(report.statusReason.indexOf('OFFICIAL_CANCELLATIONS=UNAVAILABLE') !== -1);
    assert.deepStrictEqual(Array.from(report.statusBreakdown.UNAVAILABLE), ['OFFICIAL_CANCELLATIONS']);
  } finally {
    sandbox.MetricsService.calculateMany = originalMany;
  }
});

test('M1B-S6 — Future unknown metric status (composition): still PARTIAL and surfaced, never hidden', function() {
  reset();
  seedAllEmpty();
  const originalMany = sandbox.MetricsService.calculateMany;
  sandbox.MetricsService.calculateMany = function(names, period) {
    const data = originalMany.call(sandbox.MetricsService, names, period);
    data.data.results.NO_SHOW_APPOINTMENTS.status = 'PENDING_EVIDENCE'; // a hypothetical future status
    return data;
  };
  try {
    const result = sandbox.ReportService.generateDaily();
    sandbox.MetricsService.calculateMany = originalMany;
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.status, 'PARTIAL');
    assert.ok(result.data.statusReason.indexOf('NO_SHOW_APPOINTMENTS=PENDING_EVIDENCE') !== -1);
    assert.ok(result.data.statusBreakdown.hasOwnProperty('PENDING_EVIDENCE'));
  } finally {
    sandbox.MetricsService.calculateMany = originalMany;
  }
});

test('M1B-S7 — §34 Source failure (evidence source, closed period): generation FAILS verbatim — no zero, no empty report, no fake partial', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([]);
  seedAttendance([]);
  state.failRead['B6_LIFECYCLE'] = true;

  const result = sandbox.ReportService.generateDaily(CL(2026, 8, 20, 12, 0));
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.data, null);
  assert.strictEqual(result.error.code, 'METRIC_SOURCE_UNAVAILABLE'); // frozen M1-A code, verbatim
  assert.ok(result.error.message.indexOf('B6_LIFECYCLE') !== -1 || String(result.error.details.source).indexOf('B6_LIFECYCLE') !== -1);
});

test('M1B-S8 — §34 Source failure (Availability, current period): generation FAILS verbatim', function() {
  reset();
  seedAllEmpty();
  state.failRead['Availability'] = true;

  const result = sandbox.ReportService.generateDaily(); // open day reads Availability
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'METRIC_SOURCE_UNAVAILABLE');
  // never a fabricated report
  assert.strictEqual(result.data, null);
});

test('M1B-S9 — generatedAt from Clock.now() never changes the period; default reference is Clock.now()', function() {
  reset();
  seedAllEmpty();
  // default reference: frozen clock → today's clinic day
  const today = sandbox.ReportService.generateDaily();
  assert.strictEqual(today.data.period.startMs, Date.UTC(2026, 7, 23, 21, 0));
  assert.strictEqual(today.data.generatedAt instanceof Date, true);
  assert.strictEqual(today.data.generatedAt.getTime(), NOW_MS);
  assert.strictEqual(today.data.generatedAtWallClock, '2026-08-24T12:00:00+03:00');

  // explicit past reference: past period, generatedAt still now
  const past = sandbox.ReportService.generateWeekly(CL(2026, 8, 18, 12, 0));
  assert.strictEqual(past.data.period.startMs, Date.UTC(2026, 7, 14, 21, 0)); // Sat 08-15
  assert.strictEqual(past.data.generatedAt.getTime(), NOW_MS);
  assert.strictEqual(past.data.status, 'PARTIAL'); // closed week semantics intact
});

// ── Z — Zero semantics ──────────────────────────────────────────

test('M1B-Z1 — Current period with empty stores: every metric is a VALID ZERO (AVAILABLE 0), report COMPLETE', function() {
  reset();
  seedAllEmpty();
  const result = sandbox.ReportService.generateMonthly(); // August 2026 is open
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'COMPLETE');
  SIX_METRICS.forEach(function(name) {
    assert.strictEqual(result.data.metrics[name].status, 'AVAILABLE', name);
    assert.strictEqual(result.data.metrics[name].value, 0, name); // 0, not null
    assert.strictEqual(result.data.metrics[name].reason, null, name);
  });
});

test('M1B-Z2 — Zero ≠ Deferred inside ONE closed-period report: valid measured 0 coexists with DEFERRED null', function() {
  reset();
  // Closed day with lifecycle reads proving a valid zero for changes,
  // while confirmed is DEFERRED and cancellations has a count.
  seedAvailability([]);
  seedLifecycle([mkCancel('OPZ', CL(2026, 8, 20, 9, 0))]);
  seedAttendance([]);
  const result = sandbox.ReportService.generateDaily(CL(2026, 8, 20, 12, 0));
  assert.strictEqual(result.ok, true);
  const metrics = result.data.metrics;
  assert.strictEqual(metrics.OFFICIAL_CHANGES.status, 'AVAILABLE');
  assert.strictEqual(metrics.OFFICIAL_CHANGES.value, 0);   // valid measured zero
  assert.strictEqual(metrics.OFFICIAL_CANCELLATIONS.value, 1);
  assert.strictEqual(metrics.CONFIRMED_APPOINTMENTS.status, 'DEFERRED');
  assert.strictEqual(metrics.CONFIRMED_APPOINTMENTS.value, null); // not provable — never 0
  assert.strictEqual(result.data.status, 'PARTIAL');
});

test('M1B-Z3 — Zero ≠ Deferred ≠ Unavailable: the three-way distinction in one report (composition)', function() {
  reset();
  seedAllEmpty();
  const originalMany = sandbox.MetricsService.calculateMany;
  sandbox.MetricsService.calculateMany = function(names, period) {
    const data = originalMany.call(sandbox.MetricsService, names, period);
    data.data.results.COMPLETED_APPOINTMENTS.status = 'UNAVAILABLE';
    data.data.results.COMPLETED_APPOINTMENTS.value = null;
    data.data.results.COMPLETED_APPOINTMENTS.reason = 'ZERO_DENOMINATOR';
    return data;
  };
  try {
    // Closed day: NO_SHOW stays a valid AVAILABLE zero, CONFIRMED is
    // DEFERRED, COMPLETED forced UNAVAILABLE.
    const closed = sandbox.ReportService.generateDaily(CL(2026, 8, 20, 12, 0));
    sandbox.MetricsService.calculateMany = originalMany;
    assert.strictEqual(closed.ok, true);
    const metrics = closed.data.metrics;
    assert.strictEqual(metrics.NO_SHOW_APPOINTMENTS.status, 'AVAILABLE');
    assert.strictEqual(metrics.NO_SHOW_APPOINTMENTS.value, 0);
    assert.strictEqual(metrics.CONFIRMED_APPOINTMENTS.status, 'DEFERRED');
    assert.strictEqual(metrics.CONFIRMED_APPOINTMENTS.value, null);
    assert.strictEqual(metrics.COMPLETED_APPOINTMENTS.status, 'UNAVAILABLE');
    assert.strictEqual(metrics.COMPLETED_APPOINTMENTS.value, null);
    assert.strictEqual(closed.data.status, 'PARTIAL');
    // three distinct buckets, all honest
    assert.ok(closed.data.statusBreakdown.AVAILABLE.length >= 1);
    assert.ok(closed.data.statusBreakdown.DEFERRED.length >= 1);
    assert.deepStrictEqual(Array.from(closed.data.statusBreakdown.UNAVAILABLE), ['COMPLETED_APPOINTMENTS']);
  } finally {
    sandbox.MetricsService.calculateMany = originalMany;
  }
});

// ── V — Provenance survival ─────────────────────────────────────

test('M1B-V1 — Provenance: metric envelopes survive report composition VERBATIM (full envelope, all six)', function() {
  reset();
  seedAvailability([
    mkSlot('C1', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 10, 0), phone: PHONE }),
    mkSlot('B1', { status: 'FREE', sortKey: CL(2026, 8, 24, 14, 0) })
  ]);
  seedLifecycle([mkCancel('OP1', CL(2026, 8, 24, 9, 0)), mkChange('CH1', CL(2026, 8, 24, 10, 0))]);
  seedAttendance([mkCompleted('C1', CL(2026, 8, 24, 11, 0)), mkNoShow('N1', CL(2026, 8, 24, 11, 30))]);

  const result = sandbox.ReportService.generateDaily();
  assert.strictEqual(result.ok, true);
  const direct = sandbox.MetricsService.calculateMany(
    Array.from(result.data.requestedMetrics),
    { start: result.data.period.startMs, end: result.data.period.endMs }
  );
  assert.strictEqual(direct.ok, true);
  SIX_METRICS.forEach(function(name) {
    // full-envelope structural equality (JSON-normalized: realm- and
    // Date-prototype-agnostic), including evaluatedAt/provenance
    assert.deepStrictEqual(
      jsonClone(result.data.metrics[name]),
      jsonClone(direct.data.results[name]),
      name
    );
  });
});

test('M1B-V2 — Provenance chain: Report → Metric → Source / Condition / Period / Semantics is walkable', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([mkCancel('OPV', CL(2026, 8, 20, 9, 0))]);
  seedAttendance([mkCompleted('PV1', CL(2026, 8, 20, 13, 0)), mkCompleted('PV2', CL(2026, 8, 20, 13, 30))]);
  const result = sandbox.ReportService.generateDaily(CL(2026, 8, 20, 15, 0));
  assert.strictEqual(result.ok, true);
  const report = result.data;

  // report level: clinic timezone + canonical period semantics
  assert.strictEqual(report.period.timeZone, 'Asia/Baghdad');
  assert.ok(report.period.periodSemantics.indexOf('start inclusive, end exclusive') !== -1);

  // deferred snapshot metric: its provenance says WHY
  const confirmed = report.metrics.CONFIRMED_APPOINTMENTS;
  assert.strictEqual(confirmed.provenance.source, 'Availability');
  assert.strictEqual(confirmed.provenance.semantics, 'SNAPSHOT_CURRENT_STATE');
  assert.strictEqual(confirmed.provenance.asOfMs, NOW_MS);
  assert.ok(confirmed.provenance.historicalPolicy.indexOf('No approximation') !== -1);

  // evidence metrics: append-only provenance preserved
  const cancels = report.metrics.OFFICIAL_CANCELLATIONS;
  assert.strictEqual(cancels.provenance.source, 'B6_LIFECYCLE');
  assert.strictEqual(cancels.provenance.semantics, 'HISTORICAL_EVIDENCE');
  assert.strictEqual(cancels.provenance.aggregation, 'COUNT DISTINCT operation_id');
  assert.ok(cancels.provenance.journalDiscipline.indexOf('never multiply') !== -1);

  const completed = report.metrics.COMPLETED_APPOINTMENTS;
  assert.strictEqual(completed.provenance.source, 'ATTENDANCE_AUDIT');
  assert.strictEqual(completed.provenance.semantics, 'HISTORICAL_EVIDENCE');
  assert.strictEqual(typeof completed.provenance.attendanceActivationAtMs, 'number');
  assert.ok(completed.provenance.decisionTimestampBasis.indexOf('DECISION timestamp') !== -1);

  // each envelope period === the report period (same instants)
  SIX_METRICS.forEach(function(name) {
    assert.strictEqual(report.metrics[name].period.startMs, report.period.startMs, name);
    assert.strictEqual(report.metrics[name].period.endMs, report.period.endMs, name);
  });
});

// ── B — Behavioural boundaries through full reports ─────────────

test('M1B-B1 — Daily start boundary is inclusive through the full report (cancellation at exactly 00:00)', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([mkCancel('AT_START', CL(2026, 8, 20, 0, 0))]);
  seedAttendance([]);
  const result = sandbox.ReportService.generateDaily(CL(2026, 8, 20, 12, 0));
  assert.strictEqual(result.data.metrics.OFFICIAL_CANCELLATIONS.value, 1);
});

test('M1B-B2 — Daily end boundary is exclusive through the full report (cancellation at exactly next-day 00:00)', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([mkCancel('AT_END', CL(2026, 8, 21, 0, 0))]);
  seedAttendance([]);
  const twentieth = sandbox.ReportService.generateDaily(CL(2026, 8, 20, 12, 0));
  const twentyFirst = sandbox.ReportService.generateDaily(CL(2026, 8, 21, 12, 0));
  assert.strictEqual(twentieth.data.metrics.OFFICIAL_CANCELLATIONS.value, 0); // excluded (valid zero)
  assert.strictEqual(twentyFirst.data.metrics.OFFICIAL_CANCELLATIONS.value, 1); // included
});

test('M1B-B3 — Week transition through the full report: event at exactly Sat 00:00 opens the NEW week', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([mkCancel('WK_EDGE', CL(2026, 8, 22, 0, 0))]); // Sat 2026-08-22 exactly
  seedAttendance([]);
  const oldWeek = sandbox.ReportService.generateWeekly(CL(2026, 8, 21, 12, 0)); // Fri of week 08-15
  const newWeek = sandbox.ReportService.generateWeekly(CL(2026, 8, 22, 12, 0));
  assert.strictEqual(oldWeek.data.metrics.OFFICIAL_CANCELLATIONS.value, 0);
  assert.strictEqual(newWeek.data.metrics.OFFICIAL_CANCELLATIONS.value, 1);
  assert.strictEqual(newWeek.data.period.startMs, CL(2026, 8, 22, 0, 0));
});

test('M1B-B4 — Month transition through the full report: event at exactly Sep 1 00:00 belongs to September', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([mkCancel('MO_EDGE', CL(2026, 9, 1, 0, 0))]);
  seedAttendance([]);
  const august = sandbox.ReportService.generateMonthly(CL(2026, 8, 15, 0, 0));
  const september = sandbox.ReportService.generateMonthly(CL(2026, 9, 15, 0, 0));
  assert.strictEqual(august.data.metrics.OFFICIAL_CANCELLATIONS.value, 0);
  assert.strictEqual(september.data.metrics.OFFICIAL_CANCELLATIONS.value, 1);
  assert.strictEqual(august.data.period.endMs, september.data.period.startMs); // contiguous
});

test('M1B-B5 — YEAR transition through the full report: event at exactly 2027-01-01 00:00 belongs to January 2027', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([mkCancel('YR_EDGE', CL(2027, 1, 1, 0, 0))]);
  seedAttendance([]);
  const december = sandbox.ReportService.generateMonthly(CL(2026, 12, 15, 0, 0));
  const january = sandbox.ReportService.generateMonthly(CL(2027, 1, 15, 0, 0));
  assert.strictEqual(december.data.metrics.OFFICIAL_CANCELLATIONS.value, 0);
  assert.strictEqual(january.data.metrics.OFFICIAL_CANCELLATIONS.value, 1);
  assert.strictEqual(december.data.period.endWallClock, '2027-01-01T00:00:00+03:00');
  assert.strictEqual(january.data.period.startWallClock, '2027-01-01T00:00:00+03:00');
});

// ── R — Renderer ────────────────────────────────────────────────

test('M1B-R1 — Renderer: COMPLETE report renders all six metrics with values, valid zeros as 0, no ratios', function() {
  reset();
  seedAvailability([
    mkSlot('C1', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 10, 0), phone: PHONE }),
    mkSlot('B1', { status: 'FREE', sortKey: CL(2026, 8, 24, 14, 0) })
  ]);
  seedLifecycle([mkCancel('OP1', CL(2026, 8, 24, 9, 0))]);
  seedAttendance([mkCompleted('C1', CL(2026, 8, 24, 11, 0))]);

  const report = sandbox.ReportService.generateDaily().data;
  const rendered = sandbox.ReportRenderer.renderPlainText(report);
  assert.strictEqual(rendered.ok, true);
  const text = rendered.data;
  assert.ok(text.indexOf('HAMZAWE DAILY REPORT') !== -1);
  assert.ok(text.indexOf('2026-08-24T00:00:00+03:00 -> 2026-08-25T00:00:00+03:00 (Asia/Baghdad)') !== -1);
  assert.ok(text.indexOf('Status: COMPLETE') !== -1);
  assert.ok(text.indexOf('CONFIRMED_APPOINTMENTS: 1') !== -1);
  assert.ok(text.indexOf('OFFICIAL_CANCELLATIONS: 1') !== -1);
  assert.ok(text.indexOf('COMPLETED_APPOINTMENTS: 1') !== -1);
  assert.ok(text.indexOf('NO_SHOW_APPOINTMENTS: 0') !== -1); // valid zero printed as 0
  assert.ok(text.indexOf('OFFICIAL_CHANGES: 0') !== -1);
  assert.ok(text.indexOf('BOOKABLE_SLOTS: 1') !== -1);
  assert.strictEqual(text.indexOf('%'), -1); // no ratios, ever
});

test('M1B-R2 — Renderer: PARTIAL report shows DEFERRED honestly — never a fabricated zero', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([mkCancel('OPR', CL(2026, 8, 20, 9, 0))]);
  seedAttendance([mkCompleted('RP1', CL(2026, 8, 20, 13, 0))]);
  const report = sandbox.ReportService.generateDaily(CL(2026, 8, 20, 15, 0)).data;
  const rendered = sandbox.ReportRenderer.renderPlainText(report);
  assert.strictEqual(rendered.ok, true);
  const text = rendered.data;
  assert.ok(text.indexOf('Status: PARTIAL') !== -1);
  assert.ok(text.indexOf('CONFIRMED_APPOINTMENTS=DEFERRED') !== -1);
  assert.ok(text.indexOf('BOOKABLE_SLOTS=DEFERRED') !== -1);
  const lines = text.split('\n');
  const confirmedLine = lines.filter(function(l) { return l.indexOf('CONFIRMED_APPOINTMENTS:') === 0; })[0];
  assert.ok(confirmedLine.indexOf('DEFERRED') !== -1);
  assert.ok(confirmedLine.indexOf('HISTORICAL_NOT_PROVABLE') !== -1);
  assert.strictEqual(confirmedLine, 'CONFIRMED_APPOINTMENTS: DEFERRED (HISTORICAL_NOT_PROVABLE)');
  // evidence metrics still print their proven values
  assert.ok(text.indexOf('OFFICIAL_CANCELLATIONS: 1') !== -1);
  assert.ok(text.indexOf('COMPLETED_APPOINTMENTS: 1') !== -1);
  assert.strictEqual(text.indexOf('%'), -1);
});

test('M1B-R3 — Renderer purity: no metrics recalculation, no Clock, deterministic identical output', function() {
  reset();
  seedAllEmpty();
  const spy = spyMetrics();
  try {
    const report = sandbox.ReportService.generateWeekly().data;
    const generations = spy.calls.many.length; // 1 — the report generation itself
    assert.strictEqual(generations, 1);
    const first = sandbox.ReportRenderer.renderPlainText(report);
    const second = sandbox.ReportRenderer.renderPlainText(report);
    assert.strictEqual(spy.calls.many.length, generations); // rendering triggered zero metric calls
    assert.strictEqual(spy.calls.single, 0);
    assert.strictEqual(first.data, second.data); // byte-identical

    // moving the Clock does NOT change a rendered report
    state.nowMs = CL(2026, 8, 25, 10, 0);
    const third = sandbox.ReportRenderer.renderPlainText(report);
    assert.strictEqual(third.data, first.data);
  } finally {
    spy.restore();
  }
});

test('M1B-R4 — Renderer: invalid inputs fail cleanly (REPORT_INVALID)', function() {
  reset();
  [null, undefined, 42, 'report', {}, { reportType: 'DAILY' }].forEach(function(bad) {
    const rendered = sandbox.ReportRenderer.renderPlainText(bad);
    assert.strictEqual(rendered.ok, false, String(bad));
    assert.strictEqual(rendered.error.code, 'REPORT_INVALID');
  });
});

test('M1B-R5 — Renderer: UNAVAILABLE metric renders its status + reason, never a value', function() {
  reset();
  seedAllEmpty();
  const report = sandbox.ReportService.generateDaily().data;
  report.metrics.OFFICIAL_CANCELLATIONS.status = 'UNAVAILABLE';
  report.metrics.OFFICIAL_CANCELLATIONS.value = null;
  report.metrics.OFFICIAL_CANCELLATIONS.reason = 'ZERO_DENOMINATOR';
  report.status = 'PARTIAL';
  const rendered = sandbox.ReportRenderer.renderPlainText(report);
  assert.strictEqual(rendered.ok, true);
  assert.strictEqual(
    rendered.data.split('\n').filter(function(l) {
      return l.indexOf('OFFICIAL_CANCELLATIONS:') === 0;
    })[0],
    'OFFICIAL_CANCELLATIONS: UNAVAILABLE (ZERO_DENOMINATOR)'
  );
});

// ── X — Side effects & architecture ─────────────────────────────

test('M1B-X1 — READ ONLY: generating all report types over open and closed periods writes nothing and creates nothing', function() {
  reset();
  seedAvailability([mkSlot('C1', { status: 'CONFIRMED', sortKey: CL(2026, 8, 24, 10, 0), phone: PHONE })]);
  seedLifecycle([mkCancel('OP1', CL(2026, 8, 20, 9, 0)), mkCancel('OP2', CL(2026, 8, 24, 8, 0))]);
  seedAttendance([mkCompleted('C1', CL(2026, 8, 24, 11, 0))]);

  sandbox.ReportService.generateDaily();
  sandbox.ReportService.generateWeekly();
  sandbox.ReportService.generateMonthly();
  sandbox.ReportService.generateDaily(CL(2026, 8, 20, 12, 0));
  sandbox.ReportService.generateWeekly(CL(2026, 8, 18, 12, 0));
  sandbox.ReportService.generateMonthly(CL(2026, 7, 15, 0, 0));
  sandbox.ReportRenderer.renderPlainText(sandbox.ReportService.generateDaily().data);

  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.sheetCreates, 0);
});

test('M1B-X2 — Structural: report files have no source/storage/scheduler/whatsapp references; ReportService uses Clock + calculateMany only', function() {
  const sources = {
    'Application/ReportService.js': stripComments(fs.readFileSync(path.join(ROOT, 'Application/ReportService.js'), 'utf8')),
    'Application/ReportRenderer.js': stripComments(fs.readFileSync(path.join(ROOT, 'Application/ReportRenderer.js'), 'utf8')),
    'Utils/ReportPeriod.js': stripComments(fs.readFileSync(path.join(ROOT, 'Utils/ReportPeriod.js'), 'utf8'))
  };
  const forbidden = [
    'SpreadsheetApp', 'CalendarApp', 'UrlFetchApp', 'GoogleSheets',
    'SlotRepository', 'B6LifecycleRepository', 'AttendanceAuditRepository',
    'AttendanceAuditReadRepository', 'CalendarRepository', 'LogRepository',
    'SYSTEM_LOG', 'PropertiesService', 'LockService', 'WhatsAppAdapter',
    'Session', 'Utilities', 'Scheduler', 'Webhook'
  ];
  Object.keys(sources).forEach(function(file) {
    forbidden.forEach(function(token) {
      assert.strictEqual(sources[file].indexOf(token), -1, file + ' must not reference ' + token);
    });
    // The REAL current-time hazard is a no-argument Date construction.
    // Application files additionally never construct Dates at all
    // (Clock.now() is the only permitted source); Utils/ReportPeriod may
    // construct Dates ONLY from explicitly passed epoch-ms values (pure
    // arithmetic, same documented discipline as LegacySlotTimeParser).
    assert.strictEqual(/\bnew\s+Date\s*\(\s*\)/.test(sources[file]), false,
      file + ' must not construct a current-time Date');
  });
  ['Application/ReportService.js', 'Application/ReportRenderer.js'].forEach(function(file) {
    assert.strictEqual(sources[file].indexOf('new Date('), -1,
      file + ' must obtain time only through Clock.now()');
  });

  // positive anchors
  const rs = sources['Application/ReportService.js'];
  assert.ok(rs.indexOf('Clock.now()') !== -1, 'ReportService must use Clock.now()');
  assert.ok(rs.indexOf('MetricsServiceRef = MetricsService') !== -1,
    'MetricsService must be bound at CALL time (clasp alphabetical order)');
  assert.ok(rs.indexOf('MetricsServiceRef.calculateMany') !== -1,
    'calculateMany is the metrics path');
  assert.strictEqual(rs.indexOf('MetricsServiceRef.calculate('), -1, 'no independent calculate() path');
  assert.strictEqual(rs.indexOf('MetricsServiceRef.calculateRatio'), -1, 'no ratio path');
  const rr = sources['Application/ReportRenderer.js'];
  // Word-boundary matching so DTO field names like startWallClock do
  // not create false positives on the 'Clock' token.
  ['MetricsService', 'ReportPeriod', 'Clock', 'Config', 'ReportService'].forEach(function(token) {
    assert.strictEqual(new RegExp('\\b' + token + '\\b').test(rr), false,
      'Renderer must be presentation-only: ' + token);
  });
  const rp = sources['Utils/ReportPeriod.js'];
  assert.ok(rp.indexOf("'Asia/Baghdad'") !== -1);
  assert.ok(rp.indexOf('REPORT_WEEK_START: 6') !== -1);
});

test('M1B-X3 — clasp alphabetical evaluation-order independence (call-time bindings), full stack', function() {
  // Reproduces clasp's alphabetical project-file order for the M1-B
  // closure: Application/* evaluate BEFORE Config.js and BEFORE
  // Utils/ReportPeriod.js; every cross-module reference must resolve
  // at CALL time.
  const sb = vm.createContext({ console: console });
  const fixed = { nowMs: NOW_MS };
  sb.Clock = { now: function() { return new Date(fixed.nowMs); } };
  sb.GoogleSheets = {
    getHeaders: function(name) {
      const sheet = sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      return sheet.headers.slice();
    },
    queryRows: function(name, predicateFn) {
      const sheet = sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      return sheet.rows.map(function(r, idx) {
          return Object.assign({ _rowNumber: idx + 2 }, r);
        })
        .filter(predicateFn)
        .map(function(r) { return Object.assign({}, r); });
    }
  };
  vm.runInContext('this.mkVmDate = function(ms) { return new Date(ms); };', sb);
  // Rows must carry sb-realm Dates (single-V8-realm discipline): a Date
  // from another realm would fail instanceof inside the sb MetricsService.
  const alphaCancel = mkCancel('ALPHA_OP', CL(2026, 8, 24, 9, 0));
  alphaCancel.created_at = sb.mkVmDate(CL(2026, 8, 24, 8, 0));
  alphaCancel.updated_at = sb.mkVmDate(CL(2026, 8, 24, 9, 0));
  alphaCancel.timestamp = sb.mkVmDate(CL(2026, 8, 24, 9, 0));
  const sheets = {
    'Availability': { headers: AV_HEADERS.slice(), rows: [] },
    'B6_LIFECYCLE': {
      headers: sandbox.B6LifecycleRepository.HEADERS.slice(),
      rows: [alphaCancel]
    },
    'ATTENDANCE_AUDIT': {
      headers: sandbox.AttendanceAuditRepository.HEADERS.slice(),
      rows: []
    }
  };

  const alphabetical = [
    ['Application/B6LifecycleService.js', 'B6LifecycleService'],
    ['Application/MetricsService.js', 'MetricsService'],
    ['Application/ReportRenderer.js', 'ReportRenderer'],
    ['Application/ReportService.js', 'ReportService'],
    ['Clock.js', 'Clock'],
    ['Config.js', 'Config'],
    ['Repositories/AttendanceAuditReadRepository.js', 'AttendanceAuditReadRepository'],
    ['Repositories/AttendanceAuditRepository.js', 'AttendanceAuditRepository'],
    ['Repositories/B6LifecycleRepository.js', 'B6LifecycleRepository'],
    ['Repositories/SlotRepository.js', 'SlotRepository'],
    ['Result.js', 'Result'],
    ['StateMachine.js', 'StateMachine'],
    ['Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser'],
    ['Utils/ReportPeriod.js', 'ReportPeriod']
  ];
  alphabetical.forEach(function(entry) {
    const source = fs.readFileSync(path.join(ROOT, entry[0]), 'utf8');
    vm.runInContext(source + '\nthis.' + entry[1] + ' = ' + entry[1] + ';', sb, { filename: entry[0] });
  });
  // Sanity: ReportService evaluated before Utils/ReportPeriod.js existed.
  assert.strictEqual(Object.keys(sb).indexOf('ReportService') < Object.keys(sb).indexOf('ReportPeriod'), true);

  const weekly = sb.ReportService.generateWeekly();
  assert.strictEqual(weekly.ok, true);
  assert.strictEqual(weekly.data.reportType, 'WEEKLY');
  assert.strictEqual(weekly.data.period.startMs, Date.UTC(2026, 7, 21, 21, 0)); // Sat 08-22
  assert.strictEqual(weekly.data.metrics.OFFICIAL_CANCELLATIONS.value, 1);
  assert.strictEqual(weekly.data.status, 'COMPLETE'); // open week, empty availability = zeros

  const rendered = sb.ReportRenderer.renderPlainText(weekly.data);
  assert.strictEqual(rendered.ok, true);
  assert.ok(rendered.data.indexOf('HAMZAWE WEEKLY REPORT') !== -1);
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
