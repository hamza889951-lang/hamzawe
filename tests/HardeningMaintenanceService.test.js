'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function createHarness() {
  const state = {
    nowIso: '2026-10-12T08:00:00.000Z',
    queryResult: { ok: true, data: [] },
    cleanupResult: { ok: true, data: { status: 'SKIPPED_STATE' } },
    updateBatchResult: { ok: true, data: { updated: 0 } },
    updateBatchCalls: 0,
    logs: []
  };
  const sandbox = vm.createContext({ console: console });
  sandbox.Result = {
    ok: function(data) { return { ok: true, data: data === undefined ? null : data, error: null }; },
    fail: function(code, message, details) {
      return { ok: false, data: null, error: { code: code, message: message, details: details || null } };
    }
  };
  sandbox.Clock = { now: function() { return new Date(state.nowIso); } };
  sandbox.Config = { VOCABULARY: { STATUS: { RESERVED: 'RESERVED', FREE: 'FREE', EXPIRED: 'EXPIRED' }, SHEETS: { AVAILABILITY: 'Availability' } } };
  sandbox.LegacySlotTimeParser = { toComparableTime: function(value) { return value === 'valid-past' ? 1 : null; } };
  sandbox.SlotRepository = {
    queryResult: function() { return state.queryResult; },
    cleanupExpiredReservation: function() { return state.cleanupResult; }
  };
  sandbox.GoogleSheets = {
    updateBatch: function() { state.updateBatchCalls++; return state.updateBatchResult; }
  };
  sandbox.LogRepository = { write: function(entry) { state.logs.push(entry); } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'Application/MaintenanceService.js'), 'utf8');
  vm.runInContext(source + '\nthis.MaintenanceService = MaintenanceService;', sandbox, { filename: 'Application/MaintenanceService.js' });
  return { sandbox: sandbox, state: state };
}

test('Maintenance cleanup fails closed when candidate query fails', function() {
  const h = createHarness();
  h.state.queryResult = { ok: false, error: { code: 'AVAILABILITY_QUERY_FAILED' } };
  const result = h.sandbox.MaintenanceService.runCleanup();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'MAINTENANCE_CLEANUP_QUERY_FAILED');
});

test('Maintenance expiration fails closed when candidate query fails', function() {
  const h = createHarness();
  h.state.queryResult = { ok: false, error: { code: 'AVAILABILITY_QUERY_FAILED' } };
  const result = h.sandbox.MaintenanceService.runExpiration();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'MAINTENANCE_EXPIRATION_QUERY_FAILED');
  assert.strictEqual(h.state.updateBatchCalls, 0, 'no expiration write is allowed after a failed read');
});

test('Maintenance aggregate exposes query failures instead of reporting success', function() {
  const h = createHarness();
  h.state.queryResult = { ok: false, error: { code: 'AVAILABILITY_QUERY_FAILED' } };
  const result = h.sandbox.MaintenanceService.run();
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'MAINTENANCE_PARTIAL_FAILURE');
  assert.strictEqual(result.error.details.cleanupOk, false);
  assert.strictEqual(result.error.details.expirationOk, false);
  assert.ok(h.state.logs.some(entry => entry.command === 'MAINTENANCE_RUN' && entry.success === false));
});

test('Maintenance keeps normal empty-query behavior', function() {
  const h = createHarness();
  const result = h.sandbox.MaintenanceService.run();
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.data)), { cleaned: 0, expired: 0 });
  assert.strictEqual(h.state.updateBatchCalls, 0);
});

let failures = 0;
tests.forEach(function(entry) {
  try { entry.fn(); console.log('PASS:', entry.name); }
  catch (error) { failures++; console.error('FAIL:', entry.name); console.error(error.stack || error.message); }
});
if (failures > 0) process.exit(1);
console.log('\\n' + (tests.length - failures) + '/' + tests.length + ' tests passed');
