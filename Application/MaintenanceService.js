const MaintenanceService = {

  runCleanup: function() {
    var nowMs = Clock.now().getTime();
    var expiredCandidates = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.RESERVED) return false;
      var until = Number(row.reserved_until_unix);
      if (isNaN(until)) return false;
      return until < nowMs;
    });

    if (expiredCandidates.length === 0) {
      return Result.ok({ cleaned: 0, skipped: 0 });
    }

    var cleaned = 0;
    var skipped = 0;

    for (var i = 0; i < expiredCandidates.length; i++) {
      var candidate = expiredCandidates[i];
      var result = SlotRepository.cleanupExpiredReservation(candidate.slot_id, nowMs);

      if (!result.ok) {
        return result;
      }

      if (result.data && result.data.status === 'CLEANED') {
        cleaned++;
      } else if (
        result.data &&
        (result.data.status === 'SKIPPED_STATE' || result.data.status === 'SKIPPED_NOT_EXPIRED')
      ) {
        skipped++;
      }
    }

    return Result.ok({ cleaned: cleaned, skipped: skipped });
  },

  runExpiration: function() {
    var nowMs = Clock.now().getTime();
    var passedSlots = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
      var slotTime = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (slotTime === null) return false;
      return slotTime < nowMs;
    });
    if (passedSlots.length === 0) return Result.ok({ expired: 0 });
    var updates = passedSlots.map(function(slot) {
      return { columnName: 'slot_id', value: slot.slot_id, fields: { status: Config.VOCABULARY.STATUS.EXPIRED } };
    });
    var result = GoogleSheets.updateBatch(Config.VOCABULARY.SHEETS.AVAILABILITY, updates);
    if (!result.ok) return result;
    return Result.ok({ expired: result.data.updated });
  },

  run: function() {
    var cleanupResult = this.runCleanup();
    var expirationResult = this.runExpiration();
    var cleaned = (cleanupResult.ok) ? cleanupResult.data.cleaned : 0;
    var expired = (expirationResult.ok) ? expirationResult.data.expired : 0;
    var cleanupOk = cleanupResult.ok;
    var expirationOk = expirationResult.ok;
    var allOk = cleanupOk && expirationOk;

    LogRepository.write({
      timestamp: Clock.now(), command: 'MAINTENANCE_RUN', phone: '', slotId: '',
      stage: 'END', success: allOk, durationMs: null,
      error: JSON.stringify({ cleaned: cleaned, expired: expired, cleanupOk: cleanupOk, expirationOk: expirationOk })
    });

    if (allOk) return Result.ok({ cleaned: cleaned, expired: expired });

    return Result.fail('MAINTENANCE_PARTIAL_FAILURE', 'One or more maintenance sub-stages failed', { cleaned: cleaned, expired: expired, cleanupOk: cleanupOk, expirationOk: expirationOk });
  }
};
