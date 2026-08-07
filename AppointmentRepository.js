/**
 * ═══════════════════════════════════════
 * CONTRACT — AppointmentRepository
 * ═══════════════════════════════════════
 * يضمن:
 *   - واجهة موحّدة لبيانات "الحجز الفعلي" بصرف النظر عن مكان تخزينها فعلياً.
 * لا يضمن:
 *   - وجود مصدر بيانات مستقل عن Slot في v1.
 *
 * تصنيف رسمي (ADR-010): Compatibility Layer.
 * ليس "تغليفاً" مؤقتاً عابراً، بل قرار معماري متعمد: يجوز إنشاء Repository
 * لكيان لم ينفصل تخزينياً بعد، إذا كان وجوده يمنع تعديل Application مستقبلاً
 * عند فصل هذا الكيان فعلياً. BookingService سيتحدث مع هذا الملف من اليوم
 * الأول، وعند فصل Appointment تخزينياً مستقبلاً، يُعاد كتابة هذا الملف فقط.
 */
const AppointmentRepository = {

  findBySlotId(slotId) {
    return SlotRepository.findById(slotId);
  },

  findActiveByPhone(phone) {
    return SlotRepository.findByPhoneAndStatus(phone, Config.VOCABULARY.STATUS.CONFIRMED);
  },

  attachCalendarEvent(slotId, calendarEventId) {
    return SlotRepository.atomicUpdate(slotId, function() {
      return Result.ok({ calendar_event_id: calendarEventId });
    });
  }
};