'use strict';

/**
 * HardeningM2.test.js — M2 (PHASE 1.5 — RATE FOUNDATION)
 *
 * Proves the FROZEN M2-RATE-FOUNDATION-v2 contract:
 *   1  — Episode model (NOT slot_id identity): slot reuse, sequential
 *        changes, same-day change, recovery interleaving
 *   2  — Appointment-day basis (operation/attendance timestamps never
 *        assign the period): delayed completion/no-show, post-day
 *        cancellation/change
 *   3  — Shared cohort + four rates: partition, count-weighted
 *        weekly/monthly rollup (never averages of daily percentages)
 *   4  — Evidence handling: unattributable (excluded + provenance) vs
 *        conflicting (UNAVAILABLE / RATE_EVIDENCE_INVALID, period-scoped),
 *        duplicate terminal operation_id, duplicate Availability slot_id,
 *        missing old_slot_id / new_slot_id / slot_id, conflicting
 *        attendance, pre-activation boundary, ALREADY_APPLIED exclusion,
 *        missing pre-B6 evidence
 *   5  — Zero / source semantics: ZERO_DENOMINATOR (never 0%),
 *        RATE_SOURCE_UNAVAILABLE (shared-source coupling, never zero)
 *   6  — Boundaries: period validation, start/end inclusivity,
 *        determinism, read-once / read-only, provenance completeness,
 *        ReportPeriod delegation (all periods via ReportPeriod.periodFor)
 *
 * Mandatory matrix coverage (v2 §30) — every listed case is a test:
 *   slot reuse ........................................ M2-02, M2-03
 *   sequential changes ................................ M2-03, M2-04
 *   same-day change ................................... M2-05
 *   recovery after release ............................ M2-06
 *   delayed completion ................................ M2-07
 *   delayed no-show ................................... M2-08
 *   post-day cancellation ............................. M2-09
 *   post-day change ................................... M2-10
 *   pre-B6 missing evidence ........................... M2-11
 *   pre-activation attendance ........................ M2-12
 *   still-confirmed closed day ........................ M2-13
 *   missing old_slot_id ............................... M2-14
 *   missing new_slot_id ............................... M2-15
 *   duplicate terminal operation_id ................... M2-17
 *   conflicting attendance evidence ................... M2-18, M2-19
 *   duplicate Availability slot_id .................... M2-20, M2-21
 *   start/end boundaries ................................ M2-25
 *   zero denominator .................................. M2-26
 *   source failure .................................... M2-27
 *   shared-source failure ............................. M2-28
 *   provenance ........................................ M2-29
 *   count-weighted weekly/monthly ..................... M2-33, M2-34
 *   missing slot_id (APPLIED) ........................ M2-16
 *
 * Grid discipline (mirrors M1 tests): the sandbox's sort_key parser and
 * the test periods share ONE wall-clock grid (the host process timezone),
 * faithfully simulating the production invariant of v2 §7 — the Apps
 * Script project timezone IS the clinic timezone (Asia/Baghdad, pinned in
 * appsscript.json). ReportPeriod itself is pure fixed-offset arithmetic
 * and is tested separately for delegation (M2-37).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';

// ── Deterministic time anchors (host-local wall grid) ────────────
const NOW_DATE = new Date(2026, 7, 24, 12, 0);            // 2026-08-24 12:00
const NOW_MS = NOW_DATE.getTime();

/** epoch ms on the host-local grid */
function D(month0, day, hour, minute) {
  return new Date(2026, month0, day, hour || 0, minute || 0).getTime();
}

/** one host-local calendar day period (start inclusive / end exclusive) */
function dayPeriod(month0, day) {
  return { start: D(month0, day, 0), end: D(month0, day + 1, 0) };
}

/** sort_key 'yyyyMMddHHmm' from an epoch ms on the host-local grid */
function sortKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes());
}

function createRateSandbox() {
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

  // Production Apps Script is a single V8 realm: every Date a sheet read
  // returns shares one Date constructor. Simulate faithfully.
  vm.runInContext('this.mkVmDate = function(ms) { return new Date(ms); };', sandbox);

  // Read paths faithful to the production GoogleSheets surface; every
  // mutation path FAILS the test if the foundation ever touches it
  // (M2: the foundation is pure reads).
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
      throw new Error('M2_FOUNDATION_MUST_NOT_CREATE_SHEETS: ' + name);
    },
    appendRow: function(name) {
      state.writes += 1;
      throw new Error('M2_FOUNDATION_MUST_NOT_WRITE: appendRow ' + name);
    },
    appendRows: function(name) {
      state.writes += 1;
      throw new Error('M2_FOUNDATION_MUST_NOT_WRITE: appendRows ' + name);
    },
    updateRowByColumn: function(name) {
      state.writes += 1;
      throw new Error('M2_FOUNDATION_MUST_NOT_WRITE: updateRowByColumn ' + name);
    },
    updateBatch: function(name) {
      state.writes += 1;
      throw new Error('M2_FOUNDATION_MUST_NOT_WRITE: updateBatch ' + name);
    },
    deleteRowsByNumbers: function(name) {
      state.writes += 1;
      throw new Error('M2_FOUNDATION_MUST_NOT_WRITE: deleteRowsByNumbers ' + name);
    }
  };

  // Load the real production stack (references resolve at call time).
  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('StateMachine.js', 'StateMachine');
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('Utils/ReportPeriod.js', 'ReportPeriod');
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('Repositories/AttendanceAuditRepository.js', 'AttendanceAuditRepository');
  load('Repositories/AttendanceAuditReadRepository.js', 'AttendanceAuditReadRepository');
  load('Repositories/B6LifecycleRepository.js', 'B6LifecycleRepository');
  load('Application/B6LifecycleService.js', 'B6LifecycleService');
  load('Application/RateFoundationService.js', 'RateFoundationService');

  return { sandbox: sandbox, state: state };
}

const core = createRateSandbox();
const sandbox = core.sandbox;
const state = core.state;
const RFS = sandbox.RateFoundationService;

// ── Sheet seeding helpers ─────────────────────────────────────────

const AV_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];

