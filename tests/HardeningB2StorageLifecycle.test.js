'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_MS = 1700000000000;
const WINDOW_MS = 300000;

const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(
    source + '\nthis.' + globalName + ' = ' + globalName + ';',
    sandbox,
    { filename: relativePath }
  );
}

load('Result.js', 'Result');

var currentTimeMs = NOW_MS;
var storage = {};
var getPropertiesCalls = 0;
var deleteCalls = [];
var failGetProperties = false;
var failDelete = false;
var failRead = false;
var failWrite = false;
var lockCalls = 0;
var lockKey = null;

function resetState(seed) {
  currentTimeMs = NOW_MS;
  storage = seed || {};
  getPropertiesCalls = 0;
  deleteCalls = [];
  failGetProperties = false;
  failDelete = false;
  failRead = false;
  failWrite = false;
  lockCalls = 0;
  lockKey = null;

  sandbox.Clock = {
    now: function() { return new Date(currentTimeMs); }
  };

  sandbox.Lock = {
    runExclusive: function(key, fn) {
      lockCalls++;
      lockKey = key;
      return fn();
    }
  };

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(key) {
          if (failRead) throw new Error('READ_FAILURE');
          return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
        },
        setProperty: function(key, value) {
          if (failWrite) throw new Error('WRITE_FAILURE');
          storage[key] = value;
        },
        getProperties: function() {
          getPropertiesCalls++;
          if (failGetProperties) throw new Error('SNAPSHOT_FAILURE');
          return Object.assign({}, storage);
        },
        deleteProperty: function(key) {
          deleteCalls.push(key);
          if (failDelete) throw new Error('DELETE_FAILURE');
          delete storage[key];
        }
      };
    }
  };
}

load('ProcessedMessagesRepository.js', 'ProcessedMessagesRepository');

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function expired(ms) {
  return String(NOW_MS - WINDOW_MS - ms);
}

