/**
 * GoogleCalendar
 *
 * The only infrastructure file that calls CalendarApp. Generic appointment
 * creation/deletion remains available for existing workflows. B6-specific
 * methods add/inspect the contract-required operation correlation tag.
 */
const GoogleCalendar = {

  B6_OPERATION_TAG_KEY: 'operation_id',

  // Absence verification is deliberately bounded and fail-closed. The first
  // read is immediate; retries are only used when the event is still observed.
  // This avoids treating a transient read-after-write observation as proof
  // that deleteEvent() failed, without ever treating an unproven delete as
  // successful.
  B6_DELETE_VERIFICATION_DELAYS_MS: [0, 250, 500, 1000, 2000],

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

  _verifyLifecycleEventAbsence(eventId, calendarId) {
    for (let i = 0; i < this.B6_DELETE_VERIFICATION_DELAYS_MS.length; i++) {
      const delayMs = this.B6_DELETE_VERIFICATION_DELAYS_MS[i];
      if (delayMs > 0) {
        if (typeof Utilities === 'undefined' || typeof Utilities.sleep !== 'function') {
          throw new Error('CALENDAR_DELETE_VERIFICATION_SLEEP_UNAVAILABLE');
        }
        Utilities.sleep(delayMs);
      }

      // Resolve a fresh Calendar context for every observation. Do not reuse
      // the pre-delete Calendar/Event object because a stale read must not be
      // allowed to become the terminal deletion verdict.
      const calendar = this._getCalendar(calendarId);
      const event = calendar.getEventById(eventId);
      if (!event) {
        return {
          absenceObserved: true,
          verificationAttempts: i + 1
        };
      }
    }

    return {
      absenceObserved: false,
      verificationAttempts: this.B6_DELETE_VERIFICATION_DELAYS_MS.length
    };
  },

  /**
   * Deletes a known event and verifies absence using bounded fresh-context
   * observations. A delete is considered proven only after an absence is
   * observed. Exhausting verification remains DELETE_NOT_PROVEN so B6 can
   * enter recovery rather than silently releasing an unresolved appointment.
   */
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
    const verification = this._verifyLifecycleEventAbsence(eventId, resolvedCalendarId);
    if (!verification.absenceObserved) {
      return {
        status: 'DELETE_NOT_PROVEN',
        eventId: eventId,
        calendarId: resolvedCalendarId,
        deleteConfirmed: true,
        absenceObserved: false,
        verificationAttempts: verification.verificationAttempts
      };
    }

    return {
      status: 'ABSENCE_OBSERVED',
      eventId: eventId,
      calendarId: resolvedCalendarId,
      deleteConfirmed: true,
      absenceObserved: true,
      verificationAttempts: verification.verificationAttempts
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
