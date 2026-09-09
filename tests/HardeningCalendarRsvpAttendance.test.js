const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const GLOBALS = {
  'Clock.js': 'Clock',
  'CalendarRsvpConfigRepository.js': 'CalendarRsvpConfigRepository',
  'CalendarRsvpCheckpointRepository.js': 'CalendarRsvpCheckpointRepository',
  'CalendarRsvpSyncRepository.js': 'CalendarRsvpSyncRepository',
  'CalendarRsvpTrigger.js': 'CalendarRsvpTrigger',
  'CalendarRsvpAttendanceService.js': 'CalendarRsvpAttendanceService',
  'GoogleCalendar.js': 'GoogleCalendar',
  'CalendarRepository.js': 'CalendarRepository'
};
function makeResult() { return { ok(d) { return { ok: true, data: d }; }, fail(c, m, d) { return { ok: false, error: { code: c, message: m, data: d } }; } }; }
function makeHarness() {
  const props = {};
  const calls = { list: [], get: [], attendance: [], creates: [], availability: [], deletes: [], logs: [], checkpointWrites: [] };
  const triggers = [];
  const sheets = {};
  let listQueue = [], getQueue = [], created = 0;
  const ensureSheet = (name, headers) => { if (!sheets[name]) sheets[name] = { headers: headers.slice(), rows: [] }; return sheets[name]; };
  const sandbox = {
    Result: makeResult(),
    PropertiesService: { getScriptProperties() { return { getProperty: k => Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null, getProperties: () => Object.assign({}, props), deleteProperty: k => delete props[k], setProperties: v => Object.keys(v).forEach(k => props[k] = String(v[k])), setProperty: (k, v) => props[k] = String(v) }; } },
    GoogleSheets: {
      getOrCreateSheet: (name, headers) => ensureSheet(name, headers),
      queryRows: (name, predicate) => { const sheet = sheets[name]; if (!sheet) throw new Error('SHEET_NOT_FOUND:' + name); return sheet.rows.map((row, idx) => { const obj = { _rowNumber: idx + 2 }; sheet.headers.forEach((h, i) => obj[h] = row[i]); return obj; }).filter(predicate); },
      appendRows: (name, rows) => { const sheet = sheets[name]; if (!sheet) throw new Error('SHEET_NOT_FOUND:' + name); rows.forEach(r => sheet.rows.push(r.slice())); calls.checkpointWrites.push(rows.length); return sandbox.Result.ok({ inserted: rows.length }); },
      deleteRowsByNumbers: (name, rowNumbers) => { const sheet = sheets[name]; if (!sheet) throw new Error('SHEET_NOT_FOUND:' + name); rowNumbers.slice().sort((a, b) => b - a).forEach(n => sheet.rows.splice(n - 2, 1)); return sandbox.Result.ok({ deleted: rowNumbers.length }); }
    },
    Lock: { runExclusive: (k, fn) => fn() },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    console: { error: m => calls.logs.push(String(m)) },
    AttendanceService: {
      markCompleted: c => { calls.attendance.push({ decision: 'completed', context: c }); return sandbox.__attendanceResult || sandbox.Result.ok({ applied: true, alreadyApplied: false }); },
      markNoShow: c => { calls.attendance.push({ decision: 'no_show', context: c }); return sandbox.__attendanceResult || sandbox.Result.ok({ applied: true, alreadyApplied: false }); }
    },
    SlotRepository: { queryResult: predicate => { calls.availability.push(predicate); return sandbox.__availabilityResult || sandbox.Result.ok(sandbox.__availabilityRows || []); } },
    Calendar: { Events: {
      list: (calendarId, params) => { calls.list.push({ calendarId, params: Object.assign({}, params) }); if (!listQueue.length) return { items: [], nextSyncToken: 'default' }; const x = listQueue.shift(); if (x instanceof Error) throw x; return x; },
      get: (calendarId, eventId) => { calls.get.push({ calendarId, eventId }); if (!getQueue.length) return null; const x = getQueue.shift(); if (x instanceof Error) throw x; return x; }
    } },
    ScriptApp: {
      EventType: { ON_EVENT_UPDATED: 'ON_EVENT_UPDATED' },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: trigger => { const i = triggers.indexOf(trigger); if (i >= 0) { triggers.splice(i, 1); calls.deletes.push(trigger); } },
      newTrigger: h => ({ forUserCalendar(id) { this.calendarId = id; return this; }, onEventUpdated() { this.eventType = 'ON_EVENT_UPDATED'; return this; }, create() { created++; triggers.push({ getHandlerFunction: () => h, getEventType: () => 'ON_EVENT_UPDATED', getTriggerSourceId: () => this.calendarId }); } })
    },
    CalendarApp: { getCalendarById: id => ({ getId: () => id, createEvent: (title, start, end, options) => { const r = { id, title, start, end, options, guests: [] }; calls.creates.push(r); return { getId: () => 'event-' + calls.creates.length, addGuest: e => r.guests.push(e), setTag() {}, getTag() { return ''; } }; }, getEventById: () => null, getEvents: () => [] }), getDefaultCalendar: () => null },
    __attendanceResult: null, __availabilityResult: null, __availabilityRows: [], __props: props, __calls: calls, __sheets: sheets, __triggers: triggers,
    __setListQueue: q => { listQueue = q.slice(); }, __setGetQueue: q => { getQueue = q.slice(); }, __setAvailability: rows => { sandbox.__availabilityRows = rows; sandbox.__availabilityResult = null; }, __setAvailabilityResult: r => { sandbox.__availabilityResult = r; }, __triggerCreateCount: () => created
  };
  vm.createContext(sandbox); return sandbox;
}
function load(s, p) { const source = fs.readFileSync(path.join(ROOT, p), 'utf8'); const name = GLOBALS[path.basename(p)]; vm.runInContext(source + (name ? '\nthis.' + name + ' = ' + name + ';' : ''), s, { filename: p }); }
function loadRsvp(s) { load(s, 'Clock.js'); s.Clock.now = () => new Date('2026-09-09T18:00:00.000Z'); load(s, 'Repositories/CalendarRsvpConfigRepository.js'); load(s, 'Repositories/CalendarRsvpCheckpointRepository.js'); load(s, 'Repositories/CalendarRsvpSyncRepository.js'); load(s, 'Infrastructure/CalendarRsvpTrigger.js'); load(s, 'Application/CalendarRsvpAttendanceService.js'); }
function event(responseStatus, extra) { return Object.assign({ id: 'evt-1', iCalUID: 'uid-1', status: 'confirmed', attendees: [{ email: 'Secretary@Example.com ', responseStatus }] }, extra || {}); }
function availability(uid, slotId) { return { calendar_event_id: uid, slot_id: slotId || 'slot-1', status: 'CONFIRMED' }; }
function configure(s) { s.__props.HAMZAWE_CALENDAR_ID = 'clinic-calendar@example.com'; s.__props.ATTENDANCE_SECRETARY_EMAIL = 'Secretary@Example.com'; s.__props.ATTENDANCE_OPERATOR_EMAIL = 'secretary@example.com'; s.__props.HAMZAWE_RSVP_INITIALIZED = 'true'; s.__props.HAMZAWE_RSVP_ACTIVE = 'true'; s.__props.HAMZAWE_RSVP_BOUND_CALENDAR_ID = 'clinic-calendar@example.com'; s.__props.HAMZAWE_RSVP_BOUND_SECRETARY_EMAIL = 'secretary@example.com'; s.__props.HAMZAWE_RSVP_SYNC_TOKEN = 'sync-1'; s.__setAvailability([availability('uid-1')]); }
function checkpointMap(s) { const result = {}; const sheet = s.__sheets.CALENDAR_RSVP_CHECKPOINT; if (!sheet) return result; sheet.rows.forEach(row => { result[row[0]] = { eventStatus: row[1], responseStatus: row[2], outcome: row[3], reasonCode: row[4], decision: row[5], updatedAt: row[6] }; }); return result; }
let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS ' + name); } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; } }

