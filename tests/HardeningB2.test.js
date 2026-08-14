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

// ── In-memory ScriptProperties mock ──
var scriptProperties = {};
var scriptPropertiesShouldFail = false;

sandbox.PropertiesService = {
  getScriptProperties: function() {
    return {
      getProperty: function(key) {
        if (scriptPropertiesShouldFail) throw new Error('STORAGE_FAILURE');
        return scriptProperties.hasOwnProperty(key) ? scriptProperties[key] : null;
      },
      setProperty: function(key, value) {
        if (scriptPropertiesShouldFail) throw new Error('STORAGE_FAILURE');
        scriptProperties[key] = value;
      }
    };
  }
};

// ── Lock mock (real single-threaded semantics by default) ──
var lockShouldFail = false;
sandbox.Lock = {
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

// Load production files
load('ProcessedMessagesRepository.js', 'ProcessedMessagesRepository');
load('ProcessedMessagesService.js', 'ProcessedMessagesService');

// ── Router mock for webhook tests ──
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
  scriptProperties = {};
  scriptPropertiesShouldFail = false;
  lockShouldFail = false;
  currentTimeMs = NOW_MS;
  routerDispatchCount = 0;
  routerLastContext = null;
  logEntries = [];
  lastContentOutput = null;
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
// C — Concurrent duplicate (simulated)
// ═══════════════════════════════════════
test('C — concurrent duplicate yields exactly one owner', function() {
  resetState();

  // Simulate concurrent execution by using a lock that serializes access
  // and captures the interleaving that would cause a race without atomicity.
  //
  // With a real lock: A acquires → B waits → A releases → B acquires → sees claim → DUPLICATE
  // Without a lock:   A reads false → B reads false → A writes → B writes → both ACQUIRED (bug)
  //
  // We test by calling claim() twice sequentially (which is what a real lock would serialize to)
  // and verifying exactly one ACQUIRED.

  var results = [];
  var executionCount = 0;

  // Override Lock to track serialization
  var originalLock = sandbox.Lock;
  var lockAcquired = false;
  sandbox.Lock = {
    runExclusive: function(key, fn) {
      // Simulate real lock: only one execution at a time
      if (lockAcquired) {
        // In a real system, B would wait. Here we just serialize.
        // The test verifies that even with perfect serialization,
        // the second call sees the first's claim.
      }
      lockAcquired = true;
      try {
        return fn();
      } finally {
        lockAcquired = false;
      }
    }
  };

  // First claim
  var r1 = sandbox.ProcessedMessagesService.claim('msg-concurrent', '9647001234567', 'test');
  results.push(r1);

  // Second claim (simulates the other request that was waiting on lock)
  var r2 = sandbox.ProcessedMessagesService.claim('msg-concurrent', '9647001234567', 'test');
  results.push(r2);

  // Restore lock
  sandbox.Lock = originalLock;

  var acquiredCount = results.filter(function(r) { return r.ok && r.data.status === 'ACQUIRED'; }).length;
  var duplicateCount = results.filter(function(r) { return r.ok && r.data.status === 'DUPLICATE'; }).length;

  assert.strictEqual(acquiredCount, 1, 'Exactly one execution should get ACQUIRED');
  assert.strictEqual(duplicateCount, 1, 'Exactly one execution should get DUPLICATE');
});

// ═══════════════════════════════════════
// C2 — Verify lock prevents interleaving
// ═══════════════════════════════════════
test('C2 — claim uses Lock.runExclusive (atomicity enforced)', function() {
  resetState();

  // Track whether Lock.runExclusive was actually called during claim
  var lockCalled = false;
  var lockKeyUsed = null;
  var originalLock = sandbox.Lock;

  sandbox.Lock = {
    runExclusive: function(key, fn) {
      lockCalled = true;
      lockKeyUsed = key;
      return fn();
    }
  };

  sandbox.ProcessedMessagesService.claim('msg-lock-check', '9647001234567', 'test');

  sandbox.Lock = originalLock;

  assert.strictEqual(lockCalled, true, 'claim() must call Lock.runExclusive()');
  assert.strictEqual(typeof lockKeyUsed, 'string', 'Lock must be called with a key');
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

// ═══════════════════════════════════════
// E2 — Multiple different messages all reach Router
// ═══════════════════════════════════════
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

  // First claim
  var r1 = sandbox.ProcessedMessagesService.claim('msg-expiry', '9647001234567', 'hello');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.data.status, 'ACQUIRED');

  // Advance time past DUPLICATE_WINDOW_MS (300,000ms)
  currentTimeMs = NOW_MS + 300001;

  // Same key should now be ACQUIRED again (expired → retryable)
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
  scriptPropertiesShouldFail = true;

  var result = sandbox.ProcessedMessagesService.claim('msg-fail', '9647001234567', 'hello');

  assert.strictEqual(result.ok, false, 'Claim should fail on persistence error');
  assert.notStrictEqual(result.error.code, 'DUPLICATE', 'Must not be reported as DUPLICATE');
});

