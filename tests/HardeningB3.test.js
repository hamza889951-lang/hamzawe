'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_MS = 1700000000000;

// ─────────────────────────────────────────
// Sandbox setup
// ─────────────────────────────────────────
const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(
    source + '\nthis.' + globalName + ' = ' + globalName + ';',
    sandbox,
    { filename: relativePath }
  );
}

// Load core dependencies
load('Result.js', 'Result');
load('Config.js', 'Config');

// ── Clock seam ──
var currentTimeMs = NOW_MS;
sandbox.Clock = {
  now: function() { return new Date(currentTimeMs); }
};

// ── DateUtils mock ──
sandbox.DateUtils = {
  addMinutes: function(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
  },
  formatDateDisplay: function(value) { return String(value); },
  formatTimeDisplay: function(value) { return String(value); }
};

// ── LegacySlotTimeParser mock ──
sandbox.LegacySlotTimeParser = {
  toComparableTime: function(value) {
    return typeof value === 'number' ? value : null;
  }
};

// ── Lock mock (controllable) ──
var lockShouldFail = false;
var lockKeyUsed = null;

function makeDefaultLock() {
  return {
    runExclusive: function(key, fn) {
      lockKeyUsed = key;
      if (lockShouldFail) {
        return sandbox.Result.fail('LOCK_TIMEOUT', 'Could not acquire lock for ' + key);
      }
      try {
        return fn();
      } catch (e) {
        return sandbox.Result.fail('UNEXPECTED_ERROR', e.message, e.stack);
      }
    }
  };
}

sandbox.Lock = makeDefaultLock();

// ── In-memory GoogleSheets storage mock ──
var availabilityRows = [];
var updateRowCalls = [];
var updateBatchCalls = [];
var shouldFailUpdateRow = false;

function resetStorage() {
  availabilityRows = [];
  updateRowCalls = [];
  updateBatchCalls = [];
  shouldFailUpdateRow = false;
  lockShouldFail = false;
  lockKeyUsed = null;
  currentTimeMs = NOW_MS;
  sandbox.Lock = makeDefaultLock();
}

function makeGoogleSheets() {
  return {
    findRowByColumn: function(sheetName, columnName, value) {
      if (sheetName === sandbox.Config.VOCABULARY.SHEETS.AVAILABILITY) {
        var found = availabilityRows.find(function(r) { return r[columnName] === value; });
        return found ? Object.assign({}, found) : null;
      }
      return null;
    },
    queryRows: function(sheetName, predicateFn) {
      if (sheetName === sandbox.Config.VOCABULARY.SHEETS.AVAILABILITY) {
        return availabilityRows.filter(predicateFn).map(function(r) { return Object.assign({}, r); });
      }
      return [];
    },
    updateRowByColumn: function(sheetName, columnName, value, fields) {
      updateRowCalls.push({ sheetName: sheetName, columnName: columnName, value: value, fields: fields });
      if (shouldFailUpdateRow) return false;

      if (sheetName === sandbox.Config.VOCABULARY.SHEETS.AVAILABILITY) {
        var index = availabilityRows.findIndex(function(r) { return r[columnName] === value; });
        if (index !== -1) {
          Object.assign(availabilityRows[index], fields);
          return true;
        }
      }
      return false;
    },
    updateBatch: function(sheetName, updates) {
      updateBatchCalls.push({ sheetName: sheetName, updates: updates });
      return sandbox.Result.ok({ updated: updates ? updates.length : 0 });
    }
  };
}

sandbox.GoogleSheets = makeGoogleSheets();

// ── LogRepository mock ──
var logEntries = [];
sandbox.LogRepository = {
  write: function(entry) { logEntries.push(entry); }
};

// Load production files
load('Repositories/SlotRepository.js', 'SlotRepository');
load('Application/MaintenanceService.js', 'MaintenanceService');

