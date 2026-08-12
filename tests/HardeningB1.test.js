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
sandbox.SlotRepository = {};

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

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('A — normal reservation', function() {
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
  const result = reserveWithBookingService();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.slot.slot_id, 'A');
  assert.deepStrictEqual(attempts, ['A']);

  sandbox.SlotRepository.queryResult = function() { return sandbox.Result.ok([]); };
  const noCandidate = sandbox.SlotSelection.findEarliestBookable();
  assert.strictEqual(noCandidate.ok, false);
  assert.strictEqual(noCandidate.error.code, 'NO_SLOT_AVAILABLE');
});

test('B — race loss then retry succeeds on a different slot', function() {
  const slotA = candidate('A', 120);
  const slotB = candidate('B', 150);
  const attempts = configureReservation(
    [slotB, slotA],
    { A: ['INVALID_TRANSITION'], B: ['SUCCESS'] }
  );
  const result = reserveWithBookingService();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.slot.slot_id, 'B');
  assert.deepStrictEqual(attempts, ['A', 'B']);
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
    const result = sandbox.BookingService._handleWaitingName(
      '9647000000000', 'Test Patient'
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, errorCode);
    assert.deepStrictEqual(attempts, ['A']);
  });

  sandbox.SlotRepository.queryResult = function() {
    return sandbox.Result.fail('UNEXPECTED_ERROR', 'read failure');
  };
  const readFailure = sandbox.BookingService._handleWaitingName(
    '9647000000000', 'Test Patient'
  );
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
  const result = reserveWithBookingService();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.slot.slot_id, 'B');
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
