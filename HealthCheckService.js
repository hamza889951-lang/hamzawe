/**
 * HealthCheckService.gs
 * تُستدعى من Scheduler.main لتفحص صحة النظام + Liveness.
 *
 * ═══ فصل Liveness عن health failure ═══
 * healthy: false ← مشاكل تشغيلية حقيقية (Availability, Settings, SYSTEM_LOG)
 * warnings: [...] ← تحذيرات تشخيصية (Liveness > 25 ساعة)
 *
 * Liveness warning لا يجعل healthy = false، حتى لا يمنع
 * الدورة الحالية من تسجيل نجاحها بعد التعافي.
 */
const HealthCheckService = {

  H25: 25 * 60 * 60 * 1000,
  H23: 23 * 60 * 60 * 1000,

  run: function() {
    var issues = [];
    var warnings = [];

    try {
      var allSlots = GoogleSheets.getAllRows(Config.VOCABULARY.SHEETS.AVAILABILITY);
      if (!allSlots || allSlots.length === 0) { issues.push('لا توجد فتحات في Availability'); }
    } catch (e) { issues.push('فشل قراءة Availability: ' + e.message); }

    try {
      var logRows = GoogleSheets.getAllRows(Config.VOCABULARY.SHEETS.SYSTEM_LOG);
      if (!logRows || logRows.length === 0) { issues.push('SYSTEM_LOG فارغ'); }
    } catch (e) { issues.push('فشل قراءة SYSTEM_LOG: ' + e.message); }

    try {
      var settings = SettingsRepository.getAll();
      if (!settings || !settings.work_start) { issues.push('Settings غير مكتملة'); }
    } catch (e) { issues.push('فشل قراءة Settings: ' + e.message); }

    // ── Liveness: تحذير تشخيصي ← لا يؤثر على healthy ──
    try {
      var lastSuccessStr = PropertiesService.getScriptProperties().getProperty('LAST_SCHEDULER_SUCCESS_MS');
      if (lastSuccessStr) {
        var lastSuccessMs = parseInt(lastSuccessStr, 10);
        var nowMs = Clock.now().getTime();
        if (nowMs - lastSuccessMs > this.H25) {
          var shouldAlert = true;
          var lastAlertStr = PropertiesService.getScriptProperties().getProperty('LAST_LIVENESS_ALERT_MS');
          if (lastAlertStr) {
            var lastAlertMs = parseInt(lastAlertStr, 10);
            if (nowMs - lastAlertMs < this.H23) { shouldAlert = false; }
          }
          if (shouldAlert) {
            var warningMsg = 'LIVENESS: لم يتم تشغيل Scheduler بنجاح منذ أكثر من 25 ساعة';
            warnings.push(warningMsg);
            PropertiesService.getScriptProperties().setProperty('LAST_LIVENESS_ALERT_MS', String(nowMs));
            try {
              var adminPhone = PropertiesService.getScriptProperties().getProperty('ADMIN_PHONE');
              if (adminPhone) { WhatsAppAdapter.sendMessage(adminPhone, warningMsg); }
            } catch (e2) { /* best effort */ }
          }
        }
      }
    } catch (e) { /* best effort */ }

    var healthy = issues.length === 0;

    LogRepository.write({
      timestamp: Clock.now(),
      command: 'HEALTH_CHECK',
      phone: '',
      slotId: '',
      stage: 'END',
      success: healthy,
      durationMs: null,
      error: JSON.stringify({ healthy: healthy, issues: issues, warnings: warnings })
    });

    return Result.ok({ healthy: healthy, issues: issues, warnings: warnings });
  }
};