function mkSlot(id, opts) {
  const o = opts || {};
  const sortKey = o.sortKey !== undefined
    ? o.sortKey
    : sortKeyOf(D(7, 10, 10, 0));
  return {
    slot_id: id,
    date: o.date || '2026/08/10',
    time: o.time || '10:00',
    sort_key: sortKey,
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
    operation_id: o.opId !== undefined ? o.opId : opId,
    phone: o.phone || PHONE,
    command: o.command || (lifecycleState === 'RESOLVED_CHANGE' ? 'CHANGE' : 'CANCEL'),
    old_slot_id: o.oldSlotId !== undefined ? o.oldSlotId : ('OLD_' + opId),
    new_slot_id: o.newSlotId !== undefined ? o.newSlotId : '',
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

function seedLifecycle(rows) {
  state.sheets['B6_LIFECYCLE'] = {
    headers: sandbox.B6LifecycleRepository.HEADERS.slice(),
    rows: rows || []
  };
}

function mkAudit(slotId, decision, toStatus, outcome, tsMs) {
  const ts = sandbox.mkVmDate(tsMs);
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
    timestamp: ts
  };
}

function seedAttendance(rows) {
  state.sheets['ATTENDANCE_AUDIT'] = {
    headers: sandbox.AttendanceAuditRepository.HEADERS.slice(),
    rows: rows || []
  };
}

/** All three sources present but empty (headers only). */
function seedEmptySources() {
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

function assertClose(actual, expected, message) {
  assert.strictEqual(
    Math.abs(actual - expected) < 1e-9, true,
    (message || '') + ' expected ' + expected + ' got ' + actual
  );
}

/** Recursively removes evaluatedAt (Clock-dependent) for deep compares.
 *  Arrays are rebuilt as host-realm arrays (a vm array's .map would
 *  return a vm-realm array — same prototype caveat as hostClone). */
function deepStrip(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) {
    const arr = [];
    for (let i = 0; i < o.length; i++) arr[i] = deepStrip(o[i]);
    return arr;
  }
  const out = {};
  Object.keys(o).forEach(function(k) {
    if (k === 'evaluatedAt') return;
    out[k] = deepStrip(o[k]);
  });
  return out;
}

/**
 * Re-materializes a sandbox-realm plain object in the HOST realm.
 * The vm context has its own Object.prototype/Array constructor, so
 * assert.deepStrictEqual against a host literal fails on the
 * prototype check even when the structure is identical. Primitives
 * pass through unchanged.
 */
function hostClone(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) {
    const arr = [];
    for (let i = 0; i < o.length; i++) arr[i] = hostClone(o[i]);
    return arr;
  }
  const out = {};
  Object.keys(o).forEach(function(k) { out[k] = hostClone(o[k]); });
  return out;
}

function ratesOf(result) {
  assert.strictEqual(result.ok, true, 'calculateRates failed: ' +
    (result.error ? result.error.code + ' ' + result.error.message : ''));
  return result.data.rates;
}

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ── 1 — Episode model / shared cohort ─────────────────────────────

test('M2-01 — Mixed fixture: cohort partition, byPath, four rates, sum ≤ 100%', function() {
  reset();
  seedAvailability([
    mkSlot('A1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 9, 0)), phone: PHONE }),
    mkSlot('B1', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE }),
    mkSlot('C1', { status: 'NO_SHOW', sortKey: sortKeyOf(D(7, 10, 11, 0)), phone: PHONE }),
    mkSlot('D1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 12, 0)) }),
    mkSlot('E1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 13, 0)) }),
    mkSlot('F1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 14, 0)), phone: PHONE }),
    mkSlot('G1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 11, 9, 0)), phone: PHONE }) // out of period
  ]);
  seedLifecycle([
    mkLifecycle('OP_D1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'D1' }),
    mkLifecycle('OP_E1', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 9, 10, 0), { oldSlotId: 'E1', newSlotId: 'F1' })
  ]);
  seedAttendance([
    mkAudit('B1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 10, 12, 0)),
    mkAudit('C1', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(7, 10, 13, 0))
  ]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.ok, true, res.error && res.error.message);
  const data = res.data;

  // cohort: A1 live, B1 completed, C1 no-show, D1 released-cancel,
  // E1 released-change, F1 live → 6 (G1 out of period)
  assert.strictEqual(data.cohort.total, 6);
  assert.deepStrictEqual(hostClone(data.cohort.byPath), {
    pathA_stillConfirmed: 2,
    pathB_completed: 1,
    pathC_noShow: 1,
    pathD_cancelled: 1,
    pathE_changed: 1
  });

  const r = ratesOf(res);
  assertClose(r.CANCELLATION_RATE.value, 100 / 6, 'cancel');
  assertClose(r.CHANGE_RATE.value, 100 / 6, 'change');
  assertClose(r.COMPLETION_RATE.value, 100 / 6, 'completed');
  assertClose(r.NO_SHOW_RATE.value, 100 / 6, 'no-show');
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    assert.strictEqual(r[name].status, 'AVAILABLE');
    assert.strictEqual(r[name].reason, null);
    assert.strictEqual(r[name].provenance.denominator, 6);
  });

  // partition: rates sum to ≤ 100% (remainder = still confirmed)
  const sum = r.CANCELLATION_RATE.value + r.CHANGE_RATE.value +
    r.COMPLETION_RATE.value + r.NO_SHOW_RATE.value;
  assert.strictEqual(sum < 100, true, 'sum must be ≤ 100');
  assertClose(sum, 400 / 6, 'sum of four rates');

  // as-of
  assert.strictEqual(data.asOfMs, NOW_MS);
});

test('M2-02 — Slot reuse: cancel → reuse same slot → new appointment (cohort = 2)', function() {
  reset();
  seedAvailability([
    // Episode 1 released by OP_A; episode 2 = the rebooked CONFIRMED row
    mkSlot('S1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: '9647002222222' })
  ]);
  seedLifecycle([
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 12, 0), { oldSlotId: 'S1' })
  ]);
  seedAttendance([]);

  const r = ratesOf(RFS.calculateRates(dayPeriod(7, 10)));
  const data = RFS.calculateRates(dayPeriod(7, 10)).data;

  assert.strictEqual(data.cohort.total, 2, 'reuse slot contributes TWO episodes');
  assert.strictEqual(data.cohort.byPath.pathD_cancelled, 1);
  assert.strictEqual(data.cohort.byPath.pathA_stillConfirmed, 1);
  assert.strictEqual(data.cohort.reusedSlots, 1);
  assert.strictEqual(data.cohort.reusedSlotEpisodes, 2);

  assertClose(r.CANCELLATION_RATE.value, 50, '1 cancelled of 2 episodes');
  assertClose(r.CHANGE_RATE.value, 0);
  assertClose(r.COMPLETION_RATE.value, 0);
  assertClose(r.NO_SHOW_RATE.value, 0);
});

test('M2-03 — change → reuse → another change on one day: 3 episodes, 2 changed', function() {
  reset();
  // X(09:00) → S(10:00) → Y(11:00), all day 10. X, S released; Y live.
  seedAvailability([
    mkSlot('X', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 9, 0)) }),
    mkSlot('S', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) }),
    mkSlot('Y', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 11, 0)), phone: PHONE })
  ]);
  seedLifecycle([
    mkLifecycle('OP1', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 8, 9, 0), { oldSlotId: 'X', newSlotId: 'S' }),
    mkLifecycle('OP2', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'S', newSlotId: 'Y' })
  ]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  const data = res.data;
  assert.strictEqual(data.cohort.total, 3);
  assert.strictEqual(data.cohort.byPath.pathE_changed, 2);
  assert.strictEqual(data.cohort.byPath.pathA_stillConfirmed, 1);

  // S appears as OP1.new_slot_id AND OP2.old_slot_id — it contributes
  // exactly ONE episode (the one released by OP2).
  const r = res.data.rates;
  assertClose(r.CHANGE_RATE.value, 200 / 3, '2 changed of 3 episodes');
  assertClose(r.CANCELLATION_RATE.value, 0);
});

