'use strict';

/**
 * HardeningRetentionSchedulerSeparation.test.js
 *
 * Proves that historical retention has its own entry point and that the
 * operational Scheduler cannot execute it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, { filename: relativePath });
}

sandbox.Result = {
  ok: function(data) { return { ok: true, data: data }; },
  fail: function(code, message, details) { return { ok: false, error: { code: code, message: message, details: details || null } }; }
};
sandbox.Clock = { now: function() { return new Date(1700000000000); } };
var logEntries = [];
sandbox.LogRepository = { write: function(entry) { logEntries.push(entry); } };

var archiveCalls = 0;
sandbox.ArchiveService = {
  run: function() {
    archiveCalls += 1;
    return sandbox.Result.ok({ mode: 'DRY_RUN', source: 'SYSTEM_LOG' });
  }
};

load('RetentionScheduler.js', 'RetentionScheduler');

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

runTest('operational Scheduler source contains no retention entry point', function() {
  var scheduler = fs.readFileSync(path.join(ROOT, 'Scheduler.js'), 'utf8');
  assert.strictEqual((scheduler.match(/ArchiveService\.run\(\)/g) || []).length, 0);
  assert.strictEqual(scheduler.indexOf('RetentionService.run('), -1);
});

runTest('dedicated retention entry point invokes ArchiveService', function() {
  archiveCalls = 0;
  logEntries = [];
  var result = sandbox.runRetentionScheduler();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(archiveCalls, 1);
  assert.strictEqual(result.data.retention.source, 'SYSTEM_LOG');
  assert.ok(logEntries.some(function(entry) { return entry.command === 'RETENTION_SCHEDULER_RUN'; }));
});

runTest('retention result is surfaced as failure without being converted to success', function() {
  archiveCalls = 0;
  logEntries = [];
  sandbox.ArchiveService.run = function() {
    archiveCalls += 1;
    return sandbox.Result.fail('RETENTION_PARTIAL_FAILURE', 'test failure', { source: 'SYSTEM_LOG' });
  };

  var result = sandbox.runRetentionScheduler();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(result.error.details.durationMs >= 0, true);
  assert.strictEqual(archiveCalls, 1);
  assert.ok(logEntries.some(function(entry) {
    return entry.command === 'RETENTION_SCHEDULER_RUN' && entry.success === false;
  }));
});

// The operational/retention boundary is intentionally explicit: this suite
// is part of the final runtime-gate verification for the deployed topology.
if (process.exitCode !== 1) console.log('3/3 PASS');
