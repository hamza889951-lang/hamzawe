'use strict';

/**
 * HardeningM1.test.js — M1-A (PHASE 1.2 — METRICS FOUNDATION)
 *
 * Proves the M1-A contract:
 *   A — Confirmed Appointments (count / valid zero / boundaries /
 *       historical DEFERRED)
 *   B — Bookable Slots (eligibility = SlotSelection contract / lead
 *       cutoff / historical DEFERRED)
 *   C — Official Cancellations (terminal filtering / COUNT DISTINCT
 *       operation_id / boundaries / append-only history provable)
 *   D — Official Changes (terminal filtering / wrong-pair exclusion)
 *   E — Completed / No-show (APPLIED filtering / ALREADY_APPLIED
 *       exclusion / activation boundary / distinct slot_id /
 *       decision-timestamp basis / pre-activation valid zero)
 *   F — Failure semantics (source failure ≠ zero for all three sources;
 *       schema drift; unknown metric; malformed periods)
 *   G — Determinism (Date vs epoch-ms inputs; uniform inclusive/
 *       exclusive boundaries across all metric families)
 *   H — Zero denominator (ratio combinator: N/A, never 0%)
 *   I — Honesty (unattributable rows surfaced, never guessed;
 *       snapshot metrics never invented for closed periods)
 *   P — Performance & purity (one read per source in calculateMany;
 *       zero writes / zero sheet creation / no locks)
 *   S — Structural boundaries (layering, Clock, read-only attendance
 *       boundary, append-only writer untouched, B6 repository API
 *       surface, clasp evaluation-order independence)
 *
 * P1 REMEDIATION (review of PR #12):
 *   — ATTENDANCE_ACTIVATION_AT is the timestamp of the FIRST APPLIED
 *     row in append order. If that row's timestamp is unparseable the
 *     attendance metrics FAIL (METRIC_EVIDENCE_INVALID); the boundary
 *     is NEVER redefined to the next parsable row. (test M1-E8)
 *   — Terminal lifecycle rows without a valid non-empty operation_id
 *     and APPLIED attendance rows without a valid non-empty slot_id
 *     are unattributable and never counted. (tests M1-C6, M1-E9)
 *
 * Regression (M0 + B1–B6 = 149/149) is executed from the existing
 * Hardening*.test.js files against the same tree.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';

// ── Deterministic time anchors (local-wall constructors; every metric
//    comparison happens in canonical epoch ms) ─────────────────────
const NOW_DATE = new Date(2026, 7, 24, 12, 0);            // 2026-08-24 12:00
const NOW_MS = NOW_DATE.getTime();
const DAY_START_MS = new Date(2026, 7, 24, 0, 0).getTime();
const DAY_END_MS = new Date(2026, 7, 25, 0, 0).getTime();
const P = { start: DAY_START_MS, end: DAY_END_MS };
const PAST_P = {
  start: new Date(2026, 7, 20, 0, 0).getTime(),
  end: new Date(2026, 7, 21, 0, 0).getTime()
};
const FUTURE_P = {
  start: new Date(2026, 8, 1, 0, 0).getTime(),
  end: new Date(2026, 8, 2, 0, 0).getTime()
};
/** hour on 2026-08-24 */
function H(hour) { return new Date(2026, 7, 24, hour, 0).getTime(); }
/** hour on another day (month is 0-based) */
function D(month, day, hour) { return new Date(2026, month, day, hour, 0).getTime(); }

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ═══════════════════════════════════════════════════════════════
// Sandbox — production M1 stack over an in-memory GoogleSheets seam
// ═══════════════════════════════════════════════════════════════

function createMetricsSandbox() {
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
  // returns, a caller builds, or MetricsService sees shares one Date
  // constructor. To simulate that faithfully, tests create seed/caller
  // Dates in the SANDBOX realm (host-realm Dates would fail instanceof
  // checks cross-realm, which cannot happen in production).
  vm.runInContext('this.mkVmDate = function(ms) { return new Date(ms); };', sandbox);

  // Read paths are faithful to the production GoogleSheets surface.
  // Every mutation path is instrumented to FAIL the test if metrics
  // ever touch it (M1: metrics are pure reads).
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
      // Faithful to production GoogleSheets.queryRows: every row becomes
      // an object carrying _rowNumber (sheet row, 1-based, header = 1)
      // BEFORE the predicate runs, and sheet order is preserved.
      return sheet.rows.map(function(r, idx) {
          return Object.assign({ _rowNumber: idx + 2 }, r);
        })
        .filter(predicateFn)
        .map(function(r) { return Object.assign({}, r); });
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

  // Load the real production stack (references resolve at call time).
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

  return { sandbox: sandbox, state: state };
}

const core = createMetricsSandbox();
const sandbox = core.sandbox;
const state = core.state;

// ── Sheet seeding helpers ────────────────────────────────────────

const AV_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];

function mkSlot(id, opts) {
  const o = opts || {};
  return {
    slot_id: id,
    date: o.date || '2026/08/24',
    time: o.time || '16:00',
    sort_key: o.sortKey !== undefined ? o.sortKey : '202608241600',
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

function reset() {
  state.nowMs = NOW_MS;
  state.sheets = {};
  state.failRead = {};
  state.queryCalls = {};
  state.headerCalls = {};
  state.writes = 0;
  state.sheetCreates = 0;
}

/** Envelope copy without the evaluatedAt timestamp (Clock-dependent). */
function stripped(envelope) {
  const copy = Object.assign({}, envelope);
  delete copy.evaluatedAt;
  return copy;
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ── A — Confirmed Appointments ──────────────────────────────────

test('M1-A1 — Confirmed count: only CONFIRMED rows with start inside the period are counted', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: '202608241000', phone: PHONE }),
    mkSlot('S2', { status: 'CONFIRMED', sortKey: '202608241600', phone: PHONE }),
    mkSlot('S3', { status: 'CONFIRMED', sortKey: '202608251000', phone: PHONE }), // next day
    mkSlot('S4', { status: 'FREE', sortKey: '202608241700' }),
    mkSlot('S5', { status: 'COMPLETED', sortKey: '202608241800', phone: PHONE }),
    mkSlot('S6', { status: 'NO_SHOW', sortKey: '202608241900', phone: PHONE }),
    mkSlot('S7', { status: 'RESERVED', sortKey: '202608241100', phone: PHONE })
  ]);

  const result = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 2);
  assert.strictEqual(result.data.reason, null);
  assert.strictEqual(result.data.period.startMs, P.start);
  assert.strictEqual(result.data.period.endMs, P.end);

  const provenance = result.data.provenance;
  assert.strictEqual(provenance.source, 'Availability');
  // Array.from: bring the vm-realm array into the host realm for strict comparison
  assert.deepStrictEqual(Array.from(provenance.fields), ['status', 'sort_key']);
  assert.ok(provenance.condition.indexOf("status === 'CONFIRMED'") !== -1);
  assert.strictEqual(provenance.aggregation, 'COUNT');
  assert.strictEqual(provenance.semantics, 'SNAPSHOT_CURRENT_STATE');
  assert.strictEqual(provenance.unattributableRows, 0);
  assert.strictEqual(provenance.periodSemantics, 'start inclusive, end exclusive (canonical epoch ms)');
});