test('config normalizes secretary email and exposes trusted operator policy', () => { const s = makeHarness(); load(s, 'Repositories/CalendarRsvpConfigRepository.js'); s.__props.HAMZAWE_CALENDAR_ID = 'cal-1'; s.__props.ATTENDANCE_SECRETARY_EMAIL = '  SEC@Example.COM '; s.__props.ATTENDANCE_OPERATOR_EMAIL = 'sec@example.com'; const r = s.CalendarRsvpConfigRepository.getRuntimeConfig(); assert.strictEqual(r.ok, true); assert.strictEqual(r.data.secretaryEmail, 'sec@example.com'); assert.strictEqual(r.data.trustedOperatorEmail, 'sec@example.com'); });

test('stable sync parameter shape excludes forbidden incremental filters', () => { const s = makeHarness(); load(s, 'Repositories/CalendarRsvpSyncRepository.js'); s.CalendarRsvpSyncRepository.listPage('cal', null, null); s.CalendarRsvpSyncRepository.listPage('cal', 'tok', 'page'); assert.strictEqual(s.__calls.list[0].params.showDeleted, true); assert.strictEqual(s.__calls.list[0].params.singleEvents, false); assert.strictEqual('syncToken' in s.__calls.list[0].params, false); assert.strictEqual(s.__calls.list[1].params.syncToken, 'tok'); assert.strictEqual(s.__calls.list[1].params.pageToken, 'page'); assert.strictEqual('timeMin' in s.__calls.list[1].params, false); });

