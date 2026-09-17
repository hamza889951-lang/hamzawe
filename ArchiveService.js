/**
 * ArchiveService.js — compatibility facade
 *
 * The retention policy and storage lifecycle live in RetentionService.
 * ArchiveService.run() is retained as the narrow SYSTEM_LOG retention entry
 * point used by the dedicated RetentionScheduler, not by Scheduler.main().
 */
const ArchiveService = {
  run: function() {
    return RetentionService.run({
      sources: [RetentionService.SOURCES.SYSTEM_LOG]
    });
  }
};
