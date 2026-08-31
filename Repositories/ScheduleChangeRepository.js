/**
 * ═══════════════════════════════════════
 * CONTRACT — ScheduleChangeRepository
 * ═══════════════════════════════════════
 * M4-C — append-only persistence for immutable Schedule Change Records.
 *
 * يضمن:
 * - تخزين records كصفوف في ورقة ScheduleChanges عبر GoogleSheets فقط.
 * - append-only على المستوى الدلالي: لا update ولا delete لسجل تاريخي.
 * - بحث بالـcommandId / changeId / scope.
 * - قفل نطاق الجدول (key توثيقي) حول القراءة الحية + الإلحاق.
 *
 * لا يضمن:
 * - حساب EffectiveSchedule — ذلك Application.
 * - أي Availability / Calendar / WhatsApp.
 */
const ScheduleChangeRepository = {

  HEADERS: [
    'changeId',
    'doctorId',
    'clinicId',
    'actorId',
    'commandId',
    'changeKind',
    'effectiveFrom',
    'effectiveTo',
    'payloadJson',
    'createdAt',
    'status',
    'targetChangeId',
    'beforeJson',
    'afterJson'
  ],

  KIND: {
    RECURRING: 'RECURRING',
    TEMPORARY_CLOSE: 'TEMPORARY_CLOSE',
    TEMPORARY_OPEN: 'TEMPORARY_OPEN',
    CANCEL: 'CANCEL'
  },

  STATUS: {
    COMMITTED: 'COMMITTED'
  },

  _sheetName: function() {
    return Config.VOCABULARY.SHEETS.SCHEDULE_CHANGES;
  },

  _ensureSheet: function() {
    GoogleSheets.getOrCreateSheet(this._sheetName(), this.HEADERS);
  },

  _normalizeClinicId: function(clinicId) {
    if (clinicId === undefined || clinicId === null || clinicId === '') return null;
    return String(clinicId);
  },

  _clinicKey: function(clinicId) {
    var id = this._normalizeClinicId(clinicId);
    return id === null ? '' : id;
  },

  _scopeKey: function(doctorId, clinicId) {
    return 'schedule-intent:' + String(doctorId) + ':' + this._clinicKey(clinicId);
  },

  _sameScope: function(row, doctorId, clinicId) {
    if (!row || row.doctorId !== doctorId) return false;
    return this._clinicKey(row.clinicId) === this._clinicKey(clinicId);
  },

  _parseRow: function(row) {
    if (!row) return null;
    var payload = null;
    var before = null;
    var after = null;
    try {
      payload = row.payloadJson ? JSON.parse(String(row.payloadJson)) : null;
    } catch (e) {
      payload = { __malformed: true, raw: row.payloadJson };
    }
    try {
      before = row.beforeJson ? JSON.parse(String(row.beforeJson)) : null;
    } catch (e2) {
      before = { __malformed: true };
    }
    try {
      after = row.afterJson ? JSON.parse(String(row.afterJson)) : null;
    } catch (e3) {
      after = { __malformed: true };
    }
    return {
      changeId: row.changeId,
      scope: {
        doctorId: row.doctorId,
        clinicId: this._normalizeClinicId(row.clinicId)
      },
      actorId: row.actorId,
      commandId: row.commandId,
      changeKind: row.changeKind,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo === '' || row.effectiveTo == null ? null : row.effectiveTo,
      payload: payload,
      createdAt: row.createdAt,
      status: row.status,
      targetChangeId: row.targetChangeId === '' || row.targetChangeId == null ? null : row.targetChangeId,
      before: before,
      after: after
    };
  },

  /**
   * Lock-protected exclusive section for one logical schedule scope.
   * @param {string} doctorId
   * @param {*} clinicId
   * @param {Function} fn — must return Result
   * @returns {Result}
   */
  runExclusiveForScope: function(doctorId, clinicId, fn) {
    return Lock.runExclusive(this._scopeKey(doctorId, clinicId), fn);
  },

  listByScopeResult: function(doctorId, clinicId) {
    try {
      this._ensureSheet();
      var self = this;
      var rows = GoogleSheets.queryRows(this._sheetName(), function(row) {
        return self._sameScope(row, doctorId, clinicId);
      });
      var parsed = [];
      for (var i = 0; i < rows.length; i++) {
        parsed.push(this._parseRow(rows[i]));
      }
      return Result.ok(parsed);
    } catch (e) {
      return Result.fail(
        'SCHEDULE_CHANGE_READ_FAILED',
        'Failed to read schedule change records',
        e && e.message ? e.message : e
      );
    }
  },

  findByChangeIdResult: function(changeId) {
    try {
      this._ensureSheet();
      var row = GoogleSheets.findRowByColumn(this._sheetName(), 'changeId', changeId);
      if (!row) return Result.ok(null);
      return Result.ok(this._parseRow(row));
    } catch (e) {
      return Result.fail(
        'SCHEDULE_CHANGE_READ_FAILED',
        'Failed to read schedule change by id',
        e && e.message ? e.message : e
      );
    }
  },

  findByCommandIdResult: function(doctorId, clinicId, commandId) {
    try {
      this._ensureSheet();
      var self = this;
      var rows = GoogleSheets.queryRows(this._sheetName(), function(row) {
        return self._sameScope(row, doctorId, clinicId) && row.commandId === commandId;
      });
      if (!rows.length) return Result.ok(null);
      return Result.ok(this._parseRow(rows[0]));
    } catch (e) {
      return Result.fail(
        'SCHEDULE_CHANGE_READ_FAILED',
        'Failed to read schedule change by commandId',
        e && e.message ? e.message : e
      );
    }
  },

  /**
   * Append-only persist. Callers must already hold runExclusiveForScope
   * for the same scope when used from a mutation command.
   * @param {Object} record
   * @returns {Result}
   */
  appendCommitted: function(record) {
    try {
      this._ensureSheet();
      var createdAt = record.createdAt;
      if (!createdAt) {
        createdAt = Clock.now().toISOString();
      }
      var changeId = record.changeId || IdGenerator.generateScheduleChangeId();
      var row = {
        changeId: changeId,
        doctorId: record.scope.doctorId,
        clinicId: this._clinicKey(record.scope.clinicId),
        actorId: record.actorId,
        commandId: record.commandId,
        changeKind: record.changeKind,
        effectiveFrom: record.effectiveFrom,
        effectiveTo: record.effectiveTo == null ? '' : record.effectiveTo,
        payloadJson: JSON.stringify(record.payload == null ? {} : record.payload),
        createdAt: createdAt,
        status: this.STATUS.COMMITTED,
        targetChangeId: record.targetChangeId == null ? '' : record.targetChangeId,
        beforeJson: JSON.stringify(record.before == null ? {} : record.before),
        afterJson: JSON.stringify(record.after == null ? {} : record.after)
      };
      GoogleSheets.appendRow(this._sheetName(), row);
      return Result.ok(this._parseRow(row));
    } catch (e) {
      return Result.fail(
        'SCHEDULE_CHANGE_WRITE_FAILED',
        'Failed to persist schedule change record',
        e && e.message ? e.message : e
      );
    }
  }
};
