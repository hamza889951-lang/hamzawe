/**
 * Native Calendar RSVP entry points.
 * No Web App / Add-on UI is involved in this attendance path.
 */
function initializeCalendarRsvpAttendance() {
  return CalendarRsvpAttendanceService.initializeBaseline();
}

function activateCalendarRsvpAttendance() {
  return CalendarRsvpAttendanceService.activate();
}

function onCalendarRsvpEventUpdated(e) {
  return CalendarRsvpAttendanceService.handleEventUpdated(e);
}
