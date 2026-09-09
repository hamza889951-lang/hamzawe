/**
 * CalendarRsvpTrigger
 * Owns ScriptApp knowledge for the single installable Calendar trigger.
 */
const CalendarRsvpTrigger = {
  HANDLER: 'onCalendarRsvpEventUpdated',

  install(calendarId) {
    if (!calendarId) return Result.fail('RSVP_CALENDAR_ID_REQUIRED', 'calendarId is required');
    try {
      const triggers = ScriptApp.getProjectTriggers();
      for (let i = 0; i < triggers.length; i++) {
        const trigger = triggers[i];
        if (trigger.getHandlerFunction && trigger.getHandlerFunction() === this.HANDLER &&
            trigger.getEventType && trigger.getEventType() === ScriptApp.EventType.ON_EVENT_UPDATED) {
          const sourceId = trigger.getTriggerSourceId ? trigger.getTriggerSourceId() : '';
          if (sourceId === calendarId || !sourceId) return Result.ok({ installed: false, existing: true });
          return Result.fail('RSVP_TRIGGER_WRONG_CALENDAR', 'A Calendar RSVP trigger already exists for a different calendar', { existingCalendarId: sourceId, expectedCalendarId: calendarId });
        }
      }
      ScriptApp.newTrigger(this.HANDLER).forUserCalendar(calendarId).onEventUpdated().create();
      return Result.ok({ installed: true, existing: false });
    } catch (e) {
      return Result.fail('RSVP_TRIGGER_INSTALL_FAILED', e.message, e.stack);
    }
  }
};
