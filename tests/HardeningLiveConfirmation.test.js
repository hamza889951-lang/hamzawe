'use strict';

/**
 * Live correction regression: confirmation message / bus number / clinic
 * work-start presentation. This suite exercises real BusNumberCalculator and
 * BookingService behavior with a controlled Apps Script-like host.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log('PASS: ' + name);
    passCount += 1;
  } catch (e) {
    console.error('FAIL: ' + name);
    console.error('    ' + (e && e.stack ? e.stack : e));
    failCount += 1;
  }
}

function loadInto(sandbox, rel, name) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
}

function formatInTimeZone(date, timeZone, fmt) {
  if (!(date instanceof Date)) return String(date);
  if (fmt === 'HH:mm') {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    }).formatToParts(date).reduce(function(acc, part) {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return parts.hour + ':' + parts.minute;
  }
  if (fmt === 'yyyy-MM-dd') {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).reduce(function(acc, part) {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return parts.year + '-' + parts.month + '-' + parts.day;
  }
  return date.toISOString();
}

function createBaseSandbox(settingsOverride) {
  const sandbox = vm.createContext({ console: console, Intl: Intl });
  const settings = Object.assign({ work_start: '16:00', 'Slot Duration (min)': '15' }, settingsOverride || {});

  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sandbox.Utilities = { formatDate: formatInTimeZone };
  sandbox.GoogleSheets = {
    getAllRows: function(name) {
      if (name === sandbox.Config.VOCABULARY.SHEETS.SETTINGS) return [Object.assign({}, settings)];
      throw new Error('Unexpected getAllRows: ' + name);
    }
  };

  loadInto(sandbox, 'Result.js', 'Result');
  loadInto(sandbox, 'Config.js', 'Config');
  loadInto(sandbox, 'SettingsRepository.js', 'SettingsRepository');
  loadInto(sandbox, 'BusNumberCalculator.js', 'BusNumberCalculator');

  return sandbox;
}

function createBookingSandbox(settingsOverride) {
  const sandbox = vm.createContext({ console: console, Intl: Intl });
  const state = {
    sheets: Object.create(null),
    calendarEvents: [],
    lockHeld: false,
    nowIso: '2026-09-05T10:00:00.000Z'
  };
  const settings = Object.assign({ work_start: '16:00', 'Slot Duration (min)': '15' }, settingsOverride || {});

  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sandbox.Utilities = { formatDate: formatInTimeZone };
  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return { getProperty: function() { return null; }, setProperty: function() {} };
    }
  };
  sandbox.LockService = {
    getScriptLock: function() {
      return {
        waitLock: function() {
          if (state.lockHeld) throw new Error('LOCK_ALREADY_HELD');
          state.lockHeld = true;
        },
        releaseLock: function() { state.lockHeld = false; }
      };
    }
  };

  function sheet(name) {
    if (!state.sheets[name]) state.sheets[name] = { headers: [], rows: [] };
    return state.sheets[name];
  }

  sandbox.GoogleSheets = {
    getAllRows: function(name) {
      if (name === sandbox.Config.VOCABULARY.SHEETS.SETTINGS) return [Object.assign({}, settings)];
      return sheet(name).rows.map(function(row) { return Object.assign({}, row); });
    },
    queryRows: function(name, predicate) {
      return sandbox.GoogleSheets.getAllRows(name).filter(predicate);
    },
    getHeaders: function(name) {
      return sheet(name).headers.slice();
    },
    findRowByColumn: function(name, columnName, value) {
      const row = sheet(name).rows.find(function(candidate) {
        return String(candidate[columnName]) === String(value);
      });
      return row ? Object.assign({}, row) : null;
    },
    appendRow: function(name, rowObject) {
      const target = sheet(name);
      if (!target.headers.length) target.headers = Object.keys(rowObject);
      const row = {};
      target.headers.forEach(function(header) {
        row[header] = Object.prototype.hasOwnProperty.call(rowObject, header) ? rowObject[header] : '';
      });
      target.rows.push(row);
      return true;
    },
    updateRowByColumn: function(name, columnName, value, fields) {
      const row = sheet(name).rows.find(function(candidate) {
        return String(candidate[columnName]) === String(value);
      });
      if (!row) return false;
      Object.keys(fields).forEach(function(key) { row[key] = fields[key]; });
      return true;
    }
  };
  sandbox.GoogleCalendar = {
    createEvent: function(params) {
      state.calendarEvents.push(params);
      return 'EVT_' + state.calendarEvents.length;
    }
  };

  [
    ['Result.js', 'Result'],
    ['Config.js', 'Config'],
    ['Clock.js', 'Clock'],
    ['Utils/ULID.js', 'ULID'],
    ['Utils/IdGenerator.js', 'IdGenerator'],
    ['Utils/DateUtils.js', 'DateUtils'],
    ['Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser'],
    ['Utils/PhoneUtils.js', 'PhoneUtils'],
    ['SettingsRepository.js', 'SettingsRepository'],
    ['StateMachine.js', 'StateMachine'],
    ['Domain/Validators.js', 'Validators'],
    ['Infrastructure/Lock.js', 'Lock'],
    ['Repositories/SlotRepository.js', 'SlotRepository'],
    ['Repositories/CalendarRepository.js', 'CalendarRepository'],
    ['ConversationRepository.js', 'ConversationRepository'],
    ['LogRepository.js', 'LogRepository'],
    ['Application/CommandExecutor.js', 'CommandExecutor'],
    ['BusNumberCalculator.js', 'BusNumberCalculator'],
    ['Application/BookingService.js', 'BookingService']
  ].forEach(function(pair) { loadInto(sandbox, pair[0], pair[1]); });

  sandbox.Clock.now = function() { return new Date(state.nowIso); };
  sandbox.LogRepository.write = function() { return true; };

  state.sheets.Availability = {
    headers: [
      'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
      'patient_name', 'phone', 'calendar_event_id', 'reserved_until', 'reserved_until_unix'
    ],
    rows: []
  };
  state.sheets.Conversations = {
    headers: ['conversation_id', 'phone', 'state', 'temp_name', 'slot_id', 'updated_at'],
    rows: []
  };

  return { sandbox: sandbox, state: state };
}

function seedReservedBooking(env, slotTimeDate) {
  env.state.sheets.Availability.rows.push({
    slot_id: 'SLT_LIVE_1600',
    date: new Date('2026-09-05T21:00:00.000Z'), // 2026-09-06 Asia/Baghdad
    time: slotTimeDate,
    sort_key: '202609061600',
    status: 'RESERVED',
    is_available: true,
    patient_name: 'مريض تجربة',
    phone: '9647800003333',
    calendar_event_id: '',
    reserved_until: '',
    reserved_until_unix: String(Date.now() + 600000)
  });
  env.state.sheets.Conversations.rows.push({
    conversation_id: 'CONV_LIVE',
    phone: '9647800003333',
    state: 'WAITING_CONFIRMATION',
    temp_name: 'مريض تجربة',
    slot_id: 'SLT_LIVE_1600',
    updated_at: ''
  });
}

test('LIVE-01 — bus number is 1 for a 16:00 slot when work_start=16:00 and duration=15', function() {
  const sandbox = createBaseSandbox();
  const result = sandbox.BusNumberCalculator.fromTime(new Date('2026-09-06T13:00:00.000Z'));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.busNumber, 1);
});

test('LIVE-02 — bus number is 2 for a 16:15 slot', function() {
  const sandbox = createBaseSandbox();
  const result = sandbox.BusNumberCalculator.fromTime(new Date('2026-09-06T13:15:00.000Z'));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.busNumber, 2);
});

test('LIVE-03 — bus number is 24 for a 21:45 slot', function() {
  const sandbox = createBaseSandbox();
  const result = sandbox.BusNumberCalculator.fromTime(new Date('2026-09-06T18:45:00.000Z'));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.busNumber, 24);
});

test('LIVE-04 — timezone-sensitive Date is interpreted in Asia/Baghdad, not host-local time', function() {
  const sandbox = createBaseSandbox();
  const slotAtClinic1600 = new Date('2026-09-06T13:00:00.000Z');
  assert.notStrictEqual(slotAtClinic1600.getUTCHours(), 16, 'control: UTC hour differs from clinic hour');
  const result = sandbox.BusNumberCalculator.fromTime(slotAtClinic1600);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.busNumber, 1);
});

test('LIVE-05 — final booking confirmation contains date, bus number, and clinic work-start', function() {
  const env = createBookingSandbox();
  seedReservedBooking(env, new Date('2026-09-06T13:00:00.000Z'));

  const result = env.sandbox.BookingService.handleIncomingMessage('9647800003333', '1');
  const reply = result.data.reply;

  assert.strictEqual(result.ok, true);
  assert.ok(reply.indexOf('تم تأكيد حجزك بنجاح') !== -1);
  assert.ok(reply.indexOf('بتاريخ 2026-09-06') !== -1);
  assert.ok(reply.indexOf('رقم الباص: 1') !== -1);
  assert.ok(reply.indexOf('يبدأ دوام العيادة الساعة 04:00 مساءً') !== -1);
});

test('LIVE-06 — final confirmation does not expose slot time or runtime-derived accidental time', function() {
  const env = createBookingSandbox();
  seedReservedBooking(env, new Date('2026-09-06T13:00:00.000Z'));

  const result = env.sandbox.BookingService.handleIncomingMessage('9647800003333', '1');
  const reply = result.data.reply;

  assert.strictEqual(result.ok, true);
  assert.strictEqual(reply.indexOf('الساعة 16:00'), -1);
  assert.strictEqual(reply.indexOf('16:00'), -1);
  assert.strictEqual(reply.indexOf('02:57'), -1);
});

test('LIVE-07 — bus calculation failure does not fall back to displaying slot.time', function() {
  const env = createBookingSandbox({ work_start: 'not-a-time' });
  seedReservedBooking(env, new Date('2026-09-06T13:00:00.000Z'));

  const result = env.sandbox.BookingService.handleIncomingMessage('9647800003333', '1');
  const reply = result.data.reply;

  assert.strictEqual(result.ok, true);
  assert.strictEqual(env.state.sheets.Availability.rows[0].status, 'RESERVED', 'confirmation transition is not applied when presentation cannot be reliable');
  assert.ok(reply.indexOf('تعذّر تأكيد الحجز حاليًا') !== -1);
  assert.strictEqual(reply.indexOf('الساعة 16:00'), -1);
  assert.strictEqual(reply.indexOf('16:00'), -1);
  assert.strictEqual(reply.indexOf('02:57'), -1);
});

test('LIVE-08 — successful booking side effects remain intact', function() {
  const env = createBookingSandbox();
  seedReservedBooking(env, new Date('2026-09-06T13:00:00.000Z'));

  const result = env.sandbox.BookingService.handleIncomingMessage('9647800003333', '1');
  const slot = env.state.sheets.Availability.rows[0];
  const conversation = env.state.sheets.Conversations.rows[0];

  assert.strictEqual(result.ok, true);
  assert.strictEqual(slot.status, 'CONFIRMED');
  assert.strictEqual(slot.calendar_event_id, 'EVT_1');
  assert.strictEqual(conversation.state, 'BOOKED');
  assert.strictEqual(env.state.calendarEvents.length, 1);
  assert.strictEqual(env.state.calendarEvents[0].title, '#1 | مريض تجربة');
});

process.on('exit', function() {
  console.log('\nLive confirmation correction tests: ' + passCount + '/' + (passCount + failCount) + ' PASS');
  if (failCount > 0) process.exitCode = 1;
});
