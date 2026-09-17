/**
 * LogArchiveRepository
 *
 * Storage boundary for SYSTEM_LOG retention. It owns reading, idempotent
 * archival, exact snapshot verification, fresh reread deletion checks, and
 * deletion. Retention policy itself lives in RetentionService.
 *
 * Delete invariant:
 *   archive snapshot -> verify exact snapshot -> fresh reread -> exact-match -> delete
 */
const LogArchiveRepository = {

  ARCHIVE_SHEET_NAME: 'SYSTEM_LOG_ARCHIVE',

  findOlderThan: function(cutoffMs) {
    var sourceName = Config.VOCABULARY.SHEETS.SYSTEM_LOG;
    var rows;
    try {
      rows = GoogleSheets.getAllRows(sourceName);
    } catch (e) {
      return Result.fail('ARCHIVE_READ_FAILED', 'Failed to read SYSTEM_LOG', { message: e.message });
    }

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

  /**
   * Idempotent archive operation. Existing exact snapshots are accepted;
   * ambiguous duplicates block the operation and therefore block deletion.
   */
  archiveRecords: function(records) {
    if (!records || records.length === 0) return Result.ok({ appended: 0, verified: 0 });

    try {
      var sourceName = Config.VOCABULARY.SHEETS.SYSTEM_LOG;
      var sourceHeaders = GoogleSheets.getHeaders(sourceName);
      GoogleSheets.getOrCreateSheet(this.ARCHIVE_SHEET_NAME, sourceHeaders);
      var archiveHeaders = GoogleSheets.ensureHeaders(this.ARCHIVE_SHEET_NAME, sourceHeaders);
      var archiveRows = GoogleSheets.getAllRows(this.ARCHIVE_SHEET_NAME);

      var toAppend = [];
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        var matches = this._findExactMatches(archiveRows, record);
        if (matches.length > 1) {
          return Result.fail('ARCHIVE_IDENTITY_AMBIGUOUS',
            'More than one exact archive snapshot exists; delete blocked', {
              timestamp: record.timestamp,
              command: record.command,
              slotId: record.slotId
            });
        }
        if (matches.length === 0) {
          toAppend.push(archiveHeaders.map(function(header) {
            return record.hasOwnProperty(header) ? record[header] : '';
          }));
        }
      }

      if (toAppend.length > 0) {
        var appendResult = GoogleSheets.appendRows(this.ARCHIVE_SHEET_NAME, toAppend);
        if (!appendResult || !appendResult.ok) {
          return Result.fail('ARCHIVE_WRITE_FAILED', 'Failed to write SYSTEM_LOG archive', appendResult ? appendResult.error : null);
        }
      }

      var verifiedRows = GoogleSheets.getAllRows(this.ARCHIVE_SHEET_NAME);
      for (var r = 0; r < records.length; r++) {
        var verified = this._findExactMatches(verifiedRows, records[r]);
        if (verified.length !== 1) {
          return Result.fail('ARCHIVE_VERIFY_FAILED', 'SYSTEM_LOG archive verification failed', {
            matchCount: verified.length,
            timestamp: records[r].timestamp,
            command: records[r].command,
            slotId: records[r].slotId
          });
        }
      }

      return Result.ok({ appended: toAppend.length, verified: records.length });
    } catch (e) {
      return Result.fail('ARCHIVE_VERIFY_FAILED', 'SYSTEM_LOG archive operation failed before delete', { message: e.message });
    }
  },

  // Backward-compatible API used by older callers/tests.
  appendToArchive: function(records) {
    return this.archiveRecords(records);
  },

  /**
   * Fresh reread and exact identity validation before delete.
   */
  deleteRecords: function(records) {
    if (!records || records.length === 0) return Result.ok({ deleted: 0 });

    var sourceName = Config.VOCABULARY.SHEETS.SYSTEM_LOG;
    var currentRows;
    try {
      currentRows = GoogleSheets.getAllRows(sourceName);
    } catch (e) {
      return Result.fail('ARCHIVE_DELETE_REVALIDATION_FAILED',
        'Failed to reread SYSTEM_LOG before delete', { message: e.message });
    }

    var rowNumbers = [];
    for (var i = 0; i < records.length; i++) {
      var matches = this._findExactMatches(currentRows, records[i]);
      if (matches.length === 0) {
        return Result.fail('ARCHIVE_IDENTITY_NOT_FOUND',
          'No exact SYSTEM_LOG match for archived record; delete blocked');
      }
      if (matches.length > 1) {
        return Result.fail('ARCHIVE_IDENTITY_AMBIGUOUS',
          'More than one exact SYSTEM_LOG match for archived record; delete blocked');
      }
      rowNumbers.push(matches[0]._rowNumber);
    }

    var deleteResult;
    try {
      deleteResult = GoogleSheets.deleteRowsByNumbers(sourceName, rowNumbers);
    } catch (e2) {
      return Result.fail('ARCHIVE_DELETE_FAILED',
        'Failed to delete archived SYSTEM_LOG rows', { message: e2.message });
    }
    if (!deleteResult || !deleteResult.ok) {
      return Result.fail('ARCHIVE_DELETE_FAILED',
        'Failed to delete archived SYSTEM_LOG rows', deleteResult ? deleteResult.error : null);
    }

    try {
      var remaining = GoogleSheets.getAllRows(sourceName);
      for (var r = 0; r < records.length; r++) {
        if (this._findExactMatches(remaining, records[r]).length > 0) {
          return Result.fail('ARCHIVE_DELETE_VERIFY_FAILED',
            'SYSTEM_LOG archived snapshot remains after deletion');
        }
      }
    } catch (e3) {
      return Result.fail('ARCHIVE_DELETE_VERIFY_FAILED',
        'Could not verify SYSTEM_LOG deletion', { message: e3.message });
    }

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
    Object.keys(a || {}).forEach(function(k) {
      if (k !== '_rowNumber') keys[k] = true;
    });
    Object.keys(b || {}).forEach(function(k) {
      if (k !== '_rowNumber') keys[k] = true;
    });

    for (var key in keys) {
      if (this._value(a[key]) !== this._value(b[key])) return false;
    }
    return true;
  },

  _value: function(v) {
    if (v instanceof Date) return 'D:' + v.getTime();
    if (v === undefined || v === null) return '';
    return String(v);
  }
};
