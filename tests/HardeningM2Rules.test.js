'use strict';

/**
 * HardeningM2Rules.test.js — M2 (PHASE 1.6 — RULE / INSIGHT)
 *
 * Proves the FROZEN M2-RULE-INSIGHT-v1 contract:
 *   1  — Rules consume RateFoundationService output ONLY (no raw
 *        repository re-derivation); foundation validity flows
 *        verbatim (AVAILABLE / UNAVAILABLE / ZERO_DENOMINATOR /
 *        RATE_EVIDENCE_INVALID / RATE_SOURCE_UNAVAILABLE)
 *   2  — Minimum sample (MINIMUM_COHORT = 10, approved): value stays
 *        reported, severity withheld (INSUFFICIENT_SAMPLE)
 *   3  — Threshold governance: NO approved values exist →
 *        RULE_NOT_CONFIGURED (never a default / magic number);
 *        the data-driven band mechanism is proven with SYNTHETIC
 *        TEST-ONLY policies (threshold transitions, polarity)
 *   4  — Four separate metric rules with direction metadata
 *        (ABOVE for cancellation/change/no-show, BELOW for completion)
 *   5  — Trend engine (separate from absolute evaluation):
 *        TREND_UP / FLAT / DOWN, unavailable previous period,
 *        deterministic previous-period derivation
 *   6  — Combined insights from reliable inputs only (no causal /
 *        no blame / no patient-specific / no automatic action)
 *   7  — Confidence determinism (invalid → null, insufficient → LOW,
 *        comparison unavailable → MEDIUM)
 *   8  — Provenance preservation (numerator / denominator / period /
 *        evaluatedAt / asOfMs / sources / foundation status+reason)
 *   9  — Read-only architecture: read-once per source, no writes,
 *        no locks, no sheet creation, no direct repository access
 *
 * Mandatory matrix coverage (v1 §48) — every listed cell is a test:
 *   AVAILABLE rate ................................ M2R-02
 *   UNAVAILABLE rate ................................ M2R-03
 *   ZERO_DENOMINATOR .............................. M2R-04, M2R-06
 *   RATE_EVIDENCE_INVALID .......................... M2R-03
 *   RATE_SOURCE_UNAVAILABLE ........................ M2R-05
 *   cohort = 0 .................................... M2R-06
 *   cohort < 10 ................................... M2R-07
 *   cohort = 10 ................................... M2R-08
 *   cohort > 10 ................................... M2R-09
 *   exactly at threshold ........................... M2R-10
 *   just below threshold ........................... M2R-11
 *   just above threshold ........................... M2R-12
 *   each severity transition ....................... M2R-13, M2R-21
 *   cancellation rule ............................. M2R-14
 *   change rule ................................... M2R-15
 *   completion rule ............................... M2R-16
 *   no-show rule .................................. M2R-17
 *   high cancellation ............................. M2R-18
 *   high change ................................... M2R-19
 *   high no-show .................................. M2R-20
 *   high completion ............................... M2R-21
 *   current > previous ............................ M2R-22
 *   current = previous ............................ M2R-23
 *   current < previous ............................ M2R-24
 *   unavailable previous period ................... M2R-25
 *   cancellation + no-show ........................ M2R-26
 *   cancellation + change .......................... M2R-27
 *   multiple elevated metrics ...................... M2R-28
 *   no causal inference ........................... M2R-30
 *   no blame inference ............................ M2R-31
 *   no automatic action ........................... M2R-32
 *   no patient-specific recommendation ............ M2R-33
 *   no individual-facing action ................... M2R-34
 *   numerator preserved ........................... M2R-35
 *   denominator preserved ......................... M2R-36
 *   period preserved .............................. M2R-37
 *   evaluatedAt preserved .......................... M2R-38
 *   asOfMs + source/provenance preserved .......... M2R-39
 *   read-only ..................................... M2R-40, M2R-43
 *   no locks ...................................... M2R-40, M2R-41
 *   no sheet creation ............................. M2R-40, M2R-42
 *   no repository writes .......................... M2R-41, M2R-44
 *   batch independence ............................ M2R-49
 *   determinism ................................... M2R-48
 *   Rule layer never touches raw repositories ..... M2R-45
 *   RULE_NOT_CONFIGURED (no approved values) ...... M2R-01
 *   insight completeness .......................... M2R-50
 *   ForReport period delegation ................... M2R-46
 *   period validation ............................. M2R-47
 *   policy cannot override frozen MINIMUM_COHORT .. M2R-51 (supervisor P1)
 *   provenance completeness full-surface gate ..... M2R-52 (supervisor P2)
 *
 * THRESHOLD FIXTURE NOTICE (contract §10, §50):
 *   No approved threshold values exist in Config or Contract. The
 *   production policy store in RateRuleService is EMPTY and M2R-01
 *   proves the live behavior (RULE_NOT_CONFIGURED). TEST_POLICIES
 *   below are SYNTHETIC TEST FIXTURES ONLY — they exercise the
 *   generic, data-driven band mechanism (direction, inclusivity,
 *   severity transitions). They are NOT approved business values and
 *   are never written into the production store outside a test.
 *
 * Grid discipline (mirrors M2 Foundation tests): the sandbox's
 * sort_key parser and the test periods share ONE host-local wall grid,
 * simulating the production invariant (appsscript.json pins the script
 * timezone to the clinic timezone). ReportPeriod (pure +03:00
 * arithmetic) is tested for delegation, not grid equality.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';
const SERVICE_PATH = path.join(ROOT, 'Application', 'RateRuleService.js');

// ── Deterministic time anchors (host-local wall grid) ────────────
const NOW_DATE = new Date(2026, 7, 24, 12, 0);            // 2026-08-24 12:00
const NOW_MS = NOW_DATE.getTime();

function D(month0, day, hour, minute) {
  return new Date(2026, month0, day, hour || 0, minute || 0).getTime();
}

function dayPeriod(month0, day) {
  return { start: D(month0, day, 0), end: D(month0, day + 1, 0) };
}

function sortKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes());
}

function createRulesSandbox() {
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

  // Read paths faithful to production; every mutation path FAILS the
  // test if the rule layer ever touches it (the rule layer must be
  // pure reads through the foundation).
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
      throw new Error('M2_RULES_MUST_NOT_CREATE_SHEETS: ' + name);
    },
    appendRow: function(name) {
      state.writes += 1;
      throw new Error('M2_RULES_MUST_NOT_WRITE: appendRow ' + name);
    },
    appendRows: function(name) {
      state.writes += 1;
      throw new Error('M2_RULES_MUST_NOT_WRITE: appendRows ' + name);
    },
    updateRowByColumn: function(name) {
      state.writes += 1;
      throw new Error('M2_RULES_MUST_NOT_WRITE: updateRowByColumn ' + name);
    },
    updateBatch: function(name) {
      state.writes += 1;
      throw new Error('M2_RULES_MUST_NOT_WRITE: updateBatch ' + name);
    },
    deleteRowsByNumbers: function(name) {
      state.writes += 1;
      throw new Error('M2_RULES_MUST_NOT_WRITE: deleteRowsByNumbers ' + name);
    }
  };

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
  load('Application/RateRuleService.js', 'RateRuleService');

  return { sandbox: sandbox, state: state };
}

const core = createRulesSandbox();
const sandbox = core.sandbox;
const state = core.state;
const RRS = sandbox.RateRuleService;

// ── Sheet seeding helpers (same shapes as the M2 Foundation tests) ─

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

function seedAvailability(rows) {
  state.sheets['Availability'] = { headers: AV_HEADERS.slice(), rows: rows || [] };
}
function seedLifecycle(rows) {
  state.sheets['B6_LIFECYCLE'] = {
    headers: sandbox.B6LifecycleRepository.HEADERS.slice(),
    rows: rows || []
  };
}
function seedAttendance(rows) {
  state.sheets['ATTENDANCE_AUDIT'] = {
    headers: sandbox.AttendanceAuditRepository.HEADERS.slice(),
    rows: rows || []
  };
}

/**
 * Seeds one appointment day with an EXACT episode mix:
 *   spec = { live, cancelled, changed, completed, noShow }
 * Every count maps 1:1 to one provable episode (see M2 Foundation):
 *   cancelled → FREE slot + RESOLVED_CANCEL terminal op
 *   changed   → FREE slot + RESOLVED_CHANGE terminal op (the
 *               new_slot_id reference points OUTSIDE Availability —
 *               reference-only, so it never adds an episode)
 *   completed → COMPLETED slot + one APPLIED row (12:00)
 *   noShow    → NO_SHOW slot + one APPLIED row (12:00)
 *   live      → CONFIRMED slot
 * cohort = live + cancelled + changed + completed + noShow
 * Seeds the sheets directly (a standalone call is a complete state).
 * Tests that append manual rows re-seed with the extended arrays.
 */
