/**
 * ArchiveService.js — compatibility facade
 *
 * The retention policy and storage lifecycle now live in RetentionService.
 * This facade preserves the historical ArchiveService.run() call boundary.
 *
 * Scheduler safety:
 *   run()          = explicit/manual retention entry point
 *   runScheduled() = Scheduler entry point, opt-in via
 *                    RETENTION_SCHEDULER_ENABLED=TRUE
 *
 * The gate is orchestration policy only; there is still exactly one retention
 * engine: RetentionService.
 */
const ArchiveService = {
  SCHEDULER_ENABLED_KEY: 'RETENTION_SCHEDULER_ENABLED',

  run: function() {
    return RetentionService.run({
      sources: [RetentionService.SOURCES.SYSTEM_LOG]
    });
  },

  runScheduled: function() {
    if (!this._schedulerEnabled()) {
      return Result.ok({
        status: 'SKIPPED',
        reason: 'RETENTION_SCHEDULER_DISABLED'
      });
    }

    return this.run();
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
