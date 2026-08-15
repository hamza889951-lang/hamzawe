'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_MS = 1700000000000;
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

let nowMs = NOW_MS;
let tokenSequence = 0;
sandbox.Clock = { now: function() { return new Date(nowMs); } };
sandbox.ULID = { generate: function() { tokenSequence += 1; return 'TOKEN_' + tokenSequence; } };

let properties = {};
let propertyReadFailure = false;
let propertyWriteFailure = false;
let propertyDeleteFailure = false;
let releaseInterleave = null;
let pendingAfterUnlock = null;

sandbox.PropertiesService = {
  getScriptProperties: function() {
    return {
      getProperty: function(key) {
        if (propertyReadFailure) throw new Error('PROPERTY_READ_FAILED');
        return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null;
      },
      setProperty: function(key, value) {
        if (propertyWriteFailure) throw new Error('PROPERTY_WRITE_FAILED');
        properties[key] = value;
      },
      deleteProperty: function(key) {
        if (propertyDeleteFailure) throw new Error('PROPERTY_DELETE_FAILED');
        delete properties[key];
        if (releaseInterleave) {
          pendingAfterUnlock = releaseInterleave;
          releaseInterleave = null;
        }
      }
    };
  }
};

let lockHeld = false;
let lockShouldFail = false;
let lockEntries = [];
sandbox.Lock = {
  runExclusive: function(key, fn) {
    lockEntries.push({ key: key, phase: 'enter' });
    if (lockShouldFail || lockHeld) {
      return sandbox.Result.fail('LOCK_TIMEOUT', 'Could not acquire lock for ' + key);
    }
    lockHeld = true;
    try {
      return fn();
    } catch (e) {
      return sandbox.Result.fail('UNEXPECTED_ERROR', e.message, e.stack);
    } finally {
      lockHeld = false;
      lockEntries.push({ key: key, phase: 'exit' });
      if (pendingAfterUnlock) {
        const interleave = pendingAfterUnlock;
        pendingAfterUnlock = null;
        interleave();
      }
    }
  }
};

let slots = [];
let atomicCalls = [];
let reserveAttempts = [];
let forceFirstReserveRace = false;

function clone(value) { return Object.assign({}, value); }
function slot(id, status, phone) {
  return {
    slot_id: id,
    status: status,
    phone: phone || '',
    patient_name: phone ? 'Patient ' + phone : '',
    calendar_event_id: status === 'CONFIRMED' ? 'OLD_EVENT_' + id : '',
    reserved_until: '',
    reserved_until_unix: '',
    is_available: true,
    sort_key: NOW_MS + (id === 'A' ? 7200000 : 10800000),
    date: '2026/08/20',
    time: '16:00'
  };
}

sandbox.SlotRepository = {
  findById: function(slotId) {
    const found = slots.find(function(item) { return item.slot_id === slotId; });
    return found ? clone(found) : null;
  },
  findByPhoneAndStatus: function(phone, status) {
    const found = slots.find(function(item) {
      return item.phone === phone && item.status === status;
    });
    return found ? clone(found) : null;
  },
  queryResult: function(predicateFn) {
    return sandbox.Result.ok(slots.filter(predicateFn).map(clone));
  },
  atomicUpdate: function(slotId, decisionFn) {
    assert.strictEqual(lockHeld, false,
      'B4 must not hold its claim ScriptLock while SlotRepository.atomicUpdate runs');
    atomicCalls.push(slotId);
    const persisted = slots.find(function(item) { return item.slot_id === slotId; });
    if (!persisted) return sandbox.Result.fail('SLOT_NOT_FOUND', 'missing');

    if (persisted.status === sandbox.Config.VOCABULARY.STATUS.FREE) {
      reserveAttempts.push(slotId);
      if (forceFirstReserveRace) {
        forceFirstReserveRace = false;
        persisted.status = sandbox.Config.VOCABULARY.STATUS.RESERVED;
        persisted.phone = 'OTHER_RACE_OWNER';
        return sandbox.Result.fail('INVALID_TRANSITION', 'race lost');
      }
    }

    const decision = decisionFn(clone(persisted));
    if (!decision.ok) return decision;
    Object.assign(persisted, decision.data);
    return sandbox.Result.ok(Object.assign({ slotId: slotId }, decision.data));
  }
};

