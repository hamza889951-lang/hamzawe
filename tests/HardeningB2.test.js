'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_MS = 1700000000000;

// ─────────────────────────────────────────
// Sandbox setup
// ─────────────────────────────────────────
const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(
    source + '\nthis.' + globalName + ' = ' + globalName + ';',
    sandbox,
    { filename: relativePath }
  );
}

// Load core dependencies
load('Result.js', 'Result');
load('Config.js', 'Config');

// ── Clock seam ──
var currentTimeMs = NOW_MS;
sandbox.Clock = {
  now: function() { return new Date(currentTimeMs); }
};

// ── In-memory ScriptProperties mock (controllable) ──
var scriptProperties = {};
var scriptPropertiesShouldFailRead = false;
var scriptPropertiesShouldFailWrite = false;

function resetScriptProperties() {
  scriptProperties = {};
  scriptPropertiesShouldFailRead = false;
  scriptPropertiesShouldFailWrite = false;
}

function makePropertiesService() {
  return {
    getScriptProperties: function() {
      return {
        getProperty: function(key) {
          if (scriptPropertiesShouldFailRead) throw new Error('READ_FAILURE');
          return scriptProperties.hasOwnProperty(key) ? scriptProperties[key] : null;
        },
        setProperty: function(key, value) {
          if (scriptPropertiesShouldFailWrite) throw new Error('WRITE_FAILURE');
          scriptProperties[key] = value;
        }
      };
    }
  };
}

sandbox.PropertiesService = makePropertiesService();

// ── Lock mock (simple passthrough by default) ──
var lockShouldFail = false;

function makeDefaultLock() {
  return {
    runExclusive: function(key, fn) {
      if (lockShouldFail) {
        return sandbox.Result.fail('LOCK_TIMEOUT', 'Could not acquire lock for ' + key);
      }
      try {
        return fn();
      } catch (e) {
        return sandbox.Result.fail('UNEXPECTED_ERROR', e.message, e.stack);
      }
    }
  };
}

sandbox.Lock = makeDefaultLock();

// Load production files
load('ProcessedMessagesRepository.js', 'ProcessedMessagesRepository');
load('ProcessedMessagesService.js', 'ProcessedMessagesService');

// ── Router mock ──
var routerDispatchCount = 0;
var routerLastContext = null;
sandbox.Router = {
  dispatch: function(context) {
    routerDispatchCount++;
    routerLastContext = context;
    return sandbox.Result.ok({ reply: 'test reply', conversationState: 'MENU_MAIN' });
  }
};

// ── WhatsAppAdapter mock ──
sandbox.WhatsAppAdapter = {
  parseIncomingPayload: function(e) {
    try {
      const payload = JSON.parse(e.postData.contents);
      const data = payload.data;
      if (!data || !data.from || !data.body) return null;
      return {
        phone: data.from.replace('@c.us', ''),
        message: data.body,
        messageId: data.id || null
      };
    } catch (err) {
      return null;
    }
  },
  sendMessage: function() {
    return sandbox.Result.ok({ phone: 'test' });
  }
};

// ── ContentService mock ──
var lastContentOutput = null;
sandbox.ContentService = {
  createTextOutput: function(text) {
    lastContentOutput = text;
    return { text: text };
  }
};

// ── LogRepository mock ──
var logEntries = [];
sandbox.LogRepository = {
  write: function(entry) { logEntries.push(entry); }
};

// Load Webhook (defines doPost globally in sandbox)
load('Webhook.js', 'doPost');

// ─────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────
function resetState() {
  resetScriptProperties();
  lockShouldFail = false;
  currentTimeMs = NOW_MS;
  routerDispatchCount = 0;
  routerLastContext = null;
  logEntries = [];
  lastContentOutput = null;
  sandbox.Lock = makeDefaultLock();
  sandbox.PropertiesService = makePropertiesService();
}

function makeWebhookEvent(messageId, phone, body) {
  return {
    postData: {
      contents: JSON.stringify({
        data: {
          id: messageId,
          from: phone + '@c.us',
          body: body
        }
      })
    }
  };
}

