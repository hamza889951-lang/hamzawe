'use strict';

/**
 * HardeningRetentionArchive.test.js
 * Contract: RETENTION-ARCHIVE-UNIFICATION-v1
 */

process.env.TZ = 'Asia/Baghdad';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_ISO = '2026-09-17T12:00:00.000Z';
const AVAILABILITY_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];
const LOG_HEADERS = [
  'timestamp', 'command', 'phone', 'slotId', 'stage', 'success', 'durationMs', 'error'
];

function clone(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    var out = {};
    Object.keys(v).forEach(function(k) { out[k] = clone(v[k]); });
    return out;
  }
  return v;
}

function createSandbox() {
  var sandbox = vm.createContext({ console: console });
  var state = {
    sheets: {},
    properties: {},
    logs: [],
    failRead: {},
    failWriteSheets: {},
    corruptAvailabilityArchive: false,
    mutateSourceAfterAvailabilityArchive: false
  };

  function ensureSheet(name, headers) {
    if (!state.sheets[name]) state.sheets[name] = { headers: (headers || []).slice(), rows: [] };
    return state.sheets[name];
  }

  function guardRead(name) {
    if (!state.sheets[name]) throw new Error('SHEET_NOT_FOUND: ' + name);
    if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
  }

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(key) { return state.properties[key] || null; },
        setProperty: function(key, value) { state.properties[key] = String(value); }
      };
    }
  };

  sandbox.Utilities = {
    formatDate: function(date) {
      var p = function(n) { return String(n).padStart(2, '0'); };
      return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
    }
  };
  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };

  sandbox.GoogleSheets = {
    getAllRows: function(name) {
      guardRead(name);
      return state.sheets[name].rows.map(clone);
    },
    queryRows: function(name, predicateFn) {
      return sandbox.GoogleSheets.getAllRows(name).filter(predicateFn);
    },
    getHeaders: function(name) {
      guardRead(name);
      return state.sheets[name].headers.slice();
    },
    getOrCreateSheet: function(name, headers) {
      return ensureSheet(name, headers);
    },
    ensureHeaders: function(name, requiredHeaders) {
      var sheet = ensureSheet(name, requiredHeaders);
      var merged = sheet.headers.slice();
      requiredHeaders.forEach(function(h) {
        if (merged.indexOf(h) === -1) merged.push(h);
      });
      sheet.headers = merged;
      return merged.slice();
    },
    appendRows: function(name, rows) {
      guardRead(name);
      if (state.failWriteSheets[name]) throw new Error('INJECTED_WRITE_FAILURE: ' + name);
      var sheet = state.sheets[name];
      rows.forEach(function(values) {
        var row = {};
        sheet.headers.forEach(function(h, i) { row[h] = values[i] === undefined ? '' : clone(values[i]); });
        sheet.rows.push(row);
      });

      if (name === 'Availability_ARCHIVE' && sheet.rows.length) {
        if (state.corruptAvailabilityArchive) {
          sheet.rows[sheet.rows.length - 1].patient_name = '__CORRUPTED_ARCHIVE__';
        }
        if (state.mutateSourceAfterAvailabilityArchive) {
          state.sheets.Availability.rows[0].patient_name = '__CHANGED_AFTER_ARCHIVE__';
        }
      }
      return sandbox.Result.ok({ inserted: rows.length });
    },
    deleteRowsByNumbers: function(name, rowNumbers) {
      guardRead(name);
      if (state.failWriteSheets[name]) throw new Error('INJECTED_DELETE_FAILURE: ' + name);
      rowNumbers.slice().sort(function(a, b) { return b - a; }).forEach(function(rowNumber) {
        var index = rowNumber - 2;
        if (index >= 0 && index < state.sheets[name].rows.length) {
          state.sheets[name].rows.splice(index, 1);
        }
      });
      return sandbox.Result.ok({ deleted: rowNumbers.length });
    }
  };

  sandbox.LogRepository = {
    write: function(entry) { state.logs.push(clone(entry)); return true; }
  };

  function load(rel, name) {
    var src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
  }

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('Clock.js', 'Clock');
  sandbox.Clock.now = function() { return new Date(NOW_ISO); };
  load('Utils/DateUtils.js', 'DateUtils');
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('LogArchiveRepository.js', 'LogArchiveRepository');
  load('AvailabilityArchiveRepository.js', 'AvailabilityArchiveRepository');
  load('RetentionService.js', 'RetentionService');

  return { sandbox: sandbox, state: state };
}

var core = createSandbox();
var sandbox = core.sandbox;
var state = core.state;
var SVC = sandbox.RetentionService;
var tests = [];

function test(name, fn) { tests.push({ name: name, fn: fn }); }

function reset() {
  state.sheets = {
    Availability: { headers: AVAILABILITY_HEADERS.slice(), rows: [] },
    SYSTEM_LOG: { headers: LOG_HEADERS.slice(), rows: [] }
  };
  state.properties = {};
  state.logs = [];
  state.failRead = {};
  state.failWriteSheets = {};
  state.corruptAvailabilityArchive = false;
  state.mutateSourceAfterAvailabilityArchive = false;
}

