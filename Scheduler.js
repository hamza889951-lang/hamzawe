/**
 * Scheduler.js — v3 + Liveness + Archive
 * الترتيب: Archive → Maintenance → Horizon → Reminders → HealthCheck
 */
const Scheduler = {

  main: function() {
    // B5 — Scheduler orchestration serialization uses the UserLock, NOT the
    // global ScriptLock. Repository data atomicity keeps owning the ScriptLock
    // via Lock.runExclusive(); this Scheduler must therefore never hold the
    // ScriptLock across a stage that itself acquires it through
    // Lock.runExclusive() (Maintenance/Horizon/Reminders) — that is a nested
    // acquisition of the same global lock, the exact topology B5 removes — and
    // must not couple Scheduler orchestration to webhook atomicUpdate.
    //
    // The UserLock serializes Scheduler executions under the documented
    // deployment model, which is a precondition to verify at deploy time, not
    // a runtime fact asserted here: every Scheduler invocation (the single
    // daily time-driven trigger and manual RUN_scheduler) runs as the same
    // owner user — appsscript.json (webapp executeAs: USER_DEPLOYING) and
    // PROJECT_CONTEXT.md §5 ("Google services run as the deploying user"),
    // §11 (trigger configured manually by the owner), §12 (single daily
    // trigger). (Supervisor decision — B5.)
    var schedulerLock = LockService.getUserLock();
    var hasLock = false;

    try { schedulerLock.waitLock(1000); hasLock = true; } catch (e) {
      LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_LOCKED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: 'Another Scheduler instance is already running' });
      return Result.ok({ status: 'SKIPPED', reason: 'Locked by concurrent run' });
    }

    try {
      var startedAt = Clock.now();
      var S = { archive: { status: 'NOT_RUN', error: null }, maintenance: { status: 'NOT_RUN', error: null }, horizon: { status: 'NOT_RUN', error: null }, reminders: { status: 'NOT_RUN', error: null }, healthCheck: { status: 'NOT_RUN', error: null } };

      try { var aResult = ArchiveService.run(); if (aResult && aResult.ok) { S.archive.status = 'OK'; } else { S.archive.status = 'FAILED'; S.archive.error = aResult ? JSON.stringify(aResult.error) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'archive', error: S.archive.error }) }); } } catch (e) { S.archive.status = 'FAILED'; S.archive.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'archive', error: e.message }) }); }

      try { var mResult = MaintenanceService.run(); if (mResult && mResult.ok) { S.maintenance.status = 'OK'; } else { S.maintenance.status = 'FAILED'; S.maintenance.error = mResult ? JSON.stringify(mResult.error) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'maintenance', error: S.maintenance.error }) }); } } catch (e) { S.maintenance.status = 'FAILED'; S.maintenance.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'maintenance', error: e.message }) }); }

      try { var hResult = AvailabilityHorizonMaintainer.ensureHorizon(); if (hResult && hResult.ok) { S.horizon.status = 'OK'; } else { S.horizon.status = 'FAILED'; S.horizon.error = hResult ? JSON.stringify(hResult.error) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'horizon', error: S.horizon.error }) }); } } catch (e) { S.horizon.status = 'FAILED'; S.horizon.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'horizon', error: e.message }) }); }

      try { var rResult = ReminderService.processPendingReminders(function(phone, message) { return WhatsAppAdapter.sendMessage(phone, message); }); if (rResult && rResult.ok) { S.reminders.status = 'OK'; } else { S.reminders.status = 'FAILED'; S.reminders.error = rResult ? JSON.stringify(rResult.error) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'reminders', error: S.reminders.error }) }); } } catch (e) { S.reminders.status = 'FAILED'; S.reminders.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'reminders', error: e.message }) }); }

      try { var hcResult = HealthCheckService.run(); if (hcResult && hcResult.ok && hcResult.data && hcResult.data.healthy) { S.healthCheck.status = 'OK'; } else { S.healthCheck.status = 'FAILED'; S.healthCheck.error = (hcResult && hcResult.data) ? JSON.stringify(hcResult.data) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'healthCheck', error: S.healthCheck.error }) }); } } catch (e) { S.healthCheck.status = 'FAILED'; S.healthCheck.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'healthCheck', error: e.message }) }); }

      var operationalOk = S.maintenance.status === 'OK' && S.horizon.status === 'OK' && S.reminders.status === 'OK' && S.healthCheck.status === 'OK';
      var allOk = operationalOk && S.archive.status === 'OK';
      var finishedAt = Clock.now();
      var durationMs = finishedAt.getTime() - startedAt.getTime();
      var summary = { archive: S.archive.status === 'OK' ? 'OK' : S.archive.error, maintenance: S.maintenance.status === 'OK' ? 'OK' : S.maintenance.error, horizon: S.horizon.status === 'OK' ? 'OK' : S.horizon.error, reminders: S.reminders.status === 'OK' ? 'OK' : S.reminders.error, healthCheck: S.healthCheck.status === 'OK' ? 'OK' : S.healthCheck.error };

      LogRepository.write({ timestamp: finishedAt, command: 'SCHEDULER_RUN', phone: '', slotId: '', stage: 'END', success: allOk, durationMs: durationMs, error: JSON.stringify(summary) });

      if (operationalOk) {
        try { PropertiesService.getScriptProperties().setProperty('LAST_SCHEDULER_SUCCESS_MS', String(finishedAt.getTime())); } catch (e) { /* best effort */ }
        if (allOk) {
          return Result.ok({ stages: { archive: 'OK', maintenance: 'OK', horizon: 'OK', reminders: 'OK', healthCheck: 'OK' }, durationMs: durationMs });
        }
        return Result.ok({ stages: { archive: 'FAILED', maintenance: 'OK', horizon: 'OK', reminders: 'OK', healthCheck: 'OK' }, archiveWarning: summary.archive, durationMs: durationMs });
      }
      return Result.fail('SCHEDULER_PARTIAL_FAILURE', 'One or more Scheduler stages failed', { stages: { archive: S.archive.status, maintenance: S.maintenance.status, horizon: S.horizon.status, reminders: S.reminders.status, healthCheck: S.healthCheck.status }, details: summary, durationMs: durationMs });

    } finally {
      if (hasLock) { try { schedulerLock.releaseLock(); } catch (e) { /* best effort */ } }
    }
  }
};
