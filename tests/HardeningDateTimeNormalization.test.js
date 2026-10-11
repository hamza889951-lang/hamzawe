'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'Utils', 'DateUtils.js'),
  'utf8'
);
const sandbox = vm.createContext({ Intl: Intl });
sandbox.Utilities = {
  formatDate: function(value, timeZone, pattern) {
    const options = pattern === 'yyyy-MM-dd'
      ? { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }
      : { timeZone: timeZone, hour: '2-digit', minute: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(value)
      .reduce(function(out, part) {
        out[part.type] = part.value;
        return out;
      }, {});
    return pattern === 'yyyy-MM-dd'
      ? parts.year + '-' + parts.month + '-' + parts.day
      : parts.hour + ':' + parts.minute;
  }
};
vm.runInContext(source + '\nthis.DateUtils = DateUtils;', sandbox, {
  filename: 'Utils/DateUtils.js'
});
const D = sandbox.DateUtils;

(function normalizesKnownLegacyAndCanonicalDateShapes() {
  assert.strictEqual(D.normalizeDate('2026-09-02'), '2026-09-02');
  assert.strictEqual(D.normalizeDate('2026/09/02'), '2026-09-02');
  assert.strictEqual(D.normalizeDate('2026-02-29'), null);
  assert.strictEqual(D.normalizeDate('09/02/2026'), null);
  assert.strictEqual(D.formatDateForStorage('2026-09-02'), '2026/09/02');
}());

(function normalizesTimeWithoutLocaleGuessing() {
  assert.strictEqual(D.normalizeTime('09:05'), '09:05');
  assert.strictEqual(D.normalizeTime('9:05'), '09:05');
  assert.strictEqual(D.normalizeTime('09:05:59'), null);
  assert.strictEqual(D.normalizeTime('24:00'), null);
  assert.strictEqual(D.normalizeTime('9:05 AM'), null);
  assert.strictEqual(D.formatTimeForStorage('16:30'), '16:30');
}());

(function normalizesLocalWallClockStamps() {
  assert.strictEqual(D.normalizeLocalDateTime('2026-09-02T09:05'), '2026-09-02T09:05');
  assert.strictEqual(D.normalizeLocalDateTime('2026-09-02 9:05'), '2026-09-02T09:05');
  assert.strictEqual(D.normalizeLocalDateTime('2026/09/02 09:05'), '2026-09-02T09:05');
  assert.strictEqual(D.normalizeLocalDateTime('2026/09/02 09:05:59'), null);
  assert.strictEqual(D.normalizeLocalDateTime('2026-02-29T09:05'), null);
  assert.strictEqual(D.normalizeLocalDateTime('2026-09-02T25:05'), null);
  assert.strictEqual(D.formatLocalStamp('2026/09/02 09:05'), '2026-09-02T09:05');
}());

(function normalizesDateObjectsInExplicitClinicTimezone() {
  const date = new Date('2026-09-05T23:57:00.000Z');
  assert.strictEqual(D.formatDateDisplay(date), '2026-09-06');
  assert.strictEqual(D.formatTimeDisplay(date), '02:57');
  assert.strictEqual(D.formatSortKey(date), '202609060257');
}());

(function invalidDisplayValuesFailClosedInsteadOfThrowing() {
  assert.strictEqual(D.formatDateDisplay('not a date'), '');
  assert.strictEqual(D.formatTimeDisplay('not a time'), '');
  assert.strictEqual(D.formatLocalStamp('not a timestamp'), '');
}());

console.log('Canonical date/time normalization: 5/5 PASS');