sandbox.SlotSelection = {
  findEarliestBookable: function(excludedIds) {
    const excluded = excludedIds || [];
    const found = slots.find(function(item) {
      return item.status === sandbox.Config.VOCABULARY.STATUS.FREE &&
        item.is_available === true && excluded.indexOf(item.slot_id) === -1;
    });
    return found
      ? sandbox.Result.ok(clone(found))
      : sandbox.Result.fail('NO_SLOT_AVAILABLE', 'No bookable slot found');
  }
};

sandbox.PhoneUtils = { normalize: function(value) { return String(value).replace(/\D/g, ''); } };
sandbox.DateUtils = {
  addMinutes: function(date, minutes) { return new Date(date.getTime() + minutes * 60000); },
  fromTimestamp: function(value) { return new Date(value); },
  formatDateDisplay: function(value) { return String(value); },
  formatTimeDisplay: function(value) { return String(value); }
};
sandbox.LegacySlotTimeParser = {
  toComparableTime: function(value) { return typeof value === 'number' ? value : null; }
};
sandbox.SettingsRepository = { getSlotDurationMinutes: function() { return 30; } };
sandbox.BusNumberCalculator = {
  fromSlot: function(item) { return sandbox.Result.ok({ busNumber: item.slot_id === 'A' ? 1 : 2 }); }
};
sandbox.CommandExecutor = {
  execute: function(command, context, fn) {
    try { return fn(); } catch (e) { return sandbox.Result.fail('UNEXPECTED_ERROR', e.message, e.stack); }
  }
};

let createdEvents = [];
let deletedEvents = [];
let calendarShouldFail = false;
let calendarInterleave = null;
sandbox.CalendarRepository = {
  createAppointmentEvent: function() {
    assert.strictEqual(lockHeld, false,
      'B4 must not hold its claim ScriptLock during Calendar creation');
    if (calendarInterleave) {
      const interleave = calendarInterleave;
      calendarInterleave = null;
      interleave();
    }
    if (calendarShouldFail) {
      return sandbox.Result.fail('CALENDAR_CREATE_FAILED', 'calendar unavailable');
    }
    const eventId = 'EVENT_' + (createdEvents.length + 1);
    createdEvents.push(eventId);
    return sandbox.Result.ok({ eventId: eventId });
  },
  deleteAppointmentEvent: function(eventId) {
    deletedEvents.push(eventId);
    return sandbox.Result.ok({ deleted: true });
  }
};

let logs = [];
sandbox.LogRepository = { write: function(entry) { logs.push(entry); } };
sandbox.ConversationRepository = {
  findByPhone: function() {
    return { state: sandbox.Config.VOCABULARY.CONVERSATION_STATE.BOOKED };
  },
  moveToWaitingConfirmation: function() {}
};

load('AppointmentRepository.js', 'AppointmentRepository');
load('Changeservice.js', 'ChangeService');
load('Core/Router.js', 'Router');

function resetWorkflow() {
  nowMs = NOW_MS;
  tokenSequence = 0;
  properties = {};
  propertyReadFailure = false;
  propertyWriteFailure = false;
  propertyDeleteFailure = false;
  releaseInterleave = null;
  pendingAfterUnlock = null;
  lockHeld = false;
  lockShouldFail = false;
  lockEntries = [];
  atomicCalls = [];
  reserveAttempts = [];
  forceFirstReserveRace = false;
  createdEvents = [];
  deletedEvents = [];
  calendarShouldFail = false;
  calendarInterleave = null;
  logs = [];
  slots = [
    slot('OLD', sandbox.Config.VOCABULARY.STATUS.CONFIRMED, PHONE),
    slot('A', sandbox.Config.VOCABULARY.STATUS.FREE, ''),
    slot('B', sandbox.Config.VOCABULARY.STATUS.FREE, ''),
    slot('OTHER_OLD', sandbox.Config.VOCABULARY.STATUS.CONFIRMED, OTHER_PHONE)
  ];
}

