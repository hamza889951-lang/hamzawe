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

function makeRepositorySandbox(active) {
  const props = {
    HAMZAWE_CALENDAR_ID: 'clinic-calendar@example.com',
    ATTENDANCE_SECRETARY_EMAIL: 'Secretary@Example.com',
    ATTENDANCE_OPERATOR_EMAIL: 'secretary@example.com',
    HAMZAWE_RSVP_BOUND_CALENDAR_ID: 'clinic-calendar@example.com',
    HAMZAWE_RSVP_BOUND_SECRETARY_EMAIL: 'secretary@example.com'
  };
  const captures = { generic: [], lifecycle: [] };
  const result = {
    ok(data) { return { ok: true, data: data }; },
    fail(code, message, data) { return { ok: false, error: { code: code, message: message, data: data } }; }
  };

  const sandbox = {
    Result: result,
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
    CalendarRsvpConfigRepository: {
      getRuntimeConfig() {
        return result.ok({
          calendarId: props.HAMZAWE_CALENDAR_ID,
          secretaryEmail: props.ATTENDANCE_SECRETARY_EMAIL.trim().toLowerCase(),
          trustedOperatorEmail: props.ATTENDANCE_OPERATOR_EMAIL.trim().toLowerCase()
        });
      },
      getActive() { return result.ok(active); },
      validateConfigBinding(config) {
        return config.calendarId === props.HAMZAWE_CALENDAR_ID
          ? result.ok({ matches: true, bound: true })
          : result.fail('RSVP_ACTIVE_CONFIG_MISMATCH', 'binding mismatch');
      },
      validateTrustedOperator(config) {
        return config.trustedOperatorEmail === config.secretaryEmail
          ? result.ok({ trustedOperatorEmail: config.trustedOperatorEmail })
          : result.fail('RSVP_OPERATOR_POLICY_MISMATCH', 'operator mismatch');
      }
    },
    GoogleCalendar: {
      createEvent(params) { captures.generic.push(params); return 'GENERIC_EVENT'; },
      createLifecycleEvent(params) { captures.lifecycle.push(params); return { eventId: 'LIFECYCLE_EVENT', calendarId: params.calendarId, operationId: params.operationId }; },
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

function runProjectionAssertions(env) {
  const generic = env.sandbox.CalendarRepository.createAppointmentEvent({ title: 'generic' });
  const lifecycle = env.sandbox.CalendarRepository.createLifecycleAppointmentEvent({ title: 'lifecycle', operationId: 'OP_1' });
  assert.strictEqual(generic.ok, true);
  assert.strictEqual(lifecycle.ok, true);
  assert.strictEqual(env.captures.generic[0].calendarId, 'clinic-calendar@example.com');
  assert.strictEqual(env.captures.generic[0].secretaryEmail, 'secretary@example.com');
  assert.strictEqual(env.captures.lifecycle[0].calendarId, 'clinic-calendar@example.com');
  assert.strictEqual(env.captures.lifecycle[0].secretaryEmail, 'secretary@example.com');
}

{
  const env = makeRepositorySandbox(true);
  load(env.sandbox, 'Repositories/CalendarRepository.js', 'CalendarRepository');
  runProjectionAssertions(env);
}

{
  const env = makeRepositorySandbox(false);
  load(env.sandbox, 'Repositories/CalendarRepository.js', 'CalendarRepository');
  const legacy = env.sandbox.CalendarRepository.createLifecycleAppointmentEvent({
    title: 'legacy', operationId: 'OP_2', calendarId: 'legacy-calendar'
  });
  assert.strictEqual(legacy.ok, true);
  assert.strictEqual(env.captures.lifecycle[0].calendarId, 'legacy-calendar',
    'inactive RSVP preserves the caller-provided legacy calendar');
  assert.strictEqual(env.captures.lifecycle[0].secretaryEmail, undefined,
    'inactive RSVP does not inject secretary attendee');
}

// Infrastructure must be the sole owner of CalendarApp guest projection.
const infrastructure = fs.readFileSync(path.join(ROOT, 'Infrastructure/GoogleCalendar.js'), 'utf8');
assert.ok(infrastructure.includes('if (params.secretaryEmail) event.addGuest(params.secretaryEmail);'));

console.log('Calendar RSVP/B6 projection tests: 2/2 PASS');