test('pagination consumes all pages and final nextSyncToken', () => { const s = makeHarness(); loadRsvp(s); s.__setListQueue([{ items: [event('needsAction')], nextPageToken: 'p2' }, { items: [event('tentative', { id: 'evt-2', iCalUID: 'uid-2' })], nextSyncToken: 'final' }]); const r = s.CalendarRsvpAttendanceService._collectPages('cal', 'tok'); assert.strictEqual(r.ok, true); assert.strictEqual(r.data.items.length, 2); assert.strictEqual(r.data.nextSyncToken, 'final'); });

test('baseline is read-only and establishes binding without writing attendance', () => { const s = makeHarness(); loadRsvp(s); s.__props.HAMZAWE_CALENDAR_ID = 'clinic-calendar@example.com'; s.__props.ATTENDANCE_SECRETARY_EMAIL = 'Secretary@Example.com'; s.__props.HAMZAWE_RSVP_INITIALIZED = 'false'; s.__props.HAMZAWE_RSVP_ACTIVE = 'false'; s.__setAvailability([availability('uid-1')]); s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'base-2' }]); const r = s.CalendarRsvpAttendanceService.initializeBaseline(); assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance.length, 0); assert.strictEqual(s.__props.HAMZAWE_RSVP_SYNC_TOKEN, 'base-2'); assert.strictEqual(s.__props.HAMZAWE_RSVP_BOUND_CALENDAR_ID, 'clinic-calendar@example.com'); assert.strictEqual(checkpointMap(s)['uid-1'].outcome, 'OBSERVED_NO_DECISION'); });

test('repeated baseline for same binding is rejected', () => { const s = makeHarness(); configure(s); s.__props.HAMZAWE_RSVP_ACTIVE = 'false'; loadRsvp(s); const r = s.CalendarRsvpAttendanceService.initializeBaseline(); assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'RSVP_BASELINE_ALREADY_INITIALIZED'); });

test('active sync is hard-gated when inactive', () => { const s = makeHarness(); configure(s); s.__props.HAMZAWE_RSVP_ACTIVE = 'false'; loadRsvp(s); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'RSVP_NOT_ACTIVE'); assert.strictEqual(s.__calls.list.length, 0); });

test('active configuration drift is rejected before any Calendar sync read', () => { const s = makeHarness(); configure(s); s.__props.HAMZAWE_RSVP_BOUND_CALENDAR_ID = 'old-calendar@example.com'; loadRsvp(s); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'RSVP_ACTIVE_CONFIG_MISMATCH'); assert.strictEqual(s.__calls.list.length, 0); });

test('activation rejects secretary/trusted-operator mismatch', () => { const s = makeHarness(); configure(s); s.__props.ATTENDANCE_OPERATOR_EMAIL = 'doctor@example.com'; s.__props.HAMZAWE_RSVP_ACTIVE = 'false'; loadRsvp(s); const r = s.CalendarRsvpAttendanceService.activate(); assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'RSVP_OPERATOR_POLICY_MISMATCH'); assert.strictEqual(s.__triggerCreateCount(), 0); });

