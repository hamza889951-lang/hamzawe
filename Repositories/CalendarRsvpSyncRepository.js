/**
 * CalendarRsvpSyncRepository
 * Infrastructure adapter for Calendar Advanced Service incremental sync.
 */
const CalendarRsvpSyncRepository = {
  PAGE_SIZE: 2500,

  listPage(calendarId, syncToken, pageToken) {
    if (!calendarId) return Result.fail('RSVP_CALENDAR_ID_REQUIRED', 'calendarId is required');
    try {
      if (typeof Calendar === 'undefined' || !Calendar.Events || typeof Calendar.Events.list !== 'function') {
        return Result.fail('CALENDAR_ADVANCED_SERVICE_UNAVAILABLE', 'Calendar Advanced Service is unavailable');
      }
      const params = {
        showDeleted: true,
        singleEvents: false,
        maxResults: this.PAGE_SIZE
      };
      if (syncToken) params.syncToken = syncToken;
      if (pageToken) params.pageToken = pageToken;
      const response = Calendar.Events.list(calendarId, params) || {};
      return Result.ok({
        items: Array.isArray(response.items) ? response.items : [],
        nextPageToken: response.nextPageToken || null,
        nextSyncToken: response.nextSyncToken || null
      });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      const code = this._is410(e) ? 'RSVP_SYNC_TOKEN_INVALID' : 'RSVP_CALENDAR_LIST_FAILED';
      return Result.fail(code, message, e && e.stack);
    }
  },

  getEvent(calendarId, eventId) {
    try {
      if (typeof Calendar === 'undefined' || !Calendar.Events || typeof Calendar.Events.get !== 'function') {
        return Result.fail('CALENDAR_ADVANCED_SERVICE_UNAVAILABLE', 'Calendar Advanced Service is unavailable');
      }
      const event = Calendar.Events.get(calendarId, eventId);
      return Result.ok(event || null);
    } catch (e) {
      return Result.fail('RSVP_EVENT_GET_FAILED', e.message, e.stack);
    }
  },

  _is410(error) {
    const text = error && error.message ? String(error.message) : String(error || '');
    if (/\b410\b/.test(text)) return true;
    try {
      const details = error && typeof error.getDetails === 'function' ? error.getDetails() : null;
      return !!(details && Number(details.code) === 410);
    } catch (ignored) {
      return false;
    }
  },

  withSyncLock(fn) {
    return Lock.runExclusive('calendar-rsvp-sync', fn, 5000);
  }
};