function claimKey(phone) { return 'change_claim:' + phone; }
function publicChange(phone) {
  return sandbox.Router.dispatch({ phone: phone, message: '2' });
}
function confirmedFor(phone) {
  return slots.filter(function(item) {
    return item.phone === phone && item.status === sandbox.Config.VOCABULARY.STATUS.CONFIRMED;
  });
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('A/D/J — public single change succeeds once and releases its durable claim', function() {
  resetWorkflow();
  const result = publicChange(PHONE);

  assert.strictEqual(result.ok, true);
  assert.ok(result.data.reply.indexOf('تم تغيير موعدك بنجاح') !== -1);
  assert.strictEqual(confirmedFor(PHONE).length, 1);
  assert.strictEqual(confirmedFor(PHONE)[0].slot_id, 'A');
  assert.strictEqual(createdEvents.length, 1);
  assert.strictEqual(properties[claimKey(PHONE)], undefined);
  assert.deepStrictEqual(atomicCalls, ['A', 'A', 'A', 'OLD']);
});

test('B/C — same phone is blocked while different phone has an independent logical key', function() {
  resetWorkflow();
  const first = sandbox.AppointmentRepository.acquireChangeClaim(PHONE, 'OLD');
  const duplicate = sandbox.AppointmentRepository.acquireChangeClaim(PHONE, 'OLD');
  const other = sandbox.AppointmentRepository.acquireChangeClaim(OTHER_PHONE, 'OTHER_OLD');

  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.data.status, 'CLAIM_ACQUIRED');
  assert.strictEqual(duplicate.ok, false);
  assert.strictEqual(duplicate.error.code, 'CHANGE_ALREADY_IN_PROGRESS');
  assert.strictEqual(other.ok, true);
  assert.notStrictEqual(claimKey(PHONE), claimKey(OTHER_PHONE));
  assert.notStrictEqual(first.data.ownerToken, other.data.ownerToken);
});

test('E/H/J — Calendar failure preserves existing partial-commit semantics and releases claim', function() {
  resetWorkflow();
  calendarShouldFail = true;

  const result = publicChange(PHONE);

  assert.strictEqual(result.ok, true);
  assert.ok(result.data.reply.indexOf('تعذّر تغيير موعدك') !== -1);
  assert.strictEqual(properties[claimKey(PHONE)], undefined);
  assert.strictEqual(createdEvents.length, 0);
  assert.strictEqual(confirmedFor(PHONE).length, 2,
    'Existing partial commit remains: old and newly confirmed slots survive Calendar failure');
  assert.strictEqual(slots.find(function(item) { return item.slot_id === 'A'; }).calendar_event_id, '');
});

test('F — owner-token mismatch cannot release another operation claim', function() {
  resetWorkflow();
  const acquired = sandbox.AppointmentRepository.acquireChangeClaim(PHONE, 'OLD');
  const rawBefore = properties[claimKey(PHONE)];
  const release = sandbox.AppointmentRepository.releaseChangeClaim(PHONE, 'WRONG_TOKEN');

  assert.strictEqual(acquired.ok, true);
  assert.strictEqual(release.ok, false);
  assert.strictEqual(release.error.code, 'CLAIM_OWNER_MISMATCH');
  assert.strictEqual(properties[claimKey(PHONE)], rawBefore);
});

test('G — an arbitrarily old durable claim is never taken over', function() {
  resetWorkflow();
  properties[claimKey(PHONE)] = JSON.stringify({
    ownerToken: 'ANCIENT_OWNER',
    phone: PHONE,
    oldSlotId: 'OLD',
    acquiredAtMs: 1
  });
  nowMs = NOW_MS + (365 * 24 * 60 * 60 * 1000);

  const result = sandbox.AppointmentRepository.acquireChangeClaim(PHONE, 'OLD');

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'CHANGE_ALREADY_IN_PROGRESS');
  assert.strictEqual(JSON.parse(properties[claimKey(PHONE)]).ownerToken, 'ANCIENT_OWNER');
});