function seedDay(month0, day, spec) {
  spec = spec || {};
  const slots = [];
  const lc = [];
  const att = [];
  let n = 0;
  let hour = 8;
  function nid(prefix) { n += 1; return prefix + 'D' + day + 'N' + n; }
  function nextHour() { hour += 1; if (hour > 22) hour = 9; return hour; }

  let i, id;
  for (i = 0; i < (spec.cancelled || 0); i++) {
    id = nid('C');
    slots.push(mkSlot(id, { status: 'FREE', sortKey: sortKeyOf(D(month0, day, nextHour(), 0)) }));
    lc.push(mkLifecycle('OPC_' + id, 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN',
      D(month0, day - 1, 9, 0), { oldSlotId: id }));
  }
  for (i = 0; i < (spec.changed || 0); i++) {
    id = nid('H');
    slots.push(mkSlot(id, { status: 'FREE', sortKey: sortKeyOf(D(month0, day, nextHour(), 0)) }));
    lc.push(mkLifecycle('OPH_' + id, 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN',
      D(month0, day - 1, 10, 0), { oldSlotId: id, newSlotId: 'NEWREPL_' + id }));
  }
  for (i = 0; i < (spec.completed || 0); i++) {
    id = nid('M');
    slots.push(mkSlot(id, { status: 'COMPLETED', sortKey: sortKeyOf(D(month0, day, nextHour(), 0)), phone: PHONE }));
    att.push(mkAudit(id, 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(month0, day, 12, 0)));
  }
  for (i = 0; i < (spec.noShow || 0); i++) {
    id = nid('N');
    slots.push(mkSlot(id, { status: 'NO_SHOW', sortKey: sortKeyOf(D(month0, day, nextHour(), 0)), phone: PHONE }));
    att.push(mkAudit(id, 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(month0, day, 12, 0)));
  }
  for (i = 0; i < (spec.live || 0); i++) {
    id = nid('L');
    slots.push(mkSlot(id, { status: 'CONFIRMED', sortKey: sortKeyOf(D(month0, day, nextHour(), 0)), phone: PHONE }));
  }
  seedAvailability(slots);
  seedLifecycle(lc);
  seedAttendance(att);
  return { slots: slots, lc: lc, att: att };
}

/** Seeds BOTH the current day and the previous day (for trend). */
function seedTwoDays(prevSpec, curSpec) {
  const prev = seedDay(7, 9, prevSpec);
  const cur = seedDay(7, 10, curSpec);
  seedAvailability(prev.slots.concat(cur.slots));
  seedLifecycle(prev.lc.concat(cur.lc));
  seedAttendance(prev.att.concat(cur.att));
}

function seedEmptySources() {
  seedAvailability([]);
  seedLifecycle([]);
  seedAttendance([]);
}

// ── Synthetic threshold policies — TEST FIXTURES ONLY ────────────
// (Contract §10/§50: no approved values exist; production store stays
// EMPTY. These fixtures prove the generic data-driven mechanism.)
const TEST_POLICIES = {
  CANCEL: {
    thresholdId: 'TEST-CANCEL', metric: 'CANCELLATION_RATE', direction: 'ABOVE', minimumSample: 10,
    thresholds: [
      { threshold: 5, severity: 'WATCH' },
      { threshold: 10, severity: 'HIGH' },
      { threshold: 15, severity: 'CRITICAL' }
    ]
  },
  CHANGE: {
    thresholdId: 'TEST-CHANGE', metric: 'CHANGE_RATE', direction: 'ABOVE', minimumSample: 10,
    thresholds: [
      { threshold: 5, severity: 'WATCH' },
      { threshold: 10, severity: 'HIGH' },
      { threshold: 15, severity: 'CRITICAL' }
    ]
  },
  COMPLETION: {
    thresholdId: 'TEST-COMPLETION', metric: 'COMPLETION_RATE', direction: 'BELOW', minimumSample: 10,
    thresholds: [
      { threshold: 70, severity: 'WATCH' },
      { threshold: 50, severity: 'HIGH' },
      { threshold: 30, severity: 'CRITICAL' }
    ]
  },
  NOSHOW: {
    thresholdId: 'TEST-NOSHOW', metric: 'NO_SHOW_RATE', direction: 'ABOVE', minimumSample: 10,
    thresholds: [
      { threshold: 5, severity: 'WATCH' },
      { threshold: 10, severity: 'HIGH' },
      { threshold: 15, severity: 'CRITICAL' }
    ]
  }
};

function setPolicies() {
  const names = Array.prototype.slice.call(arguments);
  sandbox.RateRuleService.THRESHOLD_POLICY.policies = names.map(function(nm) {
    return JSON.parse(JSON.stringify(TEST_POLICIES[nm]));
  });
}

function reset() {
  state.nowMs = NOW_MS;
  state.sheets = {};
  state.failRead = {};
  state.queryCalls = {};
  state.headerCalls = {};
  state.writes = 0;
  state.sheetCreates = 0;
  sandbox.RateRuleService.THRESHOLD_POLICY.policies = [];
}

// ── Realm-safe deep compare helpers ──────────────────────────────
// (vm-realm objects carry a different prototype; rebuild host-side)

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

function dataOf(result) {
  assert.strictEqual(result.ok, true, 'call failed: ' +
    (result.error ? result.error.code + ' ' + result.error.message : ''));
  return result.data;
}

function rulesOf(result) {
  return dataOf(result).rules;
}

function insightOf(data, metric) {
  const found = data.insights.filter(function(i) { return i.metric === metric; });
  assert.strictEqual(found.length, 1, 'exactly one insight for ' + metric);
  return found[0];
}

const RATES = ['CANCELLATION_RATE', 'CHANGE_RATE', 'COMPLETION_RATE', 'NO_SHOW_RATE'];

// ═══════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ── 1 — Foundation integration + threshold governance ────────────

test('M2R-01 — No approved threshold values → RULE_NOT_CONFIGURED (live production behavior)', function() {
  reset();
  setPolicies(); // explicitly empty production store
  seedDay(7, 10, { noShow: 3, live: 9 }); // cohort 12, no-show 25%

  const res = RRS.evaluateRules(dayPeriod(7, 10));
  const r = rulesOf(res).NO_SHOW_RATE;

  assert.strictEqual(r.status, 'NOT_EVALUABLE');
  assert.strictEqual(r.reason, 'RULE_NOT_CONFIGURED');
  assert.strictEqual(r.severity, null);
  // The value is KNOWN and stays reported — only classification is withheld
  assert.strictEqual(r.value, 25);
  assert.strictEqual(r.numerator, 3);
  assert.strictEqual(r.denominator, 12);
  // Confidence in the MEASUREMENT still applies (valid evidence, no trend)
  assert.strictEqual(r.confidence, 'HIGH');
  assert.strictEqual(res.data.thresholdPolicy.configuredMetrics.length, 0);
  assert.ok(res.data.thresholdPolicy.source.indexOf('no approved threshold values') !== -1);
});

test('M2R-02 — AVAILABLE foundation + approved policy → EVALUATED', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 1, live: 19 }); // cohort 20, cancel 5%

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(r.status, 'EVALUATED');
  assert.strictEqual(r.severity, 'WATCH');
  assert.strictEqual(r.reason, null);
  assert.strictEqual(r.value, 5);
  assert.strictEqual(r.threshold, 5);
  assert.strictEqual(r.thresholdId, 'TEST-CANCEL');
  assert.strictEqual(r.confidence, 'HIGH');
});

