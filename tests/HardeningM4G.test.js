'use strict';

/**
 * HardeningM4G.test.js — M4-G Final Hardening / Governance
 *
 * This suite is intentionally verification-first: it executes the established
 * M4-C/M4-D/M4-E/M4-F suites and performs narrow repository scans for the
 * frozen M4-G ownership, time, schema, security and Git-scope invariants.
 *
 * G-63 is deliberately N/A here: durable stage-closure evidence is a
 * Supervisor/governance artifact, not a repository self-test.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const BASELINE = '6578c35988c7eb319c4be3bc21fe642f44f7af67';
const EXPECTED_CHANGED_FILES = [
  'tests/HardeningM4F.test.js',
  'tests/HardeningM4G.test.js'
];

let passCount = 0;
let failCount = 0;
const suiteCache = Object.create(null);

function test(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
    passCount += 1;
  } catch (e) {
    console.error('FAIL: ' + name);
    console.error('    ' + (e && e.stack ? e.stack : e));
    failCount += 1;
  }
}

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function collectFiles(dir, prefix) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push.apply(out, collectFiles(abs, rel));
    else out.push(rel.replace(/\\/g, '/'));
  });
  return out;
}

function runNodeFile(relPath) {
  const result = cp.spawnSync('node', [path.join(ROOT, relPath)], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  return {
    status: result.status === null ? 1 : result.status,
    stdout: stdout,
    stderr: stderr,
    output: stdout + '\n' + stderr
  };
}

function runSuite(file) {
  if (!suiteCache[file]) suiteCache[file] = runNodeFile(path.join('tests', file));
  return suiteCache[file];
}

function assertSuitePass(file) {
  const result = runSuite(file);
  assert.strictEqual(
    result.status,
    0,
    file + ' failed.\n' + result.output
  );
  return result.output;
}

function assertSuiteHasPasses(file, ids) {
  const output = assertSuitePass(file);
  ids.forEach(function(id) {
    assert.ok(
      output.split(/\r?\n/).some(function(line) {
        return line.indexOf('PASS: ' + id) !== -1;
      }),
      file + ' did not report PASS for ' + id
    );
  });
}

function git(args) {
  const result = cp.spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
}

function changedFiles(base) {
  // Prefer three-dot (merge-base...HEAD). Fall back to two-dot tree diff when
  // the local clone is missing parent objects and cannot compute a merge-base.
  let r = git(['diff', '--name-only', base + '...HEAD']);
  if (r.status !== 0) {
    r = git(['diff', '--name-only', base, 'HEAD']);
  }
  assert.strictEqual(r.status, 0, r.stderr || 'git diff failed');
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

function assertBaselineAncestry(base) {
  const local = git(['merge-base', '--is-ancestor', base, 'HEAD']);
  if (local.status === 0) return;
  const head = git(['rev-parse', 'HEAD']);
  assert.strictEqual(head.status, 0, head.stderr || 'rev-parse HEAD failed');
  const gh = cp.spawnSync(
    'gh',
    [
      'api',
      'repos/hamza889951-lang/hamzawe/compare/' + base + '...' + head.stdout.trim(),
      '--jq',
      '{status:.status,behind_by:.behind_by}'
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.strictEqual(
    gh.status,
    0,
    'local ancestry unavailable and GitHub compare failed: ' + (gh.stderr || gh.stdout)
  );
  const payload = JSON.parse(gh.stdout);
  assert.strictEqual(payload.behind_by, 0, 'GitHub compare reports HEAD is behind the baseline');
  assert.ok(
    payload.status === 'ahead' || payload.status === 'identical',
    'GitHub compare status is not ancestry-safe: ' + payload.status
  );
}

function assertNoDirectInfrastructureCode(relDir) {
  collectFiles(path.join(ROOT, relDir), relDir).filter(function(f) {
    return /\.js$/.test(f);
  }).forEach(function(rel) {
    const code = stripComments(readFile(rel));
    assert.strictEqual(/\b(?:SpreadsheetApp|CalendarApp|UrlFetchApp)\b/.test(code), false, rel + ' contains forbidden direct infrastructure API');
  });
}

function allHardeningSuites() {
  return fs.readdirSync(TESTS_DIR)
    .filter(function(name) { return /^Hardening.*\.test\.js$/.test(name) && name !== 'HardeningM4G.test.js'; })
    .sort();
}

function baselineExceptionOnly(file, result) {
  if (result.status === 0) return true;
  if (file !== 'HardeningM1B.test.js') return false;
  const failLines = result.output.split(/\r?\n/).filter(function(line) {
    return /FAIL[: ]/.test(line);
  });
  return result.output.indexOf('M1B-X3') !== -1 &&
    failLines.length > 0 &&
    failLines.every(function(line) { return line.indexOf('M1B-X3') !== -1; });
}

const pds = readFile('Application/PatientDisruptionService.js');
const scheduler = readFile('Scheduler.js');
const m4cService = readFile('Application/DoctorScheduleCommandService.js');
const scheduleChangeRepo = readFile('Repositories/ScheduleChangeRepository.js');
const m4eService = readFile('Application/AffectedAppointmentDiscoveryService.js');
const horizon = readFile('AvailabilityHorizonMaintainer.js');
const config = readFile('Config.js');
const reportPeriod = readFile('Utils/ReportPeriod.js');

// ─────────────────────────────────────────────────────────────────────────────
// G-01 .. G-06 — Architecture / ownership
// ─────────────────────────────────────────────────────────────────────────────
test('G-01 — Current baseline is an ancestor and the reviewed head is real Git history', function() {
  const head = git(['rev-parse', 'HEAD']);
  assert.strictEqual(head.status, 0);
  assert.strictEqual(head.stdout.trim().length, 40);
  assert.notStrictEqual(head.stdout.trim(), BASELINE);
  const type = git(['cat-file', '-t', 'HEAD']);
  assert.strictEqual(type.status, 0);
  assert.strictEqual(type.stdout.trim(), 'commit');
  assertBaselineAncestry(BASELINE);
});

test('G-02 — No new business boundary/component is introduced by the M4-G diff', function() {
  assert.deepStrictEqual(changedFiles(BASELINE).sort(), EXPECTED_CHANGED_FILES.slice().sort());
  const forbiddenNew = changedFiles(BASELINE).filter(function(f) {
    return /^(Application|Domain|Infrastructure|Repositories)\//.test(f);
  });
  assert.deepStrictEqual(forbiddenNew, []);
});

test('G-03 — Patient Disruption delegates established ownership boundaries', function() {
  assert.ok(pds.indexOf('ChangeService.changeConfirmedAppointment') !== -1);
  assert.ok(pds.indexOf('BookingService.confirmReservedSlot') !== -1);
  assert.ok(pds.indexOf('SlotSelection.findEarliestWithinHorizon') !== -1);
});

test('G-04 — Application and Domain contain no direct Spreadsheet/Calendar/UrlFetch APIs', function() {
  assertNoDirectInfrastructureCode('Application');
  assertNoDirectInfrastructureCode('Domain');
});

test('G-05 — Patient Disruption does not assign Slot.status directly', function() {
  assert.strictEqual(/\bslot\.status\s*=/.test(stripComments(pds)), false);
});

test('G-06 — SlotSelection remains the only patient-disruption candidate selector', function() {
  assert.ok(/SlotSelection\.findEarliestWithinHorizon/.test(pds));
  assert.strictEqual(/findEarliestWithinHorizon\s*=/.test(pds), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// G-07 .. G-10 — Time / determinism
// ─────────────────────────────────────────────────────────────────────────────
test('G-07 — CAS-009 current-time shortcuts are absent from Application', function() {
  collectFiles(path.join(ROOT, 'Application'), 'Application').filter(function(f) { return /\.js$/.test(f); }).forEach(function(rel) {
    const code = stripComments(readFile(rel));
    assert.strictEqual(/\bDate\.now\s*\(/.test(code), false, rel + ' uses Date.now()');
    assert.strictEqual(/\bnew\s+Date\s*\(\s*\)/.test(code), false, rel + ' uses bare new Date()');
    assert.strictEqual(/\bMath\.random\s*\(/.test(code), false, rel + ' uses Math.random()');
  });
});

test('G-08 — M4-E determinism is verified by its real acceptance suite', function() {
  assertSuitePass('HardeningM4E.test.js');
});

test('G-09 — Asia/Baghdad and local-date semantics remain explicit', function() {
  assert.ok(reportPeriod.indexOf('Asia/Baghdad') !== -1);
  assertSuitePass('HardeningM4C.test.js');
});

test('G-10 — M4-F expiry remains exactly 30 minutes', function() {
  assert.ok(config.indexOf('DISRUPTION_PROPOSAL_TIMEOUT_MINUTES: 30') !== -1);
  assertSuiteHasPasses('HardeningM4F.test.js', ['M4F-15']);
});

// ─────────────────────────────────────────────────────────────────────────────
// G-11 .. G-14 — M4-C
// ─────────────────────────────────────────────────────────────────────────────
test('G-11 — Repeated commandId is idempotent', function() {
  assertSuiteHasPasses('HardeningM4C.test.js', ['M4C-I1']);
});

test('G-12 — Schedule Change repository is append-only and cancellation is behaviorally covered', function() {
  const code = stripComments(scheduleChangeRepo);
  assert.ok(/appendRow/.test(code));
  assert.strictEqual(/updateRowByColumn/.test(code), false);
  assert.strictEqual(/deleteRowsByNumbers/.test(code), false);
  assert.ok(/Lock\.runExclusive/.test(code));
  assertSuiteHasPasses('HardeningM4C.test.js', ['M4C-C1', 'M4C-L2']);
});

test('G-13 — Schedule commands use scope serialization and fresh-state checks', function() {
  assert.ok(
    /ScheduleChangeRepository\.runExclusiveForScope/.test(m4cService),
    'DoctorScheduleCommandService must serialize through the established schedule-scope boundary'
  );
  assert.ok(
    /Lock\.runExclusive/.test(scheduleChangeRepo),
    'ScheduleChangeRepository.runExclusiveForScope must use Lock.runExclusive'
  );
  assertSuiteHasPasses('HardeningM4C.test.js', ['M4C-I2', 'M4C-I3']);
});

test('G-14 — M4-C source-failure/invalid-source behavior is exercised by the real suite', function() {
  assertSuitePass('HardeningM4C.test.js');
  assert.ok(/Result\.fail|return\s+Result\.fail/.test(m4cService));
});

// ─────────────────────────────────────────────────────────────────────────────
// G-15 .. G-20 — M4-D
// ─────────────────────────────────────────────────────────────────────────────
test('G-15 — Repeated M4-D materialization converges without duplicate starts', function() {
  assertSuitePass('HardeningM4D.test.js');
});

test('G-16 — Terminal Slot lifecycle states are protected by the materializer contract', function() {
  assert.ok(/EXPIRED/.test(horizon) && /CANCELLED/.test(horizon) && /COMPLETED/.test(horizon) && /NO_SHOW/.test(horizon));
  assertSuitePass('HardeningM4D.test.js');
});

test('G-17 — Existing patient/lifecycle/calendar data is preserved', function() {
  assert.ok(/status as it is|preserv/i.test(horizon));
  assertSuitePass('HardeningM4D.test.js');
});

test('G-18 — Existing-row reconciliation is limited to is_available', function() {
  assert.ok(/fields\s*:\s*\{\s*is_available\s*:/.test(horizon) || /is_available/.test(horizon));
  assertSuitePass('HardeningM4D.test.js');
});

test('G-19 — Booking/materialization remains per-slot atomic', function() {
  assert.ok(/SlotRepository\.atomicUpdate/.test(horizon));
  assertSuitePass('HardeningM4D.test.js');
});

test('G-20 — M4-D partial failures are explicit and retryable', function() {
  assert.ok(/partial failure|fail closed/i.test(horizon));
  assertSuitePass('HardeningM4D.test.js');
});

// ─────────────────────────────────────────────────────────────────────────────
// G-21 .. G-25 — M4-E
// ─────────────────────────────────────────────────────────────────────────────
test('G-21 — Affectedness uses materialized is_available', function() {
  assert.ok(/is_available/.test(m4eService));
  assertSuitePass('HardeningM4E.test.js');
});

test('G-22 — Discovery remains read-only', function() {
  assertSuitePass('HardeningM4E.test.js');
  const code = stripComments(m4eService);
  assert.strictEqual(/SpreadsheetApp|CalendarApp|UrlFetchApp/.test(code), false);
});

test('G-23 — M4-E discovery does not mutate schedule intent', function() {
  const code = stripComments(m4eService);
  assert.strictEqual(/ScheduleChangeRepository|DoctorScheduleCommandService|commitRecurringChange|commitTemporaryClose/.test(code), false);
});

test('G-24 — M4-E DTO output is deterministic and PII-free by implementation/test boundary', function() {
  assertSuitePass('HardeningM4E.test.js');
  assert.strictEqual(/patient_name|phone|whatsapp/i.test(stripComments(m4eService)), false);
});

test('G-25 — Availability source failure remains fail-closed', function() {
  assertSuitePass('HardeningM4E.test.js');
  assert.ok(/Result\.fail|AVAILABILITY_SOURCE_FAILED/.test(m4eService));
});

// ─────────────────────────────────────────────────────────────────────────────
// G-26 .. G-35 — M4-F proposal lifecycle
// ─────────────────────────────────────────────────────────────────────────────
const M4F_PROPOSAL_EVIDENCE = {
  'G-26': ['M4F-02'],
  'G-27': ['M4F-04'],
  'G-28': ['M4F-04', 'M4F-14'],
  'G-29': ['M4F-56'],
  'G-30': ['M4F-65'],
  'G-31': ['M4F-17'],
  'G-32': ['M4F-64'],
  'G-33': ['M4F-23'],
  'G-34': ['M4F-80'],
  'G-35': ['M4F-81']
};

Object.keys(M4F_PROPOSAL_EVIDENCE).forEach(function(g) {
  test(g + ' — M4-F proposal lifecycle criterion is behaviorally covered', function() {
    assertSuiteHasPasses('HardeningM4F.test.js', M4F_PROPOSAL_EVIDENCE[g]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-36 .. G-44 — M4-F finalization / recovery
// ─────────────────────────────────────────────────────────────────────────────
const M4F_RECOVERY_EVIDENCE = {
  'G-36': ['M4F-28'],
  'G-37': ['M4F-34'],
  'G-38': ['M4F-76'],
  'G-39': ['M4F-35', 'M4F-60'],
  'G-40': ['M4F-88', 'M4F-89'],
  'G-41': ['M4F-104'],
  'G-42': ['M4F-98'],
  'G-43': ['M4F-100'],
  'G-44': ['M4F-32']
};

Object.keys(M4F_RECOVERY_EVIDENCE).forEach(function(g) {
  test(g + ' — M4-F finalization/recovery criterion is behaviorally covered', function() {
    assertSuiteHasPasses('HardeningM4F.test.js', M4F_RECOVERY_EVIDENCE[g]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-45 .. G-49 — Scheduler
// ─────────────────────────────────────────────────────────────────────────────
test('G-45 — Single Scheduler order is Archive → Maintenance → Horizon → Disruption → Reminders → HealthCheck', function() {
  const order = [
    'ArchiveService.run',
    'MaintenanceService.run',
    'AvailabilityHorizonMaintainer.ensureHorizon',
    'PatientDisruptionService.processDisruptions',
    'ReminderService.processPendingReminders',
    'HealthCheckService.run'
  ].map(function(token) { return scheduler.indexOf(token); });
  order.forEach(function(index) { assert.ok(index >= 0, 'missing Scheduler stage'); });
  for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], 'Scheduler order is incorrect');
});

test('G-46 — Scheduler stage failure is explicit', function() {
  assert.ok(/SCHEDULER_STAGE_FAILED/.test(scheduler));
  assert.ok(/status\s*=\s*'FAILED'/.test(scheduler));
});

test('G-47 — Scheduler best-effort progression is preserved', function() {
  assert.ok(/try\s*\{\s*var [a-zA-Z]+Result/.test(scheduler));
  assert.ok(/SCHEDULER_PARTIAL_FAILURE/.test(scheduler));
});

test('G-48 — Liveness advances only after operational stages succeed', function() {
  assert.ok(/operationalOk\s*=/.test(scheduler));
  assert.ok(/LAST_SCHEDULER_SUCCESS_MS/.test(scheduler));
  assert.ok(/if\s*\(operationalOk\)/.test(scheduler));
});

test('G-49 — No trigger creation is introduced by M4-G', function() {
  collectFiles(path.join(ROOT, 'Application'), 'Application').filter(function(f) { return /\.js$/.test(f); }).forEach(function(rel) {
    assert.strictEqual(/ScriptApp\.newTrigger/.test(stripComments(readFile(rel))), false, rel + ' creates a trigger');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-50 .. G-54 — Data / security / observability
// ─────────────────────────────────────────────────────────────────────────────
test('G-50 — M4-F exact bounded schema is verified by the real M4-F suite', function() {
  assertSuiteHasPasses('HardeningM4F.test.js', ['M4F-55', 'M4F-91']);
});

test('G-51 — Automatic production migration is forbidden by the verified M4-F behavior', function() {
  assertSuiteHasPasses('HardeningM4F.test.js', ['M4F-86']);
  const code = stripComments(m4eService + '\n' + horizon + '\n' + pds);
  assert.strictEqual(/insertColumnsAfter|deleteColumns|auto.?migrat/i.test(code), false);
});

test('G-52 — LogRepository is diagnostic-only and M4-F logging behavior is covered', function() {
  assertSuiteHasPasses('HardeningM4F.test.js', ['M4F-90']);
  assert.ok(/LogRepository\.write/.test(pds));
});

test('G-53 — Bounded disruption business state contains no prohibited PII/provider fields', function() {
  assertSuiteHasPasses('HardeningM4F.test.js', ['M4F-91']);
  const code = stripComments(pds);
  assert.strictEqual(
    /\bdisruption_(?:patient_name|phone|whatsapp|provider|transcript|calendar_event_id)\b/i.test(code),
    false,
    'bounded disruption fields must not include PII/provider identifiers'
  );
});

test('G-54 — Secrets/tokens/passwords are not introduced in Application/Domain', function() {
  collectFiles(path.join(ROOT, 'Application'), 'Application').concat(
    collectFiles(path.join(ROOT, 'Domain'), 'Domain')
  ).filter(function(f) { return /\.js$/.test(f); }).forEach(function(rel) {
    const code = stripComments(readFile(rel));
    assert.strictEqual(/(?:^|[^A-Za-z])(password|passwd|secret|access[_-]?token|client[_-]?secret)(?:$|[^A-Za-z])/i.test(code), false, rel + ' contains a secret/token-like identifier');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-55 .. G-63 — Quality / regression / governance
// ─────────────────────────────────────────────────────────────────────────────
test('G-55 — Every changed JavaScript file passes node --check', function() {
  changedFiles(BASELINE).filter(function(f) { return /\.js$/.test(f); }).forEach(function(rel) {
    const result = cp.spawnSync('node', ['--check', path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, rel + '\n' + (result.stderr || ''));
  });
});

test('G-56 — Every existing Hardening suite is executed from the current tree', function() {
  const suites = allHardeningSuites();
  assert.ok(suites.length > 0);
  suites.forEach(function(file) {
    const result = runSuite(file);
    assert.ok(
      baselineExceptionOnly(file, result),
      file + ' failed outside the documented M1B-X3 baseline exception.\n' + result.output
    );
  });
});

test('G-57 — Full regression distinguishes the documented M1B-X3 baseline exception from new failures', function() {
  const suites = allHardeningSuites();
  const failures = suites.filter(function(file) { return runSuite(file).status !== 0; });
  assert.deepStrictEqual(failures, ['HardeningM1B.test.js']);
  assert.ok(runSuite('HardeningM1B.test.js').output.indexOf('M1B-X3') !== -1);
});

test('G-58 — Repository-level forbidden dependency/write scans pass', function() {
  assertNoDirectInfrastructureCode('Application');
  assertNoDirectInfrastructureCode('Domain');
  collectFiles(path.join(ROOT, 'Application'), 'Application').filter(function(f) { return /\.js$/.test(f); }).forEach(function(rel) {
    const code = stripComments(readFile(rel));
    assert.strictEqual(/ScriptApp\.newTrigger/.test(code), false, rel + ' creates a trigger');
  });
});

test('G-59 — Reviewed diff is exactly the authorized M4-G scope', function() {
  assert.deepStrictEqual(changedFiles(BASELINE).sort(), EXPECTED_CHANGED_FILES.slice().sort());
});

test('G-60 — Git history and exact reviewed head are internally consistent', function() {
  const head = git(['rev-parse', 'HEAD']);
  const show = git(['show', '-s', '--format=%H%n%P', 'HEAD']);
  assert.strictEqual(head.status, 0);
  assert.strictEqual(show.status, 0);
  const lines = show.stdout.trim().split(/\r?\n/);
  assert.strictEqual(lines[0], head.stdout.trim());
  assert.ok(lines[1] && /^[0-9a-f]{40}/.test(lines[1]), 'HEAD commit is missing a parent SHA');
  assertBaselineAncestry(BASELINE);
});

test('G-61 — CI is reported only when actual GitHub Actions evidence exists', function() {
  const workflowsDir = path.join(ROOT, '.github', 'workflows');
  if (!fs.existsSync(workflowsDir)) {
    console.log('  -> N/A: no GitHub Actions workflow is present in this repository.');
    return;
  }
  const workflowFiles = fs.readdirSync(workflowsDir).filter(function(f) { return /\.(yml|yaml)$/.test(f); });
  if (workflowFiles.length === 0) {
    console.log('  -> N/A: workflow directory exists but contains no workflow files.');
    return;
  }
  assert.strictEqual(process.env.GITHUB_ACTIONS, 'true', 'CI workflows exist, but this execution is not actual GitHub Actions evidence');
  assert.ok(process.env.GITHUB_RUN_ID, 'GitHub Actions run id is unavailable');
});

test('G-62 — Production deployment remains outside this reviewed change set', function() {
  const files = changedFiles(BASELINE);
  files.forEach(function(rel) {
    assert.ok(rel.indexOf('tests/') === 0 || rel.indexOf('docs/governance/') === 0, 'non-governance/test file changed: ' + rel);
  });
  assert.strictEqual(files.some(function(rel) { return /^appsscript\.json$/.test(rel); }), false);
  assert.strictEqual(files.some(function(rel) { return /^Application\//.test(rel); }), false);
});

console.log('G-63: SUPERVISOR-OWNED — durable stage-closure record is stored and verified by the Supervisor in Library, out-of-band. No self-assertion.');

const automatedTotal = passCount + failCount;
console.log('\nAutomated M4-G acceptance: ' + passCount + '/' + automatedTotal + ' PASS (G-63 SUPERVISOR-OWNED, not counted).');
process.exit(failCount > 0 ? 1 : 0);
