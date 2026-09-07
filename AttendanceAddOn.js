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
 * The UI language is intentionally human-facing; internal attendance
 * decisions and Calendar identities remain implementation data.
 */

var ATTENDANCE_DECISION_MARK_COMPLETED = 'MARK_COMPLETED';
var ATTENDANCE_DECISION_MARK_NO_SHOW = 'MARK_NO_SHOW';

var ATTENDANCE_OPERATOR_PROPERTY_KEY = 'ATTENDANCE_OPERATOR_EMAIL';

function onCalendarEventOpen(e) {
  var identity = _extractEventIdentity(e);
  return _buildCard({
    eventId: identity.eventId,
    calendarId: identity.calendarId,
    decision: '',
    result: null
  });
}

function onMarkCompleted(e) {
  return _handleAttendanceAction(e, ATTENDANCE_DECISION_MARK_COMPLETED);
}

function onMarkNoShow(e) {
  return _handleAttendanceAction(e, ATTENDANCE_DECISION_MARK_NO_SHOW);
}

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

function _extractEventIdentity(e) {
  var eventId = '';
  var calendarId = '';

  var documented = e && e.calendarEventObject && e.calendarEventObject.calendar;
  if (documented) {
    if (typeof documented.id === 'string') eventId = documented.id;
    if (typeof documented.calendarId === 'string') calendarId = documented.calendarId;
  }

  if (!eventId && e && e.selectedEvent) {
    if (typeof e.selectedEvent.id === 'string') eventId = e.selectedEvent.id;
    if (!calendarId && e.calendar && typeof e.calendar.id === 'string') {
      calendarId = e.calendar.id;
    }
    if (!calendarId && typeof e.calendarId === 'string') calendarId = e.calendarId;
  }

  if (!eventId && e && e.calendar && !e.selectedEvent) {
    if (typeof e.calendar.id === 'string') eventId = e.calendar.id;
    if (typeof e.calendar.calendarId === 'string') calendarId = e.calendar.calendarId;
  }

  if (!eventId && e && typeof e.id === 'string') eventId = e.id;
  if (!calendarId && e && typeof e.calendarId === 'string') calendarId = e.calendarId;

  return {
    eventId: eventId ? String(eventId).trim() : '',
    calendarId: calendarId ? String(calendarId).trim() : ''
  };
}

function _extractActionParameters(e) {
  var common = e && e.commonEventObject && e.commonEventObject.parameters;
  if (common && typeof common === 'object') return common;
  if (e && e.parameters && typeof e.parameters === 'object') return e.parameters;
  return {};
}

/**
 * Human-facing CardService presentation. Technical event identities remain
 * server-side action parameters but are intentionally omitted from the UI.
 */
function _buildCard(fields) {
  var contextSection = CardService.newCardSection().setHeader('الموعد');
  if (fields.eventId) {
    contextSection.addWidget(
      CardService.newTextParagraph().setText('تم فتح موعد HAMZAWE. اختر حالة الحضور أدناه.')
    );
  } else {
    contextSection.addWidget(
      CardService.newTextParagraph().setText('تعذر تحديد هوية الموعد — تم تعطيل تسجيل الحضور لهذا الحدث.')
    );
  }

  var decisionSection = CardService.newCardSection().setHeader('تسجيل الحضور');
  if (fields.decision) {
    decisionSection.addWidget(_resultWidget(fields.result));
  } else if (fields.eventId) {
    decisionSection.addWidget(
      CardService.newTextButton()
        .setText('حضر ✅')
        .setOnClickAction(_attendanceAction('onMarkCompleted', fields))
    );
    decisionSection.addWidget(
      CardService.newTextButton()
        .setText('لم يحضر ❌')
        .setOnClickAction(_attendanceAction('onMarkNoShow', fields))
    );
  } else {
    decisionSection.addWidget(
      CardService.newTextParagraph().setText('افتح حدث موعد HAMZAWE الصحيح لتسجيل الحضور.')
    );
  }

  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('تسجيل حضور الموعد'))
    .addSection(contextSection)
    .addSection(decisionSection)
    .build();
}

function _attendanceAction(functionName, fields) {
  return CardService.newAction()
    .setFunctionName(functionName)
    .setParameters({
      eventId: fields.eventId,
      calendarId: fields.calendarId || ''
    });
}

function _resultWidget(result) {
  if (result && result.ok) {
    var data = result.data || {};
    var line;
    if (data.alreadyApplied) {
      line = 'تم تسجيل القرار مسبقًا لهذا الموعد.';
    } else if (data.status === 'COMPLETED') {
      line = 'تم تسجيل الحضور بنجاح ✅';
    } else if (data.status === 'NO_SHOW') {
      line = 'تم تسجيل عدم الحضور بنجاح ❌';
    } else {
      line = 'تم تسجيل القرار بنجاح.';
    }
    line += '\nحالة سجل التدقيق: ' + (data.auditRecorded ? 'تم التسجيل' : 'تحتاج إلى التحقق');
    return CardService.newTextParagraph().setText(line);
  }

  var code = result && result.error ? result.error.code : 'UNKNOWN_ERROR';
  var message = result && result.error ? result.error.message : 'Unknown error';
  return CardService.newTextParagraph().setText('FAILED: ' + code + ' — ' + message);
}

function _buildActionResponse(fields) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().updateCard(_buildCard(fields)))
    .build();
}
