const GoogleSheets = {
  _openSpreadsheet: function() {
    var sheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    return sheetId
      ? SpreadsheetApp.openById(sheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
  },

  _getSheet: function(sheetName) {
    var sheet = this._openSpreadsheet().getSheetByName(sheetName);
    if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + sheetName);
    return sheet;
  },

  getOrCreateSheet: function(sheetName, headers) {
    var spreadsheet = this._openSpreadsheet();
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (sheet) return sheet;

    sheet = spreadsheet.insertSheet(sheetName);
    if (headers && headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    return sheet;
  },

  /**
   * Ensure an archive sheet contains every source header while preserving
   * existing archive-only columns. New source columns are appended at the
   * end so historical snapshots remain column-compatible and lossless.
   */
  ensureHeaders: function(sheetName, requiredHeaders) {
    if (!requiredHeaders || requiredHeaders.length === 0) {
      return this.getHeaders(sheetName);
    }

    var spreadsheet = this._openSpreadsheet();
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      this.getOrCreateSheet(sheetName, requiredHeaders);
      return requiredHeaders.slice();
    }

    var values = sheet.getDataRange().getValues();
    var existing = values.length ? values[0].slice() : [];
    var merged = existing.slice();

    for (var i = 0; i < requiredHeaders.length; i++) {
      var header = requiredHeaders[i];
      if (merged.indexOf(header) === -1) merged.push(header);
    }

    if (merged.length > sheet.getMaxColumns()) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), merged.length - sheet.getMaxColumns());
    }

    var changed = merged.length !== existing.length;
    if (!changed) {
      for (var j = 0; j < merged.length; j++) {
        if (merged[j] !== existing[j]) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      sheet.getRange(1, 1, 1, merged.length).setValues([merged]);
    }

    return merged;
  },

  _rowToObject: function(headers, row, rowNumber) {
    var obj = { _rowNumber: rowNumber };
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  },

  /** Return true when a sheet contains at least one data row. */
  hasDataRows: function(sheetName) {
    var sheet = this._getSheet(sheetName);
    return sheet.getLastRow() >= 2;
  },

  /**
   * Read one fresh row without loading the entire sheet data range.
   * This is intentionally a point-read path for atomic/fresh-read callers.
   */
  findRowByColumn: function(sheetName, columnName, value) {
    var sheet = this._getSheet(sheetName);
    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) return null;

    var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var columnIndex = headers.indexOf(columnName);
    if (columnIndex === -1) throw new Error('COLUMN_NOT_FOUND: ' + columnName);

    var rowNumber = this._findRowNumberByColumnValue(
      sheet, columnIndex + 1, lastRow, value
    );
    if (rowNumber === null) return null;

    var rowValues = sheet.getRange(rowNumber, 1, 1, lastColumn).getValues()[0];
    return this._rowToObject(headers, rowValues, rowNumber);
  },

  /**
   * Locate a row by an exact key match. TextFinder performs the search inside
   * Sheets instead of transferring the entire key column to Apps Script on
   * every atomic update. Keep strict value semantics for non-string keys,
   * which use the original typed scan.
   */
  _findRowNumberByColumnValue: function(sheet, columnNumber, lastRow, value) {
    var keyRange = sheet.getRange(2, columnNumber, lastRow - 1, 1);
    if (typeof value === 'string' && typeof keyRange.createTextFinder === 'function') {
      var match = keyRange.createTextFinder(value)
        .matchEntireCell(true)
        .matchCase(true)
        .matchFormulaText(false)
        .useRegularExpression(false)
        .findNext();
      return match ? match.getRow() : null;
    }

    // Retain compatibility with lightweight infrastructure mocks and any
    // alternate Spreadsheet adapter that does not implement TextFinder.
    var values = keyRange.getValues();
    for (var i = 0; i < values.length; i++) {
      if (values[i][0] === value) return i + 2;
    }
    return null;
  },

  queryRows: function(sheetName, predicateFn) {
    var sheet = this._getSheet(sheetName);
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    var headers = data[0];
    var results = [];
    for (var i = 1; i < data.length; i++) {
      var obj = this._rowToObject(headers, data[i], i + 1);
      if (predicateFn(obj)) results.push(obj);
    }
    return results;
  },

  getAllRows: function(sheetName) {
    return this.queryRows(sheetName, function() { return true; });
  },

  /**
   * Update one fresh row located by a point lookup rather than rereading the
   * entire sheet. First-match semantics are preserved.
   */
  updateRowByColumn: function(sheetName, columnName, value, fields) {
    var sheet = this._getSheet(sheetName);
    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) return false;

    var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var columnIndex = headers.indexOf(columnName);
    if (columnIndex === -1) throw new Error('COLUMN_NOT_FOUND: ' + columnName);

    var rowNumber = this._findRowNumberByColumnValue(
      sheet, columnIndex + 1, lastRow, value
    );
    if (rowNumber === null) return false;

    Object.keys(fields).forEach(function(key) {
      var fieldColIndex = headers.indexOf(key);
      if (fieldColIndex !== -1) {
        var cell = sheet.getRange(rowNumber, fieldColIndex + 1);
        // Preserve string storage values; Sheets otherwise may coerce ISO-like
        // strings into Date values, changing their representation on readback.
        if (typeof fields[key] === 'string') {
          cell.setNumberFormat('@');
        }
        cell.setValue(fields[key]);
      }
    });
    return true;
  },

  /**
   * Update only named fields in the first data row of a single-row settings
   * sheet. Requires every requested column to exist; never changes headers
   * or unrelated cells. Caller must hold the script-wide lock.
   */
  updateFirstDataRowFields: function(sheetName, fields) {
    var sheet = this._getSheet(sheetName);
    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 2 || lastColumn < 1) throw new Error('SETTINGS_NOT_CONFIGURED');
    var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var keys = Object.keys(fields || {});
    if (!keys.length) return { updated: 0 };
    var rowRange = sheet.getRange(2, 1, 1, lastColumn);
    var values = rowRange.getValues()[0];
    var formulas = typeof rowRange.getFormulas === 'function' ? rowRange.getFormulas()[0] : [];
    // Preserve formulas in unrelated Settings cells while preparing a single
    // row write, so a failure cannot leave only some schedule cells updated.
    for (var f = 0; f < formulas.length; f++) {
      if (formulas[f]) values[f] = formulas[f];
    }
    var indexes = [];
    for (var i = 0; i < keys.length; i++) {
      var index = headers.indexOf(keys[i]);
      if (index < 0) throw new Error('SETTINGS_COLUMN_NOT_FOUND: ' + keys[i]);
      indexes.push(index);
      values[index] = fields[keys[i]];
    }
    // Keep only the intended schedule cells as literal text. Formatting is
    // set before the one-row write; unrelated cells retain their formats.
    for (var j = 0; j < keys.length; j++) {
      if (typeof fields[keys[j]] === 'string') sheet.getRange(2, indexes[j] + 1).setNumberFormat('@');
    }
    rowRange.setValues([values]);
    return { updated: keys.length };
  },

  appendRow: function(sheetName, rowObject) {
    var sheet = this._getSheet(sheetName);
    var headers = sheet.getDataRange().getValues()[0];

    var row = headers.map(function(header) {
      return rowObject.hasOwnProperty(header)
        ? rowObject[header]
        : '';
    });

    var nextRow = sheet.getLastRow() + 1;

    // Set text format before writing so ISO-like string values remain strings.
    row.forEach(function(value, index) {
      if (typeof value === 'string') {
        sheet.getRange(nextRow, index + 1).setNumberFormat('@');
      }
    });

    sheet
      .getRange(nextRow, 1, 1, row.length)
      .setValues([row]);
  }
};