function addAvailability(fields) {
  var row = Object.assign({
    slot_id: 'SLT_' + String(state.sheets.Availability.rows.length + 1),
    date: '2026/07/01',
    time: '10:00',
    sort_key: '202607011000',
    status: 'EXPIRED',
    is_available: false,
    patient_name: '',
    phone: '',
    calendar_event_id: '',
    Reminder_sent: '',
    whatsapp_message_id: '',
    reserved_until: '',
    reserved_until_unix: ''
  }, fields || {});
  state.sheets.Availability.rows.push(row);
}

function addLog(dateIso, command) {
  state.sheets.SYSTEM_LOG.rows.push({
    timestamp: new Date(dateIso),
    command: command || 'TEST',
    phone: '', slotId: '', stage: 'END', success: true, durationMs: null, error: ''
  });
}

function run(options) { return SVC.run(options || {}); }
function archiveCount(name) { return state.sheets[name] ? state.sheets[name].rows.length : 0; }

test('migration default is DRY_RUN and performs no archive or delete', function() {
  reset();
  addLog('2026-08-16T10:00:00.000Z', 'OLD_LOG');
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });

  var result = run();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.mode, 'DRY_RUN');
  assert.strictEqual(archiveCount('SYSTEM_LOG_ARCHIVE'), 0);
  assert.strictEqual(archiveCount('Availability_ARCHIVE'), 0);
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows.length, 1);
  assert.strictEqual(state.sheets.Availability.rows.length, 1);
});

test('ARCHIVE_ONLY is idempotent on retry', function() {
  reset();
  addLog('2026-08-16T10:00:00.000Z', 'OLD_LOG');
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });

  var first = run({ mode: 'ARCHIVE_ONLY' });
  assert.strictEqual(first.ok, true);
  var systemArchive = archiveCount('SYSTEM_LOG_ARCHIVE');
  var availabilityArchive = archiveCount('Availability_ARCHIVE');
  var second = run({ mode: 'ARCHIVE_ONLY' });

  assert.strictEqual(second.ok, true);
  assert.strictEqual(archiveCount('SYSTEM_LOG_ARCHIVE'), systemArchive);
  assert.strictEqual(archiveCount('Availability_ARCHIVE'), availabilityArchive);
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows.length, 1);
  assert.strictEqual(state.sheets.Availability.rows.length, 1);
});

