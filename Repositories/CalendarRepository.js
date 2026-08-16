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
      const eventId = GoogleCalendar.createEvent(params);
      return Result.ok({ eventId: eventId });
    } catch (e) {
      return Result.fail('CALENDAR_CREATE_FAILED', e.message, e.stack);
    }
  },

  createLifecycleAppointmentEvent(params) {
    try {
      const event = GoogleCalendar.createLifecycleEvent(params);
      return Result.ok(event);
    } catch (e) {
      return Result.fail('CALENDAR_CREATE_OUTCOME_UNKNOWN', e.message, e.stack);
    }
  },

  inspectLifecycleAppointmentEvent(eventId, calendarId, expectedOperationId) {
    try {
      return Result.ok(
        GoogleCalendar.inspectLifecycleEvent(eventId, calendarId, expectedOperationId)
      );
    } catch (e) {
      return Result.fail('CALENDAR_LOOKUP_FAILED', e.message, e.stack);
    }
  },

  deleteLifecycleAppointmentEvent(eventId, calendarId, expectedOperationId) {
    try {
      const result = GoogleCalendar.deleteLifecycleEvent(
        eventId,
        calendarId,
        expectedOperationId
      );
      if (result.status !== 'ABSENCE_OBSERVED') {
        return Result.fail('CALENDAR_ABSENCE_NOT_PROVEN', result.status, result);
      }
      return Result.ok(result);
    } catch (e) {
      return Result.fail('CALENDAR_DELETE_OUTCOME_UNKNOWN', e.message, e.stack);
    }
  },

  findLifecycleEventsByOperationId(operationId, startTime, endTime, calendarId) {
    try {
      const result = GoogleCalendar.findLifecycleEventsByOperationId(
        operationId,
        startTime,
        endTime,
        calendarId
      );
      return Result.ok(result);
    } catch (e) {
      return Result.fail('CALENDAR_CORRELATION_LOOKUP_FAILED', e.message, e.stack);
    }
  },

  deleteAppointmentEvent(eventId, calendarId) {
    try {
      const deleted = GoogleCalendar.deleteEvent(eventId, calendarId);
      return Result.ok({ deleted: deleted });
    } catch (e) {
      return Result.fail('CALENDAR_DELETE_FAILED', e.message, e.stack);
    }
  }
};
