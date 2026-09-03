'use strict';

/**
 * HardeningM4E.test.js — M4-E Affected Appointment Discovery / Impact Preview
 *
 * Contract: HAMZAWE M4-E frozen session contract (2026-09-02).
 *
 * Acceptance mapping (contract §18 minimum hardening coverage):
 *   M4E-01  affected CONFIRMED discovered
 *   M4E-02  active affected RESERVED discovered
 *   M4E-03  FREE unavailable excluded
 *   M4E-04  terminal unavailable excluded
 *   M4E-05  expired RESERVED excluded
 *   M4E-06/07 RESERVED expiry boundary (strict > evaluatedAtMs)
 *   M4E-08  malformed RESERVED expiry reported
 *   M4E-09  confirmed before reserved
 *   M4E-10  deterministic within-class ordering
 *   M4E-11/12 malformed sort_key reported/excluded
 *   M4E-13  exact [from,to) boundaries
 *   M4E-14  Clock.now() captured once for the operation
 *   M4E-15  source failure returns Result.fail (source-level injection)
 *   M4E-16  repeated unchanged discovery deterministic
 *   M4E-17  no writes occur
 *   M4E-18  no Calendar calls occur
 *   M4E-19  no patient PII in default DTO
 *   M4E-20  scope preserved
 *   M4E-21  completeness says CURRENT_MATERIALIZED_VIEW
 *   M4E-22  no durable journal
 *   M4E-23  no EffectiveSchedule recomputation inside M4-E
 *   M4E-24  no second selector/state machine/repository/store/scheduler
 *   M4E-25  invalid window rejected (fail-closed)
 *   M4E-26  invalid scope rejected (fail-closed)
 *   M4E-27  empty discovery is ok-with-zero, distinct from source failure
 *   M4E-28  is_available canonical variants
 *   M4E-29  Date-instance window bounds accepted
 *   M4E-30  diagnostics semantics deterministic under shuffled storage order
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const EVAL_ISO = '2026-09-03T06:00:00.000Z';
const EVAL_MS = Date.parse(EVAL_ISO);

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
    locks: 0,
    logs: [],
    clockCalls: 0,
    nowIso: EVAL_ISO,
    seq: 0
  };

  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sandbox.Utilities = { formatDate: function(date) { return String(date); } };

  function sheetStore(name) {
    if (!state.sheets[name]) { state.sheets[name] = { headers: [], rows: [] }; }
    return state.sheets[name];
  }

  sandbox.GoogleSheets = {
    getAllRows: function(name) {
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
      return sheet.rows.map(function(r) { return Object.assign({}, r); });
    },
    queryRows: function(name, predicateFn) {
      return sandbox.GoogleSheets.getAllRows(name).filter(predicateFn);
    },
    getHeaders: function(name) {
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      return sheet.headers.slice();
    },
    findRowByColumn: function() {
      throw new Error('M4E_MUST_NOT_USE_FIND');
    },
    appendRow: function() {
      state.writes.push('appendRow');
      throw new Error('M4E_MUST_NOT_WRITE');
    },
    appendRows: function() {
      state.writes.push('appendRows');
      throw new Error('M4E_MUST_NOT_WRITE');
    },
    updateRowByColumn: function() {
      state.updates += 1;
      throw new Error('M4E_MUST_NOT_WRITE');
    },
    updateBatch: function() {
      state.updates += 1;
      throw new Error('M4E_MUST_NOT_WRITE');
    },
    deleteRowsByNumbers: function() {
      state.deletes += 1;
      throw new Error('M4E_MUST_NOT_DELETE');
    },
    getOrCreateSheet: function() {
      state.writes.push('getOrCreateSheet');
      throw new Error('M4E_MUST_NOT_CREATE_SHEET');
    }
  };

  sandbox.GoogleCalendar = {
    createEvent: function() { state.calendar += 1; throw new Error('M4E_MUST_NOT_CALENDAR'); },
    deleteEvent: function() { state.calendar += 1; throw new Error('M4E_MUST_NOT_CALENDAR'); },
    getEventById: function() { state.calendar += 1; throw new Error('M4E_MUST_NOT_CALENDAR'); }
  };
  sandbox.WhatsAppAdapter = {
    sendMessage: function() { state.sends += 1; throw new Error('M4E_MUST_NOT_SEND'); }
  };
  sandbox.Lock = {
    runExclusive: function() { state.locks += 1; throw new Error('M4E_MUST_NOT_LOCK'); }
  };
  sandbox.LockService = {
    getScriptLock: function() { state.locks += 1; throw new Error('M4E_MUST_NOT_LOCK'); },
    getUserLock: function() { state.locks += 1; throw new Error('M4E_MUST_NOT_LOCK'); }
  };
  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return { getProperty: function() { return null; }, setProperty: function() {} };
    }
  };

  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
  }

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('Clock.js', 'Clock');
  sandbox.Clock.now = function() {
    state.clockCalls += 1;
    return new Date(state.nowIso);
  };
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('Application/AffectedAppointmentDiscoveryService.js', 'AffectedAppointmentDiscoveryService');

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;
const SVC = sandbox.AffectedAppointmentDiscoveryService;

// ── Helpers ──

function resetAvailability() {
  state.sheets['Availability'] = {
    headers: [
      'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
      'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
      'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
    ],
    rows: []
  };
  state.failRead = {};
  state.writes = [];
  state.updates = 0;
  state.deletes = 0;
  state.sends = 0;
  state.calendar = 0;
  state.locks = 0;
  state.logs = [];
  state.clockCalls = 0;
  state.nowIso = EVAL_ISO;
}

function seedSlot(fields) {
  state.seq += 1;
  const slot = Object.assign({
    slot_id: 'SLT_M4E_' + String(state.seq).padStart(3, '0'),
    date: '2026/09/04',
    time: '09:00',
    sort_key: '202609040900',
    status: 'FREE',
    is_available: true,
    patient_name: '',
    phone: '',
    calendar_event_id: '',
    Reminder_sent: '',
    whatsapp_message_id: '',
    reserved_until: '',
    reserved_until_unix: ''
  }, fields || {});
  state.sheets['Availability'].rows.push(slot);
  return slot;
}

// sort_key → epoch ms via the SAME canonical parser the service must use.
function stamp(sortKey) {
  return sandbox.LegacySlotTimeParser.toComparableTime(sortKey);
}

function dayWindow(dayKey, nextDayKey) {
  return { from: stamp(dayKey || '202609040000'), to: stamp(nextDayKey || '202609050000') };
}

function discover(overrides) {
  const request = Object.assign(dayWindow(), overrides || {});
  return SVC.discoverAffected(request);
}

// Sandbox results are created in another vm realm; their prototypes differ
// from this realm's, so deepStrictEqual needs realm-neutral plain data.
function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// ── M4E-01: affected CONFIRMED discovered ──

test('M4E-01 — affected CONFIRMED discovered with exact default DTO', function() {
  resetAvailability();
  seedSlot({
    slot_id: 'SLT_A', sort_key: '202609041000', date: '2026/09/04', time: '10:00',
    status: 'CONFIRMED', is_available: false,
    patient_name: 'ALICE', phone: '9647005550001', calendar_event_id: 'EVT_1'
  });

  const r = discover();
  assert.strictEqual(r.ok, true, 'discovery should succeed');
  assert.strictEqual(r.data.counts.total, 1, 'one affected appointment');
  assert.strictEqual(r.data.affectedConfirmed.length, 1);
  assert.strictEqual(r.data.affectedReserved.length, 0);

  const item = r.data.affectedConfirmed[0];
  assert.strictEqual(item.slotId, 'SLT_A');
  assert.strictEqual(item.status, 'CONFIRMED');
  assert.strictEqual(item.scheduledDate, '2026/09/04');
  assert.strictEqual(item.scheduledTime, '10:00');
  assert.strictEqual(item.isAvailable, false);
  assert.strictEqual(item.impactReason, 'OPERATIONALLY_UNAVAILABLE');
  assert.strictEqual(item.impactReasonSource, 'SLOT_IS_AVAILABLE');
});

// ── M4E-02: active affected RESERVED discovered ──

test('M4E-02 — active affected RESERVED discovered', function() {
  resetAvailability();
  seedSlot({
    slot_id: 'SLT_R', sort_key: '202609041030', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000
  });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.counts.reserved, 1);
  assert.strictEqual(r.data.affectedReserved[0].slotId, 'SLT_R');
  assert.strictEqual(r.data.affectedReserved[0].status, 'RESERVED');
});

// ── M4E-03: FREE unavailable excluded ──

test('M4E-03 — FREE unavailable excluded', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_F', sort_key: '202609041000', status: 'FREE', is_available: false });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.counts.total, 0, 'FREE slots are never affected appointments');
  assert.strictEqual(r.data.diagnostics.length, 0, 'exclusion is not a diagnostic');
});

// ── M4E-04: terminal unavailable excluded ──

test('M4E-04 — terminal unavailable excluded', function() {
  resetAvailability();
  ['COMPLETED', 'NO_SHOW', 'EXPIRED', 'CANCELLED'].forEach(function(status, i) {
    seedSlot({
      slot_id: 'SLT_T' + i, sort_key: '2026090411' + String(i * 10).padStart(2, '0'),
      status: status, is_available: false
    });
  });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.counts.total, 0, 'terminal slots are never actionable');
});

// ── M4E-05/06/07: RESERVED expiry semantics ──

test('M4E-05 — expired RESERVED excluded', function() {
  resetAvailability();
  seedSlot({
    slot_id: 'SLT_EXP', sort_key: '202609041000', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS - 1
  });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.counts.total, 0, 'expired reservation is not actionable');
  assert.strictEqual(r.data.diagnostics.length, 0, 'expired is an excluded class, not malformed');
});

test('M4E-06 — RESERVED with reserved_until_unix === evaluatedAtMs excluded (strict >)', function() {
  resetAvailability();
  seedSlot({
    slot_id: 'SLT_EDGE', sort_key: '202609041000', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS
  });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.counts.total, 0);
});

test('M4E-07 — RESERVED with reserved_until_unix === evaluatedAtMs + 1 is actionable', function() {
  resetAvailability();
  seedSlot({
    slot_id: 'SLT_ACTIVE', sort_key: '202609041000', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 1
  });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.counts.reserved, 1);
});

// ── M4E-08: malformed RESERVED expiry reported ──

test('M4E-08 — malformed RESERVED expiry reported in diagnostics and excluded', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_ME1', sort_key: '202609041000', status: 'RESERVED',
    is_available: false, reserved_until_unix: '' });
  seedSlot({ slot_id: 'SLT_ME2', sort_key: '202609041100', status: 'RESERVED',
    is_available: false, reserved_until_unix: 'abc' });
  const noExpiry = seedSlot({ slot_id: 'SLT_ME3', sort_key: '202609041200', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000 });
  delete noExpiry.reserved_until_unix; // missing field entirely

  const r = discover();
  assert.strictEqual(r.ok, true, 'row-level malformation must not fail the source');
  assert.strictEqual(r.data.counts.total, 0, 'malformed expiry rows are never actionable');
  assert.strictEqual(r.data.counts.malformed, 3);
  const codes = plain(r.data.diagnostics.map(function(d) { return d.code; }));
  assert.deepStrictEqual(codes, [
    'MALFORMED_RESERVATION_EXPIRY',
    'MALFORMED_RESERVATION_EXPIRY',
    'MALFORMED_RESERVATION_EXPIRY'
  ]);
  const ids = plain(r.data.diagnostics.map(function(d) { return d.slotId; })).sort();
  assert.deepStrictEqual(ids, ['SLT_ME1', 'SLT_ME2', 'SLT_ME3'],
    'diagnostics carry evidence identity and are deterministically ordered');
  assert.ok(r.data.diagnostics[0].evidence.hasOwnProperty('rawReservedUntilUnix'),
    'diagnostic evidence preserved');
});

// ── M4E-09: confirmed before reserved ──

test('M4E-09 — all affected CONFIRMED returned before affected RESERVED', function() {
  resetAvailability();
  // RESERVED stored first with an earlier start than the CONFIRMED one:
  seedSlot({ slot_id: 'SLT_R1', sort_key: '202609040900', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000 });
  seedSlot({ slot_id: 'SLT_C1', sort_key: '202609041000', status: 'CONFIRMED',
    is_available: false });

  const r = discover();
  assert.strictEqual(r.ok, true);
  const order = plain(r.data.affected.map(function(i) { return i.status; }));
  assert.deepStrictEqual(order, ['CONFIRMED', 'RESERVED'],
    'class ordering is CONFIRMED then RESERVED regardless of start time');
  assert.strictEqual(r.data.affected[0].slotId, 'SLT_C1');
  assert.strictEqual(r.data.affected[1].slotId, 'SLT_R1');
});

// ── M4E-10: deterministic within-class ordering ──

test('M4E-10 — within-class ordering: start ascending, then slot_id ascending', function() {
  resetAvailability();
  // Seeded deliberately out of order (storage order must not matter):
  seedSlot({ slot_id: 'SLT_B', sort_key: '202609040900', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_A', sort_key: '202609040900', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_D', sort_key: '202609040800', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_R_B', sort_key: '202609041000', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000 });
  seedSlot({ slot_id: 'SLT_R_A', sort_key: '202609041000', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000 });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    plain(r.data.affectedConfirmed.map(function(i) { return i.slotId; })),
    ['SLT_D', 'SLT_A', 'SLT_B'],
    'CONFIRMED: start ascending; equal starts tie-broken by slot_id ascending'
  );
  assert.deepStrictEqual(
    plain(r.data.affectedReserved.map(function(i) { return i.slotId; })),
    ['SLT_R_A', 'SLT_R_B'],
    'RESERVED: start ascending; equal starts tie-broken by slot_id ascending'
  );
});

// ── M4E-11/12: malformed sort_key reported/excluded ──

test('M4E-11 — malformed sort_key reported as MALFORMED_SORT_KEY and excluded', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_MS1', sort_key: 'NOT_A_KEY', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_MS2', sort_key: '', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000 });
  seedSlot({ slot_id: 'SLT_OK', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });

  const r = discover();
  assert.strictEqual(r.ok, true, 'malformed rows must not fail discovery');
  assert.deepStrictEqual(plain(r.data.affectedConfirmed.map(function(i) { return i.slotId; })), ['SLT_OK'],
    'malformed rows excluded from actionable ordered output');
  assert.strictEqual(r.data.counts.malformed, 2);
  const diag = r.data.diagnostics.filter(function(d) { return d.code === 'MALFORMED_SORT_KEY'; });
  assert.strictEqual(diag.length, 2);
  assert.deepStrictEqual(plain(diag.map(function(d) { return d.slotId; })), ['SLT_MS1', 'SLT_MS2']);
  assert.ok(diag[0].evidence.hasOwnProperty('rawSortKey'), 'raw sort_key evidence preserved');
});

test('M4E-12 — non-finite sort_key value isolated as malformed (never ordered)', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_NAN', sort_key: NaN, status: 'CONFIRMED', is_available: false });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.counts.total, 0);
  assert.strictEqual(r.data.counts.malformed, 1);
  assert.strictEqual(r.data.diagnostics[0].code, 'MALFORMED_SORT_KEY');
});

// ── M4E-13: exact [from, to) boundaries ──

test('M4E-13 — exact [from, to) boundaries: from inclusive, to exclusive', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_BEFORE', sort_key: '202609040930', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_AT_FROM', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_INSIDE', sort_key: '202609041100', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_AT_TO', sort_key: '202609041200', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_AFTER', sort_key: '202609041230', status: 'CONFIRMED', is_available: false });

  const r = SVC.discoverAffected({
    from: stamp('202609041000'),
    to: stamp('202609041200')
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    plain(r.data.affectedConfirmed.map(function(i) { return i.slotId; })),
    ['SLT_AT_FROM', 'SLT_INSIDE'],
    'from inclusive, to exclusive, outside rows not discovered'
  );
  assert.strictEqual(r.data.counts.malformed, 0, 'out-of-window rows are not diagnostics');
});

// ── M4E-14: Clock.now() captured once ──

test('M4E-14 — Clock.now() captured exactly once per operation', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_R', sort_key: '202609041100', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000 });

  state.clockCalls = 0;
  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.clockCalls, 1, 'exactly one Clock.now() per discovery operation');
  assert.strictEqual(r.data.evaluatedAtMs, EVAL_MS);
  assert.strictEqual(r.data.evaluatedAt, EVAL_ISO);
});

// ── M4E-15: source failure ⇒ Result.fail ──

test('M4E-15 — source-level failure returns Result.fail, never an empty impact set', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });
  // Source-level injection: the real read path (GoogleSheets.getAllRows →
  // SlotRepository.queryResult catch) surfaces the failure — no wrapper
  // monkey-patching.
  state.failRead['Availability'] = true;

  const r = discover();
  assert.strictEqual(r.ok, false, 'source failure must fail the Result');
  assert.strictEqual(r.error.code, 'AVAILABILITY_SOURCE_FAILED');
  assert.ok(r.error.details && r.error.details.cause, 'underlying source error preserved');
  assert.strictEqual(r.data, null, 'no impact set is fabricated on source failure');
});

// ── M4E-16: determinism on unchanged source ──

test('M4E-16 — repeated discovery on unchanged rows is byte-for-byte deterministic', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C2', sort_key: '202609040900', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_C1', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_R1', sort_key: '202609041100', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000 });
  seedSlot({ slot_id: 'SLT_BAD', sort_key: 'BROKEN', status: 'RESERVED', is_available: false });

  const first = discover();
  const second = discover();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.deepStrictEqual(second.data, first.data,
    'same membership, class ordering, within-class ordering, diagnostics semantics');
});

// ── M4E-17: no writes occur ──

test('M4E-17 — discovery performs no writes (append/update/delete/sheet creation)', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_R', sort_key: '202609041100', status: 'RESERVED',
    is_available: false, reserved_until_unix: EVAL_MS + 60000 });

  const before = JSON.stringify(state.sheets['Availability'].rows);
  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.writes.length, 0, 'no row appends');
  assert.strictEqual(state.updates, 0, 'no row updates');
  assert.strictEqual(state.deletes, 0, 'no row deletes');
  assert.strictEqual(state.locks, 0, 'no locks acquired by observation');
  assert.strictEqual(state.sends, 0, 'no notification sends');
  assert.strictEqual(JSON.stringify(state.sheets['Availability'].rows), before,
    'sheet rows byte-identical after discovery');
});

// ── M4E-18: no Calendar calls ──

test('M4E-18 — discovery performs no Calendar calls', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED',
    is_available: false, calendar_event_id: 'EVT_XYZ' });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.calendar, 0, 'no Calendar infrastructure touched');
});

// ── M4E-19: no patient PII in default DTO ──

test('M4E-19 — default DTO is exactly the minimal field set with zero PII', function() {
  resetAvailability();
  seedSlot({
    slot_id: 'SLT_PII', sort_key: '202609041000', status: 'CONFIRMED', is_available: false,
    patient_name: 'ALICE_SECRET_NAME', phone: '9647001234567', calendar_event_id: 'EVT_SECRET_42'
  });
  seedSlot({
    slot_id: 'SLT_PII2', sort_key: '202609041100', status: 'RESERVED', is_available: false,
    patient_name: 'BOB_SECRET_NAME', phone: '9647007654321',
    reserved_until_unix: EVAL_MS + 60000
  });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.counts.total, 2);

  const serialized = JSON.stringify(r.data);
  ['ALICE_SECRET_NAME', 'BOB_SECRET_NAME', '9647001234567', '9647007654321', 'EVT_SECRET_42']
    .forEach(function(secret) {
      assert.strictEqual(serialized.indexOf(secret), -1, 'PII leaked: ' + secret);
    });

  const allowed = ['impactReason', 'impactReasonSource', 'isAvailable', 'scheduledDate',
    'scheduledTime', 'scope', 'slotId', 'status'];
  r.data.affected.forEach(function(item) {
    assert.deepStrictEqual(Object.keys(item).sort(), allowed,
      'DTO must contain exactly the contracted minimal fields');
  });
});

// ── M4E-20: scope preserved ──

test('M4E-20 — logical scope preserved in result and every item; default null scope', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });

  const scoped = SVC.discoverAffected(Object.assign(dayWindow(), {
    scope: { doctorId: 'DOC_123', clinicId: null }
  }));
  assert.strictEqual(scoped.ok, true);
  assert.deepStrictEqual(plain(scoped.data.scope), { doctorId: 'DOC_123', clinicId: null });
  scoped.data.affected.forEach(function(item) {
    assert.deepStrictEqual(plain(item.scope), { doctorId: 'DOC_123', clinicId: null });
  });

  const unscoped = discover();
  assert.strictEqual(unscoped.ok, true);
  assert.deepStrictEqual(plain(unscoped.data.scope), { doctorId: null, clinicId: null },
    'omitted scope defaults to null/null without failing');
});

// ── M4E-21: completeness + envelope ──

test('M4E-21 — completeness is CURRENT_MATERIALIZED_VIEW and envelope exposes all fields', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.completeness, 'CURRENT_MATERIALIZED_VIEW');
  assert.strictEqual(r.data.sourceStatus, 'READ_OK');
  assert.ok(typeof r.data.evaluatedAt === 'string');
  assert.ok(Number.isFinite(r.data.evaluatedAtMs));
  assert.deepStrictEqual(plain(r.data.window), {
    fromMs: stamp('202609040000'), toMs: stamp('202609050000')
  });
  assert.ok(Array.isArray(r.data.affected));
  assert.ok(Array.isArray(r.data.affectedConfirmed));
  assert.ok(Array.isArray(r.data.affectedReserved));
  assert.deepStrictEqual(Object.keys(r.data.counts).sort(),
    ['confirmed', 'malformed', 'reserved', 'total']);
  assert.ok(Array.isArray(r.data.diagnostics));
});

// ── M4E-22: no durable journal ──

test('M4E-22 — no durable impact journal: no sheets created, no logs, no writes', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(state.sheets), ['Availability'],
    'discovery must not create any journal/impact sheet');
  assert.strictEqual(state.writes.length, 0);
  assert.strictEqual(state.logs.length, 0, 'no log/journal records produced');
});

// ── M4E-23: no EffectiveSchedule recomputation ──

test('M4E-23 — no EffectiveSchedule recomputation inside M4-E (structural)', function() {
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'Application/AffectedAppointmentDiscoveryService.js'), 'utf8')
  );
  ['EffectiveScheduleService', 'SettingsRepository', 'ScheduleChangeRepository',
   'SlotGenerator', 'AvailabilityHorizonMaintainer', 'projectFromSources',
   'DoctorScheduleReadService', 'DoctorScheduleCommandService'].forEach(function(token) {
    assert.strictEqual(src.indexOf(token), -1,
      'M4-E must not reference schedule sources/projection: ' + token);
  });
  // No causal provenance field is invented.
  assert.strictEqual(src.indexOf('changeId'), -1, 'no ScheduleChange changeId attribution');
});

// ── M4E-24: no second selector/state machine/store/scheduler; mutation-free ──

test('M4E-24 — no second selector/state machine/repository mutation/scheduler (structural)', function() {
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'Application/AffectedAppointmentDiscoveryService.js'), 'utf8')
  );
  ['SlotSelection', 'StateMachine', 'atomicUpdate', 'Scheduler',
   'GoogleSheets', 'SpreadsheetApp', 'CalendarApp', 'GoogleCalendar',
   'WhatsAppAdapter', 'LogRepository', 'LockService', 'Lock.runExclusive',
   'ConversationRepository', 'BookingService', 'CancelService', 'Changeservice',
   'MaintenanceService', 'PropertiesService'].forEach(function(token) {
    assert.strictEqual(src.indexOf(token), -1,
      'forbidden dependency in M4-E service: ' + token);
  });

  // The Result-based bounded read is used; the legacy swallowing query() is not.
  assert.notStrictEqual(src.indexOf('queryResult('), -1, 'must use SlotRepository.queryResult');
  assert.strictEqual(src.replace(/queryResult/g, '').indexOf('.query('), -1,
    'must not use legacy SlotRepository.query (collapses source failure into [])');

  // Clock.now() appears exactly once in code.
  const clockCalls = (src.match(/Clock\.now\(/g) || []).length;
  assert.strictEqual(clockCalls, 1, 'exactly one Clock.now() call site');
});

// ── M4E-25: invalid window fail-closed ──

test('M4E-25 — invalid window rejected fail-closed, before any source read', function() {
  resetAvailability();
  state.failRead['Availability'] = true; // even with a broken source, validation wins

  const cases = [
    {},
    { from: stamp('202609040000') },
    { to: stamp('202609050000') },
    { from: '2026/09/04', to: '2026/09/05' },
    { from: stamp('202609050000'), to: stamp('202609040000') },
    { from: stamp('202609040000'), to: stamp('202609040000') }
  ];
  cases.forEach(function(request) {
    const r = SVC.discoverAffected(request);
    assert.strictEqual(r.ok, false, 'invalid window must fail: ' + JSON.stringify(request));
    assert.strictEqual(r.error.code, 'INVALID_DISCOVERY_WINDOW');
  });
  assert.strictEqual(state.clockCalls <= cases.length, true);
});

// ── M4E-26: invalid scope fail-closed ──

test('M4E-26 — invalid scope rejected fail-closed', function() {
  resetAvailability();
  ['DOC', 42, true, [1, 2]].forEach(function(badScope) {
    const r = SVC.discoverAffected(Object.assign(dayWindow(), { scope: badScope }));
    assert.strictEqual(r.ok, false, 'invalid scope must fail: ' + JSON.stringify(badScope));
    assert.strictEqual(r.error.code, 'INVALID_DISCOVERY_SCOPE');
  });
});

// ── M4E-27: empty discovery is ok-with-zero ──

test('M4E-27 — empty discovery returns ok with zero counts (distinct from source failure)', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_FREE_OK', sort_key: '202609041000', status: 'FREE', is_available: true });
  seedSlot({ slot_id: 'SLT_CONF_OK', sort_key: '202609041100', status: 'CONFIRMED', is_available: true });

  const r = discover();
  assert.strictEqual(r.ok, true, 'empty impact set is a valid observation');
  assert.strictEqual(r.data.sourceStatus, 'READ_OK');
  assert.strictEqual(r.data.counts.total, 0);
  assert.deepStrictEqual(plain(r.data.affected), []);
  assert.deepStrictEqual(plain(r.data.diagnostics), []);
});

// ── M4E-28: canonical is_available variants ──

test('M4E-28 — is_available canonical truth: false/\'FALSE\'/\'\' affected; true/\'TRUE\' not', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_V1', sort_key: '202609040900', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_V2', sort_key: '202609041000', status: 'CONFIRMED', is_available: 'FALSE' });
  seedSlot({ slot_id: 'SLT_V3', sort_key: '202609041100', status: 'CONFIRMED', is_available: '' });
  seedSlot({ slot_id: 'SLT_V4', sort_key: '202609041200', status: 'CONFIRMED', is_available: true });
  seedSlot({ slot_id: 'SLT_V5', sort_key: '202609041300', status: 'CONFIRMED', is_available: 'TRUE' });

  const r = discover();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(
    plain(r.data.affectedConfirmed.map(function(i) { return i.slotId; })),
    ['SLT_V1', 'SLT_V2', 'SLT_V3'],
    'only operationally-unavailable values are affected'
  );
});

// ── M4E-29: Date-instance window bounds accepted ──

test('M4E-29 — Date-instance window bounds accepted (constructed in-runtime)', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_D', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });

  // Dates must be created inside the service's own realm.
  const from = vm.runInContext('new Date(' + stamp('202609040000') + ')', sandbox);
  const to = vm.runInContext('new Date(' + stamp('202609050000') + ')', sandbox);
  const r = SVC.discoverAffected({ from: from, to: to });
  assert.strictEqual(r.ok, true, 'Date window bounds must be accepted');
  assert.deepStrictEqual(plain(r.data.window), {
    fromMs: stamp('202609040000'), toMs: stamp('202609050000')
  });
  assert.strictEqual(r.data.counts.total, 1);
});

// ── M4E-30: diagnostics deterministic under shuffled storage order ──

test('M4E-30 — diagnostics semantics deterministic when storage order differs', function() {
  resetAvailability();
  seedSlot({ slot_id: 'SLT_B', sort_key: 'XYZ_B', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_A', sort_key: 'XYZ_A', status: 'RESERVED', is_available: false });
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });
  const first = discover();

  // Rebuild the same logical rows in reversed physical order.
  resetAvailability();
  seedSlot({ slot_id: 'SLT_C', sort_key: '202609041000', status: 'CONFIRMED', is_available: false });
  seedSlot({ slot_id: 'SLT_A', sort_key: 'XYZ_A', status: 'RESERVED', is_available: false });
  seedSlot({ slot_id: 'SLT_B', sort_key: 'XYZ_B', status: 'CONFIRMED', is_available: false });
  const second = discover();

  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.deepStrictEqual(second.data, first.data,
    'membership, ordering, and diagnostics must not depend on storage row order');
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
