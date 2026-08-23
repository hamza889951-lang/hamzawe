/**
 * AttendanceAddOn — M0 (PHASE 1.1 — MANAGEMENT INTELLIGENCE)
 *
 * Google Calendar Add-on surface for attendance capture (Entry layer, in
 * the same layer as Webhook.js / ManualRunners.js).
 *
 * This file is the Interaction Surface + Event Context for M0. It does
 * exactly four things:
 *   1. Extract event context (stable eventId + calendarId from the
 *      CardService event object supplied by the add-on framework).
 *   2. Identify the operator server-side via Session (the Google account
 *      operating the add-on). Operator identity is NEVER taken from
 *      client-supplied data.
 *   3. Call the AttendanceService application boundary with a trusted
 *      operator context and the explicit decision implied by which
 *      handler fired (onMarkCompleted / onMarkNoShow).
 *   4. Display the Result as a Card.
 *
 * Explicitly NOT done here (and asserted by tests):
 *   - No StateMachine logic, no slot state knowledge.
 *   - No GoogleSheets / SpreadsheetApp writes, no direct row mutation.
 *   - No business authorization decisions (the service owns them).
 *   - No CalendarApp calls (no event mutation — PoC T5 is out of scope).
 *   - The event title is display-only context for the operator; it is
 *     never a correlation key (eventId is).
 *
 * Deployment: Calendar Add-on deployment of this same script
 * (Deploy → New deployment → Calendar add-on). No appsscript.json change,
 * no new trigger, no production webapp (v7) change.
 */

var ATTENDANCE_DECISION_MARK_COMPLETED = 'MARK_COMPLETED';
var ATTENDANCE_DECISION_MARK_NO_SHOW = 'MARK_NO_SHOW';

/**
 * Calendar Add-on entry point (GAS naming convention).
 * Renders the attendance card for the event currently open, carrying the
 * stable event identity as button parameters.
 *
 * @param {Object} e - add-on event: e.calendar (Calendar), e.selectedEvent (Event)
 * @returns {Object} CardService card
 */
function onOpen(e) {
  var selected = e && e.selectedEvent;
  var eventId = (selected && typeof selected.getId === 'function')
    ? String(selected.getId() || '')
    : '';
  var eventTitle = (selected && typeof selected.getTitle === 'function')
    ? String(selected.getTitle() || '')
    : '';
  var eventStart = (selected && typeof selected.getStartDate === 'function')
    ? selected.getStartDate()
    : null;
  var calendarId = (e && e.calendar && typeof e.calendar.getId === 'function')
    ? String(e.calendar.getId() || '')
    : '';

  return _buildCard({
    eventId: eventId,
    calendarId: calendarId,
    eventTitle: eventTitle,
    eventStart: eventStart,
    decision: '',
    result: null
  });
}

/**
 * Action handler — decision is explicit by handler identity.
 * @param {Object} e - CardService action event (e.params = event identity)
 * @returns {Object} CardService action response
 */
function onMarkCompleted(e) {
  return _handleAttendanceAction(e, ATTENDANCE_DECISION_MARK_COMPLETED);
}

/**
 * Action handler — decision is explicit by handler identity.
 * @param {Object} e - CardService action event (e.params = event identity)
 * @returns {Object} CardService action response
 */
function onMarkNoShow(e) {
  return _handleAttendanceAction(e, ATTENDANCE_DECISION_MARK_NO_SHOW);
}

/**
 * Shared action pipeline: event identity from params (server-rendered),
 * operator from Session, then the application boundary. Free-form
 * decisions are structurally impossible — only the two handlers above
 * exist.
 */
