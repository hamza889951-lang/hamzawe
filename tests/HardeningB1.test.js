'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_MS = 1700000000000;
const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, {
    filename: relativePath
  });
}

load('Result.js', 'Result');
load('Config.js', 'Config');
load('StateMachine.js', 'StateMachine');
load('Domain/Validators.js', 'Validators');

sandbox.Clock = { now: function() { return new Date(NOW_MS); } };
sandbox.DateUtils = {
  addMinutes: function(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
  },
  formatDateDisplay: function(value) { return String(value); },
  formatTimeDisplay: function(value) { return String(value); }
};
sandbox.LegacySlotTimeParser = {
  toComparableTime: function(value) {
    return typeof value === 'number' ? value : null;
  }
};
sandbox.GoogleSheets = {
  queryRows: function() { return []; },
  findRowByColumn: function() { return null; },
  updateRowByColumn: function() { return true; }
};
sandbox.Lock = {
  runExclusive: function(key, fn) { return fn(); }
};

// Load the production repository implementation. The repository contract tests
// below call these functions directly instead of replacing queryResult with a mock.
load('Repositories/SlotRepository.js', 'SlotRepository');
const productionQueryResult = sandbox.SlotRepository.queryResult;
const productionQuery = sandbox.SlotRepository.query;
const productionAtomicUpdate = sandbox.SlotRepository.atomicUpdate;
const productionFindById = sandbox.SlotRepository.findById;

load('Slotselection.js', 'SlotSelection');
load('Application/BookingService.js', 'BookingService');
load('Changeservice.js', 'ChangeService');

function candidate(id, offsetMinutes) {
  return {
    slot_id: id,
    status: sandbox.Config.VOCABULARY.STATUS.FREE,
    is_available: true,
    sort_key: NOW_MS + offsetMinutes * 60000,
    date: '2026/08/20',
    time: '16:00'
  };
}

function configureReservation(candidates, outcomesById) {
  const attempts = [];
  Object.defineProperty(attempts, 'reservedSlotIds', {
    value: [],
    enumerable: false
  });
  const byId = {};
  candidates.forEach(function(slot) { byId[slot.slot_id] = slot; });

  sandbox.SlotRepository.queryResult = function(predicate) {
    return sandbox.Result.ok(candidates.filter(predicate));
  };

  sandbox.SlotRepository.atomicUpdate = function(slotId, decisionFn) {
    attempts.push(slotId);
    const outcomes = outcomesById[slotId] || [];
    const outcome = outcomes.length ? outcomes.shift() : 'SUCCESS';

    if (outcome !== 'SUCCESS') {
      return sandbox.Result.fail(outcome, outcome + ' test failure');
    }

    const fresh = Object.assign({}, byId[slotId], {
      status: sandbox.Config.VOCABULARY.STATUS.FREE
    });
    const decision = decisionFn(fresh);
    if (!decision.ok) return decision;
    attempts.reservedSlotIds.push(slotId);
    return sandbox.Result.ok(Object.assign({ slotId: slotId }, decision.data));
  };

  return attempts;
}

function reserveWithBookingService() {
  return sandbox.BookingService._reserveEarliestBookable(
    '9647000000000',
    'Test Patient',
    new Date(NOW_MS + 5 * 60000)
  );
}

function runPublicBookingWorkflow() {
  let movedToSlotId = null;

  sandbox.PhoneUtils = { normalize: function(value) { return value; } };
  sandbox.CommandExecutor = {
    execute: function(command, context, fn) { return fn(); }
  };
  sandbox.BusNumberCalculator = {
    fromSlot: function() { return sandbox.Result.ok({ busNumber: 1 }); }
  };
  sandbox.ConversationRepository = {
    findByPhone: function() {
      return { state: sandbox.Config.VOCABULARY.CONVERSATION_STATE.WAITING_NAME };
    },
    moveToWaitingConfirmation: function(phone, patientName, slotId) {
      movedToSlotId = slotId;
    }
  };

  const result = sandbox.BookingService.handleIncomingMessage(
    '9647000000000',
    'Test Patient'
  );

  return { result: result, movedToSlotId: movedToSlotId };
}

