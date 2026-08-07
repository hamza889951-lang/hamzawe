const GoogleSheets = {
  _getSheet: function(sheetName) {
    var sheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    var spreadsheet = sheetId
      ? SpreadsheetApp.openById(sheetId)
      : SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) throw new Error('SHEET_NOT_FOUND: ' + sheetName);
    return sheet;
  },

  _rowToObject: function(headers, row, rowNumber) {
    var obj = { _rowNumber: rowNumber };
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  },

  findRowByColumn: function(sheetName, columnName, value) {
    var rows = this.queryRows(sheetName, function(row) {
      return row[columnName] === value;
    });
    return rows.length ? rows[0] : null;
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

  updateRowByColumn: function(sheetName, columnName, value, fields) {
    var sheet = this._getSheet(sheetName);
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var colIndex = headers.indexOf(columnName);
    if (colIndex === -1) throw new Error('COLUMN_NOT_FOUND: ' + columnName);
    for (var i = 1; i < data.length; i++) {
      if (data[i][colIndex] === value) {
        Object.keys(fields).forEach(function(key) {
          var fieldColIndex = headers.indexOf(key);
          if (fieldColIndex !== -1) {
            sheet.getRange(i + 1, fieldColIndex + 1).setValue(fields[key]);
          }
        });
        return true;
      }
    }
    return false;
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

    sheet
      .getRange(nextRow, 1, 1, row.length)
      .setValues([row]);
  }
};

GoogleSheets.updateBatch = function(sheetName, updates) {
  if (!updates || updates.length === 0) return Result.ok({ updated: 0 });

  var sheet = this._getSheet(sheetName);
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
  var sheet = this._getSheet(sheetName);
  return sheet.getDataRange().getValues()[0];
};

GoogleSheets.appendRows = function(sheetName, rows) {
  var sheet = this._getSheet(sheetName);
  if (!rows || rows.length === 0) return Result.ok({ inserted: 0 });

  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);

  return Result.ok({ inserted: rows.length });
};