test('M2-04 — Sequential changes across days: each episode lives on its own day', function() {
  reset();
  // X day10 → A day11 → B day12
  seedAvailability([
    mkSlot('X', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 9, 0)) }),
    mkSlot('A', { status: 'FREE', sortKey: sortKeyOf(D(7, 11, 9, 0)) }),
    mkSlot('B', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 12, 9, 0)), phone: PHONE })
  ]);
  seedLifecycle([
    mkLifecycle('OP1', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'X', newSlotId: 'A' }),
    mkLifecycle('OP2', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 10, 9, 0), { oldSlotId: 'A', newSlotId: 'B' })
  ]);
  seedAttendance([]);

  const day10 = ratesOf(RFS.calculateRates(dayPeriod(7, 10)));
  assertClose(day10.CHANGE_RATE.value, 100, 'day 10: X changed (1/1)');
  assert.strictEqual(day10.CHANGE_RATE.provenance.denominator, 1);

  const day11 = ratesOf(RFS.calculateRates(dayPeriod(7, 11)));
  assertClose(day11.CHANGE_RATE.value, 100, 'day 11: A changed (1/1)');
  assert.strictEqual(day11.CHANGE_RATE.provenance.denominator, 1);

  const day12 = ratesOf(RFS.calculateRates(dayPeriod(7, 12)));
  assertClose(day12.CHANGE_RATE.value, 0, 'day 12: B is live, not changed');
  assertClose(day12.COMPLETION_RATE.value, 0);
});

test('M2-05 — Same-day change: two instances in ONE day cohort', function() {
  reset();
  seedAvailability([
    mkSlot('X', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) }),
    mkSlot('A', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 11, 0)), phone: PHONE })
  ]);
  seedLifecycle([
    mkLifecycle('OP1', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'X', newSlotId: 'A' })
  ]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.data.cohort.total, 2, 'old + new both belong to the same day');
  const r = res.data.rates;
  assertClose(r.CHANGE_RATE.value, 50, '1 changed of 2 episodes');
  assertClose(r.CANCELLATION_RATE.value, 0);
});

test('M2-06 — Recovery interleaving + duplicate terminal row: NO chronological sort', function() {
  function run(opATs, opBTs) {
    reset();
    seedAvailability([
      mkSlot('S', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) }),
      mkSlot('R1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 12, 10, 0)), phone: PHONE })
    ]);
    seedLifecycle([
      // OP_A changed S → R1; OP_B later cancelled S (rebooked instance);
      // plus a pathological DUPLICATE of OP_B (recovery re-proof).
      mkLifecycle('OP_A', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', opATs, { oldSlotId: 'S', newSlotId: 'R1' }),
      mkLifecycle('OP_B', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', opBTs, { oldSlotId: 'S' }),
      mkLifecycle('OP_B', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', opBTs + 5000, { oldSlotId: 'S' })
    ]);
    seedAttendance([]);
    return RFS.calculateRates(dayPeriod(7, 10)).data;
  }

  // Order A: change row earlier than cancel row
  const a = run(D(7, 11, 9, 0), D(7, 13, 9, 0));
  // Order B: same evidence, timestamps SWAPPED (recovery interleaving)
  const b = run(D(7, 13, 9, 0), D(7, 11, 9, 0));

  assert.strictEqual(a.cohort.total, 2, 'two released episodes on S');
  assert.strictEqual(a.cohort.byPath.pathD_cancelled, 1, 'OP_B deduped (duplicate row never multiplies)');
  assert.strictEqual(a.cohort.byPath.pathE_changed, 1);

  const pick = (d) => ({
    cohort: d.cohort.total,
    byPath: d.cohort.byPath,
    cancel: d.rates.CANCELLATION_RATE.value,
    change: d.rates.CHANGE_RATE.value,
    completed: d.rates.COMPLETION_RATE.value,
    noShow: d.rates.NO_SHOW_RATE.value
  });
  assert.deepStrictEqual(pick(a), pick(b), 'episode reconstruction is structural — identical under timestamp interleaving');
  assertClose(a.rates.CANCELLATION_RATE.value, 50);
  assertClose(a.rates.CHANGE_RATE.value, 50);
});

// ── 2 — Appointment-day basis ─────────────────────────────────────

test('M2-07 — Delayed completion: counted on APPOINTMENT day, not decision day', function() {
  reset();
  // Appointment 2026-08-20; doctor marks COMPLETED on 2026-08-22
  seedAvailability([
    mkSlot('S1', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 20, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 22, 12, 0))
  ]);

  const day20 = RFS.calculateRates(dayPeriod(7, 20));
  assert.strictEqual(day20.data.cohort.total, 1);
  const r20 = day20.data.rates;
  assertClose(r20.COMPLETION_RATE.value, 100, 'day 20: 1 completed of 1');

  // day 22 (decision day) has NO cohort — the rate must not live there
  const day22 = RFS.calculateRates(dayPeriod(7, 22));
  assert.strictEqual(day22.data.cohort.total, 0);
  assert.strictEqual(day22.data.rates.COMPLETION_RATE.status, 'UNAVAILABLE');
  assert.strictEqual(day22.data.rates.COMPLETION_RATE.reason, 'ZERO_DENOMINATOR');
});

test('M2-08 — Delayed no-show: counted on APPOINTMENT day', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'NO_SHOW', sortKey: sortKeyOf(D(7, 20, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([
    mkAudit('S1', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(7, 21, 18, 0))
  ]);

  const day20 = RFS.calculateRates(dayPeriod(7, 20));
  assertClose(day20.data.rates.NO_SHOW_RATE.value, 100);
  const day21 = RFS.calculateRates(dayPeriod(7, 21));
  assert.strictEqual(day21.data.rates.NO_SHOW_RATE.reason, 'ZERO_DENOMINATOR');
});

test('M2-09 — Post-day cancellation: terminal proof AFTER the day still counts on the appointment day', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'FREE', sortKey: sortKeyOf(D(7, 20, 10, 0)) })
  ]);
  seedLifecycle([
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 21, 9, 0), { oldSlotId: 'S1' })
  ]);
  seedAttendance([]);

  const day20 = RFS.calculateRates(dayPeriod(7, 20));
  assert.strictEqual(day20.data.cohort.total, 1);
  assertClose(day20.data.rates.CANCELLATION_RATE.value, 100, 'cancellation belongs to the appointment day');

  // M2 ≠ M1 operation-timestamp basis: day 21 (operation day) is empty
  const day21 = RFS.calculateRates(dayPeriod(7, 21));
  assert.strictEqual(day21.data.cohort.total, 0);
  assert.strictEqual(day21.data.rates.CANCELLATION_RATE.reason, 'ZERO_DENOMINATOR');
});

