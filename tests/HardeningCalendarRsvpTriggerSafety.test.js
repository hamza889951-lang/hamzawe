'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// Temporary non-functional branch touch for one-time governance execution.
function load(sourceSandbox) {
  const source = fs.readFileSync(path.join(ROOT, 'Infrastructure/CalendarRsvpTrigger.js'), 'utf8');
  vm.runInContext(source + '\nthis.CalendarRsvpTrigger = CalendarRsvpTrigger;', sourceSandbox, { filename: 'Infrastructure/CalendarRsvpTrigger.js' });
}

function makeSandbox(existingTriggers, deleteTriggerAvailable) {
  const deleted = [];
  const created = [];
  const sandbox = {
    Result: {
      ok(data) { return { ok: true, data: data }; },
      fail(code, message, data) { return { ok: false, error: { code: code, message: message, data: data } }; }
    },
    ScriptApp: {
      EventType: { ON_EVENT_UPDATED: 'ON_EVENT_UPDATED' },
      getProjectTriggers() { return existingTriggers.slice(); },
      newTrigger(handler) {
        const builder = {
          calendarId: null,
          forUserCalendar(id) { this.calendarId = id; return this; },
          onEventUpdated() { return this; },
          create() { created.push({ handler, calendarId: this.calendarId }); }
        };
        return builder;
      }
    }
  };
  if (deleteTriggerAvailable) {
    sandbox.ScriptApp.deleteTrigger = trigger => deleted.push(trigger);
  }
  vm.createContext(sandbox);
  return { sandbox, deleted, created };
}

function matchingTrigger(sourceId, sourceGetter) {
  return {
    getHandlerFunction() { return 'onCalendarRsvpEventUpdated'; },
    getEventType() { return 'ON_EVENT_UPDATED'; },
    getTriggerSourceId: sourceGetter || function() { return sourceId; }
  };
}

{
  const env = makeSandbox([matchingTrigger('calendar-1'), matchingTrigger('calendar-1')], true);
  load(env.sandbox);
  const result = env.sandbox.CalendarRsvpTrigger.install('calendar-1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.existing, true);
  assert.strictEqual(result.data.removedDuplicates, 1);
  assert.strictEqual(env.deleted.length, 1);
}

{
  const env = makeSandbox([matchingTrigger('calendar-1')], true);
  load(env.sandbox);
  const result = env.sandbox.CalendarRsvpTrigger.install('calendar-2');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.installed, true);
  assert.strictEqual(env.deleted.length, 1);
  assert.strictEqual(env.created[0].calendarId, 'calendar-2');
}

{
  const env = makeSandbox([matchingTrigger('', function() { return ''; })], true);
  load(env.sandbox);
  const result = env.sandbox.CalendarRsvpTrigger.install('calendar-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RSVP_TRIGGER_SOURCE_UNVERIFIABLE');
  assert.strictEqual(env.deleted.length, 0, 'uncertain trigger set is never mutated');
  assert.strictEqual(env.created.length, 0);
}

{
  const env = makeSandbox([{
    getHandlerFunction() { return 'onCalendarRsvpEventUpdated'; },
    getEventType() { return 'ON_EVENT_UPDATED'; }
  }], true);
  load(env.sandbox);
  const result = env.sandbox.CalendarRsvpTrigger.install('calendar-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RSVP_TRIGGER_SOURCE_UNVERIFIABLE');
  assert.strictEqual(env.deleted.length, 0);
}

{
  const env = makeSandbox([matchingTrigger('calendar-1')], false);
  load(env.sandbox);
  const result = env.sandbox.CalendarRsvpTrigger.install('calendar-2');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'RSVP_TRIGGER_DELETE_UNAVAILABLE');
  assert.strictEqual(env.deleted.length, 0);
  assert.strictEqual(env.created.length, 0);
}

console.log('Calendar RSVP trigger safety tests: 5/5 PASS');