test('M2R-03 — UNAVAILABLE foundation (RATE_EVIDENCE_INVALID) → all four rules NOT_EVALUABLE', function() {
  reset();
  setPolicies('CANCEL', 'CHANGE', 'COMPLETION', 'NOSHOW');
  // K2: APPLIED COMPLETED + APPLIED NO_SHOW for one in-period slot
  seedAvailability([
    mkSlot('S1', { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 10, 9, 0)), phone: PHONE })
  ].concat(seedDay(7, 10, { live: 9 }).slots));
  seedLifecycle([]);
  seedAttendance([
    mkAudit('S1', 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 10, 12, 0)),
    mkAudit('S1', 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(7, 10, 13, 0))
  ]);

  const res = RRS.evaluateRules(dayPeriod(7, 10));
  assert.strictEqual(res.ok, true, 'an in-period evidence conflict is an honest NOT_EVALUABLE result, not a call failure');
  RATES.forEach(function(name) {
    const r = res.data.rules[name];
    assert.strictEqual(r.status, 'NOT_EVALUABLE', name);
    assert.strictEqual(r.reason, 'RATE_EVIDENCE_INVALID', name);
    assert.strictEqual(r.severity, null, name);
    assert.strictEqual(r.value, null, name);
    assert.strictEqual(r.confidence, null, name + ' — invalid evidence is never covered by LOW');
    // S1's final episode is UNPROVABLE (conflicting terminal evidence) →
    // it proves 0 episodes; cohort = the 9 live slots. The rates are
    // UNAVAILABLE anyway (in-period conflict) — the rule layer preserves
    // the foundation denominator verbatim.
    assert.strictEqual(r.denominator, 9, name);
  });
});

test('M2R-04 — ZERO_DENOMINATOR foundation → NOT_EVALUABLE (never 0%, never severity)', function() {
  reset();
  setPolicies('CANCEL', 'CHANGE', 'COMPLETION', 'NOSHOW');
  seedEmptySources();

  const res = RRS.evaluateRules(dayPeriod(7, 10));
  RATES.forEach(function(name) {
    const r = res.data.rules[name];
    assert.strictEqual(r.status, 'NOT_EVALUABLE');
    assert.strictEqual(r.reason, 'ZERO_DENOMINATOR');
    assert.strictEqual(r.value, null);
    assert.strictEqual(r.numerator, 0);
    assert.strictEqual(r.denominator, 0);
    assert.strictEqual(r.severity, null);
  });
});

test('M2R-05 — RATE_SOURCE_UNAVAILABLE fails the WHOLE rule batch (shared source, no partial)', function() {
  reset();
  setPolicies('CANCEL');
  seedEmptySources();
  state.failRead['Availability'] = true;

  const rulesRes = RRS.evaluateRules(dayPeriod(7, 10));
  assert.strictEqual(rulesRes.ok, false);
  assert.strictEqual(rulesRes.error.code, 'RATE_SOURCE_UNAVAILABLE');
  assert.strictEqual(rulesRes.error.details.source, 'Availability');

  const insightsRes = RRS.generateInsights(dayPeriod(7, 10));
  assert.strictEqual(insightsRes.ok, false, 'insights must not expose a partial-healthy set');
  assert.strictEqual(insightsRes.error.code, 'RATE_SOURCE_UNAVAILABLE');
});

// ── 2 — Minimum sample (MINIMUM_COHORT = 10, approved) ───────────

test('M2R-06 — cohort = 0 → NOT_EVALUABLE / ZERO_DENOMINATOR (sample floor is a floor, not a zero)', function() {
  reset();
  setPolicies('CANCEL');
  seedAvailability([]);
  seedLifecycle([]);
  seedAttendance([]);

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(r.status, 'NOT_EVALUABLE');
  assert.strictEqual(r.reason, 'ZERO_DENOMINATOR');
  assert.notStrictEqual(r.reason, 'INSUFFICIENT_SAMPLE', 'zero cohort is foundation ZERO_DENOMINATOR, not a sample classification');
  assert.strictEqual(r.value, null);
});

test('M2R-07 — cohort < 10: value stays 20% but ruleStatus = INSUFFICIENT_SAMPLE (contract §7 example)', function() {
  reset();
  setPolicies('NOSHOW');
  seedDay(7, 10, { noShow: 1, live: 4 }); // cohort 5, no-show 20%

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  const r = data.rules.NO_SHOW_RATE;
  assert.strictEqual(r.status, 'INSUFFICIENT_SAMPLE');
  assert.strictEqual(r.reason, 'INSUFFICIENT_SAMPLE');
  assert.strictEqual(r.value, 20, 'the rate itself stays reported');
  assert.strictEqual(r.numerator, 1);
  assert.strictEqual(r.denominator, 5);
  assert.strictEqual(r.severity, null, 'no severity — not HIGH, not CRITICAL, not UNAVAILABLE');
  assert.strictEqual(r.confidence, 'LOW', 'small sample → LOW, deterministic');
  const ins = insightOf(data, 'NO_SHOW_RATE');
  assert.strictEqual(ins.explanation,
    'معدل عدم الحضور (20%) محسوب على عينة من 5 appointment episode، أقل من الحد الأدنى المعتمد (10) — لا يُصنَّف severity.');
  assert.strictEqual(ins.recommendation,
    'متابعة العينة في الفترات القادمة قبل تصنيف الحد.');
});

test('M2R-08 — cohort = 10 exactly: the sample gate PASSES (boundary is >=, not >)', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 1, live: 9 }); // cohort 10, cancel 10%

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(r.status, 'EVALUATED', 'denominator 10 is sufficient');
  assert.strictEqual(r.severity, 'HIGH', '10% hits the HIGH band of the test fixture');
});

test('M2R-09 — cohort > 10: full evaluation', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 2, live: 10 }); // cohort 12, cancel 16.67%

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(r.status, 'EVALUATED');
  assert.strictEqual(r.severity, 'CRITICAL', '16.67% >= 15 band');
  assert.strictEqual(r.denominator, 12);
});

// ── 3 — Threshold band mechanics (synthetic test policies) ───────

test('M2R-10 — Exactly AT threshold belongs to the band (inclusive)', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 1, live: 9 }); // exactly 10%

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(r.severity, 'HIGH', '10% is exactly the HIGH band — not WATCH, not NORMAL');
  assert.strictEqual(r.threshold, 10);
});

test('M2R-11 — Just BELOW threshold: previous band', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 9, live: 91 }); // 9% — just below HIGH@10

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(r.severity, 'WATCH');
});

test('M2R-12 — Just ABOVE threshold: next band', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 11, live: 89 }); // 11% — just above HIGH@10

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(r.severity, 'HIGH');
});

test('M2R-13 — Every severity transition (ABOVE policy): NORMAL→WATCH→HIGH→CRITICAL', function() {
  const cases = [
    { cancelled: 4, expected: 'NORMAL', label: '4% below WATCH@5' },
    { cancelled: 5, expected: 'WATCH', label: '5% at WATCH' },
    { cancelled: 9, expected: 'WATCH', label: '9% in WATCH' },
    { cancelled: 10, expected: 'HIGH', label: '10% at HIGH' },
    { cancelled: 14, expected: 'HIGH', label: '14% in HIGH' },
    { cancelled: 15, expected: 'CRITICAL', label: '15% at CRITICAL' }
  ];
  cases.forEach(function(c) {
    reset();
    setPolicies('CANCEL');
    seedDay(7, 10, { cancelled: c.cancelled, live: 100 - c.cancelled }); // cohort 100
    const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
    assert.strictEqual(r.status, 'EVALUATED', c.label);
    assert.strictEqual(r.severity, c.expected, c.label + ' (value ' + r.value + '%)');
  });
});

// ── 4 — Four separate metric rules + polarity ────────────────────

test('M2R-14 — Cancellation rule: separate rule, own metadata, own result', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 4, live: 16 }); // 20%

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(r.ruleId, 'RULE-CANCELLATION');
  assert.strictEqual(r.metric, 'CANCELLATION_RATE');
  assert.strictEqual(r.direction, 'ABOVE');
  assert.strictEqual(r.status, 'EVALUATED');
  assert.strictEqual(r.severity, 'CRITICAL');
  assert.strictEqual(r.value, 20);
  assert.ok(r.period && r.period.startMs === D(7, 10, 0));
});

test('M2R-15 — Change rule: separate rule, own metadata, own result', function() {
  reset();
  setPolicies('CHANGE');
  seedDay(7, 10, { changed: 4, live: 16 }); // 20%

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CHANGE_RATE;
  assert.strictEqual(r.ruleId, 'RULE-CHANGE');
  assert.strictEqual(r.metric, 'CHANGE_RATE');
  assert.strictEqual(r.direction, 'ABOVE');
  assert.strictEqual(r.severity, 'CRITICAL');
  assert.strictEqual(r.value, 20);
});

