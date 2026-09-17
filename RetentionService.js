/**
 * RetentionService
 *
 * Unified retention/archive orchestration for the existing Scheduler.
 * Logical sources remain separate:
 *   SYSTEM_LOG   -> SYSTEM_LOG_ARCHIVE
 *   Availability -> Availability_ARCHIVE
 *
 * Deployment safety:
 *   DRY_RUN            = inspect only (migration default)
 *   ARCHIVE_ONLY       = archive + verify, never delete
 *   ARCHIVE_AND_DELETE = archive + verify + fresh-read/revalidate + delete
 *
 * Deletion requires explicit RETENTION_MODE=ARCHIVE_AND_DELETE.
 */
const RetentionService = {

  MODES: {
    DRY_RUN: 'DRY_RUN',
    ARCHIVE_ONLY: 'ARCHIVE_ONLY',
    ARCHIVE_AND_DELETE: 'ARCHIVE_AND_DELETE'
  },

  SOURCES: {
    SYSTEM_LOG: 'SYSTEM_LOG',
    AVAILABILITY: 'Availability'
  },

  PROPERTY_KEY: 'RETENTION_MODE',
  DEFAULT_MODE: 'DRY_RUN',

  POLICIES: {
    SYSTEM_LOG_DAYS: 31,
    AVAILABILITY_DAYS: 60
  },

  run: function(options) {
    options = options || {};

    var modeResult = this._resolveMode(options.mode);
    if (!modeResult.ok) return modeResult;

    var mode = modeResult.data.mode;
    var requestedSources = options.sources || [this.SOURCES.SYSTEM_LOG, this.SOURCES.AVAILABILITY];
    var startedAt = Clock.now();
    var startedMs = startedAt.getTime();
    var results = {};
    var allOk = true;

    for (var i = 0; i < requestedSources.length; i++) {
      var source = requestedSources[i];
      var sourceResult;

      if (source === this.SOURCES.SYSTEM_LOG) {
        sourceResult = this._runSystemLog(mode, startedMs);
      } else if (source === this.SOURCES.AVAILABILITY) {
        sourceResult = this._runAvailability(mode, startedMs);
      } else {
        sourceResult = Result.fail('RETENTION_SOURCE_UNKNOWN', 'Unknown retention source', { source: source });
      }

      results[source] = sourceResult && sourceResult.ok
        ? sourceResult.data
        : { status: 'FAILED', error: sourceResult ? sourceResult.error : 'null result' };

      if (!sourceResult || !sourceResult.ok) allOk = false;
    }

    var finishedAt = Clock.now();
    var summary = {
      mode: mode,
      durationMs: finishedAt.getTime() - startedMs,
      sources: results
    };

    this._log('RETENTION_RUN', allOk, summary);

    if (!allOk) {
      return Result.fail(
        'RETENTION_PARTIAL_FAILURE',
        'One or more retention sources failed; data was kept safe',
        summary
      );
    }

    return Result.ok(summary);
  },

  _runSystemLog: function(mode, nowMs) {
    var cutoffDate = DateUtils.addMinutes(
      DateUtils.fromTimestamp(nowMs),
      -this.POLICIES.SYSTEM_LOG_DAYS * 24 * 60
    );
    var cutoffMs = cutoffDate.getTime();
    var findResult = LogArchiveRepository.findOlderThan(cutoffMs);
    if (!findResult.ok) {
      this._stageFailure(this.SOURCES.SYSTEM_LOG, 'read', findResult);
      return findResult;
    }

    var records = findResult.data.records || [];
    var result = {
      status: 'OK',
      mode: mode,
      eligible: records.length,
      archived: 0,
      deleted: 0,
      cutoffMs: cutoffMs,
      malformedTimestamps: findResult.data.malformedTimestamps || 0
    };

    if (result.malformedTimestamps) {
      this._log('RETENTION_SKIP', true, {
        source: this.SOURCES.SYSTEM_LOG,
        mode: mode,
        malformedTimestamps: result.malformedTimestamps,
        reason: 'PROTECTED_OR_UNUSABLE_ROWS'
      });
    }

    if (records.length === 0) return Result.ok(result);

    if (mode === this.MODES.DRY_RUN) {
      this._log('RETENTION_SKIP', true, {
        source: this.SOURCES.SYSTEM_LOG,
        mode: mode,
        eligible: records.length,
        reason: 'DRY_RUN'
      });
      return Result.ok(result);
    }

    var archiveResult = LogArchiveRepository.archiveRecords(records);
    if (!archiveResult.ok) {
      this._stageFailure(this.SOURCES.SYSTEM_LOG, 'archive', archiveResult);
      return archiveResult;
    }
    result.archived = archiveResult.data.verified || 0;

    if (mode === this.MODES.ARCHIVE_ONLY) return Result.ok(result);

    var deleteResult = LogArchiveRepository.deleteRecords(records);
    if (!deleteResult.ok) {
      this._stageFailure(this.SOURCES.SYSTEM_LOG, 'delete', deleteResult);
      return deleteResult;
    }
    result.deleted = deleteResult.data.deleted || 0;

    return Result.ok(result);
  },

  _runAvailability: function(mode, nowMs) {
    var cutoffDate = DateUtils.clinicDateDaysAgo(
      DateUtils.fromTimestamp(nowMs),
      this.POLICIES.AVAILABILITY_DAYS
    );
    var findResult = AvailabilityArchiveRepository.findOlderThan(cutoffDate);
    if (!findResult.ok) {
      this._stageFailure(this.SOURCES.AVAILABILITY, 'read', findResult);
      return findResult;
    }

    var records = findResult.data.records || [];
    var result = {
      status: 'OK',
      mode: mode,
      eligible: records.length,
      archived: 0,
      deleted: 0,
      cutoffDate: cutoffDate,
      malformedSlotIds: findResult.data.malformedSlotIds || 0,
      malformedSortKeys: findResult.data.malformedSortKeys || 0,
      reservedSkipped: findResult.data.reservedSkipped || 0,
      ambiguousSlotIds: findResult.data.ambiguousSlotIds || 0
    };

    if (result.malformedSlotIds || result.malformedSortKeys || result.reservedSkipped || result.ambiguousSlotIds) {
      this._log('RETENTION_SKIP', true, {
        source: this.SOURCES.AVAILABILITY,
        mode: mode,
        cutoffDate: cutoffDate,
        malformedSlotIds: result.malformedSlotIds,
        malformedSortKeys: result.malformedSortKeys,
        reservedSkipped: result.reservedSkipped,
        ambiguousSlotIds: result.ambiguousSlotIds,
        reason: 'PROTECTED_OR_UNUSABLE_ROWS'
      });
    }

    if (records.length === 0) return Result.ok(result);

    if (mode === this.MODES.DRY_RUN) {
      this._log('RETENTION_SKIP', true, {
        source: this.SOURCES.AVAILABILITY,
        mode: mode,
        eligible: records.length,
        cutoffDate: cutoffDate,
        reason: 'DRY_RUN'
      });
      return Result.ok(result);
    }

    var archiveResult = AvailabilityArchiveRepository.archiveRecords(records);
    if (!archiveResult.ok) {
      this._stageFailure(this.SOURCES.AVAILABILITY, 'archive', archiveResult);
      return archiveResult;
    }
    result.archived = archiveResult.data.verified || 0;

    if (mode === this.MODES.ARCHIVE_ONLY) return Result.ok(result);

    var deleteResult = AvailabilityArchiveRepository.deleteRecords(records, cutoffDate);
    if (!deleteResult.ok) {
      this._stageFailure(this.SOURCES.AVAILABILITY, 'delete', deleteResult);
      return deleteResult;
    }
    result.deleted = deleteResult.data.deleted || 0;

    return Result.ok(result);
  },

  _resolveMode: function(requestedMode) {
    var mode = requestedMode;
    if (!mode) {
      try {
        mode = PropertiesService.getScriptProperties().getProperty(this.PROPERTY_KEY);
      } catch (e) {
        mode = null;
      }
    }
    if (!mode) mode = this.DEFAULT_MODE;

    if (!this.MODES.hasOwnProperty(mode)) {
      return Result.fail('RETENTION_MODE_INVALID',
        'RETENTION_MODE must be DRY_RUN, ARCHIVE_ONLY, or ARCHIVE_AND_DELETE', {
          value: mode
        });
    }

    return Result.ok({ mode: mode });
  },

  _stageFailure: function(source, phase, result) {
    var code = result && result.error && result.error.code ? result.error.code : '';
    var command = (code.indexOf('VERIFY') !== -1 || code.indexOf('ARCHIVE_VERIFY') !== -1)
      ? 'RETENTION_VERIFY_FAILED'
      : (phase === 'delete' ? 'RETENTION_DELETE_FAILED' : 'RETENTION_STAGE_FAILED');

    this._log(command, false, {
      source: source,
      phase: phase,
      error: result ? result.error : 'null result'
    });
  },

  _log: function(command, success, payload) {
    try {
      LogRepository.write({
        timestamp: Clock.now(),
        command: command,
        phone: '',
        slotId: '',
        stage: 'END',
        success: success,
        durationMs: null,
        error: JSON.stringify(payload || {})
      });
    } catch (e) {
      // Observability must never turn a safe retention result into a data
      // mutation or deletion path.
    }
  }
};