test('M2-10 — Post-day change: same appointment-day rule', function() {
  reset();
  seedAvailability([
    mkSlot('X', { status: 'FREE', sortKey: sortKeyOf(D(7, 20, 10, 0)) }),
    mkSlot('A', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 22, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([
    mkLifecycle('OP_A', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 21, 9, 0), { oldSlotId: 'X', newSlotId: 'A' })
  ]);
  seedAttendance([]);

  const day20 = RFS.calculateRates(dayPeriod(7, 20));
  assertClose(day20.data.rates.CHANGE_RATE.value, 100);
  const day21 = RFS.calculateRates(dayPeriod(7, 21));
  assert.strictEqual(day21.data.rates.CHANGE_RATE.reason, 'ZERO_DENOMINATOR');
  const day22 = RFS.calculateRates(dayPeriod(7, 22));
  assert.strictEqual(day22.data.cohort.total, 1, 'replacement lives on its own day');
  assertClose(day22.data.rates.CHANGE_RATE.value, 0);
});

test('M2-11 — Pre-B6 missing evidence: unprovable instances are absent, never invented', function() {
  // (a) one unprovable FREE slot + one provable live slot → cohort floor
  reset();
  seedAvailability([
    mkSlot('H1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 9, 0)) }),   // pre-B6 era, no journal
    mkSlot('L1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([]);
  const a = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(a.data.cohort.total, 1, 'only provable episodes count');
  assert.strictEqual(a.data.cohort.unattributableRows, 0, 'absence of evidence is not unattributable evidence');
  assertClose(a.data.rates.CANCELLATION_RATE.value, 0, 'valid zero, AVAILABLE');
  assert.strictEqual(a.data.rates.CANCELLATION_RATE.status, 'AVAILABLE');

  // (b) only unprovable slots → ZERO_DENOMINATOR (never 0%)
  reset();
  seedAvailability([
    mkSlot('H1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 9, 0)) })
  ]);
  seedLifecycle([]);
  seedAttendance([]);
  const b = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(b.data.cohort.total, 0);
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    assert.strictEqual(b.data.rates[name].status, 'UNAVAILABLE');
    assert.strictEqual(b.data.rates[name].reason, 'ZERO_DENOMINATOR');
    assert.strictEqual(b.data.rates[name].value, null);
  });
});

test('M2-12 — Pre-activation attendance (clock skew): earlier-timestamp row excluded', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 10, 9, 0)), phone: PHONE }),
    mkSlot('S2', { status: 'NO_SHOW', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  // Sheet order = append order. FIRST APPLIED (row 2) sets activation at
  // 10:00. The second row carries an EARLIER timestamp (09:00) — skew.
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 10, 10, 0)),
    mkAudit('S2', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(7, 10, 9, 0))
  ]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.cohort.total, 2);
  // S2's APPLIED row is pre-activation → its numerator is empty, but the
  // terminal STATE still proves S2's final episode (state ≠ audit).
  assert.strictEqual(res.data.cohort.byPath.pathB_completed, 1);
  assert.strictEqual(res.data.cohort.byPath.pathC_noShow, 1);
  const r = res.data.rates;
  assertClose(r.COMPLETION_RATE.value, 50);
  assertClose(r.NO_SHOW_RATE.value, 0, 'pre-activation APPLIED never counts');
  assert.strictEqual(r.NO_SHOW_RATE.status, 'AVAILABLE', 'valid zero — not converted to anything else');
  assert.strictEqual(res.data.provenance.activationMs, D(7, 10, 10, 0));
});

test('M2-13 — Still-confirmed closed day: cohort residue, all rates valid zeros', function() {
  reset();
  // Appointment day is in the past; the doctor never marked anything.
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 20, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 20));
  assert.strictEqual(res.data.cohort.total, 1);
  assert.strictEqual(res.data.cohort.byPath.pathA_stillConfirmed, 1);
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    assert.strictEqual(res.data.rates[name].status, 'AVAILABLE');
    assert.strictEqual(res.data.rates[name].value, 0, 'closed day residue: valid zero');
  });
});

// ── 3 — Evidence handling ─────────────────────────────────────────

