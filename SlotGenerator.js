/**
 * ═══════════════════════════════════════
 * CONTRACT — SlotGenerator
 * ═══════════════════════════════════════
 * ADR-022 — Domain Helper
 *
 * تصنيف: Domain Helper — بلا حالة، بلا I/O.
 * كل الدوال Pure Functions تعمل على قيم ممررة إليها.
 *
 * قواعد صارمة:
 * - ممنوع SpreadsheetApp أو UrlFetchApp
 * - ممنوع new Date() لقراءة الوقت الحالي — استخدم Clock.now()
 * - ممنوع Utilities.formatDate — استخدم DateUtils
 *
 * ADR-022 exception: new Date() مسموح هنا للتحويلات
 * الخالصة فقط (نسخ من Date موجود، بناء من مكوّنات year/month/day)
 * وليس لقراءة الوقت الحالي من النظام.
 */
const SlotGenerator = {

  /**
   * يقرر هل نحتاج توليد فتحات جديدة، ومن أي تاريخ، وكم يومًا.
   *
   * @param {string|null} latestSortKey
   * @param {Object} settings — صف الإعدادات
   * @returns {Result}
   */
  calculateGenerationPlan: function(latestSortKey, settings) {
    var targetDays = parseInt(settings.slot_generation_days, 10) || 30;
    var today = Clock.now();
    today.setHours(0, 0, 0, 0);

    if (!latestSortKey) {
      return Result.ok({
        needsGeneration: true,
        startDate: today,
        daysCount: targetDays,
        reason: 'No slots found in the system'
      });
    }

    var lastSlotDate = SlotGenerator._parseSortKeyToDate(latestSortKey);
    if (!lastSlotDate) {
      return Result.fail('INVALID_SORT_KEY', 'Cannot parse sort_key: ' + latestSortKey);
    }
    lastSlotDate.setHours(0, 0, 0, 0);

    var diffMs = lastSlotDate.getTime() - today.getTime();
    var diffDays = Math.ceil(diffMs / 86400000);

    if (diffDays < targetDays) {
      var missingDays = targetDays - diffDays;
      // ADR-022 exception: new Date() هنا نسخ من Date موجود — ليس قراءة للوقت الحالي
      var startDate = new Date(lastSlotDate.getTime());
      startDate.setDate(startDate.getDate() + 1);

      return Result.ok({
        needsGeneration: true,
        startDate: startDate,
        daysCount: missingDays,
        reason: 'Only ' + diffDays + ' days ahead, need ' + targetDays + ' days'
      });
    }

    return Result.ok({
      needsGeneration: false,
      startDate: null,
      daysCount: 0,
      reason: 'System has ' + diffDays + ' days ahead (target: ' + targetDays + ')'
    });
  },

  /**
   * يولّد جميع فتحات يوم واحد.
   *
   * @param {Date} date — اليوم المطلوب
   * @param {Object} settings — صف الإعدادات (لقراءة work_start, work_end, أيام العمل فقط)
   * @param {number} slotDuration — مدة الجلسة بالدقائق (من SettingsRepository.getSlotDurationMinutes())
   * @returns {Object[]}
   */
  calculateDailySlots: function(date, settings, slotDuration) {
    var slots = [];
    var dur = slotDuration || 30;

    var startParts = settings.work_start.split(':');
    var endParts = settings.work_end.split(':');
    var startMinutes = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    var endMinutes = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);

    var currentMinutes = startMinutes;

    while (currentMinutes + dur <= endMinutes) {
      // ADR-022 exception: new Date() هنا نسخ من Date موجود — ليس قراءة للوقت الحالي
      var slotTime = new Date(date.getTime());
      slotTime.setHours(
        Math.floor(currentMinutes / 60),
        currentMinutes % 60,
        0,
        0
      );

      var slotId = IdGenerator.generateSlotId();

      slots.push({
        slot_id: slotId,
        date: DateUtils.formatDateForStorage(slotTime),
        time: DateUtils.formatTimeForStorage(slotTime),
        sort_key: DateUtils.formatSortKey(slotTime),
        status: Config.VOCABULARY.STATUS.FREE,
        is_available: true,
        patient_name: '',
        phone: '',
        calendar_event_id: '',
        Reminder_sent: false,
        whatsapp_message_id: '',
        reserved_until: '',
        reserved_until_unix: ''
      });

      currentMinutes += dur;
    }

    return slots;
  },

  /**
   * هل اليوم يوم عمل؟
   *
   * @param {Date} date
   * @param {Object} settings
   * @returns {boolean}
   */
  isWorkingDay: function(date, settings) {
    var dayOfWeek = date.getDay();
    var dayMapping = {
      0: settings.sunday,
      1: settings.monday,
      2: settings.tuesday,
      3: settings.wednesday,
      4: settings.thursday,
      5: settings.friday,
      6: settings.saturday
    };

    var value = dayMapping[dayOfWeek];
    if (value === true) return true;
    if (typeof value === 'string' && value.toUpperCase() === 'TRUE') return true;
    return false;
  },

  // ──────────────── أدوات داخلية ────────────────

  /**
   * يحوّل sort_key (صيغة "yyyyMMddHHmm") إلى كائن Date.
   * ADR-022 exception: new Date() هنا بناء من مكوّنات — ليس قراءة للوقت الحالي
   */
  _parseSortKeyToDate: function(sortKey) {
    if (!sortKey) return null;
    var str = (typeof sortKey === 'string') ? sortKey : String(sortKey);
    if (str.length < 8) return null;
    var year = parseInt(str.substring(0, 4), 10);
    var month = parseInt(str.substring(4, 6), 10) - 1;
    var day = parseInt(str.substring(6, 8), 10);
    // ADR-022 exception: بناء Date من مكوّنات رقمية خالصة
    return new Date(year, month, day);
  }
};
