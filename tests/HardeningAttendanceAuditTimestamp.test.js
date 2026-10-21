'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../Repositories/AttendanceAuditRepository.js'),
  'utf8'
);

const headers = [
  'operator_id', 'calendar_event_id', 'calendar_id', 'slot_id', 'decision',
  'from_status', 'to_status', 'outcome', 'error_code', 'timestamp'
];

let clockValue;
let appendCalls = 0;
let appendedRows = null;

const context = {
  Date,
  isFinite,
  Clock: { now: function() { return clockValue; } },
  Result: {
    ok: function(data) { return { ok: true, data: data }; },
    fail: function(code, message, details) {
      return { ok: false, error: { code: code, message: message, details: details } };
    }
  },
  GoogleSheets: {
    getOrCreateSheet: function() {},
    getHeaders: function() { return headers.slice(); },
    appendRows: function(sheetName, rows) {
      appendCalls += 1;
      appendedRows = rows;
      return { ok: true, data: { inserted: rows.length } };
    }
  }
};

vm.createContext(context);
vm.runInContext(source, context, { filename: 'AttendanceAuditRepository.js' });
const repository = vm.runInContext('AttendanceAuditRepository', context);

function testValidDateIsPersistedAsDateEvidence() {
  const expected = new Date('2026-10-21T16:00:00.000Z');
  clockValue = expected;
  appendCalls = 0;
  appendedRows = null;

  const result = repository.append({
    operator_id: 'operator-test',
    slot_id: 'slot-test',
    decision: 'MARK_COMPLETED',
    outcome: 'APPLIED',
    to_status: 'COMPLETED'
  });

  assert.strictEqual(result.ok, true, 'valid Date should be accepted');
  assert.strictEqual(appendCalls, 1, 'one append should occur');
  const timestampIndex = headers.indexOf('timestamp');
  assert.strictEqual(appendedRows[0][timestampIndex], expected,
    'the exact Date returned by Clock.now must be persisted');
  assert.ok(appendedRows[0][timestampIndex] instanceof Date,
    'timestamp must remain a Date, not a formatted string');
}

function testDateOnlyStringIsRejectedBeforeWrite() {
  clockValue = '2026-10-21';
  appendCalls = 0;
  appendedRows = null;

  const result = repository.append({
    operator_id: 'operator-test',
    slot_id: 'slot-test',
    decision: 'MARK_COMPLETED',
    outcome: 'APPLIED',
    to_status: 'COMPLETED'
  });

  assert.strictEqual(result.ok, false, 'date-only string must be rejected');
  assert.strictEqual(result.error.code, 'ATTENDANCE_AUDIT_TIMESTAMP_INVALID');
  assert.strictEqual(appendCalls, 0, 'invalid timestamp must not reach storage');
  assert.strictEqual(appendedRows, null);
}

function testInvalidDateObjectIsRejectedBeforeWrite() {
  clockValue = new Date(NaN);
  appendCalls = 0;
  appendedRows = null;

  const result = repository.append({
    operator_id: 'operator-test',
    slot_id: 'slot-test',
    decision: 'MARK_COMPLETED',
    outcome: 'APPLIED',
    to_status: 'COMPLETED'
  });

  assert.strictEqual(result.ok, false, 'invalid Date object must be rejected');
  assert.strictEqual(result.error.code, 'ATTENDANCE_AUDIT_TIMESTAMP_INVALID');
  assert.strictEqual(appendCalls, 0, 'invalid Date must not reach storage');
}

testValidDateIsPersistedAsDateEvidence();
testDateOnlyStringIsRejectedBeforeWrite();
testInvalidDateObjectIsRejectedBeforeWrite();

console.log('Attendance audit timestamp guard: 3/3 PASS');
