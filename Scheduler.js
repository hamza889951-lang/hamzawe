/**
 * ═══════════════════════════════════════
 * CONTRACT — Scheduler
 * ═══════════════════════════════════════
 * (ADR-020: Scheduler هو Orchestrator، وليس مجرد Trigger)
 *
 * يضمن:
 * - نقطة دخول واحدة (main()) لكل المهام المجدوَلة.
 * - ترتيب التنفيذ: صيانة ← توليد فتحات ← تذكيرات.
 * - try/catch على مستوى main() كشبكة أمان أخيرة.
 *
 * لا يضمن:
 * - أي منطق عمل — كل المنطق في الخدمات التي يستدعيها.
 * - أي معرفة بـ Sheets أو Calendar أو UltraMsg مباشرة.
 *
 * آلية الاستدعاء:
 * - Google Apps Script Time Trigger (الإنتاج).
 * - الاختبارات اليدوية (تشغيل مباشر من المحرر).
 * - Web App: function doGet() { return Scheduler.main(); }
 *
 * ترتيب التنفيذ:
 * 1. MaintenanceService.run()
 * 2. AvailabilityHorizonMaintainer.ensureHorizon()
 * 3. ReminderService.processPendingReminders(sendFn)
 * 4. HealthCheckService.run()
 */
const Scheduler = {

  main: function() {
    var startedAt = Clock.now();
    var maintenanceResult = null;
    var remindersResult = null;

    try {

      maintenanceResult = MaintenanceService.run();

      AvailabilityHorizonMaintainer.ensureHorizon();

      remindersResult = ReminderService.processPendingReminders(
        function(phone, message) {
          return WhatsAppAdapter.sendMessage(phone, message);
        }
      );

      try {
        HealthCheckService.run();
      } catch (healthError) {
        LogRepository.write({
          timestamp: Clock.now(),
          command: 'HEALTH_CHECK_FAILED',
          phone: '',
          slotId: '',
          stage: 'END',
          success: false,
          durationMs: null,
          error: healthError.message || 'HealthCheck failed'
        });
      }

    } catch (e) {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'SCHEDULER_CRASH',
        phone: '',
        slotId: '',
        stage: 'END',
        success: false,
        durationMs: null,
        error: e.message || 'Unknown error in Scheduler.main()'
      });
    }

    var finishedAt = Clock.now();
    var durationMs = finishedAt.getTime() - startedAt.getTime();

    LogRepository.write({
      timestamp: finishedAt,
      command: 'SCHEDULER_RUN',
      phone: '',
      slotId: '',
      stage: 'END',
      success: true,
      durationMs: durationMs,
      error: JSON.stringify({
        maintenance: (maintenanceResult && maintenanceResult.ok) ? maintenanceResult.data : null,
        reminders: (remindersResult && remindersResult.ok) ? remindersResult.data : null
      })
    });

    return Result.ok({
      maintenance: (maintenanceResult && maintenanceResult.ok) ? maintenanceResult.data : null,
      reminders: (remindersResult && remindersResult.ok) ? remindersResult.data : null
    });
  }
};