// ─────────────────────────────────────────
// Helper to build slot rows
// ─────────────────────────────────────────
function createSlot(id, status, reservedUntilUnix, phone, patientName) {
  return {
    slot_id: id,
    status: status,
    reserved_until_unix: reservedUntilUnix !== undefined ? reservedUntilUnix : '',
    reserved_until: reservedUntilUnix ? new Date(reservedUntilUnix) : '',
    phone: phone || '',
    patient_name: patientName || '',
    is_available: true,
    sort_key: NOW_MS + 120 * 60000,
    date: '2026/08/20',
    time: '16:00',
    calendar_event_id: ''
  };
}

// ─────────────────────────────────────────
// Tests
// ─────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ═══════════════════════════════════════
// A — Normal Path (RESERVED + expired -> FREE)
// ═══════════════════════════════════════
test('A — normal path: expired RESERVED slot is cleaned to FREE with cleared patient fields', function() {
  resetStorage();
  var expiredSlot = createSlot('SLOT-01', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 60000, '9647001111111', 'Ali Ahmed');
  availabilityRows.push(expiredSlot);

  var result = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-01', NOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'CLEANED');
  assert.strictEqual(result.data.slotId, 'SLOT-01');

  // Verify sheet state was updated
  var updated = availabilityRows.find(function(r) { return r.slot_id === 'SLOT-01'; });
  assert.strictEqual(updated.status, sandbox.Config.VOCABULARY.STATUS.FREE);
  assert.strictEqual(updated.phone, '');
  assert.strictEqual(updated.patient_name, '');
  assert.strictEqual(updated.reserved_until, '');
  assert.strictEqual(updated.reserved_until_unix, '');
  assert.strictEqual(updateRowCalls.length, 1);
});

// ═══════════════════════════════════════
// B — Safety Path: CONFIRMED must NOT be changed
// ═══════════════════════════════════════
test('B — safety path: CONFIRMED slot is skipped and NOT modified', function() {
  resetStorage();
  var confirmedSlot = createSlot('SLOT-CONFIRMED', sandbox.Config.VOCABULARY.STATUS.CONFIRMED, NOW_MS - 60000, '9647002222222', 'Fatima Hassan');
  availabilityRows.push(confirmedSlot);

  var result = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-CONFIRMED', NOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'SKIPPED_STATE');
  assert.strictEqual(result.data.slotId, 'SLOT-CONFIRMED');
  assert.strictEqual(result.data.currentStatus, sandbox.Config.VOCABULARY.STATUS.CONFIRMED);

  // Assert NO write occurred
  assert.strictEqual(updateRowCalls.length, 0);
  var persisted = availabilityRows.find(function(r) { return r.slot_id === 'SLOT-CONFIRMED'; });
  assert.strictEqual(persisted.status, sandbox.Config.VOCABULARY.STATUS.CONFIRMED);
  assert.strictEqual(persisted.phone, '9647002222222');
  assert.strictEqual(persisted.patient_name, 'Fatima Hassan');
});

// ═══════════════════════════════════════
// B2 — Safety Path: FREE / EXPIRED / CANCELLED must NOT be modified
// ═══════════════════════════════════════
test('B2 — safety path: FREE and EXPIRED slots are skipped without writing', function() {
  resetStorage();
  var freeSlot = createSlot('SLOT-FREE', sandbox.Config.VOCABULARY.STATUS.FREE, '');
  var expiredStateSlot = createSlot('SLOT-EXPIRED', sandbox.Config.VOCABULARY.STATUS.EXPIRED, '');
  availabilityRows.push(freeSlot, expiredStateSlot);

  var rFree = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-FREE', NOW_MS);
  var rExp = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-EXPIRED', NOW_MS);

  assert.strictEqual(rFree.ok, true);
  assert.strictEqual(rFree.data.status, 'SKIPPED_STATE');
  assert.strictEqual(rExp.ok, true);
  assert.strictEqual(rExp.data.status, 'SKIPPED_STATE');
  assert.strictEqual(updateRowCalls.length, 0);
});

