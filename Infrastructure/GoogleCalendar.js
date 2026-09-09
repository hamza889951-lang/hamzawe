/**
 * GoogleCalendar
 *
 * The only infrastructure file that calls CalendarApp. Generic appointment
 * creation/deletion remains available for existing workflows. B6-specific
 * methods add/inspect the contract-required operation correlation tag.
 */
const GoogleCalendar = {

  B6_OPERATION_TAG_KEY: 'operation_id',

  _getCalendar(calendarId) {
    const calendar = calendarId
      ? CalendarApp.getCalendarById(calendarId)
      : CalendarApp.getDefaultCalendar();
    if (!calendar) throw new Error('CALENDAR_NOT_FOUND: ' + calendarId);
    return calendar;
  },

  _calendarId(calendar, requestedCalendarId) {
    if (calendar && typeof calendar.getId === 'function') return calendar.getId();
    return requestedCalendarId || '';
  },

  /**
   * Existing generic appointment creation path. When the RSVP path is
   * activated, CalendarRepository supplies the explicit HAMZAWE calendar ID
   * and secretary attendee email. Outside activation, legacy behavior remains.
   */
  createEvent(params) {
    const calendar = this._getCalendar(params.calendarId);
    const event = calendar.createEvent(
      params.title,
      params.startTime,
      params.endTime,
      { description: params.description || '' }
    );
    if (params.secretaryEmail) event.addGuest(params.secretaryEmail);
    return event.getId();
  },

  createLifecycleEvent(params) {
    if (!params || !params.operationId) {
      throw new Error('B6_OPERATION_ID_REQUIRED');
    }

    const calendar = this._getCalendar(params.calendarId);
    const event = calendar.createEvent(
      params.title,
      params.startTime,
      params.endTime,
      { description: params.description || '' }
    );

    event.setTag(this.B6_OPERATION_TAG_KEY, params.operationId);

    return {
      eventId: event.getId(),
      calendarId: this._calendarId(calendar, params.calendarId),
      operationId: params.operationId
    };
  },

  resolveAppointmentEventIdentity(eventId, calendarId) {
    if (typeof eventId !== 'string' || eventId.trim() === '') {
      throw new Error('CALENDAR_EVENT_ID_REQUIRED');
    }
    if (typeof calendarId !== 'string' || calendarId.trim() === '') {
      throw new Error('CALENDAR_ID_REQUIRED');
    }
    if (typeof Calendar === 'undefined' || !Calendar.Events ||
      typeof Calendar.Events.get !== 'function') {
      throw new Error('CALENDAR_ADVANCED_SERVICE_UNAVAILABLE');
    }

    const requestedEventId = eventId.trim();
    const requestedCalendarId = calendarId.trim();
    const event = Calendar.Events.get(requestedCalendarId, requestedEventId);

    if (!event) {
      throw new Error('CALENDAR_EVENT_NOT_FOUND');
    }
    if (event.id && String(event.id) !== requestedEventId) {
      throw new Error('CALENDAR_EVENT_ID_MISMATCH');
    }
    if (typeof event.iCalUID !== 'string' || event.iCalUID.trim() === '') {
      throw new Error('CALENDAR_EVENT_ICALUID_MISSING');
    }

    return {
      eventId: requestedEventId,
      calendarId: requestedCalendarId,
      iCalUID: event.iCalUID.trim()
    };
  },

  inspectLifecycleEvent(eventId, calendarId, expectedOperationId) {
    const calendar = this._getCalendar(calendarId);
    const resolvedCalendarId = this._calendarId(calendar, calendarId);
    const event = calendar.getEventById(eventId);

    if (!event) {
      return {
        status: 'NOT_FOUND',
        eventId: eventId,
        calendarId: resolvedCalendarId,
        contextResolved: true
      };
    }

    const actualOperationId = event.getTag(this.B6_OPERATION_TAG_KEY);
    if (expectedOperationId && actualOperationId !== expectedOperationId) {
      return {
        status: 'CORRELATION_MISMATCH',
        eventId: eventId,
        calendarId: resolvedCalendarId,
        expectedOperationId: expectedOperationId,
        actualOperationId: actualOperationId || ''
      };
    }

    return {
      status: 'MATCH',
      eventId: eventId,
      calendarId: resolvedCalendarId,
      operationId: actualOperationId || '',
      contextResolved: true
    };
  },

  _verifyLifecycleEventAbsenceAuthoritatively(eventId, calendarId) {
    if (typeof Calendar === 'undefined' || !Calendar.Events ||
      typeof Calendar.Events.list !== 'function') {
      throw new Error('CALENDAR_ADVANCED_SERVICE_UNAVAILABLE');
    }

    const response = Calendar.Events.list(calendarId, {
      iCalUID: eventId,
      showDeleted: false,
      maxResults: 50
    });
    const items = response && Array.isArray(response.items) ? response.items : [];

    return {
      absenceObserved: items.length === 0,
      matchingEventCount: items.length
    };
  },

  deleteLifecycleEvent(eventId, calendarId, expectedOperationId) {
    const before = this.inspectLifecycleEvent(eventId, calendarId, expectedOperationId);
    if (before.status !== 'MATCH') {
      return {
        status: before.status,
        eventId: eventId,
        calendarId: before.calendarId || calendarId || '',
        deleteConfirmed: false,
        absenceObserved: false,
        verificationAttempts: 0
      };
    }

    const resolvedCalendarId = before.calendarId || calendarId || '';
    const calendar = this._getCalendar(resolvedCalendarId);
    const event = calendar.getEventById(eventId);
    if (!event) {
      return {
        status: 'NOT_FOUND',
        eventId: eventId,
        calendarId: resolvedCalendarId,
        deleteConfirmed: false,
        absenceObserved: false,
        verificationAttempts: 0
      };
    }

    event.deleteEvent();

    const verification = this._verifyLifecycleEventAbsenceAuthoritatively(
      eventId,
      resolvedCalendarId
    );
    if (!verification.absenceObserved) {
      return {
        status: 'DELETE_NOT_PROVEN',
        eventId: eventId,
        calendarId: resolvedCalendarId,
        deleteConfirmed: true,
        absenceObserved: false,
        matchingEventCount: verification.matchingEventCount,
        verificationAttempts: 1
      };
    }

    return {
      status: 'ABSENCE_OBSERVED',
      eventId: eventId,
      calendarId: resolvedCalendarId,
      deleteConfirmed: true,
      absenceObserved: true,
      matchingEventCount: verification.matchingEventCount,
      verificationAttempts: 1
    };
  },

  findLifecycleEventsByOperationId(operationId, startTime, endTime, calendarId) {
    if (!operationId) throw new Error('B6_OPERATION_ID_REQUIRED');
    if (!startTime || !endTime) throw new Error('B6_CALENDAR_WINDOW_REQUIRED');

    const calendar = this._getCalendar(calendarId);
    const resolvedCalendarId = this._calendarId(calendar, calendarId);
    const events = calendar.getEvents(startTime, endTime);
    const matches = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.getTag(this.B6_OPERATION_TAG_KEY) === operationId) {
        matches.push({
          eventId: event.getId(),
          calendarId: resolvedCalendarId,
          operationId: operationId
        });
      }
    }

    return {
      calendarId: resolvedCalendarId,
      operationId: operationId,
      matches: matches
    };
  },

  deleteEvent(eventId, calendarId) {
    const calendar = this._getCalendar(calendarId);
    const event = calendar.getEventById(eventId);
    if (!event) return false;
    event.deleteEvent();
    return true;
  }
};