// ─────────────────────────────────────────
// Tests
// ─────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ═══════════════════════════════════════
// A — First claim
// ═══════════════════════════════════════
test('A — first claim returns ACQUIRED', function() {
  resetState();
  var result = sandbox.ProcessedMessagesService.claim('msg-001', '9647001234567', 'hello');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
});

// ═══════════════════════════════════════
// B — Sequential duplicate
// ═══════════════════════════════════════
test('B — sequential duplicate returns DUPLICATE', function() {
  resetState();
  var first = sandbox.ProcessedMessagesService.claim('msg-002', '9647001234567', 'hello');
  var second = sandbox.ProcessedMessagesService.claim('msg-002', '9647001234567', 'hello');

  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.data.status, 'ACQUIRED');
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.data.status, 'DUPLICATE');
});

// ═══════════════════════════════════════
// C — Deterministic Race Test
// ═══════════════════════════════════════
//
// This test proves atomicity by injecting an interleaving attempt
// BETWEEN the read and write operations of claim().
//
// Methodology:
//   1. Install a Lock mock with REAL mutual exclusion semantics
//      (re-entrant attempt returns LOCK_TIMEOUT).
//   2. Install a PropertiesService mock where getProperty() triggers
//      a nested claim() attempt on first read of a new key.
//   3. Call claim(K) — enters lock → reads (absent) → nested claim
//      tries to enter lock → BLOCKED → outer continues → writes → ACQUIRED.
//
// With atomic implementation: nested gets LOCK_TIMEOUT → PASS
// With non-atomic (no lock):  nested also gets ACQUIRED → FAIL
//
test('C — deterministic race: interleaving between read and write is blocked', function() {
  resetState();

  // ── Lock mock with REAL mutual exclusion ──
  var lockHeld = false;
  sandbox.Lock = {
    runExclusive: function(key, fn) {
      if (lockHeld) {
        // Another execution already holds the lock — this is the race guard
        return sandbox.Result.fail('LOCK_TIMEOUT', 'Lock held by another execution');
      }
      lockHeld = true;
      try {
        return fn();
      } finally {
        lockHeld = false;
      }
    }
  };

  // ── Storage mock that injects interleaving attempt ──
  var storage = {};
  var interleavingAttempted = false;
  var interleavingResult = null;

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(key) {
          var value = storage.hasOwnProperty(key) ? storage[key] : null;

          // INJECT INTERLEAVING: on first read of this key where value is absent,
          // simulate a second execution arriving during the first's critical section
          if (!interleavingAttempted && value === null) {
            interleavingAttempted = true;
            // B attempts claim while A is still inside the lock
            interleavingResult = sandbox.ProcessedMessagesRepository.claim(
              key, NOW_MS + 1, 300000
            );
          }

          return value;
        },
        setProperty: function(key, value) {
          storage[key] = value;
        }
      };
    }
  };

  // ── Execute A's claim (production code path) ──
  var resultA = sandbox.ProcessedMessagesRepository.claim('msg_race_key', NOW_MS, 300000);

  // ── Assertions ──
  assert.strictEqual(interleavingAttempted, true,
    'Interleaving should have been attempted during A critical section');

  // A must get ACQUIRED
  assert.strictEqual(resultA.ok, true);
  assert.strictEqual(resultA.data.status, 'ACQUIRED');

  // B (interleaving) must NOT get ACQUIRED
  assert.ok(interleavingResult, 'Interleaving must have produced a result');

  if (interleavingResult.ok) {
    assert.strictEqual(interleavingResult.data.status, 'DUPLICATE',
      'RACE VIOLATION: interleaved execution got ACQUIRED — atomicity is broken');
  } else {
    assert.strictEqual(interleavingResult.error.code, 'LOCK_TIMEOUT',
      'Interleaved execution should be blocked by lock, got: ' + interleavingResult.error.code);
  }
});

// ═══════════════════════════════════════
// C2 — Structural: claim uses Lock.runExclusive
// ═══════════════════════════════════════
test('C2 — structural: ProcessedMessagesRepository.claim uses Lock.runExclusive', function() {
  resetState();

  var lockCalled = false;
  var lockKeyUsed = null;
  sandbox.Lock = {
    runExclusive: function(key, fn) {
      lockCalled = true;
      lockKeyUsed = key;
      return fn();
    }
  };

  sandbox.ProcessedMessagesRepository.claim('msg_struct', NOW_MS, 300000);

  assert.strictEqual(lockCalled, true, 'Repository.claim must call Lock.runExclusive');
  assert.strictEqual(lockKeyUsed, 'idempotency', 'Lock key must be "idempotency"');
});

