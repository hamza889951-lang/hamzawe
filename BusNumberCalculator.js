/**
 * ═══════════════════════════════════════
 * CONTRACT — BusNumberCalculator
 * ═══════════════════════════════════════
 *
 * يضمن:
 * - fromSlot(slot): يحسب رقم الباص لفتحة معينة، بناءً على وقت بداية
 *   الدوام ومدة الجلسة (من ورقة Settings). قيمة عرض بحتة — لا تخزين.
 * - fromTime(dateValue): يحسب رقم الباص من كائن Date مباشرة (يُستخدم
 *   عندما لا يتوفر كائن slot كامل — مثلاً من داخل ChangeService).
 *
 * لا يضمن:
 * - أي كتابة أو تخزين — Pure Function.
 * - أي معرفة بـ Slot أو Booking أو أي Service.
 *
 * ═══════════════════════════════════════
 * صيغة الحساب (بقرار مشرف)
 * ═══════════════════════════════════════
 * رقم الباص = (وقت الفتحة بالدقائق - وقت بداية الدوام بالدقائق)
 *             ÷ مدة الجلسة بالدقائق + 1
 *
 * مثال: دوام من 16:00، مدة الجلسة 15 دقيقة
 *   الفتحة 16:00 ← (960 - 960) / 15 + 1 = الباص 1
 *   الفتحة 16:15 ← (975 - 960) / 15 + 1 = الباص 2
 *   الفتحة 22:00 ← لا يوجد — 22:00 هي نهاية الدوام
 *   الفتحة 21:45 ← (1305 - 960) / 15 + 1 = الباص 24
 *
 * ═══════════════════════════════════════
 * ملاحظة: هذا الملف ليس Repository وليس Service — بل
 * Application Helper مستقل. مسؤوليته الوحيدة: حساب رقم الباص.
 * لا يعتمد عليه أي منطق أعمال — العرض فقط.
 */
const BusNumberCalculator = {

  /**
   * يحسب رقم الباص من كائن slot كامل (يحوي حقل time).
   * @param {Object} slot - صف من SlotRepository (يحوي slot.time كـ Date)
   * @returns {Result} data: { busNumber: number }
   */
  fromSlot(slot) {
    if (!slot || !slot.time) {
      return Result.fail('BUS_CALC_ERROR', 'Slot has no time field');
    }
    return this.fromTime(slot.time);
  },

  /**
   * يحسب رقم الباص من كائن Date مباشرة.
   * @param {Date} timeValue - وقت الفتحة
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

      // تحليل work_start (مثال: "16:00") — هذا هو مصدر الحقيقة
      // التشغيلي لبداية دوام العيادة من Settings.
      var startParts = this._parseHourMinuteText(workStart);
      if (!startParts) {
        return Result.fail('BUS_CALC_ERROR', 'Invalid work_start in Settings');
      }
      var startMinutes = startParts.hour * 60 + startParts.minute;

      // استخراج الساعة والدقيقة صراحةً وفق المنطقة الزمنية المضبوطة
      // للمشروع (appsscript.json / Session.getScriptTimeZone()). لا نعتمد
      // على Date.getHours()/getMinutes() لأنهما يتبعان المنطقة الزمنية
      // المحلية لبيئة التنفيذ وقد يخرجان وقتًا مضللًا عند التعامل مع
      // كائنات Date القادمة من Google Sheets.
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

  /**
   * يستخرج وقت العيادة المحلي من قيمة وقت قادمة من Sheets.
   * Date تُقرأ عبر Utilities.formatDate مع Session.getScriptTimeZone()
   * لضمان Asia/Baghdad المعلنة في إعداد المشروع، لا منطقة المضيف.
   * النص "HH:mm" مدعوم فقط كتمثيل ورقة/اختبار مباشر لنفس وقت العيادة.
   * @param {*} timeValue
   * @returns {{hour:number, minute:number}|null}
   */
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

  /**
   * @param {*} text
   * @returns {{hour:number, minute:number}|null}
   */
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
