/**
 * ═══════════════════════════════════════
 * CONTRACT — SettingsRepository
 * ═══════════════════════════════════════
 * يضمن:
 * - قراءة إعدادات العيادة كقيم، لا كصف.
 * - توفير getSlotDurationMinutes() كمصدر الحقيقة الوحيد لمدة الفتحة
 *   الزمنية (CAS-005/CAS-006) — أُضيفت بقرار معماري لمنع تكرار قراءة
 *   هذا الإعداد داخل أكثر من Service (كانت مكررة سابقًا في
 *   BookingService وChangeService، وهذا كان يخالف CAS-005).
 *
 * لا يضمن:
 * - أي تحقق من صحة القيم.
 *
 * ═══════════════════════════════════════
 * قرار إصدار (لا يزال قائمًا)
 * ═══════════════════════════════════════
 * v1: عيادة واحدة فقط، صف إعدادات واحد → getAll تعيد rows[0] دائمًا.
 * v2: عند دعم عدة عيادات، يُعاد تصميم هذا الملف ليقبل clinicId ويبحث
 * عن الصف المطابق، بدل افتراض صف واحد ثابت.
 *
 * ═══════════════════════════════════════
 * ملاحظة بخصوص getSlotDurationMinutes (قرار المشرف)
 * ═══════════════════════════════════════
 * لا تُعتبر مدة الفتحة قيمة ثابتة في النظام (لذلك لا تنتقل إلى
 * Config.SYSTEM_POLICY) — بل قيمة تشغيلية تُقرأ من ورقة Settings.
 * لذلك مكانها الطبيعي هنا فقط، وليس داخل أي Service مستهلك لها.
 */
const SettingsRepository = {

  // اسم المفتاح الفعلي في ورقة Settings.
  // ⚠️ افتراض بيانات يحتاج تأكيد المشرف مقابل ورقة Settings الفعلية.
  SLOT_DURATION_SETTINGS_KEY: 'Slot Duration (min)',

  // القيمة الافتراضية عند تعذّر قراءة الإعداد أعلاه.
  DEFAULT_SLOT_DURATION_MINUTES: 30,

  getAll() {
    const rows = GoogleSheets.getAllRows(Config.VOCABULARY.SHEETS.SETTINGS);
    if (!rows.length) {
      throw new Error('SETTINGS_NOT_CONFIGURED');
    }
    return rows[0];
  },

  get(key) {
    const settings = this.getAll();
    return settings[key];
  },

  /**
   * Result-based read of the settings row (first row in v1 single-clinic).
   * Distinguishes sheet/storage failure from unconfigured state.
   * @returns {Result} ok(row) | fail(SETTINGS_NOT_CONFIGURED | SETTINGS_READ_FAILED)
   */
  getSettingsResult() {
    try {
      const rows = GoogleSheets.getAllRows(Config.VOCABULARY.SHEETS.SETTINGS);
      if (!rows || !rows.length) {
        return Result.fail('SETTINGS_NOT_CONFIGURED', 'Settings sheet is empty or not configured');
      }
      return Result.ok(rows[0]);
    } catch (e) {
      return Result.fail('SETTINGS_READ_FAILED', e.message, e.stack);
    }
  },

  /**
   * مصدر الحقيقة الوحيد لمدة الفتحة الزمنية بالدقائق.
   * يُستخدم من BookingService وChangeService دون أي نسخ محلي.
   * @returns {number}
   */
  getSlotDurationMinutes() {
    try {
      const configured = this.get(this.SLOT_DURATION_SETTINGS_KEY);
      const parsed = Number(configured);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    } catch (e) {
      // الإعدادات غير متاحة — استخدام القيمة الافتراضية
    }
    return this.DEFAULT_SLOT_DURATION_MINUTES;
  },

  /**
   * Returns duration with provenance (CONFIGURED vs DEFAULT_FALLBACK).
   * M1-C: 30 configured ≠ 30 fallback.
   * @returns {{minutes: number, source: string}}
   */
  getSlotDurationInfo() {
    try {
      const settingsResult = this.getSettingsResult();
      if (settingsResult.ok) {
        const configured = settingsResult.data[this.SLOT_DURATION_SETTINGS_KEY];
        const parsed = Number(configured);
        if (!isNaN(parsed) && parsed > 0) {
          return {
            minutes: parsed,
            source: 'CONFIGURED'
          };
        }
      }
    } catch (e) {
      // settings unavailable
    }
    return {
      minutes: this.DEFAULT_SLOT_DURATION_MINUTES,
      source: 'DEFAULT_FALLBACK'
    };
  }
};