test('M2-14 — Missing old_slot_id: unattributable, excluded, surfaced', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) })
  ]);
  seedLifecycle([
    mkLifecycle('OP_X', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 9, 0), { oldSlotId: '' })
  ]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.cohort.total, 0, 'no provable episode');
  assert.strictEqual(res.data.cohort.unattributableRows, 1);
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    assert.strictEqual(res.data.rates[name].status, 'UNAVAILABLE');
    assert.strictEqual(res.data.rates[name].reason, 'ZERO_DENOMINATOR');
    assert.strictEqual(res.data.rates[name].provenance.unattributableRows, 1);
  });
});

test('M2-15 — Missing new_slot_id: old episode still CHANGED (reference-only field)', function() {
  reset();
  seedAvailability([
    mkSlot('X1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) })
  ]);
  seedLifecycle([
    mkLifecycle('OP_Y', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'X1', newSlotId: '' })
  ]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.data.cohort.total, 1);
  assert.strictEqual(res.data.cohort.byPath.pathE_changed, 1);
  assertClose(res.data.rates.CHANGE_RATE.value, 100);
  assert.strictEqual(res.data.rates.CHANGE_RATE.status, 'AVAILABLE');
  assert.strictEqual(res.data.rates.CHANGE_RATE.provenance.changeRowsMissingNewSlotId, 1, 'surfaced in provenance');
});

test('M2-16 — APPLIED row with missing slot_id: unattributable, never counted', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([
    mkAudit('', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 10, 12, 0))
  ]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.data.cohort.total, 1, 'the live slot is still provable');
  assert.strictEqual(res.data.cohort.unattributableRows, 1);
  assert.strictEqual(res.data.rates.COMPLETION_RATE.value, 0);
  assert.strictEqual(res.data.rates.COMPLETION_RATE.status, 'AVAILABLE');
  assert.strictEqual(res.data.rates.COMPLETION_RATE.provenance.numerator, 0);
});

test('M2-17 — Duplicate terminal operation_id (recovery re-proof): deduped to one episode', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) })
  ]);
  seedLifecycle([
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'S1' }),
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 9, 0) + 5000, { oldSlotId: 'S1' })
  ]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.data.cohort.total, 1, 'one operation = one released episode');
  assert.strictEqual(res.data.cohort.byPath.pathD_cancelled, 1);
  assertClose(res.data.rates.CANCELLATION_RATE.value, 100);
  assert.strictEqual(res.data.cohort.unattributableRows, 0, 'duplication is expected journal shape, not unattributable');
});

test('M2-18 — Conflicting attendance (COMPLETED + NO_SHOW): all four rates UNAVAILABLE', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 10, 12, 0)),
    mkAudit('S1', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(7, 10, 13, 0))
  ]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.ok, true, 'conflict is an honest UNAVAILABLE result, not a call failure');
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    const e = res.data.rates[name];
    assert.strictEqual(e.status, 'UNAVAILABLE');
    assert.strictEqual(e.reason, 'RATE_EVIDENCE_INVALID');
    assert.strictEqual(e.value, null);
    assert.strictEqual(e.provenance.conflicts.length, 1);
    assert.strictEqual(e.provenance.conflicts[0].type, 'ATTENDANCE_OUTCOME_CONFLICT');
  });
});

test('M2-19 — Conflicting evidence OUT of period: period-scoped, not fatal', function() {
  reset();
  seedAvailability([
    mkSlot('S_BAD', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 5, 10, 0)), phone: PHONE }),
    mkSlot('S_OK', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([
    mkAudit('S_BAD', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 5, 12, 0)),
    mkAudit('S_BAD', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(7, 5, 13, 0))
  ]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    assert.strictEqual(res.data.rates[name].status, 'AVAILABLE');
    assert.strictEqual(res.data.rates[name].provenance.conflicts.length, 0);
  });
  assert.strictEqual(res.data.cohort.total, 1);
  assert.strictEqual(res.data.rates.CANCELLATION_RATE.provenance.outOfPeriodConflicts, 1, 'counted for transparency');
});

test('M2-20 — Duplicate Availability slot_id IN period: identity ambiguity → UNAVAILABLE', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE }),
    mkSlot('S1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) }),
    mkSlot('S2', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 11, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    const e = res.data.rates[name];
    assert.strictEqual(e.status, 'UNAVAILABLE');
    assert.strictEqual(e.reason, 'RATE_EVIDENCE_INVALID');
    assert.strictEqual(e.provenance.conflicts[0].type, 'DUPLICATE_SLOT_ID');
  });
});

test('M2-21 — Duplicate Availability slot_id OUT of period: not fatal, counted', function() {
  reset();
  seedAvailability([
    mkSlot('S_DUP', { status: 'FREE', sortKey: sortKeyOf(D(7, 5, 10, 0)) }),
    mkSlot('S_DUP', { status: 'FREE', sortKey: sortKeyOf(D(7, 5, 10, 0)) }),
    mkSlot('S_OK', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.data.cohort.total, 1);
  assert.strictEqual(res.data.rates.CANCELLATION_RATE.status, 'AVAILABLE');
  assert.strictEqual(res.data.rates.CANCELLATION_RATE.provenance.outOfPeriodConflicts, 1);
});

test('M2-22 — One operation_id, two distinct old_slot_ids (K4): UNAVAILABLE', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 9, 0)) }),
    mkSlot('S2', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) })
  ]);
  seedLifecycle([
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'S1' }),
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 10, 0), { oldSlotId: 'S2' })
  ]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    const e = res.data.rates[name];
    assert.strictEqual(e.status, 'UNAVAILABLE');
    assert.strictEqual(e.reason, 'RATE_EVIDENCE_INVALID');
    assert.strictEqual(e.provenance.conflicts[0].type, 'OPERATION_IDENTITY_CONFLICT');
  });
});

test('M2-23 — One operation_id, both CANCEL and CHANGE terminals (K5): UNAVAILABLE', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 9, 0)) })
  ]);
  seedLifecycle([
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'S1' }),
    mkLifecycle('OP_A', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 9, 10, 0), { oldSlotId: 'S1', newSlotId: 'R1' })
  ]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.data.rates.CANCELLATION_RATE.reason, 'RATE_EVIDENCE_INVALID');
  assert.strictEqual(res.data.rates.CHANGE_RATE.reason, 'RATE_EVIDENCE_INVALID');
  assert.strictEqual(res.data.rates.COMPLETION_RATE.reason, 'RATE_EVIDENCE_INVALID');
  assert.strictEqual(res.data.rates.NO_SHOW_RATE.reason, 'RATE_EVIDENCE_INVALID');
  assert.strictEqual(res.data.rates.CANCELLATION_RATE.provenance.conflicts[0].type, 'OPERATION_IDENTITY_CONFLICT');
});

