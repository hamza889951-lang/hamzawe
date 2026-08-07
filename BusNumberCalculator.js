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

      // تحليل work_start (مثال: "16:00")
      var startParts = workStart.split(':');
      var startMinutes = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);

      // استخراج الساعة والدقيقة من كائن Date
      var slotHour = timeValue.getHours();
      var slotMinute = timeValue.getMinutes();
      var slotMinutes = slotHour * 60 + slotMinute;

      var busNumber = Math.floor((slotMinutes - startMinutes) / slotDuration) + 1;

      if (busNumber < 1) {
        return Result.fail('BUS_CALC_ERROR', 'Slot time is before work start');
      }

      return Result.ok({ busNumber: busNumber });
    } catch (e) {
      return Result.fail('BUS_CALC_ERROR', e.message || 'Unknown error calculating bus number');
    }
  }
};
