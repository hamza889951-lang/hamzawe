'use strict';

/**
 * HardeningM3.test.js — M3 (ENHANCED REPORT)
 *
 * Proves the FROZEN M3-ENHANCED-REPORT-v1 contract over the REAL
 * production stack (M1 ReportService + M1-A MetricsService, M2
 * RateFoundationService + RateRuleService, ReportPeriod) behind one
 * in-memory GoogleSheets seam. Every mutation seam FAILS the test if
 * M3 ever touches it — M3 is composition + presentation ONLY.
 *
 * Coverage (contract §21):
 *   Period    — daily / weekly / monthly / Baghdad TZ / Saturday week
 *               start / boundary dates
 *   M1        — complete / partial / unavailable-input / deferred
 *   M2 rates  — sufficient / insufficient cohort / zero denominator /
 *               unavailable evidence / valid rate + no policy →
 *               RULE_NOT_CONFIGURED
 *   Rules     — normal / severity / no insight-absence / existing
 *               insight / recommendation
 *   Trend     — available / unavailable / previous-period unavailable /
 *               trend must not modify severity
 *   FULL      — canonical content preserved / provenance preserved /
 *               no information silently lost
 *   SUMMARY   — projection only / no recalculation / no new ranking /
 *               no new severity / no new insight / no causal language /
 *               data-quality warnings preserved
 *   Determinism — same input twice → same semantic output
 *   Dependency scan — no repository / Sheets / Calendar / attendance /
 *               notification / billing / write imports; correct
 *               dependency direction
 *
 * Grid discipline (mirrors M2 tests): the sandbox's sort_key parser and
 * the test periods share ONE host-local wall grid (production pins the
 * script timezone to the clinic timezone). ReportPeriod (pure +03:00
 * arithmetic) is tested for delegation/Baghdad correctness directly.
 *
 * THRESHOLD FIXTURE NOTICE: no approved threshold values exist. The
 * production RateRuleService policy store is EMPTY (RULE_NOT_CONFIGURED
 * is the live behavior). Severity coverage uses SYNTHETIC TEST-ONLY
 * policies injected into the sandbox RateRuleService — they are never
 * approved business values and never touch the production store.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';

// ── Deterministic time anchor (host-local wall grid) ─────────────
const NOW_DATE = new Date(2026, 7, 24, 12, 0);            // 2026-08-24 12:00
const NOW_MS = NOW_DATE.getTime();

function D(month0, day, hour, minute) {
  return new Date(2026, month0, day, hour || 0, minute || 0).getTime();
}
function dayPeriodRef(month0, day) { return D(month0, day, 12, 0); }
function sortKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes());
}
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }

// ═══════════════════════════════════════════════════════════════
// Sandbox — full production M1/M2/M3 stack over in-memory GoogleSheets
// ═══════════════════════════════════════════════════════════════

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
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
    getOrCreateSheet: function(name) {
      state.sheetCreates += 1;
      throw new Error('M3_MUST_NOT_CREATE_SHEETS: ' + name);
    },
    appendRow: function(name) { state.writes += 1; throw new Error('M3_MUST_NOT_WRITE: appendRow ' + name); },
    appendRows: function(name) { state.writes += 1; throw new Error('M3_MUST_NOT_WRITE: appendRows ' + name); },
    updateRowByColumn: function(name) { state.writes += 1; throw new Error('M3_MUST_NOT_WRITE: updateRowByColumn ' + name); },
    updateBatch: function(name) { state.writes += 1; throw new Error('M3_MUST_NOT_WRITE: updateBatch ' + name); },
    deleteRowsByNumbers: function(name) { state.writes += 1; throw new Error('M3_MUST_NOT_WRITE: deleteRowsByNumbers ' + name); }
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
  load('Application/MetricsService.js', 'MetricsService');
  load('Application/ReportService.js', 'ReportService');
  load('Application/ReportRenderer.js', 'ReportRenderer');
  load('Application/RateFoundationService.js', 'RateFoundationService');
  load('Application/RateRuleService.js', 'RateRuleService');
  load('Application/EnhancedReportService.js', 'EnhancedReportService');
  load('Application/EnhancedReportRenderer.js', 'EnhancedReportRenderer');

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;
const ERS = sandbox.EnhancedReportService;
const ERR = sandbox.EnhancedReportRenderer;

// ── Seeding helpers (same shapes as M2 Foundation/Rules tests) ────

const AV_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];

function mkSlot(id, opts) {
  const o = opts || {};
  return {
    slot_id: id,
    date: o.date || '2026/08/10',
    time: o.time || '10:00',
    sort_key: o.sortKey !== undefined ? o.sortKey : sortKeyOf(D(7, 10, 10, 0)),
    status: o.status || 'FREE',
    is_available: o.isAvailable !== undefined ? o.isAvailable : true,
    patient_name: o.phone ? 'Patient' : '',
    phone: o.phone || '',
    calendar_event_id: '',
    Reminder_sent: '', whatsapp_message_id: '', reserved_until: '', reserved_until_unix: ''
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
    calendar_event_id: '', calendar_correlation_id: opId, calendar_id: '',
    recovery_state: '', recovery_case_id: '',
    created_at: sandbox.mkVmDate(tsMs - 3600000),
    updated_at: ts, timestamp: ts, details: ''
  };
}
function mkAudit(slotId, decision, toStatus, outcome, tsMs) {
  const ts = sandbox.mkVmDate(tsMs);
  return {
    operator_id: 'doctor.test@hamzawe.clinic',
    calendar_event_id: 'EV_' + slotId, calendar_id: 'CAL_DEFAULT',
    slot_id: slotId, decision: decision,
    from_status: outcome === 'APPLIED' ? 'CONFIRMED' : toStatus,
    to_status: toStatus, outcome: outcome,
    error_code: outcome === 'APPLIED' ? '' : 'SOME_CODE',
    timestamp: ts
  };
}
function seedAvailability(rows) { state.sheets['Availability'] = { headers: AV_HEADERS.slice(), rows: rows || [] }; }
function seedLifecycle(rows) { state.sheets['B6_LIFECYCLE'] = { headers: sandbox.B6LifecycleRepository.HEADERS.slice(), rows: rows || [] }; }
function seedAttendance(rows) { state.sheets['ATTENDANCE_AUDIT'] = { headers: sandbox.AttendanceAuditRepository.HEADERS.slice(), rows: rows || [] }; }

/**
 * Build the row arrays for one appointment day with an exact episode
 * mix. Returns { slots, lc, att } so multiple days can be combined.
 */