test('H/I/J — deterministic public interleaving permits one replacement and one event only', function() {
  resetWorkflow();
  let secondResult = null;

  calendarInterleave = function() {
    // T1 already owns the claim and has confirmed A. T2 enters through Router
    // before T1 creates/stores its Calendar event and before claim release.
    secondResult = publicChange(PHONE);
  };

  const firstResult = publicChange(PHONE);

  assert.strictEqual(firstResult.ok, true);
  assert.ok(firstResult.data.reply.indexOf('تم تغيير موعدك بنجاح') !== -1);
  assert.ok(secondResult);
  assert.strictEqual(secondResult.ok, true);
  assert.ok(secondResult.data.reply.indexOf('عملية تغيير جارية') !== -1);
  assert.strictEqual(reserveAttempts.length, 1, 'T2 must not reserve a replacement');
  assert.strictEqual(createdEvents.length, 1, 'T2 must not create a Calendar event');
  assert.strictEqual(confirmedFor(PHONE).length, 1, 'Only T1 replacement remains confirmed');
  assert.strictEqual(confirmedFor(PHONE)[0].slot_id, 'A');
  assert.strictEqual(properties[claimKey(PHONE)], undefined, 'T1 releases after core success');
});

test('BLOCKER — release-before-cleanup window rejects a stale-old second change', function() {
  resetWorkflow();
  let secondResult = null;
  let stateAtSecondEntry = null;

  releaseInterleave = function() {
    // T1's durable claim has been deleted and its short ScriptLock released,
    // but ChangeService has not yet entered post-commit cleanup. OLD and A are
    // both still CONFIRMED. T2 enters through the real public Router workflow.
    stateAtSecondEntry = confirmedFor(PHONE).map(function(item) { return item.slot_id; });
    secondResult = publicChange(PHONE);
  };

  const firstResult = publicChange(PHONE);

  assert.deepStrictEqual(stateAtSecondEntry, ['OLD', 'A'],
    'The injected T2 must run after claim release and before old cleanup');
  assert.strictEqual(firstResult.ok, true);
  assert.ok(firstResult.data.reply.indexOf('تم تغيير موعدك بنجاح') !== -1);
  assert.ok(secondResult);
  assert.ok(secondResult.data.reply.indexOf('تعذّر تغيير موعدك') !== -1);
  assert.strictEqual(reserveAttempts.length, 1, 'T2 must not reserve B in the release window');
  assert.strictEqual(createdEvents.length, 1, 'T2 must not create a second Calendar event');
  assert.strictEqual(confirmedFor(PHONE).length, 1, 'T1 cleanup leaves only replacement A');
  assert.strictEqual(confirmedFor(PHONE)[0].slot_id, 'A');
  assert.strictEqual(properties[claimKey(PHONE)], undefined);
});

test('G/B1 — existing bounded slot-race retry remains in the CHANGE core', function() {
  resetWorkflow();
  forceFirstReserveRace = true;

  const result = publicChange(PHONE);

  assert.strictEqual(result.ok, true);
  assert.ok(result.data.reply.indexOf('تم تغيير موعدك بنجاح') !== -1);
  assert.deepStrictEqual(reserveAttempts, ['A', 'B']);
  assert.strictEqual(slots.find(function(item) { return item.slot_id === 'B'; }).status,
    sandbox.Config.VOCABULARY.STATUS.CONFIRMED);
  assert.strictEqual(createdEvents.length, 1);
  assert.strictEqual(properties[claimKey(PHONE)], undefined);
});

