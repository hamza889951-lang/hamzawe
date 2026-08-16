/**
 * B6LifecycleRepository
 *
 * Durable, append-only lifecycle checkpoint journal for B6.
 * It is deliberately separate from Availability (business slot state),
 * PropertiesService (ownership fence), and SYSTEM_LOG (diagnostics).
 */
const B6LifecycleRepository = {
  SHEET_NAME: 'B6_LIFECYCLE',

  HEADERS: [
    'operation_id',
    'phone',
    'command',
    'old_slot_id',
    'new_slot_id',
    'lifecycle_state',
    'ownership_state',
    'checkpoint',
    'calendar_event_id',
    'calendar_correlation_id',
    'calendar_id',
    'recovery_state',
    'recovery_case_id',
    'created_at',
    'updated_at',
    'timestamp',
    'details'
  ],

  ensureStore: function() {
    try {
      GoogleSheets.getOrCreateSheet(this.SHEET_NAME, this.HEADERS);
      var headers = GoogleSheets.getHeaders(this.SHEET_NAME);
      for (var i = 0; i < this.HEADERS.length; i++) {
        if (headers.indexOf(this.HEADERS[i]) === -1) {
          return Result.fail(
            'B6_LIFECYCLE_SCHEMA_INVALID',
            'Missing required B6 lifecycle header: ' + this.HEADERS[i]
          );
        }
      }
      return Result.ok({ sheetName: this.SHEET_NAME, headers: headers });
    } catch (e) {
      return Result.fail('B6_LIFECYCLE_STORE_UNAVAILABLE', e.message, e.stack);
    }
  },

  appendCheckpoint: function(record) {
    var storeResult = this.ensureStore();
    if (!storeResult.ok) return storeResult;

    var now = Clock.now();
    var normalized = {
      operation_id: record.operation_id || '',
      phone: record.phone || '',
      command: record.command || '',
      old_slot_id: record.old_slot_id || '',
      new_slot_id: record.new_slot_id || '',
      lifecycle_state: record.lifecycle_state || '',
      ownership_state: record.ownership_state || '',
      checkpoint: record.checkpoint || '',
      calendar_event_id: record.calendar_event_id || '',
      calendar_correlation_id: record.calendar_correlation_id || '',
      calendar_id: record.calendar_id || '',
      recovery_state: record.recovery_state || '',
      recovery_case_id: record.recovery_case_id || '',
      created_at: record.created_at || now,
      updated_at: now,
      timestamp: now,
      details: record.details || ''
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
          'B6_CHECKPOINT_PERSISTENCE_UNKNOWN',
          'B6 lifecycle checkpoint was not acknowledged',
          appendResult && appendResult.error ? appendResult.error : null
        );
      }
      return Result.ok(normalized);
    } catch (e) {
      return Result.fail('B6_CHECKPOINT_PERSISTENCE_UNKNOWN', e.message, e.stack);
    }
  },

  findByOperationId: function(operationId) {
    return this._find(function(row) {
      return row.operation_id === operationId;
    });
  },

  findByPhone: function(phone) {
    return this._find(function(row) {
      return row.phone === phone;
    });
  },

  findByRecoveryCaseId: function(recoveryCaseId) {
    return this._find(function(row) {
      return row.recovery_case_id === recoveryCaseId;
    });
  },

  latestByOperationId: function(operationId) {
    var result = this.findByOperationId(operationId);
    if (!result.ok) return result;
    return Result.ok(this._latest(result.data));
  },

  latestByPhone: function(phone) {
    var result = this.findByPhone(phone);
    if (!result.ok) return result;
    return Result.ok(this._latest(result.data));
  },

  latestByRecoveryCaseId: function(recoveryCaseId) {
    var result = this.findByRecoveryCaseId(recoveryCaseId);
    if (!result.ok) return result;
    return Result.ok(this._latest(result.data));
  },

  _find: function(predicateFn) {
    var storeResult = this.ensureStore();
    if (!storeResult.ok) return storeResult;

    try {
      var rows = GoogleSheets.queryRows(this.SHEET_NAME, predicateFn);
      return Result.ok(rows);
    } catch (e) {
      return Result.fail('B6_LIFECYCLE_READ_FAILED', e.message, e.stack);
    }
  },

  _latest: function(rows) {
    if (!rows || rows.length === 0) return null;
    var sorted = rows.slice().sort(function(a, b) {
      return Number(a._rowNumber || 0) - Number(b._rowNumber || 0);
    });
    return sorted[sorted.length - 1];
  }
};
