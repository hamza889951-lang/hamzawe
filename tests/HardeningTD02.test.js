'use strict';

/**
 * HardeningTD02.test.js — TD-02 CAS-009 Time-Source Audit (Post M4-E / Pre M4-F gate)
 *
 * CAS-009: Clock.now() is the ONLY source of the CURRENT time. A bare
 * new Date() (zero arguments) or Date.now() reads wall-clock directly and
 * is forbidden everywhere except inside Clock.js itself. Argument-taking
 * new Date(value) is a pure conversion (from an already-captured instant or
 * from stored data) and is allowed by the constitution's conversion rule —
 * the exemption files (DateUtils.js, SlotGenerator.js,
 * LegacySlotTimeParser.js) additionally build Dates from components.
 *
 * Remediation applied in this gate: AvailabilityHorizonMaintainer.js had
 * one bare `new Date()` in the no-existing-slots reconciliation branch of
 * ensureHorizon(); it now reuses the operation's Clock.now()-derived
 * `nowMs`. This suite is the permanent guard against re-introduction.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const SKIP_DIRS = { tests: true, '.git': true, node_modules: true };

function productionFiles() {
  const out = [];
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    const abs = path.join(ROOT, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS[entry.name]) continue;
      for (const f of fs.readdirSync(abs)) {
        if (f.endsWith('.js')) out.push(path.join(abs, f));
      }
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(abs);
    }
  }
  return out.sort();
}

/**
 * CAS-009 scanner: returns current-time-read violations found in stripped
 * source code. A "read of the current time" is a bare new Date() (no
 * arguments) or Date.now(). Conversions with arguments are not violations.
 */
function scanCas009(strippedSource) {
  const violations = [];
  const bare = strippedSource.match(/new\s+Date\s*\(\s*\)/g);
  if (bare) violations.push('new Date():' + bare.length);
  const epoch = strippedSource.match(/Date\.now\s*\(/g);
  if (epoch) violations.push('Date.now():' + epoch.length);
  // `+new Date` (no arguments) coerces the current time; `+new Date(ms)`
  // is a numeric conversion of a captured instant and is NOT a violation.
  const unary = strippedSource.match(/\+\s*new\s+Date\s*\(\s*\)/g) ||
                strippedSource.match(/\+\s*new\s+Date(?![\w(.])/g);
  if (unary) violations.push('+new Date:' + unary.length);
  return violations;
}

// ══════════════════════════════════════════════════════════
// A — Permanent repository-wide CAS-009 structural audit
// ══════════════════════════════════════════════════════════

test('TD02-A1 — no bare new Date() outside Clock.js; no Date.now() in any production file', function() {
  const files = productionFiles();
  assert.ok(files.length >= 40, 'scanner must see the real production tree');

  const offenders = [];
  const clockReaders = [];
  files.forEach(function(file) {
    const rel = path.relative(ROOT, file);
    const violations = scanCas009(stripComments(fs.readFileSync(file, 'utf8')));
    if (violations.length === 0) return;
    if (rel === path.join('Clock.js')) { clockReaders.push(rel); return; }
    offenders.push(rel + ' → ' + violations.join(', '));
  });

  assert.deepStrictEqual(clockReaders, ['Clock.js'],
    'Clock.now() remains the single wall-clock reader');
  assert.deepStrictEqual(offenders, [],
    'CAS-009 violations found (current time read outside Clock): ' + offenders.join(' | '));
});

test('TD02-A2 — scanner has teeth: negative controls', function() {
  // Bare current-time read must be flagged:
  assert.ok(scanCas009(stripComments('var today = new Date();')).length === 1,
    'a bare new Date() must be flagged');
  assert.ok(scanCas009(stripComments('var x = Date.now();')).length === 1,
    'Date.now() must be flagged');
  assert.ok(scanCas009(stripComments('var y = + new Date;')).length >= 1,
    'unary +new Date (no args) must be flagged');
  assert.ok(scanCas009(stripComments('var y = +new Date();')).length >= 1,
    'unary +new Date() must be flagged');
  assert.deepStrictEqual(scanCas009(stripComments('var n = +new Date(ms);')), [],
    'unary conversion of a captured instant must NOT be flagged');
  // Pure conversions must NOT be flagged:
  assert.deepStrictEqual(scanCas009(stripComments('var d = new Date(ms);')), [],
    'conversion from a captured instant is not a current-time read');
  assert.deepStrictEqual(scanCas009(stripComments('var d = new Date(y, mo, da); d.setHours(0,0,0,0);')), [],
    'component construction (allowed exemption pattern) is not a current-time read');
  // Commented-out occurrences are not violations (comment stripping first):
  assert.deepStrictEqual(scanCas009(stripComments('// var old = new Date();')), []);
  assert.deepStrictEqual(scanCas009(stripComments('/* today = new Date(); */')), []);
});

test('TD02-A3 — exemption files exist and contain conversions only (never bare reads)', function() {
  ['Utils/DateUtils.js', 'SlotGenerator.js', 'Utils/LegacySlotTimeParser.js'].forEach(function(rel) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), 'CAS-009 exemption file must exist: ' + rel);
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(scanCas009(src), [],
      rel + ' is exempt for CONVERSIONS only — it must still not read the current time directly');
  });
});