test('M1-A2 — Confirmed empty store / empty period is a VALID ZERO, never unavailable', function() {
  reset();
  seedAvailability([]); // headers only, zero rows
  const emptyStore = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  assert.strictEqual(emptyStore.ok, true);
  assert.strictEqual(emptyStore.data.status, 'AVAILABLE');
  assert.strictEqual(emptyStore.data.value, 0);

  reset();
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: '202608261000', phone: PHONE }) // outside period
  ]);
  const emptyPeriod = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  assert.strictEqual(emptyPeriod.ok, true);
  assert.strictEqual(emptyPeriod.data.status, 'AVAILABLE');
  assert.strictEqual(emptyPeriod.data.value, 0);
});

test('M1-A3 — Confirmed start boundary is inclusive', function() {
  reset();
  seedAvailability([
    mkSlot('AT_START', { status: 'CONFIRMED', sortKey: '202608240000', phone: PHONE })
  ]);
  const result = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  assert.strictEqual(result.data.value, 1);
});

test('M1-A4 — Confirmed end boundary is exclusive', function() {
  reset();
  seedAvailability([
    mkSlot('AT_END', { status: 'CONFIRMED', sortKey: '202608250000', phone: PHONE })
  ]);
  const result = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  assert.strictEqual(result.data.value, 0);
});

test('M1-A5 — Confirmed closed (historical) period → DEFERRED / HISTORICAL_NOT_PROVABLE, with zero source reads', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: '202608201000', phone: PHONE })
  ]);
  const result = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', PAST_P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'DEFERRED');
  assert.strictEqual(result.data.value, null);
  assert.strictEqual(result.data.reason, 'HISTORICAL_NOT_PROVABLE');
  assert.ok(result.data.provenance.historicalPolicy.indexOf('mutable') !== -1);
  // an unprovable metric must not even imply the source was consulted
  assert.strictEqual(state.queryCalls['Availability'] || 0, 0);
  assert.strictEqual(state.headerCalls['Availability'] || 0, 0);
});

// ── B — Bookable Slots ──────────────────────────────────────────

test('M1-B1 — Bookable eligibility mirrors SlotSelection.findEarliestBookable exactly', function() {
  reset();
  // NOW = 12:00 → cutoff = 13:00
  seedAvailability([
    mkSlot('B1', { status: 'FREE', sortKey: '202608241600', isAvailable: 'TRUE' }),  // ✓ string TRUE
    mkSlot('B2', { status: 'FREE', sortKey: '202608241700', isAvailable: true }),   // ✓ boolean
    mkSlot('B3', { status: 'FREE', sortKey: '202608241230' }),                      // ✗ before lead cutoff
    mkSlot('B4', { status: 'FREE', sortKey: '202608241800', isAvailable: 'FALSE' }),// ✗ not available
    mkSlot('B5', { status: 'FREE', sortKey: '202608241900', isAvailable: false }),  // ✗ not available
    mkSlot('B6', { status: 'CONFIRMED', sortKey: '202608241930', phone: PHONE }),   // ✗ not FREE
    mkSlot('B7', { status: 'FREE', sortKey: '202608251000' })                       // ✗ outside period
  ]);

  const result = sandbox.MetricsService.calculate('BOOKABLE_SLOTS', P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 2);
  assert.strictEqual(result.data.provenance.leadMinutes, 60);
  assert.strictEqual(result.data.provenance.eligibilityReference, 'SlotSelection.findEarliestBookable');
  assert.strictEqual(result.data.provenance.eligibilityCutoffMs, NOW_MS + 60 * 60000);
});

test('M1-B2 — Bookable lead cutoff boundary is inclusive (>= now + lead)', function() {
  reset();
  seedAvailability([
    mkSlot('AT_CUTOFF', { status: 'FREE', sortKey: '202608241300' }) // exactly 13:00
  ]);
  const result = sandbox.MetricsService.calculate('BOOKABLE_SLOTS', P);
  assert.strictEqual(result.data.value, 1);
});

test('M1-B3 — Bookable closed (historical) period → DEFERRED, never reconstructed', function() {
  reset();
  seedAvailability([mkSlot('OLD', { status: 'FREE', sortKey: '202608201000' })]);
  const result = sandbox.MetricsService.calculate('BOOKABLE_SLOTS', PAST_P);
  assert.strictEqual(result.data.status, 'DEFERRED');
  assert.strictEqual(result.data.value, null);
  assert.strictEqual(result.data.reason, 'HISTORICAL_NOT_PROVABLE');
  assert.strictEqual(state.queryCalls['Availability'] || 0, 0);
});

test('M1-B4 — Bookable future period is a valid current snapshot (generated ≠ bookable)', function() {
  reset();
  seedAvailability([
    mkSlot('F1', { status: 'FREE', sortKey: '202609011000' }),
    mkSlot('F2', { status: 'FREE', sortKey: '202609011100', isAvailable: false }),
    mkSlot('F3', { status: 'RESERVED', sortKey: '202609011200', phone: PHONE })
  ]);
  const result = sandbox.MetricsService.calculate('BOOKABLE_SLOTS', FUTURE_P);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 1);
});