test('accepted maps to completed through existing authorization policy', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance[0].decision, 'completed'); assert.strictEqual(s.__calls.attendance[0].context.deployment.trustedOperatorEmail, 'secretary@example.com'); assert.strictEqual(s.__calls.attendance[0].context.executionPrincipal, 'owner@example.com'); assert.strictEqual(s.__calls.availability.length, 1); });

test('declined maps to no-show', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setListQueue([{ items: [event('declined')], nextSyncToken: 'sync-2' }]); assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true); assert.strictEqual(s.__calls.attendance[0].decision, 'no_show'); });

test('needsAction and tentative produce no decision', () => { ['needsAction', 'tentative'].forEach(st => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setListQueue([{ items: [event(st)], nextSyncToken: 'sync-2' }]); assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true); assert.strictEqual(s.__calls.attendance.length, 0); }); });

test('same RSVP response is idempotently skipped from the technical journal', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]); assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true); s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-3' }]); assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true); assert.strictEqual(s.__calls.attendance.length, 1); assert.strictEqual(Object.keys(checkpointMap(s)).length, 1); });

test('unknown Calendar event is never checkpointed or sent to AttendanceService', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setAvailability([]); s.__setListQueue([{ items: [event('accepted', { iCalUID: 'foreign-uid' })], nextSyncToken: 'sync-2' }]); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.attendance.length, 0); assert.strictEqual(Object.keys(checkpointMap(s)).length, 0); });

test('ambiguous Availability correlation is no-mutation diagnostic', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setAvailability([availability('uid-1', 'slot-a'), availability('uid-1', 'slot-b')]); s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, true); assert.strictEqual(r.data.ambiguousEvents, 1); assert.strictEqual(s.__calls.attendance.length, 0); });

test('Availability source failure blocks the batch before cursor/checkpoint advancement', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setAvailabilityResult(s.Result.fail('SLOT_READ_FAILED', 'storage down')); s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, false); assert.strictEqual(r.error.code, 'RSVP_AVAILABILITY_SOURCE_UNAVAILABLE'); assert.strictEqual(s.__props.HAMZAWE_RSVP_SYNC_TOKEN, 'sync-1'); assert.strictEqual(Object.keys(checkpointMap(s)).length, 0); });

test('attendeesOmitted refetches complete event', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setListQueue([{ items: [event('needsAction', { attendeesOmitted: true })], nextSyncToken: 'sync-2' }]); s.__setGetQueue([{ id: 'evt-1', iCalUID: 'uid-1', status: 'confirmed', attendees: [{ email: 'secretary@example.com', responseStatus: 'accepted' }] }]); assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true); assert.strictEqual(s.__calls.get.length, 1); assert.strictEqual(s.__calls.attendance.length, 1); });

test('incomplete attendee evidence does not checkpoint or mutate', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setListQueue([{ items: [event('accepted', { attendeesOmitted: true })], nextSyncToken: 'sync-2' }]); s.__setGetQueue([{ id: 'evt-1', iCalUID: 'uid-1', attendeesOmitted: true }]); assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true); assert.strictEqual(s.__calls.attendance.length, 0); assert.strictEqual(Object.keys(checkpointMap(s)).length, 0); });

test('cancelled known event is never no-show and records eventStatus separately', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setListQueue([{ items: [event('accepted', { status: 'cancelled' })], nextSyncToken: 'sync-2' }]); assert.strictEqual(s.CalendarRsvpAttendanceService.syncNow().ok, true); assert.strictEqual(s.__calls.attendance.length, 0); const cp = checkpointMap(s)['uid-1']; assert.strictEqual(cp.eventStatus, 'cancelled'); assert.strictEqual(cp.responseStatus, ''); });

test('retryable Attendance failure preserves replayability', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__attendanceResult = s.Result.fail('LOCK_TIMEOUT', 'busy'); s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, false); assert.strictEqual(s.__props.HAMZAWE_RSVP_SYNC_TOKEN, 'sync-1'); assert.strictEqual(Object.keys(checkpointMap(s)).length, 0); });

