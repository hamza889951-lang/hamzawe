'use strict';

/**
 * HardeningRetentionSchedulerGate.test.js
 *
 * Scheduler retention must be an explicit operational opt-in.
 * The retention engine remains available directly through RetentionService,
 * but the daily Scheduler-facing ArchiveService boundary must not perform a
 * full storage scan unless RETENTION_SCHEDULER_ENABLED=TRUE.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = vm.createContext({ console: console });
const props = {};

sandbox.Result = {
  ok: function(data) { return { ok: true, data: data }; },
  fail: function(code, message) { return { ok: false, error: { code: code, message: message } }; }
};

sandbox.PropertiesService = {
  getScriptProperties: function() {
    return {
      getProperty: function(key) { return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null; }
    };
  }
};

var retentionCalls = [];
sandbox.RetentionService = {
  SOURCES: { SYSTEM_LOG: 'SYSTEM_LOG', Availability: 'Availability' },
  run: function(options) {
    retentionCalls.push(options);
    return sandbox.Result.ok({ status: 'EXECUTED', options: options });
  }
};

function load(relativePath, globalName) {
  var source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, { filename: relativePath });
}

load('ArchiveService.js', 'ArchiveService');

function reset() {
  Object.keys(props).forEach(function(key) { delete props[key]; });
  retentionCalls = [];
}

function runTest(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (e) {
    console.error('FAIL', name);
    console.error(e.stack || e.message || e);
    process.exitCode = 1;
  }
}

runTest('default Scheduler retention is disabled and performs no RetentionService call', function() {
  reset();
  var result = sandbox.ArchiveService.run();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'SKIPPED');
  assert.strictEqual(result.data.reason, 'RETENTION_SCHEDULER_DISABLED');
  assert.strictEqual(retentionCalls.length, 0);
});

runTest('Scheduler retention executes only with explicit TRUE enablement', function() {
  reset();
  props.RETENTION_SCHEDULER_ENABLED = 'TRUE';

  var result = sandbox.ArchiveService.run();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'EXECUTED');
  assert.strictEqual(retentionCalls.length, 1);
  assert.strictEqual(retentionCalls[0].sources.length, 1);
  assert.strictEqual(retentionCalls[0].sources[0], 'SYSTEM_LOG');
});

runTest('non-TRUE values remain disabled', function() {
  reset();
  props.RETENTION_SCHEDULER_ENABLED = 'true-ish';

  var result = sandbox.ArchiveService.run();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'SKIPPED');
  assert.strictEqual(retentionCalls.length, 0);
});

if (process.exitCode !== 1) console.log('3/3 PASS');
