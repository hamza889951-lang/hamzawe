'use strict';

/**
 * HardeningB5.test.js — Scheduler Lock Ownership / Operational Boundary
 *
 * Proves:
 *   - Scheduler orchestration serialization = UserLock
 *   - repository atomicity                     = ScriptLock via Lock.runExclusive
 *   - retention is NOT an operational Scheduler stage
 *   - concurrent Scheduler executions are rejected
 *   - the scheduler lock is released on normal and failed runs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_MS = 1700000000000;
const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, { filename: relativePath });
}

load('Result.js', 'Result');
load('Config.js', 'Config');
sandbox.Clock = { now: function() { return new Date(NOW_MS); } };

var props = {};
sandbox.PropertiesService = {
  getScriptProperties: function() {
    return {
      getProperty: function(key) { return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null; },
      setProperty: function(key, value) { props[key] = value; }
    };
  }
};

var logEntries = [];
sandbox.LogRepository = { write: function(entry) { logEntries.push(entry); } };
sandbox.WhatsAppAdapter = { sendMessage: function() { return sandbox.Result.ok({}); } };

var lockCalls = [];
var userLockHeld = false;
var scriptLockHeld = false;
function makeLock(type) {
  return {
    waitLock: function(timeoutMs) {
      lockCalls.push({ type: type, op: 'waitLock', timeoutMs: timeoutMs });
      var held = type === 'user' ? userLockHeld : scriptLockHeld;
      if (held) throw new Error(type + '_LOCK_ALREADY_HELD');
      if (type === 'user') userLockHeld = true; else scriptLockHeld = true;
    },
    releaseLock: function() {
      lockCalls.push({ type: type, op: 'releaseLock' });
      if (type === 'user') userLockHeld = false; else scriptLockHeld = false;
    }
  };
}
sandbox.LockService = {
  getScriptLock: function() { lockCalls.push({ type: 'script', op: 'get' }); return makeLock('script'); },
  getUserLock: function() { lockCalls.push({ type: 'user', op: 'get' }); return makeLock('user'); }
};
load('Infrastructure/Lock.js', 'Lock');

var stageCalls = [];
var stageResults = {};
var maintenanceObserved = null;

function maintenanceRun() {
  stageCalls.push('maintenance');
  var observed = {};
  var result = sandbox.Lock.runExclusive('maintenance', function() {
    observed.userLockHeld = userLockHeld;
    observed.scriptLockHeld = scriptLockHeld;
    return stageResults.maintenance;
  });
  maintenanceObserved = observed;
  return result;
}
function horizonRun() { stageCalls.push('horizon'); return stageResults.horizon; }
function disruptionRun() { stageCalls.push('disruption'); return stageResults.disruption; }
function reminderRun() { stageCalls.push('reminders'); return stageResults.reminders; }
function healthRun() { stageCalls.push('healthCheck'); return stageResults.healthCheck; }

var archiveCalls = 0;
sandbox.ArchiveService = { run: function() { archiveCalls += 1; throw new Error('ARCHIVE_MUST_BE_SEPARATED'); } };
sandbox.MaintenanceService = { run: maintenanceRun };
sandbox.AvailabilityHorizonMaintainer = { ensureHorizon: horizonRun };
sandbox.PatientDisruptionService = { processDisruptions: disruptionRun };
sandbox.ReminderService = { processPendingReminders: reminderRun };
sandbox.HealthCheckService = { run: healthRun };
load('Scheduler.js', 'Scheduler');

function resetState() {
  props = {};
  logEntries = [];
  lockCalls = [];
  userLockHeld = false;
  scriptLockHeld = false;
  stageCalls = [];
  archiveCalls = 0;
  maintenanceObserved = null;
  stageResults = {
    maintenance: sandbox.Result.ok({ cleaned: 0, expired: 0 }),
    horizon: sandbox.Result.ok({ generated: 0 }),
    disruption: sandbox.Result.ok({}),
    reminders: sandbox.Result.ok({ sent: 0 }),
    healthCheck: sandbox.Result.ok({ healthy: true, issues: [], warnings: [] })
  };
}

function test(name, fn) {
  try {
    resetState();
    fn();
    console.log('PASS', name);
  } catch (e) {
    console.error('FAIL', name);
    console.error(e.stack || e.message || e);
    process.exitCode = 1;
  }
}

test('A — operational stages run without touching ArchiveService', function() {
  const result = sandbox.Scheduler.main();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(archiveCalls, 0);
  assert.deepStrictEqual(stageCalls, ['maintenance', 'horizon', 'disruption', 'reminders', 'healthCheck']);
  assert.strictEqual(result.data.retention, 'SEPARATED');
  assert.ok(result.data.stageDurationsMs.horizon !== undefined);
});

test('B — Scheduler serialization uses UserLock only', function() {
  sandbox.Scheduler.main();
  assert.strictEqual(lockCalls[0].type, 'user');
  assert.strictEqual(lockCalls[0].op, 'get');
  const userWaits = lockCalls.filter(function(c) { return c.type === 'user' && c.op === 'waitLock'; });
  assert.strictEqual(userWaits.length, 1);
  assert.strictEqual(userWaits[0].timeoutMs, 1000);
});

test('C — repository atomicity still uses ScriptLock inside Scheduler stage', function() {
  const result = sandbox.Scheduler.main();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(maintenanceObserved.userLockHeld, true);
  assert.strictEqual(maintenanceObserved.scriptLockHeld, true);
  const scriptWaits = lockCalls.filter(function(c) { return c.type === 'script' && c.op === 'waitLock'; });
  assert.strictEqual(scriptWaits.length, 1);
  assert.strictEqual(scriptWaits[0].timeoutMs, 5000);
});

test('D — concurrent Scheduler execution is skipped and runs no stages', function() {
  const first = sandbox.LockService.getUserLock();
  first.waitLock(1000);
  const second = sandbox.Scheduler.main();
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.data.status, 'SKIPPED');
  assert.deepStrictEqual(stageCalls, []);
  first.releaseLock();
});

test('E — nested Scheduler attempt during a stage is skipped', function() {
  var nested = null;
  sandbox.MaintenanceService.run = function() {
    stageCalls.push('maintenance');
    nested = sandbox.Scheduler.main();
    return stageResults.maintenance;
  };
  const outer = sandbox.Scheduler.main();
  assert.strictEqual(outer.ok, true);
  assert.strictEqual(nested.data.status, 'SKIPPED');
  assert.deepStrictEqual(stageCalls, ['maintenance', 'horizon', 'disruption', 'reminders', 'healthCheck']);
});

test('F — scheduler lock is released after operational failure', function() {
  stageResults.maintenance = sandbox.Result.fail('MAINTENANCE_FAILED', 'test failure');
  const result = sandbox.Scheduler.main();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'SCHEDULER_PARTIAL_FAILURE');
  assert.strictEqual(userLockHeld, false);
  assert.strictEqual(scriptLockHeld, false);
  assert.strictEqual(props.LAST_SCHEDULER_SUCCESS_MS, undefined);
});

if (process.exitCode !== 1) console.log('6/6 PASS');