// ═══════════════════════════════════════
// C — Not-expired Path (RESERVED + active -> SKIPPED_NOT_EXPIRED)
// ═══════════════════════════════════════
test('C — not-expired path: active RESERVED slot is skipped and NOT modified', function() {
  resetStorage();
  var activeSlot = createSlot('SLOT-ACTIVE', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS + 180000, '9647003333333', 'Hussein Ali');
  availabilityRows.push(activeSlot);

  var result = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-ACTIVE', NOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'SKIPPED_NOT_EXPIRED');
  assert.strictEqual(result.data.slotId, 'SLOT-ACTIVE');
  assert.strictEqual(result.data.reservedUntilUnix, NOW_MS + 180000);

  // Assert NO write occurred
  assert.strictEqual(updateRowCalls.length, 0);
  var persisted = availabilityRows.find(function(r) { return r.slot_id === 'SLOT-ACTIVE'; });
  assert.strictEqual(persisted.status, sandbox.Config.VOCABULARY.STATUS.RESERVED);
  assert.strictEqual(persisted.phone, '9647003333333');
});

// ═══════════════════════════════════════
// C2 — Invalid Expiry (NaN / empty -> SKIPPED_STATE)
// ═══════════════════════════════════════
test('C2 — invalid expiry: RESERVED slot with invalid reserved_until_unix is skipped', function() {
  resetStorage();
  var badExpirySlot = createSlot('SLOT-BAD-EXP', sandbox.Config.VOCABULARY.STATUS.RESERVED, 'INVALID_NUMBER', '9647004444444', 'Zainab');
  availabilityRows.push(badExpirySlot);

  var result = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-BAD-EXP', NOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'SKIPPED_STATE');
  assert.strictEqual(result.data.reason, 'INVALID_EXPIRY');
  assert.strictEqual(updateRowCalls.length, 0);
});

// ═══════════════════════════════════════
// D — Operational Failures: NOT_FOUND, LOCK_TIMEOUT, UPDATE_FAILED
// ═══════════════════════════════════════
test('D1 — not found: non-existent slot returns NOT_FOUND Result.fail', function() {
  resetStorage();
  var result = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-GHOST', NOW_MS);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
  assert.strictEqual(updateRowCalls.length, 0);
});

test('D2 — lock timeout: lock failure propagates as LOCK_TIMEOUT Result.fail', function() {
  resetStorage();
  var expiredSlot = createSlot('SLOT-LOCK', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 1000, '9647005555555', 'Test');
  availabilityRows.push(expiredSlot);
  lockShouldFail = true;

  var result = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-LOCK', NOW_MS);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(updateRowCalls.length, 0);
});

test('D3 — persistence failure: updateRowByColumn returning false propagates UPDATE_FAILED', function() {
  resetStorage();
  var expiredSlot = createSlot('SLOT-WRITE-FAIL', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 1000, '9647006666666', 'Test');
  availabilityRows.push(expiredSlot);
  shouldFailUpdateRow = true;

  var result = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-WRITE-FAIL', NOW_MS);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'UPDATE_FAILED');
});

