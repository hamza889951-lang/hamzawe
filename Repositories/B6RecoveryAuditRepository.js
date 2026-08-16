/**
 * B6RecoveryAuditRepository
 *
 * Dedicated append-only recovery evidence and decision store. This is not
 * SYSTEM_LOG and is not the lifecycle checkpoint journal.
 */
const B6RecoveryAuditRepository = {
  SHEET_NAME: 'B6_RECOVERY_AUDIT',

  HEADERS: [
    'recovery_case_id',
    'operation_id',
    'operator_id',
    'phone',
    'old_slot_id',
    'new_slot_id',
    'initial_state',
    'evidence_summary',
    'decision',
    'verification_result',
    'release_result',
    'timestamp'
  ],

  ensureStore: function() {
    try {
      GoogleSheets.getOrCreateSheet(this.SHEET_NAME, this.HEADERS);
      var headers = GoogleSheets.getHeaders(this.SHEET_NAME);
      for (var i = 0; i < this.HEADERS.length; i++) {
        if (headers.indexOf(this.HEADERS[i]) === -1) {
          return Result.fail(
            'B6_RECOVERY_AUDIT_SCHEMA_INVALID',
            'Missing required B6 recovery audit header: ' + this.HEADERS[i]
          );
        }
      }
      return Result.ok({ sheetName: this.SHEET_NAME, headers: headers });
    } catch (e) {
      return Result.fail('B6_RECOVERY_AUDIT_STORE_UNAVAILABLE', e.message, e.stack);
    }
  },

  append: function(record) {
    var storeResult = this.ensureStore();
    if (!storeResult.ok) return storeResult;

    var normalized = {
      recovery_case_id: record.recovery_case_id || '',
      operation_id: record.operation_id || '',
      operator_id: record.operator_id || '',
      phone: record.phone || '',
      old_slot_id: record.old_slot_id || '',
      new_slot_id: record.new_slot_id || '',
      initial_state: record.initial_state || '',
      evidence_summary: record.evidence_summary || '',
      decision: record.decision || '',
      verification_result: record.verification_result || '',
      release_result: record.release_result || '',
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
          'B6_RECOVERY_AUDIT_PERSISTENCE_UNKNOWN',
          'B6 recovery audit write was not acknowledged',
          appendResult && appendResult.error ? appendResult.error : null
        );
      }
      return Result.ok(normalized);
    } catch (e) {
      return Result.fail('B6_RECOVERY_AUDIT_PERSISTENCE_UNKNOWN', e.message, e.stack);
    }
  }
};