test('LOCK — claim lock failure stops before every replacement side effect', function() {
  resetWorkflow();
  lockShouldFail = true;

  const result = publicChange(PHONE);

  assert.strictEqual(result.ok, true);
  assert.ok(result.data.reply.indexOf('تعذّر تغيير موعدك') !== -1);
  assert.strictEqual(atomicCalls.length, 0);
  assert.strictEqual(createdEvents.length, 0);
  assert.strictEqual(slots[0].status, sandbox.Config.VOCABULARY.STATUS.CONFIRMED);
});

test('NO ACTIVE — business outcome creates neither claim nor replacement', function() {
  resetWorkflow();
  slots[0].status = sandbox.Config.VOCABULARY.STATUS.FREE;
  slots[0].phone = '';

  const result = publicChange(PHONE);

  assert.strictEqual(result.ok, true);
  assert.ok(result.data.reply.indexOf('لا يوجد لديك حجز مؤكَّد') !== -1);
  assert.strictEqual(Object.keys(properties).length, 0);
  assert.strictEqual(atomicCalls.length, 0);
  assert.strictEqual(createdEvents.length, 0);
});

test('RELEASE FAILURE — core success is preserved and claim failure is logged', function() {
  resetWorkflow();
  propertyDeleteFailure = true;

  const result = publicChange(PHONE);

  assert.strictEqual(result.ok, true);
  assert.ok(result.data.reply.indexOf('تم تغيير موعدك بنجاح') !== -1);
  assert.strictEqual(createdEvents.length, 1);
  assert.strictEqual(confirmedFor(PHONE).length, 1);
  assert.ok(properties[claimKey(PHONE)], 'Failed normal release leaves durable claim');
  assert.ok(logs.some(function(entry) { return entry.stage === 'CLAIM_RELEASE_FAILED'; }));
});

test('REGRESSION — old no-ownership model produces two replacements; production path does not', function() {
  resetWorkflow();

  function oldNoOwnershipCommit(slotId) {
    const replacement = slots.find(function(item) { return item.slot_id === slotId; });
    replacement.status = sandbox.Config.VOCABULARY.STATUS.CONFIRMED;
    replacement.phone = PHONE;
    replacement.calendar_event_id = 'LEGACY_' + slotId;
    createdEvents.push(replacement.calendar_event_id);
  }

  oldNoOwnershipCommit('A');
  oldNoOwnershipCommit('B');
  assert.strictEqual(confirmedFor(PHONE).length, 3,
    'Fixture proves old read/start-without-ownership behavior permits both replacements');
  assert.strictEqual(createdEvents.length, 2);

  resetWorkflow();
  let secondResult;
  calendarInterleave = function() { secondResult = publicChange(PHONE); };
  publicChange(PHONE);

  assert.ok(secondResult.data.reply.indexOf('عملية تغيير جارية') !== -1);
  assert.strictEqual(confirmedFor(PHONE).length, 1);
  assert.strictEqual(createdEvents.length, 1);
});

test('STRUCTURE — claim persistence stays in AppointmentRepository and B1 atomicUpdate remains used', function() {
  const appointmentSource = fs.readFileSync(path.join(ROOT, 'AppointmentRepository.js'), 'utf8');
  const changeSource = fs.readFileSync(path.join(ROOT, 'Changeservice.js'), 'utf8');
  const slotSource = fs.readFileSync(path.join(ROOT, 'Repositories/SlotRepository.js'), 'utf8');

  assert.ok(appointmentSource.indexOf("'change_claim:' + phone") !== -1);
  assert.ok(appointmentSource.indexOf('PropertiesService') !== -1);
  assert.ok(appointmentSource.indexOf('Lock.runExclusive') !== -1);
  assert.strictEqual(changeSource.indexOf('PropertiesService'), -1);
  assert.strictEqual(changeSource.indexOf('Lock.runExclusive'), -1);
  assert.ok(changeSource.indexOf('AppointmentRepository.acquireChangeClaim') !== -1);
  assert.ok(changeSource.indexOf('AppointmentRepository.releaseChangeClaim') !== -1);
  assert.ok(changeSource.indexOf('SlotRepository.atomicUpdate') !== -1);
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
