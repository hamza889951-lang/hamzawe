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
load('ProcessedMessagesRepository.js', 'ProcessedMessagesRepository');

var storage = {};
var currentTimeMs = NOW_MS;
var deleteCalls = [];
var getPropertiesCalls = 0;
var getPropertiesFailure = false;

function resetState() {
  storage = {};
  currentTimeMs = NOW_MS;
  deleteCalls = [];
  getPropertiesCalls = 0;
  getPropertiesFailure = false;

  sandbox.Clock = {
    now: function() { return new Date(currentTimeMs); }
  };

  sandbox.Lock = {
    runExclusive: function(key, fn) {
      assert.strictEqual(key, 'idempotency');
      return fn();
    }
  };

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(key) {
          return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
        },
        getProperties: function() {
          getPropertiesCalls++;
          if (getPropertiesFailure) throw new Error('SNAPSHOT_FAILURE');
          return storage;
        },
        setProperty: function(key, value) {
          storage[key] = value;
        },
        deleteProperty: function(key) {
          deleteCalls.push(key);
          delete storage[key];
        }
      };
    }
  };
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function freshTimestamp(offsetMs) {
  return String(NOW_MS - WINDOW_MS + 1 + offsetMs);
}

function expiredTimestamp(offsetMs) {
  return String(NOW_MS - WINDOW_MS - 1 - offsetMs);
}

test('B2-B1 — cleanup inspection is bounded independently from delete count', function() {
  resetState();

  var inspectedValues = {};
  for (var i = 0; i < 100; i++) {
    Object.defineProperty(inspectedValues, 'msg_fresh_' + String(i).padStart(3, '0'), {
      enumerable: true,
      configurable: true,
      get: function() { return freshTimestamp(0); }
    });
  }
  Object.defineProperty(inspectedValues, 'msg_expired_after_bound', {
    enumerable: true,
    configurable: true,
    get: function() {
      throw new Error('OUT_OF_BOUND_VALUE_READ');
    }
  });

  storage = inspectedValues;

  // getProperties returns the controlled object directly. A read beyond the
  // 100-key inspection budget would execute the sentinel getter and fail.
  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(key) {
          return key === 'msg_bound' ? null : null;
        },
        getProperties: function() {
          getPropertiesCalls++;
          return storage;
        },
        setProperty: function(key, value) {
          storage[key] = value;
        },
        deleteProperty: function(key) {
          deleteCalls.push(key);
          delete storage[key];
        }
      };
    }
  };

  var result = sandbox.ProcessedMessagesRepository.claim('msg_bound', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(getPropertiesCalls, 1);
  assert.strictEqual(deleteCalls.length, 0);
  assert.strictEqual(sandbox.ProcessedMessagesRepository.CLEANUP_MAX_INSPECTED_PER_CLAIM, 100);
});

test('B2-B2 — removal remains capped separately from inspection bound', function() {
  resetState();

  for (var i = 0; i < 25; i++) {
    storage['msg_old_' + String(i).padStart(2, '0')] = expiredTimestamp(i);
  }

  var result = sandbox.ProcessedMessagesRepository.claim('msg_delete_bound', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
  assert.strictEqual(deleteCalls.length, 20);
  assert.strictEqual(storage.msg_delete_bound, String(NOW_MS));
});

test('B2-B3 — active duplicate does not invoke cleanup snapshot', function() {
  resetState();
  storage.msg_duplicate = String(NOW_MS - 1);
  storage.msg_old = expiredTimestamp(1);

  var result = sandbox.ProcessedMessagesRepository.claim('msg_duplicate', NOW_MS, WINDOW_MS);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'DUPLICATE');
  assert.strictEqual(getPropertiesCalls, 0);
  assert.strictEqual(storage.msg_old, expiredTimestamp(1));
});

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
