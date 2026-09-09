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
      let keeper = null;
      let removed = 0;
      for (let i = 0; i < triggers.length; i++) {
        const trigger = triggers[i];
        if (!trigger.getHandlerFunction || trigger.getHandlerFunction() !== this.HANDLER ||
            !trigger.getEventType || trigger.getEventType() !== ScriptApp.EventType.ON_EVENT_UPDATED) {
          continue;
        }
        const sourceId = trigger.getTriggerSourceId ? trigger.getTriggerSourceId() : '';
        if (!keeper && sourceId === calendarId) {
          keeper = trigger;
          continue;
        }
        if (ScriptApp.deleteTrigger) {
          ScriptApp.deleteTrigger(trigger);
          removed++;
        } else if (!keeper && !sourceId) {
          keeper = trigger;
        }
      }

      if (keeper) {
        return Result.ok({ installed: false, existing: true, removedDuplicates: removed });
      }

      ScriptApp.newTrigger(this.HANDLER)
        .forUserCalendar(calendarId)
        .onEventUpdated()
        .create();
      return Result.ok({ installed: true, existing: false, removedDuplicates: removed });
    } catch (e) {
      return Result.fail('RSVP_TRIGGER_INSTALL_FAILED', e.message, e.stack);
    }
  }
};