test('M2-24 — APPLIED evidence on a currently CONFIRMED slot (K3): UNAVAILABLE', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 10, 12, 0))
  ]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    assert.strictEqual(res.data.rates[name].status, 'UNAVAILABLE');
    assert.strictEqual(res.data.rates[name].reason, 'RATE_EVIDENCE_INVALID');
    assert.strictEqual(res.data.rates[name].provenance.conflicts[0].type, 'APPLIED_VS_CURRENT_STATE');
  });
});

test('M2-31 — ALREADY_APPLIED never creates a count (and never anchors activation)', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'ALREADY_APPLIED', D(7, 10, 12, 0))
  ]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.data.cohort.total, 1, 'terminal STATE still proves the final episode');
  assert.strictEqual(res.data.cohort.byPath.pathB_completed, 1);
  assert.strictEqual(res.data.rates.COMPLETION_RATE.value, 0, 'numerator is APPLIED-only');
  assert.strictEqual(res.data.rates.COMPLETION_RATE.status, 'AVAILABLE');
  assert.strictEqual(res.data.provenance.activationMs, null, 'ALREADY_APPLIED is not the activation anchor');
});

test('M2-32 — Completed slot with NO audit row (audit loss): state proves cohort, numerator stays zero', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.data.cohort.total, 1);
  assert.strictEqual(res.data.cohort.byPath.pathB_completed, 1, 'CONFIRMED→COMPLETED is the only legal entry — state proves it');
  assert.strictEqual(res.data.rates.COMPLETION_RATE.value, 0, 'numerator is APPLIED-only (v2 §12)');
  assert.strictEqual(res.data.rates.COMPLETION_RATE.status, 'AVAILABLE');
  const sum = res.data.rates.CANCELLATION_RATE.value + res.data.rates.CHANGE_RATE.value +
    res.data.rates.COMPLETION_RATE.value + res.data.rates.NO_SHOW_RATE.value;
  assert.strictEqual(sum, 0, 'rates may sum below 100% (partition is an upper bound)');
});

// ── 4 — Zero / source semantics ───────────────────────────────────

test('M2-25 — Start/end boundaries: start inclusive, end exclusive', function() {
  reset();
  const start = D(7, 10, 0, 0);
  const end = D(7, 11, 0, 0);
  seedAvailability([
    mkSlot('AT_START', { status: 'CONFIRMED', sortKey: sortKeyOf(start) }),            // == startMs → IN
    mkSlot('AT_END', { status: 'CONFIRMED', sortKey: sortKeyOf(end) }),                // == endMs → OUT
    mkSlot('JUST_BEFORE', { status: 'CONFIRMED', sortKey: sortKeyOf(start - 60000) }), // OUT
    mkSlot('JUST_AFTER', { status: 'CONFIRMED', sortKey: sortKeyOf(start + 60000) })   // IN
  ]);
  seedLifecycle([]);
  seedAttendance([]);

  const res = RFS.calculateRates({ start: start, end: end });
  assert.strictEqual(res.data.cohort.total, 2, 'AT_START + JUST_AFTER only');
});

test('M2-26 — Zero denominator: UNAVAILABLE / null — never 0%', function() {
  reset();
  seedEmptySources();

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.cohort.total, 0);
  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    const e = res.data.rates[name];
    assert.strictEqual(e.status, 'UNAVAILABLE');
    assert.strictEqual(e.reason, 'ZERO_DENOMINATOR');
    assert.strictEqual(e.value, null, 'value MUST be null, never 0');
    assert.strictEqual(e.provenance.denominator, 0);
    assert.strictEqual(e.provenance.numerator, 0);
  });
});

test('M2-27 — Source failure: RATE_SOURCE_UNAVAILABLE for each of the three sources', function() {
  const cases = [
    { source: 'Availability' },
    { source: 'B6_LIFECYCLE' },
    { source: 'ATTENDANCE_AUDIT' }
  ];
  cases.forEach(function(c) {
    reset();
    seedEmptySources();
    state.failRead[c.source] = true;
    const res = RFS.calculateRates(dayPeriod(7, 10));
    assert.strictEqual(res.ok, false, c.source + ' failure must fail the call');
    assert.strictEqual(res.error.code, 'RATE_SOURCE_UNAVAILABLE');
    assert.strictEqual(res.error.details.source, c.source);
  });
});

test('M2-28 — Shared-source coupling: one failing source fails the WHOLE batch', function() {
  // Cancellation evidence is perfect — but the SHARED denominator needs
  // attendance too. A healthy-looking subset must never be exposed.
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'FREE', sortKey: sortKeyOf(D(7, 10, 10, 0)) })
  ]);
  seedLifecycle([
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 9, 0), { oldSlotId: 'S1' })
  ]);
  state.failRead['ATTENDANCE_AUDIT'] = true;

  const res = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res.ok, false, 'no partial-healthy foundation');
  assert.strictEqual(res.error.code, 'RATE_SOURCE_UNAVAILABLE');

  // And the reverse: an Availability failure also kills cancellation,
  // even though B6 alone "has the answer".
  reset();
  seedEmptySources();
  state.failRead['Availability'] = true;
  const res2 = RFS.calculateRates(dayPeriod(7, 10));
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(res2.error.details.source, 'Availability');
});

// ── 5 — Weekly / Monthly count-weighted rollup ────────────────────