// ── C — Official Cancellations ──────────────────────────────────

test('M1-C1 — Cancellations: only RESOLVED_CANCEL + TERMINAL_CANCEL_PROVEN rows count, distinct operations', function() {
  reset();
  seedLifecycle([
    mkLifecycle('OP1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(10) + 30000),
    mkLifecycle('OP2', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(11)),
    mkLifecycle('OP3', 'RESOLVED_CANCEL', 'RELEASE_PENDING', H(12)),               // state ok, wrong checkpoint
    mkLifecycle('OP4', 'UNRESOLVED', 'CALENDAR_DELETE_CONFIRMED', H(9)),
    mkLifecycle('OP5', 'ACTIVE_POST_EFFECT', 'SLOT_FREED', H(9) + 60000),
    mkLifecycle('OP6', 'RELEASE_PENDING', 'RELEASE_PENDING', H(9) + 120000),
    mkLifecycle('OP7', 'RELEASED', 'RELEASED', H(9) + 180000),
    mkLifecycle('OP8', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', H(9) + 240000), // wrong terminal pair
    mkLifecycle('OP9', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 25, 8))    // outside period
  ]);

  const result = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 2);

  const provenance = result.data.provenance;
  assert.strictEqual(provenance.source, 'B6_LIFECYCLE');
  assert.deepStrictEqual(Array.from(provenance.fields), ['lifecycle_state', 'checkpoint', 'operation_id', 'timestamp']);
  assert.ok(provenance.condition.indexOf("lifecycle_state === 'RESOLVED_CANCEL'") !== -1);
  assert.ok(provenance.condition.indexOf("checkpoint === 'TERMINAL_CANCEL_PROVEN'") !== -1);
  assert.strictEqual(provenance.aggregation, 'COUNT DISTINCT operation_id');
  assert.strictEqual(provenance.semantics, 'HISTORICAL_EVIDENCE');
});

test('M1-C2 — Cancellations: duplicate checkpoint/recovery/release rows for one operation count once', function() {
  reset();
  seedLifecycle([
    mkLifecycle('OP1', 'ACTIVE_PRE_EFFECT', 'OWNERSHIP_ACQUIRED', H(9)),
    mkLifecycle('OP1', 'ACTIVE_POST_EFFECT', 'SLOT_FREED', H(10)),
    mkLifecycle('OP1', 'UNRESOLVED', 'CALENDAR_DELETE_CONFIRMED', H(10) + 60000, { recoveryState: 'RECOVERY_REQUIRED', recoveryCaseId: 'RCV_1' }),
    mkLifecycle('OP1', 'RECOVERY_REQUIRED', 'SLOT_FREED', H(10) + 120000, { recoveryState: 'RECOVERY_REQUIRED', recoveryCaseId: 'RCV_1' }),
    mkLifecycle('OP1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(11)),
    mkLifecycle('OP1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(11) + 5000), // pathological duplicate terminal row
    mkLifecycle('OP1', 'RELEASE_PENDING', 'RELEASE_PENDING', H(11) + 10000),
    mkLifecycle('OP1', 'RELEASED', 'RELEASED', H(11) + 15000)
  ]);

  const result = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 1);
});

test('M1-C3 — Cancellations: start inclusive / end exclusive on the terminal proof timestamp', function() {
  reset();
  seedLifecycle([
    mkLifecycle('AT_START', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', DAY_START_MS),
    mkLifecycle('AT_END', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', DAY_END_MS)
  ]);
  const result = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  assert.strictEqual(result.data.value, 1); // AT_START in, AT_END out
});

test('M1-C4 — Cancellations over a closed past period are provable (append-only journal)', function() {
  reset();
  seedLifecycle([
    mkLifecycle('OLD_OP', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(7, 20, 15))
  ]);
  const result = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', PAST_P);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 1);
});

test('M1-C5 — Cancellations empty journal (headers only) is a VALID ZERO', function() {
  reset();
  seedLifecycle([]);
  const result = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 0);
});

test('M1-C6 — P1: terminal rows without a valid operation_id are unattributable, never counted as operations', function() {
  reset();
  seedLifecycle([
    mkLifecycle('OP1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(10)),
    mkLifecycle('', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(11)),     // no identity
    mkLifecycle('   ', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(12)),  // whitespace identity
    mkLifecycle(undefined, 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(13)) // undefined identity
  ]);
  const result = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 1); // OP1 only — 1 operation = 1 VALID identity
  assert.strictEqual(result.data.provenance.unattributableRows, 3);
  assert.ok(result.data.provenance.identityPolicy.indexOf('operation_id') !== -1);

  // the blank-identity terminal pair must not poison the change metric either
  const changes = sandbox.MetricsService.calculate('OFFICIAL_CHANGES', P);
  assert.strictEqual(changes.ok, true);
  assert.strictEqual(changes.data.value, 0);
  assert.strictEqual(changes.data.provenance.unattributableRows, 0);
});

// ── D — Official Changes ────────────────────────────────────────

test('M1-D1 — Changes: only RESOLVED_CHANGE + TERMINAL_CHANGE_PROVEN count, distinct operations', function() {
  reset();
  seedLifecycle([
    mkLifecycle('CH1', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', H(10), { command: 'CHANGE', newSlotId: 'NEW_1' }),
    mkLifecycle('CH2', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', H(16), { command: 'CHANGE', newSlotId: 'NEW_2' }),
    mkLifecycle('CH3', 'RESOLVED_CHANGE', 'TERMINAL_CANCEL_PROVEN', H(11), { command: 'CHANGE' }), // crossed pair
    mkLifecycle('CH4', 'RESOLVED_CANCEL', 'TERMINAL_CHANGE_PROVEN', H(12), { command: 'CANCEL' }), // crossed pair
    mkLifecycle('CH5', 'UNRESOLVED', 'NEW_SLOT_CONFIRMED', H(13), { command: 'CHANGE' }),
    mkLifecycle('CA1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(14)) // a cancellation is not a change
  ]);

  const result = sandbox.MetricsService.calculate('OFFICIAL_CHANGES', P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 2);
  assert.ok(result.data.provenance.condition.indexOf("lifecycle_state === 'RESOLVED_CHANGE'") !== -1);
  assert.ok(result.data.provenance.condition.indexOf("checkpoint === 'TERMINAL_CHANGE_PROVEN'") !== -1);

  // the crossed cancel-pair row (CH4: RESOLVED_CANCEL + TERMINAL_CHANGE_PROVEN)
  // must NOT leak into the cancellation metric: only the genuine CA1 counts
  const cancels = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  assert.strictEqual(cancels.data.value, 1);
});

// ── E — Completed / No-show (attendance evidence) ───────────────

function seedAttendanceMixed() {
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11)),
    mkAudit('S2', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 25, 10)),          // outside period
    mkAudit('S3', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', H(12)),
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'ALREADY_APPLIED', H(11) + 60000), // not new attendance
    mkAudit('S4', 'MARK_COMPLETED', 'COMPLETED', 'REJECTED_INVALID_TRANSITION', H(10)),
    mkAudit('S5', 'MARK_NO_SHOW', 'NO_SHOW', 'REJECTED_CORRELATION_LOST', H(10) + 30000)
  ]);
}

