'use strict';

/**
 * ReminderService reliability contract tests.
 * Run with: node tests/ReminderServiceReliability.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = vm.createContext({ console: console });
const fixedNow = new Date('2026-10-14T08:00:00.000Z');
const logEntries = [];

sandbox.Result = {
  ok: function(data) { return { ok: true, data: data, error: null }; },
  fail: function(code, message, details) {
    return { ok: false, data: null, error: { code: code, message: message, details: details || null } };
  }
};
sandbox.Clock = { now: function() { return new Date(fixedNow.getTime()); } };
sandbox.DateUtils = {
  addMinutes: function(date, minutes) { return new Date(date.getTime() + minutes * 60000); },
  formatDateDisplay: function(date) { return String(date || 'date'); },
  normalizeTime: function(value) { return value || null; }
};
sandbox.Config = {
  SYSTEM_POLICY: { REMINDER_LEAD_MINUTES: 240 },
  VOCABULARY: { STATUS: { CONFIRMED: 'CONFIRMED' } }
};
sandbox.LegacySlotTimeParser = {
  toComparableTime: function(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
};
sandbox.BusNumberCalculator = { fromSlot: function() { return sandbox.Result.ok({ busNumber: 'B1' }); } };
sandbox.SettingsRepository = { getAll: function() { return { work_start: '09:00' }; } };
sandbox.SlotRepository = {
  rows: [],
  queryFailure: null,
  queryResult: function(predicate) {
    if (this.queryFailure) return this.queryFailure;
    return sandbox.Result.ok(this.rows.filter(predicate));
  },
  isOperationallyAvailable: function(value) { return value === true || value === 'TRUE'; },
  atomicUpdate: function(slotId, decision) {
    if (this.markBehavior) return this.markBehavior(slotId, decision);
    return decision({ slot_id: slotId });
  },
  markBehavior: null
};
sandbox.LogRepository = { write: function(entry) { logEntries.push(entry); } };

vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'Reminderservice.js'), 'utf8') +
    '\nthis.ReminderService = ReminderService;',
  sandbox,
  { filename: 'Reminderservice.js' }
);

const service = sandbox.ReminderService;
const ok = sandbox.Result.ok;
const fail = sandbox.Result.fail;

function slot(id, start, extra) {
  return Object.assign({
    slot_id: id,
    phone: 'test-recipient',
    status: 'CONFIRMED',
    is_available: true,
    Reminder_sent: '',
    sort_key: start,
    date: '2026-10-14'
  }, extra || {});
}
function run(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (e) {
    console.error('FAIL', name);
    console.error(e.stack || e);
    process.exitCode = 1;
  }
}
function reset(rows) {
  sandbox.SlotRepository.rows = rows || [];
  sandbox.SlotRepository.queryFailure = null;
  sandbox.SlotRepository.markBehavior = null;
  logEntries.length = 0;
}

run('query failure is not converted into an empty successful result', function() {
  reset([]);
  sandbox.SlotRepository.queryFailure = fail('AVAILABILITY_QUERY_FAILED', 'read failed');
  const result = service.collectPendingReminders();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'AVAILABILITY_QUERY_FAILED');
});

run('eligibility preserves future, availability, sent-marker, and window gates', function() {
  reset([
    slot('eligible', '2026-10-14T11:00:00.000Z'),
    slot('past', '2026-10-14T07:59:00.000Z'),
    slot('at-now', '2026-10-14T08:00:00.000Z'),
    slot('outside-window', '2026-10-14T12:01:00.000Z'),
    slot('closed', '2026-10-14T10:00:00.000Z', { is_available: false }),
    slot('sent-bool', '2026-10-14T10:00:00.000Z', { Reminder_sent: true }),
    slot('sent-text', '2026-10-14T10:00:00.000Z', { Reminder_sent: 'TRUE' }),
    slot('wrong-status', '2026-10-14T10:00:00.000Z', { status: 'CANCELLED' }),
    slot('window-end', '2026-10-14T12:00:00.000Z')
  ]);
  const result = service.collectPendingReminders();
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    Array.from(result.data, function(job) { return job.slotId; }),
    ['eligible', 'window-end']
  );
});

run('successful send and marker produce completed success', function() {
  reset([slot('one', '2026-10-14T10:00:00.000Z')]);
  const result = service.processPendingReminders(function() { return ok({ providerMessageId: 'wamid.test' }); });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sent, 1);
  assert.strictEqual(result.data.total, 1);
  assert.strictEqual(result.data.failed, 0);
});

run('send failure is reported and marker is not attempted', function() {
  reset([slot('one', '2026-10-14T10:00:00.000Z')]);
  let markCalls = 0;
  sandbox.SlotRepository.markBehavior = function() { markCalls++; return ok({}); };
  const result = service.processPendingReminders(function() { return fail('WHATSAPP_SEND_FAILED', 'provider rejected'); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'REMINDER_PARTIAL_FAILURE');
  assert.strictEqual(result.error.details.counts.sendFailed, 1);
  assert.strictEqual(markCalls, 0);
  assert.ok(logEntries.some(function(entry) { return entry.command === 'REMINDER_SEND_FAILED'; }));
});

run('thrown send exception does not stop later reminders', function() {
  reset([
    slot('first', '2026-10-14T10:00:00.000Z'),
    slot('second', '2026-10-14T10:30:00.000Z')
  ]);
  let calls = 0;
  const result = service.processPendingReminders(function() {
    calls++;
    if (calls === 1) throw new Error('network timeout');
    return ok({});
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.details.counts.sendFailed, 1);
  assert.strictEqual(result.error.details.counts.sent, 1);
});

run('send success with marker failure is not reported as completed', function() {
  reset([slot('one', '2026-10-14T10:00:00.000Z')]);
  sandbox.SlotRepository.markBehavior = function() { return fail('UPDATE_FAILED', 'sheet write failed'); };
  const result = service.processPendingReminders(function() { return ok({}); });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.details.counts.sent, 0);
  assert.strictEqual(result.error.details.counts.markFailed, 1);
  assert.ok(logEntries.some(function(entry) { return entry.command === 'REMINDER_MARK_FAILED'; }));
});

run('empty candidate set is successful with zero counts', function() {
  reset([]);
  const result = service.processPendingReminders(function() { throw new Error('must not send'); });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.total, 0);
  assert.strictEqual(result.data.sent, 0);
});

if (process.exitCode !== 1) console.log('7/7 PASS');
