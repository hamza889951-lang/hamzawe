/**
 * Scheduler.js — Operational Scheduler
 *
 * Retention/archive is intentionally NOT an operational Scheduler stage.
 * The operational Scheduler owns only the daily clinic stages:
 *   Maintenance → Horizon → Patient Disruption → Reminders → HealthCheck
 *
 * Retention has its own dedicated entry point in RetentionScheduler.js so a
 * slow historical-data operation can never consume the operational Scheduler
 * execution budget.
 */
const Scheduler = {

  main: function() {
    // B5 — Scheduler orchestration serialization uses the UserLock, NOT the
    // global ScriptLock. Repository data atomicity keeps owning the ScriptLock
    // via Lock.runExclusive(); this Scheduler must therefore never hold the
    // ScriptLock across a stage that itself acquires it through
    // Lock.runExclusive() (Maintenance/Horizon/Reminders) — that is a nested
    // acquisition of the same global lock, the exact topology B5 removes —
    // and must not couple Scheduler orchestration to webhook atomicUpdate.
    //
    // The UserLock serializes Scheduler executions under the documented
    // deployment model, which is a precondition to verify at deploy time, not
    // a runtime fact asserted here: every Scheduler invocation (the single
    // daily time-driven trigger and manual RUN_scheduler) runs as the same
    // owner user.
    var schedulerLock = LockService.getUserLock();
    var hasLock = false;

    try { schedulerLock.waitLock(1000); hasLock = true; } catch (e) {
      LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_LOCKED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: 'Another Scheduler instance is already running' });
      return Result.ok({ status: 'SKIPPED', reason: 'Locked by concurrent run' });
    }

    try {
      var startedAt = Clock.now();
      var S = { maintenance: { status: 'NOT_RUN', error: null }, horizon: { status: 'NOT_RUN', error: null }, disruption: { status: 'NOT_RUN', error: null }, reminders: { status: 'NOT_RUN', error: null }, healthCheck: { status: 'NOT_RUN', error: null } };
      var stageDurationsMs = {};

      var stageStartedAt = Clock.now();
      try { var mResult = MaintenanceService.run(); if (mResult && mResult.ok) { S.maintenance.status = 'OK'; } else { S.maintenance.status = 'FAILED'; S.maintenance.error = mResult ? JSON.stringify(mResult.error) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'maintenance', error: S.maintenance.error }) }); } } catch (e) { S.maintenance.status = 'FAILED'; S.maintenance.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'maintenance', error: e.message }) }); }
      stageDurationsMs.maintenance = Clock.now().getTime() - stageStartedAt.getTime();

      stageStartedAt = Clock.now();
      try { var hResult = AvailabilityHorizonMaintainer.ensureHorizon(); if (hResult && hResult.ok) { S.horizon.status = 'OK'; } else { S.horizon.status = 'FAILED'; S.horizon.error = hResult ? JSON.stringify(hResult.error) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'horizon', error: S.horizon.error }) }); } } catch (e) { S.horizon.status = 'FAILED'; S.horizon.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'horizon', error: e.message }) }); }
      stageDurationsMs.horizon = Clock.now().getTime() - stageStartedAt.getTime();

      // M4-F — Patient Disruption Processing (Contract §9): runs after the
      // availability/horizon materialization stage and before reminders.
      stageStartedAt = Clock.now();
      try { var dResult = PatientDisruptionService.processDisruptions({ sendFn: function(phone, message, options) { return MessagingPolicyService.sendProactive(phone, message, options); } }); if (dResult && dResult.ok) { S.disruption.status = 'OK'; } else { S.disruption.status = 'FAILED'; S.disruption.error = dResult ? JSON.stringify(dResult.error) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'disruption', error: S.disruption.error }) }); } } catch (e) { S.disruption.status = 'FAILED'; S.disruption.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'disruption', error: e.message }) }); }
      stageDurationsMs.disruption = Clock.now().getTime() - stageStartedAt.getTime();

      stageStartedAt = Clock.now();
      try { var rResult = ReminderService.processPendingReminders(function(phone, message, options) { return MessagingPolicyService.sendProactive(phone, message, options); }); if (rResult && rResult.ok) { S.reminders.status = 'OK'; } else { S.reminders.status = 'FAILED'; S.reminders.error = rResult ? JSON.stringify(rResult.error) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'reminders', error: S.reminders.error }) }); } } catch (e) { S.reminders.status = 'FAILED'; S.reminders.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'reminders', error: e.message }) }); }
      stageDurationsMs.reminders = Clock.now().getTime() - stageStartedAt.getTime();

      stageStartedAt = Clock.now();
      try { var hcResult = HealthCheckService.run(); if (hcResult && hcResult.ok && hcResult.data && hcResult.data.healthy) { S.healthCheck.status = 'OK'; } else { S.healthCheck.status = 'FAILED'; S.healthCheck.error = (hcResult && hcResult.data) ? JSON.stringify(hcResult.data) : 'null result'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'healthCheck', error: S.healthCheck.error }) }); } } catch (e) { S.healthCheck.status = 'FAILED'; S.healthCheck.error = e.message || 'Exception'; LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'healthCheck', error: e.message }) }); }
      stageDurationsMs.healthCheck = Clock.now().getTime() - stageStartedAt.getTime();

      var operationalOk = S.maintenance.status === 'OK' && S.horizon.status === 'OK' && S.disruption.status === 'OK' && S.reminders.status === 'OK' && S.healthCheck.status === 'OK';
      var finishedAt = Clock.now();
      var durationMs = finishedAt.getTime() - startedAt.getTime();
      var summary = { maintenance: S.maintenance.status === 'OK' ? 'OK' : S.maintenance.error, horizon: S.horizon.status === 'OK' ? 'OK' : S.horizon.error, disruption: S.disruption.status === 'OK' ? 'OK' : S.disruption.error, reminders: S.reminders.status === 'OK' ? 'OK' : S.reminders.error, healthCheck: S.healthCheck.status === 'OK' ? 'OK' : S.healthCheck.error };

      LogRepository.write({ timestamp: finishedAt, command: 'SCHEDULER_RUN', phone: '', slotId: '', stage: 'END', success: operationalOk, durationMs: durationMs, error: JSON.stringify({ stages: summary, stageDurationsMs: stageDurationsMs, retention: 'SEPARATED' }) });

      if (operationalOk) {
        try { PropertiesService.getScriptProperties().setProperty('LAST_SCHEDULER_SUCCESS_MS', String(finishedAt.getTime())); } catch (e) { /* best effort */ }
        return Result.ok({ stages: { maintenance: 'OK', horizon: 'OK', disruption: 'OK', reminders: 'OK', healthCheck: 'OK' }, durationMs: durationMs, stageDurationsMs: stageDurationsMs, retention: 'SEPARATED' });
      }
      return Result.fail('SCHEDULER_PARTIAL_FAILURE', 'One or more Scheduler stages failed', { stages: { maintenance: S.maintenance.status, horizon: S.horizon.status, disruption: S.disruption.status, reminders: S.reminders.status, healthCheck: S.healthCheck.status }, details: summary, durationMs: durationMs, stageDurationsMs: stageDurationsMs, retention: 'SEPARATED' });

    } finally {
      if (hasLock) { try { schedulerLock.releaseLock(); } catch (e) { /* best effort */ } }
    }
  }
};
