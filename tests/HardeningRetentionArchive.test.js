'use strict';

/**
 * HardeningRetentionArchive.test.js
 *
 * Contract: RETENTION-ARCHIVE-UNIFICATION-v1
 *
 * Covers the safety-critical contract surface without touching real Sheets:
 *  - SYSTEM_LOG 31-day boundary
 *  - Availability 60-day local-date boundary
 *  - archive-only default / no deletion on deploy
 *  - idempotent archive retry
 *  - DRY_RUN no writes
 *  - ARCHIVE_AND_DELETE fresh reread and snapshot protection
 *  - RESERVED / malformed / boundary protection
 *  - source partial failure and invalid mode
 *  - single Scheduler orchestration integration
 */

process.env.TZ = 'Asia/Baghdad';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const EVAL_ISO = '2026-09-17T12:00:00.000Z';
const AVAILABILITY_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];
const LOG_HEADERS = [
  'timestamp', 'command', 'phone', 'slotId', 'stage', 'success', 'durationMs', 'error'
];

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(function(k) { out[k] = clone(value[k]); });
    return out;
  }
  return value;
}

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    sheets: {},
    properties: {},
    logs: [],
    failRead: {},
    failWriteSheets: {},
    mutateArchiveAfterAppend: false
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
      const p = function(n) { return String(n).padStart(2, '0'); };
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
      const sheet = ensureSheet(name, requiredHeaders);
      const merged = sheet.headers.slice();
      requiredHeaders.forEach(function(header) {
        if (merged.indexOf(header) === -1) merged.push(header);
      });
      sheet.headers = merged;
      return merged.slice();
    },
    appendRows: function(name, rows) {
      guardRead(name);
      if (state.failWriteSheets[name]) throw new Error('INJECTED_WRITE_FAILURE: ' + name);
      const sheet = state.sheets[name];
      rows.forEach(function(values) {
        const row = {};
        sheet.headers.forEach(function(h, i) { row[h] = values[i] === undefined ? '' : clone(values[i]); });
        sheet.rows.push(row);
      });
      if (name === 'Availability_ARCHIVE' && state.mutateArchiveAfterAppend && sheet.rows.length) {
        sheet.rows[sheet.rows.length - 1].patient_name = '__CORRUPTED_AFTER_APPEND__';
      }
      return sandbox.Result.ok({ inserted: rows.length });
    },
    deleteRowsByNumbers: function(name, rowNumbers) {
      guardRead(name);
      if (state.failWriteSheets[name]) throw new Error('INJECTED_DELETE_FAILURE: ' + name);
      const sorted = rowNumbers.slice().sort(function(a, b) { return b - a; });
      sorted.forEach(function(rowNumber) {
        const index = rowNumber - 2;
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
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
  }

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('Clock.js', 'Clock');
  sandbox.Clock.now = function() { return new Date(EVAL_ISO); };
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('LogArchiveRepository.js', 'LogArchiveRepository');
  load('AvailabilityArchiveRepository.js', 'AvailabilityArchiveRepository');
  load('RetentionService.js', 'RetentionService');

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;
const SVC = sandbox.RetentionService;

function reset() {
  state.sheets = {
    Availability: { headers: AVAILABILITY_HEADERS.slice(), rows: [] },
    SYSTEM_LOG: { headers: LOG_HEADERS.slice(), rows: [] }
  };
  state.properties = {};
  state.logs = [];
  state.failRead = {};
  state.failWriteSheets = {};
  state.mutateArchiveAfterAppend = false;
}

function addAvailability(fields) {
  const row = Object.assign({
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
  return row;
}

function addLog(dateIso, fields) {
  const row = Object.assign({
    timestamp: new Date(dateIso),
    command: 'TEST',
    phone: '',
    slotId: '',
    stage: 'END',
    success: true,
    durationMs: null,
    error: ''
  }, fields || {});
  state.sheets.SYSTEM_LOG.rows.push(row);
  return row;
}

function archiveRows(name) {
  return (state.sheets[name] ? state.sheets[name].rows : []).map(clone);
}

function run(options) {
  return SVC.run(options || {});
}

let tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('default mode is ARCHIVE_ONLY and does not delete', function() {
  reset();
  addLog('2026-08-16T10:00:00.000Z', { command: 'OLD_LOG' });
  addAvailability({ slot_id: 'OLD_AVAIL', sort_key: '202607181000' });

  const result = run();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.mode, 'ARCHIVE_ONLY');
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows.length, 1);
  assert.strictEqual(state.sheets.Availability.rows.length, 1);
  assert.strictEqual(archiveRows('SYSTEM_LOG_ARCHIVE').length, 1);
  assert.strictEqual(archiveRows('Availability_ARCHIVE').length, 1);
});

test('ARCHIVE_ONLY is idempotent on retry', function() {
  reset();
  addLog('2026-08-16T10:00:00.000Z', { command: 'OLD_LOG' });
  addAvailability({ slot_id: 'OLD_AVAIL', sort_key: '202607181000' });

  run();
  const beforeSystem = archiveRows('SYSTEM_LOG_ARCHIVE').length;
  const beforeAvailability = archiveRows('Availability_ARCHIVE').length;
  run();

  assert.strictEqual(archiveRows('SYSTEM_LOG_ARCHIVE').length, beforeSystem);
  assert.strictEqual(archiveRows('Availability_ARCHIVE').length, beforeAvailability);
});

test('DRY_RUN performs no archive writes', function() {
  reset();
  addLog('2026-08-16T10:00:00.000Z', { command: 'OLD_LOG' });
  addAvailability({ slot_id: 'OLD_AVAIL', sort_key: '202607181000' });

  const result = run({ mode: 'DRY_RUN' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(state.sheets.SYSTEM_LOG_ARCHIVE, undefined);
  assert.strictEqual(state.sheets.Availability_ARCHIVE, undefined);
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows.length, 1);
  assert.strictEqual(state.sheets.Availability.rows.length, 1);
});

test('Availability exact 60-day boundary is protected by local calendar date', function() {
  reset();
  addAvailability({ slot_id: 'BOUNDARY', sort_key: '202607191000' });
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });

  const result = run({ mode: 'DRY_RUN' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.Availability.eligible, 1);
  assert.ok(result.data.sources.Availability.cutoffDate);
});

test('Availability RESERVED rows remain Maintenance-owned', function() {
  reset();
  addAvailability({ slot_id: 'RESERVED_OLD', sort_key: '202607181000', status: 'RESERVED' });
  const result = run({ mode: 'ARCHIVE_ONLY' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.Availability.eligible, 0);
  assert.strictEqual(result.data.sources.Availability.reservedSkipped, 1);
  assert.strictEqual(archiveRows('Availability_ARCHIVE').length, 0);
});

test('Malformed Availability identity/time is protected and reported', function() {
  reset();
  addAvailability({ slot_id: '', sort_key: '202607181000' });
  addAvailability({ slot_id: 'BAD_TIME', sort_key: 'garbage' });
  const result = run({ mode: 'DRY_RUN' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.Availability.malformedSlotIds, 1);
  assert.strictEqual(result.data.sources.Availability.malformedSortKeys, 1);
});

test('SYSTEM_LOG exact 31-day boundary is protected', function() {
  reset();
  addLog('2026-08-17T12:00:00.000Z', { command: 'BOUNDARY' });
  addLog('2026-08-16T12:00:00.000Z', { command: 'OLD' });
  const result = run({ mode: 'DRY_RUN', sources: ['SYSTEM_LOG'] });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.SYSTEM_LOG.eligible, 1);
});

test('ARCHIVE_AND_DELETE removes only verified old records', function() {
  reset();
  addLog('2026-08-16T12:00:00.000Z', { command: 'OLD' });
  addLog('2026-09-01T12:00:00.000Z', { command: 'RECENT' });
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  addAvailability({ slot_id: 'RECENT', sort_key: '202607201000' });
  state.properties.RETENTION_MODE = 'ARCHIVE_AND_DELETE';

  const result = run();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sources.SYSTEM_LOG.deleted, 1);
  assert.strictEqual(result.data.sources.Availability.deleted, 1);
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows[0].command, 'RECENT');
  assert.strictEqual(state.sheets.Availability.rows[0].slot_id, 'RECENT');
});

test('Availability snapshot change blocks delete and preserves archive', function() {
  reset();
  addAvailability({ slot_id: 'CHANGED', sort_key: '202607181000', patient_name: 'A' });
  state.properties.RETENTION_MODE = 'ARCHIVE_AND_DELETE';

  const first = run({ mode: 'ARCHIVE_ONLY' });
  assert.strictEqual(first.ok, true);
  state.sheets.Availability.rows[0].patient_name = 'B';

  const result = run();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(state.sheets.Availability.rows.length, 1);
  assert.strictEqual(archiveRows('Availability_ARCHIVE').length, 1);
});

test('Archive verification failure blocks Availability delete', function() {
  reset();
  addAvailability({ slot_id: 'VERIFY_FAIL', sort_key: '202607181000', patient_name: 'A' });
  state.mutateArchiveAfterAppend = true;
  state.properties.RETENTION_MODE = 'ARCHIVE_AND_DELETE';

  const result = run();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(state.sheets.Availability.rows.length, 1);
  assert.ok(state.logs.some(function(log) { return log.command === 'RETENTION_VERIFY_FAILED'; }));
});

test('SYSTEM_LOG archive write failure blocks delete', function() {
  reset();
  addLog('2026-08-16T12:00:00.000Z', { command: 'OLD' });
  state.failWriteSheets.SYSTEM_LOG_ARCHIVE = true;
  state.properties.RETENTION_MODE = 'ARCHIVE_AND_DELETE';

  const result = run({ sources: ['SYSTEM_LOG'] });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows.length, 1);
  assert.ok(state.logs.some(function(log) { return log.command === 'RETENTION_STAGE_FAILED'; }));
});