test('M2-33 — Weekly rollup is count-weighted (never the average of daily rates)', function() {
  function seedWeek() {
    reset();
    const slots = [];
    // One live slot on each of the 7 days
    for (let i = 0; i < 7; i++) {
      slots.push(mkSlot('L' + i, {
        status: 'CONFIRMED',
        sortKey: sortKeyOf(D(7, 16 + i, 9, 0)),
        phone: PHONE
      }));
    }
    // Day 16: one cancellation
    slots.push(mkSlot('C1', { status: 'FREE', sortKey: sortKeyOf(D(7, 16, 10, 0)) }));
    // Day 17: one completed (first APPLIED → activation)
    slots.push(mkSlot('M17', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 17, 10, 0)), phone: PHONE }));
    // Day 19: one same-day change (X3 → A3)
    slots.push(mkSlot('X3', { status: 'FREE', sortKey: sortKeyOf(D(7, 19, 9, 0)) }));
    slots.push(mkSlot('A3', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 19, 11, 0)), phone: PHONE }));
    seedAvailability(slots);

    seedLifecycle([
      mkLifecycle('OP_C1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 15, 10, 0), { oldSlotId: 'C1' }),
      mkLifecycle('OP_X3', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(7, 18, 9, 0), { oldSlotId: 'X3', newSlotId: 'A3' })
    ]);
    seedAttendance([
      mkAudit('M17', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 17, 12, 30))
    ]);
  }

  seedWeek();
  const week = { start: D(7, 16, 0), end: D(7, 23, 0) };
  const weekly = RFS.calculateRates(week).data;

  // daily slices
  const daily = [];
  for (let i = 0; i < 7; i++) {
    daily.push(RFS.calculateRates(dayPeriod(7, 16 + i)).data);
  }

  // denominators add up (count-weighted, not percentage-averaged)
  assert.strictEqual(weekly.cohort.total, 11);
  const sumDen = daily.reduce((acc, d) => acc + d.cohort.total, 0);
  assert.strictEqual(sumDen, 11, 'weekly denominator = SUM of daily cohort counts');

  ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'].forEach(function(name) {
    const sumNum = daily.reduce((acc, d) => acc + d.rates[name].provenance.numerator, 0);
    assert.strictEqual(weekly.rates[name].provenance.numerator, sumNum, name + ' numerator adds up');
    assertClose(weekly.rates[name].value, (sumNum / sumDen) * 100, name + ' = SUM(num)/SUM(den)*100');
  });

  // Explicitly NOT the average of daily percentages:
  const dailyCancelValues = daily.map((d) => d.rates.CANCELLATION_RATE.value);
  const avgOfDailyPct = dailyCancelValues.reduce((a, b) => a + b, 0) / 7;
  assertClose(weekly.rates.CANCELLATION_RATE.value, 1 / 11 * 100);
  assert.strictEqual(
    Math.abs(weekly.rates.CANCELLATION_RATE.value - avgOfDailyPct) > 1e-6, true,
    'weekly rate must differ from the plain average of daily rates'
  );
});

test('M2-34 — Monthly rollup is count-weighted over 31 daily periods', function() {
  reset();
  const slots = [
    mkSlot('J1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(6, 2, 9, 0)), phone: PHONE }),
    mkSlot('J2', { status: 'FREE', sortKey: sortKeyOf(D(6, 2, 10, 0)) }),
    mkSlot('J3', { status: 'CONFIRMED', sortKey: sortKeyOf(D(6, 15, 9, 0)), phone: PHONE }),
    mkSlot('J4', { status: 'CONFIRMED', sortKey: sortKeyOf(D(6, 15, 10, 0)), phone: PHONE }),
    mkSlot('J5', { status: 'FREE', sortKey: sortKeyOf(D(6, 30, 9, 0)) }),
    mkSlot('J6', { status: 'CONFIRMED', sortKey: sortKeyOf(D(6, 30, 11, 0)), phone: PHONE })
  ];
  seedAvailability(slots);
  seedLifecycle([
    mkLifecycle('OP_J2', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(6, 1, 10, 0), { oldSlotId: 'J2' }),
    mkLifecycle('OP_J5', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(6, 29, 9, 0), { oldSlotId: 'J5', newSlotId: 'J6' })
  ]);
  seedAttendance([]);

  const month = { start: D(6, 1, 0), end: D(7, 1, 0) };
  const monthly = RFS.calculateRates(month).data;
  assert.strictEqual(monthly.cohort.total, 6);

  let sumDen = 0;
  let sumCancel = 0;
  let sumChange = 0;
  for (let day = 1; day <= 31; day++) {
    const d = RFS.calculateRates({ start: D(6, day, 0), end: D(6, day + 1, 0) }).data;
    sumDen += d.cohort.total;
    sumCancel += d.rates.CANCELLATION_RATE.provenance.numerator;
    sumChange += d.rates.CHANGE_RATE.provenance.numerator;
  }
  assert.strictEqual(sumDen, 6);
  assert.strictEqual(monthly.rates.CANCELLATION_RATE.provenance.numerator, sumCancel, 1);
  assert.strictEqual(monthly.rates.CHANGE_RATE.provenance.numerator, sumChange, 1);
  assertClose(monthly.rates.CANCELLATION_RATE.value, 1 / 6 * 100);
  assertClose(monthly.rates.CHANGE_RATE.value, 1 / 6 * 100);
});

// ── 6 — API hygiene ───────────────────────────────────────────────

test('M2-35 — Period validation: malformed / inverted / non-finite periods', function() {
  reset();
  seedEmptySources();
  const bad = [
    { start: D(7, 10, 0), end: D(7, 10, 0) },   // equal
    { start: 100, end: 50 },                     // inverted
    { start: NaN, end: 100 },                    // non-finite
    { start: 5, end: 3 },                        // inverted
    'nope',                                      // non-object
    { start: {}, end: {} },                      // wrong types
    null                                         // missing
  ];
  bad.forEach(function(b) {
    const res = RFS.calculateRates(b);
    assert.strictEqual(res.ok, false, JSON.stringify(b) + ' must fail');
    assert.strictEqual(res.error.code, 'RATE_PERIOD_INVALID');
  });
});

test('M2-36 — Determinism: Date inputs and epoch-ms inputs give identical results', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: PHONE })
  ]);
  seedLifecycle([]);
  seedAttendance([]);

  const r1 = RFS.calculateRates({ start: D(7, 10, 0), end: D(7, 11, 0) });
  const r2 = RFS.calculateRates({
    start: sandbox.mkVmDate(D(7, 10, 0)),
    end: sandbox.mkVmDate(D(7, 11, 0))
  });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(deepStrip(r1.data), deepStrip(r2.data));
});