test('M2R-16 — Completion rule: BELOW direction (falling = worse)', function() {
  reset();
  setPolicies('COMPLETION');
  seedDay(7, 10, { completed: 4, live: 16 }); // completion 20%

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).COMPLETION_RATE;
  assert.strictEqual(r.ruleId, 'RULE-COMPLETION');
  assert.strictEqual(r.direction, 'BELOW', 'direction is rule metadata, never a hardcoded polarity');
  assert.strictEqual(r.severity, 'CRITICAL', '20% <= 30 band (BELOW)');
  assert.strictEqual(r.value, 20);
});

test('M2R-17 — No-show rule: separate rule, own metadata, own result', function() {
  reset();
  setPolicies('NOSHOW');
  seedDay(7, 10, { noShow: 4, live: 16 }); // 20%

  const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).NO_SHOW_RATE;
  assert.strictEqual(r.ruleId, 'RULE-NO_SHOW');
  assert.strictEqual(r.direction, 'ABOVE');
  assert.strictEqual(r.severity, 'CRITICAL');
});

test('M2R-18 — High cancellation: exact explanation + recommendation (whitelisted text)', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 4, live: 16 }); // 20% → CRITICAL

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.rules.CANCELLATION_RATE.severity, 'CRITICAL');
  const ins = insightOf(data, 'CANCELLATION_RATE');
  assert.strictEqual(ins.explanation,
    'معدل الإلغاءات (20%) أعلى من الحد المعتمد خلال الفترة، على عينة من 20 appointment episode — إشارة تشغيلية قوية تستحق انتباهًا إداريًا واضحًا.');
  assert.strictEqual(ins.recommendation,
    'مراجعة إدارية عاجلة لنمط الإلغاءات خلال الفترة، مع مقارنة بالفترات السابقة ومراجعة السياق التشغيلي.');
});

test('M2R-19 — High change: ABOVE polarity', function() {
  reset();
  setPolicies('CHANGE');
  seedDay(7, 10, { changed: 4, live: 16 }); // 20%

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.rules.CHANGE_RATE.severity, 'CRITICAL');
  assert.strictEqual(insightOf(data, 'CHANGE_RATE').explanation,
    'معدل تغييرات المواعيد (20%) أعلى من الحد المعتمد خلال الفترة، على عينة من 20 appointment episode — إشارة تشغيلية قوية تستحق انتباهًا إداريًا واضحًا.');
});

test('M2R-20 — High no-show: ABOVE polarity', function() {
  reset();
  setPolicies('NOSHOW');
  seedDay(7, 10, { noShow: 4, live: 16 }); // 20%

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.rules.NO_SHOW_RATE.severity, 'CRITICAL');
  assert.strictEqual(insightOf(data, 'NO_SHOW_RATE').explanation,
    'معدل عدم الحضور (20%) أعلى من الحد المعتمد خلال الفترة، على عينة من 20 appointment episode — إشارة تشغيلية قوية تستحق انتباهًا إداريًا واضحًا.');
});

test('M2R-21 — High completion polarity: LOW completion elevates (BELOW), HIGH completion is NORMAL', function() {
  // (a) low completion: 20% → CRITICAL
  reset();
  setPolicies('COMPLETION');
  seedDay(7, 10, { completed: 4, live: 16 });
  const lowData = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  const low = lowData.rules.COMPLETION_RATE;
  assert.strictEqual(low.severity, 'CRITICAL', '20% is far below the approved floor');
  assert.strictEqual(insightOf(lowData, 'COMPLETION_RATE').explanation,
    'معدل إنجاز المواعيد (20%) أدنى من الحد المعتمد خلال الفترة، على عينة من 20 appointment episode — إشارة تشغيلية قوية تستحق انتباهًا إداريًا واضحًا.');

  // (b) high completion: 90% → NORMAL (good behavior is not a signal)
  reset();
  setPolicies('COMPLETION');
  seedDay(7, 10, { completed: 9, live: 1 });
  const highData = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  const high = highData.rules.COMPLETION_RATE;
  assert.strictEqual(high.severity, 'NORMAL', '90% is above every BELOW band');
  assert.strictEqual(high.value, 90);
  assert.strictEqual(insightOf(highData, 'COMPLETION_RATE').recommendation, null, 'NORMAL has nothing to review');

  // (c) BELOW transitions: 70 → WATCH, 50 → HIGH, 30 → CRITICAL
  [
    { completed: 7, live: 3, expected: 'WATCH' },   // 70% exactly
    { completed: 5, live: 5, expected: 'HIGH' },    // 50% exactly
    { completed: 3, live: 7, expected: 'CRITICAL' } // 30% exactly
  ].forEach(function(c) {
    reset();
    setPolicies('COMPLETION');
    seedDay(7, 10, { completed: c.completed, live: c.live });
    const r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).COMPLETION_RATE;
    assert.strictEqual(r.severity, c.expected, c.completed + '/' + (c.completed + c.live));
  });
});

// ── 5 — Trend engine ─────────────────────────────────────────────

test('M2R-22 — Trend UP: current 10% vs previous 0% (previous = deterministic previous day)', function() {
  reset();
  seedTwoDays({ live: 10 }, { cancelled: 1, live: 9 }); // 0% → 10%

  const data = dataOf(RRS.evaluateRules(dayPeriod(7, 10), { includeTrend: true }));
  const t = data.trend.metrics.CANCELLATION_RATE;
  assert.strictEqual(data.trend.available, true);
  assert.strictEqual(t.available, true);
  assert.strictEqual(t.direction, 'TREND_UP');
  assert.strictEqual(t.current, 10);
  assert.strictEqual(t.previous, 0);
  assert.strictEqual(t.previousDenominator, 10);
  // Previous period is the immediately preceding equal-length window
  assert.strictEqual(data.trend.period.startMs, D(7, 9, 0));
  assert.strictEqual(data.trend.period.endMs, D(7, 10, 0));
  // Trend never alters severity in this version
  assert.strictEqual(data.rules.CANCELLATION_RATE.severity, null, 'no approved trend-severity policy');
});

test('M2R-23 — Trend FLAT: current = previous', function() {
  reset();
  seedTwoDays({ cancelled: 1, live: 9 }, { cancelled: 1, live: 9 }); // 10% → 10%

  const t = dataOf(RRS.evaluateRules(dayPeriod(7, 10), { includeTrend: true }))
    .trend.metrics.CANCELLATION_RATE;
  assert.strictEqual(t.direction, 'TREND_FLAT');
});

test('M2R-24 — Trend DOWN: current < previous', function() {
  reset();
  seedTwoDays({ cancelled: 2, live: 8 }, { cancelled: 1, live: 9 }); // 20% → 10%

  const t = dataOf(RRS.evaluateRules(dayPeriod(7, 10), { includeTrend: true }))
    .trend.metrics.CANCELLATION_RATE;
  assert.strictEqual(t.direction, 'TREND_DOWN');
  assert.strictEqual(t.previous, 20);
  assert.strictEqual(t.current, 10);
});

test('M2R-25 — Unavailable previous period (ZERO_DENOMINATOR): per-metric reason, severity untouched, confidence → MEDIUM', function() {
  reset();
  setPolicies('CANCEL');
  seedTwoDays({ live: 0 }, { cancelled: 1, live: 9 }); // previous day empty

  const data = dataOf(RRS.evaluateRules(dayPeriod(7, 10), { includeTrend: true }));
  const r = data.rules.CANCELLATION_RATE;
  const t = data.trend.metrics.CANCELLATION_RATE;
  assert.strictEqual(data.trend.available, true, 'the previous batch WAS readable');
  assert.strictEqual(t.available, false);
  assert.strictEqual(t.direction, null);
  assert.strictEqual(t.reason, 'ZERO_DENOMINATOR', 'never converted to 0% or TREND_DOWN');
  assert.strictEqual(r.status, 'EVALUATED', 'trend unavailability does not gate evaluation');
  assert.strictEqual(r.severity, 'HIGH', '10% — severity is independent of trend in this version');
  assert.strictEqual(r.confidence, 'MEDIUM', 'comparison unavailable → deterministic downgrade');
});

