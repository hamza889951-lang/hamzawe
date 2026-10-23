/**
 * One-time, evidence-backed repair for the six date-only ATTENDANCE_AUDIT
 * timestamps confirmed by the 2026-10-09 workbook snapshot.
 *
 * Source of exact values: pre-corruption Dr.Fulan(24).xlsx snapshot. Each
 * row is guarded by physical row number AND immutable business fields.
 *
 * SAFETY:
 * - No writes occur unless every target row and the untouched final APPLIED
 *   row pass preflight.
 * - Only timestamp cells are changed.
 * - Date-only text is never parsed as a timestamp; it is replaced only with
 *   the exact timestamp recovered from the verified earlier snapshot.
 * - Spreadsheet timezone must be Asia/Baghdad.
 * - Idempotent: already-correct Date values are accepted without rewriting.
 * - No report generation, appointment mutation, or message sending.
 *
 * Remove this temporary migration file after a successful run and verified
 * report regression.
 */
var HAMZAWE_ATTENDANCE_AUDIT_TIMESTAMP_REPAIR = {
  SHEET_NAME: 'ATTENDANCE_AUDIT',
  TIME_ZONE: 'Asia/Baghdad',
  EXPECTED_ROWS: [
    {
      rowNumber: 2,
      dateOnly: '2026-09-07',
      localTimestamp: '2026-09-07 22:43:35.773',
      operator_id: 'hamza889951@gmail.com',
      calendar_event_id: 'kfvboca5v1pmeaopuqbbg09k04@google.com',
      calendar_id: 'hamza889951@gmail.com',
      slot_id: 'SLT_01KZHNKVTE4JPJ4SSJWFGY0S6F',
      decision: 'MARK_COMPLETED',
      from_status: 'CONFIRMED',
      to_status: 'COMPLETED',
      outcome: 'APPLIED',
      error_code: ''
    },
    {
      rowNumber: 3,
      dateOnly: '2026-09-07',
      localTimestamp: '2026-09-07 22:49:44.278',
      operator_id: 'hamza889951@gmail.com',
      calendar_event_id: 'kfvboca5v1pmeaopuqbbg09k04@google.com',
      calendar_id: 'hamza889951@gmail.com',
      slot_id: 'SLT_01KZHNKVTE4JPJ4SSJWFGY0S6F',
      decision: 'MARK_NO_SHOW',
      from_status: 'COMPLETED',
      to_status: '',
      outcome: 'REJECTED_INVALID_TRANSITION',
      error_code: 'INVALID_TRANSITION'
    },
    {
      rowNumber: 4,
      dateOnly: '2026-09-13',
      localTimestamp: '2026-09-13 04:47:59.849',
      operator_id: 'hamza889951@gmail.com',
      calendar_event_id: 'rsgl2i8m5pvsgv7feghguvap84@google.com',
      calendar_id: 'hamza889951@gmail.com',
      slot_id: 'SLT_01KZYNSGQAADPNSND9H882WB5G',
      decision: 'MARK_COMPLETED',
      from_status: 'CONFIRMED',
      to_status: 'COMPLETED',
      outcome: 'APPLIED',
      error_code: ''
    },
    {
      rowNumber: 5,
      dateOnly: '2026-09-17',
      localTimestamp: '2026-09-17 00:20:11.777',
      operator_id: 'hamzaalking158@gmail.com',
      calendar_event_id: 'rsgl2i8m5pvsgv7feghguvap84@google.com',
      calendar_id: 'hamza889951@gmail.com',
      slot_id: 'SLT_01KZYNSGQAADPNSND9H882WB5G',
      decision: 'MARK_NO_SHOW',
      from_status: 'CONFIRMED',
      to_status: 'NO_SHOW',
      outcome: 'APPLIED',
      error_code: ''
    },
    {
      rowNumber: 6,
      dateOnly: '2026-09-17',
      localTimestamp: '2026-09-17 00:35:31.222',
      operator_id: 'hamzaalking158@gmail.com',
      calendar_event_id: 'rsgl2i8m5pvsgv7feghguvap84@google.com',
      calendar_id: 'hamza889951@gmail.com',
      slot_id: 'SLT_01KZYNSGQAADPNSND9H882WB5G',
      decision: 'MARK_COMPLETED',
      from_status: 'NO_SHOW',
      to_status: '',
      outcome: 'REJECTED_INVALID_TRANSITION',
      error_code: 'INVALID_TRANSITION'
    },
    {
      rowNumber: 7,
      dateOnly: '2026-09-17',
      localTimestamp: '2026-09-17 00:35:57.354',
      operator_id: 'hamzaalking158@gmail.com',
      calendar_event_id: 'l1odc7capccmr3r1esedk393es@google.com',
      calendar_id: 'hamza889951@gmail.com',
      slot_id: 'SLT_01KZYNSGQA42MSXEKAZ3VHA78K',
      decision: 'MARK_NO_SHOW',
      from_status: 'CONFIRMED',
      to_status: 'NO_SHOW',
      outcome: 'APPLIED',
      error_code: ''
    },
    {
      rowNumber: 8,
      dateOnly: '2026-09-17',
      localTimestamp: '2026-09-17 03:46:59.021',
      operator_id: 'hamzaalking158@gmail.com',
      calendar_event_id: '445d1mq40kshj9kjj849jjmcik@google.com',
      calendar_id: 'hamza889951@gmail.com',
      slot_id: 'SLT_01M0BHSAMKS09WFYVK79MS4GCQ',
      decision: 'MARK_NO_SHOW',
      from_status: 'CONFIRMED',
      to_status: 'NO_SHOW',
      outcome: 'APPLIED',
      error_code: ''
    },
    {
      rowNumber: 9,
      dateOnly: '2026-10-02',
      localTimestamp: '2026-10-02 06:03:54.209',
      operator_id: 'hamzaalking158@gmail.com',
      calendar_event_id: 'fe740ac2nsrfj5e1leh2o2kiok@google.com',
      calendar_id: 'hamza889951@gmail.com',
      slot_id: 'SLT_01M1FKB7YK79Y5P1N43JPXBFTE',
      decision: 'MARK_COMPLETED',
      from_status: 'CONFIRMED',
      to_status: 'COMPLETED',
      outcome: 'APPLIED',
      error_code: ''
    }
  ],
  FINAL_APPLIED_ROW: {
    rowNumber: 10,
    date: '2026-10-11',
    localTimestamp: '2026-10-11 05:48:41.909',
    operator_id: 'hamzaalking158@gmail.com',
    calendar_event_id: '4oota1f12reg31anm7ct71d9uc@google.com',
    calendar_id: 'hamza889951@gmail.com',
    slot_id: 'SLT_01M2QM8R5H0TDG9SF3SJYFKBB2',
    decision: 'MARK_NO_SHOW',
    from_status: 'CONFIRMED',
    to_status: 'NO_SHOW',
    outcome: 'APPLIED'
  },

  run: function() {
    var ss;
    var sheet;
    try {
      ss = GoogleSheets._openSpreadsheet();
      if (!ss || ss.getSpreadsheetTimeZone() !== this.TIME_ZONE) {
        return this._fail('REPAIR_TIME_ZONE_MISMATCH',
          'Spreadsheet timezone must be Asia/Baghdad; no cells were changed.');
      }
      sheet = ss.getSheetByName(this.SHEET_NAME);
      if (!sheet) {
        return this._fail('REPAIR_SHEET_NOT_FOUND',
          'ATTENDANCE_AUDIT was not found; no cells were changed.');
      }
    } catch (e) {
      return this._fail('REPAIR_PREFLIGHT_FAILED',
        'Unable to open spreadsheet for preflight; no cells were changed.');
    }

    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow !== 10 || lastColumn < 10) {
      return this._fail('REPAIR_SHAPE_MISMATCH',
        'Expected ATTENDANCE_AUDIT data through row 10 and timestamp column; no cells were changed.',
        { lastRow: lastRow, lastColumn: lastColumn });
    }

    var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
    var required = [
      'operator_id', 'calendar_event_id', 'calendar_id', 'slot_id',
      'decision', 'from_status', 'to_status', 'outcome', 'error_code', 'timestamp'
    ];
    var columns = {};
    for (var h = 0; h < required.length; h++) {
      columns[required[h]] = headers.indexOf(required[h]);
      if (columns[required[h]] < 0) {
        return this._fail('REPAIR_SCHEMA_MISMATCH',
          'Missing required ATTENDANCE_AUDIT header; no cells were changed.',
          { missingHeader: required[h] });
      }
    }

    var plan = [];
    for (var i = 0; i < this.EXPECTED_ROWS.length; i++) {
      var expected = this.EXPECTED_ROWS[i];
      var rowValues = sheet.getRange(expected.rowNumber, 1, 1, lastColumn).getValues()[0];
      var identityMismatch = this._identityMismatch(rowValues, columns, expected);
      if (identityMismatch) {
        return this._fail('REPAIR_ROW_IDENTITY_MISMATCH',
          'A target row differs from the verified backup; no cells were changed.',
          { rowNumber: expected.rowNumber, field: identityMismatch });
      }

      var current = rowValues[columns.timestamp];
      if (current instanceof Date && isFinite(current.getTime())) {
        var expectedDate = this._parseTimestamp(expected.localTimestamp);
        if (current.getTime() === expectedDate.getTime()) {
          plan.push({ rowNumber: expected.rowNumber, date: expectedDate, action: 'ALREADY_CORRECT' });
          continue;
        }
      }

      if (!this._isExpectedDateOnly(current, expected.dateOnly)) {
        return this._fail('REPAIR_TIMESTAMP_MISMATCH',
          'Target timestamp is neither the expected date-only text nor the exact recovered Date; no cells were changed.',
          { rowNumber: expected.rowNumber, valueType: current instanceof Date ? 'Date' : typeof current });
      }
      plan.push({ rowNumber: expected.rowNumber, date: this._parseTimestamp(expected.localTimestamp), action: 'REPAIR' });
    }

    var finalCheck = this._validateFinalAppliedRow(sheet, lastColumn, columns);
    if (!finalCheck.ok) return finalCheck;

    // Preflight is complete for all target rows before the first write.
    // All eight target rows are contiguous (2..9), so persist their timestamp
    // column in one setValues call rather than eight independent cell writes.
    var written = [];
    var needsRepair = plan.some(function(item) { return item.action === 'REPAIR'; });
    try {
      if (needsRepair) {
        var timestampValues = plan.map(function(item) { return [item.date]; });
        sheet.getRange(2, columns.timestamp + 1, plan.length, 1).setValues(timestampValues);
        sheet.getRange(2, columns.timestamp + 1, plan.length, 1)
          .setNumberFormat('yyyy-mm-dd hh:mm:ss.000');
        written = plan.map(function(item) { return item.rowNumber; });
      }
    } catch (writeError) {
      return this._fail('REPAIR_WRITE_INCOMPLETE',
        'The timestamp-column write failed after preflight. Do not rerun reports; inspect rows 2–9 before retrying.',
        { writeAttempted: needsRepair, rowRange: '2:9' });
    }

    var verificationFailures = [];
    for (var v = 0; v < plan.length; v++) {
      var actual = sheet.getRange(plan[v].rowNumber, columns.timestamp + 1).getValue();
      if (!(actual instanceof Date) || !isFinite(actual.getTime()) ||
          actual.getTime() !== plan[v].date.getTime()) {
        verificationFailures.push(plan[v].rowNumber);
      }
    }
    if (verificationFailures.length) {
      return this._fail('REPAIR_VERIFY_FAILED',
        'Timestamp read-back verification failed. Do not rerun reports until inspected.',
        { failedRows: verificationFailures, writtenRows: written });
    }

    return {
      ok: true,
      code: 'ATTENDANCE_AUDIT_TIMESTAMPS_REPAIRED',
      mode: 'WRITE_AND_VERIFY',
      repairedRowNumbers: written,
      alreadyCorrectRowNumbers: plan.filter(function(x) {
        return x.action === 'ALREADY_CORRECT';
      }).map(function(x) { return x.rowNumber; }),
      verifiedTimestampCount: plan.length,
      finalAppliedRowVerified: true,
      reportsExecuted: false,
      messagesSent: 0
    };
  },

  _identityMismatch: function(row, columns, expected) {
    var fields = [
      'operator_id', 'calendar_event_id', 'calendar_id', 'slot_id',
      'decision', 'from_status', 'to_status', 'outcome'
    ];
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (String(row[columns[field]] == null ? '' : row[columns[field]]) !== expected[field]) {
        return field;
      }
    }
    var errorCode = row[columns.error_code];
    if (String(errorCode == null ? '' : errorCode) !== expected.error_code) return 'error_code';
    return null;
  },

  _validateFinalAppliedRow: function(sheet, lastColumn, columns) {
    var expected = this.FINAL_APPLIED_ROW;
    var row = sheet.getRange(expected.rowNumber, 1, 1, lastColumn).getValues()[0];
    var fields = [
      'operator_id', 'calendar_event_id', 'calendar_id', 'slot_id',
      'decision', 'from_status', 'to_status', 'outcome'
    ];
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (String(row[columns[field]] == null ? '' : row[columns[field]]) !== expected[field]) {
        return this._fail('REPAIR_FINAL_ROW_MISMATCH',
          'The final APPLIED row differs from the verified snapshot; no cells were changed.',
          { rowNumber: expected.rowNumber, field: field });
      }
    }
    var timestamp = row[columns.timestamp];
    if (!(timestamp instanceof Date) || !isFinite(timestamp.getTime()) ||
        Utilities.formatDate(timestamp, this.TIME_ZONE, 'yyyy-MM-dd HH:mm:ss.SSS') !== expected.localTimestamp) {
      return this._fail('REPAIR_FINAL_TIMESTAMP_MISMATCH',
        'The final APPLIED timestamp is not the verified Date value; no cells were changed.',
        { rowNumber: expected.rowNumber });
    }
    return { ok: true };
  },

  _isExpectedDateOnly: function(value, expectedDate) {
    if (typeof value !== 'string') return false;
    var normalized = value.trim().replace(/\//g, '-');
    return normalized === expectedDate;
  },

  _parseTimestamp: function(localTimestamp) {
    return Utilities.parseDate(localTimestamp, this.TIME_ZONE, 'yyyy-MM-dd HH:mm:ss.SSS');
  },

  _fail: function(code, message, details) {
    return { ok: false, code: code, message: message, details: details || null };
  }
};

function runHamzaweAttendanceAuditTimestampRepair() {
  var result;
  try {
    result = HAMZAWE_ATTENDANCE_AUDIT_TIMESTAMP_REPAIR.run();
  } catch (error) {
    result = {
      ok: false,
      code: 'REPAIR_UNHANDLED_EXCEPTION',
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack) : null,
      writesMayHaveOccurred: false
    };
  }
  // Apps Script's execution transcript does not display a function's return
  // object. Emit the exact guard/result so a completed run cannot look like
  // a silent no-op when preflight intentionally fails closed.
  Logger.log('HAMZAWE_ATTENDANCE_AUDIT_TIMESTAMP_REPAIR_RESULT=' + JSON.stringify(result));
  return result;
}
