'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('Repositories/SchedulePromotionLedgerRepository.js', 'utf8');
const HEADERS = ['eventId','changeId','doctorId','clinicId','effectiveFrom','state','beforeFingerprint','targetFingerprint','eventAt','detailJson'];

function makeSheet(headers, rows = []) {
  return {
    headers: headers.slice(),
    rows: rows.slice(),
    getLastColumn() { return this.headers.length; },
    getRange(row, col, numRows, numCols) {
      assert.equal(row, 1);
      assert.equal(col, 1);
      return { getValues: () => [this.headers.slice(0, numCols)] };
    }
  };
}
function load(headers = HEADERS, rows = []) {
  const sheet = makeSheet(headers, rows);
  const context = {
    Result: {
      ok: data => ({ ok: true, data }),
      fail: (code, message, details) => ({ ok: false, error: { code, message, details } })
    },
    Clock: { now: () => new Date('2026-10-23T05:00:00.000Z') },
    IdGenerator: { generateScheduleChangeId: () => 'SCH_TEST' },
    GoogleSheets: {
      getOrCreateSheet: (name, requestedHeaders) => {
        assert.equal(name, 'SchedulePromotionLedger');
        if (!sheet.headers.length) sheet.headers = requestedHeaders.slice();
        return sheet;
      },
      queryRows: (name, predicate) => {
        assert.equal(name, 'SchedulePromotionLedger');
        return sheet.rows.filter(predicate);
      },
      appendRow: (name, row) => { sheet.rows.push(row); }
    }
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.repo = SchedulePromotionLedgerRepository;', context);
  return { repo: context.repo, sheet };
}

// A new ledger is initialized with the canonical schema and can be read.
{
  const env = load([]);
  const result = env.repo.listByScopeResult('doctor-1', null);
  assert.equal(result.ok, true);
  assert.deepEqual(env.sheet.headers, HEADERS);
}

// Existing compatible ledger is readable.
{
  const env = load(HEADERS, [{
    eventId: 'e1', changeId: 'c1', doctorId: 'doctor-1', clinicId: '',
    effectiveFrom: '2026-10-23T00:00', state: 'COMPLETED',
    beforeFingerprint: 'before', targetFingerprint: 'target',
    eventAt: '2026-10-23T05:00:00.000Z', detailJson: '{"verified":true}'
  }]);
  const result = env.repo.listByScopeResult('doctor-1', null);
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].state, 'COMPLETED');
  assert.deepEqual(result.data[0].detail, { verified: true });
}

// An incompatible existing schema fails closed; it is not silently rewritten.
{
  const env = load(['changeId','state','effectiveFrom']);
  const result = env.repo.listByScopeResult('doctor-1', null);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SCHEDULE_PROMOTION_LEDGER_READ_FAILED');
  assert.deepEqual(env.sheet.headers, ['changeId','state','effectiveFrom']);
}

console.log('SchedulePromotionLedgerRepository tests: PASS (3 scenarios)');