// ── 6 — Combined insights ────────────────────────────────────────

test('M2R-26 — Cancellation + no-show elevated → ATTENDANCE_BEHAVIOR_PATTERN (reliable inputs only)', function() {
  reset();
  setPolicies('CANCEL', 'NOSHOW');
  seedDay(7, 10, { cancelled: 4, noShow: 4, completed: 10, live: 2 }); // cohort 20

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.rules.CANCELLATION_RATE.severity, 'CRITICAL');
  assert.strictEqual(data.rules.NO_SHOW_RATE.severity, 'CRITICAL');
  // completion 50% has NO policy → NOT_EVALUABLE → not a reliable input
  assert.strictEqual(data.rules.COMPLETION_RATE.status, 'NOT_EVALUABLE');

  const combos = data.insights.filter(function(i) { return i.combined; });
  assert.strictEqual(combos.length, 1, 'exactly one pattern fires');
  const combo = combos[0];
  assert.strictEqual(combo.patternId, 'ATTENDANCE_BEHAVIOR_PATTERN');
  assert.deepStrictEqual(hostClone(combo.metrics), ['CANCELLATION_RATE', 'NO_SHOW_RATE']);
  assert.strictEqual(combo.status, 'EVALUATED');
  assert.strictEqual(combo.severity, null, 'no approved combined-severity policy');
  assert.strictEqual(combo.confidence, 'HIGH', 'min of input confidences');
  assert.strictEqual(combo.value, null, 'a pattern is not a rate');
  assert.strictEqual(combo.explanation,
    'نشاط الإلغاءات وعدم الحضور مرتفع معًا خلال الفترة — نمط سلوك تشغيلي يستحق المراجعة الإدارية (بدون استنتاج سببي).');
  assert.strictEqual(combo.recommendation,
    'مراجعة نمط الالتزام بالمواعيد خلال الفترة، ومقارنته بالفترات السابقة، ومراجعة السياق التشغيلي.');
  // Provenance identifies each metric input
  assert.strictEqual(combo.provenance.inputs.length, 2);
  const byMetric = {};
  combo.provenance.inputs.forEach(function(inp) { byMetric[inp.metric] = inp; });
  assert.strictEqual(byMetric.CANCELLATION_RATE.severity, 'CRITICAL');
  assert.strictEqual(byMetric.CANCELLATION_RATE.value, 20);
  assert.strictEqual(byMetric.NO_SHOW_RATE.value, 20);
  assert.strictEqual(combo.provenance.asOfMs, NOW_MS);
});

test('M2R-27 — Cancellation + change elevated → RESCHEDULING_PATTERN', function() {
  reset();
  setPolicies('CANCEL', 'CHANGE');
  seedDay(7, 10, { cancelled: 4, changed: 4, live: 12 }); // cohort 20

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  const combos = data.insights.filter(function(i) { return i.combined; });
  assert.strictEqual(combos.length, 1);
  assert.strictEqual(combos[0].patternId, 'RESCHEDULING_PATTERN');
  assert.deepStrictEqual(hostClone(combos[0].metrics), ['CANCELLATION_RATE', 'CHANGE_RATE']);
  assert.strictEqual(combos[0].explanation,
    'نشاط الإلغاءات وتغييرات المواعيد مرتفع معًا خلال الفترة — نمط إعادة جدولة يستحق المراجعة الإدارية (بدون استنتاج سببي).');
});

test('M2R-28 — Multiple elevated metrics (4): all defined patterns fire, MULTI documents the whole', function() {
  reset();
  setPolicies('CANCEL', 'CHANGE', 'COMPLETION', 'NOSHOW');
  // cohort 30: cancel 20% CRIT, change 20% CRIT, no-show 20% CRIT,
  // completion 40% → BELOW HIGH (elevated) → 4 elevated metrics
  seedDay(7, 10, { cancelled: 6, changed: 6, noShow: 6, completed: 12, live: 0 });

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  const patterns = {};
  data.insights.forEach(function(i) { if (i.combined) patterns[i.patternId] = i; });
  assert.strictEqual(Object.keys(patterns).length, 3);
  assert.ok(patterns.ATTENDANCE_BEHAVIOR_PATTERN);
  assert.ok(patterns.RESCHEDULING_PATTERN);
  const multi = patterns.MULTI_METRIC_ELEVATION;
  assert.strictEqual(multi.metrics.length, 4);
  assert.strictEqual(multi.explanation,
    '4 معدلات تشغيلية مرتفعة معًا خلال الفترة — يستحق المراجعة الإدارية الشاملة (بدون استنتاج سببي).');
  assert.strictEqual(multi.recommendation,
    'مراجعة شاملة للنمط التشغيلي خلال الفترة ومقارنته بالفترات السابقة.');
});

test('M2R-29 — Combined insight never exceeds input validity (unreliable no-show blocks the pair)', function() {
  reset();
  setPolicies('CANCEL');
  // cancellation elevated; the ONLY APPLIED row has an unparseable
  // timestamp → activation boundary unestablishable → completion and
  // no-show envelopes are UNAVAILABLE (RATE_EVIDENCE_INVALID)
  const day = seedDay(7, 10, { cancelled: 2, live: 7 });
  const sc = 'S_C';
  day.slots.push(mkSlot(sc, { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 10, 23, 0)), phone: PHONE }));
  day.att.push(mkAudit(sc, 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', 'garbage-not-a-date'));
  seedAvailability(day.slots);
  seedLifecycle(day.lc);
  seedAttendance(day.att);

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.rules.CANCELLATION_RATE.status, 'EVALUATED');
  assert.strictEqual(data.rules.CANCELLATION_RATE.severity, 'CRITICAL', '20% — elevated on its own');
  assert.strictEqual(data.rules.NO_SHOW_RATE.status, 'NOT_EVALUABLE');
  assert.strictEqual(data.rules.NO_SHOW_RATE.reason, 'RATE_EVIDENCE_INVALID');

  const combos = data.insights.filter(function(i) { return i.combined; });
  assert.strictEqual(combos.length, 0, 'no pattern may be built from an unreliable input');
});

// ── 7 — Safety: no causality / blame / automatic action / patient / individual-facing ──

test('M2R-30 — No causal inference: every text equals its whitelisted template (nothing added)', function() {
  reset();
  setPolicies('CANCEL', 'NOSHOW');
  seedDay(7, 10, { cancelled: 4, noShow: 4, completed: 10, live: 2 });

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  // Metric texts are EXACTLY the templates — any invented inference
  // (cause, fault, prediction) would break the equality.
  assert.strictEqual(insightOf(data, 'CANCELLATION_RATE').explanation,
    'معدل الإلغاءات (20%) أعلى من الحد المعتمد خلال الفترة، على عينة من 20 appointment episode — إشارة تشغيلية قوية تستحق انتباهًا إداريًا واضحًا.');
  assert.strictEqual(insightOf(data, 'NO_SHOW_RATE').explanation,
    'معدل عدم الحضور (20%) أعلى من الحد المعتمد خلال الفترة، على عينة من 20 appointment episode — إشارة تشغيلية قوية تستحق انتباهًا إداريًا واضحًا.');
  assert.strictEqual(insightOf(data, 'COMPLETION_RATE').explanation,
    'المعدل متاح والعينة كافية (20)، لكن لا يوجد threshold policy معتمد لهذا المقياس — لا يُصنَّف (RULE_NOT_CONFIGURED).');
  const combo = data.insights.filter(function(i) { return i.combined; })[0];
  assert.strictEqual(combo.explanation,
    'نشاط الإلغاءات وعدم الحضور مرتفع معًا خلال الفترة — نمط سلوك تشغيلي يستحق المراجعة الإدارية (بدون استنتاج سببي).');
});

test('M2R-31 — No blame inference: no cause/fault/patient/doctor tokens in any insight text', function() {
  reset();
  setPolicies('CANCEL', 'CHANGE', 'COMPLETION', 'NOSHOW');
  seedDay(7, 10, { cancelled: 6, changed: 6, noShow: 6, completed: 12, live: 0 });

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10), { includeTrend: true }));
  const texts = [];
  data.insights.forEach(function(i) {
    if (i.explanation) texts.push(i.explanation);
    if (i.recommendation) texts.push(i.recommendation);
  });
  assert.ok(texts.length >= 4);
  const forbidden = ['بسبب', 'السبب', 'أسباب', 'إهمال', 'خطأ', 'مريض', 'طبيب', 'إخلال', 'fault', 'negligence'];
  texts.forEach(function(t) {
    forbidden.forEach(function(tok) {
      assert.strictEqual(t.indexOf(tok) !== -1, false, 'forbidden token "' + tok + '" in: ' + t);
    });
  });
});

