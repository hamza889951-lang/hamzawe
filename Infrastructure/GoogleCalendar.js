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
   * Existing generic appointment creation path. It intentionally returns only
   * the event ID so BookingService's established contract remains unchanged.
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

  /**
   * B6 lifecycle event creation. The operation ID is stored as Calendar custom
   * metadata before the event is reported as created to the caller.
   */
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

  /**
   * Inspects a known event ID in a specific Calendar context. NOT_FOUND is an
   * observation only; callers must not treat it as terminal absence by itself.
   */
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

  /**
   * Deletes a known event and then performs a same-context lookup. A null
   * lookup alone is never returned as proof; deleteConfirmed records that this
   * execution first resolved the exact event and called deleteEvent().
   */
  deleteLifecycleEvent(eventId, calendarId, expectedOperationId) {
    const before = this.inspectLifecycleEvent(eventId, calendarId, expectedOperationId);
    if (before.status !== 'MATCH') {
      return {
        status: before.status,
        eventId: eventId,
        calendarId: before.calendarId || calendarId || '',
        deleteConfirmed: false,
        absenceObserved: false
      };
    }

    const calendar = this._getCalendar(before.calendarId || calendarId);
    const event = calendar.getEventById(eventId);
    if (!event) {
      return {
        status: 'NOT_FOUND',
        eventId: eventId,
        calendarId: before.calendarId || calendarId || '',
        deleteConfirmed: false,
        absenceObserved: false
      };
    }

    event.deleteEvent();
    const after = calendar.getEventById(eventId);
    if (after) {
      return {
        status: 'DELETE_NOT_PROVEN',
        eventId: eventId,
        calendarId: before.calendarId || calendarId || '',
        deleteConfirmed: true,
        absenceObserved: false
      };
    }

    return {
      status: 'ABSENCE_OBSERVED',
      eventId: eventId,
      calendarId: before.calendarId || calendarId || '',
      deleteConfirmed: true,
      absenceObserved: true
    };
  },

  /**
   * Finds events carrying an exact B6 operation tag in an explicitly supplied
   * Calendar/time context. The caller interprets 0/1/many results under the
   * recovery contract.
   */
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

  /** @returns {boolean} true if deleted, false if not found */
  deleteEvent(eventId, calendarId) {
    const calendar = this._getCalendar(calendarId);
    const event = calendar.getEventById(eventId);
    if (!event) return false;
    event.deleteEvent();
    return true;
  }
};
