/**
 * ═══════════════════════════════════════
 * CONTRACT — CalendarRepository
 * ═══════════════════════════════════════
 * يضمن:
 * - تحويل نتيجة GoogleCalendar (تُرجع قيمة خام أو ترمي استثناء) إلى Result
 *   موحّد (CAS-008 من وثيقة Result).
 * لا يضمن:
 * - أي علاقة بين الحدث و Slot — تلك معرفة تعيش في BookingService فقط،
 *   الذي يقرر متى يُنشأ/يُحذف الحدث ولماذا.
 *
 * ملاحظة: هذا الملف كان موجودًا في شجرة المجلدات الأصلية المعتمدة من
 * المشرف (Repositories/CalendarRepository.gs) ولم يُبنَ ضمن المرحلة
 * الثالثة. أُنشئ الآن لأن BookingService يحتاجه فعليًا، تعبئةً لفجوة
 * معتمدة سلفًا، وليس إضافة معمارية جديدة.
 */
const CalendarRepository = {
  /**
   * @param {Object} params - { title, startTime, endTime, description, calendarId }
   * @returns {Result}
   */
  createAppointmentEvent(params) {
    try {
      const eventId = GoogleCalendar.createEvent(params);
      return Result.ok({ eventId: eventId });
    } catch (e) {
      return Result.fail('CALENDAR_CREATE_FAILED', e.message, e.stack);
    }
  },

  /**
   * @param {string} eventId
   * @param {string} [calendarId]
   * @returns {Result}
   */
  deleteAppointmentEvent(eventId, calendarId) {
    try {
      const deleted = GoogleCalendar.deleteEvent(eventId, calendarId);
      return Result.ok({ deleted: deleted });
    } catch (e) {
      return Result.fail('CALENDAR_DELETE_FAILED', e.message, e.stack);
    }
  }
};