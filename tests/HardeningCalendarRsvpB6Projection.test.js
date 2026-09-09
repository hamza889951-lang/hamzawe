'use strict';

/**
 * RSVP/B6 projection regression.
 *
 * The RSVP activation binding is a cross-cutting Calendar concern. Every
 * appointment-creation boundary must therefore project the configured
 * calendar and secretary attendee consistently, including B6 lifecycle
 * creation. This test owns that contract at the CalendarRepository seam.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function load(sandbox, relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, { filename: relativePath });
}

function makeSandbox(active) {
  const props = {
    HAMZAWE_CALENDAR_ID: 'clinic-calendar@example.com',
    ATTENDANCE_SECRETARY_EMAIL: 'Secretary@Example.com',
    ATTENDANCE_OPERATOR_EMAIL: 'secretary@example.com',
    HAMZAWE_RSVP_BOUND_CALENDAR_ID: 'clinic-calendar@example.com',
    HAMZAWE_RSVP_BOUND_SECRETARY_EMAIL: 'secretary@example.com',
    HAMZAWE_RSVP_ACTIVE: active ? 'true' : 'false'
  };
  const captures = { generic: [], lifecycle: [], guests: [] };

  const sandbox = {
    Result: {
      ok(data) { return { ok: true, data: data }; },
      fail(code, message, data) { return { ok: false, error: { code: code, message: message, data: data } }; }
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) { return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null; },
          setProperty() {},
          deleteProperty() {},
          setProperties() {}
        };
      }
    },
    CalendarApp: {
      getCalendarById(id) {
        return {
          getId() { return id; },
          createEvent(title, start, end, options) {
            const capture = { title, start, end, options, guests: [] };
            captures.generic.push(capture);
            return {
              getId() { return 'event-' + captures.generic.length; },
              addGuest(email) { capture.guests.push(email); captures.guests.push(email); },
              setTag() {},
              getTag() { return ''; },
              deleteEvent() {}
            };
          },
          getEventById() { return null; },
          getEvents() { return []; }
        };
      },
      getDefaultCalendar() {
        return null;
      }
    },
    CalendarRsvpConfigRepository: {
      getRuntimeConfig() {
        return sandbox.Result.ok({
          calendarId: String(props.HAMZAWE_CALENDAR_ID),
          secretaryEmail: String(props.ATTENDANCE_SECRETARY_EMAIL).trim().toLowerCase(),
          trustedOperatorEmail: String(props.ATTENDANCE_OPERATOR_EMAIL).trim().toLowerCase()
        });
      },
      getActive() {
        return sandbox.Result.ok(active);
      },
      validateConfigBinding(config) {
        return sandbox.Result.ok({
          matches: config.calendarId === 'clinic-calendar@example.com',
          bound: true
        });
      },
      validateTrustedOperator(config) {
        return config.trustedOperatorEmail === config.secretaryEmail
          ? sandbox.Result.ok({ trustedOperatorEmail: config.trustedOperatorEmail })
          : sandbox.Result.fail('RSVP_OPERATOR_POLICY_MISMATCH', 'operator mismatch');
      }
    },
    GoogleCalendar: {
      createEvent(params) {
        captures.generic.push({ lifecycle: false, params });
        return 'generic-event';
      },
      createLifecycleEvent(params) {
        captures.lifecycle.push(params);
        return { eventId: 'lifecycle-event', calendarId: params.calendarId, operationId: params.operationId };
      },
      resolveAppointmentEventIdentity() {},
      inspectLifecycleEvent() {},
      deleteLifecycleEvent() {},
      findLifecycleEventsByOperationId() {},
      deleteEvent() {}
    }
  };
  vm.createContext(sandbox);
  return { sandbox, captures };
}

function runActiveProjectionTest() {
  const env = makeSandbox(true);
  load(env.sandbox, 'Repositories/CalendarRepository.js', 'CalendarRepository');

  const generic = env.sandbox.CalendarRepository.createAppointmentEvent({
    title: 'generic', startTime: new Date('2026-09-09T13:00:00Z'), endTime: new Date('2026-09-09T13:30:00Z')
  });
  const lifecycle = env.sandbox.CalendarRepository.createLifecycleAppointmentEvent({
    title: 'lifecycle', startTime: new Date('2026-09-09T13:00:00Z'), endTime: new Date('2026-09-09T13:30:00Z'), operationId: 'OP_1'
  });

  assert.strictEqual(generic.ok, true);
  assert.strictEqual(lifecycle.ok, true);
  assert.strictEqual(env.captures.lifecycle.length, 1);
  assert.strictEqual(env.captures.lifecycle[0].calendarId, 'clinic-calendar@example.com');
  assert.strictEqual(env.captures.lifecycle[0].secretaryEmail, 'secretary@example.com');

  // The lifecycle path is sent through the same repository preparation seam;
  // the remaining guest projection belongs to Infrastructure/GoogleCalendar.
  const infrastructure = fs.readFileSync(path.join(ROOT, 'Infrastructure/GoogleCalendar.js'), 'utf8');
  assert.ok(infrastructure.indexOf('if (params.secretaryEmail) event.addGuest(params.secretaryEmail);') !== -1,
    'lifecycle infrastructure must project the configured secretary attendee');
}

function runInactiveProjectionTest() {
  const env = makeSandbox(false);
  load(env.sandbox, 'Repositories/CalendarRepository.js', 'CalendarRepository');

  const lifecycle = env.sandbox.CalendarRepository.createLifecycleAppointmentEvent({
    title: 'legacy', startTime: new Date('2026-09-09T13:00:00Z'), endTime: new Date('2026-09-09T13:30:00Z'), operationId: 'OP_2', calendarId: 'legacy-calendar'
  });

  assert.strictEqual(lifecycle.ok, true);
  assert.strictEqual(env.captures.lifecycle[0].calendarId, undefined,
    'inactive RSVP does not inject a calendar override');
  assert.strictEqual(env.captures.lifecycle[0].operationId, 'OP_2');
}

runActiveProjectionTest();
runInactiveProjectionTest();
console.log('Calendar RSVP/B6 projection tests: 2/2 PASS');