test('M2R-32 — No automatic action: the layer has no mutation / messaging surface (code + runtime)', function() {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  const forbidden = [
    'appendRow', 'updateRow', 'updateBatch', 'deleteRows', 'getOrCreateSheet',
    'ScriptLock', 'Lock.runExclusive', 'GoogleSheets',
    'WhatsApp', 'UltraMsg', 'notification', 'Notification',
    'sendMessage', 'XMLHttpRequest', 'fetch(', 'CalendarApp', 'Calendar'
  ];
  forbidden.forEach(function(tok) {
    assert.strictEqual(src.indexOf(tok) !== -1, false, 'forbidden token in RateRuleService.js: ' + tok);
  });
  // Runtime proof: a full insight run performs zero writes / creations
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 4, live: 16 });
  dataOf(RRS.generateInsights(dayPeriod(7, 10), { includeTrend: true }));
  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.sheetCreates, 0);
});

test('M2R-33 — No patient-specific recommendation: seeded patient identity never leaks into text', function() {
  reset();
  setPolicies('CANCEL');
  const day = seedDay(7, 10, { cancelled: 4, live: 15 });
  day.slots.push(mkSlot('S_PAT', {
    status: 'CONFIRMED',
    sortKey: sortKeyOf(D(7, 10, 23, 0)),
    patient: 'أحمد العلي',
    phone: '9647770001111'
  }));
  seedAvailability(day.slots);
  seedLifecycle(day.lc);
  seedAttendance(day.att);

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  const all = JSON.stringify(data.insights.map(function(i) {
    return { e: i.explanation, r: i.recommendation };
  }));
  assert.strictEqual(all.indexOf('أحمد العلي') !== -1, false, 'patient name must never appear');
  assert.strictEqual(all.indexOf('9647770001111') !== -1, false, 'patient phone must never appear');
});

test('M2R-34 — No individual-facing surface: no "doctor" token in code or output', function() {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  assert.strictEqual(/doctor/i.test(src), false, 'no individual-facing surface in the rule layer');
  assert.strictEqual(src.indexOf('طبيب') !== -1, false);

  reset();
  setPolicies('CANCEL', 'CHANGE', 'COMPLETION', 'NOSHOW');
  seedDay(7, 10, { cancelled: 6, changed: 6, noShow: 6, completed: 12, live: 0 });
  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(/doctor/i.test(JSON.stringify(data)), false, 'no individual-facing surface in output');
});

// ── 8 — Provenance preservation ──────────────────────────────────

test('M2R-35 — Numerator preserved through rule + insight', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 4, live: 16 });

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  const rule = data.rules.CANCELLATION_RATE;
  const insight = data.insights.filter(function(i) { return i.metric === 'CANCELLATION_RATE'; })[0];
  assert.strictEqual(rule.numerator, 4);
  assert.strictEqual(insight.numerator, 4);
  assert.strictEqual(rule.provenance.foundationProvenance.numerator, 4, 'foundation envelope provenance preserved verbatim');
});

test('M2R-36 — Denominator (cohort) preserved through rule + insight', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 4, live: 16 });

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.rules.CANCELLATION_RATE.denominator, 20);
  const insight = data.insights.filter(function(i) { return i.metric === 'CANCELLATION_RATE'; })[0];
  assert.strictEqual(insight.denominator, 20);
  assert.strictEqual(data.cohort.total, 20, 'the shared foundation cohort is exposed, never redefined');
});

test('M2R-37 — Period preserved (canonical start-inclusive / end-exclusive)', function() {
  reset();
  seedDay(7, 10, { cancelled: 1, live: 19 });

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.period.startMs, D(7, 10, 0));
  assert.strictEqual(data.period.endMs, D(7, 11, 0));
  RATES.forEach(function(name) {
    assert.strictEqual(data.rules[name].period.startMs, D(7, 10, 0));
    assert.strictEqual(data.rules[name].period.endMs, D(7, 11, 0));
  });
  data.insights.forEach(function(i) {
    assert.strictEqual(i.period.startMs, D(7, 10, 0));
    assert.strictEqual(i.period.endMs, D(7, 11, 0));
  });
});

test('M2R-38 — evaluatedAt preserved (inherited from the foundation batch, never re-sampled)', function() {
  reset();
  seedDay(7, 10, { cancelled: 1, live: 19 });

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.evaluatedAt.getTime(), NOW_MS);
  data.insights.forEach(function(i) {
    assert.strictEqual(i.provenance.evaluatedAt.getTime(), NOW_MS);
  });
});

test('M2R-39 — asOfMs + sources + foundation status/reason preserved', function() {
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 4, live: 16 });

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(data.asOfMs, NOW_MS);
  data.insights.forEach(function(i) {
    assert.strictEqual(i.provenance.asOfMs, NOW_MS);
    assert.deepStrictEqual(hostClone(i.provenance.sources),
      ['Availability', 'B6_LIFECYCLE', 'ATTENDANCE_AUDIT']);
    assert.strictEqual(i.provenance.foundationStatus, 'AVAILABLE');
    assert.strictEqual(i.provenance.foundationReason, null);
  });
  assert.strictEqual(data.provenance.foundation.sourceFailure, null);
});

// ── 9 — Architecture: read-only / no direct repositories ─────────

test('M2R-40 — Read-once per source (no trend), read-only, no sheet creation', function() {
  reset();
  seedDay(7, 10, { cancelled: 2, live: 18 });

  dataOf(RRS.evaluateRules(dayPeriod(7, 10)));
  assert.strictEqual(state.queryCalls['Availability'], 1);
  assert.strictEqual(state.queryCalls['B6_LIFECYCLE'], 1);
  assert.strictEqual(state.queryCalls['ATTENDANCE_AUDIT'], 1);
  assert.strictEqual(state.headerCalls['B6_LIFECYCLE'], 1);
  assert.strictEqual(state.headerCalls['ATTENDANCE_AUDIT'], 1);
  assert.strictEqual(state.headerCalls['Availability'] || 0, 0);
  assert.strictEqual(state.writes, 0, 'no repository writes');
  assert.strictEqual(state.sheetCreates, 0, 'no sheet creation');
});

test('M2R-41 — No locks / no mutation: a full run with trend touches zero write surfaces', function() {
  reset();
  setPolicies('CANCEL');
  seedTwoDays({ cancelled: 1, live: 9 }, { cancelled: 2, live: 8 });

  dataOf(RRS.generateInsights(dayPeriod(7, 10), { includeTrend: true }));
  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.sheetCreates, 0);
});

test('M2R-42 — Header validation happens ONLY where the foundation reporting boundaries require it', function() {
  reset();
  seedEmptySources();

  dataOf(RRS.evaluateRules(dayPeriod(7, 10)));
  assert.strictEqual(state.headerCalls['B6_LIFECYCLE'], 1, 'strict B6 header contract (schema drift = failure, never false zero)');
  assert.strictEqual(state.headerCalls['ATTENDANCE_AUDIT'], 1, 'strict attendance header contract');
  assert.strictEqual(state.headerCalls['Availability'] || 0, 0);
});

test('M2R-43 — includeTrend adds exactly ONE foundation batch (two reads per source, still read-only)', function() {
  reset();
  seedTwoDays({ live: 10 }, { cancelled: 1, live: 9 });

  dataOf(RRS.evaluateRules(dayPeriod(7, 10), { includeTrend: true }));
  assert.strictEqual(state.queryCalls['Availability'], 2, 'current + previous — one batch each');
  assert.strictEqual(state.queryCalls['B6_LIFECYCLE'], 2);
  assert.strictEqual(state.queryCalls['ATTENDANCE_AUDIT'], 2);
  assert.strictEqual(state.writes, 0);
  assert.strictEqual(state.sheetCreates, 0);
});

test('M2R-44 — generateInsights adds NO extra reads over evaluateRules', function() {
  reset();
  seedDay(7, 10, { cancelled: 1, live: 19 });

  dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  assert.strictEqual(state.queryCalls['Availability'], 1);
  assert.strictEqual(state.queryCalls['B6_LIFECYCLE'], 1);
  assert.strictEqual(state.queryCalls['ATTENDANCE_AUDIT'], 1);
});