// ═══════════════════════════════════════
// E — ACTUAL DETERMINISTIC RACE PROOF (Section 15.D)
// ═══════════════════════════════════════
//
// Demonstrates the exact race interleaving:
//   1. Candidate discovery (query) sees Slot-A as RESERVED and expired.
//   2. T_User confirms Slot-A (status becomes CONFIRMED with patient info).
//   3. T_Maint executes cleanupExpiredReservation('Slot-A', nowMs).
//   4. Fresh read inside critical section sees Slot-A is CONFIRMED.
//   5. Cleanup returns SKIPPED_STATE without writing to storage.
//   6. Slot-A remains CONFIRMED, patient data is preserved (NO DOUBLE BOOKING).
//
test('E — deterministic race: concurrent confirmation before cleanup critical section is safely detected and preserved', function() {
  resetStorage();

  // Initial state: Slot-A was RESERVED and expired
  var slotA = createSlot('SLOT-A', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 30000, '9647007777777', 'Murtadha');
  availabilityRows.push(slotA);

  // Step 1: T_Maint candidate discovery
  var candidates = sandbox.SlotRepository.query(function(row) {
    if (row.status !== sandbox.Config.VOCABULARY.STATUS.RESERVED) return false;
    var until = Number(row.reserved_until_unix);
    return !isNaN(until) && until < NOW_MS;
  });
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].slot_id, 'SLOT-A');

  // Step 2: T_User concurrently confirms Slot-A (interleaving before T_Maint executes cleanup)
  var persistedSlot = availabilityRows.find(function(r) { return r.slot_id === 'SLOT-A'; });
  persistedSlot.status = sandbox.Config.VOCABULARY.STATUS.CONFIRMED;
  persistedSlot.patient_name = 'Murtadha Confirmed';
  persistedSlot.phone = '9647007777777';
  persistedSlot.calendar_event_id = 'CAL-EVENT-12345';

  // Step 3: T_Maint attempts cleanup on the discovered candidate ID
  var cleanupResult = sandbox.SlotRepository.cleanupExpiredReservation('SLOT-A', NOW_MS);

  // Assertions:
  // 1. Cleanup recognized the new state and returned SKIPPED_STATE
  assert.strictEqual(cleanupResult.ok, true);
  assert.strictEqual(cleanupResult.data.status, 'SKIPPED_STATE');
  assert.strictEqual(cleanupResult.data.currentStatus, sandbox.Config.VOCABULARY.STATUS.CONFIRMED);

  // 2. Storage was NOT overwritten
  assert.strictEqual(updateRowCalls.length, 0);

  // 3. The CONFIRMED booking is fully intact
  var finalSlot = availabilityRows.find(function(r) { return r.slot_id === 'SLOT-A'; });
  assert.strictEqual(finalSlot.status, sandbox.Config.VOCABULARY.STATUS.CONFIRMED);
  assert.strictEqual(finalSlot.patient_name, 'Murtadha Confirmed');
  assert.strictEqual(finalSlot.phone, '9647007777777');
  assert.strictEqual(finalSlot.calendar_event_id, 'CAL-EVENT-12345');
});

// ═══════════════════════════════════════
// F — REGRESSION TEST: Old implementation vs New implementation (Section 16)
// ═══════════════════════════════════════
//
// Proves that the OLD logic (query -> updateBatch) WOULD destroy the confirmed appointment,
// while the NEW logic (guarded fresh-read cleanup) preserves it.
//
test('F — regression proof: old blind updateBatch destroys confirmed appointment; new guarded cleanup preserves it', function() {
  // ── OLD IMPLEMENTATION SIMULATION ──
  var oldRows = [
    createSlot('SLOT-RACE', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 10000, '9647008888888', 'Patient Old')
  ];

  // Old step 1: query
  var oldDiscovered = oldRows.filter(function(r) {
    return r.status === sandbox.Config.VOCABULARY.STATUS.RESERVED && Number(r.reserved_until_unix) < NOW_MS;
  });

  // User confirms mid-way
  oldRows[0].status = sandbox.Config.VOCABULARY.STATUS.CONFIRMED;
  oldRows[0].patient_name = 'Confirmed Patient';

  // Old step 2: blind updateBatch builds updates from old snapshot
  var oldBatchUpdates = oldDiscovered.map(function(s) {
    return {
      columnName: 'slot_id',
      value: s.slot_id,
      fields: { status: 'FREE', patient_name: '', phone: '', reserved_until: '', reserved_until_unix: '' }
    };
  });
  // Blind update applies:
  oldBatchUpdates.forEach(function(u) {
    var r = oldRows.find(function(row) { return row.slot_id === u.value; });
    Object.assign(r, u.fields);
  });
  // CORRUPTION PROOF: Old implementation erased CONFIRMED!
  assert.strictEqual(oldRows[0].status, 'FREE', 'OLD implementation corrupted data (converted CONFIRMED to FREE)');
  assert.strictEqual(oldRows[0].patient_name, '', 'OLD implementation erased patient name');

  // ── NEW IMPLEMENTATION PROOF ──
  resetStorage();
  var newSlot = createSlot('SLOT-RACE', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 10000, '9647008888888', 'Patient New');
  availabilityRows.push(newSlot);

  // New step 1: discover candidates
  var newDiscovered = sandbox.SlotRepository.query(function(row) {
    return row.status === sandbox.Config.VOCABULARY.STATUS.RESERVED && Number(row.reserved_until_unix) < NOW_MS;
  });

  // User confirms mid-way
  availabilityRows[0].status = sandbox.Config.VOCABULARY.STATUS.CONFIRMED;
  availabilityRows[0].patient_name = 'Confirmed Patient New';

  // New step 2: guarded cleanup per candidate
  var result = sandbox.SlotRepository.cleanupExpiredReservation(newDiscovered[0].slot_id, NOW_MS);

  // INVARIANT PROOF: New implementation protected CONFIRMED!
  assert.strictEqual(result.data.status, 'SKIPPED_STATE');
  assert.strictEqual(availabilityRows[0].status, sandbox.Config.VOCABULARY.STATUS.CONFIRMED);
  assert.strictEqual(availabilityRows[0].patient_name, 'Confirmed Patient New');
});