test('M2-29 — Provenance completeness (v2 §27: every question answerable)', function() {
  reset();
  // reuse scenario + one unattributable row
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 10, 10, 0)), phone: '9647002222222' })
  ]);
  seedLifecycle([
    mkLifecycle('OP_A', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 12, 0), { oldSlotId: 'S1' }),
    mkLifecycle('OP_BAD', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 9, 13, 0), { oldSlotId: '' })
  ]);
  seedAttendance([]);

  const res = RFS.calculateRates(dayPeriod(7, 10));
  const data = res.data;
  const env = data.rates.CANCELLATION_RATE;
  const prov = env.provenance;

  // What was the numerator? What was the denominator?
  assert.strictEqual(prov.numerator, 1);
  assert.strictEqual(prov.denominator, 2);
  assert.strictEqual(prov.formula, 'numerator / denominator * 100');
  // Which appointment day was used?
  assert.ok(prov.appointmentDayBasis.indexOf('APPOINTMENT_START') !== -1);
  assert.strictEqual(prov.periodSemantics, 'start inclusive, end exclusive (canonical epoch ms)');
  // Which evidence sources? How many episodes, by which path?
  assert.strictEqual(data.provenance.sources.length, 3);
  assert.deepStrictEqual(hostClone(prov.cohortByPath), {
    pathA_stillConfirmed: 1,
    pathB_completed: 0,
    pathC_noShow: 0,
    pathD_cancelled: 1,
    pathE_changed: 0
  });
  const pathSum = Object.keys(prov.cohortByPath).reduce((a, k) => a + prov.cohortByPath[k], 0);
  assert.strictEqual(pathSum, prov.denominator, 'cohortByPath sums to the denominator');
  // How many slots reused? How many episodes?
  assert.strictEqual(prov.reusedSlots, 1);
  assert.strictEqual(prov.reusedSlotEpisodes, 2);
  // How many excluded, and why?
  assert.strictEqual(prov.unattributableRows, 1);
  assert.strictEqual(prov.sourceFailure, null);
  assert.deepStrictEqual(hostClone(prov.conflicts), []);
  // as-of
  assert.strictEqual(data.asOfMs, NOW_MS);
  assert.strictEqual(env.asOfMs, NOW_MS);
  // evidence condition is explicit per rate
  assert.strictEqual(prov.evidence.source, 'B6_LIFECYCLE');
  assert.ok(prov.evidence.aggregation.indexOf('COUNT DISTINCT operation_id') !== -1);
  assert.strictEqual(data.rates.COMPLETION_RATE.provenance.evidence.source, 'ATTENDANCE_AUDIT');
  // cohort block at top level
  assert.strictEqual(data.cohort.total, 2);
  assert.strictEqual(data.cohort.unattributableRows, 1);
});

test('M2-30 — Read-once per source, read-only (no writes / no sheet creation / no legacy reads)', function() {
  reset();
  seedAvailability([
    mkSlot('L0', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 16, 9, 0)), phone: PHONE }),
    mkSlot('C1', { status: 'FREE', sortKey: sortKeyOf(D(7, 16, 10, 0)) })
  ]);
  seedLifecycle([
    mkLifecycle('OP_C1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 15, 10, 0), { oldSlotId: 'C1' })
  ]);
  seedAttendance([
    mkAudit('L0', 'MARK_COMPLETED', 'COMPLETED', 'ALREADY_APPLIED', D(7, 16, 12, 0))
  ]);

  const res = RFS.calculateRates(dayPeriod(7, 16));
  assert.strictEqual(res.ok, true);

  // ONE read per source
  assert.strictEqual(state.queryCalls['Availability'], 1);
  assert.strictEqual(state.queryCalls['B6_LIFECYCLE'], 1);
  assert.strictEqual(state.queryCalls['ATTENDANCE_AUDIT'], 1);
  // Header validation only where the reporting boundaries require it
  assert.strictEqual(state.headerCalls['B6_LIFECYCLE'], 1);
  assert.strictEqual(state.headerCalls['ATTENDANCE_AUDIT'], 1);
  assert.strictEqual(state.headerCalls['Availability'] || 0, 0);
  // READ ONLY
  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.sheetCreates, 0);
});

test('M2-37 — All periods via ReportPeriod.periodFor (DAILY / WEEKLY / MONTHLY)', function() {
  reset();
  seedEmptySources();
  const ref = D(7, 24, 12);

  const daily = RFS.calculateRatesForReport('DAILY', ref);
  assert.strictEqual(daily.ok, true);
  assert.strictEqual(daily.data.reportType, 'DAILY');
  assert.strictEqual(
    daily.data.period.startMs,
    sandbox.ReportPeriod.dailyPeriod(ref).data.startMs,
    'daily period delegates to ReportPeriod'
  );
  assert.strictEqual(daily.data.period.endMs, sandbox.ReportPeriod.dailyPeriod(ref).data.endMs);
  assert.strictEqual(daily.data.period.timeZone, 'Asia/Baghdad');
  assert.strictEqual(Object.keys(daily.data.rates).length, 4);
  // empty sources → honest ZERO_DENOMINATOR envelopes, not an error
  assert.strictEqual(daily.data.rates.CANCELLATION_RATE.status, 'UNAVAILABLE');
  assert.strictEqual(daily.data.rates.CANCELLATION_RATE.reason, 'ZERO_DENOMINATOR');

  const weekly = RFS.calculateRatesForReport('WEEKLY', ref);
  assert.strictEqual(weekly.ok, true);
  assert.strictEqual(
    weekly.data.period.startMs,
    sandbox.ReportPeriod.weeklyPeriod(ref).data.startMs,
    'weekly period delegates to ReportPeriod (Saturday-start reporting calendar)'
  );
  assert.strictEqual(weekly.data.period.reportWeekStart, 6);

  const monthly = RFS.calculateRatesForReport('MONTHLY', ref);
  assert.strictEqual(monthly.ok, true);
  assert.strictEqual(
    monthly.data.period.startMs,
    sandbox.ReportPeriod.monthlyPeriod(ref).data.startMs,
    'monthly period delegates to ReportPeriod'
  );

  const unknown = RFS.calculateRatesForReport('HOURLY', ref);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.error.code, 'REPORT_TYPE_UNKNOWN');

  const badRef = RFS.calculateRatesForReport('DAILY', 'nope');
  assert.strictEqual(badRef.ok, false);
  assert.strictEqual(badRef.error.code, 'REPORT_PERIOD_INVALID');
});

// ── Runner ────────────────────────────────────────────────────────

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