function buildDay(month0, day, spec) {
  spec = spec || {};
  const slots = [], lc = [], att = [];
  let n = 0, hour = 8;
  function nid(prefix) { n += 1; return prefix + 'D' + month0 + '_' + day + 'N' + n; }
  function nextHour() { hour += 1; if (hour > 22) hour = 9; return hour; }
  let i, id;
  for (i = 0; i < (spec.cancelled || 0); i++) {
    id = nid('C');
    slots.push(mkSlot(id, { status: 'FREE', sortKey: sortKeyOf(D(month0, day, nextHour(), 0)) }));
    lc.push(mkLifecycle('OPC_' + id, 'RESOLVED_CANCEL', 'TERMINAL_CANCEL_PROVEN', D(month0, day - 1, 9, 0), { oldSlotId: id }));
  }
  for (i = 0; i < (spec.changed || 0); i++) {
    id = nid('H');
    slots.push(mkSlot(id, { status: 'FREE', sortKey: sortKeyOf(D(month0, day, nextHour(), 0)) }));
    lc.push(mkLifecycle('OPH_' + id, 'RESOLVED_CHANGE', 'TERMINAL_CHANGE_PROVEN', D(month0, day - 1, 10, 0), { oldSlotId: id, newSlotId: 'NR_' + id }));
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
  for (i = 0; i < (spec.free || 0); i++) {
    id = nid('F');
    slots.push(mkSlot(id, { status: 'FREE', isAvailable: true, sortKey: sortKeyOf(D(month0, day, nextHour(), 0)) }));
  }
  return { slots: slots, lc: lc, att: att };
}
function seedDays(/* ...builtDays */) {
  const slots = [], lc = [], att = [];
  for (let i = 0; i < arguments.length; i++) {
    const b = arguments[i];
    slots.push.apply(slots, b.slots);
    lc.push.apply(lc, b.lc);
    att.push.apply(att, b.att);
  }
  seedAvailability(slots); seedLifecycle(lc); seedAttendance(att);
}
function seedDay(month0, day, spec) { seedDays(buildDay(month0, day, spec)); }

function reset() {
  state.sheets = {}; state.failRead = {};
  state.queryCalls = {}; state.headerCalls = {};
  state.writes = 0; state.sheetCreates = 0;
  restorePolicies();
}

// ── Synthetic TEST-ONLY threshold policies (never approved values) ──
const RRS = sandbox.RateRuleService;
const ORIG_POLICIES = RRS.THRESHOLD_POLICY.policies;
function setPolicies(list) { RRS.THRESHOLD_POLICY.policies = list; }
function restorePolicies() { RRS.THRESHOLD_POLICY.policies = ORIG_POLICIES; }

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function fullOf(reportType, reference, options) {
  const r = ERS.generateFull(reportType, reference, options);
  assert.strictEqual(r.ok, true, 'generateFull failed: ' + JSON.stringify(r.error));
  return r.data;
}

// ═══════════════════════════════════════════════════════════════
// PERIOD
// ═══════════════════════════════════════════════════════════════

test('M3-P1 — DAILY period is delegated to ReportPeriod (clinic-local day)', function() {
  reset();
  seedDay(7, 24, { live: 3, completed: 4, cancelled: 2 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const pr = sandbox.ReportPeriod.periodFor('DAILY', dayPeriodRef(7, 24)).data;
  assert.strictEqual(full.period.startMs, pr.startMs);
  assert.strictEqual(full.period.endMs, pr.endMs);
  assert.strictEqual(full.period.endMs - full.period.startMs, 86400000);
  assert.strictEqual(full.reportType, 'DAILY');
});

test('M3-P2 — WEEKLY period uses Saturday reporting-calendar start', function() {
  reset();
  seedDay(7, 24, { live: 2, completed: 2 });
  const full = fullOf('WEEKLY', dayPeriodRef(7, 24));
  const pr = sandbox.ReportPeriod.periodFor('WEEKLY', dayPeriodRef(7, 24)).data;
  assert.strictEqual(full.period.startMs, pr.startMs);
  assert.strictEqual(full.period.endMs, pr.endMs);
  assert.strictEqual(full.period.endMs - full.period.startMs, 7 * 86400000);
  // Weekly period metadata records the reporting-calendar week start.
  assert.strictEqual(full.period.reportWeekStart, 6);
});

test('M3-P3 — MONTHLY period is delegated to ReportPeriod (calendar month)', function() {
  reset();
  seedDay(7, 24, { live: 2 });
  const full = fullOf('MONTHLY', dayPeriodRef(7, 24));
  const pr = sandbox.ReportPeriod.periodFor('MONTHLY', dayPeriodRef(7, 24)).data;
  assert.strictEqual(full.period.startMs, pr.startMs);
  assert.strictEqual(full.period.endMs, pr.endMs);
});

test('M3-P4 — Baghdad timezone + start inclusive / end exclusive preserved', function() {
  reset();
  seedDay(7, 24, { live: 1 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  assert.strictEqual(full.period.timeZone, 'Asia/Baghdad');
  assert.strictEqual(full.period.utcOffsetMinutes, 180);
  assert.ok(/\+03:00$/.test(full.period.startWallClock));
  assert.ok(/T00:00:00\+03:00$/.test(full.period.startWallClock));
  assert.ok(/T00:00:00\+03:00$/.test(full.period.endWallClock));
});

test('M3-P5 — boundary date: reference at exactly next-day 00:00 belongs to the NEXT day', function() {
  reset();
  seedDay(7, 25, { live: 2 });
  // reference exactly at 2026-08-25 00:00 clinic-local
  const boundary = sandbox.ReportPeriod.instantOf(2026, 8, 25, 0, 0);
  const full = fullOf('DAILY', boundary);
  const expected = sandbox.ReportPeriod.periodFor('DAILY', boundary).data;
  assert.strictEqual(full.period.startMs, expected.startMs);
  assert.strictEqual(full.period.startWallClock, '2026-08-25T00:00:00+03:00');
});

test('M3-P6 — unknown report type fails cleanly (REPORT_TYPE_UNKNOWN), no partial model', function() {
  reset();
  seedDay(7, 24, { live: 1 });
  const r = ERS.generateFull('YEARLY', dayPeriodRef(7, 24));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'REPORT_TYPE_UNKNOWN');
});

test('M3-P7 — invalid reference fails cleanly (strings rejected, no ambiguous parsing)', function() {
  reset();
  seedDay(7, 24, { live: 1 });
  const r = ERS.generateFull('DAILY', '2026-08-24');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'REPORT_REFERENCE_INVALID');
});

// ═══════════════════════════════════════════════════════════════
// M1 INTEGRATION
// ═══════════════════════════════════════════════════════════════

test('M3-M1-1 — complete: all six M1 metrics AVAILABLE, envelopes VERBATIM', function() {
  reset();
  seedDay(7, 24, { live: 5, completed: 8, noShow: 2, cancelled: 3, changed: 2, free: 4 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  assert.strictEqual(full.m1.status, 'COMPLETE');
  // The exact M1-A envelopes are preserved verbatim (deep equality with
  // an independent ReportService call over the same seam/clock).
  const direct = sandbox.ReportService.generate('DAILY', dayPeriodRef(7, 24)).data;
  assert.deepStrictEqual(jsonClone(full.m1.metrics), jsonClone(direct.metrics));
  assert.strictEqual(full.m1.metrics.CONFIRMED_APPOINTMENTS.value, 5);
  assert.strictEqual(full.m1.metrics.COMPLETED_APPOINTMENTS.value, 8);
});

test('M3-M1-2 — deferred: closed-period snapshot metric stays DEFERRED (never 0)', function() {
  reset();
  // A day fully in the past relative to NOW → snapshot metrics DEFERRED.
  seedDay(7, 10, { live: 3, completed: 2 });
  const full = fullOf('DAILY', dayPeriodRef(7, 10));
  const conf = full.m1.metrics.CONFIRMED_APPOINTMENTS;
  assert.strictEqual(conf.status, 'DEFERRED');
  assert.strictEqual(conf.value, null); // never fabricated to 0
  assert.strictEqual(conf.reason, 'HISTORICAL_NOT_PROVABLE');
  // Report availability reflects the gap honestly (PARTIAL), not COMPLETE.
  assert.strictEqual(full.availability.status, 'PARTIAL');
});

test('M3-M1-3 — partial: DEFERRED metric drives report-level PARTIAL, value preserved null', function() {
  reset();
  seedDay(7, 10, { live: 2, cancelled: 1 });
  const full = fullOf('DAILY', dayPeriodRef(7, 10));
  assert.strictEqual(full.availability.status, 'PARTIAL');
  assert.ok(full.availability.availableInputs < full.availability.totalInputs);
  // The honest gap is preserved in provenance data-quality.
  assert.ok(full.provenance.dataQuality.m1.gaps.length > 0);
});

test('M3-M1-4 — M1 source failure propagates VERBATIM (never a zeroed report)', function() {
  reset();
  seedDay(7, 24, { live: 3 });
  state.failRead['Availability'] = true; // break an M1 source
  const r = ERS.generateFull('DAILY', dayPeriodRef(7, 24));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'METRIC_SOURCE_UNAVAILABLE');
});

// ═══════════════════════════════════════════════════════════════
// M2 RATES
// ═══════════════════════════════════════════════════════════════

test('M3-M2-1 — sufficient cohort: rates AVAILABLE, values PROJECTED (not recomputed)', function() {
  reset();
  seedDay(7, 24, { live: 5, cancelled: 3, changed: 2, completed: 7, noShow: 1 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const rate = full.m2.rates.CANCELLATION_RATE;
  assert.strictEqual(rate.status, 'AVAILABLE');
  // The value/numerator/denominator equal EXACTLY what the foundation
  // produced (projection, never a recomputation).
  const direct = sandbox.RateFoundationService.calculateRates(
    { start: full.period.startMs, end: full.period.endMs }).data;
  const dEnv = direct.rates.CANCELLATION_RATE;
  assert.strictEqual(rate.value, dEnv.value);
  assert.strictEqual(rate.numerator, dEnv.provenance.numerator);
  assert.strictEqual(rate.denominator, dEnv.provenance.denominator);
  assert.strictEqual(rate.numerator, 3);            // 3 cancellation episodes seeded
  assert.strictEqual(rate.denominator, direct.cohort.total);
});

test('M3-M2-2 — insufficient cohort (< 10): value reported, rule INSUFFICIENT_SAMPLE, no severity', function() {
  reset();
  seedDay(7, 24, { live: 2, cancelled: 1 }); // cohort = 3 < 10
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const rate = full.m2.rates.CANCELLATION_RATE;
  assert.strictEqual(rate.status, 'AVAILABLE');       // value still reported
  assert.strictEqual(rate.denominator, 3);
  const rule = full.m2.rules.CANCELLATION_RATE;
  assert.strictEqual(rule.status, 'INSUFFICIENT_SAMPLE');
  assert.strictEqual(rule.severity, null);            // no severity
});

test('M3-M2-3 — zero denominator: rate UNAVAILABLE / ZERO_DENOMINATOR (never 0%)', function() {
  reset();
  seedDay(7, 24, { free: 3 }); // no episodes → cohort 0
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const rate = full.m2.rates.CANCELLATION_RATE;
  assert.strictEqual(rate.status, 'UNAVAILABLE');
  assert.strictEqual(rate.value, null);               // never 0%
  assert.strictEqual(rate.reason, 'ZERO_DENOMINATOR');
});

test('M3-M2-4 — unavailable evidence (conflict): rate UNAVAILABLE / RATE_EVIDENCE_INVALID', function() {
  reset();
  // K2 conflict: one slot with APPLIED COMPLETED and APPLIED NO_SHOW.
  const slotId = 'CONFLICT1';
  const slots = [mkSlot(slotId, { status: 'COMPLETED', sortKey: sortKeyOf(D(7, 24, 10, 0)), phone: PHONE }),
                 mkSlot('LIVE1', { status: 'CONFIRMED', sortKey: sortKeyOf(D(7, 24, 11, 0)), phone: PHONE })];
  seedAvailability(slots);
  seedLifecycle([]);
  seedAttendance([
    mkAudit(slotId, 'MARK_COMPLETED', 'COMPLETED', 'APPLIED', D(7, 24, 12, 0)),
    mkAudit(slotId, 'MARK_NO_SHOW', 'NO_SHOW', 'APPLIED', D(7, 24, 13, 0))
  ]);
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const rate = full.m2.rates.CANCELLATION_RATE;
  assert.strictEqual(rate.status, 'UNAVAILABLE');
  assert.strictEqual(rate.reason, 'RATE_EVIDENCE_INVALID');
  const rule = full.m2.rules.CANCELLATION_RATE;
  assert.strictEqual(rule.status, 'NOT_EVALUABLE');
  assert.strictEqual(rule.reason, 'RATE_EVIDENCE_INVALID');
});

test('M3-M2-5 — valid rate + no approved policy → RULE_NOT_CONFIGURED (live behavior)', function() {
  reset(); // production policy store is EMPTY
  seedDay(7, 24, { live: 8, cancelled: 6, completed: 6 }); // cohort 20 >= 10
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const rule = full.m2.rules.CANCELLATION_RATE;
  assert.strictEqual(full.m2.rates.CANCELLATION_RATE.status, 'AVAILABLE');
  assert.strictEqual(rule.status, 'NOT_EVALUABLE');
  assert.strictEqual(rule.reason, 'RULE_NOT_CONFIGURED');
  assert.strictEqual(rule.severity, null);
});

test('M3-M2-6 — M2 source failure propagates VERBATIM', function() {
  reset();
  seedDay(7, 24, { live: 3, cancelled: 2 });
  state.failRead['B6_LIFECYCLE'] = true; // break an M2 source
  const r = ERS.generateFull('DAILY', dayPeriodRef(7, 24));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.code === 'RATE_SOURCE_UNAVAILABLE' || r.error.code === 'METRIC_SOURCE_UNAVAILABLE');
});

// ═══════════════════════════════════════════════════════════════
// RULES / INSIGHTS
// ═══════════════════════════════════════════════════════════════

test('M3-R1 — normal severity (synthetic policy): rule EVALUATED / NORMAL, verbatim', function() {
  reset();
  setPolicies([{ thresholdId: 'T-CANCEL-TEST', metric: 'CANCELLATION_RATE', direction: 'ABOVE',
    thresholds: [{ threshold: 90, severity: 'HIGH' }] }]);
  seedDay(7, 24, { live: 18, cancelled: 2 }); // ~10% < 90 → NORMAL, cohort 20
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const rule = full.m2.rules.CANCELLATION_RATE;
  assert.strictEqual(rule.status, 'EVALUATED');
  assert.strictEqual(rule.severity, 'NORMAL');
});

test('M3-R2 — elevated severity (synthetic policy): HIGH preserved verbatim in FULL', function() {
  reset();
  setPolicies([{ thresholdId: 'T-CANCEL-TEST', metric: 'CANCELLATION_RATE', direction: 'ABOVE',
    thresholds: [{ threshold: 20, severity: 'HIGH' }, { threshold: 40, severity: 'CRITICAL' }] }]);
  seedDay(7, 24, { live: 5, cancelled: 15 }); // 75% → CRITICAL, cohort 20
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const rule = full.m2.rules.CANCELLATION_RATE;
  assert.strictEqual(rule.status, 'EVALUATED');
  assert.strictEqual(rule.severity, 'CRITICAL');
});

test('M3-R3 — one insight per metric ALWAYS present (including NOT_EVALUABLE)', function() {
  reset();
  seedDay(7, 24, { live: 8, cancelled: 6, completed: 6 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const metricInsights = full.m2.insights.filter(function(i) { return !i.combined; });
  assert.strictEqual(metricInsights.length, 4); // one per rate metric
  metricInsights.forEach(function(i) { assert.ok(i.explanation && i.explanation.length > 0); });
});

test('M3-R4 — existing combined insight preserved (reliable elevated inputs)', function() {
  reset();
  setPolicies([
    { thresholdId: 'T-CANCEL', metric: 'CANCELLATION_RATE', direction: 'ABOVE', thresholds: [{ threshold: 10, severity: 'HIGH' }] },
    { thresholdId: 'T-NOSHOW', metric: 'NO_SHOW_RATE', direction: 'ABOVE', thresholds: [{ threshold: 10, severity: 'HIGH' }] }
  ]);
  seedDay(7, 24, { live: 4, cancelled: 8, noShow: 8 }); // both elevated, cohort 20
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const combos = full.m2.insights.filter(function(i) { return i.combined; });
  assert.ok(combos.some(function(c) { return c.patternId === 'ATTENDANCE_BEHAVIOR_PATTERN'; }));
});

test('M3-R5 — recommendation preserved and surfaced as MANAGEMENT NOTES (never Actions)', function() {
  reset();
  setPolicies([{ thresholdId: 'T-CANCEL', metric: 'CANCELLATION_RATE', direction: 'ABOVE',
    thresholds: [{ threshold: 10, severity: 'HIGH' }] }]);
  seedDay(7, 24, { live: 5, cancelled: 15 }); // HIGH → has a recommendation
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const summary = ERS.project(full);
  assert.ok(summary.managementNotes.length > 0);
  // The note text equals the M2 recommendation verbatim.
  const cancelInsight = full.m2.insights.filter(function(i) { return i.metric === 'CANCELLATION_RATE' && !i.combined; })[0];
  assert.ok(summary.managementNotes.some(function(n) { return n.note === cancelInsight.recommendation; }));
  // No "Actions" surface anywhere in the projection.
  assert.strictEqual(summary.hasOwnProperty('actions'), false);
  assert.strictEqual(summary.hasOwnProperty('Actions'), false);
});

// ═══════════════════════════════════════════════════════════════
// TREND
// ═══════════════════════════════════════════════════════════════

test('M3-T1 — trend available: both current and previous comparable periods AVAILABLE', function() {
  reset();
  seedDays(
    buildDay(7, 23, { live: 10, cancelled: 5 }),  // previous day
    buildDay(7, 24, { live: 10, cancelled: 8 })   // current day
  );
  const full = fullOf('DAILY', dayPeriodRef(7, 24), { includeTrend: true });
  assert.strictEqual(full.m2.trend.available, true);
  const t = full.m2.trend.metrics.CANCELLATION_RATE;
  assert.strictEqual(t.available, true);
  assert.ok(['TREND_UP', 'TREND_DOWN', 'TREND_FLAT'].indexOf(t.direction) !== -1);
});

test('M3-T2 — previous period unavailable: trend metric marked unavailable, current preserved', function() {
  reset();
  // Current day has data; previous day is empty → previous cohort 0.
  seedDay(7, 24, { live: 10, cancelled: 8 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24), { includeTrend: true });
  const t = full.m2.trend.metrics.CANCELLATION_RATE;
  assert.strictEqual(t.available, false);
  // current rate still fully available in the rates section
  assert.strictEqual(full.m2.rates.CANCELLATION_RATE.status, 'AVAILABLE');
});

test('M3-T3 — trend disabled by option: trend is null (no extra batch)', function() {
  reset();
  seedDay(7, 24, { live: 10, cancelled: 8 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24), { includeTrend: false });
  assert.strictEqual(full.m2.trend, null);
});

test('M3-T4 — trend must NOT modify severity', function() {
  reset();
  setPolicies([{ thresholdId: 'T-CANCEL', metric: 'CANCELLATION_RATE', direction: 'ABOVE',
    thresholds: [{ threshold: 20, severity: 'HIGH' }] }]);
  // Same current data; only the trend option differs.
  const build = function() {
    return [buildDay(7, 23, { live: 15, cancelled: 5 }), buildDay(7, 24, { live: 5, cancelled: 15 })];
  };
  seedDays.apply(null, build());
  const withTrend = fullOf('DAILY', dayPeriodRef(7, 24), { includeTrend: true });
  seedDays.apply(null, build());
  const withoutTrend = fullOf('DAILY', dayPeriodRef(7, 24), { includeTrend: false });
  assert.strictEqual(withTrend.m2.trend.available, true);
  assert.strictEqual(
    withTrend.m2.rules.CANCELLATION_RATE.severity,
    withoutTrend.m2.rules.CANCELLATION_RATE.severity,
    'trend must not change severity'
  );
});

// ═══════════════════════════════════════════════════════════════
// FULL — canonical content / provenance / no silent loss
// ═══════════════════════════════════════════════════════════════

test('M3-F1 — FULL carries all canonical sections (Doctor-Dashboard readiness)', function() {
  reset();
  seedDay(7, 24, { live: 5, cancelled: 3, completed: 7, noShow: 2, changed: 1 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  assert.strictEqual(full.schema, 'M3-ENHANCED-REPORT-v1');
  assert.strictEqual(full.representation, 'FULL');
  ['period', 'availability', 'm1', 'm2', 'provenance', 'metadata'].forEach(function(k) {
    assert.ok(full.hasOwnProperty(k), 'FULL missing ' + k);
  });
  // M1 canonical envelopes + status breakdown present.
  assert.strictEqual(Object.keys(full.m1.metrics).length, 6);
  assert.ok(full.m1.statusBreakdown);
  // M2 rates + rules + insights + cohort + governance present.
  assert.strictEqual(Object.keys(full.m2.rates).length, 4);
  assert.strictEqual(Object.keys(full.m2.rules).length, 4);
  assert.ok(Array.isArray(full.m2.insights));
  assert.ok(full.m2.cohort && typeof full.m2.cohort.total === 'number');
  assert.strictEqual(full.m2.minimumCohort, 10);
  assert.ok(full.m2.thresholdPolicy);
});

test('M3-F2 — FULL preserves the walkable rate provenance chain (foundation provenance)', function() {
  reset();
  seedDay(7, 24, { live: 5, cancelled: 3, completed: 7 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const prov = full.m2.rates.CANCELLATION_RATE.provenance;
  assert.ok(prov, 'foundation provenance preserved');
  assert.ok(prov.evidence && prov.evidence.source === 'B6_LIFECYCLE');
  assert.ok(typeof prov.cohortDefinition === 'string' && prov.cohortDefinition.length > 0);
  assert.ok(prov.cohortByPath);
});

test('M3-F3 — FULL data-quality provenance records every honest gap (no silent loss)', function() {
  reset();
  seedDay(7, 24, { free: 3 }); // cohort 0 → all rates ZERO_DENOMINATOR
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const dq = full.provenance.dataQuality;
  assert.strictEqual(dq.m2.cohortTotal, 0);
  assert.strictEqual(dq.m2.rateGaps.length, 4);
  dq.m2.rateGaps.forEach(function(g) { assert.strictEqual(g.reason, 'ZERO_DENOMINATOR'); });
});

test('M3-F4 — generatedAt is metadata ONLY and does not alter the period', function() {
  reset();
  seedDay(7, 24, { live: 3, cancelled: 2 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  // generatedAt reflects the fixed clock; period derives from reference.
  assert.strictEqual(full.metadata.generatedAtMs, NOW_MS);
  const expected = sandbox.ReportPeriod.periodFor('DAILY', dayPeriodRef(7, 24)).data;
  assert.strictEqual(full.period.startMs, expected.startMs);
  assert.strictEqual(full.period.endMs, expected.endMs);
});

// ═══════════════════════════════════════════════════════════════
// SUMMARY — projection only
// ═══════════════════════════════════════════════════════════════

test('M3-S1 — SUMMARY is a pure projection of FULL (no service calls, no recompute)', function() {
  reset();
  seedDay(7, 24, { live: 5, cancelled: 3, completed: 7 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const before = { q: jsonClone(state.queryCalls), h: jsonClone(state.headerCalls) };
  const summary = ERS.project(full); // pure transform
  const after = { q: jsonClone(state.queryCalls), h: jsonClone(state.headerCalls) };
  assert.deepStrictEqual(before, after, 'project() must not read any source');
  assert.strictEqual(summary.representation, 'SUMMARY');
  assert.strictEqual(summary.metadata.projectionOf, 'FULL');
});

test('M3-S2 — SUMMARY values equal FULL values exactly (no recalculation)', function() {
  reset();
  seedDay(7, 24, { live: 5, cancelled: 3, completed: 7, noShow: 1 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const summary = ERS.project(full);
  summary.rates.forEach(function(sr) {
    assert.strictEqual(sr.value, full.m2.rates[sr.metric].value, sr.metric + ' rate value must match FULL');
    assert.strictEqual(sr.severity, full.m2.rules[sr.metric].severity, sr.metric + ' severity must match FULL');
  });
  summary.metrics.forEach(function(sm) {
    const env = full.m1.metrics[sm.metric];
    const expected = env.status === 'AVAILABLE' ? env.value : null;
    assert.strictEqual(sm.value, expected, sm.metric + ' metric value must match FULL');
  });
});

test('M3-S3 — SUMMARY introduces NO new severity beyond FULL rules', function() {
  reset();
  seedDay(7, 24, { live: 8, cancelled: 6, completed: 6 }); // RULE_NOT_CONFIGURED
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const summary = ERS.project(full);
  summary.rates.forEach(function(sr) {
    // No policy approved → severity must remain null (never invented).
    assert.strictEqual(sr.severity, null);
  });
});

test('M3-S4 — SUMMARY preserves canonical insight order (no new ranking / no Top Findings)', function() {
  reset();
  setPolicies([
    { thresholdId: 'T-CANCEL', metric: 'CANCELLATION_RATE', direction: 'ABOVE', thresholds: [{ threshold: 10, severity: 'HIGH' }] },
    { thresholdId: 'T-NOSHOW', metric: 'NO_SHOW_RATE', direction: 'ABOVE', thresholds: [{ threshold: 10, severity: 'HIGH' }] }
  ]);
  seedDay(7, 24, { live: 4, cancelled: 8, noShow: 8 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const summary = ERS.project(full);
  // Same set + same order as FULL insights (that carry text).
  const fullOrder = full.m2.insights.filter(function(i) { return i.explanation; })
    .map(function(i) { return i.insightId; });
  const sumOrder = summary.insights.map(function(i) { return i.insightId; });
  assert.deepStrictEqual(sumOrder, fullOrder, 'no re-ranking in SUMMARY');
  assert.strictEqual(summary.hasOwnProperty('topFindings'), false);
  assert.strictEqual(summary.hasOwnProperty('ranking'), false);
});

test('M3-S5 — SUMMARY data-quality warnings preserved when relevant', function() {
  reset();
  seedDay(7, 24, { free: 3 }); // cohort 0 → rate gaps
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const summary = ERS.project(full);
  assert.ok(summary.dataQualityWarnings.length >= 4);
  assert.ok(summary.dataQualityWarnings.some(function(w) {
    return w.scope === 'M2_RATE' && /ZERO_DENOMINATOR/.test(w.detail);
  }));
});

test('M3-S6 — SUMMARY adds no causal language to insight/note text (verbatim only)', function() {
  reset();
  setPolicies([{ thresholdId: 'T-CANCEL', metric: 'CANCELLATION_RATE', direction: 'ABOVE',
    thresholds: [{ threshold: 10, severity: 'HIGH' }] }]);
  seedDay(7, 24, { live: 5, cancelled: 15 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const summary = ERS.project(full);
  // Every summary insight text must be byte-identical to a FULL insight
  // explanation (SUMMARY never rewrites or adds causal phrasing).
  const fullTexts = full.m2.insights.map(function(i) { return i.explanation; });
  summary.insights.forEach(function(si) {
    assert.ok(fullTexts.indexOf(si.explanation) !== -1, 'insight text must be verbatim from FULL');
  });
  summary.managementNotes.forEach(function(n) {
    const fromFull = full.m2.insights.some(function(i) { return i.recommendation === n.note; });
    assert.ok(fromFull, 'note text must be verbatim from FULL');
  });
});

test('M3-S7 — SUMMARY keeps UNAVAILABLE honest (never converted to 0 / healthy)', function() {
  reset();
  seedDay(7, 24, { free: 3 }); // cohort 0
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const summary = ERS.project(full);
  summary.rates.forEach(function(sr) {
    assert.strictEqual(sr.status, 'UNAVAILABLE');
    assert.strictEqual(sr.value, null); // never 0
  });
});

// ═══════════════════════════════════════════════════════════════
// RENDERER
// ═══════════════════════════════════════════════════════════════

test('M3-RND1 — renders FULL and SUMMARY deterministically (byte-identical repeats)', function() {
  reset();
  seedDay(7, 24, { live: 5, cancelled: 3, completed: 7 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const summary = ERS.project(full);
  const f1 = ERR.render(full), f2 = ERR.render(full);
  const s1 = ERR.render(summary), s2 = ERR.render(summary);
  assert.strictEqual(f1.ok, true); assert.strictEqual(s1.ok, true);
  assert.strictEqual(f1.data, f2.data);
  assert.strictEqual(s1.data, s2.data);
  assert.ok(f1.data.indexOf('HAMZAWE DAILY ENHANCED REPORT (FULL)') !== -1);
  assert.ok(s1.data.indexOf('(SUMMARY)') !== -1);
});

test('M3-RND2 — renderer prints Management Notes header, never Actions', function() {
  reset();
  setPolicies([{ thresholdId: 'T-CANCEL', metric: 'CANCELLATION_RATE', direction: 'ABOVE',
    thresholds: [{ threshold: 10, severity: 'HIGH' }] }]);
  seedDay(7, 24, { live: 5, cancelled: 15 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const text = ERR.render(full).data;
  assert.ok(text.indexOf('MANAGEMENT NOTES') !== -1);
  assert.strictEqual(/\bACTIONS\b/.test(text), false);
});

test('M3-RND3 — renderer prints valid zero as 0, UNAVAILABLE with status (never a value)', function() {
  reset();
  seedDay(7, 24, { free: 3 }); // rates UNAVAILABLE, metrics like cancellations = 0
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  const text = ERR.render(full).data;
  assert.ok(/OFFICIAL_CANCELLATIONS: 0/.test(text));           // valid zero
  assert.ok(/CANCELLATION_RATE: UNAVAILABLE/.test(text));      // honest, no value
});

test('M3-RND4 — renderer rejects a non-model input cleanly', function() {
  reset();
  const r = ERR.render({ nonsense: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'ENHANCED_REPORT_INVALID');
});

test('M3-RND6 — renderer NEVER throws on a malformed model: Result.fail, not a TypeError', function() {
  reset();
  // A structurally plausible envelope but missing the collections each
  // render path dereferences. Before hardening, FULL would throw on
  // model.m1.requestedMetrics / SUMMARY on model.metrics.length.
  const baseEnvelope = function(rep) {
    return {
      representation: rep,
      reportType: 'DAILY',
      period: { startWallClock: 'a', endWallClock: 'b', timeZone: 'Asia/Baghdad' },
      availability: { status: 'COMPLETE' }
    };
  };

  const cases = [
    ['FULL missing m1 entirely', baseEnvelope('FULL')],
    ['FULL m1 without metrics', Object.assign(baseEnvelope('FULL'), { m1: {} })],
    ['FULL missing m2', Object.assign(baseEnvelope('FULL'), { m1: { metrics: {} } })],
    ['FULL m2 without rates', Object.assign(baseEnvelope('FULL'), { m1: { metrics: {} }, m2: {} })],
    ['FULL metrics is an array not object', Object.assign(baseEnvelope('FULL'), { m1: { metrics: [] }, m2: { rates: {} } })],
    ['SUMMARY missing metrics/rates', baseEnvelope('SUMMARY')],
    ['SUMMARY metrics not an array', Object.assign(baseEnvelope('SUMMARY'), { metrics: {}, rates: [] })],
    ['SUMMARY rates not an array', Object.assign(baseEnvelope('SUMMARY'), { metrics: [], rates: {} })],
    ['unknown representation', Object.assign(baseEnvelope('FULL'), { representation: 'WEIRD' })],
    ['null model', null],
    ['non-object model', 42],
    ['array model', []]
  ];

  cases.forEach(function(c) {
    var r;
    assert.doesNotThrow(function() { r = ERR.render(c[1]); }, 'renderer must not throw: ' + c[0]);
    assert.strictEqual(r.ok, false, 'must fail: ' + c[0]);
    assert.strictEqual(r.error.code, 'ENHANCED_REPORT_INVALID', 'must be ENHANCED_REPORT_INVALID: ' + c[0]);
  });
});

test('M3-RND7 — defensive: a model that passes the gate but corrupts mid-render still fails cleanly', function() {
  reset();
  seedDay(7, 24, { live: 3, cancelled: 2, completed: 5 });
  const full = fullOf('DAILY', dayPeriodRef(7, 24));
  // Poison a collection AFTER the structural gate would see valid shapes:
  // m1.metrics is a valid object, but one entry throws on property access.
  const poisoned = jsonClone(full);
  poisoned.m1.requestedMetrics = ['CONFIRMED_APPOINTMENTS'];
  Object.defineProperty(poisoned.m1.metrics, 'CONFIRMED_APPOINTMENTS', {
    enumerable: true,
    get: function() { throw new Error('boom'); }
  });
  var r;
  assert.doesNotThrow(function() { r = ERR.render(poisoned); }, 'renderer must not throw on mid-render corruption');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'ENHANCED_REPORT_INVALID');
});

test('M3-RND8 — validation itself is exception-safe: a throwing getter → ENHANCED_REPORT_INVALID', function() {
  reset();
  // A hostile model whose OWN property getters throw during validation
  // (before any render path runs). Each of the common-envelope fields is
  // read inside _isValidModel(); a throw there must NOT escape render().
  const poisonedField = function(field) {
    const m = {
      representation: 'FULL',
      reportType: 'DAILY',
      period: { startWallClock: 'a', endWallClock: 'b', timeZone: 'Asia/Baghdad' },
      availability: { status: 'COMPLETE' },
      m1: { metrics: {} },
      m2: { rates: {} }
    };
    Object.defineProperty(m, field, { enumerable: true, get: function() { throw new Error('boom:' + field); } });
    return m;
  };

  ['representation', 'reportType', 'period', 'availability', 'm1', 'm2'].forEach(function(field) {
    var r;
    assert.doesNotThrow(function() { r = ERR.render(poisonedField(field)); },
      'render() must not throw when validation reads a poisoned ' + field);
    assert.strictEqual(r.ok, false, 'must fail on poisoned ' + field);
    assert.strictEqual(r.error.code, 'ENHANCED_REPORT_INVALID', 'poisoned ' + field);
  });

  // Also a nested throwing getter (period.startWallClock) read during the
  // common-envelope check.
  const nested = {
    representation: 'FULL',
    reportType: 'DAILY',
    period: {},
    availability: { status: 'COMPLETE' },
    m1: { metrics: {} },
    m2: { rates: {} }
  };
  Object.defineProperty(nested.period, 'startWallClock', { enumerable: true, get: function() { throw new Error('boom:nested'); } });
  var rn;
  assert.doesNotThrow(function() { rn = ERR.render(nested); }, 'render() must not throw on a nested poisoned getter');
  assert.strictEqual(rn.ok, false);
  assert.strictEqual(rn.error.code, 'ENHANCED_REPORT_INVALID');
});

test('M3-RND5 — trend renders as a compact marker only (no causal sentence)', function() {
  reset();
  seedDays(buildDay(7, 23, { live: 15, cancelled: 5 }), buildDay(7, 24, { live: 5, cancelled: 15 }));
  const full = fullOf('DAILY', dayPeriodRef(7, 24), { includeTrend: true });
  const text = ERR.render(full).data;
  // A direction marker appears; no causal words like "because".
  assert.ok(/[↑↓→]/.test(text));
  assert.strictEqual(/because|بسبب/i.test(text), false);
});

// ═══════════════════════════════════════════════════════════════
// DETERMINISM
// ═══════════════════════════════════════════════════════════════

test('M3-D1 — same input twice → deep-equal FULL, SUMMARY, and rendering', function() {
  const runOnce = function() {
    reset();
    setPolicies([{ thresholdId: 'T-CANCEL', metric: 'CANCELLATION_RATE', direction: 'ABOVE',
      thresholds: [{ threshold: 20, severity: 'HIGH' }] }]);
    seedDays(buildDay(7, 23, { live: 12, cancelled: 8 }), buildDay(7, 24, { live: 5, cancelled: 15, completed: 4 }));
    const res = ERS.generate('DAILY', dayPeriodRef(7, 24), { includeTrend: true });
    assert.strictEqual(res.ok, true);
    return {
      full: jsonClone(res.data.full),
      summary: jsonClone(res.data.summary),
      renderFull: ERR.render(res.data.full).data,
      renderSummary: ERR.render(res.data.summary).data
    };
  };
  const a = runOnce();
  const b = runOnce();
  assert.deepStrictEqual(a.full, b.full);
  assert.deepStrictEqual(a.summary, b.summary);
  assert.strictEqual(a.renderFull, b.renderFull);
  assert.strictEqual(a.renderSummary, b.renderSummary);
});

// ═══════════════════════════════════════════════════════════════
// READ-ONLY / DEPENDENCY DIRECTION
// ═══════════════════════════════════════════════════════════════

test('M3-X1 — generating every report type writes nothing and creates no sheet', function() {
  reset();
  seedDay(7, 24, { live: 5, cancelled: 3, completed: 7, noShow: 2, changed: 1 });
  ['DAILY', 'WEEKLY', 'MONTHLY'].forEach(function(type) {
    const r = ERS.generate(type, dayPeriodRef(7, 24), { includeTrend: true });
    assert.strictEqual(r.ok, true);
    ERR.render(r.data.full);
    ERR.render(r.data.summary);
  });
  assert.strictEqual(state.writes, 0, 'M3 must perform no writes');
  assert.strictEqual(state.sheetCreates, 0, 'M3 must create no sheets');
});

test('M3-X2 — forbidden dependency scan: M3 files import no repositories / Sheets / Calendar / attendance / notification / billing', function() {
  const files = ['Application/EnhancedReportService.js', 'Application/EnhancedReportRenderer.js'];
  const forbidden = [
    /GoogleSheets/, /GoogleCalendar/, /SpreadsheetApp/, /CalendarApp/, /UrlFetchApp/,
    /Repository\b/, /SlotRepository/, /AttendanceAudit/, /B6LifecycleRepository/,
    /WhatsAppAdapter/, /Reminderservice/, /Reminder/i,
    /AttendanceService/, /AttendanceAddOn/,
    /price|cost|billable|invoice|charge|customer_fee/i,
    /SettingsRepository/, /Scheduler/, /Webhook/
  ];
  files.forEach(function(rel) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    forbidden.forEach(function(rx) {
      assert.strictEqual(rx.test(code), false, rel + ' must not reference ' + rx);
    });
  });
});

test('M3-X3 — dependency direction: M3 references only M1/M2 public APIs + ReportPeriod/Clock/Result', function() {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'Application/EnhancedReportService.js'), 'utf8'));
  // Allowed upstream references (call-time bound).
  assert.ok(/ReportService/.test(code), 'must consume M1 ReportService');
  assert.ok(/RateRuleService/.test(code), 'must consume M2 RateRuleService');
  assert.ok(/ReportPeriod/.test(code), 'must use ReportPeriod');
  // Must NOT reach into the raw foundation read internals directly for
  // composition (the model rates come from RateRuleService output).
  assert.strictEqual(/RateFoundationService/.test(code), false,
    'M3 composes over RateRuleService output, not RateFoundationService directly');
});

test('M3-X4 — clasp alphabetical evaluation-order independence (call-time bindings)', function() {
  // EnhancedReport* sorts BEFORE MetricsService/Rate*/Report*/Utils; the
  // full stack must still resolve because every reference is call-time.
  const sb = vm.createContext({ console: console });
  const fixed = { nowMs: NOW_MS };
  sb.Clock = { now: function() { return new Date(fixed.nowMs); } };
  const localSheets = {};
  sb.GoogleSheets = {
    getHeaders: function(name) { const s = localSheets[name]; if (!s) throw new Error('SHEET_NOT_FOUND: ' + name); return s.headers.slice(); },
    queryRows: function(name, pred) { const s = localSheets[name]; if (!s) throw new Error('SHEET_NOT_FOUND: ' + name); return s.rows.map(function(r, i) { return Object.assign({ _rowNumber: i + 2 }, r); }).filter(pred).map(function(r) { return Object.assign({}, r); }); }
  };
  vm.runInContext('this.mkVmDate = function(ms) { return new Date(ms); };', sb);

  // Load in ALPHABETICAL order (EnhancedReport* first).
  const alpha = [
    ['Application/EnhancedReportRenderer.js', 'EnhancedReportRenderer'],
    ['Application/EnhancedReportService.js', 'EnhancedReportService'],
    ['Application/MetricsService.js', 'MetricsService'],
    ['Application/RateFoundationService.js', 'RateFoundationService'],
    ['Application/RateRuleService.js', 'RateRuleService'],
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
  // B6LifecycleService is a dependency of the repositories path; load it too.
  alpha.splice(2, 0, ['Application/B6LifecycleService.js', 'B6LifecycleService']);
  alpha.forEach(function(entry) {
    const src = fs.readFileSync(path.join(ROOT, entry[0]), 'utf8');
    vm.runInContext(src + '\nthis.' + entry[1] + ' = ' + entry[1] + ';', sb, { filename: entry[0] });
  });
  // Sanity: EnhancedReportService evaluated before ReportService/ReportPeriod.
  assert.ok(Object.keys(sb).indexOf('EnhancedReportService') < Object.keys(sb).indexOf('ReportService'));
  assert.ok(Object.keys(sb).indexOf('EnhancedReportService') < Object.keys(sb).indexOf('ReportPeriod'));

  localSheets['Availability'] = { headers: AV_HEADERS.slice(), rows: [
    { slot_id: 'L1', date: '2026/08/24', time: '10:00', sort_key: sortKeyOf(D(7, 24, 10, 0)), status: 'CONFIRMED', is_available: true, patient_name: 'P', phone: PHONE, calendar_event_id: '', Reminder_sent: '', whatsapp_message_id: '', reserved_until: '', reserved_until_unix: '' }
  ] };
  localSheets['B6_LIFECYCLE'] = { headers: sb.B6LifecycleRepository.HEADERS.slice(), rows: [] };
  localSheets['ATTENDANCE_AUDIT'] = { headers: sb.AttendanceAuditRepository.HEADERS.slice(), rows: [] };

  const res = sb.EnhancedReportService.generate('DAILY', dayPeriodRef(7, 24));
  assert.strictEqual(res.ok, true, 'call-time bindings must resolve despite alphabetical load order');
  assert.strictEqual(res.data.full.representation, 'FULL');
  assert.strictEqual(res.data.summary.representation, 'SUMMARY');
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