test('Invalid RETENTION_MODE fails closed before any source work', function() {
  reset();
  state.properties.RETENTION_MODE = 'DELETE_EVERYTHING';
  addLog('2026-08-16T12:00:00.000Z', { command: 'OLD' });
  const result = run();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_MODE_INVALID');
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows.length, 1);
});

test('SYSTEM_LOG and Availability source failures become one partial retention failure', function() {
  reset();
  addLog('2026-08-16T12:00:00.000Z', { command: 'OLD' });
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  state.failRead.SYSTEM_LOG = true;

  const result = run({ mode: 'ARCHIVE_ONLY' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(archiveRows('Availability_ARCHIVE').length, 1);
});

test('Scheduler uses RetentionService as the sole retention entry point', function() {
  const source = fs.readFileSync(path.join(ROOT, 'Scheduler.js'), 'utf8');
  assert.ok(source.indexOf('RetentionService.run()') !== -1);
  assert.strictEqual((source.match(/RetentionService\.run\(\)/g) || []).length, 1);
  assert.strictEqual(source.indexOf('ArchiveService.run()'), -1);
  assert.ok(source.indexOf('LockService.getUserLock()') !== -1);
});

test('Frozen policy constants remain 31 and 60 days', function() {
  assert.strictEqual(SVC.POLICIES.SYSTEM_LOG_DAYS, 31);
  assert.strictEqual(SVC.POLICIES.AVAILABILITY_DAYS, 60);
});

let passed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed += 1;
    console.log('PASS', t.name);
  } catch (err) {
    console.error('FAIL', t.name);
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
    break;
  }
}

if (process.exitCode !== 1) {
  console.log(passed + '/' + tests.length + ' PASS');
}