// ─────────────────────────────────────────
// Contract: namespace / eligibility
// ─────────────────────────────────────────
test('B2-L1 — expired numeric msg_* claims are cleaned', function() {
  resetState({
    'msg_old_a': expired(1),
    'msg_old_b': expired(2),
    'msg_fresh': String(NOW_MS - WINDOW_MS + 1),
    'msg_future': String(NOW_MS + 1000),
    'msg_bad': 'not-a-timestamp',
    'other_state': expired(3)
  });

  var result = sandbox.ProcessedMessagesRepository.claim('msg_current', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(storage.msg_old_a, undefined);
  assert.strictEqual(storage.msg_old_b, undefined);
  assert.strictEqual(storage.msg_fresh, String(NOW_MS - WINDOW_MS + 1));
  assert.strictEqual(storage.msg_future, String(NOW_MS + 1000));
  assert.strictEqual(storage.msg_bad, 'not-a-timestamp');
  assert.strictEqual(storage.other_state, expired(3));
  assert.strictEqual(storage.msg_current, String(NOW_MS));
});

test('B2-L2 — numeric timestamp boundary: 299999 preserved, 300000 cleaned', function() {
  resetState({
    'msg_299999': String(NOW_MS - WINDOW_MS + 1),
    'msg_300000': String(NOW_MS - WINDOW_MS),
    'msg_300001': String(NOW_MS - WINDOW_MS - 1)
  });

  var result = sandbox.ProcessedMessagesRepository.claim('msg_boundary', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(storage.msg_299999, String(NOW_MS - WINDOW_MS + 1));
  assert.strictEqual(storage.msg_300000, undefined);
  assert.strictEqual(storage.msg_300001, undefined);
});

test('B2-L3 — malformed msg_* values are preserved', function() {
  resetState({
    'msg_empty': '',
    'msg_text_suffix': '1699999999999abc',
    'msg_decimal': '1699999999999.5',
    'msg_negative': '-1699999999999'
  });

  var result = sandbox.ProcessedMessagesRepository.claim('msg_malformed', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(storage.msg_empty, '');
  assert.strictEqual(storage.msg_text_suffix, '1699999999999abc');
  assert.strictEqual(storage.msg_decimal, '1699999999999.5');
  assert.strictEqual(storage.msg_negative, '-1699999999999');
});

// ─────────────────────────────────────────
// Contract: current claim / atomicity
// ─────────────────────────────────────────
test('B2-L4 — expired current claim is safely reacquired and not deleted by cleanup', function() {
  resetState({
    'msg_current': String(NOW_MS - WINDOW_MS),
    'msg_old': String(NOW_MS - WINDOW_MS - 10)
  });

  var result = sandbox.ProcessedMessagesRepository.claim('msg_current', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(storage.msg_current, String(NOW_MS));
  assert.ok(deleteCalls.indexOf('msg_current') === -1, 'Current key must not be removed by cleanup');
});

test('B2-L5 — valid duplicate returns before cleanup and preserves all state', function() {
  resetState({
    'msg_current': String(NOW_MS - 1),
    'msg_old': String(NOW_MS - WINDOW_MS - 10)
  });

  var result = sandbox.ProcessedMessagesRepository.claim('msg_current', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'DUPLICATE');
  assert.strictEqual(getPropertiesCalls, 0, 'No cleanup is needed for an active duplicate');
  assert.strictEqual(storage.msg_old, String(NOW_MS - WINDOW_MS - 10));
});

test('B2-L6 — claim remains atomic under the same idempotency lock', function() {
  resetState();

  var result = sandbox.ProcessedMessagesRepository.claim('msg_atomic', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(lockCalls, 1);
  assert.strictEqual(lockKey, 'idempotency');
});

// ─────────────────────────────────────────
// Contract: bounded cleanup
// ─────────────────────────────────────────
test('B2-L7 — cleanup deletes no more than CLEANUP_MAX_PER_CLAIM', function() {
  var seed = {};
  for (var i = 0; i < 25; i++) {
    seed['msg_old_' + String(i).padStart(2, '0')] = expired(i);
  }
  resetState(seed);

  var result = sandbox.ProcessedMessagesRepository.claim('msg_bound', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(deleteCalls.length, sandbox.ProcessedMessagesRepository.CLEANUP_MAX_PER_CLAIM);
  assert.strictEqual(storage.msg_bound, String(NOW_MS));
});

test('B2-L8 — repeated claims converge by cleaning additional expired candidates', function() {
  var seed = {};
  for (var i = 0; i < 25; i++) {
    seed['msg_old_' + String(i).padStart(2, '0')] = expired(i);
  }
  resetState(seed);

  var first = sandbox.ProcessedMessagesRepository.claim('msg_one', NOW_MS, WINDOW_MS);
  var remainingAfterFirst = Object.keys(storage).filter(function(key) {
    return key.indexOf('msg_old_') === 0;
  }).length;

  var second = sandbox.ProcessedMessagesRepository.claim('msg_two', NOW_MS + 1, WINDOW_MS);
  var remainingAfterSecond = Object.keys(storage).filter(function(key) {
    return key.indexOf('msg_old_') === 0;
  }).length;

  assert.strictEqual(first.data.status, 'ACQUIRED');
  assert.strictEqual(second.data.status, 'ACQUIRED');
  assert.strictEqual(remainingAfterFirst, 5);
  assert.strictEqual(remainingAfterSecond, 0);
});

// ─────────────────────────────────────────
// Contract: failure semantics
// ─────────────────────────────────────────
test('B2-L9 — cleanup snapshot failure does not fail an otherwise valid claim', function() {
  resetState({
    'msg_old': expired(1)
  });
  failGetProperties = true;

  var result = sandbox.ProcessedMessagesRepository.claim('msg_cleanup_failure', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(storage.msg_cleanup_failure, String(NOW_MS));
  assert.strictEqual(storage.msg_old, expired(1));
});

test('B2-L10 — cleanup delete failure does not fail an otherwise valid claim', function() {
  resetState({
    'msg_old': expired(1)
  });
  failDelete = true;

  var result = sandbox.ProcessedMessagesRepository.claim('msg_cleanup_delete_failure', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(storage.msg_cleanup_delete_failure, String(NOW_MS));
  assert.strictEqual(storage.msg_old, expired(1));
});

test('B2-L11 — primary read failure remains CLAIM_READ_FAILED', function() {
  resetState();
  failRead = true;

  var result = sandbox.ProcessedMessagesRepository.claim('msg_read_failure', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'CLAIM_READ_FAILED');
});

test('B2-L12 — primary write failure remains CLAIM_PERSISTENCE_FAILED', function() {
  resetState();
  failWrite = true;

  var result = sandbox.ProcessedMessagesRepository.claim('msg_write_failure', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'CLAIM_PERSISTENCE_FAILED');
});

// ─────────────────────────────────────────
// Run
// ─────────────────────────────────────────
var failures = 0;
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
console.log(tests.length + '/' + tests.length + ' tests passed');
