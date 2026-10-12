const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('Infrastructure/GoogleSheets.js', 'utf8');
const headers = ['slot_id', 'status', 'is_available'];
const rows = [
  ['SLOT-1', 'FREE', true],
  ['SLOT-10', 'FREE', true],
  ['slot-2', 'FREE', false]
];
const calls = { columnReads: 0, textFinderCalls: 0, writes: [] };

function makeRange(row, col, numRows, numCols) {
  return {
    getValues() {
      if (row === 1) return [headers.slice(0, numCols)];
      if (numCols === 1 && row === 2) calls.columnReads++;
      return rows.slice(row - 2, row - 2 + numRows).map(r => r.slice(col - 1, col - 1 + numCols));
    },
    createTextFinder(value) {
      calls.textFinderCalls++;
      const options = { entire: false, caseSensitive: false, regex: true };
      const finder = {
        matchEntireCell(v) { options.entire = v; return finder; },
        matchCase(v) { options.caseSensitive = v; return finder; },
        matchFormulaText() { return finder; },
        useRegularExpression(v) { options.regex = v; return finder; },
        findNext() {
          for (let i = 0; i < rows.length; i++) {
            const cell = String(rows[i][col - 1]);
            const matches = options.entire
              ? cell === value
              : cell.indexOf(value) !== -1;
            if (matches && (!options.caseSensitive || cell === value)) {
              return { getRow: () => i + 2 };
            }
          }
          return null;
        }
      };
      return finder;
    },
    setNumberFormat() {},
    setValue(value) {
      rows[row - 2][col - 1] = value;
      calls.writes.push({ row, col, value });
    }
  };
}

const sheet = {
  getLastRow: () => rows.length + 1,
  getLastColumn: () => headers.length,
  getRange: (row, col, numRows, numCols) => makeRange(row, col, numRows || 1, numCols || 1)
};
const sandbox = {
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) },
  Result: { ok: data => ({ ok: true, data }) }
};
vm.createContext(sandbox);
vm.runInContext(source + '\nthis.GoogleSheets = GoogleSheets;', sandbox);

const found = sandbox.GoogleSheets.findRowByColumn('Availability', 'slot_id', 'SLOT-1');
assert.equal(found.slot_id, 'SLOT-1');
assert.equal(found._rowNumber, 2);
assert.equal(calls.columnReads, 0, 'string-key lookup must not transfer the full key column');
assert.equal(calls.textFinderCalls, 1);

const updated = sandbox.GoogleSheets.updateRowByColumn(
  'Availability', 'slot_id', 'SLOT-10', { is_available: false }
);
assert.equal(updated, true);
assert.equal(rows[1][2], false);
assert.equal(calls.columnReads, 0, 'string-key update lookup must not transfer the full key column');
assert.equal(calls.textFinderCalls, 2);

assert.equal(
  sandbox.GoogleSheets.findRowByColumn('Availability', 'slot_id', 'SLOT'),
  null,
  'partial matches must not match a slot ID'
);
assert.equal(
  sandbox.GoogleSheets.findRowByColumn('Availability', 'slot_id', 'SLOT-2'),
  null,
  'string-key matching must preserve case-sensitive exact-match semantics'
);

const typed = sandbox.GoogleSheets._findRowNumberByColumnValue(sheet, 2, rows.length + 1, 1);
assert.equal(typed, null, 'non-string keys must preserve strict typed comparison');
console.log('GoogleSheets exact point lookup tests passed.');
