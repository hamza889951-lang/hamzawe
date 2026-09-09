const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function makeResult() {
  return {
    ok(data) { return { ok: true, data: data }; },
    fail(code, message, data) { return { ok: false, error: { code: code, message: message, data: data } }; }
  };
}

function makeHarness() {
  const props = {};
  const calls = { list: [], get: [], attendance: [], triggers: [], creates: [] };
  const calendars = [];
  const triggerObjects = [];
  let listQueue = [];
  let getQueue = [];
  let triggerCreateCount = 0;

  const sandbox = {
    Result: makeResult(),
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) { return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null; },
          deleteProperty(key) { delete props[key]; },
          setProperties(values) { Object.keys(values).forEach(k => { props[k] = String(values[k]); }); },
          setProperty(key, value) { props[key] = String(value); }
        };
      }
    },
    Lock: { runExclusive(key, fn) { return fn(); } },
    Session: { getEffectiveUser() { return { getEmail() { return 'owner@example.com'; } }; } },
    AttendanceService: {
      markCompleted(context) { calls.attendance.push({ decision: 'completed', context }); return sandbox.__attendanceResult || sandbox.Result.ok({ applied: true, alreadyApplied: false }); },
      markNoShow(context) { calls.attendance.push({ decision: 'no_show', context }); return sandbox.__attendanceResult || sandbox.Result.ok({ applied: true, alreadyApplied: false }); }
    },
    Calendar: {
      Events: {
        list(calendarId, params) {
          calls.list.push({ calendarId, params: Object.assign({}, params) });
          if (!listQueue.length) return { items: [], nextSyncToken: 'token-default' };
          const item = listQueue.shift();
          if (item instanceof Error) throw item;
          return item;
        },
        get(calendarId, eventId) {
          calls.get.push({ calendarId, eventId });
          if (!getQueue.length) return null;
          const item = getQueue.shift();
          if (item instanceof Error) throw item;
          return item;
        }
      }
    },
    ScriptApp: {
      EventType: { ON_EVENT_UPDATED: 'ON_EVENT_UPDATED' },
      getProjectTriggers() { return triggerObjects.slice(); },
      newTrigger(handler) {
        const builder = {
          forUserCalendar(calendarId) {
            this.calendarId = calendarId;
            return this;
          },
          onEventUpdated() { this.eventType = 'ON_EVENT_UPDATED'; return this; },
          create() {
            triggerCreateCount++;
            triggerObjects.push({
              getHandlerFunction: () => handler,
              getEventType: () => 'ON_EVENT_UPDATED',
              getTriggerSourceId: () => this.calendarId
            });
          }
        };
        return builder;
      }
    },
    CalendarApp: {
      getCalendarById(id) {
        return {
          getId: () => id,
          createEvent(title, start, end, options) {
            calls.creates.push({ id, title, start, end, options, guests: [] });
            const record = calls.creates[calls.creates.length - 1];
            return {
              getId: () => 'event-' + calls.creates.length,
              addGuest(email) { record.guests.push(email); },
              setTag() {},
              getTag() { return ''; }
            };
          },
          getEventById() { return null; },
          getEvents() { return []; }
        };
      },
      getDefaultCalendar() { return null; }
    },
    __attendanceResult: null,
    __setListQueue(items) { listQueue = items.slice(); },
    __setGetQueue(items) { getQueue = items.slice(); },
    __props: props,
    __calls: calls,
    __triggerCreateCount() { return triggerCreateCount; }
  };
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, relPath) {
  const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  vm.runInContext(source, sandbox, { filename: relPath });
}

function loadRsvp(sandbox) {
  load(sandbox, 'Repositories/CalendarRsvpConfigRepository.js');
  load(sandbox, 'Repositories/CalendarRsvpSyncRepository.js');
  load(sandbox, 'Infrastructure/CalendarRsvpTrigger.js');
  load(sandbox, 'Application/CalendarRsvpAttendanceService.js');
}

function event(responseStatus, extra) {
  return Object.assign({
    id: 'evt-1',
    iCalUID: 'uid-1',
    status: 'confirmed',
    attendees: [{ email: 'Secretary@Example.com ', responseStatus: responseStatus }]
  }, extra || {});
}

