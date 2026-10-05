'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'Infrastructure', 'GoogleSheets.js'),
  'utf8'
);

function createHarness() {
  const cells = {};
  const rows = [
    ['phone', 'doctor_draft_effective_from', 'doctor_draft_effective_to', 'state'],
    ['9647824134670', '', '', 'DOCTOR_AWAITING_INPUT']
  ];

  function key(row, col) { return row + ':' + col; }

  function getCell(row, col) {
    const k = key(row, col);
    if (!cells[k]) cells[k] = { value: rows[row - 1] ? rows[row - 1][col - 1] : '', format: 'AUTO' };
    return cells[k];
  }

  function range(row, col, numRows, numCols) {
    return {
      getValues: function() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(getCell(row + r, col + c).value);
          out.push(line);
        }
        return out;
      },
      setNumberFormat: function(format) {
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) getCell(row + r, col + c).format = format;
        }
        return this;
      },
      setValue: function(value) {
        const cell = getCell(row, col);
        cell.value = cell.format === '@' ? value : coerce(value);
        return this;
      },
      setValues: function(values) {
        for (let r = 0; r < values.length; r++) {
          for (let c = 0; c < values[r].length; c++) {
            const cell = getCell(row + r, col + c);
            cell.value = cell.format === '@' ? values[r][c] : coerce(values[r][c]);
          }
        }
        return this;
      }
    };
  }

  function coerce(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      return new Date(value + ':00Z');
    }
    return value;
  }

  const sheet = {
    getLastRow: function() { return 2; },
    getLastColumn: function() { return 4; },
    getRange: range,
    getDataRange: function() { return range(1, 1, 2, 4); }
  };

  const sandbox = vm.createContext({
    console: console,
    Result: { ok: function(data) { return { ok: true, data: data }; } },
    PropertiesService: {
      getScriptProperties: function() {
        return { getProperty: function() { return null; } };
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: function() {
        return { getSheetByName: function() { return sheet; } };
      }
    }
  });

  vm.runInContext(source + '\nthis.GoogleSheets = GoogleSheets;', sandbox, {
    filename: 'Infrastructure/GoogleSheets.js'
  });

  return { api: sandbox.GoogleSheets, cells: cells };
}

(function testUpdatePreservesIsoText() {
  const h = createHarness();
  const ok = h.api.updateRowByColumn(
    'Conversations',
    'phone',
    '9647824134670',
    {
      doctor_draft_effective_from: '2026-10-06T00:00',
      doctor_draft_effective_to: '2026-10-07T00:00'
    }
  );
  assert.strictEqual(ok, true);
  assert.strictEqual(h.cells['2:2'].value, '2026-10-06T00:00');
  assert.strictEqual(typeof h.cells['2:2'].value, 'string');
  assert.strictEqual(h.cells['2:3'].value, '2026-10-07T00:00');
  assert.strictEqual(typeof h.cells['2:3'].value, 'string');
})();

console.log('HardeningGoogleSheetsStringPersistence: PASS');
