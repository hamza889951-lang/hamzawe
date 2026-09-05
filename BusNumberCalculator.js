/**
 * ═══════════════════════════════════════
 * CONTRACT — BusNumberCalculator
 * ═══════════════════════════════════════
 *
 * يضمن:
 * - fromSlot(slot): يحسب رقم الباص لفتحة معينة، اعتمادًا على وقت
 *   الموعد التشغيلي canonical في sort_key، مع الحفاظ على دعم time
 *   كمسار توافق للبيانات القديمة التي لا تحتوي sort_key.
 * - fromTime(dateValue): يحسب رقم الباص من كائن Date مباشرة.
 *
 * لا يضمن:
 * - أي كتابة أو تخزين — Pure Function.
 * - أي معرفة بحجز أو دورة حياة الفتحة.
 *
 * ═══════════════════════════════════════
 * صيغة الحساب (بقرار المشرف)
 * ═══════════════════════════════════════
 * رقم الباص = (وقت الفتحة بالدقائق - وقت بداية الدوام بالدقائق)
 *             ÷ مدة الجلسة بالدقائق + 1
 *
 * مثال: دوام من 16:00، مدة الجلسة 15 دقيقة
 *   الفتحة 16:00 ← الباص 1
 *   الفتحة 16:15 ← الباص 2
 *   الفتحة 21:45 ← الباص 24
 *
 * ═══════════════════════════════════════
 * سبب استخدام sort_key في fromSlot:
 * - SlotSelection وLegacySlotTimeParser يعتمدان sort_key كتمثيل وقت
 *   الموعد التشغيلي للمقارنة والترتيب.
 * - Google Sheets قد يعيد حقل time كـ Date يحمل تمثيلًا زمنيًا غير
 *   مناسب لحساب وقت العيادة (وقت-only value)، وهو ما قد يحوّل فتحة صحيحة
 *   مثل 16:00 إلى ساعة قبل work_start ويؤدي إلى BUS_CALC_ERROR.
 * - لذلك منعت هذه الطبقة الاعتماد على Date time-only في fromSlot عندما
 *   يكون sort_key متوفرًا، من دون تغيير startTime/endTime الحقيقيين.
 */
const BusNumberCalculator = {

  /**
   * يحسب رقم الباص من صف Slot.
   * sort_key هو المصدر المفضل لوقت الموعد التشغيلي؛ time يبقى fallback
   * توافق فقط إذا كان sort_key غير متوفر.
   * @param {Object} slot
   * @returns {Result} data: { busNumber: number }
   */
  fromSlot(slot) {
    if (!slot) {
      return Result.fail('BUS_CALC_ERROR', 'Slot is missing');
    }

    if (slot.sort_key !== undefined && slot.sort_key !== null &&
      String(slot.sort_key).trim() !== '') {
      if (typeof LegacySlotTimeParser === 'undefined') {
        return Result.fail('BUS_CALC_ERROR', 'LegacySlotTimeParser is unavailable');
      }

      var comparableMs = LegacySlotTimeParser.toComparableTime(slot.sort_key);
      if (comparableMs === null || !isFinite(comparableMs)) {
        return Result.fail('BUS_CALC_ERROR', 'Invalid slot sort_key');
      }

      return this.fromTime(new Date(comparableMs));
    }

    if (!slot.time) {
      return Result.fail('BUS_CALC_ERROR', 'Slot has no time field');
    }
    return this.fromTime(slot.time);
  },

  /**
   * يحسب رقم الباص من كائن Date أو تمثيل وقت HH:mm.
   * @param {Date|string} timeValue
   * @returns {Result} data: { busNumber: number }
   */
  fromTime(timeValue) {
    if (!timeValue) {
      return Result.fail('BUS_CALC_ERROR', 'No time value provided');
    }

    try {
      var settings = SettingsRepository.getAll();
      var workStart = settings.work_start;
      var slotDuration = SettingsRepository.getSlotDurationMinutes();

      if (!workStart || !slotDuration || slotDuration <= 0) {
        return Result.fail('BUS_CALC_ERROR', 'Missing work_start or slot duration in Settings');
      }

      var startParts = this._parseHourMinuteText(workStart);
      if (!startParts) {
        return Result.fail('BUS_CALC_ERROR', 'Invalid work_start in Settings');
      }
      var startMinutes = startParts.hour * 60 + startParts.minute;

      var slotParts = this._extractClinicHourMinute(timeValue);
      if (!slotParts) {
        return Result.fail('BUS_CALC_ERROR', 'Invalid slot time value');
      }
      var slotMinutes = slotParts.hour * 60 + slotParts.minute;

      var busNumber = Math.floor((slotMinutes - startMinutes) / slotDuration) + 1;

      if (busNumber < 1) {
        return Result.fail('BUS_CALC_ERROR', 'Slot time is before work start');
      }

      return Result.ok({ busNumber: busNumber });
    } catch (e) {
      return Result.fail('BUS_CALC_ERROR', e.message || 'Unknown error calculating bus number');
    }
  },

  _extractClinicHourMinute(timeValue) {
    if (timeValue instanceof Date || Object.prototype.toString.call(timeValue) === '[object Date]') {
      if (isNaN(timeValue.getTime())) return null;
      var rendered = Utilities.formatDate(
        timeValue,
        Session.getScriptTimeZone(),
        'HH:mm'
      );
      return this._parseHourMinuteText(rendered);
    }

    if (typeof timeValue === 'string') {
      return this._parseHourMinuteText(timeValue);
    }

    return null;
  },

  _parseHourMinuteText(text) {
    if (typeof text !== 'string') return null;
    var match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    var hour = parseInt(match[1], 10);
    var minute = parseInt(match[2], 10);
    if (isNaN(hour) || isNaN(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour: hour, minute: minute };
  }
};
