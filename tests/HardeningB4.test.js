'use strict';

/*
 * B4 legacy-claim compatibility regression.
 *
 * B6 replaces B4 as the production confirmed-appointment lifecycle boundary,
 * but existing change_claim:<phone> records remain non-destructively readable
 * and owner-token protected pending production-gated inventory/migration.
 * B6 public CHANGE/CANCEL concurrency is exercised in HardeningB6.test.js.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';
const OTHER_PHONE = '9647002222222';
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

let nowMs = 1700000000000;
let token = 0;
sandbox.Clock = { now: function() { return new Date(nowMs); } };
sandbox.ULID = { generate: function() { token += 1; return 'TOKEN_' + token; } };

let properties = {};
let readFailure = false;
let writeFailure = false;
let deleteFailure = false;
sandbox.PropertiesService = {
  getScriptProperties: function() {
    return {
      getProperty: function(key) {
        if (readFailure) throw new Error('PROPERTY_READ_FAILED');
        return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null;
      },
      setProperty: function(key, value) {
        if (writeFailure) throw new Error('PROPERTY_WRITE_FAILED');
        properties[key] = value;
      },
      deleteProperty: function(key) {
        if (deleteFailure) throw new Error('PROPERTY_DELETE_FAILED');
        delete properties[key];
      }
    };
  }
};

let lockFailure = false;
let lockHeld = false;
sandbox.Lock = {
  runExclusive: function(key, fn) {
    if (lockFailure || lockHeld) return sandbox.Result.fail('LOCK_TIMEOUT', 'locked: ' + key);
    lockHeld = true;
    try { return fn(); } catch (e) { return sandbox.Result.fail('UNEXPECTED_ERROR', e.message, e.stack); }
    finally { lockHeld = false; }
  }
};

let slots = [];
function makeSlot(id, phone) {
  return { slot_id: id, status: sandbox.Config.VOCABULARY.STATUS.CONFIRMED, phone: phone };
}
sandbox.SlotRepository = {
  findById: function(slotId) {
    const found = slots.find(function(item) { return item.slot_id === slotId; });
    return found ? Object.assign({}, found) : null;
  },
  findByPhoneAndStatus: function(phone, status) {
    const found = slots.find(function(item) { return item.phone === phone && item.status === status; });
    return found ? Object.assign({}, found) : null;
  },
  queryResult: function(predicateFn) {
    return sandbox.Result.ok(slots.filter(predicateFn).map(function(item) { return Object.assign({}, item); }));
  },
  atomicUpdate: function() { return sandbox.Result.ok({}); }
};

load('AppointmentRepository.js', 'AppointmentRepository');

function reset() {
  nowMs = 1700000000000;
  token = 0;
  properties = {};
  readFailure = false;
  writeFailure = false;
  deleteFailure = false;
  lockFailure = false;
  lockHeld = false;
  slots = [makeSlot('OLD', PHONE), makeSlot('OTHER', OTHER_PHONE)];
}
function key(phone) { return 'change_claim:' + phone; }
function acquire(phone, slotId) { return sandbox.AppointmentRepository.acquireChangeClaim(phone, slotId); }

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('A — legacy B4 claim acquires a durable owner token', function() {
  reset();
  const result = acquire(PHONE, 'OLD');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'CLAIM_ACQUIRED');
  const stored = JSON.parse(properties[key(PHONE)]);
  assert.strictEqual(stored.phone, PHONE);
  assert.strictEqual(stored.oldSlotId, 'OLD');
  assert.ok(stored.ownerToken.indexOf('CHG_') === 0);
});

test('B — matching owner token releases legacy B4 claim', function() {
  reset();
  const acquired = acquire(PHONE, 'OLD');
  const release = sandbox.AppointmentRepository.releaseChangeClaim(PHONE, acquired.data.ownerToken);
  assert.strictEqual(release.ok, true);
  assert.strictEqual(properties[key(PHONE)], undefined);
});

test('C — same phone cannot acquire two legacy claims', function() {
  reset();
  assert.strictEqual(acquire(PHONE, 'OLD').ok, true);
  const second = acquire(PHONE, 'OLD');
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error.code, 'CHANGE_ALREADY_IN_PROGRESS');
});

test('D — different phones keep independent legacy keys', function() {
  reset();
  const first = acquire(PHONE, 'OLD');
  const other = acquire(OTHER_PHONE, 'OTHER');
  assert.strictEqual(first.ok, true);
  assert.strictEqual(other.ok, true);
  assert.notStrictEqual(key(PHONE), key(OTHER_PHONE));
  assert.notStrictEqual(first.data.ownerToken, other.data.ownerToken);
});

test('E — wrong owner token cannot release a legacy claim', function() {
  reset();
  acquire(PHONE, 'OLD');
  const before = properties[key(PHONE)];
  const release = sandbox.AppointmentRepository.releaseChangeClaim(PHONE, 'WRONG');
  assert.strictEqual(release.ok, false);
  assert.strictEqual(release.error.code, 'CLAIM_OWNER_MISMATCH');
  assert.strictEqual(properties[key(PHONE)], before);
});

test('F — arbitrarily old legacy claim has no takeover path', function() {
  reset();
  properties[key(PHONE)] = JSON.stringify({ ownerToken: 'ANCIENT', phone: PHONE, oldSlotId: 'OLD', acquiredAtMs: 1 });
  nowMs += 365 * 24 * 60 * 60 * 1000;
  const result = acquire(PHONE, 'OLD');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'CHANGE_ALREADY_IN_PROGRESS');
  assert.strictEqual(JSON.parse(properties[key(PHONE)]).ownerToken, 'ANCIENT');
});

test('G — property read failure prevents legacy admission', function() {
  reset();
  readFailure = true;
  const result = acquire(PHONE, 'OLD');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'CLAIM_ACQUIRE_FAILED');
  assert.strictEqual(properties[key(PHONE)], undefined);
});

test('H — property write failure prevents legacy admission', function() {
  reset();
  writeFailure = true;
  const result = acquire(PHONE, 'OLD');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'CLAIM_ACQUIRE_FAILED');
  assert.strictEqual(properties[key(PHONE)], undefined);
});

test('I — delete failure preserves legacy ownership', function() {
  reset();
  const acquired = acquire(PHONE, 'OLD');
  deleteFailure = true;
  const release = sandbox.AppointmentRepository.releaseChangeClaim(PHONE, acquired.data.ownerToken);
  assert.strictEqual(release.ok, false);
  assert.strictEqual(release.error.code, 'CLAIM_RELEASE_FAILED');
  assert.ok(properties[key(PHONE)]);
});

test('J — zero active appointments cannot acquire a legacy change claim', function() {
  reset();
  slots[0].status = sandbox.Config.VOCABULARY.STATUS.FREE;
  slots[0].phone = '';
  const result = acquire(PHONE, 'OLD');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'ACTIVE_APPOINTMENT_AMBIGUOUS');
});

test('K — multiple active appointments cannot acquire a legacy change claim', function() {
  reset();
  slots.push(makeSlot('SECOND', PHONE));
  const result = acquire(PHONE, 'OLD');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'ACTIVE_APPOINTMENT_AMBIGUOUS');
});

test('L — stale old Slot identity cannot acquire a legacy change claim', function() {
  reset();
  const result = acquire(PHONE, 'NOT_OLD');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'ACTIVE_APPOINTMENT_CHANGED');
});

test('M — B4 legacy boundary remains in AppointmentRepository while production CHANGE uses B6 ownership', function() {
  const appointmentSource = fs.readFileSync(path.join(ROOT, 'AppointmentRepository.js'), 'utf8');
  const changeSource = fs.readFileSync(path.join(ROOT, 'Changeservice.js'), 'utf8');
  const slotSource = fs.readFileSync(path.join(ROOT, 'Repositories/SlotRepository.js'), 'utf8');
  assert.ok(appointmentSource.indexOf("'change_claim:' + phone") !== -1);
  assert.ok(appointmentSource.indexOf('acquireChangeClaim') !== -1);
  assert.ok(appointmentSource.indexOf('releaseChangeClaim') !== -1);
  assert.ok(appointmentSource.indexOf('acquireB6LifecycleOwnership') !== -1);
  assert.ok(changeSource.indexOf('B6LifecycleService.begin') !== -1);
  assert.ok(slotSource.indexOf('atomicUpdate: function(slotId, decisionFn)') !== -1);
});

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