function _handleAttendanceAction(e, decision) {
  var params = (e && e.params) || {};
  var eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
  var calendarId = typeof params.calendarId === 'string' ? params.calendarId.trim() : '';

  if (!eventId) {
    return _buildActionResponse({
      eventId: '',
      calendarId: '',
      eventTitle: '',
      eventStart: null,
      decision: decision,
      result: { ok: false, error: { code: 'ADDON_EVENT_IDENTITY_MISSING', message: 'Event identity is missing from the card action' } }
    });
  }

  // Operator identity: server-side only. The Google account operating the
  // add-on is the trusted operator. Calendar access alone is not
  // authorization — the service re-validates the full operator context.
  var operatorId = Session.getActiveUser().getEmail();

  var context = {
    operator: {
      operatorId: operatorId,
      authorityType: AttendanceService.OPERATOR_AUTHORITY
    },
    calendarEvent: {
      eventId: eventId,
      calendarId: calendarId
    }
  };

  var serviceResult = decision === ATTENDANCE_DECISION_MARK_COMPLETED
    ? AttendanceService.markCompleted(context)
    : AttendanceService.markNoShow(context);

  return _buildActionResponse({
    eventId: eventId,
    calendarId: calendarId,
    eventTitle: typeof params.eventTitle === 'string' ? params.eventTitle : '',
    eventStart: null,
    decision: decision,
    result: serviceResult
  });
}

/**
 * Card construction (UI only).
 */
function _buildCard(fields) {
  var builder = CardService.newCardBuilder().setTitle('Attendance Capture');

  // Event context section (display-only context; correlation is by eventId).
  var contextSection = CardService.newSection().setHeaderTitle('Event context');
  if (fields.eventTitle) {
    contextSection.addWidget(CardService.newTextParagraph().setText('Title: ' + fields.eventTitle));
  }
  if (fields.eventStart) {
    contextSection.addWidget(CardService.newTextParagraph().setText('Start: ' + String(fields.eventStart)));
  }
  contextSection.addWidget(CardService.newTextParagraph().setText('Event ID: ' + (fields.eventId || 'unavailable')));

  // Attendance decision section.
  var decisionSection = CardService.newSection().setHeaderTitle('Attendance decision');
  if (fields.decision) {
    decisionSection.addWidget(CardService.newTextParagraph().setText('Decision: ' + fields.decision));
    decisionSection.addWidget(_resultWidget(fields.result));
  } else {
    if (fields.eventId) {
      decisionSection.addWidget(
        CardService.newTextButton('Mark completed')
          .setText('MARK COMPLETED')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onMarkCompleted')
            .setParams({
              eventId: fields.eventId,
              calendarId: fields.calendarId,
              eventTitle: fields.eventTitle
            }))
      );
      decisionSection.addWidget(
        CardService.newTextButton('Mark no-show')
          .setText('MARK NO-SHOW')
          .setOnClickAction(CardService.newAction()
            .setFunctionName('onMarkNoShow')
            .setParams({
              eventId: fields.eventId,
              calendarId: fields.calendarId,
              eventTitle: fields.eventTitle
            }))
      );
    } else {
      decisionSection.addWidget(
        CardService.newTextParagraph().setText('No stable event identity available — attendance capture is disabled for this event.')
      );
    }
  }

  var card = builder.setSection(contextSection).setSection(decisionSection).build();
  return card;
}

/**
 * Renders the service Result (or an add-on-level failure) as card text.
 * Explicit failures are displayed as failures — never as success.
 */
function _resultWidget(result) {
  if (result && result.ok) {
    var data = result.data || {};
    var line = data.alreadyApplied
      ? 'Already recorded: ' + data.status + ' (duplicate request, no new record).'
      : 'Recorded: ' + data.status;
    line += ' | Slot: ' + (data.slotId || '');
    line += ' | Operator: ' + (data.operatorId || '');
    line += ' | Audit: ' + (data.auditRecorded ? 'recorded' : 'NOT recorded — verify ATTENDANCE_AUDIT');
    return CardService.newTextParagraph().setText(line);
  }
  var code = result && result.error ? result.error.code : 'UNKNOWN_ERROR';
  var message = result && result.error ? result.error.message : 'Unknown error';
  return CardService.newTextParagraph().setText('FAILED: ' + code + ' — ' + message);
}

/**
 * Action response wrapper (Calendar add-on action handlers must return an
 * ActionResponse).
 */
function _buildActionResponse(fields) {
  return CardService.newActionResponse()
    .setRenderCard(_buildCard(fields))
    .build();
}
