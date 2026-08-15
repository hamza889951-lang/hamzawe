'use strict';

/**
 * HardeningB5.test.js — Scheduler Lock Ownership / Nested ScriptLock Hardening
 *
 * Proves the B5 contract:
 *   Scheduler orchestration serialization = LockService.getUserLock()
 *   Repository data atomicity              = Lock.runExclusive() → getScriptLock()
 *
 * The LockService mock is NOT a passthrough: it implements REAL mutual
 * exclusion per lock type (a second waitLock on an already-held lock throws),
 * and it distinguishes getUserLock() from getScriptLock(), so the tests can
 * prove:
 *   - the Scheduler acquires the UserLock (and never the global ScriptLock);
 *   - a second Scheduler execution cannot enter concurrently (→ SKIPPED);
 *   - repository atomicity inside a Scheduler stage still acquires the
 *     ScriptLock via the unchanged Lock.runExclusive(), without any reliance
 *     on ScriptLock reentrancy;
 *   - the scheduler lock is always released, including on stage failure;
 *   - existing stage/semantics contract is preserved.
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
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, {
    filename: relativePath
  });
}

load('Result.js', 'Result');
load('Config.js', 'Config');

// ── Clock seam ──
sandbox.Clock = { now: function() { return new Date(NOW_MS); } };

// ── PropertiesService mock (liveness semantics) ──
var props = {};
sandbox.PropertiesService = {
  getScriptProperties: function() {
    return {
      getProperty: function(key) {
        return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null;
      },
      setProperty: function(key, value) { props[key] = value; }
    };
  }
};

// ── LogRepository mock ──
var logEntries = [];
sandbox.LogRepository = { write: function(entry) { logEntries.push(entry); } };

sandbox.WhatsAppAdapter = {
  sendMessage: function() { return sandbox.Result.ok({ phone: '' }); }
};

// ─────────────────────────────────────────────
// LockService mock with REAL per-type mutual exclusion.
// getScriptLock() and getUserLock() are independent locks, each with its own
// held-flag; re-acquiring the same lock while held throws. The mock models the
// documented one-holder-at-a-time semantics of LockService so the ownership
// proof is deterministic; it asserts no runtime claim about ScriptLock's
// same-execution reentrancy behavior (B5 removes the nested topology entirely,
// so no proof here depends on it).
// ─────────────────────────────────────────────
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
  getScriptLock: function() {
    lockCalls.push({ type: 'script', op: 'get' });
    return makeLock('script');
  },
  getUserLock: function() {
    lockCalls.push({ type: 'user', op: 'get' });
    return makeLock('user');
  }
};

// Load the REAL Lock wrapper — production code, must remain unchanged:
// Lock.runExclusive() must keep acquiring the global ScriptLock.
load('Infrastructure/Lock.js', 'Lock');

// ─────────────────────────────────────────────
// Stage mocks — recording, controllable results, fixed order.
// ─────────────────────────────────────────────
var stageCalls = [];
var stageResults = {};
var maintenanceObserved = null;

function defaultArchiveRun() {
  stageCalls.push('archive');
  return stageResults.archive;
}

function defaultMaintenanceRun() {
  stageCalls.push('maintenance');
  // Mirror the real chain MaintenanceService.run → SlotRepository
  // (cleanupExpiredReservation/atomicUpdate) → Lock.runExclusive():
  // run the stage body through the REAL Lock wrapper and observe that both
  // locks are held concurrently inside the critical section.
  var observed = {};
  var result = sandbox.Lock.runExclusive('maintenance', function() {
    observed.userLockHeld = userLockHeld;
    observed.scriptLockHeld = scriptLockHeld;
    return stageResults.maintenance;
  });
  maintenanceObserved = observed;
  return result;
}

function defaultHorizonRun() {
  stageCalls.push('horizon');
  return stageResults.horizon;
}

function defaultRemindersRun() {
  stageCalls.push('reminders');
  return stageResults.reminders;
}

function defaultHealthCheckRun() {
  stageCalls.push('healthCheck');
  return stageResults.healthCheck;
}

sandbox.ArchiveService = { run: defaultArchiveRun };
sandbox.MaintenanceService = { run: defaultMaintenanceRun };
sandbox.AvailabilityHorizonMaintainer = { ensureHorizon: defaultHorizonRun };
sandbox.ReminderService = { processPendingReminders: defaultRemindersRun };
sandbox.HealthCheckService = { run: defaultHealthCheckRun };

// Load production Scheduler
load('Scheduler.js', 'Scheduler');

function resetState() {
  props = {};
  logEntries = [];
  lockCalls = [];
  userLockHeld = false;
  scriptLockHeld = false;
  maintenanceObserved = null;
  stageCalls = [];
  stageResults = {
    archive: sandbox.Result.ok({ archived: 0 }),
    maintenance: sandbox.Result.ok({ cleaned: 0, expired: 0 }),
    horizon: sandbox.Result.ok({ generated: 0 }),
    reminders: sandbox.Result.ok({ sent: 0, total: 0 }),
    healthCheck: sandbox.Result.ok({ healthy: true, issues: [], warnings: [] })
  };
  sandbox.ArchiveService.run = defaultArchiveRun;
  sandbox.MaintenanceService.run = defaultMaintenanceRun;
  sandbox.AvailabilityHorizonMaintainer.ensureHorizon = defaultHorizonRun;
  sandbox.ReminderService.processPendingReminders = defaultRemindersRun;
  sandbox.HealthCheckService.run = defaultHealthCheckRun;
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ═══════════════════════════════════════
// A — Scheduler serialization
// ═══════════════════════════════════════

test('A — full run: UserLock acquired, stages in order, lock released, liveness updated', function() {
  resetState();
  const result = sandbox.Scheduler.main();

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(stageCalls,
    ['archive', 'maintenance', 'horizon', 'reminders', 'healthCheck'],
    'stage order must remain Archive → Maintenance → Horizon → Reminders → HealthCheck');
  assert.strictEqual(userLockHeld, false, 'Scheduler must release its lock after the run');
  assert.strictEqual(scriptLockHeld, false, 'repository ScriptLock must be released too');

  const userGets = lockCalls.filter(function(c) { return c.type === 'user' && c.op === 'get'; });
  assert.strictEqual(userGets.length, 1, 'exactly one Scheduler lock acquisition per run');

  assert.ok(props['LAST_SCHEDULER_SUCCESS_MS'], 'operational success must update liveness');
  assert.ok(logEntries.some(function(e) { return e.command === 'SCHEDULER_RUN'; }));
});

test('A2 — second Scheduler cannot enter concurrently: returns SKIPPED and runs no stage', function() {
  resetState();

  // First execution owns the Scheduler lock
  const first = sandbox.LockService.getUserLock();
  first.waitLock(1000);
  assert.strictEqual(userLockHeld, true);

  const second = sandbox.Scheduler.main();

  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.data.status, 'SKIPPED');
  assert.strictEqual(second.data.reason, 'Locked by concurrent run');
  assert.deepStrictEqual(stageCalls, [], 'SKIPPED execution must not run any stage');
  assert.ok(logEntries.some(function(e) { return e.command === 'SCHEDULER_LOCKED'; }));
  assert.strictEqual(userLockHeld, true, 'first execution still owns the lock');

  first.releaseLock();
  assert.strictEqual(userLockHeld, false);
});

test('A3 — deterministic interleave: nested Scheduler during a stage returns SKIPPED (no reentrancy)', function() {
  resetState();
  let nestedResult = null;
  let nestedAttempted = false;
  sandbox.ArchiveService.run = function() {
    stageCalls.push('archive');
    if (!nestedAttempted) {
      nestedAttempted = true;
      // Second Scheduler execution arrives while the first is mid-run
      nestedResult = sandbox.Scheduler.main();
    }
    return sandbox.Result.ok({ archived: 0 });
  };

  const outer = sandbox.Scheduler.main();

  assert.strictEqual(outer.ok, true);
  assert.strictEqual(nestedAttempted, true, 'interleaving must have been attempted');
  assert.ok(nestedResult, 'nested execution must have produced a result');
  assert.strictEqual(nestedResult.ok, true);
  assert.strictEqual(nestedResult.data.status, 'SKIPPED');
  assert.deepStrictEqual(stageCalls,
    ['archive', 'maintenance', 'horizon', 'reminders', 'healthCheck'],
    'only the outer run executes stages — the nested run must not');
  assert.strictEqual(userLockHeld, false, 'outer run releases the lock at the end');
});

// ═══════════════════════════════════════
// B — Scheduler lock ownership
// ═══════════════════════════════════════

test('B — Scheduler acquires the UserLock, never the global ScriptLock', function() {
  resetState();
  sandbox.Scheduler.main();

  // First lock interaction of the whole run is the Scheduler's UserLock
  assert.strictEqual(lockCalls[0].type, 'user');
  assert.strictEqual(lockCalls[0].op, 'get');

  const userGets = lockCalls.filter(function(c) { return c.type === 'user' && c.op === 'get'; });
  assert.strictEqual(userGets.length, 1, 'Scheduler must acquire exactly one UserLock per run');

  // The 1-second scheduler lock timeout is preserved
  const userWaits = lockCalls.filter(function(c) { return c.type === 'user' && c.op === 'waitLock'; });
  assert.strictEqual(userWaits.length, 1);
  assert.strictEqual(userWaits[0].timeoutMs, 1000, 'scheduler waitLock timeout must remain 1000ms');

  // The Scheduler-level lock must never be the ScriptLock: the first waitLock
  // (which precedes every stage) is a UserLock wait
  const firstWait = lockCalls.filter(function(c) { return c.op === 'waitLock'; })[0];
  assert.strictEqual(firstWait.type, 'user',
    'Scheduler serialization must not consume the repository ScriptLock');
});

// ═══════════════════════════════════════
// C — Repository atomicity unchanged
// ═══════════════════════════════════════

test('C — Lock.runExclusive still acquires the ScriptLock inside a Scheduler stage (no reentrancy needed)', function() {
  resetState();
  const result = sandbox.Scheduler.main();

  assert.strictEqual(result.ok, true);
  assert.ok(maintenanceObserved, 'maintenance stage must run through Lock.runExclusive');

  // Inside the stage critical section BOTH locks are held simultaneously:
  // the Scheduler UserLock AND the repository ScriptLock — they are distinct
  // locks, so the stage never depends on ScriptLock reentrancy.
  assert.strictEqual(maintenanceObserved.userLockHeld, true);
  assert.strictEqual(maintenanceObserved.scriptLockHeld, true);

  // The ScriptLock acquisitions inside the run come exclusively from
  // Lock.runExclusive (the repository chain)…
  const scriptWaits = lockCalls.filter(function(c) { return c.type === 'script' && c.op === 'waitLock'; });
  assert.strictEqual(scriptWaits.length, 1);
  assert.strictEqual(scriptWaits[0].timeoutMs, 5000, 'Lock.runExclusive default timeout must stay 5000ms');
  assert.strictEqual(scriptLockHeld, false, 'script lock released after the stage');
});

test('C2 — stage ScriptLock is independent: a concurrent holder blocks it, Scheduler itself still runs', function() {
  resetState();

  // Simulate a concurrent webhook-like execution holding the ScriptLock
  const webhook = sandbox.LockService.getScriptLock();
  webhook.waitLock(5000);
  assert.strictEqual(scriptLockHeld, true);

  // The Scheduler still runs (its own UserLock is free — pre-B5 this call
  // would have been SKIPPED or self-deadlocked instead)…
  const result = sandbox.Scheduler.main();

  // …but the maintenance stage's Lock.runExclusive fails with LOCK_TIMEOUT:
  // repository atomicity is still fully protected by the ScriptLock and never
  // relies on hidden reentrancy.
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'SCHEDULER_PARTIAL_FAILURE');
  assert.ok(logEntries.some(function(e) { return e.command === 'SCHEDULER_STAGE_FAILED'; }));
  assert.strictEqual(props['LAST_SCHEDULER_SUCCESS_MS'], undefined,
    'operational failure must not update liveness');
  assert.strictEqual(userLockHeld, false, 'scheduler lock still released after stage failure');

  // Once the concurrent holder releases, the same stage path succeeds
  webhook.releaseLock();
  const retry = sandbox.Scheduler.main();
  assert.strictEqual(retry.ok, true);
  assert.ok(maintenanceObserved);
  assert.strictEqual(maintenanceObserved.scriptLockHeld, true);
  assert.ok(props['LAST_SCHEDULER_SUCCESS_MS']);
});

// ═══════════════════════════════════════
// D — Lock release on failure
// ═══════════════════════════════════════

test('D — scheduler lock released even when a stage fails; failure semantics unchanged', function() {
  resetState();
  stageResults.maintenance = sandbox.Result.fail('MAINTENANCE_FAILED', 'test failure');

  const result = sandbox.Scheduler.main();

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'SCHEDULER_PARTIAL_FAILURE');
  assert.strictEqual(userLockHeld, false, 'lock must be released after failure');
  assert.strictEqual(scriptLockHeld, false, 'script lock must be released after failure');
  assert.strictEqual(props['LAST_SCHEDULER_SUCCESS_MS'], undefined,
    'operational failure must not update liveness');

  const failedLogs = logEntries.filter(function(e) { return e.command === 'SCHEDULER_STAGE_FAILED'; });
  assert.ok(failedLogs.length >= 1, 'stage failure must be logged');
  assert.ok(failedLogs.some(function(e) { return e.error.indexOf('maintenance') !== -1; }));

  // Stage order contract still holds even on failure
  assert.deepStrictEqual(stageCalls,
    ['archive', 'maintenance', 'horizon', 'reminders', 'healthCheck']);
});

// ═══════════════════════════════════════
// E — Existing stage semantics preserved
// ═══════════════════════════════════════

test('E — archive-only failure keeps operationalOk: Result.ok with archiveWarning + liveness updated', function() {
  resetState();
  stageResults.archive = sandbox.Result.fail('ARCHIVE_READ_FAILED', 'test archive failure');

  const result = sandbox.Scheduler.main();

  assert.strictEqual(result.ok, true, 'archive is non-operational — overall run stays ok');
  assert.ok(result.data.archiveWarning);
  assert.strictEqual(result.data.archiveWarning.indexOf('ARCHIVE_READ_FAILED') !== -1, true);
  assert.ok(props['LAST_SCHEDULER_SUCCESS_MS'], 'operationalOk true → liveness updated');
  assert.strictEqual(userLockHeld, false);
  assert.ok(logEntries.some(function(e) { return e.command === 'SCHEDULER_RUN'; }));
});

// ═══════════════════════════════════════
// STRUCTURE — source-level regression guards
// ═══════════════════════════════════════

test('STRUCTURE — Scheduler uses getUserLock; Lock.runExclusive keeps getScriptLock', function() {
  const schedulerSource = fs.readFileSync(path.join(ROOT, 'Scheduler.js'), 'utf8');
  const lockSource = fs.readFileSync(path.join(ROOT, 'Infrastructure/Lock.js'), 'utf8');

  assert.ok(schedulerSource.indexOf('getUserLock()') !== -1,
    'Scheduler must acquire the UserLock');
  assert.strictEqual(schedulerSource.indexOf('getScriptLock()'), -1,
    'Scheduler must never acquire the global ScriptLock');
  assert.ok(lockSource.indexOf('getScriptLock()') !== -1,
    'Lock.runExclusive must keep acquiring the ScriptLock');
  assert.strictEqual(lockSource.indexOf('getUserLock()'), -1,
    'Lock must not be changed to a UserLock');
});

// ─────────────────────────────────────────────
// Run all tests
// ─────────────────────────────────────────────
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