test('M2R-45 — The rule layer never references raw repositories (only the foundation + period utils)', function() {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  ['SlotRepository', 'B6LifecycleRepository', 'AttendanceAuditReadRepository',
   'AttendanceAuditRepository', 'MetricsService'].forEach(function(tok) {
    assert.strictEqual(src.indexOf(tok) !== -1, false, 'direct reference to ' + tok + ' would bypass the foundation');
  });
  assert.ok(src.indexOf('RateFoundationService') !== -1, 'the foundation is the only rates source');
  assert.ok(src.indexOf('ReportPeriod') !== -1, 'periods come from ReportPeriod');
});

// ── 10 — API hygiene / determinism / batch independence ──────────

test('M2R-46 — ForReport: DAILY/WEEKLY/MONTHLY delegate to ReportPeriod (Saturday week, Asia/Baghdad)', function() {
  reset();
  seedEmptySources();
  const ref = NOW_MS;

  const daily = dataOf(RRS.evaluateRulesForReport('DAILY', ref, { includeTrend: true }));
  assert.strictEqual(daily.period.startMs, sandbox.ReportPeriod.dailyPeriod(ref).data.startMs);
  assert.strictEqual(daily.period.endMs, sandbox.ReportPeriod.dailyPeriod(ref).data.endMs);
  assert.strictEqual(daily.period.timeZone, 'Asia/Baghdad');
  assert.strictEqual(Object.keys(daily.rules).length, 4);
  // Previous day for trend is the ReportPeriod previous day (delegation, not arithmetic)
  const expectedPrev = sandbox.ReportPeriod.dailyPeriod(daily.period.startMs - 1).data;
  assert.strictEqual(daily.trend.period.startMs, expectedPrev.startMs);
  assert.strictEqual(daily.trend.period.endMs, expectedPrev.endMs);

  const weekly = dataOf(RRS.evaluateRulesForReport('WEEKLY', ref));
  assert.strictEqual(weekly.period.startMs, sandbox.ReportPeriod.weeklyPeriod(ref).data.startMs);
  assert.strictEqual(weekly.period.reportWeekStart, 6, 'Saturday-start reporting calendar preserved');

  const monthly = dataOf(RRS.evaluateRulesForReport('MONTHLY', ref));
  assert.strictEqual(monthly.period.startMs, sandbox.ReportPeriod.monthlyPeriod(ref).data.startMs);

  const unknown = RRS.evaluateRulesForReport('HOURLY', ref);
  assert.strictEqual(unknown.ok, false);
  assert.strictEqual(unknown.error.code, 'REPORT_TYPE_UNKNOWN');

  const badRef = RRS.evaluateRulesForReport('DAILY', 'nope');
  assert.strictEqual(badRef.ok, false);
  assert.strictEqual(badRef.error.code, 'REPORT_PERIOD_INVALID');
});

test('M2R-47 — Period validation: malformed / inverted / non-finite → RATE_PERIOD_INVALID (delegated)', function() {
  reset();
  seedEmptySources();
  const bad = [
    { start: D(7, 10, 0), end: D(7, 10, 0) },
    { start: 100, end: 50 },
    { start: NaN, end: 100 },
    'nope',
    null
  ];
  bad.forEach(function(b) {
    const res = RRS.evaluateRules(b);
    assert.strictEqual(res.ok, false, JSON.stringify(b) + ' must fail');
    assert.strictEqual(res.error.code, 'RATE_PERIOD_INVALID');
  });
});

test('M2R-48 — Determinism: identical input → identical output (two runs, with trend)', function() {
  reset();
  setPolicies('CANCEL', 'NOSHOW');
  seedTwoDays({ cancelled: 1, live: 9 }, { cancelled: 2, live: 8 });

  const r1 = RRS.generateInsights(dayPeriod(7, 10), { includeTrend: true });
  const r2 = RRS.generateInsights(dayPeriod(7, 10), { includeTrend: true });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(deepStrip(r1.data), deepStrip(r2.data));
});

test('M2R-49 — Batch independence: one metric NOT_EVALUABLE never hides the independent rules', function() {
  reset();
  setPolicies('CANCEL');
  // ONLY APPLIED row has an unparseable timestamp → activation boundary
  // unestablishable → completion + no-show UNAVAILABLE; cancellation +
  // change are unaffected
  const day = seedDay(7, 10, { cancelled: 2, live: 8 });
  const sc = 'S_X';
  day.slots.push(mkSlot(sc, { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 10, 23, 0)), phone: PHONE }));
  day.att.push(mkAudit(sc, 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', 'garbage-not-a-date'));
  seedAvailability(day.slots);
  seedLifecycle(day.lc);
  seedAttendance(day.att);

  const data = dataOf(RRS.evaluateRules(dayPeriod(7, 10)));
  assert.strictEqual(data.rules.CANCELLATION_RATE.status, 'EVALUATED', 'independent rule proceeds');
  assert.strictEqual(data.rules.CANCELLATION_RATE.severity, 'CRITICAL', '200/11% ≥ 15 band');
  assert.strictEqual(data.rules.CHANGE_RATE.status, 'NOT_EVALUABLE', 'unaffected by the attendance conflict — its only issue is the missing policy');
  assert.strictEqual(data.rules.CHANGE_RATE.reason, 'RULE_NOT_CONFIGURED');
  assert.strictEqual(data.rules.COMPLETION_RATE.status, 'NOT_EVALUABLE');
  assert.strictEqual(data.rules.COMPLETION_RATE.reason, 'RATE_EVIDENCE_INVALID');
  assert.strictEqual(data.rules.NO_SHOW_RATE.status, 'NOT_EVALUABLE');
  assert.strictEqual(data.rules.NO_SHOW_RATE.reason, 'RATE_EVIDENCE_INVALID');
  // Call succeeded — a per-metric evidence problem is not a call failure
  assert.strictEqual(data.asOfMs, NOW_MS);
});

test('M2R-50 — Insight completeness: one insight per metric ALWAYS (including NOT_EVALUABLE), confidence null when invalid', function() {
  reset();
  setPolicies('CANCEL');
  seedEmptySources();

  const data = dataOf(RRS.generateInsights(dayPeriod(7, 10)));
  const metricInsights = data.insights.filter(function(i) { return !i.combined; });
  assert.strictEqual(metricInsights.length, 4, 'the report must be able to show WHY a rate is absent');
  metricInsights.forEach(function(i) {
    assert.strictEqual(i.status, 'NOT_EVALUABLE');
    assert.strictEqual(i.reason, 'ZERO_DENOMINATOR');
    assert.strictEqual(i.severity, null);
    assert.strictEqual(i.value, null);
    assert.strictEqual(i.confidence, null, 'invalid/undefined evidence → confidence null, never LOW');
    assert.strictEqual(i.ruleId !== null, true);
  });
  const ids = {};
  data.insights.forEach(function(i) { ids[i.insightId] = true; });
  assert.strictEqual(Object.keys(ids).length, 4, 'insightIds are deterministic and unique');
});

// ── 11 — Supervisor review fixes (CHANGES REQUIRED) ──────────────

function setPolicyWithMinSample(minSample) {
  const p = JSON.parse(JSON.stringify(TEST_POLICIES.CANCEL));
  p.minimumSample = minSample;
  sandbox.RateRuleService.THRESHOLD_POLICY.policies = [p];
}

