/**
 * Scheduler.js — P0 Hardening v3
 * ADR-020: كل مرحلة مستقلة، كل فشل يسجّل، SCHEDULER_RUN صادق
 * P1 fix: Result.fail عند allOk === false
 */
const Scheduler = {

  main: function() {
    var scriptLock = LockService.getScriptLock();
    var hasLock = false;

    try {
      scriptLock.waitLock(1000);
      hasLock = true;
    } catch (e) {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'SCHEDULER_LOCKED',
        phone: '',
        slotId: '',
        stage: 'END',
        success: false,
        durationMs: null,
        error: 'Another Scheduler instance is already running'
      });
      return Result.ok({ status: 'SKIPPED', reason: 'Locked by concurrent run' });
    }

    try {

      var startedAt = Clock.now();

      var stages = {
        maintenance: { status: 'NOT_RUN', error: null },
        horizon:     { status: 'NOT_RUN', error: null },
        reminders:   { status: 'NOT_RUN', error: null },
        healthCheck: { status: 'NOT_RUN', error: null }
      };

      // ── 1. الصيانة ──
      try {
        var mResult = MaintenanceService.run();
        if (mResult && mResult.ok) {
          stages.maintenance.status = 'OK';
        } else {
          stages.maintenance.status = 'FAILED';
          stages.maintenance.error = mResult ? JSON.stringify(mResult.error) : 'null result';
          LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'maintenance', error: stages.maintenance.error }) });
        }
      } catch (e) {
        stages.maintenance.status = 'FAILED';
        stages.maintenance.error = e.message || 'Exception';
        LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'maintenance', error: e.message }) });
      }

      // ── 2. توليد الفتحات ──
      try {
        var hResult = AvailabilityHorizonMaintainer.ensureHorizon();
        if (hResult && hResult.ok) {
          stages.horizon.status = 'OK';
        } else {
          stages.horizon.status = 'FAILED';
          stages.horizon.error = hResult ? JSON.stringify(hResult.error) : 'null result';
          LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'horizon', error: stages.horizon.error }) });
        }
      } catch (e) {
        stages.horizon.status = 'FAILED';
        stages.horizon.error = e.message || 'Exception';
        LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'horizon', error: e.message }) });
      }

      // ── 3. تذكيرات ──
      try {
        var rResult = ReminderService.processPendingReminders(
          function(phone, message) {
            return WhatsAppAdapter.sendMessage(phone, message);
          }
        );
        if (rResult && rResult.ok) {
          stages.reminders.status = 'OK';
        } else {
          stages.reminders.status = 'FAILED';
          stages.reminders.error = rResult ? JSON.stringify(rResult.error) : 'null result';
          LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'reminders', error: stages.reminders.error }) });
        }
      } catch (e) {
        stages.reminders.status = 'FAILED';
        stages.reminders.error = e.message || 'Exception';
        LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'reminders', error: e.message }) });
      }

      // ── 4. فحص صحي ──
      try {
        var hcResult = HealthCheckService.run();
        if (hcResult && hcResult.ok && hcResult.data && hcResult.data.healthy) {
          stages.healthCheck.status = 'OK';
        } else {
          stages.healthCheck.status = 'FAILED';
          stages.healthCheck.error = (hcResult && hcResult.data) ? JSON.stringify(hcResult.data) : 'null result';
          LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'healthCheck', error: stages.healthCheck.error }) });
        }
      } catch (e) {
        stages.healthCheck.status = 'FAILED';
        stages.healthCheck.error = e.message || 'Exception';
        LogRepository.write({ timestamp: Clock.now(), command: 'SCHEDULER_STAGE_FAILED', phone: '', slotId: '', stage: 'END', success: false, durationMs: null, error: JSON.stringify({ stage: 'healthCheck', error: e.message }) });
      }

      var allOk = stages.maintenance.status === 'OK' &&
                  stages.horizon.status === 'OK' &&
                  stages.reminders.status === 'OK' &&
                  stages.healthCheck.status === 'OK';

      var finishedAt = Clock.now();
      var durationMs = finishedAt.getTime() - startedAt.getTime();

      var stageSummary = {
        maintenance: stages.maintenance.status === 'OK' ? 'OK' : stages.maintenance.error,
        horizon: stages.horizon.status === 'OK' ? 'OK' : stages.horizon.error,
        reminders: stages.reminders.status === 'OK' ? 'OK' : stages.reminders.error,
        healthCheck: stages.healthCheck.status === 'OK' ? 'OK' : stages.healthCheck.error
      };

      LogRepository.write({
        timestamp: finishedAt,
        command: 'SCHEDULER_RUN',
        phone: '',
        slotId: '',
        stage: 'END',
        success: allOk,
        durationMs: durationMs,
        error: JSON.stringify(stageSummary)
      });

      if (allOk) {
        return Result.ok({
          stages: {
            maintenance: 'OK',
            horizon: 'OK',
            reminders: 'OK',
            healthCheck: 'OK'
          },
          durationMs: durationMs
        });
      }

      return Result.fail(
        'SCHEDULER_PARTIAL_FAILURE',
        'One or more Scheduler stages failed',
        {
          stages: {
            maintenance: stages.maintenance.status,
            horizon: stages.horizon.status,
            reminders: stages.reminders.status,
            healthCheck: stages.healthCheck.status
          },
          details: stageSummary,
          durationMs: durationMs
        }
      );

    } finally {
      if (hasLock) {
        try { scriptLock.releaseLock(); } catch (e) { /* best effort */ }
      }
    }
  }
};
