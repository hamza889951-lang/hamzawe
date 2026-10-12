const MaintenanceService = {

  runCleanup: function() {
    var stageStartedMs = Clock.now().getTime();
    var nowMs = Clock.now().getTime();
    var expiredCandidates = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.RESERVED) return false;
      var until = Number(row.reserved_until_unix);
      if (isNaN(until)) return false;
      return until < nowMs;
    });

    var queryDurationMs = Math.max(0, Clock.now().getTime() - stageStartedMs);
    if (expiredCandidates.length === 0) {
      return Result.ok({ cleaned: 0, skipped: 0, diagnostics: { queryDurationMs: queryDurationMs, candidates: 0, cleanupLoopDurationMs: 0, cleanupCalls: 0 } });
    }

    var cleaned = 0;
    var skipped = 0;
    var cleanupStartedMs = Clock.now().getTime();

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

    return Result.ok({ cleaned: cleaned, skipped: skipped, diagnostics: { queryDurationMs: queryDurationMs, candidates: expiredCandidates.length, cleanupLoopDurationMs: Math.max(0, Clock.now().getTime() - cleanupStartedMs), cleanupCalls: expiredCandidates.length } });
  },

  runExpiration: function() {
    var stageStartedMs = Clock.now().getTime();
    var nowMs = Clock.now().getTime();
    var passedSlots = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
      var slotTime = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (slotTime === null) return false;
      return slotTime < nowMs;
    });
    var queryDurationMs = Math.max(0, Clock.now().getTime() - stageStartedMs);
    if (passedSlots.length === 0) return Result.ok({ expired: 0, diagnostics: { queryDurationMs: queryDurationMs, candidates: 0, updateBatchDurationMs: 0 } });
    var updates = passedSlots.map(function(slot) {
      return { columnName: 'slot_id', value: slot.slot_id, fields: { status: Config.VOCABULARY.STATUS.EXPIRED } };
    });
    var updateStartedMs = Clock.now().getTime();
    var result = GoogleSheets.updateBatch(Config.VOCABULARY.SHEETS.AVAILABILITY, updates);
    var updateBatchDurationMs = Math.max(0, Clock.now().getTime() - updateStartedMs);
    if (!result.ok) return result;
    return Result.ok({ expired: result.data.updated, diagnostics: { queryDurationMs: queryDurationMs, candidates: passedSlots.length, updateBatchDurationMs: updateBatchDurationMs } });
  },

  run: function() {
    var cleanupStageStartedMs = Clock.now().getTime();
    var cleanupResult = this.runCleanup();
    var cleanupStageDurationMs = Math.max(0, Clock.now().getTime() - cleanupStageStartedMs);
    var expirationStageStartedMs = Clock.now().getTime();
    var expirationResult = this.runExpiration();
    var expirationStageDurationMs = Math.max(0, Clock.now().getTime() - expirationStageStartedMs);
    var cleaned = (cleanupResult.ok) ? cleanupResult.data.cleaned : 0;
    var expired = (expirationResult.ok) ? expirationResult.data.expired : 0;
    var cleanupOk = cleanupResult.ok;
    var expirationOk = expirationResult.ok;
    var allOk = cleanupOk && expirationOk;

    LogRepository.write({
      timestamp: Clock.now(), command: 'MAINTENANCE_RUN', phone: '', slotId: '',
      stage: 'END', success: allOk, durationMs: null,
      error: JSON.stringify({ cleaned: cleaned, expired: expired, cleanupOk: cleanupOk, expirationOk: expirationOk, diagnostics: { cleanupStageDurationMs: cleanupStageDurationMs, expirationStageDurationMs: expirationStageDurationMs, cleanup: cleanupResult.ok ? cleanupResult.data.diagnostics : null, expiration: expirationResult.ok ? expirationResult.data.diagnostics : null } })
    });

    if (allOk) return Result.ok({ cleaned: cleaned, expired: expired, diagnostics: { cleanupStageDurationMs: cleanupStageDurationMs, expirationStageDurationMs: expirationStageDurationMs, cleanup: cleanupResult.data.diagnostics, expiration: expirationResult.data.diagnostics } });

    return Result.fail('MAINTENANCE_PARTIAL_FAILURE', 'One or more maintenance sub-stages failed', { cleaned: cleaned, expired: expired, cleanupOk: cleanupOk, expirationOk: expirationOk, diagnostics: { cleanupStageDurationMs: cleanupStageDurationMs, expirationStageDurationMs: expirationStageDurationMs, cleanup: cleanupResult.ok ? cleanupResult.data.diagnostics : null, expiration: expirationResult.ok ? expirationResult.data.diagnostics : null } });
  }
};
