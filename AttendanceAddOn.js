/**
 * AttendanceAddOn — M0 (PHASE 1.1 — MANAGEMENT INTELLIGENCE)
 *
 * Google Calendar Add-on surface for attendance capture (Entry layer, in
 * the same layer as Webhook.js / ManualRunners.js).
 *
 * This file is the Interaction Surface + Event Context for M0. It does
 * exactly four things:
 *   1. Extract event context — the STABLE event identity (eventId,
 *      calendarId) from the event object supplied by the add-on
 *      framework (see _extractEventIdentity for the verified structure).
 *   2. Identify the operator SERVER-SIDE via Session (the Google account
 *      operating the add-on) and read the deployment trust policy
 *      (Script Property ATTENDANCE_OPERATOR_EMAIL). Operator identity is
 *      NEVER taken from client-supplied action data.
 *   3. Call the AttendanceService application boundary with a context
 *      envelope carrying identity + deployment policy + event identity.
 *      The AUTHORIZATION DECISION (is this identity the trusted operator?
 *      does it derive DOCTOR authority?) is made by AttendanceService,
 *      not here. This entry layer never asserts authority.
 *   4. Display the Result as a Card (re-rendered via Navigation.updateCard).
 *
 * Verified against the official Google documentation AND live test
 * captures (M0 remediation + live verification, final):
 *   - Manifest: addOns.calendar.eventOpenTrigger.runFunction +
 *     currentEventAccess = "READ". Scopes: calendar.addons.execute
 *     (documented metadata-access requirement) +
 *     calendar.addons.current.event.read (documented READ requirement).
 *   - LIVE CAPTURES (M0 test deployment):
 *       METADATA: e.calendar.{id, calendarId, organizer, capabilities}
 *       READ:     e.calendar.{id, calendarId, organizer, capabilities,
 *                 attendees} — user-generated fields present, so READ is
 *                 in effect. In BOTH captures the documented event fields
 *                 arrive FLATTENED under top-level e.calendar (no
 *                 selectedEvent / calendarEventObject in this runtime).
 *       DECISIVE PROBE: the captured e.calendar.id value resolved via
 *       CalendarApp.getEventById as the opened EVENT (getCalendarById:
 *       null) — i.e. e.calendar.id = EVENT id, e.calendar.calendarId =
 *       parent calendar id. (Matches the documented event-object table:
 *       calendar.id = "The event ID", calendar.calendarId = "The calendar
 *       ID".)
 *   - Consequence: the READ level is an empirically demonstrated
 *     necessity (METADATA did not deliver the event context usefully in
 *     this runtime), read-only — NO current.event.write scope, NO
 *     READ_WRITE, NO CalendarApp mutation in this file (structurally
 *     asserted by tests). Attendance state lives in Availability via
 *     StateMachine; the Calendar event is never a state store (T5 closed).
 *   - M0 reads ONLY the two stable ids (eventId, calendarId);
 *     attendees/organizer are never read (PII discipline). The card
 *     displays stable identity only (the official field table does not
 *     include summary/start/end at any level; the operator sees the event
 *     itself in the Calendar UI).
 *   - Action parameters: e.commonEventObject.parameters (the current
 *     documented location; Action.setParameters is the current API).
 *   - CardService: newCardBuilder/setHeader/newCardHeader.setTitle/
 *     addSection/newCardSection.setHeader/addWidget/newTextParagraph.
 *     setText/newTextButton().setText/setOnClickAction/
 *     newAction().setFunctionName/setParameters/
 *     newActionResponseBuilder().setNavigation(newNavigation().updateCard).
 *
 * Explicitly NOT done here (and asserted by tests):
 *   - No StateMachine logic, no slot state knowledge.
 *   - No GoogleSheets / SpreadsheetApp writes, no direct row mutation.
 *   - No business authorization decisions (the service owns them).
 *   - No CalendarApp calls (no event mutation — PoC T5 is out of scope).
 *   - The event title is never a correlation key (eventId is).
 *
 * Deployment: Calendar Add-on deployment of this same script (Deploy →
 * New deployment → Calendar add-on). The production webapp (v7) is a
 * separate deployment and is untouched.
 */

var ATTENDANCE_DECISION_MARK_COMPLETED = 'MARK_COMPLETED';
var ATTENDANCE_DECISION_MARK_NO_SHOW = 'MARK_NO_SHOW';

/** Deployment trust policy property (set by the owner at deploy time). */
var ATTENDANCE_OPERATOR_PROPERTY_KEY = 'ATTENDANCE_OPERATOR_EMAIL';

