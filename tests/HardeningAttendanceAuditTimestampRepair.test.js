'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../diagnostics/RepairAttendanceAuditTimestamps.js'),
  'utf8'
);
const headers = [
  'operator_id', 'calendar_event_id', 'calendar_id', 'slot_id', 'decision',
  'from_status', 'to_status', 'outcome', 'error_code', 'timestamp'
];

function parseLocal(value) {
  return new Date(Date.parse(value.replace(' ', 'T') + '+03:00'));
}

function formatLocal(value, format) {
  const d = new Date(value.getTime() + 3 * 60 * 60 * 1000);
  const pad = function(n, width) { return String(n).padStart(width, '0'); };
  const date = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' +
    pad(d.getUTCDate(), 2);
  const time = pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' +
    pad(d.getUTCSeconds(), 2) + '.' + pad(d.getUTCMilliseconds(), 3);
  return format === 'yyyy-MM-dd' ? date : date + ' ' + time;
}

function createEnvironment(timeZone) {
  const rows = Array.from({ length: 10 }, function() {
    return Array(10).fill('');
  });
  rows[0] = headers.slice();

  function row(n, values) {
    Object.keys(values).forEach(function(key) {
      rows[n - 1][headers.indexOf(key)] = values[key];
    });
  }
  const applied = [
    [2, 'hamza889951@gmail.com', 'kfvboca5v1pmeaopuqbbg09k04@google.com',
      'hamza889951@gmail.com', 'SLT_01KZHNKVTE4JPJ4SSJWFGY0S6F', 'MARK_COMPLETED',
      'CONFIRMED', 'COMPLETED', '2026-09-07'],
    [4, 'hamza889951@gmail.com', 'rsgl2i8m5pvsgv7feghguvap84@google.com',
      'hamza889951@gmail.com', 'SLT_01KZYNSGQAADPNSND9H882WB5G', 'MARK_COMPLETED',
      'CONFIRMED', 'COMPLETED', '2026-09-13'],
    [5, 'hamzaalking158@gmail.com', 'rsgl2i8m5pvsgv7feghguvap84@google.com',
      'hamza889951@gmail.com', 'SLT_01KZYNSGQAADPNSND9H882WB5G', 'MARK_NO_SHOW',
      'CONFIRMED', 'NO_SHOW', '2026-09-17'],
    [7, 'hamzaalking158@gmail.com', 'l1odc7capccmr3r1esedk393es@google.com',
      'hamza889951@gmail.com', 'SLT_01KZYNSGQA42MSXEKAZ3VHA78K', 'MARK_NO_SHOW',
      'CONFIRMED', 'NO_SHOW', '2026-09-17'],
    [8, 'hamzaalking158@gmail.com', '445d1mq40kshj9kjj849jjmcik@google.com',
      'hamza889951@gmail.com', 'SLT_01M0BHSAMKS09WFYVKMS4GCQ', 'MARK_NO_SHOW',
      'CONFIRMED', 'NO_SHOW', '2026-09-17'],
    [9, 'hamzaalking158@gmail.com', 'fe740ac2nsrfj5e1leh2o2kiok@google.com',
      'hamza889951@gmail.com', 'SLT_01M1FKB7YK79Y5P1N43JPXBFTE', 'MARK_COMPLETED',
      'CONFIRMED', 'COMPLETED', '2026-10-02']
  ];
  applied.forEach(function(x) {
    row(x[0], {
      operator_id: x[1], calendar_event_id: x[2], calendar_id: x[3], slot_id: x[4],
      decision: x[5], from_status: x[6], to_status: x[7], outcome: 'APPLIED',
      error_code: '', timestamp: x[8]
    });
  });
  row(3, { slot_id: 'SLT_01KZHNKVTE4JPJ4SSJWFGY0S6F', decision: 'MARK_NO_SHOW',
    from_status: 'COMPLETED', outcome: 'REJECTED_INVALID_TRANSITION',
    error_code: 'INVALID_TRANSITION', timestamp: '2026-09-07' });
  row(6, { slot_id: 'SLT_01KZYNSGQAADPNSND9H882WB5G', decision: 'MARK_COMPLETED',
    from_status: 'NO_SHOW', outcome: 'REJECTED_INVALID_TRANSITION',
    error_code: 'INVALID_TRANSITION', timestamp: '2026-09-17' });
  row(10, {
    operator_id: 'hamzaalking158@gmail.com',
    calendar_event_id: '4oota1f12reg31anm7ct71d9uc@google.com',
    calendar_id: 'hamza889951@gmail.com',
    slot_id: 'SLT_01M2QM8R5H0TDG9SF3SJYFKBB2',
    decision: 'MARK_NO_SHOW', from_status: 'CONFIRMED', to_status: 'NO_SHOW',
    outcome: 'APPLIED', error_code: '', timestamp: parseLocal('2026-10-11 05:48:41.909')
  });

  let writes = 0;
  const sheet = {
    getLastRow: function() { return 10; },
    getLastColumn: function() { return 10; },
    getRange: function(r, c, nr, nc) {
      nr = nr || 1; nc = nc || 1;
      return {
        getValues: function() {
          return rows.slice(r - 1, r - 1 + nr).map(function(sourceRow) {
            return sourceRow.slice(c - 1, c - 1 + nc);
          });
        },
        getValue: function() { return rows[r - 1][c - 1]; },
        setValue: function(value) { rows[r - 1][c - 1] = value; writes += 1; },
        setNumberFormat: function() {}
      };
    }
  };
  const spreadsheet = {
    getSpreadsheetTimeZone: function() { return timeZone || 'Asia/Baghdad'; },
    getSheetByName: function(name) { return name === 'ATTENDANCE_AUDIT' ? sheet : null; }
  };
  const context = {
    Date,
    isFinite,
    GoogleSheets: { _openSpreadsheet: function() { return spreadsheet; } },
    Utilities: { parseDate: parseLocal, formatDate: formatLocal }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'RepairAttendanceAuditTimestamps.js' });
  return {
    rows: rows,
    getWrites: function() { return writes; },
    run: function() { return vm.runInContext('runHamzaweAttendanceAuditTimestampRepair()', context); }
  };
}