GoogleSheets.updateBatch = function(sheetName, updates) {
  if (!updates || updates.length === 0) return Result.ok({ updated: 0 });

  var sheet = GoogleSheets._getSheet(sheetName);
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  var rowsToUpdate = [];
  var rowIndices = [];

  for (var u = 0; u < updates.length; u++) {
    var update = updates[u];
    var colIndex = headers.indexOf(update.columnName);
    if (colIndex === -1) continue;
    for (var i = 1; i < data.length; i++) {
      if (data[i][colIndex] === update.value) {
        var row = data[i].slice();
        Object.keys(update.fields).forEach(function(key) {
          var fieldColIndex = headers.indexOf(key);
          if (fieldColIndex !== -1) {
            row[fieldColIndex] = update.fields[key];
          }
        });
        rowsToUpdate.push(row);
        rowIndices.push(i);
        break;
      }
    }
  }

  if (rowsToUpdate.length === 0) return Result.ok({ updated: 0 });

  for (var j = 0; j < rowsToUpdate.length; j++) {
    sheet.getRange(rowIndices[j] + 1, 1, 1, rowsToUpdate[j].length).setValues([rowsToUpdate[j]]);
  }

  return Result.ok({ updated: rowsToUpdate.length });
};

GoogleSheets.getHeaders = function(sheetName) {
  var sheet = GoogleSheets._getSheet(sheetName);
  return sheet.getDataRange().getValues()[0];
};

GoogleSheets.appendRows = function(sheetName, rows) {
  var sheet = GoogleSheets._getSheet(sheetName);
  if (!rows || rows.length === 0) return Result.ok({ inserted: 0 });

  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);

  return Result.ok({ inserted: rows.length });
};

GoogleSheets.deleteRowsByNumbers = function(sheetName, rowNumbers) {
  var sheet = GoogleSheets._getSheet(sheetName);
  if (!rowNumbers || rowNumbers.length === 0) return Result.ok({ deleted: 0 });

  var sorted = rowNumbers.slice().sort(function(a, b) { return a - b; });

  var ranges = [];
  var i = 0;
  while (i < sorted.length) {
    var start = sorted[i];
    var count = 1;
    while (i + 1 < sorted.length && sorted[i + 1] === start + count) {
      count++;
      i++;
    }
    ranges.push({ start: start, count: count });
    i++;
  }

  for (var r = ranges.length - 1; r >= 0; r--) {
    sheet.deleteRows(ranges[r].start, ranges[r].count);
  }

  return Result.ok({ deleted: sorted.length });
};