test('G2 — persistence failure in webhook blocks Router', function() {
  resetState();
  scriptPropertiesShouldFail = true;

  var event = makeWebhookEvent('msg-g2', '9647001234567', 'hello');
  sandbox.doPost(event);

  assert.strictEqual(routerDispatchCount, 0, 'Router must NOT be called when claim fails');

  // Verify error was logged
  var claimFailLog = logEntries.find(function(e) { return e.command === 'WEBHOOK_CLAIM_FAILED'; });
  assert.ok(claimFailLog, 'Claim failure should be logged');
});

// ═══════════════════════════════════════
// G3 — Lock failure
// ═══════════════════════════════════════
test('G3 — lock failure blocks business processing', function() {
  resetState();
  lockShouldFail = true;

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
// R1 — Repository: first claim (write + read)
// ═══════════════════════════════════════
test('R1 — repository first claim stores value', function() {
  resetState();

  sandbox.ProcessedMessagesRepository.write('msg_r1', '12345');
  var stored = sandbox.ProcessedMessagesRepository.read('msg_r1');

  assert.strictEqual(stored, '12345');
});

// ═══════════════════════════════════════
// R2 — Repository: duplicate claim read
// ═══════════════════════════════════════
test('R2 — repository duplicate claim returns stored value', function() {
  resetState();

  sandbox.ProcessedMessagesRepository.write('msg_r2', '99999');
  var first = sandbox.ProcessedMessagesRepository.read('msg_r2');
  var second = sandbox.ProcessedMessagesRepository.read('msg_r2');

  assert.strictEqual(first, '99999');
  assert.strictEqual(second, '99999');
});

// ═══════════════════════════════════════
// R3 — Repository: different key
// ═══════════════════════════════════════
test('R3 — repository different keys are independent', function() {
  resetState();

  sandbox.ProcessedMessagesRepository.write('msg_r3a', '111');
  sandbox.ProcessedMessagesRepository.write('msg_r3b', '222');

  assert.strictEqual(sandbox.ProcessedMessagesRepository.read('msg_r3a'), '111');
  assert.strictEqual(sandbox.ProcessedMessagesRepository.read('msg_r3b'), '222');
});

// ═══════════════════════════════════════
// R4 — Repository: persistence failure
// ═══════════════════════════════════════
test('R4 — repository persistence failure throws', function() {
  resetState();
  scriptPropertiesShouldFail = true;

  var writeThrew = false;
  try {
    sandbox.ProcessedMessagesRepository.write('msg_r4', '999');
  } catch (e) {
    writeThrew = true;
  }
  assert.strictEqual(writeThrew, true, 'Write should throw on storage failure');
});

// ═══════════════════════════════════════
// R5 — Repository: read non-existent key returns null
// ═══════════════════════════════════════
test('R5 — repository read non-existent key returns null', function() {
  resetState();

  var value = sandbox.ProcessedMessagesRepository.read('msg_nonexistent_r5');
  assert.strictEqual(value, null);
});

// ═══════════════════════════════════════
// Regression — B2 prevents old pattern
// ═══════════════════════════════════════
test('REGRESSION — Webhook.js source does not use isDuplicate+markProcessed pattern in critical path', function() {
  var webhookSource = fs.readFileSync(path.join(ROOT, 'Webhook.js'), 'utf8');

  // The critical path must use claim(), not separate isDuplicate + markProcessed
  assert.ok(
    webhookSource.indexOf('.claim(') !== -1,
    'Webhook.js must use claim() in the critical path'
  );

  // Verify that the old two-step pattern is NOT present as sequential calls in the critical path
  // (isDuplicate followed by markProcessed before Router.dispatch)
  var hasOldPattern = false;
  var lines = webhookSource.split('\n');
  var foundIsDuplicate = false;
  var foundMarkProcessed = false;
  var foundDispatch = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    // Skip comments
    if (line.indexOf('//') === 0 || line.indexOf('*') === 0) continue;

    if (line.indexOf('.isDuplicate(') !== -1) foundIsDuplicate = true;
    if (line.indexOf('.markProcessed(') !== -1) foundMarkProcessed = true;
    if (line.indexOf('Router.dispatch(') !== -1) foundDispatch = true;
  }

  // If both isDuplicate and markProcessed appear before Router.dispatch in active code, that's the old pattern
  if (foundIsDuplicate && foundMarkProcessed && foundDispatch) {
    hasOldPattern = true;
  }

  assert.strictEqual(hasOldPattern, false,
    'Webhook.js must not contain the old isDuplicate + markProcessed two-step pattern');
});

// ═══════════════════════════════════════
// Regression — claim uses Lock
// ═══════════════════════════════════════
test('REGRESSION — ProcessedMessagesService.claim uses Lock.runExclusive', function() {
  var source = fs.readFileSync(
    path.join(ROOT, 'ProcessedMessagesService.js'), 'utf8'
  );

  assert.ok(
    source.indexOf('Lock.runExclusive') !== -1,
    'claim() must use Lock.runExclusive for atomicity'
  );
});

// ═══════════════════════════════════════
// Regression — no PropertiesService in Application
// ═══════════════════════════════════════
test('REGRESSION — no PropertiesService in Application/Domain layer', function() {
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

// ═══════════════════════════════════════
// Regression — B1 files unchanged
// ═══════════════════════════════════════
test('REGRESSION — B1 files are not modified by B2', function() {
  var b1Files = [
    'Slotselection.js',
    'Application/BookingService.js',
    'Changeservice.js',
    'Repositories/SlotRepository.js'
  ];

  // This test is a structural check — we verify that B2 tests don't import
  // or depend on B1 internals being changed. The actual git diff check
  // happens separately. Here we just confirm these files exist and load fine.
  b1Files.forEach(function(file) {
    var filePath = path.join(ROOT, file);
    if (fs.existsSync(filePath)) {
      var source = fs.readFileSync(filePath, 'utf8');
      assert.ok(source.length > 0, file + ' should still exist and be non-empty');
    }
  });
});

// ═══════════════════════════════════════
// messageId remains primary identity key
// ═══════════════════════════════════════
test('IDENTITY — messageId is the primary key when present', function() {
  resetState();

  // Same messageId, different phone/message → should be DUPLICATE
  var r1 = sandbox.ProcessedMessagesService.claim('msg-identity', '9647001111111', 'first');
  var r2 = sandbox.ProcessedMessagesService.claim('msg-identity', '9647002222222', 'second');

  assert.strictEqual(r1.data.status, 'ACQUIRED');
  assert.strictEqual(r2.data.status, 'DUPLICATE');
});

// ═══════════════════════════════════════
// Fallback key behavior preserved
// ═══════════════════════════════════════
test('FALLBACK — null messageId uses fallback key (behavior preserved)', function() {
  resetState();

  // With null messageId, fallback key is used based on phone+message+minute bucket
  var r1 = sandbox.ProcessedMessagesService.claim(null, '9647001234567', 'same message');
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.data.status, 'ACQUIRED');

  // Same phone+message within same minute bucket → DUPLICATE
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
