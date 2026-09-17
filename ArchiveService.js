/**
 * ArchiveService.js — compatibility facade
 *
 * The retention policy and storage lifecycle now live in RetentionService.
 * This facade preserves the historical ArchiveService.run() call boundary
 * for existing callers while applying the frozen 31-day SYSTEM_LOG policy.
 */
const ArchiveService = {
  run: function() {
    return RetentionService.run({
      sources: [RetentionService.SOURCES.SYSTEM_LOG]
    });
  }
};