test('M1-E1 — Completed: only APPLIED rows with to_status COMPLETED count (decision-timestamp basis)', function() {
  reset();
  seedAttendanceMixed();
  const result = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 1);

  const provenance = result.data.provenance;
  assert.strictEqual(provenance.source, 'ATTENDANCE_AUDIT');
  assert.deepStrictEqual(Array.from(provenance.fields), ['outcome', 'to_status', 'timestamp', 'slot_id']);
  assert.ok(provenance.condition.indexOf("outcome === 'APPLIED'") !== -1);
  assert.ok(provenance.condition.indexOf("to_status === 'COMPLETED'") !== -1);
  assert.ok(provenance.condition.indexOf('ATTENDANCE_ACTIVATION_AT') !== -1);
  assert.strictEqual(provenance.aggregation, 'COUNT DISTINCT slot_id');
  // activation = first APPLIED row timestamp (S1 at 11:00 is earliest APPLIED)
  assert.strictEqual(provenance.attendanceActivationAtMs, H(11));
});

test('M1-E2 — No-show: only APPLIED rows with to_status NO_SHOW count', function() {
  reset();
  seedAttendanceMixed();
  const result = sandbox.MetricsService.calculate('NO_SHOW_APPOINTMENTS', P);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 1);
  assert.strictEqual(result.data.provenance.attendanceActivationAtMs, H(11));
});

test('M1-E3 — ALREADY_APPLIED exclusion and duplicate APPLIED rows collapse to distinct slot_id', function() {
  reset();
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11)),
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'ALREADY_APPLIED', H(11) + 60000),
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'ALREADY_APPLIED', H(11) + 120000),
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11) + 180000), // pathological duplicate evidence row
    mkAudit('S2', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(12))
  ]);
  const result = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(result.data.value, 2); // S1 + S2, never 5
});

test('M1-E4 — Activation boundary: ATTENDANCE_ACTIVATION_AT = first APPLIED timestamp; pre-activation evidence excluded', function() {
  reset();
  seedAttendance([
    mkAudit('S0', 'MARK_COMPLETED', 'COMPLETED', 'ALREADY_APPLIED', H(9)),   // before activation, wrong outcome anyway
    mkAudit('S1', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', H(10)),              // FIRST APPLIED → activation
    mkAudit('S2', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11)),
    mkAudit('S3', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(12))
  ]);
  const completed = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(completed.data.provenance.attendanceActivationAtMs, H(10));
  assert.strictEqual(completed.data.value, 2); // S2 + S3

  // a period entirely before activation contains no official attendance
  const beforeActivation = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', {
    start: H(9) - 3600000,
    end: H(10)
  });
  assert.strictEqual(beforeActivation.data.status, 'AVAILABLE');
  assert.strictEqual(beforeActivation.data.value, 0);
});

test('M1-E5 — Attendance not yet activated (no APPLIED rows) is a VALID ZERO with activation null', function() {
  reset();
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'REJECTED_INVALID_TRANSITION', H(11))
  ]);
  const result = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(result.data.status, 'AVAILABLE');
  assert.strictEqual(result.data.value, 0);
  assert.strictEqual(result.data.provenance.attendanceActivationAtMs, null);
});

test('M1-E6 — Attendance evidence over a closed past period is provable (append-only store)', function() {
  reset();
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 20, 15)),
    mkAudit('S2', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(7, 20, 16))
  ]);
  const completed = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', PAST_P);
  assert.strictEqual(completed.data.status, 'AVAILABLE');
  assert.strictEqual(completed.data.value, 1);
  const noShow = sandbox.MetricsService.calculate('NO_SHOW_APPOINTMENTS', PAST_P);
  assert.strictEqual(noShow.data.value, 1);
});