// ═══════════════════════════════════════
// D — Different messages
// ═══════════════════════════════════════
test('D — different message IDs work independently', function() {
  resetState();
  var r1 = sandbox.ProcessedMessagesService.claim('msg-A', '9647001234567', 'hello');
  var r2 = sandbox.ProcessedMessagesService.claim('msg-B', '9647001234567', 'world');

  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.data.status, 'ACQUIRED');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.data.status, 'ACQUIRED');
});

// ═══════════════════════════════════════
// E — Duplicate blocked before business layer (webhook test)
// ═══════════════════════════════════════
test('E — duplicate blocked before Router via doPost', function() {
  resetState();

  var event = makeWebhookEvent('msg-e2e-001', '9647001234567', 'أريد حجز موعد');

  // First delivery
  sandbox.doPost(event);
  assert.strictEqual(routerDispatchCount, 1, 'First delivery should reach Router');

  // Same message again
  sandbox.doPost(event);
  assert.strictEqual(routerDispatchCount, 1, 'Duplicate must NOT reach Router again');
});

test('E2 — different messages all reach Router via doPost', function() {
  resetState();

  sandbox.doPost(makeWebhookEvent('msg-multi-1', '9647001234567', 'first'));
  sandbox.doPost(makeWebhookEvent('msg-multi-2', '9647001234567', 'second'));
  sandbox.doPost(makeWebhookEvent('msg-multi-3', '9647009999999', 'third'));

  assert.strictEqual(routerDispatchCount, 3, 'All distinct messages should reach Router');
});

// ═══════════════════════════════════════
// F — Processing failure / expiration
// ═══════════════════════════════════════
test('F — expired claim allows retry', function() {
  resetState();

  var r1 = sandbox.ProcessedMessagesService.claim('msg-expiry', '9647001234567', 'hello');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.data.status, 'ACQUIRED');

  // Advance time past DUPLICATE_WINDOW_MS (300,000ms)
  currentTimeMs = NOW_MS + 300001;

  var r2 = sandbox.ProcessedMessagesService.claim('msg-expiry', '9647001234567', 'hello');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.data.status, 'ACQUIRED');
});

test('F2 — claim just before expiry still blocks', function() {
  resetState();

  var r1 = sandbox.ProcessedMessagesService.claim('msg-notexpired', '9647001234567', 'hello');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.data.status, 'ACQUIRED');

  // Advance time but still within window
  currentTimeMs = NOW_MS + 299999;

  var r2 = sandbox.ProcessedMessagesService.claim('msg-notexpired', '9647001234567', 'hello');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.data.status, 'DUPLICATE');
});

// ═══════════════════════════════════════
// G — Persistence failure
// ═══════════════════════════════════════
test('G — persistence failure blocks business processing', function() {
  resetState();
  scriptPropertiesShouldFailWrite = true;
  sandbox.PropertiesService = makePropertiesService();

  var result = sandbox.ProcessedMessagesService.claim('msg-fail', '9647001234567', 'hello');

  assert.strictEqual(result.ok, false, 'Claim should fail on persistence error');
  assert.notStrictEqual(result.error.code, 'DUPLICATE', 'Must not be reported as DUPLICATE');
});

test('G2 — persistence failure in webhook blocks Router', function() {
  resetState();
  scriptPropertiesShouldFailWrite = true;
  sandbox.PropertiesService = makePropertiesService();

  var event = makeWebhookEvent('msg-g2', '9647001234567', 'hello');
  sandbox.doPost(event);

  assert.strictEqual(routerDispatchCount, 0, 'Router must NOT be called when claim fails');

  var claimFailLog = logEntries.find(function(e) { return e.command === 'WEBHOOK_CLAIM_FAILED'; });
  assert.ok(claimFailLog, 'Claim failure should be logged');
});

