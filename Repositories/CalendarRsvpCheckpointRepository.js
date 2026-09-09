/**
 * CalendarRsvpCheckpointRepository
 * Technical reconciliation state only. It is not an event database and is
 * never used as business truth for Availability or Attendance.
 */
const CalendarRsvpCheckpointRepository = {
  SHEET_NAME: 'CALENDAR_RSVP_CHECKPOINT',
  HEADERS: ['iCalUID', 'event_status', 'response_status', 'outcome', 'reason_code', 'decision', 'updated_at'],

  _sheet() {
    return GoogleSheets.getOrCreateSheet(this.SHEET_NAME, this.HEADERS);
  },

  readAll() {
    try {
      this._sheet();
      const rows = GoogleSheets.queryRows(this.SHEET_NAME, function() { return true; });
      const result = Object.create(null);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] || {};
        const key = typeof row.iCalUID === 'string' ? row.iCalUID.trim() : '';
        if (!key) continue;
        result[key] = {
          responseStatus: String(row.response_status || ''),
          eventStatus: String(row.event_status || ''),
          outcome: String(row.outcome || ''),
          reasonCode: String(row.reason_code || ''),
          decision: String(row.decision || ''),
          updatedAt: String(row.updated_at || '')
        };
      }
      return Result.ok(result);
    } catch (e) {
      return Result.fail('RSVP_CHECKPOINT_READ_FAILED', e.message, e.stack);
    }
  },

  saveAll(checkpoints) {
    try {
      this._sheet();
      const rows = Object.keys(checkpoints || {}).map(function(key) {
        const cp = checkpoints[key] || {};
        return [
          key,
          cp.eventStatus || '',
          cp.responseStatus || '',
          cp.outcome || '',
          cp.reasonCode || '',
          cp.decision || '',
          cp.updatedAt || ''
        ];
      });

      if (GoogleSheets.deleteRowsByNumbers) {
        const current = GoogleSheets.queryRows(this.SHEET_NAME, function() { return true; });
        const rowNumbers = current.map(function(row) { return row._rowNumber; });
        if (rowNumbers.length) {
          const deleted = GoogleSheets.deleteRowsByNumbers(this.SHEET_NAME, rowNumbers);
          if (!deleted || !deleted.ok) return deleted || Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', 'Failed to replace technical checkpoint rows');
        }
      }

      if (rows.length && GoogleSheets.appendRows) {
        const appended = GoogleSheets.appendRows(this.SHEET_NAME, rows);
        if (!appended || !appended.ok) return appended || Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', 'Failed to append technical checkpoint rows');
      }
      return Result.ok({ saved: rows.length });
    } catch (e) {
      return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, e.stack);
    }
  },

  clearAll() {
    try {
      this._sheet();
      const rows = GoogleSheets.queryRows(this.SHEET_NAME, function() { return true; });
      const rowNumbers = rows.map(function(row) { return row._rowNumber; });
      if (!rowNumbers.length) return Result.ok({ removed: 0 });
      return GoogleSheets.deleteRowsByNumbers(this.SHEET_NAME, rowNumbers);
    } catch (e) {
      return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, e.stack);
    }
  }
};