test('M1-E7 — Attendance boundaries: start inclusive / end exclusive on decision timestamp', function() {
  reset();
  seedAttendance([
    mkAudit('AT_START', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', DAY_START_MS),
    mkAudit('AT_END', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', DAY_END_MS)
  ]);
  const result = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(result.data.value, 1);
});

test('M1-E8 — P1: first APPLIED row with unparseable timestamp → METRIC_EVIDENCE_INVALID (boundary never redefined to the next parsable row)', function() {
  reset();
  const corruptFirstApplied = {
    operator_id: 'doctor.test@hamzawe.clinic',
    calendar_event_id: 'EV_S0',
    calendar_id: 'CAL_DEFAULT',
    slot_id: 'S0',
    decision: 'MARK_COMPLETED',
    from_status: 'CONFIRMED',
    to_status: 'COMPLETED',
    outcome: 'APPLIED',
    error_code: '',
    timestamp: 'GARBAGE'
  };
  seedAttendance([
    corruptFirstApplied, // THE first APPLIED row (append order) — corrupt timestamp
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11)),
    mkAudit('S2', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', H(12))
  ]);

  // both attendance metrics are withheld — never recomputed against H(11)
  const completed = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(completed.ok, false);
  assert.strictEqual(completed.data, null);
  assert.strictEqual(completed.error.code, 'METRIC_EVIDENCE_INVALID');
  assert.ok(completed.error.message.indexOf('ATTENDANCE_ACTIVATION_AT') !== -1);
  assert.strictEqual(completed.error.details.rowNumber, 2); // first data row of the sheet

  const noShow = sandbox.MetricsService.calculate('NO_SHOW_APPOINTMENTS', P);
  assert.strictEqual(noShow.ok, false);
  assert.strictEqual(noShow.error.code, 'METRIC_EVIDENCE_INVALID');

  // all-or-nothing batch: healthy metrics in the same batch are withheld too
  seedAvailability([mkSlot('S9', { status: 'CONFIRMED', sortKey: '202608241600', phone: PHONE })]);
  const batch = sandbox.MetricsService.calculateMany(
    ['CONFIRMED_APPOINTMENTS', 'COMPLETED_APPOINTMENTS'], P
  );
  assert.strictEqual(batch.ok, false);
  assert.strictEqual(batch.error.code, 'METRIC_EVIDENCE_INVALID');

  // the ratio combinator propagates the failure instead of dividing an unproven input
  const ratio = sandbox.MetricsService.calculateRatio(
    'COMPLETED_APPOINTMENTS', 'CONFIRMED_APPOINTMENTS', P
  );
  assert.strictEqual(ratio.ok, false);
  assert.strictEqual(ratio.error.code, 'METRIC_EVIDENCE_INVALID');

  // contrast: the SAME corrupt row AFTER a parseable first APPLIED row does
  // not invalidate the boundary — the boundary is the FIRST row, which is
  // intact; the later corrupt row stays unattributable.
  reset();
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11)),
    Object.assign({}, corruptFirstApplied, { slot_id: 'S0B' })
  ]);
  const salvageable = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(salvageable.ok, true);
  assert.strictEqual(salvageable.data.value, 1);
  assert.strictEqual(salvageable.data.provenance.attendanceActivationAtMs, H(11));
  assert.strictEqual(salvageable.data.provenance.unattributableRows, 1);
});

test('M1-E9 — P1: APPLIED rows without a valid slot_id are unattributable, never counted as appointments', function() {
  reset();
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11)),
    mkAudit('', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(12)),      // no identity
    mkAudit('   ', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', H(13))        // whitespace identity
  ]);
  const completed = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(completed.ok, true);
  assert.strictEqual(completed.data.status, 'AVAILABLE');
  assert.strictEqual(completed.data.value, 1); // S1 only — 1 outcome = 1 VALID identity
  assert.strictEqual(completed.data.provenance.unattributableRows, 1);
  assert.ok(completed.data.provenance.identityPolicy.indexOf('slot_id') !== -1);

  const noShow = sandbox.MetricsService.calculate('NO_SHOW_APPOINTMENTS', P);
  assert.strictEqual(noShow.ok, true);
  assert.strictEqual(noShow.data.value, 0);
  assert.strictEqual(noShow.data.provenance.unattributableRows, 1);
  // the activation boundary is the FIRST APPLIED row (S1 at 11:00) — a later
  // identity-invalid row never moves it
  assert.strictEqual(noShow.data.provenance.attendanceActivationAtMs, H(11));
});

// ── F — Failure semantics ───────────────────────────────────────

test('M1-F1 — Availability source failure → METRIC_SOURCE_UNAVAILABLE, never a zero envelope', function() {
  reset();
  seedAvailability([mkSlot('S1', { status: 'CONFIRMED', sortKey: '202608241000', phone: PHONE })]);
  state.failRead['Availability'] = true;
  const result = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  assert.strictEqual(result.ok, false);           // a failed read is a failure, not a value
  assert.strictEqual(result.data, null);
  assert.strictEqual(result.error.code, 'METRIC_SOURCE_UNAVAILABLE');
  assert.strictEqual(result.error.details.source, 'Availability');

  // zero vs unavailable must be impossible to confuse
  reset();
  seedAvailability([]);
  const zero = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  assert.strictEqual(zero.ok, true);
  assert.strictEqual(zero.data.value, 0);
});

test('M1-F2 — Availability sheet absent → METRIC_SOURCE_UNAVAILABLE', function() {
  reset(); // nothing seeded
  const result = sandbox.MetricsService.calculate('BOOKABLE_SLOTS', P);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'METRIC_SOURCE_UNAVAILABLE');
});

test('M1-F3 — B6 lifecycle source failure / absent sheet / schema drift → METRIC_SOURCE_UNAVAILABLE', function() {
  reset();
  // absent sheet
  const absent = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  assert.strictEqual(absent.ok, false);
  assert.strictEqual(absent.error.code, 'METRIC_SOURCE_UNAVAILABLE');
  assert.strictEqual(absent.error.details.error.code, 'B6_LIFECYCLE_READ_FAILED');

  // injected read failure
  seedLifecycle([mkLifecycle('OP1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(11))]);
  state.failRead['B6_LIFECYCLE'] = true;
  const failed = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.error.code, 'METRIC_SOURCE_UNAVAILABLE');

  // schema drift: checkpoint column missing → never a silent false zero
  reset();
  state.sheets['B6_LIFECYCLE'] = {
    headers: sandbox.B6LifecycleRepository.HEADERS.filter(function(h) { return h !== 'checkpoint'; }),
    rows: []
  };
  const drifted = sandbox.MetricsService.calculate('OFFICIAL_CHANGES', P);
  assert.strictEqual(drifted.ok, false);
  assert.strictEqual(drifted.error.code, 'METRIC_SOURCE_UNAVAILABLE');
  assert.strictEqual(drifted.error.details.error.code, 'B6_LIFECYCLE_SCHEMA_INVALID');
});

test('M1-F4 — Attendance audit absent / unreadable / schema-drifted → METRIC_SOURCE_UNAVAILABLE', function() {
  reset();
  // absent store: never an implicit zero (cannot distinguish never-created from deleted)
  const absent = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(absent.ok, false);
  assert.strictEqual(absent.error.code, 'METRIC_SOURCE_UNAVAILABLE');
  assert.strictEqual(absent.error.details.error.code, 'ATTENDANCE_AUDIT_READ_FAILED');

  // injected read failure
  seedAttendance([mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11))]);
  state.failRead['ATTENDANCE_AUDIT'] = true;
  const failed = sandbox.MetricsService.calculate('NO_SHOW_APPOINTMENTS', P);
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.error.code, 'METRIC_SOURCE_UNAVAILABLE');

  // schema drift: outcome column missing
  reset();
  state.sheets['ATTENDANCE_AUDIT'] = {
    headers: sandbox.AttendanceAuditRepository.HEADERS.filter(function(h) { return h !== 'outcome'; }),
    rows: []
  };
  const drifted = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(drifted.ok, false);
  assert.strictEqual(drifted.error.code, 'METRIC_SOURCE_UNAVAILABLE');
  assert.strictEqual(drifted.error.details.error.code, 'ATTENDANCE_AUDIT_SCHEMA_INVALID');
});

