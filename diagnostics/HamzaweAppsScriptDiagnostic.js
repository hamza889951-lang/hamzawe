/**
 * HAMZAWE — Apps Script Diagnostic
 * ---------------------------------
 * DIAGNOSTIC ONLY. This file must not change application state.
 *
 * Purpose:
 *   Identify whether an Apps Script failure is caused by:
 *   1) script/runtime availability,
 *   2) project configuration / script properties,
 *   3) spreadsheet access,
 *   4) Calendar service / advanced Calendar API,
 *   5) URL Fetch capability,
 *   6) execution locks / trigger visibility,
 *   7) missing/failed application globals after clasp synchronization,
 *   8) unexpected execution errors.
 *
 * Safety:
 *   - No writes to Sheets.
 *   - No writes to Properties.
 *   - No Calendar mutations.
 *   - No WhatsApp/Meta messages.
 *   - No webhook calls.
 *   - No deployment changes.
 *   - No manifest changes.
 *
 * Run from the Apps Script editor:
 *   runHamzaweDiagnostic()
 *
 * The function returns a JSON-safe report and also logs it.
 * Copy the complete returned object / execution log back for analysis.
 */

var HAMZAWE_DIAGNOSTIC = (function() {
  'use strict';

  var VERSION = 'HAMZAWE-APPS-SCRIPT-DIAGNOSTIC-v1.0';
  var startedAt = new Date().toISOString();

  function ok(name, detail, extra) {
    return Object.assign({
      name: name,
      status: 'PASS',
      detail: detail || ''
    }, extra || {});
  }

  function fail(name, error, extra) {
    return Object.assign({
      name: name,
      status: 'FAIL',
      errorType: error && error.name ? String(error.name) : 'Error',
      errorMessage: error && error.message ? String(error.message) : String(error),
      errorStack: error && error.stack ? String(error.stack).substring(0, 3000) : ''
    }, extra || {});
  }

  function warn(name, detail, extra) {
    return Object.assign({
      name: name,
      status: 'WARN',
      detail: detail || ''
    }, extra || {});
  }

  function runCheck(name, fn) {
    var t0 = new Date().getTime();
    try {
      var result = fn();
      var elapsedMs = new Date().getTime() - t0;
      return Object.assign({}, result || ok(name, 'Completed'), {
        name: name,
        elapsedMs: elapsedMs
      });
    } catch (e) {
      return fail(name, e, {
        elapsedMs: new Date().getTime() - t0
      });
    }
  }

  function typeOfGlobal(name) {
    try {
      return typeof this[name];
    } catch (e) {
      return 'ERROR:' + e.message;
    }
  }

  function globalCheck(name) {
    var type = typeOfGlobal(name);
    return {
      symbol: name,
      type: type,
      present: type !== 'undefined'
    };
  }

  function safeString(value) {
    if (value === null) return null;
    if (value === undefined) return undefined;
    if (value instanceof Date) return {
      value: value.toISOString(),
      type: 'Date'
    };
    return {
      value: String(value),
      type: typeof value
    };
  }

  function run() {
    var report = {
      diagnosticVersion: VERSION,
      startedAt: startedAt,
      finishedAt: null,
      executionId: null,
      scriptId: null,
      timezone: null,
      checks: [],
      globals: [],
      summary: null
    };

    // ---------------------------------------------------------
    // 1. Core runtime
    // ---------------------------------------------------------
    report.checks.push(runCheck('CORE_RUNTIME', function() {
      var now = new Date();
      if (isNaN(now.getTime())) throw new Error('Date runtime is invalid.');

      var scriptId = ScriptApp.getScriptId();
      if (!scriptId) throw new Error('ScriptApp.getScriptId() returned empty.');

      report.scriptId = scriptId;

      try {
        report.executionId = ScriptApp.getExecutionInfo().getExecutionId();
      } catch (ignored) {
        // ExecutionInfo may not expose an ID in every execution context.
      }

      try {
        report.timezone = Session.getScriptTimeZone();
      } catch (ignored2) {
        report.timezone = 'UNAVAILABLE';
      }

      return ok(
        'CORE_RUNTIME',
        'Apps Script V8 runtime is executing normally.',
        {
          now: now.toISOString(),
          timezone: report.timezone
        }
      );
    }));

    // ---------------------------------------------------------
    // 2. Built-in services availability
    // ---------------------------------------------------------
    var builtIns = [
      'ScriptApp',
      'PropertiesService',
      'SpreadsheetApp',
      'CalendarApp',
      'UrlFetchApp',
      'LockService',
      'Utilities',
      'Session'
    ];

    for (var i = 0; i < builtIns.length; i++) {
      (function(name) {
        report.checks.push(runCheck('SERVICE_' + name, function() {
          var type = typeOfGlobal(name);
          if (type === 'undefined') {
            throw new Error(name + ' is undefined.');
          }
          return ok('SERVICE_' + name, name + ' is available.', { type: type });
        }));
      })(builtIns[i]);
    }

    // ---------------------------------------------------------
    // 3. Script Properties — READ ONLY
    // ---------------------------------------------------------
    report.checks.push(runCheck('SCRIPT_PROPERTIES_READ', function() {
      var props = PropertiesService.getScriptProperties().getProperties();
      var keys = Object.keys(props).sort();

      // Deliberately do NOT return values: tokens/secrets must never
      // appear in the diagnostic report.
      return ok(
        'SCRIPT_PROPERTIES_READ',
        'Script Properties can be read.',
        {
          keyCount: keys.length,
          keys: keys.map(function(key) {
            return key;
          })
        }
      );
    }));

    // ---------------------------------------------------------
    // 4. Spreadsheet access — READ ONLY
    // ---------------------------------------------------------
    report.checks.push(runCheck('SPREADSHEET_ACCESS', function() {
      var props = PropertiesService.getScriptProperties();
      var spreadsheetId = props.getProperty('SPREADSHEET_ID');

      if (spreadsheetId) {
        var ss = SpreadsheetApp.openById(spreadsheetId);
        var sheets = ss.getSheets();
        return ok(
          'SPREADSHEET_ACCESS',
          'Configured spreadsheet can be opened read-only.',
          {
            spreadsheetIdPresent: true,
            spreadsheetIdMasked: maskId(spreadsheetId),
            spreadsheetName: ss.getName(),
            sheetCount: sheets.length,
            sheetNames: sheets.map(function(sheet) { return sheet.getName(); }).slice(0, 50)
          }
        );
      }

      var active = SpreadsheetApp.getActiveSpreadsheet();
      if (!active) {
        return warn(
          'SPREADSHEET_ACCESS',
          'No SPREADSHEET_ID property and no active spreadsheet is available.'
        );
      }

      return ok(
        'SPREADSHEET_ACCESS',
        'Active spreadsheet is accessible read-only.',
        {
          spreadsheetIdPresent: false,
          spreadsheetName: active.getName(),
          sheetCount: active.getSheets().length
        }
      );
    }));

    // ---------------------------------------------------------
    // 5. Required HAMZAWE sheets — READ ONLY
    // ---------------------------------------------------------
    var expectedSheets = [
      'conversations',
      'settings',
      'schedule_changes'
    ];

    report.checks.push(runCheck('HAMZAWE_SHEETS', function() {
      var props = PropertiesService.getScriptProperties();
      var spreadsheetId = props.getProperty('SPREADSHEET_ID');
      var ss = spreadsheetId
        ? SpreadsheetApp.openById(spreadsheetId)
        : SpreadsheetApp.getActiveSpreadsheet();

      if (!ss) {
        throw new Error('Cannot inspect HAMZAWE sheets: spreadsheet unavailable.');
      }

      var found = {};
      expectedSheets.forEach(function(name) {
        var sheet = ss.getSheetByName(name);
        found[name] = sheet ? {
          exists: true,
          lastRow: sheet.getLastRow(),
          lastColumn: sheet.getLastColumn()
        } : {
          exists: false
        };
      });

      var missing = expectedSheets.filter(function(name) {
        return !found[name].exists;
      });

      if (missing.length) {
        return warn(
          'HAMZAWE_SHEETS',
          'Some expected sheets are missing.',
          { sheets: found, missing: missing }
        );
      }

      return ok(
        'HAMZAWE_SHEETS',
        'Expected HAMZAWE sheets are accessible read-only.',
        { sheets: found }
      );
    }));

    // ---------------------------------------------------------
    // 6. CalendarApp — READ ONLY
    // ---------------------------------------------------------
    report.checks.push(runCheck('CALENDAR_APP_READ', function() {
      var calendar = CalendarApp.getDefaultCalendar();
      if (!calendar) throw new Error('Default calendar is unavailable.');

      return ok(
        'CALENDAR_APP_READ',
        'CalendarApp can access the default calendar read-only.',
        {
          calendarIdMasked: maskId(calendar.getId()),
          calendarName: calendar.getName()
        }
      );
    }));

    // ---------------------------------------------------------
    // 7. Advanced Calendar service — READ ONLY
    // ---------------------------------------------------------
    report.checks.push(runCheck('ADVANCED_CALENDAR_READ', function() {
      if (typeof Calendar === 'undefined') {
        return warn(
          'ADVANCED_CALENDAR_READ',
          'Advanced Calendar service symbol is unavailable.'
        );
      }

      // Read-only API call. No event/calendar mutation.
      var response = Calendar.CalendarList.list({
        maxResults: 1,
        showHidden: false
      });

      return ok(
        'ADVANCED_CALENDAR_READ',
        'Advanced Calendar service is callable read-only.',
        {
          returnedItems: response && response.items ? response.items.length : 0
        }
      );
    }));

    // ---------------------------------------------------------
    // 8. UrlFetchApp capability — NO NETWORK REQUEST
    // ---------------------------------------------------------
    report.checks.push(runCheck('URLFETCH_REQUEST_BUILD', function() {
      var url = 'https://graph.facebook.com/';
      var request = UrlFetchApp.getRequest(url, {
        method: 'get',
        muteHttpExceptions: true
      });

      if (!request || request.url !== url) {
        throw new Error('UrlFetchApp.getRequest() returned an unexpected request object.');
      }

      return ok(
        'URLFETCH_REQUEST_BUILD',
        'UrlFetchApp can construct an external request. No network call was made.',
        {
          url: url,
          method: request.method || 'get'
        }
      );
    }));

    // ---------------------------------------------------------
    // 9. Lock service — acquire/release only
    // ---------------------------------------------------------
    report.checks.push(runCheck('LOCK_SERVICE', function() {
      var lock = LockService.getScriptLock();
      var acquired = lock.tryLock(1000);

      if (!acquired) {
        return warn(
          'LOCK_SERVICE',
          'Script lock could not be acquired within 1 second. Another execution may currently hold it.'
        );
      }

      lock.releaseLock();

      return ok(
        'LOCK_SERVICE',
        'Script lock can be acquired and released.'
      );
    }));

    // ---------------------------------------------------------
    // 10. Trigger visibility — READ ONLY
    // ---------------------------------------------------------
    report.checks.push(runCheck('TRIGGER_VISIBILITY', function() {
      var triggers = ScriptApp.getProjectTriggers();

      return ok(
        'TRIGGER_VISIBILITY',
        'Project triggers can be enumerated.',
        {
          count: triggers.length,
          triggers: triggers.map(function(trigger) {
            return {
              handlerFunction: trigger.getHandlerFunction(),
              eventType: String(trigger.getEventType()),
              triggerSource: String(trigger.getTriggerSource())
            };
          })
        }
      );
    }));

    // ---------------------------------------------------------
    // 11. HAMZAWE global symbol inventory
    // ---------------------------------------------------------
    var hamzaweGlobals = [
      'Config',
      'Result',
      'GoogleSheets',
      'ConversationRepository',
      'ScheduleChangeRepository',
      'DoctorControlInteractionService',
      'DoctorScheduleCommandService',
      'EffectiveScheduleService',
      'SlotRepository',
      'WhatsAppAdapter',
      'ProcessedMessagesService',
      'DateUtils',
      'Clock',
      'IdGenerator'
    ];

    for (var g = 0; g < hamzaweGlobals.length; g++) {
      var item = globalCheck(hamzaweGlobals[g]);
      report.globals.push(item);
    }

    var missingGlobals = report.globals.filter(function(item) {
      return !item.present;
    });

    report.checks.push(
      missingGlobals.length
        ? warn(
            'HAMZAWE_GLOBALS',
            'One or more expected application globals are not loaded in this execution context.',
            {
              missing: missingGlobals.map(function(item) { return item.symbol; })
            }
          )
        : ok(
            'HAMZAWE_GLOBALS',
            'Expected HAMZAWE application globals are visible.',
            { checked: report.globals.length }
          )
    );

    // ---------------------------------------------------------
    // 12. Read-only smoke checks against GoogleSheets boundary
    // ---------------------------------------------------------
    report.checks.push(runCheck('GOOGLE_SHEETS_BOUNDARY', function() {
      if (typeof GoogleSheets === 'undefined') {
        return warn(
          'GOOGLE_SHEETS_BOUNDARY',
          'GoogleSheets global is not loaded; boundary smoke check skipped.'
        );
      }

      if (typeof GoogleSheets.getHeaders !== 'function') {
        throw new Error('GoogleSheets.getHeaders is missing.');
      }

      var props = PropertiesService.getScriptProperties();
      var spreadsheetId = props.getProperty('SPREADSHEET_ID');
      var ss = spreadsheetId
        ? SpreadsheetApp.openById(spreadsheetId)
        : SpreadsheetApp.getActiveSpreadsheet();

      if (!ss) {
        throw new Error('Spreadsheet unavailable.');
      }

      var sheet = ss.getSheetByName('conversations');
      if (!sheet) {
        return warn(
          'GOOGLE_SHEETS_BOUNDARY',
          'conversations sheet is missing; boundary check skipped.'
        );
      }

      var lastColumn = sheet.getLastColumn();
      if (lastColumn < 1) {
        return warn(
          'GOOGLE_SHEETS_BOUNDARY',
          'conversations sheet has no columns.'
        );
      }

      var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];

      return ok(
        'GOOGLE_SHEETS_BOUNDARY',
        'GoogleSheets dependency is loaded and conversations headers are readable.',
        {
          headerCount: headers.length,
          importantHeaders: [
            'id',
            'phone',
            'state',
            'doctor_ux_step',
            'doctor_draft_effective_from',
            'doctor_draft_effective_to'
          ].map(function(name) {
            return {
              name: name,
              present: headers.indexOf(name) !== -1
            };
          })
        }
      );
    }));

    // ---------------------------------------------------------
    // 13. Function inventory / entry-point presence
    // ---------------------------------------------------------
    var entryPoints = [
      'doGet',
      'doPost',
      'onCalendarEventOpen',
      'runHamzaweDiagnostic'
    ];

    report.checks.push(runCheck('ENTRY_POINTS', function() {
      var entries = entryPoints.map(function(name) {
        var type = typeOfGlobal(name);
        return {
          name: name,
          type: type,
          present: type === 'function'
        };
      });

      return ok(
        'ENTRY_POINTS',
        'Entry-point inventory completed without invoking any entry point.',
        { entries: entries }
      );
    }));

    // ---------------------------------------------------------
    // 14. Final classification
    // ---------------------------------------------------------
    var failures = report.checks.filter(function(c) {
      return c.status === 'FAIL';
    });

    var warnings = report.checks.filter(function(c) {
      return c.status === 'WARN';
    });

    var passes = report.checks.filter(function(c) {
      return c.status === 'PASS';
    });

    var runtimeFailed = report.checks.some(function(c) {
      return c.name === 'CORE_RUNTIME' && c.status === 'FAIL';
    });

    report.summary = {
      classification:
        runtimeFailed ? 'RUNTIME_FAILURE' :
        failures.length ? 'ENVIRONMENT_OR_PERMISSION_FAILURE' :
        warnings.length ? 'RUNTIME_OK_WITH_WARNINGS' :
        'DIAGNOSTIC_BASELINE_PASS',
      passCount: passes.length,
      warningCount: warnings.length,
      failureCount: failures.length,
      failedChecks: failures.map(function(c) { return c.name; }),
      warningChecks: warnings.map(function(c) { return c.name; }),
      interpretation:
        runtimeFailed
          ? 'Apps Script execution itself failed before normal diagnostics completed.'
          : failures.length
            ? 'Apps Script executes, but one or more required services/configuration checks failed.'
            : warnings.length
              ? 'Apps Script executes; investigate warnings before touching application code.'
              : 'Runtime and tested dependencies are healthy. If the production webhook still fails, investigate application-specific execution paths/logs.'
    };

    report.finishedAt = new Date().toISOString();

    return report;
  }

  function maskId(value) {
    var s = String(value || '');
    if (s.length <= 8) return '***';
    return s.substring(0, 4) + '...' + s.substring(s.length - 4);
  }

  return {
    version: VERSION,
    run: run
  };
})();

/**
 * Main manual diagnostic entry point.
 *
 * IMPORTANT:
 * This function does not throw on individual diagnostic failures.
 * It returns the complete report so the Apps Script execution itself
 * can finish and expose the actual failing layer.
 */
function runHamzaweDiagnostic() {
  var report = HAMZAWE_DIAGNOSTIC.run();
  var serialized = JSON.stringify(report, null, 2);

  console.log(serialized);
  Logger.log(serialized);

  return report;
}
