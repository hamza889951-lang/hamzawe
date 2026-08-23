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
 * Verified against the official Google documentation (M0 remediation):
 *   - Manifest: addOns.calendar.eventOpenTrigger.runFunction +
 *     currentEventAccess = "METADATA" (event ID + calendar ID are
 *     metadata; no user-generated data is requested). Scope
 *     https://www.googleapis.com/auth/calendar.addons.execute is the
 *     documented requirement for Calendar event metadata access
 *     (developers.google.com/workspace/add-ons/concepts/workspace-scopes).
 *   - Event object: the Calendar event object carries
 *     e.calendarEventObject.calendar.id (event ID) and
 *     e.calendarEventObject.calendar.calendarId (calendar ID).
 *     The official field table does NOT include summary/start/end at any
 *     access level — therefore this card displays stable identity only
 *     (the operator sees the event itself in the Calendar UI).
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
  // TEMPORARY (M0 live verification): with Script Property ATTENDANCE_DEBUG
  // = "true", dump the actual event-object shape (Logger + card section) so
  // the real runtime shape can be confirmed before finalizing
  // _extractEventIdentity. Disabled by default; remove after verification.
  var diagnostic = null;
  if (_isDebugEnabled()) {
    diagnostic = _buildEventDiagnostic(e, identity);
  }
  return _buildCard({
    eventId: identity.eventId,
    calendarId: identity.calendarId,
    decision: '',
    result: null,
    diagnostic: diagnostic
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
 * Verified (official Workspace add-on event-object reference): when
 * Calendar is the acting host, the event object carries a Calendar event
 * object with the metadata fields:
 *   e.calendarEventObject.calendar.id         — the event ID
 *   e.calendarEventObject.calendar.calendarId — the calendar ID
 * (available at currentEventAccess = METADATA)
 *
 * Legacy fallback (inherited PoC evidence, older add-on runtime shape):
 *   e.selectedEvent.id / e.selectedEvent.title, e.calendar.id, or the
 *   top-level e.id / e.calendarId.
 *
 * The live runtime shape is being confirmed via the ATTENDANCE_DEBUG
 * diagnostic (M0 live verification); this function is the single place
 * to adjust if the observed shape differs.
 *
 * If neither shape yields an event ID, returns empty identity and the
 * card offers no decisions (fail-safe; the service would reject anyway).
 */
function _extractEventIdentity(e) {
  var eventId = '';
  var calendarId = '';

  var current = e && e.calendarEventObject && e.calendarEventObject.calendar;
  if (current) {
    if (typeof current.id === 'string') eventId = current.id;
    if (typeof current.calendarId === 'string') calendarId = current.calendarId;
  }

  if (!eventId && e) {
    var legacyEvent = e.selectedEvent;
    if (legacyEvent && typeof legacyEvent.id === 'string') eventId = legacyEvent.id;
    if (!eventId && typeof e.id === 'string') eventId = e.id;
    var legacyCalendar = e.calendar;
    if (!calendarId && legacyCalendar && typeof legacyCalendar.id === 'string') {
      calendarId = legacyCalendar.id;
    }
    if (!calendarId && typeof e.calendarId === 'string') calendarId = e.calendarId;
  }

  return {
    eventId: eventId ? String(eventId).trim() : '',
    calendarId: calendarId ? String(calendarId).trim() : ''
  };
}

/**
 * TEMPORARY (M0 live verification) — diagnostic mode toggle.
 */
function _isDebugEnabled() {
  try {
    return String(
      PropertiesService.getScriptProperties().getProperty('ATTENDANCE_DEBUG') || ''
    ).toLowerCase() === 'true';
  } catch (err) {
    return false;
  }
}

/**
 * TEMPORARY (M0 live verification) — dumps the actual event-object shape:
 * full JSON to the execution log (Editor → Executions) and a compact
 * key-map on the card. Never includes user data beyond the object's own
 * keys and the extracted stable IDs.
 */
function _buildEventDiagnostic(e, identity) {
  var lines = [];
  try {
    Logger.log('M0_DIAG_EVENT_OBJECT_BEGIN');
    Logger.log(JSON.stringify(e));
    Logger.log('M0_DIAG_EVENT_OBJECT_END');
  } catch (dumpErr) {
    lines.push('Full JSON dump failed: ' + dumpErr.message);
  }
  lines.push('Top keys: ' + _keysOf(e));
  if (e && e.calendarEventObject) {
    lines.push(
      'calendarEventObject keys: ' + _keysOf(e.calendarEventObject) +
      (e.calendarEventObject.calendar
        ? ' | .calendar keys: ' + _keysOf(e.calendarEventObject.calendar)
        : '')
    );
  }
  if (e && e.calendar) lines.push('calendar keys: ' + _keysOf(e.calendar));
  if (e && e.selectedEvent) lines.push('selectedEvent keys: ' + _keysOf(e.selectedEvent));
  if (e && e.commonEventObject) lines.push('commonEventObject keys: ' + _keysOf(e.commonEventObject));
  lines.push('Extracted: eventId=' + (identity.eventId || '<empty>') +
    ', calendarId=' + (identity.calendarId || '<empty>'));
  return lines.join('\n');
}

function _keysOf(obj) {
  if (!obj || typeof obj !== 'object') return '(absent)';
  var keys = Object.keys(obj);
  return keys.length ? '[' + keys.join(', ') + ']' : '[]';
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

  var builder = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Attendance Capture'));
  builder.addSection(contextSection);
  if (fields.diagnostic) {
    builder.addSection(
      CardService.newCardSection()
        .setHeader('DIAGNOSTIC (event object)')
        .addWidget(CardService.newTextParagraph().setText(fields.diagnostic))
    );
  }
  builder.addSection(decisionSection);
  return builder.build();
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