function configure(sandbox) {
  sandbox.__props.HAMZAWE_CALENDAR_ID = 'clinic-calendar@example.com';
  sandbox.__props.ATTENDANCE_SECRETARY_EMAIL = 'Secretary@Example.com';
  sandbox.__props.HAMZAWE_RSVP_INITIALIZED = 'true';
  sandbox.__props.HAMZAWE_RSVP_RESPONSE_CHECKPOINTS = '{}';
  sandbox.__props.HAMZAWE_RSVP_SYNC_TOKEN = 'sync-1';
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}

test('config normalizes secretary email and requires explicit calendar', () => {
  const s = makeHarness(); load(s, 'Repositories/CalendarRsvpConfigRepository.js');
  s.__props.HAMZAWE_CALENDAR_ID = 'cal-1'; s.__props.ATTENDANCE_SECRETARY_EMAIL = '  SEC@Example.COM ';
  const r = s.CalendarRsvpConfigRepository.getRuntimeConfig();
  assert.strictEqual(r.ok, true); assert.strictEqual(r.data.calendarId, 'cal-1'); assert.strictEqual(r.data.secretaryEmail, 'sec@example.com');
});

test('config fails closed when calendar id is missing', () => {
  const s = makeHarness(); load(s, 'Repositories/CalendarRsvpConfigRepository.js');
  s.__props.ATTENDANCE_SECRETARY_EMAIL = 'sec@example.com';
  assert.strictEqual(s.CalendarRsvpConfigRepository.getRuntimeConfig().error.code, 'RSVP_CALENDAR_ID_UNCONFIGURED');
});

test('sync requests keep stable full/incremental parameter shape', () => {
  const s = makeHarness(); load(s, 'Repositories/CalendarRsvpSyncRepository.js');
  s.CalendarRsvpSyncRepository.listPage('cal', null, null); s.CalendarRsvpSyncRepository.listPage('cal', 'tok', 'page');
  assert.strictEqual(s.__calls.list[0].params.showDeleted, true);
  assert.strictEqual(s.__calls.list[0].params.singleEvents, false);
  assert.strictEqual('syncToken' in s.__calls.list[0].params, false);
  assert.strictEqual(s.__calls.list[1].params.syncToken, 'tok');
  assert.strictEqual(s.__calls.list[1].params.pageToken, 'page');
  assert.strictEqual('timeMin' in s.__calls.list[1].params, false);
});

test('pagination consumes every page and only returns final sync token', () => {
  const s = makeHarness(); loadRsvp(s);
  s.CalendarRsvpAttendanceService._collectPages('cal', 'tok');
  s.__setListQueue([
    { items: [event('needsAction')], nextPageToken: 'p2' },
    { items: [event('tentative', { iCalUID: 'uid-2', id: 'evt-2' })], nextSyncToken: 'final' }
  ]);
  const r = s.CalendarRsvpAttendanceService._collectPages('cal', 'tok');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.data.items.length, 2); assert.strictEqual(r.data.nextSyncToken, 'final');
});

test('baseline observes accepted RSVP without mutating Availability', () => {
  const s = makeHarness(); configure(s); s.__props.HAMZAWE_RSVP_INITIALIZED = 'false'; loadRsvp(s);
  s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'base-2' }]);
  const r = s.CalendarRsvpAttendanceService.initializeBaseline();
  assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance.length, 0); assert.strictEqual(s.__props.HAMZAWE_RSVP_SYNC_TOKEN, 'base-2');
});

test('accepted RSVP maps to completed with secretary as actor', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]);
  const r = s.CalendarRsvpAttendanceService.syncNow();
  assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance[0].decision, 'completed');
  assert.strictEqual(s.__calls.attendance[0].context.operator.operatorId, 'secretary@example.com');
  assert.strictEqual(s.__calls.attendance[0].context.executionPrincipal, 'owner@example.com');
});

test('declined RSVP maps to no-show', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  s.__setListQueue([{ items: [event('declined')], nextSyncToken: 'sync-2' }]);
  const r = s.CalendarRsvpAttendanceService.syncNow();
  assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance[0].decision, 'no_show');
});

test('needsAction and tentative produce no decision', () => {
  ['needsAction', 'tentative'].forEach((status, index) => {
    const s = makeHarness(); configure(s); loadRsvp(s);
    s.__setListQueue([{ items: [event(status, { iCalUID: 'uid-' + index })], nextSyncToken: 'sync-2' }]);
    const r = s.CalendarRsvpAttendanceService.syncNow();
    assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance.length, 0);
  });
});

