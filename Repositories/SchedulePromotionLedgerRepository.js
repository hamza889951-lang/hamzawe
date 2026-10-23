/**
 * Append-only ledger for recurring schedule promotion.
 * Events are immutable. Latest event per scope/changeId is authoritative.
 * All callers must already be inside the script-wide Lock boundary.
 */
const SchedulePromotionLedgerRepository = {
  SHEET: 'SchedulePromotionLedger',
  HEADERS: ['eventId','changeId','doctorId','clinicId','effectiveFrom','state','beforeFingerprint','targetFingerprint','eventAt','detailJson'],
  _ensure: function() {
    GoogleSheets.getOrCreateSheet(this.SHEET, this.HEADERS);
    var actual = GoogleSheets.getHeaders(this.SHEET);
    if (!actual || actual.length !== this.HEADERS.length) {
      throw new Error('SCHEDULE_PROMOTION_LEDGER_SCHEMA_MISMATCH');
    }
    for (var i = 0; i < this.HEADERS.length; i++) {
      if (actual[i] !== this.HEADERS[i]) throw new Error('SCHEDULE_PROMOTION_LEDGER_SCHEMA_MISMATCH');
    }
  },
  _scope: function(doctorId, clinicId) {
    return { doctorId: String(doctorId), clinicId: clinicId == null || clinicId === '' ? '' : String(clinicId) };
  },
  _parse: function(row) {
    var detail = {};
    try { detail = row.detailJson ? JSON.parse(String(row.detailJson)) : {}; } catch (e) { detail = { __malformed: true }; }
    return {
      eventId: row.eventId, changeId: row.changeId, doctorId: row.doctorId,
      clinicId: row.clinicId == null ? '' : String(row.clinicId),
      effectiveFrom: row.effectiveFrom, state: row.state,
      beforeFingerprint: row.beforeFingerprint, targetFingerprint: row.targetFingerprint,
      eventAt: row.eventAt, detail: detail
    };
  },
  listByScopeResult: function(doctorId, clinicId) {
    try {
      this._ensure();
      var scope = this._scope(doctorId, clinicId);
      var rows = GoogleSheets.queryRows(this.SHEET, function(r) {
        return String(r.doctorId) === scope.doctorId &&
          (r.clinicId == null ? '' : String(r.clinicId)) === scope.clinicId;
      });
      return Result.ok(rows.map(this._parse.bind(this)));
    } catch (e) {
      return Result.fail('SCHEDULE_PROMOTION_LEDGER_READ_FAILED', 'Unable to read promotion ledger', e.message || String(e));
    }
  },
  appendEvent: function(event) {
    try {
      this._ensure();
      var row = {
        eventId: IdGenerator.generateScheduleChangeId(),
        changeId: event.changeId,
        doctorId: String(event.doctorId),
        clinicId: event.clinicId == null ? '' : String(event.clinicId),
        effectiveFrom: event.effectiveFrom,
        state: event.state,
        beforeFingerprint: event.beforeFingerprint || '',
        targetFingerprint: event.targetFingerprint || '',
        eventAt: Clock.now().toISOString(),
        detailJson: JSON.stringify(event.detail || {})
      };
      GoogleSheets.appendRow(this.SHEET, row);
      return Result.ok(this._parse(row));
    } catch (e) {
      return Result.fail('SCHEDULE_PROMOTION_LEDGER_WRITE_FAILED', 'Unable to append promotion ledger event', e.message || String(e));
    }
  },
  latestByChangeId: function(events) {
    var latest = {};
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e || !e.changeId || !e.state || e.detail && e.detail.__malformed) {
        return Result.fail('SCHEDULE_PROMOTION_LEDGER_INVALID', 'Promotion ledger contains malformed event');
      }
      latest[e.changeId] = e;
    }
    return Result.ok(latest);
  }
};