function testRepairsSixVerifiedTimestampsAndVerifiesReadback() {
  const env = createEnvironment();
  const result = env.run();
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.repairedRowNumbers.join(','), '2,4,5,7,8,9');
  assert.strictEqual(result.verifiedTimestampCount, 6);
  assert.strictEqual(env.getWrites(), 6);
  [2, 4, 5, 7, 8, 9].forEach(function(rowNumber) {
    const value = env.rows[rowNumber - 1][9];
    assert.ok(value instanceof Date, 'row ' + rowNumber + ' must be stored as Date');
    assert.strictEqual(formatLocal(value, 'yyyy-MM-dd HH:mm:ss.SSS'),
      ({
        2: '2026-09-07 22:43:35.773',
        4: '2026-09-13 04:47:59.849',
        5: '2026-09-17 00:20:11.777',
        7: '2026-09-17 00:35:57.354',
        8: '2026-09-17 03:46:59.021',
        9: '2026-10-02 06:03:54.209'
      })[rowNumber]);
  });
}

function testRepairIsIdempotent() {
  const env = createEnvironment();
  const first = env.run();
  assert.strictEqual(first.ok, true);
  const writesAfterFirstRun = env.getWrites();
  const second = env.run();
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(env.getWrites(), writesAfterFirstRun);
  assert.strictEqual(second.repairedRowNumbers.length, 0);
  assert.strictEqual(second.alreadyCorrectRowNumbers.length, 6);
}

function testIdentityMismatchBlocksAllWrites() {
  const env = createEnvironment();
  env.rows[8 - 1][headers.indexOf('slot_id')] = 'WRONG_SLOT_ID';
  const result = env.run();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'REPAIR_ROW_IDENTITY_MISMATCH');
  assert.strictEqual(env.getWrites(), 0, 'preflight mismatch must block every write');
}

function testTimezoneMismatchBlocksAllWrites() {
  const env = createEnvironment('UTC');
  const result = env.run();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'REPAIR_TIME_ZONE_MISMATCH');
  assert.strictEqual(env.getWrites(), 0);
}

testRepairsSixVerifiedTimestampsAndVerifiesReadback();
testRepairIsIdempotent();
testIdentityMismatchBlocksAllWrites();
testTimezoneMismatchBlocksAllWrites();

console.log('Attendance audit timestamp repair: 4/4 PASS');