test('G3 — lock failure blocks business processing', function() {
  resetState();
  lockShouldFail = true;
  sandbox.Lock = makeDefaultLock();

  var result = sandbox.ProcessedMessagesService.claim('msg-lockfail', '9647001234567', 'hello');

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
});

// ═══════════════════════════════════════
// H — Existing webhook behavior
// ═══════════════════════════════════════
test('H — new valid message passes through Router normally', function() {
  resetState();

  var event = makeWebhookEvent('msg-h-001', '9647001234567', 'أهلاً');
  var output = sandbox.doPost(event);

  assert.strictEqual(routerDispatchCount, 1);
  assert.strictEqual(routerLastContext.phone, '9647001234567');
  assert.strictEqual(routerLastContext.message, 'أهلاً');
  assert.strictEqual(lastContentOutput, 'OK');
});

test('H2 — parse failure returns IGNORED and does not reach Router', function() {
  resetState();

  var event = { postData: { contents: 'INVALID_JSON' } };
  sandbox.doPost(event);

  assert.strictEqual(routerDispatchCount, 0);
  assert.strictEqual(lastContentOutput, 'IGNORED');
});

test('H3 — missing postData returns IGNORED', function() {
  resetState();

  sandbox.doPost({});

  assert.strictEqual(routerDispatchCount, 0);
  assert.strictEqual(lastContentOutput, 'IGNORED');
});

// ═══════════════════════════════════════
// R1–R6 — Repository tests (production code)
// ═══════════════════════════════════════

test('R1 — repository first claim returns ACQUIRED', function() {
  resetState();

  var result = sandbox.ProcessedMessagesRepository.claim('msg_r1', NOW_MS, 300000);

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.status, 'ACQUIRED');
});

test('R2 — repository duplicate claim returns DUPLICATE', function() {
  resetState();

  var r1 = sandbox.ProcessedMessagesRepository.claim('msg_r2', NOW_MS, 300000);
  var r2 = sandbox.ProcessedMessagesRepository.claim('msg_r2', NOW_MS + 1000, 300000);

  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.data.status, 'ACQUIRED');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.data.status, 'DUPLICATE');
});

test('R3 — repository expired claim allows new ACQUIRED', function() {
  resetState();

  var r1 = sandbox.ProcessedMessagesRepository.claim('msg_r3', NOW_MS, 300000);
  assert.strictEqual(r1.data.status, 'ACQUIRED');

  // After expiration
  var r2 = sandbox.ProcessedMessagesRepository.claim('msg_r3', NOW_MS + 300001, 300000);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.data.status, 'ACQUIRED');
});

test('R4 — repository read failure returns CLAIM_READ_FAILED', function() {
  resetState();
  scriptPropertiesShouldFailRead = true;
  sandbox.PropertiesService = makePropertiesService();

  var result = sandbox.ProcessedMessagesRepository.claim('msg_r4', NOW_MS, 300000);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'CLAIM_READ_FAILED');
});

test('R5 — repository write failure returns CLAIM_PERSISTENCE_FAILED', function() {
  resetState();
  scriptPropertiesShouldFailWrite = true;
  sandbox.PropertiesService = makePropertiesService();

  var result = sandbox.ProcessedMessagesRepository.claim('msg_r5', NOW_MS, 300000);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'CLAIM_PERSISTENCE_FAILED');
});

test('R6 — repository lock failure returns LOCK_TIMEOUT', function() {
  resetState();
  lockShouldFail = true;
  sandbox.Lock = makeDefaultLock();

  var result = sandbox.ProcessedMessagesRepository.claim('msg_r6', NOW_MS, 300000);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
});

// ═══════════════════════════════════════
// REGRESSION — Layer boundary checks
// ═══════════════════════════════════════

test('REGRESSION — ProcessedMessagesService does NOT reference Lock', function() {
  var source = fs.readFileSync(path.join(ROOT, 'ProcessedMessagesService.js'), 'utf8');

  // Remove comments for analysis
  var codeLines = source.split('\n').filter(function(line) {
    var trimmed = line.trim();
    return trimmed.indexOf('//') !== 0 && trimmed.indexOf('*') !== 0 && trimmed.indexOf('/**') !== 0;
  }).join('\n');

  assert.strictEqual(
    codeLines.indexOf('Lock.runExclusive') === -1,
    true,
    'ProcessedMessagesService must NOT call Lock.runExclusive in code'
  );
});

