/**
 * LogArchiveRepository
 * مسؤول عن كل تفاصيل التخزين المتعلقة بأرشفة SYSTEM_LOG:
 * قراءة السجلات القديمة، النسخ إلى ورقة الأرشيف، التحقق، ثم الحذف.
 *
 * لا يعرف سياسة الاحتفاظ (Retention) ولا أي منطق أعمال — فقط التخزين.
 * لا يظهر SpreadsheetApp أو أسماء الأوراق أو أرقام الصفوف خارج هذا الملف.
 *
 * قاعدة أمان الهوية عند الحذف:
 *   - تطابق واحد بالضبط (بالمحتوى الكامل) → مرشح صالح للحذف.
 *   - لا يوجد تطابق → Result.fail ولا حذف.
 *   - أكثر من تطابق → Result.fail ولا حذف (لا تخمين بأرقام الصفوف).
 */
const LogArchiveRepository = {

  ARCHIVE_SHEET_NAME: 'SYSTEM_LOG_ARCHIVE',

  findOlderThan: function(cutoffMs) {
    var sourceName = Config.VOCABULARY.SHEETS.SYSTEM_LOG;
    var rows = GoogleSheets.getAllRows(sourceName);

    var records = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var ts = row.timestamp;
      if (!ts) continue;
      var rowMs = (typeof ts === 'object') ? ts.getTime() : new Date(ts).getTime();
      if (isNaN(rowMs)) continue;
      if (rowMs < cutoffMs) records.push(this._toRecord(row));
    }

    return Result.ok({ records: records, totalCount: rows.length });
  },

  appendToArchive: function(records) {
    if (!records || records.length === 0) return Result.ok({ appended: 0 });

    var sourceName = Config.VOCABULARY.SHEETS.SYSTEM_LOG;
    var headers = GoogleSheets.getHeaders(sourceName);

    try {
      GoogleSheets.getOrCreateSheet(this.ARCHIVE_SHEET_NAME, headers);
    } catch (e) {
      return Result.fail('ARCHIVE_SHEET_FAILED', 'Cannot create or access SYSTEM_LOG_ARCHIVE', e.message);
    }

    var rows = records.map(function(record) {
      return headers.map(function(header) {
        return record.hasOwnProperty(header) ? record[header] : '';
      });
    });

    var appendResult = GoogleSheets.appendRows(this.ARCHIVE_SHEET_NAME, rows);
    if (!appendResult.ok) return Result.fail('ARCHIVE_WRITE_FAILED', 'Failed to write to archive', appendResult.error);

    var verifyResult = this._verifyAppended(rows);
    if (!verifyResult.ok) return verifyResult;

    return Result.ok({ appended: rows.length });
  },

  deleteRecords: function(records) {
    if (!records || records.length === 0) return Result.ok({ deleted: 0 });

    var sourceName = Config.VOCABULARY.SHEETS.SYSTEM_LOG;
    var currentRows = GoogleSheets.getAllRows(sourceName);

    var rowNumbers = [];
    for (var i = 0; i < records.length; i++) {
      var matches = this._findExactMatches(currentRows, records[i]);
      if (matches.length === 0) {
        return Result.fail('ARCHIVE_IDENTITY_NOT_FOUND', 'No exact match for archived record; delete blocked');
      }
      if (matches.length > 1) {
        return Result.fail('ARCHIVE_IDENTITY_AMBIGUOUS', 'More than one exact match for archived record; delete blocked');
      }
      rowNumbers.push(matches[0]._rowNumber);
    }

    var deleteResult = GoogleSheets.deleteRowsByNumbers(sourceName, rowNumbers);
    if (!deleteResult.ok) return Result.fail('ARCHIVE_DELETE_FAILED', 'Failed to delete archived rows', deleteResult.error);

    return Result.ok({ deleted: rowNumbers.length });
  },

  _toRecord: function(row) {
    var record = {};
    Object.keys(row).forEach(function(key) {
      if (key !== '_rowNumber') record[key] = row[key];
    });
    return record;
  },

  _findExactMatches: function(rows, record) {
    var matches = [];
    for (var i = 0; i < rows.length; i++) {
      if (this._recordsEqual(rows[i], record)) matches.push(rows[i]);
    }
    return matches;
  },

  _recordsEqual: function(a, b) {
    var keys = {};
    Object.keys(a).forEach(function(k) { keys[k] = true; });
    Object.keys(b).forEach(function(k) { keys[k] = true; });

    for (var key in keys) {
      if (key === '_rowNumber') continue;
      if (this._value(a[key]) !== this._value(b[key])) return false;
    }
    return true;
  },

  _value: function(v) {
    if (v instanceof Date) return 'D:' + v.getTime();
    if (v === undefined || v === null) return '';
    return v;
  },

  _verifyAppended: function(rows) {
    var appended = GoogleSheets.getAllRows(this.ARCHIVE_SHEET_NAME);
    if (appended.length < rows.length) {
      return Result.fail('ARCHIVE_VERIFY_COUNT', 'Verification read back fewer rows than written');
    }

    var start = appended.length - rows.length;
    var headers = GoogleSheets.getHeaders(this.ARCHIVE_SHEET_NAME);

    for (var r = 0; r < rows.length; r++) {
      for (var h = 0; h < headers.length; h++) {
        var header = headers[h];
        if (this._value(appended[start + r][header]) !== this._value(rows[r][h])) {
          return Result.fail('ARCHIVE_VERIFY_MISMATCH', 'Appended row content differs at row ' + (start + r + 1) + ' column ' + header);
        }
      }
    }

    return Result.ok(true);
  }
};