/**
 * Calendar eventOpenTrigger entry point (GAS add-on naming convention;
 * mapped by appsscript.json addOns.calendar.eventOpenTrigger.runFunction).
 *
 * Builds and returns a single Card (documented contract for
 * eventOpenTrigger functions).
 *
 * @param {Object} e - add-on event object (framework-supplied)
 * @returns {Object} CardService Card
 */
function onCalendarEventOpen(e) {
  var identity = _extractEventIdentity(e);
  return _buildCard({
    eventId: identity.eventId,
    calendarId: identity.calendarId,
    decision: '',
    result: null
  });
}
/**
 * Action handler — decision is explicit by handler identity.
 * @param {Object} e - CardService action event (parameters = event identity)
 * @returns {Object} CardService ActionResponse
 */
function onMarkCompleted(e) {
  return _handleAttendanceAction(e, ATTENDANCE_DECISION_MARK_COMPLETED);
}

/**
 * Action handler — decision is explicit by handler identity.
 * @param {Object} e - CardService action event (parameters = event identity)
 * @returns {Object} CardService ActionResponse
 */
function onMarkNoShow(e) {
  return _handleAttendanceAction(e, ATTENDANCE_DECISION_MARK_NO_SHOW);
}

/**
 * Shared action pipeline. Client-influenceable inputs are limited to the
 * action (which handler fired) and the string parameters rendered into
 * this card server-side; the eventId is validated by the service's
 * exactly-one correlation against the authoritative slot row, and the
 * operator identity + trust policy are resolved server-side below.
 */
function _handleAttendanceAction(e, decision) {
  var params = _extractActionParameters(e);
  var eventId = typeof params.eventId === 'string' ? params.eventId.trim() : '';
  var calendarId = typeof params.calendarId === 'string' ? params.calendarId.trim() : '';

  if (!eventId) {
    return _buildActionResponse({
      eventId: '',
      calendarId: '',
      decision: decision,
      result: {
        ok: false,
        error: {
          code: 'ADDON_EVENT_IDENTITY_MISSING',
          message: 'Event identity is missing from the card action'
        }
      }
    });
  }

  var operatorContext = _resolveOperatorContext();

  var context = {
    operator: operatorContext.operator,
    deployment: operatorContext.deployment,
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
    decision: decision,
    result: serviceResult
  });
}

/**
 * Server-side operator identity + deployment trust policy.
 *   - identity: Session.getActiveUser().getEmail() (the Google account
 *     operating the add-on; requires the userinfo.email scope, which is
 *     declared in the manifest).
 *   - policy: Script Property ATTENDANCE_OPERATOR_EMAIL (the configured
 *     trusted operator; set by the owner at deploy time).
 * This function does NOT decide authorization — it only resolves the two
 * inputs and hands them to the AttendanceService, which derives the
 * authority (trusted single-doctor deployment boundary).
 */
function _resolveOperatorContext() {
  var operatorId = '';
  try {
    operatorId = Session.getActiveUser().getEmail() || '';
  } catch (e) {
    operatorId = '';
  }

  var trustedOperatorEmail = '';
  try {
    trustedOperatorEmail =
      PropertiesService.getScriptProperties().getProperty(ATTENDANCE_OPERATOR_PROPERTY_KEY) || '';
  } catch (e) {
    trustedOperatorEmail = '';
  }

  return {
    operator: { operatorId: operatorId },
    deployment: { trustedOperatorEmail: trustedOperatorEmail }
  };
}

/**
 * Extracts the STABLE event identity from the add-on event object.
 *
 * VERIFIED CONTRACT (M0 live captures, READ level, build v5):
 *   The runtime delivers the documented Calendar-event fields FLATTENED
 *   to a top-level e.calendar object:
 *     e.calendar.id          — the opened EVENT id (26-char Calendar
 *                              event id; live-verified by resolving the
 *                              value via CalendarApp.getEventById)
 *     e.calendar.calendarId  — the parent calendar id
 *     e.calendar.attendees / organizer / capabilities — event-level
 *                              fields (user-generated data, delivered
 *                              because currentEventAccess = READ)
 *   M0 uses ONLY the two stable ids above; attendees/organizer are never
 *   read (PII discipline).
 *
 * Resolution order (first hit wins; each branch is unambiguous):
 *   (a) documented nested layout  e.calendarEventObject.calendar.*
 *   (b) legacy layout (inherited PoC evidence)  e.selectedEvent.id
 *   (c) observed runtime layout  top-level e.calendar (only when no
 *       selectedEvent — so the legacy semantics stay intact)
 *   (d) deprecated top-level e.id / e.calendarId
 *
 * If no branch yields an event ID, returns empty identity and the card
 * offers no decisions (fail-safe; the service would reject anyway).
 */
