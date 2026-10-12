const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('Infrastructure/GoogleSheets.js', 'utf8');

function makeHarness(options = {}) {
  const headers = ['slot_id', 'status', 'is_available'];
  // Model the values visible through getValues(), separately from formulas.
  const rows = [
    ['SLOT-1', 'FREE', true],
    ['SLOT-10', 'FREE', true],
    ['slot-2', 'FREE', false],
    ['FORMULA-KEY', 'FREE', true],
    ['SLOT-1', 'CONFIRMED', false] // duplicate: preserve first-match semantics
  ];
  const formulas = new Map([[5, '=CONCAT("FORMULA","-KEY")']]);
  const calls = {
    ranges: [],
    valueReads: [],
    textFinderCalls: [],
    finderOptions: [],
    writes: []
  };

  function makeRange(row, col, numRows, numCols) {
    const rangeSpec = { row, col, numRows, numCols };
    calls.ranges.push(rangeSpec);
    return {
      getValues() {
        calls.valueReads.push(rangeSpec);
        if (row === 1) {
          return [headers.slice(col - 1, col - 1 + numCols)];
        }
        return rows.slice(row - 2, row - 2 + numRows)
          .map(r => r.slice(col - 1, col - 1 + numCols));
      },
      createTextFinder(searchValue) {
        if (options.textFinder === false) {
          throw new Error('createTextFinder should not be called when unavailable');
        }
        calls.textFinderCalls.push({ searchValue, rangeSpec });
        const finderOptions = {
          entireCell: false,
          caseSensitive: false,
          formulaText: true,
          regularExpression: true
        };
        const finder = {
          matchEntireCell(value) {
            finderOptions.entireCell = value;
            return finder;
          },
          matchCase(value) {
            finderOptions.caseSensitive = value;
            return finder;
          },
          matchFormulaText(value) {
            finderOptions.formulaText = value;
            return finder;
          },
          useRegularExpression(value) {
            finderOptions.regularExpression = value;
            return finder;
          },
          findNext() {
            calls.finderOptions.push({ ...finderOptions });
            const needle = String(searchValue);
            for (let offset = 0; offset < numRows; offset++) {
              const sheetRow = row + offset;
              const cellValue = rows[sheetRow - 2][col - 1];
              const formula = formulas.get(sheetRow);
              const searchable = finderOptions.formulaText && formula
                ? formula
                : String(cellValue);
              let matches;
              if (finderOptions.regularExpression) {
                matches = new RegExp(needle).test(searchable);
              } else {
                matches = searchable.includes(needle);
              }
              if (finderOptions.entireCell) matches = searchable === needle;
              if (!finderOptions.caseSensitive) {
                matches = finderOptions.entireCell
                  ? searchable.toLowerCase() === needle.toLowerCase()
                  : searchable.toLowerCase().includes(needle.toLowerCase());
              }
              if (matches) return { getRow: () => sheetRow };
            }
            return null;
          }
        };
        return finder;
      },
      setNumberFormat(format) {
        calls.writes.push({ type: 'format', row, col, format });
      },
      setValue(value) {
        rows[row - 2][col - 1] = value;
        calls.writes.push({ type: 'value', row, col, value });
      }
    };
  }

  const sheet = {
    getLastRow: () => rows.length + 1,
    getLastColumn: () => headers.length,
    getRange(row, col, numRows, numCols) {
      const range = makeRange(row, col, numRows || 1, numCols || 1);
      if (options.textFinder === false) {
        // Match an adapter/mock that has no createTextFinder method.
        delete range.createTextFinder;
      }
      return range;
    }
  };
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) },
    Result: { ok: data => ({ ok: true, data }) }
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\nthis.GoogleSheets = GoogleSheets;', sandbox);
  return { api: sandbox.GoogleSheets, rows, calls, headers, sheet };
}

{
  const { api, rows, calls } = makeHarness();

  const found = api.findRowByColumn('Availability', 'slot_id', 'SLOT-1');
  assert.equal(found.slot_id, 'SLOT-1');
  assert.equal(found._rowNumber, 2, 'duplicate keys must retain first-match behavior');
  assert.equal(calls.textFinderCalls.length, 1);
  assert.deepEqual(calls.finderOptions[0], {
    entireCell: true,
    caseSensitive: true,
    formulaText: false,
    regularExpression: false
  }, 'all TextFinder matching flags must be explicitly constrained');

  // The only values transferred for this lookup are the header and matched row;
  // the key column itself is searched in Sheets by TextFinder.
  assert.equal(
    calls.valueReads.some(r => r.col === 1 && r.numCols === 1 && r.row > 1),
    false,
    'string-key lookup must not transfer the key column'
  );

  const updated = api.updateRowByColumn(
    'Availability', 'slot_id', 'SLOT-10', { is_available: false }
  );
  assert.equal(updated, true);
  assert.equal(rows[1][2], false);
  assert.equal(calls.textFinderCalls.length, 2);
  assert.equal(
    calls.valueReads.some(r => r.col === 1 && r.numCols === 1 && r.row > 1),
    false,
    'string-key update must not transfer the key column'
  );

  assert.equal(api.findRowByColumn('Availability', 'slot_id', 'SLOT'), null,
    'partial key must not match');
  assert.equal(api.findRowByColumn('Availability', 'slot_id', 'SLOT-2'), null,
    'case mismatch must not match');
  assert.equal(api.findRowByColumn('Availability', 'slot_id', 'FORMULA'), null,
    'partial display-value match must not match');
  assert.equal(api.findRowByColumn('Availability', 'slot_id', '=CONCAT("FORMULA","-KEY")'), null,
    'formula text must not be searched when matchFormulaText(false) is specified');
  assert.equal(api.findRowByColumn('Availability', 'slot_id', 'FORMULA-KEY')._rowNumber, 5,
    'the displayed cell value should be searchable');

  const typed = api._findRowNumberByColumnValue(
    { getRange: (row, col, numRows, numCols) => makeHarness().sheet.getRange(row, col, numRows, numCols) },
    2, rows.length + 1, 1
  );
  assert.equal(typed, null, 'non-string keys must preserve strict typed comparison');
}

{
  const { api, calls } = makeHarness({ textFinder: false });
  assert.equal(api.findRowByColumn('Availability', 'slot_id', 'SLOT-10')._rowNumber, 3,
    'fallback scan must preserve correct row numbers');
  assert.equal(calls.textFinderCalls.length, 0);
  assert.equal(calls.valueReads.some(r => r.col === 1 && r.numCols === 1 && r.row > 1), true,
    'fallback path may read the key column when TextFinder is unavailable');
}

console.log('GoogleSheets exact point lookup tests passed.');
