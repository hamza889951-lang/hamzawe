'use strict';

process.env.TZ = 'Asia/Baghdad';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const NOW_ISO = '2026-09-17T12:00:00.000Z';
const AV_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];
const LOG_HEADERS = ['timestamp', 'command', 'phone', 'slotId', 'stage', 'success', 'durationMs', 'error'];

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

function makeSandbox() {
  var sandbox = vm.createContext({ console: console });
  var state = {
    sheets: {},
    props: {},
    logs: [],
    failRead: {},
    failWrite: {},
    corruptArchive: false,
    mutateSourceAfterArchive: false
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
        getProperty: function(k) { return state.props[k] || null; },
        setProperty: function(k, v) { state.props[k] = String(v); }
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
  sandbox.LogRepository = { write: function(e) { state.logs.push(clone(e)); return true; } };

  sandbox.GoogleSheets = {
    getAllRows: function(name) {
      guardRead(name);
      return state.sheets[name].rows.map(function(row, i) {
        var copy = clone(row);
        copy._rowNumber = i + 2;
        return copy;
      });
    },
    queryRows: function(name, predicate) {
      return sandbox.GoogleSheets.getAllRows(name).filter(predicate);
    },
    getHeaders: function(name) {
      guardRead(name);
      return state.sheets[name].headers.slice();
    },
    getOrCreateSheet: function(name, headers) { return ensureSheet(name, headers); },
    ensureHeaders: function(name, requiredHeaders) {
      var sheet = ensureSheet(name, requiredHeaders);
      requiredHeaders.forEach(function(h) {
        if (sheet.headers.indexOf(h) === -1) sheet.headers.push(h);
      });
      return sheet.headers.slice();
    },
    appendRows: function(name, rows) {
      guardRead(name);
      if (state.failWrite[name]) throw new Error('INJECTED_WRITE_FAILURE: ' + name);
      var sheet = state.sheets[name];
      rows.forEach(function(values) {
        var row = {};
        sheet.headers.forEach(function(h, i) { row[h] = values[i] === undefined ? '' : clone(values[i]); });
        sheet.rows.push(row);
      });
      if (name === 'Availability_ARCHIVE' && sheet.rows.length) {
        if (state.corruptArchive) sheet.rows[sheet.rows.length - 1].patient_name = '__CORRUPT__';
        if (state.mutateSourceAfterArchive) state.sheets.Availability.rows[0].patient_name = '__CHANGED__';
      }
      return sandbox.Result.ok({ inserted: rows.length });
    },
    deleteRowsByNumbers: function(name, rowNumbers) {
      guardRead(name);
      if (state.failWrite[name]) throw new Error('INJECTED_DELETE_FAILURE: ' + name);
      rowNumbers.slice().sort(function(a, b) { return b - a; }).forEach(function(rowNumber) {
        state.sheets[name].rows.splice(rowNumber - 2, 1);
      });
      return sandbox.Result.ok({ deleted: rowNumbers.length });
    }
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

var core = makeSandbox();
var sandbox = core.sandbox;
var state = core.state;
var svc = sandbox.RetentionService;
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }
function reset() {
  state.sheets = {
    Availability: { headers: AV_HEADERS.slice(), rows: [] },
    SYSTEM_LOG: { headers: LOG_HEADERS.slice(), rows: [] }
  };
  state.props = {};
  state.logs = [];
  state.failRead = {};
  state.failWrite = {};
  state.corruptArchive = false;
  state.mutateSourceAfterArchive = false;
}
function addAvailability(fields) {
  state.sheets.Availability.rows.push(Object.assign({
    slot_id: 'SLT_' + (state.sheets.Availability.rows.length + 1),
    date: '2026/07/01', time: '10:00', sort_key: '202607011000', status: 'EXPIRED',
    is_available: false, patient_name: '', phone: '', calendar_event_id: '',
    Reminder_sent: '', whatsapp_message_id: '', reserved_until: '', reserved_until_unix: ''
  }, fields || {}));
}
function addLog(iso, command) {
  state.sheets.SYSTEM_LOG.rows.push({
    timestamp: new Date(iso), command: command || 'TEST', phone: '', slotId: '',
    stage: 'END', success: true, durationMs: null, error: ''
  });
}
function run(options) { return svc.run(options || {}); }
function count(name) { return state.sheets[name] ? state.sheets[name].rows.length : 0; }

test('default migration mode is DRY_RUN', function() {
  reset(); addLog('2026-08-16T10:00:00Z', 'OLD'); addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  var r = run();
  assert.strictEqual(r.ok, true); assert.strictEqual(r.data.mode, 'DRY_RUN');
  assert.strictEqual(count('SYSTEM_LOG_ARCHIVE'), 0); assert.strictEqual(count('Availability_ARCHIVE'), 0);
  assert.strictEqual(count('SYSTEM_LOG'), 1); assert.strictEqual(count('Availability'), 1);
});

test('ARCHIVE_ONLY is idempotent', function() {
  reset(); addLog('2026-08-16T10:00:00Z', 'OLD'); addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  assert.strictEqual(run({ mode: 'ARCHIVE_ONLY' }).ok, true);
  var a = count('SYSTEM_LOG_ARCHIVE'); var b = count('Availability_ARCHIVE');
  assert.strictEqual(run({ mode: 'ARCHIVE_ONLY' }).ok, true);
  assert.strictEqual(count('SYSTEM_LOG_ARCHIVE'), a); assert.strictEqual(count('Availability_ARCHIVE'), b);
});

test('SYSTEM_LOG boundary is strict at 31 days', function() {
  reset(); addLog('2026-08-17T12:00:00Z', 'BOUNDARY'); addLog('2026-08-17T11:59:59Z', 'OLD');
  var r = run({ mode: 'DRY_RUN', sources: ['SYSTEM_LOG'] });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.data.sources.SYSTEM_LOG.eligible, 1);
});

test('Availability boundary is strict at 60 clinic-local calendar days', function() {
  reset(); addAvailability({ slot_id: 'BOUNDARY', sort_key: '202607191000' }); addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  var r = run({ mode: 'DRY_RUN', sources: ['Availability'] });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.data.sources.Availability.cutoffDate, '2026-07-19');
  assert.strictEqual(r.data.sources.Availability.eligible, 1);
});

