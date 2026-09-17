/**
 * ArchiveService.js — compatibility facade
 *
 * The retention policy and storage lifecycle live in RetentionService.
 * ArchiveService.run() remains the existing Scheduler call boundary.
 *
 * Scheduled retention is an explicit operational opt-in. This protects the
 * daily Scheduler SLA while keeping RetentionService available for an
 * intentional/manual migration run.
 */
const ArchiveService = {
  SCHEDULER_ENABLED_KEY: 'RETENTION_SCHEDULER_ENABLED',

  run: function() {
    if (!this._schedulerEnabled()) {
      return Result.ok({
        status: 'SKIPPED',
        reason: 'RETENTION_SCHEDULER_DISABLED'
      });
    }

    return RetentionService.run({
      sources: [RetentionService.SOURCES.SYSTEM_LOG]
    });
  },

  _schedulerEnabled: function() {
    try {
      var value = PropertiesService.getScriptProperties().getProperty(this.SCHEDULER_ENABLED_KEY);
      return String(value || '').trim().toUpperCase() === 'TRUE';
    } catch (e) {
      return false;
    }
  }
};