test('same RSVP response is idempotently skipped', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]);
  assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true);
  s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-3' }]);
  assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true);
  assert.strictEqual(s.__calls.attendance.length, 1);
});

test('attendeesOmitted causes authoritative refetch', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  s.__setListQueue([{ items: [event('needsAction', { attendeesOmitted: true })], nextSyncToken: 'sync-2' }]);
  s.__setGetQueue([{ attendees: [{ email: 'secretary@example.com', responseStatus: 'accepted' }], status: 'confirmed', id: 'evt-1', iCalUID: 'uid-1' }]);
  const r = s.CalendarRsvpAttendanceService.syncNow();
  assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.get.length, 1); assert.strictEqual(s.__calls.attendance.length, 1);
});

test('unavailable attendee evidence does not mutate or advance via candidate', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  s.__setListQueue([{ items: [event('accepted', { attendeesOmitted: true })], nextSyncToken: 'sync-2' }]);
  s.__setGetQueue([{ attendeesOmitted: true, id: 'evt-1', iCalUID: 'uid-1' }]);
  const r = s.CalendarRsvpAttendanceService.syncNow();
  assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance.length, 0);
});

test('cancelled event never maps to no-show', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  s.__setListQueue([{ items: [event('accepted', { status: 'cancelled' })], nextSyncToken: 'sync-2' }]);
  const r = s.CalendarRsvpAttendanceService.syncNow();
  assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance.length, 0);
});

test('semantic rejection is diagnosed and checkpointed', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  s.__attendanceResult = s.Result.fail('ATTENDANCE_EVENT_NOT_CORRELATED', 'unknown');
  s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]);
  assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true);
  s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-3' }]);
  assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true);
  assert.strictEqual(s.__calls.attendance.length, 1);
});

test('retryable Attendance failure preserves replayability', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  s.__attendanceResult = s.Result.fail('LOCK_TIMEOUT', 'busy');
  s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]);
  const r = s.CalendarRsvpAttendanceService.syncNow();
  assert.strictEqual(r.ok, false); assert.strictEqual(s.__props.HAMZAWE_RSVP_SYNC_TOKEN, 'sync-1');
});

test('410 sync token triggers one full resync', () => {
  const s = makeHarness(); configure(s); loadRsvp(s);
  const stale = new Error('HTTP 410 Gone');
  s.__setListQueue([stale, { items: [], nextSyncToken: 'recovered' }]);
  const r = s.CalendarRsvpAttendanceService.syncNow();
  assert.strictEqual(r.ok, true); assert.strictEqual(r.data.restartedFrom410, true); assert.strictEqual(s.__props.HAMZAWE_RSVP_SYNC_TOKEN, 'recovered');
  assert.strictEqual(s.__calls.list.length, 2); assert.strictEqual('syncToken' in s.__calls.list[1].params, false);
});

test('trigger installation is idempotent', () => {
  const s = makeHarness(); load(s, 'Infrastructure/CalendarRsvpTrigger.js');
  assert.strictEqual(s.CalendarRsvpTrigger.install('cal').data.installed, true);
  assert.strictEqual(s.CalendarRsvpTrigger.install('cal').data.existing, true);
  assert.strictEqual(s.__triggerCreateCount(), 1);
});

test('trigger refuses an RSVP handler bound to another calendar', () => {
  const s = makeHarness(); load(s, 'Infrastructure/CalendarRsvpTrigger.js');
  assert.strictEqual(s.CalendarRsvpTrigger.install('cal-1').ok, true);
  assert.strictEqual(s.CalendarRsvpTrigger.install('cal-2').error.code, 'RSVP_TRIGGER_WRONG_CALENDAR');
  assert.strictEqual(s.__triggerCreateCount(), 1);
});

test('appointment creation uses explicit configured calendar and secretary attendee', () => {
  const s = makeHarness(); configure(s); load(s, 'Infrastructure/GoogleCalendar.js'); load(s, 'Repositories/CalendarRsvpConfigRepository.js'); load(s, 'Repositories/CalendarRepository.js');
  const r = s.CalendarRepository.createAppointmentEvent({ title: 'A', startTime: new Date(), endTime: new Date() });
  assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.creates[0].id, 'clinic-calendar@example.com'); assert.deepStrictEqual(s.__calls.creates[0].guests, ['secretary@example.com']);
});

console.log(`\n${passed} Calendar RSVP hardening tests passed.`);