// ═══════════════════════════════════════
// G — PUBLIC WORKFLOW PROOF: MaintenanceService.runCleanup() (Section 17)
// ═══════════════════════════════════════
test('G1 — public workflow: MaintenanceService.runCleanup cleans expired, skips active, and aggregates results', function() {
  resetStorage();

  var s1 = createSlot('SLOT-EXP-1', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 50000, '9647001111111', 'P1');
  var s2 = createSlot('SLOT-EXP-2', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 20000, '9647002222222', 'P2');
  var s3 = createSlot('SLOT-ACTIVE', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS + 60000, '9647003333333', 'P3');
  var s4 = createSlot('SLOT-CONFIRMED', sandbox.Config.VOCABULARY.STATUS.CONFIRMED, NOW_MS - 10000, '9647004444444', 'P4');

  availabilityRows.push(s1, s2, s3, s4);

  var cleanupResult = sandbox.MaintenanceService.runCleanup();

  assert.strictEqual(cleanupResult.ok, true);
  assert.strictEqual(cleanupResult.data.cleaned, 2);
  assert.strictEqual(cleanupResult.data.skipped, 0);

  // Assert s1 and s2 became FREE
  assert.strictEqual(availabilityRows.find(function(r) { return r.slot_id === 'SLOT-EXP-1'; }).status, sandbox.Config.VOCABULARY.STATUS.FREE);
  assert.strictEqual(availabilityRows.find(function(r) { return r.slot_id === 'SLOT-EXP-2'; }).status, sandbox.Config.VOCABULARY.STATUS.FREE);

  // Assert s3 (active) and s4 (confirmed) remained untouched
  assert.strictEqual(availabilityRows.find(function(r) { return r.slot_id === 'SLOT-ACTIVE'; }).status, sandbox.Config.VOCABULARY.STATUS.RESERVED);
  assert.strictEqual(availabilityRows.find(function(r) { return r.slot_id === 'SLOT-CONFIRMED'; }).status, sandbox.Config.VOCABULARY.STATUS.CONFIRMED);

  // Assert NO direct calls to updateBatch from runCleanup
  assert.strictEqual(updateBatchCalls.length, 0);
});

test('G2 — public workflow: MaintenanceService.runCleanup returns cleaned: 0 when no candidates', function() {
  resetStorage();
  availabilityRows.push(
    createSlot('SLOT-ACTIVE', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS + 60000, '9647003333333', 'P3'),
    createSlot('SLOT-CONFIRMED', sandbox.Config.VOCABULARY.STATUS.CONFIRMED, NOW_MS - 10000, '9647004444444', 'P4')
  );

  var cleanupResult = sandbox.MaintenanceService.runCleanup();

  assert.strictEqual(cleanupResult.ok, true);
  assert.strictEqual(cleanupResult.data.cleaned, 0);
  assert.strictEqual(cleanupResult.data.skipped, 0);
  assert.strictEqual(updateRowCalls.length, 0);
});

