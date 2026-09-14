/**
 * TEMPORARY — Secretary OAuth / userinfo.email diagnostic.
 * Branch only: temp/secretary-userinfo-diagnostic-2026-09-14
 *
 * Purpose:
 *   Run inside the real Google Calendar Workspace Add-on callback context
 *   to prove whether the current user has actually granted userinfo.email.
 *
 * Safety:
 *   - No Availability reads/writes.
 *   - No Calendar API calls.
 *   - No attendance mutation.
 *   - No production logging.
 *   - Explicitly requests only the already-declared userinfo.email scope.
 */

var TEMP_USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

function onSecretaryUserInfoDiagnosticOpen(e) {
  return CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader().setTitle('HAMZAWE — Secretary OAuth Diagnostic')
    )
    .addSection(
      CardService.newCardSection()
        .setHeader('تشخيص صلاحية userinfo.email')
        .addWidget(
          CardService.newTextParagraph().setText(
            'هذا اختبار مؤقت فقط. اضغط الزر لإجبار طلب userinfo.email داخل Calendar Add-on callback الحقيقي.'
          )
        )
        .addWidget(
          CardService.newTextButton()
            .setText('طلب صلاحية userinfo.email 🔐')
            .setOnClickAction(
              CardService.newAction()
                .setFunctionName('onSecretaryUserInfoDiagnosticCheck')
            )
        )
    )
    .build();
}

function onSecretaryUserInfoDiagnosticCheck(e) {
  var requested = false;
  var requireScopeError = '';
  try {
    ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, [TEMP_USERINFO_EMAIL_SCOPE]);
    requested = true;
  } catch (err) {
    requireScopeError = String(err && err.message ? err.message : err);
  }

  var activeUserEmail = '';
  var activeUserError = '';
  try {
    activeUserEmail = Session.getActiveUser().getEmail() || '';
  } catch (err) {
    activeUserError = String(err && err.message ? err.message : err);
  }

  var effectiveUserEmail = '';
  var effectiveUserError = '';
  try {
    effectiveUserEmail = Session.getEffectiveUser().getEmail() || '';
  } catch (err) {
    effectiveUserError = String(err && err.message ? err.message : err);
  }

  var temporaryActiveUserKey = '';
  var temporaryActiveUserKeyError = '';
  try {
    temporaryActiveUserKey = Session.getTemporaryActiveUserKey() || '';
  } catch (err) {
    temporaryActiveUserKeyError = String(err && err.message ? err.message : err);
  }

  var trustedOperatorEmail = '';
  var trustedOperatorError = '';
  try {
    trustedOperatorEmail =
      PropertiesService.getScriptProperties().getProperty('ATTENDANCE_OPERATOR_EMAIL') || '';
  } catch (err) {
    trustedOperatorError = String(err && err.message ? err.message : err);
  }

  var eventShape = {
    hasEvent: !!e,
    keys: e ? Object.keys(e) : [],
    hostApp: e && e.commonEventObject ? e.commonEventObject.hostApp || '' : '',
    platform: e && e.commonEventObject ? e.commonEventObject.platform || '' : '',
    hasCalendar: !!(e && e.calendar),
    calendarId: e && e.calendar && typeof e.calendar.id === 'string' ? e.calendar.id : '',
    calendarCalendarId: e && e.calendar && typeof e.calendar.calendarId === 'string'
      ? e.calendar.calendarId
      : ''
  };

  var payload = {
    executionAuthMode: e && e.commonEventObject ? e.commonEventObject.authMode || '' : '',
    request: {
      userinfoEmailScope: TEMP_USERINFO_EMAIL_SCOPE,
      requireScopesReturned: requested,
      requireScopesError: requireScopeError
    },
    session: {
      activeUserEmail: activeUserEmail,
      activeUserError: activeUserError,
      effectiveUserEmail: effectiveUserEmail,
      effectiveUserError: effectiveUserError,
      temporaryActiveUserKey: temporaryActiveUserKey,
      temporaryActiveUserKeyError: temporaryActiveUserKeyError
    },
    property: {
      attendanceOperatorEmailPresent: !!trustedOperatorEmail,
      attendanceOperatorEmail: trustedOperatorEmail,
      error: trustedOperatorError
    },
    event: eventShape,
    comparison: {
      activeMatchesTrusted: !!activeUserEmail && !!trustedOperatorEmail &&
        activeUserEmail === trustedOperatorEmail,
      effectiveMatchesTrusted: !!effectiveUserEmail && !!trustedOperatorEmail &&
        effectiveUserEmail === trustedOperatorEmail,
      activeEqualsEffective: !!activeUserEmail && !!effectiveUserEmail &&
        activeUserEmail === effectiveUserEmail
    }
  };

  return CardService.newCardBuilder()
    .setHeader(
      CardService.newCardHeader().setTitle('Secretary OAuth Diagnostic Result')
    )
    .addSection(
      CardService.newCardSection()
        .setHeader('النتيجة')
        .addWidget(
          CardService.newTextParagraph().setText(
            '<pre>' +
            _tempEscapeHtml(JSON.stringify(payload, null, 2)) +
            '</pre>'
          )
        )
    )
    .build();
}

function _tempEscapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