test('M1-F5 — Unknown metric rejected with the registry in details', function() {
  reset();
  const result = sandbox.MetricsService.calculate('BOOKING_UTILIZATION', P);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'METRIC_UNKNOWN');
  assert.ok(result.error.details.available.indexOf('CONFIRMED_APPOINTMENTS') !== -1);
});

test('M1-F6 — Malformed periods rejected deterministically (no string parsing, no inverted ranges)', function() {
  reset();
  seedAvailability([]);
  const cases = [
    undefined,
    null,
    { start: H(10) },                               // missing end
    { start: '2026-08-24', end: H(20) },            // string start
    { start: H(20), end: H(10) },                   // inverted
    { start: H(10), end: H(10) },                   // empty range (start must be < end)
    { start: NaN, end: H(20) }
  ];
  cases.forEach(function(period) {
    const result = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', period);
    assert.strictEqual(result.ok, false, 'period must be rejected: ' + JSON.stringify(String(period && period.start)));
    assert.strictEqual(result.error.code, 'METRIC_PERIOD_INVALID');
  });
});

// ── G — Determinism / timezone contract ─────────────────────────

test('M1-G1 — Date-object and epoch-ms period inputs produce identical envelopes', function() {
  reset();
  seedAttendance([mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11))]);

  const byDate = sandbox.MetricsService.calculate(
    'COMPLETED_APPOINTMENTS',
    { start: sandbox.mkVmDate(P.start), end: sandbox.mkVmDate(P.end) }
  );
  const byMs = sandbox.MetricsService.calculate(
    'COMPLETED_APPOINTMENTS',
    { start: P.start, end: P.end }
  );
  assert.deepStrictEqual(stripped(byDate.data), stripped(byMs.data));
});

test('M1-G2 — Uniform boundary interpretation across every metric family', function() {
  reset();
  seedAvailability([
    mkSlot('AT_START', { status: 'CONFIRMED', sortKey: '202608240000', phone: PHONE }),
    mkSlot('AT_END', { status: 'CONFIRMED', sortKey: '202608250000', phone: PHONE })
  ]);
  seedLifecycle([
    mkLifecycle('AT_START', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', DAY_START_MS),
    mkLifecycle('AT_END', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', DAY_END_MS)
  ]);
  seedAttendance([
    mkAudit('AT_START', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', DAY_START_MS),
    mkAudit('AT_END', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', DAY_END_MS)
  ]);

  const confirmed = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  const cancelled = sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  const completed = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(confirmed.data.value, 1);
  assert.strictEqual(cancelled.data.value, 1);
  assert.strictEqual(completed.data.value, 1);
  // one shared interpretation, echoed identically by every family
  assert.deepStrictEqual(
    { s: confirmed.data.period.startMs, e: confirmed.data.period.endMs },
    { s: cancelled.data.period.startMs, e: cancelled.data.period.endMs }
  );
  assert.strictEqual(
    completed.data.provenance.periodSemantics,
    confirmed.data.provenance.periodSemantics
  );
});

// ── H — Zero denominator (ratio combinator) ─────────────────────

test('M1-H1 — Zero denominator → N/A (UNAVAILABLE / ZERO_DENOMINATOR), never 0', function() {
  reset();
  seedAvailability([]); // future period: 0 confirmed, 0 bookable
  const ratio = sandbox.MetricsService.calculateRatio(
    'CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS', FUTURE_P
  );
  assert.strictEqual(ratio.ok, true);
  assert.strictEqual(ratio.data.status, 'UNAVAILABLE');
  assert.strictEqual(ratio.data.value, null);
  assert.strictEqual(ratio.data.reason, 'ZERO_DENOMINATOR');
  assert.ok(ratio.data.provenance.zeroDenominatorPolicy.indexOf('never 0') !== -1);
});

test('M1-H2 — Valid zero numerator over positive denominator is 0; positive/positive is exact', function() {
  reset();
  seedAvailability([
    mkSlot('B1', { status: 'FREE', sortKey: '202609011000' }),
    mkSlot('B2', { status: 'FREE', sortKey: '202609011100' }),
    mkSlot('B3', { status: 'FREE', sortKey: '202609011200' }),
    mkSlot('B4', { status: 'FREE', sortKey: '202609011300' })
  ]);
  const zeroNumerator = sandbox.MetricsService.calculateRatio(
    'CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS', FUTURE_P
  );
  assert.strictEqual(zeroNumerator.data.status, 'AVAILABLE');
  assert.strictEqual(zeroNumerator.data.value, 0);

  reset();
  seedAvailability([
    mkSlot('C1', { status: 'CONFIRMED', sortKey: '202609011000', phone: PHONE }),
    mkSlot('C2', { status: 'CONFIRMED', sortKey: '202609011100', phone: PHONE }),
    mkSlot('B1', { status: 'FREE', sortKey: '202609011200' }),
    mkSlot('B2', { status: 'FREE', sortKey: '202609011300' }),
    mkSlot('B3', { status: 'FREE', sortKey: '202609011400' }),
    mkSlot('B4', { status: 'FREE', sortKey: '202609011500' })
  ]);
  const half = sandbox.MetricsService.calculateRatio(
    'CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS', FUTURE_P
  );
  assert.strictEqual(half.data.status, 'AVAILABLE');
  assert.strictEqual(half.data.value, 0.5);
});

test('M1-H3 — Ratio propagates source failures and DEFERRED snapshot history', function() {
  reset();
  seedAvailability([]);
  state.failRead['Availability'] = true;
  const failed = sandbox.MetricsService.calculateRatio(
    'CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS', FUTURE_P
  );
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.error.code, 'METRIC_SOURCE_UNAVAILABLE');

  reset();
  seedAvailability([mkSlot('OLD', { status: 'CONFIRMED', sortKey: '202608201000', phone: PHONE })]);
  const deferred = sandbox.MetricsService.calculateRatio(
    'CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS', PAST_P
  );
  assert.strictEqual(deferred.ok, true);
  assert.strictEqual(deferred.data.status, 'DEFERRED');
  assert.strictEqual(deferred.data.reason, 'HISTORICAL_NOT_PROVABLE');
  assert.strictEqual(deferred.data.value, null);
});

// ── I — Honesty: unattributable rows ────────────────────────────

test('M1-I1 — Unattributable rows are surfaced in provenance, never guessed into a period', function() {
  reset();
  seedAvailability([
    mkSlot('GOOD', { status: 'CONFIRMED', sortKey: '202608241000', phone: PHONE }),
    mkSlot('GARBAGE_KEY', { status: 'CONFIRMED', sortKey: 'NOT_A_TIME', phone: PHONE }),
    mkSlot('EMPTY_KEY', { status: 'CONFIRMED', sortKey: '', phone: PHONE })
  ]);
  const confirmed = sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  assert.strictEqual(confirmed.data.value, 1);
  assert.strictEqual(confirmed.data.provenance.unattributableRows, 2);

  reset();
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11)),
    { // APPLIED evidence with an unparseable timestamp: excluded + surfaced
      operator_id: 'doctor.test@hamzawe.clinic',
      calendar_event_id: 'EV_S9',
      calendar_id: 'CAL_DEFAULT',
      slot_id: 'S9',
      decision: 'MARK_COMPLETED',
      from_status: 'CONFIRMED',
      to_status: 'COMPLETED',
      outcome: 'APPLIED',
      error_code: '',
      timestamp: 'NOT_A_TIME'
    }
  ]);
  const completed = sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  assert.strictEqual(completed.data.value, 1);
  assert.strictEqual(completed.data.provenance.unattributableRows, 1);
  // activation stays the first time-positioned APPLIED row
  assert.strictEqual(completed.data.provenance.attendanceActivationAtMs, H(11));
});