test('DRY_RUN never creates archive sheets', function() {
  reset();
  addLog('2026-08-16T10:00:00.000Z', 'OLD_LOG');
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  var result = run({ mode: 'DRY_RUN' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.sheets.SYSTEM_LOG_ARCHIVE, undefined);
  assert.strictEqual(state.sheets.Availability_ARCHIVE, undefined);
});

test('SYSTEM_LOG boundary is strict at 31 days', function() {
  reset();
  addLog('2026-08-17T12:00:00.000Z', 'BOUNDARY');
  addLog('2026-08-17T11:59:59.000Z', 'OLD');
  var result = run({ mode: 'DRY_RUN', sources: ['SYSTEM_LOG'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.SYSTEM_LOG.eligible, 1);
});

test('Availability boundary is strict at 60 clinic-local calendar days', function() {
  reset();
  addAvailability({ slot_id: 'BOUNDARY', sort_key: '202607191000' });
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  var result = run({ mode: 'DRY_RUN', sources: ['Availability'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.Availability.cutoffDate, '2026-07-19');
  assert.strictEqual(result.data.sources.Availability.eligible, 1);
});

test('Reserved and ambiguous Availability rows are protected', function() {
  reset();
  addAvailability({ slot_id: 'RESERVED', sort_key: '202607181000', status: 'RESERVED' });
  addAvailability({ slot_id: 'DUP', sort_key: '202607181000' });
  addAvailability({ slot_id: 'DUP', sort_key: '202607181001' });
  var result = run({ mode: 'DRY_RUN', sources: ['Availability'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.Availability.reservedSkipped, 1);
  assert.strictEqual(result.data.sources.Availability.ambiguousSlotIds, 1);
  assert.strictEqual(result.data.sources.Availability.eligible, 0);
});

test('Malformed Availability identity/time is fail-closed', function() {
  reset();
  addAvailability({ slot_id: '', sort_key: '202607181000' });
  addAvailability({ slot_id: 'BAD', sort_key: 'garbage' });
  var result = run({ mode: 'DRY_RUN', sources: ['Availability'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.Availability.malformedSlotIds, 1);
  assert.strictEqual(result.data.sources.Availability.malformedSortKeys, 1);
  assert.strictEqual(result.data.sources.Availability.eligible, 0);
});

test('ARCHIVE_AND_DELETE archives, verifies, revalidates, then deletes', function() {
  reset();
  addLog('2026-08-16T12:00:00.000Z', 'OLD');
  addLog('2026-09-01T12:00:00.000Z', 'RECENT');
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  addAvailability({ slot_id: 'RECENT', sort_key: '202607201000' });

  var result = run({ mode: 'ARCHIVE_AND_DELETE' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.SYSTEM_LOG.deleted, 1);
  assert.strictEqual(result.data.sources.Availability.deleted, 1);
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows[0].command, 'RECENT');
  assert.strictEqual(state.sheets.Availability.rows[0].slot_id, 'RECENT');
  assert.strictEqual(archiveCount('SYSTEM_LOG_ARCHIVE'), 1);
  assert.strictEqual(archiveCount('Availability_ARCHIVE'), 1);
});

test('Archive verification failure blocks Availability delete', function() {
  reset();
  addAvailability({ slot_id: 'VERIFY', sort_key: '202607181000', patient_name: 'A' });
  state.corruptAvailabilityArchive = true;

  var result = run({ mode: 'ARCHIVE_AND_DELETE', sources: ['Availability'] });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(state.sheets.Availability.rows.length, 1);
  assert.ok(state.logs.some(function(x) { return x.command === 'RETENTION_VERIFY_FAILED'; }));
});

test('Fresh Availability snapshot change blocks delete', function() {
  reset();
  addAvailability({ slot_id: 'CHANGE', sort_key: '202607181000', patient_name: 'A' });
  state.mutateSourceAfterAvailabilityArchive = true;

  var result = run({ mode: 'ARCHIVE_AND_DELETE', sources: ['Availability'] });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(state.sheets.Availability.rows.length, 1);
  assert.ok(state.logs.some(function(x) { return x.command === 'RETENTION_DELETE_FAILED'; }));
});

test('SYSTEM_LOG archive write failure blocks delete', function() {
  reset();
  addLog('2026-08-16T12:00:00.000Z', 'OLD');
  state.failWriteSheets.SYSTEM_LOG_ARCHIVE = true;

  var result = run({ mode: 'ARCHIVE_AND_DELETE', sources: ['SYSTEM_LOG'] });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows.length, 1);
});

test('Source failure becomes partial failure without deleting other source', function() {
  reset();
  addLog('2026-08-16T12:00:00.000Z', 'OLD_LOG');
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  state.failRead.SYSTEM_LOG = true;

  var result = run({ mode: 'ARCHIVE_ONLY' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(archiveCount('Availability_ARCHIVE'), 1);
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows.length, 1);
});

test('Invalid RETENTION_MODE fails closed', function() {
  reset();
  state.properties.RETENTION_MODE = 'DELETE_EVERYTHING';
  var result = run();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_MODE_INVALID');
});

test('Retention repository identity is type-sensitive', function() {
  assert.strictEqual(sandbox.AvailabilityArchiveRepository._value('1'), 'string:1');
  assert.strictEqual(sandbox.AvailabilityArchiveRepository._value(1), 'number:1');
  assert.notStrictEqual(
    sandbox.AvailabilityArchiveRepository._value('1'),
    sandbox.AvailabilityArchiveRepository._value(1)
  );
});

test('Retention code keeps current-time construction and Sheets API at boundaries', function() {
  var retention = fs.readFileSync(path.join(ROOT, 'RetentionService.js'), 'utf8');
  var availabilityRepo = fs.readFileSync(path.join(ROOT, 'AvailabilityArchiveRepository.js'), 'utf8');
  assert.strictEqual(retention.indexOf('new Date('), -1);
  assert.strictEqual(retention.indexOf('Utilities.formatDate'), -1);
  assert.strictEqual(availabilityRepo.indexOf('new Date('), -1);
  assert.strictEqual(availabilityRepo.indexOf('Utilities.formatDate'), -1);
});

test('Scheduler has exactly one RetentionService entry and no legacy ArchiveService call', function() {
  var scheduler = fs.readFileSync(path.join(ROOT, 'Scheduler.js'), 'utf8');
  assert.strictEqual((scheduler.match(/RetentionService\.run\(\)/g) || []).length, 1);
  assert.strictEqual(scheduler.indexOf('ArchiveService.run()'), -1);
  assert.ok(scheduler.indexOf('LockService.getUserLock()') !== -1);
});

test('Frozen retention windows remain 31 and 60 days', function() {
  assert.strictEqual(SVC.POLICIES.SYSTEM_LOG_DAYS, 31);
  assert.strictEqual(SVC.POLICIES.AVAILABILITY_DAYS, 60);
});

var passed = 0;
for (var i = 0; i < tests.length; i++) {
  try {
    tests[i].fn();
    passed += 1;
    console.log('PASS', tests[i].name);
  } catch (e) {
    console.error('FAIL', tests[i].name);
    console.error(e.stack || e.message || e);
    process.exitCode = 1;
    break;
  }
}

if (process.exitCode !== 1) console.log(passed + '/' + tests.length + ' PASS');
