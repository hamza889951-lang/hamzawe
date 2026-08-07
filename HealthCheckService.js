/**
 * HealthCheckService.gs
 * تُستدعى من Scheduler.main لتفحص صحة النظام.
 */
const HealthCheckService = {

  run: function() {
    var issues = [];

    try {
      var allSlots = GoogleSheets.getAllRows(Config.VOCABULARY.SHEETS.AVAILABILITY);
      if (!allSlots || allSlots.length === 0) {
        issues.push('لا توجد فتحات في Availability');
      }
    } catch (e) {
      issues.push('فشل قراءة Availability: ' + e.message);
    }

    try {
      var logRows = GoogleSheets.getAllRows(Config.VOCABULARY.SHEETS.SYSTEM_LOG);
      if (!logRows || logRows.length === 0) {
        issues.push('SYSTEM_LOG فارغ');
      }
    } catch (e) {
      issues.push('فشل قراءة SYSTEM_LOG: ' + e.message);
    }

    try {
      var settings = SettingsRepository.getAll();
      if (!settings || !settings.work_start) {
        issues.push('Settings غير مكتملة');
      }
    } catch (e) {
      issues.push('فشل قراءة Settings: ' + e.message);
    }

    if (issues.length === 0) {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'HEALTH_CHECK',
        phone: '',
        slotId: '',
        stage: 'END',
        success: true,
        durationMs: null,
        error: ''
      });
      return Result.ok({ healthy: true, issues: [] });
    }

    var report = 'تحذير صحة النظام:\n' + issues.join('\n');

    LogRepository.write({
      timestamp: Clock.now(),
      command: 'HEALTH_CHECK',
      phone: '',
      slotId: '',
      stage: 'END',
      success: false,
      durationMs: null,
      error: report
    });

    try {
      var adminPhone = PropertiesService.getScriptProperties().getProperty('ADMIN_PHONE');
      if (adminPhone) {
        WhatsAppAdapter.sendMessage(adminPhone, report);
      }
    } catch (e) {
      // لا نرمي
    }

    return Result.ok({ healthy: false, issues: issues });
  }
};
