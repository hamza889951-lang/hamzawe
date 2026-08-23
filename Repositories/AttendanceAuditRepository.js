/**
 * AttendanceAuditRepository — M0 (PHASE 1.1 — MANAGEMENT INTELLIGENCE)
 *
 * Dedicated append-only attendance decision evidence store.
 *
 * Boundary (M0):
 *   - ATTENDANCE_AUDIT is NOT the Availability source of truth. Slot status
 *     lives only in Availability and transitions only through StateMachine.
 *   - Append-only by contract (same discipline as LogRepository's
 *     append-only rule and the B6 audit store): no read, find, or delete
 *     functions are exposed. M1 reporting reads the sheet through its own
 *     approved boundary when that milestone is built.
 *   - Rows record: operatorId, eventId, calendarId, slotId, attendance
 *     decision, from/to status, outcome, error code, timestamp.
 *   - The timestamp of the first APPLIED row is the official
 *     ATTENDANCE_ACTIVATION_AT used by M1 to delimit official attendance
 *     metrics.
 */
const AttendanceAuditRepository = {
  SHEET_NAME: 'ATTENDANCE_AUDIT',

  HEADERS: [
    'operator_id',
    'calendar_event_id',
    'calendar_id',
    'slot_id',
    'decision',
    'from_status',
    'to_status',
    'outcome',
    'error_code',
    'timestamp'
  ],

  /**
   * Ensures the audit sheet exists with the required headers.
   * @returns {Result}
   */
  ensureStore: function() {
    try {
      GoogleSheets.getOrCreateSheet(this.SHEET_NAME, this.HEADERS);
      var headers = GoogleSheets.getHeaders(this.SHEET_NAME);
      for (var i = 0; i < this.HEADERS.length; i++) {
        if (headers.indexOf(this.HEADERS[i]) === -1) {
          return Result.fail(
            'ATTENDANCE_AUDIT_SCHEMA_INVALID',
            'Missing required attendance audit header: ' + this.HEADERS[i]
          );
        }
      }
      return Result.ok({ sheetName: this.SHEET_NAME, headers: headers });
    } catch (e) {
      return Result.fail('ATTENDANCE_AUDIT_STORE_UNAVAILABLE', e.message, e.stack);
    }
  },

  /**
   * Appends exactly one attendance decision record.
   * @param {Object} record - fields per HEADERS; missing fields become ''.
   * @returns {Result} ok(normalized record) | fail(ATTENDANCE_AUDIT_PERSISTENCE_UNKNOWN)
   */
  append: function(record) {
    var storeResult = this.ensureStore();
    if (!storeResult.ok) return storeResult;

    var normalized = {
      operator_id: record.operator_id || '',
      calendar_event_id: record.calendar_event_id || '',
      calendar_id: record.calendar_id || '',
      slot_id: record.slot_id || '',
      decision: record.decision || '',
      from_status: record.from_status || '',
      to_status: record.to_status || '',
      outcome: record.outcome || '',
      error_code: record.error_code || '',
      timestamp: Clock.now()
    };

    try {
      var headers = storeResult.data.headers;
      var row = headers.map(function(header) {
        return Object.prototype.hasOwnProperty.call(normalized, header)
          ? normalized[header]
          : '';
      });
      var appendResult = GoogleSheets.appendRows(this.SHEET_NAME, [row]);
      if (!appendResult || !appendResult.ok || appendResult.data.inserted !== 1) {
        return Result.fail(
          'ATTENDANCE_AUDIT_PERSISTENCE_UNKNOWN',
          'Attendance audit write was not acknowledged',
          appendResult && appendResult.error ? appendResult.error : null
        );
      }
      return Result.ok(normalized);
    } catch (e) {
      return Result.fail('ATTENDANCE_AUDIT_PERSISTENCE_UNKNOWN', e.message, e.stack);
    }
  }
};