test('TD02-A4 — remediated file: the no-slots reconciliation branch reuses the Clock-derived instant', function() {
  const src = fs.readFileSync(path.join(ROOT, 'AvailabilityHorizonMaintainer.js'), 'utf8');
  const stripped = stripComments(src);
  assert.ok(
    /var\s+nowMs\s*=\s*Clock\.now\(\)\.getTime\(\)/.test(stripped),
    'the operation must capture the instant via Clock.now() once'
  );
  assert.ok(
    /var\s+today\s*=\s*new\s+Date\(\s*nowMs\s*\)/.test(stripped),
    'today must derive from the captured Clock instant, not from a bare read'
  );
  assert.deepStrictEqual(scanCas009(stripped), [],
    'AvailabilityHorizonMaintainer must contain no direct wall-clock read');
});

// ══════════════════════════════════════════════════════════
// B — Behavioral: ensureHorizon is Clock-driven, deterministic, unchanged
// ══════════════════════════════════════════════════════════

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    sheets: {},
    failRead: {},
    updates: 0,
    appendedRows: [],
    lockKeys: [],
    nowIso: '2030-01-01T06:00:00.000Z',
    logs: []
  };

  sandbox.LockService = {
    getScriptLock: function() {
      return { waitLock: function() {}, releaseLock: function() {} };
    }
  };
  sandbox.PropertiesService = {
    _props: {},
    getScriptProperties: function() {
      return {
        getProperty: function(key) { return sandbox.PropertiesService._props[key] || null; }
      };
    }
  };
  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sandbox.Utilities = { formatDate: function(date) { return String(date); } };

  function sheetStore(name) {
    if (!state.sheets[name]) { state.sheets[name] = { headers: [], rows: [] }; }
    return state.sheets[name];
  }

  sandbox.GoogleSheets = {
    getOrCreateSheet: function(name, headers) {
      const sheet = sheetStore(name);
      if (!sheet.headers.length && headers) sheet.headers = headers.slice();
      return sheet;
    },
    getHeaders: function(name) {
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      return sheet.headers.slice();
    },
    getAllRows: function(name) {
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
      return sheet.rows.map(function(r) { return Object.assign({}, r); });
    },
    queryRows: function(name, predicateFn) {
      return sandbox.GoogleSheets.getAllRows(name).filter(predicateFn);
    },
    findRowByColumn: function(name, columnName, value) {
      const rows = sandbox.GoogleSheets.queryRows(name, function(row) {
        return row[columnName] === value;
      });
      return rows.length ? rows[0] : null;
    },
    appendRow: function(name, rowObject) {
      const sheet = sheetStore(name);
      sheet.rows.push(Object.assign({}, rowObject));
      state.appendedRows.push(rowObject);
    },
    appendRows: function(name, rowsArray) {
      const sheet = sheetStore(name);
      for (var i = 0; i < rowsArray.length; i++) {
        var rowObj = {};
        for (var j = 0; j < sheet.headers.length; j++) {
          rowObj[sheet.headers[j]] = rowsArray[i][j];
        }
        sheet.rows.push(rowObj);
        state.appendedRows.push(rowObj);
      }
      return { ok: true, data: { inserted: rowsArray.length } };
    },
    updateRowByColumn: function(name, columnName, value, fields) {
      state.updates += 1;
      const sheet = state.sheets[name];
      if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + name);
      for (let i = 0; i < sheet.rows.length; i++) {
        if (sheet.rows[i][columnName] === value) {
          Object.keys(fields).forEach(function(key) {
            if (sheet.headers.indexOf(key) !== -1) { sheet.rows[i][key] = fields[key]; }
          });
          return true;
        }
      }
      return false;
    },
    updateBatch: function() { throw new Error('TD02_UNEXPECTED_UPDATE_BATCH'); },
    deleteRowsByNumbers: function() { throw new Error('TD02_MUST_NOT_DELETE'); }
  };

  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
  }

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('Clock.js', 'Clock');
  sandbox.Clock.now = function() { return new Date(state.nowIso); };

  load('Utils/ULID.js', 'ULID');
  load('Utils/IdGenerator.js', 'IdGenerator');
  load('Utils/DateUtils.js', 'DateUtils');
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('Infrastructure/Lock.js', 'Lock');
  const originalLock = sandbox.Lock.runExclusive;
  sandbox.Lock.runExclusive = function(key, fn, timeoutMs) {
    state.lockKeys.push(key);
    return originalLock.call(sandbox.Lock, key, fn, timeoutMs);
  };

  load('SettingsRepository.js', 'SettingsRepository');
  load('Application/DoctorScheduleReadService.js', 'DoctorScheduleReadService');
  load('Repositories/ScheduleChangeRepository.js', 'ScheduleChangeRepository');
  load('Application/EffectiveScheduleService.js', 'EffectiveScheduleService');
  load('LogRepository.js', 'LogRepository');
  sandbox.LogRepository.write = function(entry) { state.logs.push(entry); };
  load('Repositories/DoctorIdentityRepository.js', 'DoctorIdentityRepository');
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('SlotGenerator.js', 'SlotGenerator');
  load('AvailabilityHorizonMaintainer.js', 'AvailabilityHorizonMaintainer');

  // Deterministic sort_key interpretation for the test host (same override
  // as HardeningM4CC / HardeningM4D).
  sandbox.LegacySlotTimeParser.toComparableTime = function(sortKey) {
    const s = String(sortKey);
    if (!/^\d{12}$/.test(s)) return null;
    return Date.UTC(
      parseInt(s.substring(0, 4), 10),
      parseInt(s.substring(4, 6), 10) - 1,
      parseInt(s.substring(6, 8), 10),
      parseInt(s.substring(8, 10), 10),
      parseInt(s.substring(10, 12), 10)
    );
  };

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;
const HM = sandbox.AvailabilityHorizonMaintainer;

