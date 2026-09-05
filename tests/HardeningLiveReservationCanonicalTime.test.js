'use strict';

/**
 * Reproduces the live failure at ReserveSlot after patient-name entry.
 * The slot's time field may render as 02:57 while its canonical sort_key is
 * 2026-09-06 16:00. BookingService must therefore receive a valid bus number
 * from BusNumberCalculator.fromSlot() and continue to WAITING_CONFIRMATION.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const sandbox = vm.createContext({ console: console, Intl: Intl });
sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
sandbox.Utilities = {
  formatDate: function(date, tz, fmt) {
    if (fmt !== 'HH:mm') return '2026-09-06';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(date).reduce(function(acc, part) {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return parts.hour + ':' + parts.minute;
  }
};

sandbox.Result = {
  ok: function(data) { return { ok: true, data: data }; },
  fail: function(code, message, details) {
    return { ok: false, error: { code: code, message: message, details: details || null } };
  }
};

sandbox.SettingsRepository = {
  getAll: function() { return { work_start: '16:00' }; },
  getSlotDurationMinutes: function() { return 15; }
};
sandbox.LegacySlotTimeParser = {
  toComparableTime: function(value) {
    if (typeof value !== 'string' || !/^\d{12}$/.test(value)) return null;
    const y = Number(value.slice(0, 4));
    const m = Number(value.slice(4, 6));
    const d = Number(value.slice(6, 8));
    const hh = Number(value.slice(8, 10));
    const mm = Number(value.slice(10, 12));
    return new Date(Date.UTC(y, m - 1, d, hh - 3, mm, 0, 0)).getTime();
  }
};
sandbox.Config = {
  VOCABULARY: {
    STATUS: { RESERVED: 'RESERVED' },
    COMMANDS: { RESERVE_SLOT: 'RESERVE_SLOT' },
    CONVERSATION_STATE: {
      WAITING_NAME: 'WAITING_NAME',
      WAITING_CONFIRMATION: 'WAITING_CONFIRMATION'
    }
  },
  SYSTEM_POLICY: { RESERVATION_TIMEOUT_MINUTES: 10 }
};
sandbox.Validators = {
  validatePatientName: function(value) {
    return value && value.trim().split(/\s+/).length >= 2
      ? sandbox.Result.ok(value.trim())
      : sandbox.Result.fail('INVALID_PATIENT_NAME', 'invalid name');
  }
};
sandbox.Clock = { now: function() { return new Date('2026-09-05T10:00:00.000Z'); } };
sandbox.DateUtils = {
  addMinutes: function(date, minutes) { return new Date(date.getTime() + minutes * 60000); },
  formatDateDisplay: function() { return '2026-09-06'; }
};
sandbox.ConversationRepository = {
  moveToWaitingConfirmation: function() {}
};
sandbox.CommandExecutor = {
  execute: function(command, context, fn) { return fn(); }
};

function load(rel, name) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
}

load('BusNumberCalculator.js', 'BusNumberCalculator');
load('Application/BookingService.js', 'BookingService');

sandbox.BookingService._reserveEarliestBookable = function() {
  return sandbox.Result.ok({
    slot: {
      slot_id: 'SLT_LIVE_CANONICAL',
      date: '2026/09/06',
      // Live-like bad Date representation that renders as 02:57 in Baghdad.
      time: new Date('2026-09-05T23:57:00.000Z'),
      sort_key: '202609061600'
    }
  });
};

const result = sandbox.BookingService._handleWaitingName('9647800003333', 'مريض تجربة');

assert.strictEqual(result.ok, true);
assert.strictEqual(result.data.conversationState, 'WAITING_CONFIRMATION');
assert.ok(result.data.reply.indexOf('رقم الباص: 1') !== -1);
assert.ok(result.data.reply.indexOf('2026-09-06') !== -1);
assert.ok(result.data.reply.indexOf('02:57') === -1);
assert.ok(result.data.reply.indexOf('16:00') !== -1);

console.log('Live reserve canonical-time regression: 1/1 PASS');
