/**
 * AttendanceAuditReadRepository — M1-A (PHASE 1.2 — METRICS FOUNDATION)
 *
 * Dedicated READ-ONLY reporting boundary over the ATTENDANCE_AUDIT
 * evidence store.
 *
 * Boundary contract (M1-A):
 *   - M0 deliberately made AttendanceAuditRepository append-only with NO
 *     read API, because M1 was scheduled to build the reporting read
 *     boundary later. This file is that boundary. The append-only write
 *     contract in AttendanceAuditRepository is NOT modified: this
 *     repository never appends, updates, deletes, or creates the store,
 *     and exposes no mutation surface at all.
 *   - ATTENDANCE_AUDIT remains EVIDENCE, not the Availability source of
 *     truth (M0). Attendance metrics must be derived only through the M1
 *     frozen semantics: outcome = APPLIED, to_status filtering, and the
 *     ATTENDANCE_ACTIVATION_AT boundary (timestamp of the first APPLIED
 *     row). That derivation lives in Application/MetricsService.js, not
 *     here — this repository is a dumb, strict reader.
 *   - Reads are strict on purpose: the sheet must exist and must carry
 *     the full M0 header contract. A missing store or a schema-drifted
 *     store is a SOURCE FAILURE (Result.fail), never an implicit zero.
 *     A metric consumer must never confuse "the evidence could not be
 *     read" with "no attendance happened" (M1 failure semantics).
 *
 * Evaluation-order note: clasp pushes project files in alphabetical
 * order, so this file is evaluated BEFORE
 * Repositories/AttendanceAuditRepository.js. All references to the
 * writer's contract constants are therefore resolved at CALL time (the
 * same discipline documented in Application/AttendanceService.js), which
 * makes this file independent of project file order.
 */
const AttendanceAuditReadRepository = {
  /**
   * Reads every attendance audit row (the full evidence store).
   * Read-only: performs no store creation and no mutation of any kind.
   *
   * @returns {Result}
   *   ok(rows[])                                  — full evidence rows (may be empty: a store with headers and zero rows provably contains no attendance decisions)
   *   fail(ATTENDANCE_AUDIT_READ_FAILED)          — sheet absent or unreadable
   *   fail(ATTENDANCE_AUDIT_SCHEMA_INVALID)       — header contract drift
   */
  readAll: function() {
    // Resolved at call time (clasp alphabetical evaluation order).
    var sheetName = AttendanceAuditRepository.SHEET_NAME;
    var contractHeaders = AttendanceAuditRepository.HEADERS;

    try {
      var headers = GoogleSheets.getHeaders(sheetName);
      for (var i = 0; i < contractHeaders.length; i++) {
        if (headers.indexOf(contractHeaders[i]) === -1) {
          return Result.fail(
            'ATTENDANCE_AUDIT_SCHEMA_INVALID',
            'Attendance audit store is missing required header: ' + contractHeaders[i],
            { sheetName: sheetName, expected: contractHeaders, found: headers }
          );
        }
      }
      var rows = GoogleSheets.queryRows(sheetName, function() { return true; });
      return Result.ok(rows);
    } catch (e) {
      return Result.fail('ATTENDANCE_AUDIT_READ_FAILED', e.message, e.stack);
    }
  }
};