// ── P — Performance & purity ────────────────────────────────────

test('M1-P1 — calculateMany: exactly ONE read per source, results identical to individual calls', function() {
  reset();
  seedAvailability([
    mkSlot('S1', { status: 'CONFIRMED', sortKey: '202608241600', phone: PHONE }),
    mkSlot('B1', { status: 'FREE', sortKey: '202608241700' })
  ]);
  seedLifecycle([
    mkLifecycle('OP1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(10)),
    mkLifecycle('CH1', 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', H(11), { command: 'CHANGE' })
  ]);
  seedAttendance([
    mkAudit('A1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(12)),
    mkAudit('A2', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', H(12) + 60000)
  ]);

  const names = [
    'CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS', 'OFFICIAL_CANCELLATIONS',
    'OFFICIAL_CHANGES', 'COMPLETED_APPOINTMENTS', 'NO_SHOW_APPOINTMENTS'
  ];
  const batch = sandbox.MetricsService.calculateMany(names, P);
  assert.strictEqual(batch.ok, true);

  assert.strictEqual(state.queryCalls['Availability'], 1);
  assert.strictEqual(state.queryCalls['B6_LIFECYCLE'], 1);
  assert.strictEqual(state.queryCalls['ATTENDANCE_AUDIT'], 1);

  names.forEach(function(name) {
    const single = sandbox.MetricsService.calculate(name, P);
    assert.strictEqual(single.ok, true, name);
    assert.deepStrictEqual(stripped(single.data), stripped(batch.data.results[name]), name);
  });

  // same period echoed once
  assert.strictEqual(batch.data.period.startMs, P.start);
  assert.strictEqual(batch.data.period.endMs, P.end);
});

test('M1-P2 — calculateMany fails fast (no partial batches) and validates every name first', function() {
  reset();
  seedAvailability([]);
  seedLifecycle([]);
  seedAttendance([]);

  const unknown = sandbox.MetricsService.calculateMany(
    ['CONFIRMED_APPOINTMENTS', 'NOT_A_METRIC'], P
  );
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.error.code, 'METRIC_UNKNOWN');
  assert.strictEqual(state.queryCalls['Availability'] || 0, 0); // nothing read

  state.failRead['B6_LIFECYCLE'] = true;
  const partial = sandbox.MetricsService.calculateMany(
    ['CONFIRMED_APPOINTMENTS', 'OFFICIAL_CANCELLATIONS'], P
  );
  assert.strictEqual(partial.ok, false);
  assert.strictEqual(partial.error.code, 'METRIC_SOURCE_UNAVAILABLE');
  assert.strictEqual(partial.error.details.metric, 'OFFICIAL_CANCELLATIONS');

  const empty = sandbox.MetricsService.calculateMany([], P);
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.error.code, 'METRIC_REQUEST_INVALID');
});

test('M1-P3 — Metrics are side-effect free: zero writes, zero sheet creation, no locks', function() {
  reset();
  seedAvailability([mkSlot('S1', { status: 'CONFIRMED', sortKey: '202608241600', phone: PHONE })]);
  seedLifecycle([mkLifecycle('OP1', 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', H(10))]);
  seedAttendance([mkAudit('A1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', H(11))]);

  // The GoogleSheets seam THROWS on any mutation; if any call below
  // mutated storage the test would fail with M1_METRICS_MUST_NOT_*.
  sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', P);
  sandbox.MetricsService.calculate('BOOKABLE_SLOTS', P);
  sandbox.MetricsService.calculate('OFFICIAL_CANCELLATIONS', P);
  sandbox.MetricsService.calculate('OFFICIAL_CHANGES', P);
  sandbox.MetricsService.calculate('COMPLETED_APPOINTMENTS', P);
  sandbox.MetricsService.calculate('NO_SHOW_APPOINTMENTS', P);
  sandbox.MetricsService.calculate('CONFIRMED_APPOINTMENTS', PAST_P); // DEFERRED path
  sandbox.MetricsService.calculateMany(
    ['CONFIRMED_APPOINTMENTS', 'OFFICIAL_CANCELLATIONS', 'COMPLETED_APPOINTMENTS'], P
  );
  sandbox.MetricsService.calculateRatio('CONFIRMED_APPOINTMENTS', 'BOOKABLE_SLOTS', P);

  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.sheetCreates, 0);
});

// ── S — Structural boundaries ───────────────────────────────────

test('M1-S1 — Structural: MetricsService stays in the Application layer with Clock as its only time source', function() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'Application/MetricsService.js'), 'utf8'));

  ['SpreadsheetApp', 'CalendarApp', 'UrlFetchApp', 'new Date(', 'LockService',
   'PropertiesService', 'LogRepository', 'SYSTEM_LOG'].forEach(function(forbidden) {
    assert.strictEqual(src.indexOf(forbidden), -1, 'MetricsService must not reference ' + forbidden);
  });

  assert.ok(src.indexOf('Clock.now()') !== -1, 'MetricsService must use Clock.now()');
  assert.ok(src.indexOf('SlotRepository.queryResult') !== -1);
  assert.ok(src.indexOf('B6LifecycleRepository.queryResult') !== -1);
  assert.ok(src.indexOf('AttendanceAuditReadRepository.readAll') !== -1);
  // frozen contract anchors
  assert.ok(src.indexOf("'APPLIED'") !== -1);
  assert.ok(src.indexOf('HISTORICAL_NOT_PROVABLE') !== -1);
  assert.ok(src.indexOf('ZERO_DENOMINATOR') !== -1);
  // P1 remediation anchors: activation = FIRST APPLIED row (never "first
  // parsable"); identity validation before DISTINCT counting
  assert.ok(src.indexOf('METRIC_EVIDENCE_INVALID') !== -1);
  assert.ok(src.indexOf('_rowOrder') !== -1);
  assert.ok(src.indexOf('_hasIdentity') !== -1);
});