function seedStandardSettings() {
  const settings = {
    work_start: '09:00',
    work_end: '10:00',
    'Slot Duration (min)': '30',
    slot_generation_days: '3',
    sunday: true, monday: true, tuesday: true, wednesday: true,
    thursday: true, friday: true, saturday: true
  };
  state.sheets['Settings'] = {
    headers: Object.keys(settings),
    rows: [Object.assign({}, settings)]
  };
}

function seedAvailabilityHeaders() {
  state.sheets['Availability'] = {
    headers: [
      'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
      'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
      'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
    ],
    rows: []
  };
}

function controlContext() {
  return { actorId: '9647001111111', scope: { clinicId: null } };
}

function freshSetup() {
  state.sheets = {}; state.failRead = {}; state.updates = 0; state.appendedRows = [];
  state.lockKeys = []; state.logs = [];
  seedStandardSettings();
  seedAvailabilityHeaders();
}

function runSummary() {
  return HM.ensureHorizon(controlContext());
}

let b1Summary = null;

test('TD02-B1 — ensureHorizon on an empty Availability sheet runs the remediated branch deterministically', function() {
  freshSetup();

  const result = runSummary();

  assert.strictEqual(result.ok, true, 'horizon maintenance must succeed');
  // Clock stubbed to 2030-01-01 → every generated sort_key is 2030. The
  // no-existing-slots branch (the remediated code path) executes here.
  const keys = state.sheets['Availability'].rows.map(function(r) { return String(r.sort_key); });
  assert.ok(keys.length > 0, 'slots must be generated for the horizon');
  keys.forEach(function(k) {
    assert.ok(k.indexOf('2030') === 0, 'generated plan must follow the stubbed Clock, not host wall time: ' + k);
  });
  assert.strictEqual(result.data.reconciled, 0, 'no existing slots → nothing to reconcile');
  b1Summary = JSON.parse(JSON.stringify(result.data));
});

test('TD02-B2 — same stubbed Clock ⇒ identical summary (host wall time never leaks in)', function() {
  freshSetup();
  const r1 = JSON.parse(JSON.stringify(runSummary().data));
  freshSetup();
  const r2 = JSON.parse(JSON.stringify(runSummary().data));
  assert.deepStrictEqual(r1, r2);
  assert.deepStrictEqual(r1, b1Summary);
});

test('TD02-B3 — incremental horizon semantics preserved: extensions never duplicate and converge to zero', function() {
  // Continue on top of B2's converged sheet state: further runs may extend
  // the horizon by whole days (existing M4-D Q5 semantics) but must never
  // duplicate sort_keys and must reach a stable zero-generation state.
  let prevCount = state.sheets['Availability'].rows.length;
  for (let i = 0; i < 4; i++) {
    const r = runSummary();
    assert.strictEqual(r.ok, true);
    const rows = state.sheets['Availability'].rows;
    const keys = rows.map(function(x) { return String(x.sort_key); });
    assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate sort_keys after run ' + i);
    assert.ok(rows.length >= prevCount);
    prevCount = rows.length;
    if (i >= 2) assert.strictEqual(r.data.generated, 0, 'converged runs must generate nothing new');
  }
  // Convergence is stable: a final run leaves the materialized state identical.
  const before = JSON.parse(JSON.stringify(state.sheets['Availability'].rows));
  const finalRun = runSummary();
  assert.strictEqual(finalRun.ok, true);
  assert.strictEqual(finalRun.data.reconciled, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(state.sheets['Availability'].rows)), before);
});

// ── Runner ──

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
console.log('\n' + (tests.length - failures) + '/' + tests.length + ' tests passed');
