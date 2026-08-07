/**
 * ═══════════════════════════════════════
 * CONTRACT — GoogleCalendar
 * ═══════════════════════════════════════
 * يضمن:
 *   - إنشاء/حذف حدث بمعرف صالح عند النجاح.
 * لا يضمن:
 *   - وجود التقويم المحدد (calendarId) مسبقاً.
 *   - نجاح الاتصال بالشبكة (يرمي استثناء يصعد للـ CommandExecutor).
 *   - أي علاقة بين الحدث و Slot — تلك معرفة تعيش في CalendarRepository فقط.
 */
/**
 * GoogleCalendar
 * الملف الوحيد المسموح له باستدعاء CalendarApp.
 * لا يعرف شيئاً عن Slot أو Appointment — فقط "حدث" (event) بمعناه العام.
 */
const GoogleCalendar = {

  _getCalendar(calendarId) {
    const calendar = calendarId
      ? CalendarApp.getCalendarById(calendarId)
      : CalendarApp.getDefaultCalendar();
    if (!calendar) throw new Error('CALENDAR_NOT_FOUND: ' + calendarId);
    return calendar;
  },

  /**
   * @param {Object} params - { title, startTime, endTime, description, calendarId }
   * @returns {string} calendarEventId
   */
  createEvent(params) {
    const calendar = this._getCalendar(params.calendarId);
    const event = calendar.createEvent(
      params.title,
      params.startTime,
      params.endTime,
      { description: params.description || '' }
    );
    return event.getId();
  },

  /** @returns {boolean} true إن حُذف الحدث، false إن لم يُوجد أصلاً */
  deleteEvent(eventId, calendarId) {
    const calendar = this._getCalendar(calendarId);
    const event = calendar.getEventById(eventId);
    if (!event) return false;
    event.deleteEvent();
    return true;
  }
};