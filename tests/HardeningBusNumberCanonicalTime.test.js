'use strict';

/**
 * Regression for the live BUS_CALC_ERROR:
 * Google Sheets may expose Availability.time as a Date/time-only value whose
 * rendered clinic hour is not the operational appointment time. The existing
 * selection policy already treats sort_key as the canonical appointment-time
 * representation, so BusNumberCalculator.fromSlot() must use it when present.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function load(src, sandbox, filename) {
  vm.runInContext(src + '\nthis.BusNumberCalculator = BusNumberCalculator;', sandbox, { filename: filename });
}

function makeSandbox() {
  const sandbox = vm.createContext({ Intl: Intl, console: console });
  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sandbox.Utilities = {
    formatDate: function(date, tz, fmt) {
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
  return sandbox;
}

const source = fs.readFileSync(path.join(ROOT, 'BusNumberCalculator.js'), 'utf8');

(function testCanonicalSortKeyWinsOverBadTimeDate() {
  const sandbox = makeSandbox();
  load(source, sandbox, 'BusNumberCalculator.js');

  // Simulates the live shape: time renders as 02:57 in clinic timezone,
  // while sort_key says the actual appointment is 2026-09-06 16:00.
  const result = sandbox.BusNumberCalculator.fromSlot({
    time: new Date('2026-09-05T23:57:00.000Z'),
    sort_key: '202609061600'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.busNumber, 1);
}());

(function testCanonicalSortKeyDrivesSecondBus() {
  const sandbox = makeSandbox();
  load(source, sandbox, 'BusNumberCalculator.js');

  const result = sandbox.BusNumberCalculator.fromSlot({
    time: new Date('2026-09-05T23:57:00.000Z'),
    sort_key: '202609061615'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.busNumber, 2);
}());

(function testMissingSortKeyPreservesLegacyTimeFallback() {
  const sandbox = makeSandbox();
  load(source, sandbox, 'BusNumberCalculator.js');

  const result = sandbox.BusNumberCalculator.fromSlot({
    time: '16:30'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.busNumber, 3);
}());

console.log('Canonical bus-time tests: 3/3 PASS');
