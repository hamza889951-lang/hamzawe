/**
 * CalendarRepository
 *
 * Wraps GoogleCalendar raw calls in the project Result contract. Generic
 * Booking paths remain intact; B6 lifecycle paths use the B6-specific methods
 * below for operation correlation and explicit delete/absence observations.
 */
const CalendarRepository = {
  createAppointmentEvent(params) {
    try {
      const appointmentParams = Object.assign({}, params || {});
      if (typeof CalendarRsvpConfigRepository !== 'undefined') {
        const config = CalendarRsvpConfigRepository.getRuntimeConfig();
        const active = CalendarRsvpConfigRepository.getActive();
        if (active && active.ok && active.data) {
          if (!config.ok) return config;
          const binding = CalendarRsvpConfigRepository.validateConfigBinding(config.data, true);
          if (!binding.ok) return binding;
          const trusted = CalendarRsvpConfigRepository.validateTrustedOperator(config.data);
          if (!trusted.ok) return trusted;
          appointmentParams.calendarId = config.data.calendarId;
          appointmentParams.secretaryEmail = config.data.secretaryEmail;
        }
      }
      const eventId = GoogleCalendar.createEvent(appointmentParams);
      return Result.ok({ eventId: eventId });
    } catch (e) { return Result.fail('CALENDAR_CREATE_FAILED', e.message, e.stack); }
  },
  createLifecycleAppointmentEvent(params) {
    try { return Result.ok(GoogleCalendar.createLifecycleEvent(params)); }
    catch (e) { return Result.fail('CALENDAR_CREATE_OUTCOME_UNKNOWN', e.message, e.stack); }
  },
  resolveAppointmentEventIdentity(eventId, calendarId) {
    try { return Result.ok(GoogleCalendar.resolveAppointmentEventIdentity(eventId, calendarId)); }
    catch (e) { return Result.fail('CALENDAR_EVENT_IDENTITY_RESOLUTION_FAILED', e.message, e.stack); }
  },
  inspectLifecycleAppointmentEvent(eventId, calendarId, expectedOperationId) {
    try { return Result.ok(GoogleCalendar.inspectLifecycleEvent(eventId, calendarId, expectedOperationId)); }
    catch (e) { return Result.fail('CALENDAR_LOOKUP_FAILED', e.message, e.stack); }
  },
  deleteLifecycleAppointmentEvent(eventId, calendarId, expectedOperationId) {
    try {
      const result = GoogleCalendar.deleteLifecycleEvent(eventId, calendarId, expectedOperationId);
      if (result.status !== 'ABSENCE_OBSERVED') return Result.fail('CALENDAR_ABSENCE_NOT_PROVEN', result.status, result);
      return Result.ok(result);
    } catch (e) { return Result.fail('CALENDAR_DELETE_OUTCOME_UNKNOWN', e.message, e.stack); }
  },
  findLifecycleEventsByOperationId(operationId, startTime, endTime, calendarId) {
    try { return Result.ok(GoogleCalendar.findLifecycleEventsByOperationId(operationId, startTime, endTime, calendarId)); }
    catch (e) { return Result.fail('CALENDAR_CORRELATION_LOOKUP_FAILED', e.message, e.stack); }
  },
  deleteAppointmentEvent(eventId, calendarId) {
    try { return Result.ok({ deleted: GoogleCalendar.deleteEvent(eventId, calendarId) }); }
    catch (e) { return Result.fail('CALENDAR_DELETE_FAILED', e.message, e.stack); }
  }
};