function useProductionRepository() {
  sandbox.SlotRepository.queryResult = productionQueryResult;
  sandbox.SlotRepository.query = productionQuery;
  sandbox.SlotRepository.atomicUpdate = productionAtomicUpdate;
  sandbox.SlotRepository.findById = productionFindById;
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('I/R1 — production queryResult wraps successful rows in Result.ok', function() {
  useProductionRepository();
  const rows = [candidate('A', 120), candidate('B', 150)];
  sandbox.GoogleSheets.queryRows = function() { return rows; };

  const result = sandbox.SlotRepository.queryResult(function() { return true; });
  const legacyResult = sandbox.SlotRepository.query(function() { return true; });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data, rows);
  assert.strictEqual(result.error, null);
  assert.strictEqual(Array.isArray(legacyResult), true);
  assert.strictEqual(legacyResult, rows);
});

test('I/R2 — production queryResult returns Result.ok for an empty read', function() {
  useProductionRepository();
  const rows = [];
  sandbox.GoogleSheets.queryRows = function() { return rows; };

  const result = sandbox.SlotRepository.queryResult(function() { return true; });
  const legacyResult = sandbox.SlotRepository.query(function() { return true; });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data, rows);
  assert.strictEqual(result.data.length, 0);
  assert.strictEqual(Array.isArray(legacyResult), true);
  assert.strictEqual(legacyResult.length, 0);
});

test('I/R3 — production queryResult converts a read exception to Result.fail', function() {
  useProductionRepository();
  sandbox.GoogleSheets.queryRows = function() {
    throw new Error('test read failure');
  };

  const result = sandbox.SlotRepository.queryResult(function() { return true; });
  const legacyResult = sandbox.SlotRepository.query(function() { return true; });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'UNEXPECTED_ERROR');
  assert.strictEqual(result.error.message, 'test read failure');
  assert.strictEqual(Array.isArray(legacyResult), true);
  assert.strictEqual(legacyResult.length, 0);
});

test('R4 — SlotSelection maps Result.ok([]) to NO_SLOT_AVAILABLE', function() {
  useProductionRepository();
  sandbox.GoogleSheets.queryRows = function() { return []; };

  const result = sandbox.SlotSelection.findEarliestBookable();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'NO_SLOT_AVAILABLE');
});

test('R5 — SlotSelection propagates the repository read failure unchanged', function() {
  useProductionRepository();
  let repositoryFailure = null;
  sandbox.GoogleSheets.queryRows = function() {
    throw new Error('selection read failure');
  };
  sandbox.SlotRepository.queryResult = function(predicateFn) {
    repositoryFailure = productionQueryResult.call(sandbox.SlotRepository, predicateFn);
    return repositoryFailure;
  };

  const result = sandbox.SlotSelection.findEarliestBookable();

  assert.strictEqual(result, repositoryFailure);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'UNEXPECTED_ERROR');
  assert.notStrictEqual(result.error.code, 'NO_SLOT_AVAILABLE');
});

test('R6 — production path selects a candidate and performs atomicUpdate', function() {
  useProductionRepository();
  const slotA = candidate('A', 120);
  const updates = [];
  sandbox.GoogleSheets.queryRows = function(sheetName, predicateFn) {
    return [slotA].filter(predicateFn);
  };
  sandbox.GoogleSheets.findRowByColumn = function(sheetName, columnName, value) {
    return value === slotA.slot_id ? Object.assign({}, slotA) : null;
  };
  sandbox.GoogleSheets.updateRowByColumn = function(
    sheetName, columnName, value, fields
  ) {
    updates.push({ slotId: value, fields: fields });
    return true;
  };

  const result = reserveWithBookingService();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.slot.slot_id, 'A');
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].slotId, 'A');
  assert.strictEqual(
    updates[0].fields.status,
    sandbox.Config.VOCABULARY.STATUS.RESERVED
  );
});

