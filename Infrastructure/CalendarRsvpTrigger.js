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
      const candidates = [];

      for (let i = 0; i < triggers.length; i++) {
        const trigger = triggers[i];
        if (!trigger.getHandlerFunction || trigger.getHandlerFunction() !== this.HANDLER ||
            !trigger.getEventType || trigger.getEventType() !== ScriptApp.EventType.ON_EVENT_UPDATED) {
          continue;
        }

        if (typeof trigger.getTriggerSourceId !== 'function') {
          return Result.fail(
            'RSVP_TRIGGER_SOURCE_UNVERIFIABLE',
            'Cannot prove the Calendar source of an existing RSVP trigger; refusing to mutate trigger ownership'
          );
        }

        const sourceId = trigger.getTriggerSourceId();
        if (typeof sourceId !== 'string' || sourceId.trim() === '') {
          return Result.fail(
            'RSVP_TRIGGER_SOURCE_UNVERIFIABLE',
            'Existing RSVP trigger has no verifiable Calendar source; refusing to mutate trigger ownership'
          );
        }

        candidates.push({ trigger: trigger, sourceId: sourceId });
        if (!keeper && sourceId === calendarId) keeper = trigger;
      }

      let removedDuplicates = 0;
      if (typeof ScriptApp.deleteTrigger === 'function') {
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          if (candidate.trigger === keeper) continue;
          ScriptApp.deleteTrigger(candidate.trigger);
          removedDuplicates++;
        }
      } else if (candidates.length > 0 && !keeper) {
        return Result.fail(
          'RSVP_TRIGGER_DELETE_UNAVAILABLE',
          'Existing RSVP triggers require cleanup before exact-one ownership can be established'
        );
      }

      if (keeper) {
        return Result.ok({ installed: false, existing: true, removedDuplicates });
      }

      ScriptApp.newTrigger(this.HANDLER)
        .forUserCalendar(calendarId)
        .onEventUpdated()
        .create();
      return Result.ok({ installed: true, existing: false, removedDuplicates });
    } catch (e) {
      return Result.fail('RSVP_TRIGGER_INSTALL_FAILED', e.message, e.stack);
    }
  }
};