test('G3 — public workflow: MaintenanceService.runCleanup handles mid-batch confirmation', function() {
  resetStorage();

  var s1 = createSlot('SLOT-1', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 50000, '9647001111111', 'P1');
  var s2 = createSlot('SLOT-2', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 20000, '9647002222222', 'P2');
  availabilityRows.push(s1, s2);

  // Intercept second slot cleanup to simulate concurrent confirmation right before it runs
  var originalCleanup = sandbox.SlotRepository.cleanupExpiredReservation;
  sandbox.SlotRepository.cleanupExpiredReservation = function(slotId, nowMs) {
    if (slotId === 'SLOT-2') {
      availabilityRows.find(function(r) { return r.slot_id === 'SLOT-2'; }).status = sandbox.Config.VOCABULARY.STATUS.CONFIRMED;
    }
    return originalCleanup.call(sandbox.SlotRepository, slotId, nowMs);
  };

  var cleanupResult = sandbox.MaintenanceService.runCleanup();

  assert.strictEqual(cleanupResult.ok, true);
  assert.strictEqual(cleanupResult.data.cleaned, 1);
  assert.strictEqual(cleanupResult.data.skipped, 1);

  assert.strictEqual(availabilityRows.find(function(r) { return r.slot_id === 'SLOT-1'; }).status, sandbox.Config.VOCABULARY.STATUS.FREE);
  assert.strictEqual(availabilityRows.find(function(r) { return r.slot_id === 'SLOT-2'; }).status, sandbox.Config.VOCABULARY.STATUS.CONFIRMED);
});

test('G4 — public workflow: operational error in repository stops runCleanup and propagates failure', function() {
  resetStorage();
  var s1 = createSlot('SLOT-1', sandbox.Config.VOCABULARY.STATUS.RESERVED, NOW_MS - 50000, '9647001111111', 'P1');
  availabilityRows.push(s1);
  lockShouldFail = true;

  var cleanupResult = sandbox.MaintenanceService.runCleanup();

  assert.strictEqual(cleanupResult.ok, false);
  assert.strictEqual(cleanupResult.error.code, 'LOCK_TIMEOUT');
});

// ═══════════════════════════════════════
// H — ARCHITECTURAL & LAYER BOUNDARY CHECKS
// ═══════════════════════════════════════

test('H1 — structural: SlotRepository.cleanupExpiredReservation uses Lock.runExclusive', function() {
  var source = fs.readFileSync(path.join(ROOT, 'Repositories/SlotRepository.js'), 'utf8');
  assert.ok(
    source.indexOf('cleanupExpiredReservation') !== -1,
    'SlotRepository must define cleanupExpiredReservation'
  );
  assert.ok(
    source.indexOf("Lock.runExclusive('maintenance'") !== -1 || source.indexOf('Lock.runExclusive(') !== -1,
    'cleanupExpiredReservation must use Lock.runExclusive'
  );
});

test('H2 — structural: MaintenanceService.runCleanup does NOT call GoogleSheets directly', function() {
  var source = fs.readFileSync(path.join(ROOT, 'Application/MaintenanceService.js'), 'utf8');

  // Extract runCleanup function body
  var fnStart = source.indexOf('runCleanup:');
  var fnEnd = source.indexOf('runExpiration:');
  var runCleanupBody = source.substring(fnStart, fnEnd);

  assert.strictEqual(
    runCleanupBody.indexOf('GoogleSheets') === -1,
    true,
    'MaintenanceService.runCleanup must NOT reference GoogleSheets'
  );
  assert.strictEqual(
    runCleanupBody.indexOf('updateBatch') === -1,
    true,
    'MaintenanceService.runCleanup must NOT call updateBatch'
  );
});

test('H3 — structural: MaintenanceService does NOT reference Lock or PropertiesService', function() {
  var source = fs.readFileSync(path.join(ROOT, 'Application/MaintenanceService.js'), 'utf8');
  assert.strictEqual(
    source.indexOf('Lock.') === -1 && source.indexOf('LockService') === -1,
    true,
    'MaintenanceService must NOT reference Lock'
  );
  assert.strictEqual(
    source.indexOf('PropertiesService') === -1,
    true,
    'MaintenanceService must NOT reference PropertiesService'
  );
});

// ─────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────
let failures = 0;
tests.forEach(function(entry) {
  try {
    entry.fn();
    console.log('PASS:', entry.name);
  } catch (error) {
    failures++;
    console.error('FAIL:', entry.name);
    console.error(error.stack || error.message);
  }
});

if (failures > 0) process.exit(1);
console.log('\n' + tests.length + '/' + tests.length + ' tests passed');