test('M2R-51 — P1: a threshold policy can NEVER override the frozen MINIMUM_COHORT = 10', function() {
  // (a) policy claiming a LOWER floor (5): rejected for that metric —
  //     NOT_EVALUABLE / RULE_POLICY_INVALID, no severity, the frozen
  //     floor is what gets reported
  reset();
  setPolicyWithMinSample(5);
  seedDay(7, 10, { cancelled: 2, live: 10 }); // cohort 12 (>= 10)
  const ra = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(ra.status, 'NOT_EVALUABLE');
  assert.strictEqual(ra.reason, 'RULE_POLICY_INVALID');
  assert.strictEqual(ra.severity, null, 'no severity from a policy that conflicts with the frozen decision');
  assert.strictEqual(ra.minimumSample, 10, 'the frozen floor is always reported');
  assert.ok(typeof ra.provenance.policyConflict === 'string' &&
    ra.provenance.policyConflict.indexOf('frozen MINIMUM_COHORT = 10') !== -1,
    'the conflict is surfaced in provenance, not hidden');

  // (b) policy claiming a HIGHER floor (25): rejected likewise
  reset();
  setPolicyWithMinSample(25);
  seedDay(7, 10, { cancelled: 2, live: 10 });
  const rb = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(rb.status, 'NOT_EVALUABLE');
  assert.strictEqual(rb.reason, 'RULE_POLICY_INVALID');

  // (c) the frozen floor applies BEFORE any policy is consulted:
  //     cohort 5 with a minSample:1 policy → INSUFFICIENT_SAMPLE (10 wins)
  reset();
  setPolicyWithMinSample(1);
  seedDay(7, 10, { cancelled: 1, live: 4 }); // cohort 5
  const rc = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(rc.status, 'INSUFFICIENT_SAMPLE', 'a policy cannot lower the frozen floor');
  assert.strictEqual(rc.minimumSample, 10);

  // (d) a CONSISTENT policy (minSample === 10) is accepted — evaluation proceeds
  reset();
  setPolicies('CANCEL'); // TEST_POLICIES.CANCEL.minimumSample = 10
  seedDay(7, 10, { cancelled: 1, live: 19 });
  const rd = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(rd.status, 'EVALUATED', 'a consistent policy is valid');

  // (e) a malformed minSample (10.5): rejected likewise
  reset();
  setPolicyWithMinSample(10.5);
  seedDay(7, 10, { cancelled: 2, live: 10 });
  const re = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(re.status, 'NOT_EVALUABLE');
  assert.strictEqual(re.reason, 'RULE_POLICY_INVALID');

  // (f) batch independence: the conflict invalidates ONLY that metric's
  //     policy — the other rules proceed exactly as before
  reset();
  setPolicyWithMinSample(5);
  seedDay(7, 10, { cancelled: 2, live: 10 });
  const data = dataOf(RRS.evaluateRules(dayPeriod(7, 10)));
  assert.strictEqual(data.rules.CANCELLATION_RATE.reason, 'RULE_POLICY_INVALID');
  assert.strictEqual(data.rules.CHANGE_RATE.status, 'NOT_EVALUABLE');
  assert.strictEqual(data.rules.CHANGE_RATE.reason, 'RULE_NOT_CONFIGURED', 'change is unaffected (no policy for it)');
  assert.strictEqual(data.rules.COMPLETION_RATE.reason, 'RULE_NOT_CONFIGURED');
  assert.strictEqual(data.rules.NO_SHOW_RATE.reason, 'RULE_NOT_CONFIGURED');
});

test('M2R-52 — P2: provenance completeness is enforced over the WHOLE minimum surface', function() {
  const svc = sandbox.RateRuleService;
  const meta = svc.METRIC_RULES[0]; // CANCELLATION_RATE rule metadata

  function mkEnv() {
    return {
      metric: 'CANCELLATION_RATE',
      status: 'AVAILABLE',
      value: 5,
      reason: null,
      period: { startMs: D(7, 10, 0), endMs: D(7, 11, 0) },
      evaluatedAt: sandbox.mkVmDate(NOW_MS),
      asOfMs: NOW_MS,
      provenance: {
        numerator: 1,
        denominator: 20,
        formula: 'numerator / denominator * 100',
        appointmentDayBasis: 'APPOINTMENT_START',
        periodSemantics: 'start inclusive, end exclusive (canonical epoch ms)',
        cohortDefinition: 'distinct provable confirmed appointment episodes',
        cohortByPath: {
          pathA_stillConfirmed: 19, pathB_completed: 0, pathC_noShow: 0,
          pathD_cancelled: 1, pathE_changed: 0
        },
        reusedSlots: 0,
        reusedSlotEpisodes: 0,
        unattributableRows: 0,
        outOfPeriodConflicts: 0,
        changeRowsMissingNewSlotId: 0,
        sourceFailure: null,
        conflicts: [],
        evidence: {
          source: 'B6_LIFECYCLE',
          fields: ['lifecycle_state', 'checkpoint', 'operation_id', 'old_slot_id', 'Availability.sort_key'],
          condition: 'terminal cancel proven',
          aggregation: 'COUNT DISTINCT operation_id',
          periodFilter: 'old-slot appointmentStartMs in period'
        }
      }
    };
  }

  // The complete minimum surface passes the gate
  assert.strictEqual(svc._provenanceComplete(mkEnv(), meta), true, 'complete envelope → complete');

  // Every single field of the minimum surface is enforced
  const cases = [
    ['wrong metric', function(e) { e.metric = 'CHANGE_RATE'; }],
    ['invalid status', function(e) { e.status = 'WEIRD'; }],
    ['AVAILABLE without a numeric value', function(e) { e.value = null; }],
    ['negative value', function(e) { e.value = -1; }],
    ['UNAVAILABLE with non-null value', function(e) { e.status = 'UNAVAILABLE'; }],
    ['missing asOfMs', function(e) { delete e.asOfMs; }],
    ['missing evaluatedAt', function(e) { delete e.evaluatedAt; }],
    ['inverted period', function(e) { e.period = { startMs: 2, endMs: 1 }; }],
    ['missing provenance block', function(e) { delete e.provenance; }],
    ['missing numerator', function(e) { delete e.provenance.numerator; }],
    ['missing denominator', function(e) { delete e.provenance.denominator; }],
    ['missing formula', function(e) { delete e.provenance.formula; }],
    ['blank appointmentDayBasis', function(e) { e.provenance.appointmentDayBasis = '  '; }],
    ['missing periodSemantics', function(e) { delete e.provenance.periodSemantics; }],
    ['missing cohortDefinition', function(e) { delete e.provenance.cohortDefinition; }],
    ['missing cohortByPath', function(e) { delete e.provenance.cohortByPath; }],
    ['missing reusedSlots', function(e) { delete e.provenance.reusedSlots; }],
    ['missing reusedSlotEpisodes', function(e) { delete e.provenance.reusedSlotEpisodes; }],
    ['missing unattributableRows', function(e) { delete e.provenance.unattributableRows; }],
    ['missing outOfPeriodConflicts', function(e) { delete e.provenance.outOfPeriodConflicts; }],
    ['missing changeRowsMissingNewSlotId', function(e) { delete e.provenance.changeRowsMissingNewSlotId; }],
    ['sourceFailure field ABSENT', function(e) { delete e.provenance.sourceFailure; }],
    ['sourceFailure non-null on a success envelope', function(e) { e.provenance.sourceFailure = 'boom'; }],
    ['conflicts not an array', function(e) { e.provenance.conflicts = 'none'; }],
    ['missing evidence block', function(e) { delete e.provenance.evidence; }],
    ['evidence without source', function(e) { delete e.provenance.evidence.source; }],
    ['evidence with empty fields', function(e) { e.provenance.evidence.fields = []; }],
    ['evidence without aggregation', function(e) { delete e.provenance.evidence.aggregation; }],
    ['evidence without periodFilter', function(e) { delete e.provenance.evidence.periodFilter; }]
  ];
  cases.forEach(function(c) {
    const e = mkEnv();
    c[1](e);
    assert.strictEqual(svc._provenanceComplete(e, meta), false, 'must be incomplete: ' + c[0]);
  });

  // Wiring: incomplete provenance deterministically downgrades to LOW
  // (defensive path — the real foundation always produces the full surface)
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 1, live: 19 });
  const origComplete = svc._provenanceComplete;
  svc._provenanceComplete = function() { return false; };
  let r;
  try {
    r = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  } finally {
    svc._provenanceComplete = origComplete; // restore even on assertion failure
  }
  assert.strictEqual(r.status, 'EVALUATED');
  assert.strictEqual(r.confidence, 'LOW', 'incomplete provenance → LOW, never HIGH');

  // Integration: a REAL foundation envelope passes the full gate
  reset();
  setPolicies('CANCEL');
  seedDay(7, 10, { cancelled: 1, live: 19 });
  const real = rulesOf(RRS.evaluateRules(dayPeriod(7, 10))).CANCELLATION_RATE;
  assert.strictEqual(real.status, 'EVALUATED');
  assert.strictEqual(real.confidence, 'HIGH', 'the real foundation surface is complete → HIGH');
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