test('A — public BookingService workflow reserves the nearest candidate once', function() {
  const slotA = candidate('A', 120);
  const slotB = candidate('B', 180);
  const unavailable = Object.assign(candidate('UNAVAILABLE', 90), { is_available: false });
  const notFree = Object.assign(candidate('NOT_FREE', 100), {
    status: sandbox.Config.VOCABULARY.STATUS.RESERVED
  });
  const tooSoon = candidate('TOO_SOON', 30);
  const attempts = configureReservation(
    [slotB, unavailable, notFree, tooSoon, slotA],
    { A: ['SUCCESS'] }
  );
  const workflow = runPublicBookingWorkflow();

  assert.strictEqual(workflow.result.ok, true);
  assert.strictEqual(workflow.movedToSlotId, 'A');
  assert.deepStrictEqual(attempts, ['A']);
});

test('B — public BookingService retries a race loss and reserves B', function() {
  const slotA = candidate('A', 120);
  const slotB = candidate('B', 150);
  const attempts = configureReservation(
    [slotB, slotA],
    { A: ['INVALID_TRANSITION'], B: ['SUCCESS'] }
  );
  const workflow = runPublicBookingWorkflow();

  assert.strictEqual(workflow.result.ok, true);
  assert.strictEqual(workflow.movedToSlotId, 'B');
  assert.deepStrictEqual(attempts, ['A', 'B']);
  assert.deepStrictEqual(attempts.reservedSlotIds, ['B']);
  assert.strictEqual(attempts.reservedSlotIds.indexOf('A'), -1);
});

test('C — three race losses become NO_SLOT_AVAILABLE', function() {
  const attempts = configureReservation(
    [candidate('C', 180), candidate('A', 120), candidate('B', 150)],
    {
      A: ['INVALID_TRANSITION'],
      B: ['INVALID_TRANSITION'],
      C: ['INVALID_TRANSITION']
    }
  );
  const result = reserveWithBookingService();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'NO_SLOT_AVAILABLE');
  assert.deepStrictEqual(attempts, ['A', 'B', 'C']);
});

test('D — storage/lock failures are propagated without retry', function() {
  sandbox.CommandExecutor = {
    execute: function(command, context, fn) { return fn(); }
  };

  ['LOCK_TIMEOUT', 'UPDATE_FAILED'].forEach(function(errorCode) {
    const attempts = configureReservation(
      [candidate('A', 120), candidate('B', 150)],
      { A: [errorCode] }
    );
    const workflow = runPublicBookingWorkflow();

    assert.strictEqual(workflow.result.ok, false);
    assert.strictEqual(workflow.result.error.code, errorCode);
    assert.deepStrictEqual(attempts, ['A']);
  });

  sandbox.SlotRepository.queryResult = function() {
    return sandbox.Result.fail('UNEXPECTED_ERROR', 'read failure');
  };
  const readFailure = runPublicBookingWorkflow().result;
  assert.strictEqual(readFailure.ok, false);
  assert.strictEqual(readFailure.error.code, 'UNEXPECTED_ERROR');
});

test('E — a lost candidate is excluded from the current operation', function() {
  const slotA = candidate('A', 120);
  const slotB = candidate('B', 150);
  const attempts = configureReservation(
    [slotA, slotB],
    { A: ['INVALID_TRANSITION', 'SUCCESS'], B: ['SUCCESS'] }
  );
  const workflow = runPublicBookingWorkflow();

  assert.strictEqual(workflow.result.ok, true);
  assert.strictEqual(workflow.movedToSlotId, 'B');
  assert.strictEqual(attempts.filter(function(id) { return id === 'A'; }).length, 1);
  assert.deepStrictEqual(attempts, ['A', 'B']);
});