test('M1-S2 — Structural: attendance read boundary is read-only; the append-only writer is untouched', function() {
  // the M0 append-only write contract keeps exactly its original surface
  assert.deepStrictEqual(
    Object.keys(sandbox.AttendanceAuditRepository).filter(function(k) { return k.charAt(0) !== '_'; }),
    ['SHEET_NAME', 'HEADERS', 'ensureStore', 'append']
  );

  const readSrc = stripComments(
    fs.readFileSync(path.join(ROOT, 'Repositories/AttendanceAuditReadRepository.js'), 'utf8')
  );
  ['appendRow', 'appendRows', 'updateRowByColumn', 'updateBatch', 'deleteRowsByNumbers',
   'getOrCreateSheet', 'ensureStore'].forEach(function(forbidden) {
    assert.strictEqual(readSrc.indexOf(forbidden), -1, 'attendance read boundary must be read-only: ' + forbidden);
  });
  assert.ok(readSrc.indexOf('GoogleSheets.getHeaders') !== -1);
  assert.ok(readSrc.indexOf('GoogleSheets.queryRows') !== -1);

  // B6 repository: original public API + exactly one new M1 read boundary
  assert.deepStrictEqual(
    Object.keys(sandbox.B6LifecycleRepository).filter(function(k) { return k.charAt(0) !== '_'; }),
    ['SHEET_NAME', 'HEADERS', 'ensureStore', 'appendCheckpoint', 'findByOperationId',
     'findByPhone', 'findByRecoveryCaseId', 'latestByOperationId', 'latestByPhone',
     'latestByRecoveryCaseId', 'queryResult']
  );

  // Config and StateMachine untouched by M1
  const configSrc = fs.readFileSync(path.join(ROOT, 'Config.js'), 'utf8');
  const smSrc = fs.readFileSync(path.join(ROOT, 'StateMachine.js'), 'utf8');
  assert.strictEqual(configSrc.indexOf('METRIC'), -1);
  assert.strictEqual(smSrc.indexOf('METRIC'), -1);
});

test('M1-S3 — File-evaluation order independence (clasp alphabetical order: MetricsService before Config)', function() {
  // Reproduces the Apps Script V8 evaluation order for the M1 files:
  // Application/* evaluate BEFORE Config.js, and
  // Repositories/AttendanceAuditReadRepository.js evaluates BEFORE
  // Repositories/AttendanceAuditRepository.js. Every cross-module
  // reference in the metrics foundation must resolve at CALL time.
  const sb = vm.createContext({ console: console });
  sb.Clock = { now: function() { return new Date(NOW_MS); } };
  sb.GoogleSheets = {
    getHeaders: function() { return sb.AttendanceAuditReadRepository ? [] : []; },
    queryRows: function() { throw new Error('NOT_USED'); }
  };

  const alphabetical = [
    ['Application/B6LifecycleService.js', 'B6LifecycleService'],
    ['Application/MetricsService.js', 'MetricsService'],
    ['Config.js', 'Config'],
    ['Repositories/AttendanceAuditReadRepository.js', 'AttendanceAuditReadRepository'],
    ['Repositories/AttendanceAuditRepository.js', 'AttendanceAuditRepository'],
    ['Repositories/B6LifecycleRepository.js', 'B6LifecycleRepository'],
    ['Result.js', 'Result'],
    ['Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser']
  ];
  alphabetical.forEach(function(entry) {
    const source = fs.readFileSync(path.join(ROOT, entry[0]), 'utf8');
    vm.runInContext(source + '\nthis.' + entry[1] + ' = ' + entry[1] + ';', sb, { filename: entry[0] });
  });

  // The definition registry resolves with Config already bound LATER:
  // the availability status vocabulary resolves at call time.
  const def = sb.MetricsService._definition('CONFIRMED_APPOINTMENTS');
  assert.strictEqual(def.ok, true);
  assert.strictEqual(def.data.source, 'Availability');

  // Period canonicalization is independent of every external binding.
  const period = sb.MetricsService._canonicalPeriod({ start: P.start, end: P.end });
  assert.strictEqual(period.ok, true);
  assert.strictEqual(period.data.startMs, P.start);

  const unknown = sb.MetricsService._definition('NOPE');
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.error.code, 'METRIC_UNKNOWN');
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
