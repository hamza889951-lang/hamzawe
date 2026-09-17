/**
 * AvailabilityArchiveRepository
 *
 * Storage boundary for historical Availability retention.
 * Policy lives in RetentionService; this repository owns reads, archive
 * verification, fresh-read deletion checks, and archive identity.
 *
 * Safety invariant:
 *   archive snapshot -> verify exact snapshot -> fresh-read -> revalidate -> delete
 */
const AvailabilityArchiveRepository = {

  ARCHIVE_SHEET_NAME: 'Availability_ARCHIVE',
  SOURCE_SHEET_NAME: 'Availability',

  findOlderThan: function(cutoffDate) {
    var rows;
    try {
      rows = GoogleSheets.getAllRows(this.SOURCE_SHEET_NAME);
    } catch (e) {
      return Result.fail('AVAILABILITY_READ_FAILED', 'Failed to read Availability for retention', {
        message: e.message
      });
    }

    var slotIdCounts = {};
    for (var c = 0; c < rows.length; c++) {
      var countedId = rows[c].slot_id;
      if (countedId === undefined || countedId === null || String(countedId).trim() === '') continue;
      var countedKey = String(countedId);
      slotIdCounts[countedKey] = (slotIdCounts[countedKey] || 0) + 1;
    }

    var records = [];
    var malformedSlotIds = 0;
    var malformedSortKeys = 0;
    var reservedSkipped = 0;
    var ambiguousSlotIds = 0;
    var seenAmbiguous = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var slotId = row.slot_id;
      if (slotId === undefined || slotId === null || String(slotId).trim() === '') {
        malformedSlotIds += 1;
        continue;
      }

      var slotKey = String(slotId);
      if (slotIdCounts[slotKey] > 1) {
        if (!seenAmbiguous[slotKey]) {
          seenAmbiguous[slotKey] = true;
          ambiguousSlotIds += 1;
        }
        // Duplicate slot_id is an identity ambiguity. Protect every row in
        // the ambiguous group rather than guessing which lifecycle row wins.
        continue;
      }

      var startMs = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (startMs === null || isNaN(startMs)) {
        malformedSortKeys += 1;
        continue;
      }

      var appointmentDate = DateUtils.formatClinicDateFromEpoch(startMs);
      if (!appointmentDate) {
        malformedSortKeys += 1;
        continue;
      }

      // Strictly older than the retention boundary. The boundary date itself
      // remains live and is therefore protected.
      if (appointmentDate >= cutoffDate) continue;

      if (row.status === Config.VOCABULARY.STATUS.RESERVED) {
        reservedSkipped += 1;
        continue;
      }

      records.push(this._toRecord(row));
    }

    return Result.ok({
      records: records,
      totalCount: rows.length,
      malformedSlotIds: malformedSlotIds,
      malformedSortKeys: malformedSortKeys,
      reservedSkipped: reservedSkipped,
      ambiguousSlotIds: ambiguousSlotIds,
      cutoffDate: cutoffDate
    });
  },

  /**
   * Idempotent archive operation. Existing exact snapshots are accepted;
   * duplicates are treated as an archive identity violation and block delete.
   */
  archiveRecords: function(records) {
    if (!records || records.length === 0) return Result.ok({ appended: 0, verified: 0 });

    var sourceHeaders;
    try {
      sourceHeaders = GoogleSheets.getHeaders(this.SOURCE_SHEET_NAME);
      GoogleSheets.getOrCreateSheet(this.ARCHIVE_SHEET_NAME, sourceHeaders);
      var archiveHeaders = GoogleSheets.ensureHeaders(this.ARCHIVE_SHEET_NAME, sourceHeaders);
      var archiveRows = GoogleSheets.getAllRows(this.ARCHIVE_SHEET_NAME);

      var toAppend = [];
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        var matches = this._findExactMatches(archiveRows, record);
        if (matches.length > 1) {
          return Result.fail('AVAILABILITY_ARCHIVE_IDENTITY_AMBIGUOUS',
            'More than one exact Availability archive snapshot exists',
            { slotId: record.slot_id });
        }
        if (matches.length === 0) {
          toAppend.push(archiveHeaders.map(function(header) {
            return record.hasOwnProperty(header) ? record[header] : '';
          }));
        }
      }

      if (toAppend.length > 0) {
        var appendResult = GoogleSheets.appendRows(this.ARCHIVE_SHEET_NAME, toAppend);
        if (!appendResult.ok) {
          return Result.fail('AVAILABILITY_ARCHIVE_WRITE_FAILED',
            'Failed to append Availability archive snapshots', appendResult.error);
        }
      }

      // Never rely on append position. Verify every requested snapshot by
      // exact content identity after the write.
      var verifiedRows = GoogleSheets.getAllRows(this.ARCHIVE_SHEET_NAME);
      for (var r = 0; r < records.length; r++) {
        var verified = this._findExactMatches(verifiedRows, records[r]);
        if (verified.length !== 1) {
          return Result.fail('AVAILABILITY_ARCHIVE_VERIFY_FAILED',
            'Availability archive verification failed', {
              slotId: records[r].slot_id,
              matchCount: verified.length
            });
        }
      }

      return Result.ok({ appended: toAppend.length, verified: records.length });
    } catch (e) {
      return Result.fail('AVAILABILITY_ARCHIVE_VERIFY_FAILED',
        'Availability archive operation failed before delete', { message: e.message });
    }
  },

  /**
   * Fresh reread / revalidation is mandatory immediately before deletion.
   * Any identity, state, or time-boundary change blocks the entire deletion
   * batch. The archive remains intact, so retry is safe.
   */
  deleteRecords: function(records, cutoffDate) {
    if (!records || records.length === 0) return Result.ok({ deleted: 0 });

    var currentRows;
    try {
      currentRows = GoogleSheets.getAllRows(this.SOURCE_SHEET_NAME);
    } catch (e) {
      return Result.fail('AVAILABILITY_DELETE_REVALIDATION_FAILED',
        'Failed to reread Availability before delete', { message: e.message });
    }

    var rowNumbers = [];
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      var sameSlot = currentRows.filter(function(row) {
        return String(row.slot_id) === String(record.slot_id);
      });

      if (sameSlot.length === 0) {
        return Result.fail('AVAILABILITY_IDENTITY_NOT_FOUND',
          'Fresh Availability reread found no row for archived slot', {
            slotId: record.slot_id
          });
      }
      if (sameSlot.length > 1) {
        return Result.fail('AVAILABILITY_IDENTITY_AMBIGUOUS',
          'Fresh Availability reread found multiple rows for archived slot', {
            slotId: record.slot_id
          });
      }

      var fresh = sameSlot[0];
      if (!this._recordsEqual(fresh, record)) {
        return Result.fail('AVAILABILITY_SNAPSHOT_CHANGED',
          'Availability row changed after archive; delete blocked', {
            slotId: record.slot_id
          });
      }

      var startMs = LegacySlotTimeParser.toComparableTime(fresh.sort_key);
      if (startMs === null || isNaN(startMs)) {
        return Result.fail('AVAILABILITY_DELETE_REVALIDATION_FAILED',
          'Fresh Availability row now has an invalid sort_key', {
            slotId: record.slot_id
          });
      }

      var appointmentDate = DateUtils.formatClinicDateFromEpoch(startMs);
      if (!appointmentDate) {
        return Result.fail('AVAILABILITY_DELETE_REVALIDATION_FAILED',
          'Fresh Availability row has an unresolvable appointment date', {
            slotId: record.slot_id
          });
      }
      if (appointmentDate >= cutoffDate) {
        return Result.fail('AVAILABILITY_DELETE_REVALIDATION_FAILED',
          'Availability row no longer falls outside the retention window', {
            slotId: record.slot_id,
            appointmentDate: appointmentDate,
            cutoffDate: cutoffDate
          });
      }

      if (fresh.status === Config.VOCABULARY.STATUS.RESERVED) {
        return Result.fail('AVAILABILITY_RESERVED',
          'Reserved slot remains Maintenance-owned; delete blocked', {
            slotId: record.slot_id
          });
      }

      rowNumbers.push(fresh._rowNumber);
    }

    var deleteResult;
    try {
      deleteResult = GoogleSheets.deleteRowsByNumbers(this.SOURCE_SHEET_NAME, rowNumbers);
    } catch (e) {
      return Result.fail('AVAILABILITY_DELETE_FAILED',
        'Failed to delete archived Availability rows', { message: e.message });
    }
    if (!deleteResult || !deleteResult.ok) {
      return Result.fail('AVAILABILITY_DELETE_FAILED',
        'Failed to delete archived Availability rows', deleteResult ? deleteResult.error : null);
    }

    // Post-delete exact-snapshot verification. A concurrently recreated row
    // with the same slot_id but different contents does not invalidate this;
    // the archived snapshot itself must simply no longer be present.
    try {
      var remaining = GoogleSheets.getAllRows(this.SOURCE_SHEET_NAME);
      for (var p = 0; p < records.length; p++) {
        if (this._findExactMatches(remaining, records[p]).length > 0) {
          return Result.fail('AVAILABILITY_DELETE_VERIFY_FAILED',
            'Deleted Availability snapshot is still present after delete', {
              slotId: records[p].slot_id
            });
        }
      }
    } catch (e2) {
      return Result.fail('AVAILABILITY_DELETE_VERIFY_FAILED',
        'Could not verify Availability deletion', { message: e2.message });
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

  _value: function(value) {
    if (value instanceof Date) return 'date:' + value.getTime();
    if (value === undefined || value === null || value === '') return 'empty';
    return typeof value + ':' + String(value);
  }
};