test('F — ChangeService retries candidate reservation and preserves new-first order', function() {
  const oldSlot = {
    slot_id: 'OLD',
    status: sandbox.Config.VOCABULARY.STATUS.RESERVED,
    phone: '9647000000000',
    patient_name: 'Test Patient',
    is_available: false,
    sort_key: NOW_MS + 90 * 60000
  };
  const slotA = candidate('A', 120);
  const slotB = candidate('B', 150);
  const candidates = [oldSlot, slotA, slotB];
  const attempts = [];
  let movedToSlotId = null;

  sandbox.PhoneUtils = { normalize: function(value) { return value; } };
  sandbox.CommandExecutor = {
    execute: function(command, context, fn) { return fn(); }
  };
  sandbox.BusNumberCalculator = {
    fromSlot: function() { return sandbox.Result.ok({ busNumber: 2 }); }
  };
  sandbox.ConversationRepository = {
    moveToWaitingConfirmation: function(phone, patientName, slotId) {
      movedToSlotId = slotId;
    }
  };
  sandbox.SlotRepository.findByPhoneAndStatus = function() { return oldSlot; };
  sandbox.SlotRepository.queryResult = function(predicate) {
    return sandbox.Result.ok(candidates.filter(predicate));
  };
  sandbox.SlotRepository.atomicUpdate = function(slotId, decisionFn) {
    attempts.push(slotId);
    if (slotId === 'A') {
      return sandbox.Result.fail('INVALID_TRANSITION', 'race');
    }

    const fresh = slotId === 'OLD'
      ? Object.assign({}, oldSlot)
      : Object.assign({}, slotB);
    const decision = decisionFn(fresh);
    if (!decision.ok) return decision;
    return sandbox.Result.ok(Object.assign({ slotId: slotId }, decision.data));
  };

  const result = sandbox.ChangeService.changeReservation('9647000000000');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(movedToSlotId, 'B');
  assert.deepStrictEqual(attempts, ['A', 'B', 'OLD']);
});

test('G — public BookingService has one successful reservation path', function() {
  const attempts = configureReservation(
    [candidate('A', 120)],
    { A: ['SUCCESS'] }
  );

  const workflow = runPublicBookingWorkflow();

  assert.strictEqual(workflow.result.ok, true);
  assert.strictEqual(workflow.movedToSlotId, 'A');
  assert.strictEqual(attempts.length, 1);
  assert.deepStrictEqual(attempts, ['A']);
});

test('H — public ChangeService reserves new once before releasing old', function() {
  const oldSlot = {
    slot_id: 'OLD',
    status: sandbox.Config.VOCABULARY.STATUS.RESERVED,
    phone: '9647000000000',
    patient_name: 'Test Patient',
    is_available: false,
    sort_key: NOW_MS + 90 * 60000
  };
  const newSlot = candidate('NEW', 120);
  const attempts = [];

  sandbox.PhoneUtils = { normalize: function(value) { return value; } };
  sandbox.CommandExecutor = {
    execute: function(command, context, fn) { return fn(); }
  };
  sandbox.BusNumberCalculator = {
    fromSlot: function() { return sandbox.Result.ok({ busNumber: 2 }); }
  };
  sandbox.ConversationRepository = {
    moveToWaitingConfirmation: function() {}
  };
  sandbox.SlotRepository.findByPhoneAndStatus = function() { return oldSlot; };
  sandbox.SlotRepository.queryResult = function(predicate) {
    return sandbox.Result.ok([oldSlot, newSlot].filter(predicate));
  };
  sandbox.SlotRepository.atomicUpdate = function(slotId, decisionFn) {
    attempts.push(slotId);
    const fresh = slotId === 'OLD'
      ? Object.assign({}, oldSlot)
      : Object.assign({}, newSlot);
    const decision = decisionFn(fresh);
    if (!decision.ok) return decision;
    return sandbox.Result.ok(Object.assign({ slotId: slotId }, decision.data));
  };

  const result = sandbox.ChangeService.changeReservation('9647000000000');

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(attempts, ['NEW', 'OLD']);
  assert.strictEqual(attempts.filter(function(id) { return id === 'NEW'; }).length, 1);
});

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