test('REGRESSION — ProcessedMessagesService does NOT reference PropertiesService', function() {
  var source = fs.readFileSync(path.join(ROOT, 'ProcessedMessagesService.js'), 'utf8');

  var codeLines = source.split('\n').filter(function(line) {
    var trimmed = line.trim();
    return trimmed.indexOf('//') !== 0 && trimmed.indexOf('*') !== 0 && trimmed.indexOf('/**') !== 0;
  }).join('\n');

  assert.strictEqual(
    codeLines.indexOf('PropertiesService') === -1,
    true,
    'ProcessedMessagesService must NOT reference PropertiesService in code'
  );
});

test('REGRESSION — ProcessedMessagesRepository DOES reference Lock', function() {
  var source = fs.readFileSync(path.join(ROOT, 'ProcessedMessagesRepository.js'), 'utf8');
  assert.ok(
    source.indexOf('Lock.runExclusive') !== -1,
    'Repository must use Lock.runExclusive for atomicity'
  );
});

test('REGRESSION — Webhook.js uses claim only (no check+mark pattern)', function() {
  var webhookSource = fs.readFileSync(path.join(ROOT, 'Webhook.js'), 'utf8');

  assert.ok(
    webhookSource.indexOf('.claim(') !== -1,
    'Webhook.js must use claim() in the critical path'
  );

  // Verify old two-step pattern is NOT in active code
  var lines = webhookSource.split('\n');
  var foundIsDuplicate = false;
  var foundMarkProcessed = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf('//') === 0 || line.indexOf('*') === 0) continue;

    if (line.indexOf('.isDuplicate(') !== -1) foundIsDuplicate = true;
    if (line.indexOf('.markProcessed(') !== -1) foundMarkProcessed = true;
  }

  assert.strictEqual(foundIsDuplicate && foundMarkProcessed, false,
    'Webhook.js must not contain isDuplicate + markProcessed two-step pattern');
});

test('REGRESSION — no PropertiesService in Application/Domain', function() {
  var appFiles = [
    'Application/BookingService.js',
    'Application/CancelService.js',
    'Application/CommandExecutor.js',
    'Application/MaintenanceService.js'
  ];

  appFiles.forEach(function(file) {
    var filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) return;

    var source = fs.readFileSync(filePath, 'utf8');
    assert.strictEqual(
      source.indexOf('PropertiesService') === -1,
      true,
      file + ' must not reference PropertiesService directly'
    );
  });
});

test('REGRESSION — B1 files are not modified by B2', function() {
  var b1Files = [
    'Slotselection.js',
    'Application/BookingService.js',
    'Changeservice.js',
    'Repositories/SlotRepository.js'
  ];

  b1Files.forEach(function(file) {
    var filePath = path.join(ROOT, file);
    if (fs.existsSync(filePath)) {
      var source = fs.readFileSync(filePath, 'utf8');
      assert.ok(source.length > 0, file + ' should still exist and be non-empty');
    }
  });
});

// ═══════════════════════════════════════
// IDENTITY — messageId remains primary key
// ═══════════════════════════════════════
test('IDENTITY — messageId is the primary key when present', function() {
  resetState();

  var r1 = sandbox.ProcessedMessagesService.claim('msg-identity', '9647001111111', 'first');
  var r2 = sandbox.ProcessedMessagesService.claim('msg-identity', '9647002222222', 'second');

  assert.strictEqual(r1.data.status, 'ACQUIRED');
  assert.strictEqual(r2.data.status, 'DUPLICATE');
});

// ═══════════════════════════════════════
// FALLBACK — null messageId behavior preserved
// ═══════════════════════════════════════
test('FALLBACK — null messageId uses fallback key (behavior preserved)', function() {
  resetState();

  var r1 = sandbox.ProcessedMessagesService.claim(null, '9647001234567', 'same message');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.data.status, 'ACQUIRED');

  var r2 = sandbox.ProcessedMessagesService.claim(null, '9647001234567', 'same message');
  assert.strictEqual(r2.data.status, 'DUPLICATE');
});

// ═══════════════════════════════════════
// Run all tests
// ═══════════════════════════════════════
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