test('semantic invalid transition is checkpointed as diagnosable rejection', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__attendanceResult = s.Result.fail('INVALID_TRANSITION', 'terminal'); s.__setListQueue([{ items: [event('accepted')], nextSyncToken: 'sync-2' }]); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, true); const cp = checkpointMap(s)['uid-1']; assert.strictEqual(cp.outcome, 'SEMANTIC_REJECTION'); assert.strictEqual(cp.reasonCode, 'INVALID_TRANSITION'); assert.strictEqual(s.__props.HAMZAWE_RSVP_SYNC_TOKEN, 'sync-2'); });

test('410 token invalidity triggers one full resync', () => { const s = makeHarness(); configure(s); loadRsvp(s); s.__setListQueue([new Error('HTTP 410 Gone'), { items: [], nextSyncToken: 'recovered' }]); const r = s.CalendarRsvpAttendanceService.syncNow(); assert.strictEqual(r.ok, true); assert.strictEqual(r.data.restartedFrom410, true); assert.strictEqual(s.__props.HAMZAWE_RSVP_SYNC_TOKEN, 'recovered'); assert.strictEqual('syncToken' in s.__calls.list[1].params, false); });

test('trigger install converges to exactly one owned trigger and removes duplicates', () => { const s = makeHarness(); load(s, 'Infrastructure/CalendarRsvpTrigger.js'); s.__triggers.push({ getHandlerFunction: () => 'onCalendarRsvpEventUpdated', getEventType: () => 'ON_EVENT_UPDATED', getTriggerSourceId: () => 'cal-1' }); s.__triggers.push({ getHandlerFunction: () => 'onCalendarRsvpEventUpdated', getEventType: () => 'ON_EVENT_UPDATED', getTriggerSourceId: () => 'cal-1' }); s.__triggers.push({ getHandlerFunction: () => 'otherHandler', getEventType: () => 'ON_EVENT_UPDATED', getTriggerSourceId: () => 'cal-1' }); const r = s.CalendarRsvpTrigger.install('cal-1'); assert.strictEqual(r.ok, true); assert.strictEqual(r.data.removedDuplicates, 1); assert.strictEqual(s.__triggerCreateCount(), 0); assert.strictEqual(s.__triggers.length, 2); });

test('trigger install replaces stale owned trigger from another calendar', () => { const s = makeHarness(); load(s, 'Infrastructure/CalendarRsvpTrigger.js'); s.__triggers.push({ getHandlerFunction: () => 'onCalendarRsvpEventUpdated', getEventType: () => 'ON_EVENT_UPDATED', getTriggerSourceId: () => 'old-cal' }); const r = s.CalendarRsvpTrigger.install('new-cal'); assert.strictEqual(r.ok, true); assert.strictEqual(r.data.installed, true); assert.strictEqual(r.data.removedDuplicates, 1); assert.strictEqual(s.__triggerCreateCount(), 1); assert.strictEqual(s.__triggers[0].getTriggerSourceId(), 'new-cal'); });

test('deactivation disables processing without erasing technical history', () => { const s = makeHarness(); configure(s); loadRsvp(s); const r = s.CalendarRsvpAttendanceService.deactivate(); assert.strictEqual(r.ok, true); assert.strictEqual(s.__props.HAMZAWE_RSVP_ACTIVE, 'false'); });

test('appointment creation uses configured calendar and secretary only while active', () => { const s = makeHarness(); configure(s); load(s, 'Infrastructure/GoogleCalendar.js'); load(s, 'Repositories/CalendarRsvpConfigRepository.js'); load(s, 'Repositories/CalendarRepository.js'); const r = s.CalendarRepository.createAppointmentEvent({ title: 'A', startTime: new Date(), endTime: new Date() }); assert.strictEqual(r.ok, true); assert.strictEqual(s.__calls.creates[0].id, 'clinic-calendar@example.com'); assert.deepStrictEqual(s.__calls.creates[0].guests, ['secretary@example.com']); });

test('active handler failure emits diagnostic and throws for visible trigger failure', () => { const s = makeHarness(); configure(s); s.__props.HAMZAWE_RSVP_ACTIVE = 'false'; loadRsvp(s); assert.throws(() => s.CalendarRsvpAttendanceService.handleEventUpdated(), /RSVP_NOT_ACTIVE/); assert.strictEqual(s.__calls.logs.length, 1); assert.ok(s.__calls.logs[0].indexOf('RSVP_SYNC_FAILURE') >= 0); });

console.log('\n' + passed + ' Calendar RSVP hardening tests passed.');