test('Reserved, duplicate and malformed Availability rows are protected', function() {
  reset();
  addAvailability({ slot_id: 'RESERVED', sort_key: '202607181000', status: 'RESERVED' });
  addAvailability({ slot_id: 'DUP', sort_key: '202607181000' });
  addAvailability({ slot_id: 'DUP', sort_key: '202607181001' });
  addAvailability({ slot_id: '', sort_key: '202607181000' });
  addAvailability({ slot_id: 'BAD', sort_key: 'garbage' });
  var r = run({ mode: 'DRY_RUN', sources: ['Availability'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.sources.Availability.reservedSkipped, 1);
  assert.strictEqual(r.data.sources.Availability.ambiguousSlotIds, 1);
  assert.strictEqual(r.data.sources.Availability.malformedSlotIds, 1);
  assert.strictEqual(r.data.sources.Availability.malformedSortKeys, 1);
  assert.strictEqual(r.data.sources.Availability.eligible, 0);
});

test('ARCHIVE_AND_DELETE follows archive->verify->fresh-read->delete', function() {
  reset();
  addLog('2026-08-16T12:00:00Z', 'OLD'); addLog('2026-09-01T12:00:00Z', 'RECENT');
  addAvailability({ slot_id: 'OLD', sort_key: '202607181000' }); addAvailability({ slot_id: 'RECENT', sort_key: '202607201000' });
  var r = run({ mode: 'ARCHIVE_AND_DELETE' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.sources.SYSTEM_LOG.deleted, 1); assert.strictEqual(r.data.sources.Availability.deleted, 1);
  assert.strictEqual(state.sheets.SYSTEM_LOG.rows[0].command, 'RECENT');
  assert.strictEqual(state.sheets.Availability.rows[0].slot_id, 'RECENT');
  assert.strictEqual(count('SYSTEM_LOG_ARCHIVE'), 1); assert.strictEqual(count('Availability_ARCHIVE'), 1);
});

test('Archive verification failure blocks delete', function() {
  reset(); addAvailability({ slot_id: 'VERIFY', sort_key: '202607181000', patient_name: 'A' }); state.corruptArchive = true;
  var r = run({ mode: 'ARCHIVE_AND_DELETE', sources: ['Availability'] });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(count('Availability'), 1);
  assert.ok(state.logs.some(function(x) { return x.command === 'RETENTION_VERIFY_FAILED'; }));
});

test('Fresh source snapshot change blocks delete', function() {
  reset(); addAvailability({ slot_id: 'CHANGE', sort_key: '202607181000', patient_name: 'A' }); state.mutateSourceAfterArchive = true;
  var r = run({ mode: 'ARCHIVE_AND_DELETE', sources: ['Availability'] });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(count('Availability'), 1);
  assert.ok(state.logs.some(function(x) { return x.command === 'RETENTION_DELETE_FAILED'; }));
});

test('Archive write failure and source failure are fail-closed', function() {
  reset(); addLog('2026-08-16T12:00:00Z', 'OLD'); state.failWrite.SYSTEM_LOG_ARCHIVE = true;
  var r1 = run({ mode: 'ARCHIVE_AND_DELETE', sources: ['SYSTEM_LOG'] });
  assert.strictEqual(r1.ok, false); assert.strictEqual(count('SYSTEM_LOG'), 1);

  reset(); addLog('2026-08-16T12:00:00Z', 'OLD'); addAvailability({ slot_id: 'OLD', sort_key: '202607181000' });
  state.failRead.SYSTEM_LOG = true;
  var r2 = run({ mode: 'ARCHIVE_ONLY' });
  assert.strictEqual(r2.ok, false); assert.strictEqual(r2.error.code, 'RETENTION_PARTIAL_FAILURE');
  assert.strictEqual(count('Availability_ARCHIVE'), 1); assert.strictEqual(count('SYSTEM_LOG'), 1);
});

test('Invalid mode, identity typing, CAS-009 and Scheduler boundary are enforced', function() {
  reset(); state.props.RETENTION_MODE = 'DELETE_EVERYTHING';
  assert.strictEqual(run().error.code, 'RETENTION_MODE_INVALID');

  assert.notStrictEqual(sandbox.AvailabilityArchiveRepository._value('1'), sandbox.AvailabilityArchiveRepository._value(1));

  var retention = fs.readFileSync(path.join(ROOT, 'RetentionService.js'), 'utf8');
  var availability = fs.readFileSync(path.join(ROOT, 'AvailabilityArchiveRepository.js'), 'utf8');
  var scheduler = fs.readFileSync(path.join(ROOT, 'Scheduler.js'), 'utf8');
  assert.strictEqual(retention.indexOf('new Date('), -1);
  assert.strictEqual(retention.indexOf('Utilities.formatDate'), -1);
  assert.strictEqual(availability.indexOf('new Date('), -1);
  assert.strictEqual(availability.indexOf('Utilities.formatDate'), -1);
  assert.strictEqual((scheduler.match(/RetentionService\.run\(\)/g) || []).length, 1);
  assert.strictEqual(scheduler.indexOf('ArchiveService.run()'), -1);
});

test('Frozen retention windows remain 31 and 60 days', function() {
  assert.strictEqual(svc.POLICIES.SYSTEM_LOG_DAYS, 31);
  assert.strictEqual(svc.POLICIES.AVAILABILITY_DAYS, 60);
});

var passed = 0;
for (var i = 0; i < tests.length; i++) {
  try { tests[i].fn(); passed += 1; console.log('PASS', tests[i].name); }
  catch (e) { console.error('FAIL', tests[i].name); console.error(e.stack || e.message || e); process.exitCode = 1; break; }
}
if (process.exitCode !== 1) console.log(passed + '/' + tests.length + ' PASS');