function _extractEventIdentity(e) {
  var eventId = '';
  var calendarId = '';

  // (a) Documented layout: e.calendarEventObject.calendar.{id, calendarId}
  var documented = e && e.calendarEventObject && e.calendarEventObject.calendar;
  if (documented) {
    if (typeof documented.id === 'string') eventId = documented.id;
    if (typeof documented.calendarId === 'string') calendarId = documented.calendarId;
  }

  // (b) Legacy layout (inherited PoC evidence): e.selectedEvent = the event
  if (!eventId && e && e.selectedEvent) {
    if (typeof e.selectedEvent.id === 'string') eventId = e.selectedEvent.id;
    if (!calendarId && e.calendar && typeof e.calendar.id === 'string') {
      calendarId = e.calendar.id;
    }
    if (!calendarId && typeof e.calendarId === 'string') calendarId = e.calendarId;
  }

  // (c) Observed runtime layout (M0 live capture): documented event fields
  //     flattened to top-level e.calendar — e.calendar.id = EVENT id.
  if (!eventId && e && e.calendar && !e.selectedEvent) {
    if (typeof e.calendar.id === 'string') eventId = e.calendar.id;
    if (typeof e.calendar.calendarId === 'string') calendarId = e.calendar.calendarId;
  }

  // (d) Deprecated top-level ids, last resort
  if (!eventId && e && typeof e.id === 'string') eventId = e.id;
  if (!calendarId && e && typeof e.calendarId === 'string') calendarId = e.calendarId;

  return {
    eventId: eventId ? String(eventId).trim() : '',
    calendarId: calendarId ? String(calendarId).trim() : ''
  };
}

/**
 * Extracts action parameters from the action event object.
 * Current documented location: e.commonEventObject.parameters.
 * Legacy (deprecated) top-level fallback: e.parameters.
 */
function _extractActionParameters(e) {
  var common = e && e.commonEventObject && e.commonEventObject.parameters;
  if (common && typeof common === 'object') return common;
  if (e && e.parameters && typeof e.parameters === 'object') return e.parameters;
  return {};
}

/**
 * Card construction (UI only, verified CardService APIs).
 */
function _buildCard(fields) {
  var contextSection = CardService.newCardSection().setHeader('Event context');
  if (fields.eventId) {
    contextSection.addWidget(
      CardService.newTextParagraph().setText('Event ID: ' + fields.eventId)
    );
    contextSection.addWidget(
      CardService.newTextParagraph().setText('Calendar ID: ' + (fields.calendarId || 'default calendar'))
    );
  } else {
    contextSection.addWidget(
      CardService.newTextParagraph().setText('No stable event identity available — attendance capture is disabled for this event.')
    );
  }

  var decisionSection = CardService.newCardSection().setHeader('Attendance decision');
  if (fields.decision) {
    decisionSection.addWidget(
      CardService.newTextParagraph().setText('Decision: ' + fields.decision)
    );
    decisionSection.addWidget(_resultWidget(fields.result));
  } else if (fields.eventId) {
    decisionSection.addWidget(
      CardService.newTextButton()
        .setText('MARK COMPLETED')
        .setOnClickAction(_attendanceAction('onMarkCompleted', fields))
    );
    decisionSection.addWidget(
      CardService.newTextButton()
        .setText('MARK NO-SHOW')
        .setOnClickAction(_attendanceAction('onMarkNoShow', fields))
    );
  } else {
    decisionSection.addWidget(
      CardService.newTextParagraph().setText('Open a HAMZAWE appointment event to record attendance.')
    );
  }

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Attendance Capture'))
    .addSection(contextSection)
    .addSection(decisionSection)
    .build();
}

/**
 * Builds the button action carrying the stable event identity as
 * parameters (server-rendered into this card; verified API:
 * Action.setFunctionName + Action.setParameters).
 */
function _attendanceAction(functionName, fields) {
  return CardService.newAction()
    .setFunctionName(functionName)
    .setParameters({
      eventId: fields.eventId,
      calendarId: fields.calendarId || ''
    });
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
    line += ' | Authority: ' + (data.authorizedAs || '');
    line += ' | Audit: ' + (data.auditRecorded ? 'recorded' : 'NOT recorded — verify ATTENDANCE_AUDIT');
    return CardService.newTextParagraph().setText(line);
  }
  var code = result && result.error ? result.error.code : 'UNKNOWN_ERROR';
  var message = result && result.error ? result.error.message : 'Unknown error';
  return CardService.newTextParagraph().setText('FAILED: ' + code + ' — ' + message);
}

/**
 * Action response wrapper. Re-renders the card via the documented
 * Navigation.updateCard pattern (ActionResponseBuilder.setNavigation).
 */
function _buildActionResponse(fields) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(_buildCard(fields)))
    .build();
}
