/**
 * RetentionScheduler.js — dedicated historical-retention entry point
 *
 * This function is intentionally separate from Scheduler.main(). Retention is
 * historical-data maintenance and may be slow; it must not consume the daily
 * operational Scheduler execution budget.
 *
 * Apps Script should bind a separate time-driven trigger to
 * runRetentionScheduler(). Trigger timing must be chosen so it does not depend
 * on the operational Scheduler completing first.
 */
const RetentionScheduler = {

  main: function() {
    var startedAt = Clock.now();
    var result;

    try {
      result = ArchiveService.run();
    } catch (e) {
      result = Result.fail(
        'RETENTION_SCHEDULER_EXCEPTION',
        e.message || 'Retention Scheduler exception',
        { message: e.message, stack: e.stack }
      );
    }

    var finishedAt = Clock.now();
    var durationMs = finishedAt.getTime() - startedAt.getTime();
    var ok = !!(result && result.ok);

    try {
      LogRepository.write({
        timestamp: finishedAt,
        command: 'RETENTION_SCHEDULER_RUN',
        phone: '',
        slotId: '',
        stage: 'END',
        success: ok,
        durationMs: durationMs,
        error: JSON.stringify(result && result.ok ? result.data : (result ? result.error : null))
      });
    } catch (logError) {
      // Retention result must not be converted into failure by diagnostics.
    }

    if (result && result.ok) {
      return Result.ok({
        durationMs: durationMs,
        retention: result.data
      });
    }

    return Result.fail(
      result && result.error ? result.error.code : 'RETENTION_SCHEDULER_FAILED',
      result && result.error ? result.error.message : 'Retention Scheduler failed',
      {
        durationMs: durationMs,
        retention: result && result.error ? result.error.details : null
      }
    );
  }
};

/**
 * Apps Script time-driven trigger entry point.
 */
function runRetentionScheduler() {
  return RetentionScheduler.main();
}
