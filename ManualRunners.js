/**
 * ═══════════════════════════════════════
 * ManualRunners.gs — دوال للتشغيل اليدوي
 * ═══════════════════════════════════════
 * 
 * هذه الدوال مجرد wrappers لتشغيل الخدمات من محرر Apps Script.
 * تظهر في قائمة "Run" في المحرر.
 * 
 * لا تحتوي منطق عمل — فقط استدعاءات.
 */

// ═══════════════════════════════════════
// اختبارات AvailabilityHorizonMaintainer
// ═══════════════════════════════════════

/**
 * Test 1: معاينة (Dry Run) — لا يكتب شيئاً
 */
function RUN_previewHorizon() {
  var result = AvailabilityHorizonMaintainer.preview();
  Logger.log('═══════════════════════════════════════');
  Logger.log('PREVIEW RESULT:');
  Logger.log('═══════════════════════════════════════');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

--- a/ManualRunners.js
+++ b/ManualRunners.js
@@ ... @@
 /**
+ * ⚠️ تحذير: هذا الاستدعاء اليدوي يستخدم نفس ScriptLock الذي
+ * يستخدمه Scheduler.main(). تشغيله أثناء دورة Scheduler
+ * سيؤدي إلى انتظار (LOCK_TIMEOUT بعد 5 ثوانٍ).
+ * يُستخدم فقط للتشغيل الطارئ خارج أوقات Scheduler.
+ *
  * Test 2 & 3: التوليد الفعلي
  */
 function RUN_ensureHorizon() {  var result = AvailabilityHorizonMaintainer.ensureHorizon();
  Logger.log('═══════════════════════════════════════');
  Logger.log('ENSURE HORIZON RESULT:');
  Logger.log('═══════════════════════════════════════');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// ═══════════════════════════════════════
// اختبار Scheduler الكامل
// ═══════════════════════════════════════

/**
 * Test 5: تشغيل Scheduler كاملاً
 */
function RUN_scheduler() {
  var result = Scheduler.main();
  Logger.log('═══════════════════════════════════════');
  Logger.log('SCHEDULER RESULT:');
  Logger.log('═══════════════════════════════════════');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

// ═══════════════════════════════════════
// أدوات تشخيصية مساعدة
// ═══════════════════════════════════════

/**
 * فحص آخر sort_key في النظام
 */
function RUN_checkLatestSortKey() {
  var result = SlotRepository.findLatestSortKey();
  Logger.log('Latest sort_key: ' + JSON.stringify(result));
  return result;
}

/**
 * فحص الإعدادات الحالية
 */
function RUN_checkSettings() {
  var settings = SettingsRepository.getAll();
  var duration = SettingsRepository.getSlotDurationMinutes();
  Logger.log('═══════════════════════════════════════');
  Logger.log('SETTINGS:');
  Logger.log('═══════════════════════════════════════');
  Logger.log(JSON.stringify(settings, null, 2));
  Logger.log('---');
  Logger.log('Slot Duration (via getSlotDurationMinutes): ' + duration);
  return settings;
}

/**
 * فحص شامل قبل التشغيل الأول
 */
function RUN_healthCheck() {
  Logger.log('═══════════════════════════════════════');
  Logger.log('SYSTEM HEALTH CHECK');
  Logger.log('═══════════════════════════════════════');
  
  try {
    // 1. الإعدادات
    var settings = SettingsRepository.getAll();
    Logger.log('✅ Settings loaded: ' + Object.keys(settings).length + ' keys');
    
    // 2. مدة الجلسة
    var duration = SettingsRepository.getSlotDurationMinutes();
    Logger.log('✅ Slot duration: ' + duration + ' minutes');
    
    // 3. آخر فتحة
    var latestResult = SlotRepository.findLatestSortKey();
    Logger.log('✅ Latest sort_key: ' + (latestResult.ok ? latestResult.data : 'FAILED'));
    
    // 4. الوقت الحالي
    Logger.log('✅ Clock.now(): ' + Clock.now());
    
    // 5. توليد ID اختباري
    var testId = IdGenerator.generateSlotId();
    Logger.log('✅ Sample generated ID: ' + testId);
    
    Logger.log('═══════════════════════════════════════');
    Logger.log('✅ SYSTEM READY');
    Logger.log('═══════════════════════════════════════');
    return true;
  } catch (e) {
    Logger.log('❌ HEALTH CHECK FAILED: ' + e.message);
    return false;
  }
}
