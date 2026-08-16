'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';
const OTHER_PHONE = '9647002222222';
const NOW_MS = 1770000000000;
const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, {
    filename: relativePath
  });
}

load('Result.js', 'Result');
load('Config.js', 'Config');
load('StateMachine.js', 'StateMachine');
load('Domain/Validators.js', 'Validators');

let nowMs = NOW_MS;
let ulidCounter = 0;
sandbox.Clock = { now: function() { return new Date(nowMs); } };
sandbox.ULID = { generate: function() { ulidCounter += 1; return 'ULID_' + ulidCounter; } };

let properties = {};
let propertyDeleteFailure = false;
let lockHeld = false;
sandbox.PropertiesService = {
  getScriptProperties: function() {
    return {
      getProperty: function(key) {
        return Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null;
      },
      setProperty: function(key, value) {
        properties[key] = value;
      },
      deleteProperty: function(key) {
        if (propertyDeleteFailure) throw new Error('PROPERTY_DELETE_FAILED');
        delete properties[key];
      }
    };
  }
};
sandbox.Lock = {
  runExclusive: function(key, fn) {
    if (lockHeld) return sandbox.Result.fail('LOCK_TIMEOUT', 'locked: ' + key);
    lockHeld = true;
    try { return fn(); } catch (e) { return sandbox.Result.fail('UNEXPECTED_ERROR', e.message, e.stack); }
    finally { lockHeld = false; }
  }
};

let b6Sheets = {};
let lifecycleAppendFailure = false;
let failReleasedCheckpoint = false;
let auditAppendFailure = false;
function resetSheets() { b6Sheets = {}; lifecycleAppendFailure = false; failReleasedCheckpoint = false; auditAppendFailure = false; }
function clone(value) { return Object.assign({}, value); }
sandbox.GoogleSheets = {
  getOrCreateSheet: function(name, headers) {
    if (!b6Sheets[name]) b6Sheets[name] = { headers: headers.slice(), rows: [] };
    return {};
  },
  getHeaders: function(name) {
    if (!b6Sheets[name]) throw new Error('MISSING_SHEET:' + name);
    return b6Sheets[name].headers.slice();
  },
  appendRows: function(name, rows) {
    if ((name === 'B6_LIFECYCLE' && lifecycleAppendFailure) ||
        (name === 'B6_RECOVERY_AUDIT' && auditAppendFailure)) {
      return sandbox.Result.fail('APPEND_FAILED', 'injected append failure');
    }
    if (!b6Sheets[name]) throw new Error('MISSING_SHEET:' + name);
    if (name === 'B6_LIFECYCLE' && failReleasedCheckpoint) {
      const stateIndex = b6Sheets[name].headers.indexOf('lifecycle_state');
      if (rows.some(function(row) { return row[stateIndex] === 'RELEASED'; })) {
        return sandbox.Result.fail('APPEND_FAILED', 'injected RELEASED checkpoint failure');
      }
    }
    rows.forEach(function(row) { b6Sheets[name].rows.push(row.slice()); });
    return sandbox.Result.ok({ inserted: rows.length });
  },
  queryRows: function(name, predicateFn) {
    if (!b6Sheets[name]) throw new Error('MISSING_SHEET:' + name);
    const sheet = b6Sheets[name];
    return sheet.rows.map(function(row, index) {
      const obj = { _rowNumber: index + 2 };
      sheet.headers.forEach(function(header, i) { obj[header] = row[i]; });
      return obj;
    }).filter(predicateFn);
  }
};

let slots = [];
let failEventIdPersistence = false;
let failOldSlotFree = false;
let recoveryInterleave = null;
function slot(id, status, phone) {
  return {
    slot_id: id,
    status: status,
    phone: phone || '',
    patient_name: phone ? 'Patient ' + phone : '',
    calendar_event_id: status === 'CONFIRMED' ? 'OLD_EVENT' : '',
    reserved_until: '',
    reserved_until_unix: '',
    is_available: true,
    sort_key: NOW_MS + (id === 'OLD' ? 7200000 : (id === 'A' ? 10800000 : 14400000)),
    date: '2026/08/20',
    time: '16:00'
  };
}
sandbox.SlotRepository = {
  findById: function(slotId) {
    const found = slots.find(function(item) { return item.slot_id === slotId; });
    return found ? clone(found) : null;
  },
  findByPhoneAndStatus: function(phone, status) {
    const found = slots.find(function(item) { return item.phone === phone && item.status === status; });
    return found ? clone(found) : null;
  },
  queryResult: function(predicateFn) {
    return sandbox.Result.ok(slots.filter(predicateFn).map(clone));
  },
  atomicUpdate: function(slotId, decisionFn) {
    const persisted = slots.find(function(item) { return item.slot_id === slotId; });
    if (!persisted) return sandbox.Result.fail('SLOT_NOT_FOUND', 'missing');
    const decision = decisionFn(clone(persisted));
    if (!decision.ok) return decision;
    if (recoveryInterleave && slotId === 'OLD' && decision.data.status === sandbox.Config.VOCABULARY.STATUS.FREE) {
      const fn = recoveryInterleave;
      recoveryInterleave = null;
      fn();
    }
    if (failEventIdPersistence && slotId !== 'OLD' && decision.data.calendar_event_id) {
      return sandbox.Result.fail('UPDATE_FAILED', 'event id persistence injected failure');
    }
    if (failOldSlotFree && slotId === 'OLD' && decision.data.status === sandbox.Config.VOCABULARY.STATUS.FREE) {
      return sandbox.Result.fail('UPDATE_FAILED', 'old slot free injected failure');
    }
    Object.assign(persisted, decision.data);
    return sandbox.Result.ok(Object.assign({ slotId: slotId }, decision.data));
  }
};
sandbox.SlotSelection = {
  findEarliestBookable: function(excludedIds) {
    const excluded = excludedIds || [];
    const found = slots.find(function(item) {
      return item.status === sandbox.Config.VOCABULARY.STATUS.FREE &&
        item.is_available === true && excluded.indexOf(item.slot_id) === -1;
    });
    return found ? sandbox.Result.ok(clone(found)) : sandbox.Result.fail('NO_SLOT_AVAILABLE', 'none');
  }
};

sandbox.PhoneUtils = { normalize: function(value) { return String(value).replace(/\D/g, ''); } };
sandbox.DateUtils = {
  addMinutes: function(date, minutes) { return new Date(date.getTime() + minutes * 60000); },
  fromTimestamp: function(value) { return new Date(value); },
  formatDateDisplay: function(value) { return String(value); },
  formatTimeDisplay: function(value) { return String(value); }
};
sandbox.LegacySlotTimeParser = { toComparableTime: function(value) { return typeof value === 'number' ? value : null; } };
sandbox.SettingsRepository = { getSlotDurationMinutes: function() { return 30; } };
sandbox.BusNumberCalculator = { fromSlot: function() { return sandbox.Result.ok({ busNumber: 1 }); } };
sandbox.CommandExecutor = { execute: function(command, context, fn) { try { return fn(); } catch (e) { return sandbox.Result.fail('UNEXPECTED_ERROR', e.message, e.stack); } } };

let events = {};
let createFailure = false;
let deleteFailure = false;
let manyMatches = false;
let calendarInterleave = null;
let createdEventCount = 0;
sandbox.CalendarRepository = {
  createLifecycleAppointmentEvent: function(params) {
    if (calendarInterleave) { const fn = calendarInterleave; calendarInterleave = null; fn(); }
    if (createFailure) return sandbox.Result.fail('CALENDAR_CREATE_OUTCOME_UNKNOWN', 'injected create failure');
    const id = 'NEW_EVENT_' + (++createdEventCount);
    events[id] = { eventId: id, operationId: params.operationId, calendarId: 'CAL_DEFAULT' };
    return sandbox.Result.ok({ eventId: id, calendarId: 'CAL_DEFAULT', operationId: params.operationId });
  },
  inspectLifecycleAppointmentEvent: function(eventId, calendarId, expectedOperationId) {
    const event = events[eventId];
    if (!event) return sandbox.Result.ok({ status: 'NOT_FOUND', eventId: eventId, calendarId: calendarId || 'CAL_DEFAULT', contextResolved: true });
    if (expectedOperationId && event.operationId !== expectedOperationId) {
      return sandbox.Result.ok({ status: 'CORRELATION_MISMATCH', eventId: eventId, calendarId: event.calendarId });
    }
    return sandbox.Result.ok({ status: 'MATCH', eventId: eventId, calendarId: event.calendarId, operationId: event.operationId || '', contextResolved: true });
  },
  findLifecycleEventsByOperationId: function(operationId, start, end, calendarId) {
    let matches = Object.keys(events).filter(function(id) { return events[id].operationId === operationId; }).map(function(id) { return clone(events[id]); });
    if (manyMatches && matches.length === 1) matches.push({ eventId: 'DUPLICATE_' + operationId, operationId: operationId, calendarId: 'CAL_DEFAULT' });
    return sandbox.Result.ok({ calendarId: calendarId || 'CAL_DEFAULT', operationId: operationId, matches: matches });
  },
  deleteLifecycleAppointmentEvent: function(eventId, calendarId) {
    if (deleteFailure) return sandbox.Result.fail('CALENDAR_ABSENCE_NOT_PROVEN', 'injected delete failure');
    if (!events[eventId]) return sandbox.Result.fail('CALENDAR_ABSENCE_NOT_PROVEN', 'not found');
    delete events[eventId];
    return sandbox.Result.ok({ status: 'ABSENCE_OBSERVED', eventId: eventId, calendarId: calendarId || 'CAL_DEFAULT', deleteConfirmed: true, absenceObserved: true });
  }
};

let alerts = [];
let logs = [];
sandbox.B6RecoveryAlertRepository = { notifyRecoveryRequired: function(payload) { alerts.push(clone(payload)); return sandbox.Result.ok({}); } };
sandbox.LogRepository = { write: function(entry) { logs.push(entry); } };
sandbox.ConversationRepository = {
  findByPhone: function() { return { state: sandbox.Config.VOCABULARY.CONVERSATION_STATE.BOOKED }; },
  resetToMenuMain: function() {}
};

load('Repositories/B6LifecycleRepository.js', 'B6LifecycleRepository');
load('Repositories/B6RecoveryAuditRepository.js', 'B6RecoveryAuditRepository');
load('AppointmentRepository.js', 'AppointmentRepository');
load('Application/B6LifecycleService.js', 'B6LifecycleService');
load('Changeservice.js', 'ChangeService');
load('Application/CancelService.js', 'CancelService');
load('Core/Router.js', 'Router');

function reset() {
  nowMs = NOW_MS;
  ulidCounter = 0;
  properties = {};
  propertyDeleteFailure = false;
  lockHeld = false;
  resetSheets();
  failEventIdPersistence = false;
  failOldSlotFree = false;
  recoveryInterleave = null;
  createFailure = false;
  deleteFailure = false;
  manyMatches = false;
  calendarInterleave = null;
  createdEventCount = 0;
  events = { OLD_EVENT: { eventId: 'OLD_EVENT', operationId: '', calendarId: 'CAL_DEFAULT' } };
  alerts = [];
  logs = [];
  slots = [
    slot('OLD', sandbox.Config.VOCABULARY.STATUS.CONFIRMED, PHONE),
    slot('A', sandbox.Config.VOCABULARY.STATUS.FREE, ''),
    slot('B', sandbox.Config.VOCABULARY.STATUS.FREE, ''),
    slot('OTHER', sandbox.Config.VOCABULARY.STATUS.CONFIRMED, OTHER_PHONE)
  ];
}
function claim(phone) { return properties['b6_lifecycle_claim:' + phone]; }
function latest(phone) { return sandbox.B6LifecycleRepository.latestByPhone(phone).data; }
function recoveryRows() { return (b6Sheets.B6_RECOVERY_AUDIT || { rows: [] }).rows; }
function publicChange() { return sandbox.Router.dispatch({ phone: PHONE, message: '2' }); }
function publicCancel() { return sandbox.Router.dispatch({ phone: PHONE, message: '3' }); }
function confirmed(phone) { return slots.filter(function(item) { return item.phone === phone && item.status === 'CONFIRMED'; }); }
function free(slotId) { return slots.find(function(item) { return item.slot_id === slotId; }); }

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('B6-1 — normal CHANGE owns full lifecycle, proves terminal state, then releases', function() {
  reset();
  const result = publicChange();
  assert.strictEqual(result.ok, true);
  assert.ok(result.data.reply.indexOf('تم تغيير موعدك بنجاح') !== -1);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(confirmed(PHONE).length, 1);
  assert.strictEqual(confirmed(PHONE)[0].slot_id, 'A');
  assert.strictEqual(free('OLD').status, 'FREE');
  assert.strictEqual(events.OLD_EVENT, undefined);
  assert.strictEqual(Object.keys(events).length, 1);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASED');
});

test('B6-2 — normal CANCEL owns full lifecycle, proves terminal state, then releases', function() {
  reset();
  const result = publicCancel();
  assert.strictEqual(result.ok, true);
  assert.ok(result.data.reply.indexOf('تم إلغاء حجزك بنجاح') !== -1);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(confirmed(PHONE).length, 0);
  assert.strictEqual(free('OLD').status, 'FREE');
  assert.strictEqual(events.OLD_EVENT, undefined);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASED');
});

test('B6-3 — CHANGE vs CHANGE: second public command is blocked before side effects', function() {
  reset();
  let second;
  calendarInterleave = function() { second = publicChange(); };
  const first = publicChange();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.ok(second.data.reply.indexOf('تعذّر تغيير') !== -1);
  assert.strictEqual(createdEventCount, 1);
  assert.strictEqual(confirmed(PHONE).length, 1);
});

test('B6-4 — CHANGE vs CANCEL: Cancel is blocked while Change owns lifecycle', function() {
  reset();
  let second;
  calendarInterleave = function() { second = publicCancel(); };
  const first = publicChange();
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.ok(second.data.reply.indexOf('تعذّر إلغاء') !== -1);
  assert.strictEqual(confirmed(PHONE).length, 1);
  assert.strictEqual(confirmed(PHONE)[0].slot_id, 'A');
});

test('B6-5 — CANCEL vs CHANGE: Change is blocked while Cancel owns lifecycle', function() {
  reset();
  const originalDelete = sandbox.CalendarRepository.deleteLifecycleAppointmentEvent;
  let second;
  sandbox.CalendarRepository.deleteLifecycleAppointmentEvent = function() {
    second = publicChange();
    return originalDelete.apply(this, arguments);
  };
  const first = publicCancel();
  sandbox.CalendarRepository.deleteLifecycleAppointmentEvent = originalDelete;
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.ok(second.data.reply.indexOf('تعذّر تغيير') !== -1);
  assert.strictEqual(confirmed(PHONE).length, 0);
});

test('B6-6 — CANCEL vs CANCEL: second public command is blocked before side effects', function() {
  reset();
  const originalDelete = sandbox.CalendarRepository.deleteLifecycleAppointmentEvent;
  let second;
  sandbox.CalendarRepository.deleteLifecycleAppointmentEvent = function() {
    second = publicCancel();
    return originalDelete.apply(this, arguments);
  };
  const first = publicCancel();
  sandbox.CalendarRepository.deleteLifecycleAppointmentEvent = originalDelete;
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.ok(second.data.reply.indexOf('تعذّر إلغاء') !== -1);
  assert.strictEqual(confirmed(PHONE).length, 0);
});

test('B6-7 — explicit Calendar create failure retains ownership and creates recovery evidence', function() {
  reset();
  createFailure = true;
  const result = publicChange();
  assert.strictEqual(result.ok, true);
  assert.ok(claim(PHONE));
  assert.strictEqual(JSON.parse(claim(PHONE)).ownershipState, 'HELD_UNRESOLVED');
  assert.strictEqual(latest(PHONE).lifecycle_state, 'UNRESOLVED');
  assert.strictEqual(recoveryRows().length, 1);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(confirmed(PHONE).length, 2);
});

test('B6-8 — event ID persistence failure retains ownership and does not create a second event on retry', function() {
  reset();
  failEventIdPersistence = true;
  publicChange();
  assert.ok(claim(PHONE));
  assert.strictEqual(createdEventCount, 1);
  const retry = publicChange();
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(createdEventCount, 1);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'UNRESOLVED');
});

test('B6-9 — old Calendar deletion failure retains ownership', function() {
  reset();
  deleteFailure = true;
  publicChange();
  assert.ok(claim(PHONE));
  assert.strictEqual(JSON.parse(claim(PHONE)).ownershipState, 'HELD_UNRESOLVED');
  assert.strictEqual(latest(PHONE).lifecycle_state, 'UNRESOLVED');
  assert.ok(events.OLD_EVENT);
});

test('B6-10 — old Slot free failure retains ownership', function() {
  reset();
  failOldSlotFree = true;
  publicChange();
  assert.ok(claim(PHONE));
  assert.strictEqual(latest(PHONE).lifecycle_state, 'UNRESOLVED');
  assert.strictEqual(free('OLD').status, 'CONFIRMED');
});

test('B6-11 — checkpoint persistence ambiguity retains ownership', function() {
  reset();
  lifecycleAppendFailure = true;
  publicChange();
  assert.ok(claim(PHONE));
  assert.strictEqual(JSON.parse(claim(PHONE)).ownershipState, 'HELD_UNRESOLVED');
  assert.strictEqual(alerts.length, 1);
});

test('B6-12 — more than one confirmed appointment is recovery-required and blocks lifecycle effects', function() {
  reset();
  slots.find(function(item) { return item.slot_id === 'A'; }).status = 'CONFIRMED';
  slots.find(function(item) { return item.slot_id === 'A'; }).phone = PHONE;
  const result = publicChange();
  assert.strictEqual(result.ok, true);
  assert.ok(claim(PHONE));
  assert.strictEqual(JSON.parse(claim(PHONE)).ownershipState, 'HELD_UNRESOLVED');
  assert.strictEqual(createdEventCount, 0);
  assert.strictEqual(latest(PHONE).recovery_state, 'RECOVERY_REQUIRED');
});

test('B6-13 — zero confirmed appointments is REJECTED_NO_EFFECT with no claim, audit, or alert', function() {
  reset();
  slots.find(function(item) { return item.slot_id === 'OLD'; }).status = 'FREE';
  slots.find(function(item) { return item.slot_id === 'OLD'; }).phone = '';
  slots.find(function(item) { return item.slot_id === 'OLD'; }).calendar_event_id = '';
  const changeResult = publicChange();
  const cancelResult = publicCancel();
  assert.strictEqual(changeResult.ok, true);
  assert.strictEqual(cancelResult.ok, true);
  assert.ok(changeResult.data.reply.indexOf('لا يوجد لديك حجز مؤك') !== -1);
  assert.ok(cancelResult.data.reply.indexOf('لا يوجد لديك حجز') !== -1);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual((b6Sheets.B6_LIFECYCLE || { rows: [] }).rows.length, 0);
  assert.strictEqual(recoveryRows().length, 0);
  assert.strictEqual(alerts.length, 0);
  assert.strictEqual(createdEventCount, 0);
});

test('B6-14 — legacy B4 claim blocks B6 without bypass or destructive migration', function() {
  reset();
  properties['change_claim:' + PHONE] = JSON.stringify({ ownerToken: 'LEGACY', phone: PHONE, oldSlotId: 'OLD', acquiredAtMs: 1 });
  const changeResult = publicChange();
  const cancelResult = publicCancel();
  assert.strictEqual(changeResult.ok, true);
  assert.strictEqual(cancelResult.ok, true);
  assert.ok(properties['change_claim:' + PHONE]);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(createdEventCount, 0);
  assert.ok(events.OLD_EVENT);
});

test('B6-15 — old B6 ownership has no TTL or automatic takeover', function() {
  reset();
  properties['b6_lifecycle_claim:' + PHONE] = JSON.stringify({ operation_id: 'B6_OLD', phone: PHONE, ownerToken: 'OLD', ownershipState: 'HELD_UNRESOLVED', acquiredAt: 1 });
  nowMs += 365 * 24 * 60 * 60 * 1000;
  publicChange();
  assert.strictEqual(JSON.parse(claim(PHONE)).ownerToken, 'OLD');
  assert.strictEqual(createdEventCount, 0);
});

test('B6-16 — many operation-tag matches is unresolved, not terminal success', function() {
  reset();
  manyMatches = true;
  publicChange();
  assert.ok(claim(PHONE));
  assert.strictEqual(latest(PHONE).lifecycle_state, 'UNRESOLVED');
});

test('B6-17 — zero operation-tag matches is unresolved, not terminal success', function() {
  reset();
  const originalFind = sandbox.CalendarRepository.findLifecycleEventsByOperationId;
  sandbox.CalendarRepository.findLifecycleEventsByOperationId = function(operationId, start, end, calendarId) {
    return sandbox.Result.ok({ calendarId: calendarId, operationId: operationId, matches: [] });
  };
  publicChange();
  sandbox.CalendarRepository.findLifecycleEventsByOperationId = originalFind;
  assert.ok(claim(PHONE));
  assert.strictEqual(latest(PHONE).lifecycle_state, 'UNRESOLVED');
});

test('B6-18 — Calendar absence ambiguity is unresolved, not terminal cancel', function() {
  reset();
  deleteFailure = true;
  publicCancel();
  assert.ok(claim(PHONE));
  assert.strictEqual(latest(PHONE).lifecycle_state, 'UNRESOLVED');
  assert.strictEqual(free('OLD').status, 'CONFIRMED');
});

test('B6-19 — release failure keeps RELEASE_PENDING ownership after terminal proof', function() {
  reset();
  propertyDeleteFailure = true;
  const result = publicChange();
  assert.strictEqual(result.ok, true);
  assert.ok(claim(PHONE));
  assert.strictEqual(JSON.parse(claim(PHONE)).ownershipState, 'RELEASE_PENDING');
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASE_PENDING');
  assert.ok(latest(PHONE).recovery_case_id);
  assert.strictEqual(recoveryRows().length, 1);
});

test('B6-20 — RESOLVE_CHANGE proves existing replacement, cleans old resources, and releases', function() {
  reset();
  failOldSlotFree = true;
  publicChange();
  const recoveryCaseId = latest(PHONE).recovery_case_id;
  const countBeforeRecovery = createdEventCount;
  failOldSlotFree = false;
  const result = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(createdEventCount, countBeforeRecovery);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(free('OLD').status, 'FREE');
  assert.strictEqual(confirmed(PHONE).length, 1);
  assert.strictEqual(confirmed(PHONE)[0].slot_id, 'A');
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASED');
});

test('B6-21 — RESOLVE_CANCEL proves absence, frees target, and releases', function() {
  reset();
  failOldSlotFree = true;
  publicCancel();
  const recoveryCaseId = latest(PHONE).recovery_case_id;
  failOldSlotFree = false;
  const result = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CANCEL' }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(free('OLD').status, 'FREE');
  assert.strictEqual(confirmed(PHONE).length, 0);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASED');
});

test('B6-22 — RESOLVE_CHANGE without a provable replacement event remains recovery-required and creates no event', function() {
  reset();
  createFailure = true;
  publicChange();
  const recoveryCaseId = latest(PHONE).recovery_case_id;
  const countBeforeRecovery = createdEventCount;
  const result = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' }
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(createdEventCount, countBeforeRecovery);
  assert.ok(claim(PHONE));
  assert.strictEqual(JSON.parse(claim(PHONE)).ownershipState, 'HELD_RECOVERY');
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RECOVERY_REQUIRED');
});

test('B6-23 — RELEASE_PENDING journal blocks normal admission until CLOSE_RELEASE_PENDING proves and appends RELEASED', function() {
  reset();
  failReleasedCheckpoint = true;
  publicChange();
  const recoveryCaseId = latest(PHONE).recovery_case_id;
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASE_PENDING');
  const blocked = publicCancel();
  assert.strictEqual(blocked.ok, true);
  assert.ok(blocked.data.reply.indexOf('تعذّر إلغاء') !== -1);
  assert.strictEqual(confirmed(PHONE).length, 1);

  failReleasedCheckpoint = false;
  const closed = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'CLOSE_RELEASE_PENDING' }
  );
  assert.strictEqual(closed.ok, true);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASED');
  const allowed = publicCancel();
  assert.strictEqual(allowed.ok, true);
  assert.ok(allowed.data.reply.indexOf('تم إلغاء') !== -1);
});

test('B6-24 — CLOSE_RELEASE_PENDING requires the recovery execution token on re-entry', function() {
  reset();
  failReleasedCheckpoint = true;
  publicChange();
  const recoveryCaseId = latest(PHONE).recovery_case_id;
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASE_PENDING');

  failReleasedCheckpoint = false;
  auditAppendFailure = true;
  const firstClose = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'CLOSE_RELEASE_PENDING' }
  );
  assert.strictEqual(firstClose.ok, false);
  const executionClaim = JSON.parse(claim(PHONE));
  const token = firstClose.error.details.recoveryOwnerToken;
  assert.strictEqual(executionClaim.ownershipState, 'HELD_RECOVERY');
  assert.strictEqual(executionClaim.recoveryOwnerToken, token);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASE_PENDING');

  const missingToken = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'CLOSE_RELEASE_PENDING' }
  );
  const wrongToken = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'CLOSE_RELEASE_PENDING' },
    'WRONG_TOKEN'
  );
  assert.strictEqual(missingToken.ok, false);
  assert.strictEqual(missingToken.error.code, 'B6_RECOVERY_ALREADY_OWNED');
  assert.strictEqual(wrongToken.ok, false);
  assert.strictEqual(wrongToken.error.code, 'B6_RECOVERY_ALREADY_OWNED');

  auditAppendFailure = false;
  const closed = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'CLOSE_RELEASE_PENDING' },
    token
  );
  assert.strictEqual(closed.ok, true);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASED');
});

test('B6-25 — recovery authorization rejects absent operator and non-Doctor authority', function() {
  reset();
  createFailure = true;
  publicChange();
  const recoveryCaseId = latest(PHONE).recovery_case_id;
  const missingOperator = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: '', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' }
  );
  const wrongAuthority = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'operator-1', authorityType: 'ADMIN' },
    { type: 'RESOLVE_CHANGE' }
  );
  const freeFormDecision = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'GUESS_SUCCESS' }
  );
  assert.strictEqual(missingOperator.ok, false);
  assert.strictEqual(wrongAuthority.ok, false);
  assert.strictEqual(freeFormDecision.ok, false);
  assert.ok(claim(PHONE));
});

test('B6-26 — recovery audit ambiguity blocks recovery mutation and retains ownership', function() {
  reset();
  failOldSlotFree = true;
  publicChange();
  const recoveryCaseId = latest(PHONE).recovery_case_id;
  failOldSlotFree = false;
  auditAppendFailure = true;
  const result = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' }
  );
  assert.strictEqual(result.ok, false);
  assert.ok(claim(PHONE));
  assert.strictEqual(JSON.parse(claim(PHONE)).ownershipState, 'HELD_RECOVERY');
  assert.strictEqual(confirmed(PHONE).length, 2);
  assert.ok(events.OLD_EVENT === undefined);
});

test('B6-27 — ambiguous recovery audit write never releases ownership', function() {
  reset();
  auditAppendFailure = true;
  createFailure = true;
  publicChange();
  assert.ok(claim(PHONE));
  assert.strictEqual(JSON.parse(claim(PHONE)).ownershipState, 'HELD_UNRESOLVED');
});

test('B6-28 — structural: dedicated stores, operation tag, and no public recovery entry are present', function() {
  const lifecycleSource = fs.readFileSync(path.join(ROOT, 'Repositories/B6LifecycleRepository.js'), 'utf8');
  const auditSource = fs.readFileSync(path.join(ROOT, 'Repositories/B6RecoveryAuditRepository.js'), 'utf8');
  const calendarSource = fs.readFileSync(path.join(ROOT, 'Infrastructure/GoogleCalendar.js'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(ROOT, 'Application/B6LifecycleService.js'), 'utf8');
  const alertRepositorySource = fs.readFileSync(path.join(ROOT, 'Repositories/B6RecoveryAlertRepository.js'), 'utf8');
  const alertInfrastructureSource = fs.readFileSync(path.join(ROOT, 'Infrastructure/B6RecoveryAlert.js'), 'utf8');
  const webhookSource = fs.readFileSync(path.join(ROOT, 'Webhook.js'), 'utf8');
  assert.ok(lifecycleSource.indexOf("SHEET_NAME: 'B6_LIFECYCLE'") !== -1);
  assert.ok(auditSource.indexOf("SHEET_NAME: 'B6_RECOVERY_AUDIT'") !== -1);
  assert.ok(calendarSource.indexOf("B6_OPERATION_TAG_KEY: 'operation_id'") !== -1);
  assert.ok(calendarSource.indexOf('event.setTag') !== -1);
  assert.ok(calendarSource.indexOf('getEvents(startTime, endTime)') !== -1);
  assert.ok(serviceSource.indexOf('recoverRecoveryCase') !== -1);
  assert.strictEqual(serviceSource.indexOf('PropertiesService'), -1);
  assert.strictEqual(serviceSource.indexOf('WhatsAppAdapter'), -1);
  assert.strictEqual(serviceSource.indexOf('CalendarApp'), -1);
  assert.strictEqual(serviceSource.indexOf('GoogleSheets'), -1);
  assert.ok(alertRepositorySource.indexOf('B6RecoveryAlert.notifyRecoveryRequired') !== -1);
  assert.strictEqual(alertRepositorySource.indexOf('PropertiesService'), -1);
  assert.strictEqual(alertRepositorySource.indexOf('WhatsAppAdapter'), -1);
  assert.ok(alertInfrastructureSource.indexOf('PropertiesService') !== -1);
  assert.ok(alertInfrastructureSource.indexOf('WhatsAppAdapter') !== -1);
  assert.strictEqual(webhookSource.indexOf('recoverRecoveryCase'), -1);
});

test('B6-29 — structural: B6 claim has no TTL/takeover and Change/CANCEL share B6 begin', function() {
  const appointmentSource = fs.readFileSync(path.join(ROOT, 'AppointmentRepository.js'), 'utf8');
  const changeSource = fs.readFileSync(path.join(ROOT, 'Changeservice.js'), 'utf8');
  const cancelSource = fs.readFileSync(path.join(ROOT, 'Application/CancelService.js'), 'utf8');
  assert.ok(appointmentSource.indexOf("'b6_lifecycle_claim:' + phone") !== -1);
  assert.strictEqual(appointmentSource.indexOf('setTimeout'), -1);
  assert.strictEqual(appointmentSource.indexOf('takeover'), -1);
  assert.ok(changeSource.indexOf('B6LifecycleService.COMMANDS.CHANGE') !== -1);
  assert.ok(cancelSource.indexOf('B6LifecycleService.COMMANDS.CANCEL') !== -1);
});

test('B6-30 — completed RELEASED lifecycle rejects a second recovery attempt with the same recovery case', function() {
  reset();
  publicChange();
  const completed = latest(PHONE);
  const eventCountBeforeRecovery = createdEventCount;
  const result = sandbox.B6LifecycleService.recoverRecoveryCase(
    completed.recovery_case_id,
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' }
  );
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'B6_RECOVERY_NOT_ELIGIBLE');
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASED');
  assert.strictEqual(createdEventCount, eventCountBeforeRecovery);
});

test('B6-31 — ACTIVE and RESOLVED lifecycle records reject recovery without creating ownership or mutating resources', function() {
  reset();
  const activeRecord = sandbox.B6LifecycleRepository.appendCheckpoint({
    operation_id: 'B6_ACTIVE_CASE',
    phone: PHONE,
    command: 'CANCEL',
    old_slot_id: 'OLD',
    lifecycle_state: 'ACTIVE_POST_EFFECT',
    ownership_state: 'HELD_ACTIVE',
    checkpoint: 'CALENDAR_DELETE_ATTEMPTED',
    recovery_case_id: 'RCV_ACTIVE_CASE'
  });
  const resolvedRecord = sandbox.B6LifecycleRepository.appendCheckpoint({
    operation_id: 'B6_RESOLVED_CASE',
    phone: PHONE,
    command: 'CANCEL',
    old_slot_id: 'OLD',
    lifecycle_state: 'RESOLVED_CANCEL',
    ownership_state: 'RELEASED',
    checkpoint: 'RELEASED',
    recovery_case_id: 'RCV_RESOLVED_CASE'
  });
  assert.strictEqual(activeRecord.ok, true);
  assert.strictEqual(resolvedRecord.ok, true);

  const eventCountBefore = createdEventCount;
  const activeAttempt = sandbox.B6LifecycleService.recoverRecoveryCase(
    'RCV_ACTIVE_CASE',
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CANCEL' }
  );
  const resolvedAttempt = sandbox.B6LifecycleService.recoverRecoveryCase(
    'RCV_RESOLVED_CASE',
    { operatorId: 'doctor-1', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CANCEL' }
  );
  assert.strictEqual(activeAttempt.ok, false);
  assert.strictEqual(activeAttempt.error.code, 'B6_RECOVERY_NOT_ELIGIBLE');
  assert.strictEqual(resolvedAttempt.ok, false);
  assert.strictEqual(resolvedAttempt.error.code, 'B6_RECOVERY_NOT_ELIGIBLE');
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(createdEventCount, eventCountBefore);
  assert.ok(events.OLD_EVENT);
  assert.strictEqual(free('OLD').status, 'CONFIRMED');
});

test('B6-32 — deterministic recovery interleave blocks a second execution and normal lifecycle commands', function() {
  reset();
  failOldSlotFree = true;
  publicChange();
  const recoveryCaseId = latest(PHONE).recovery_case_id;
  failOldSlotFree = false;
  const eventCountBeforeRecovery = createdEventCount;
  let executionBRecovery;
  let executionBChange;
  let executionBCancel;

  recoveryInterleave = function() {
    executionBRecovery = sandbox.B6LifecycleService.recoverRecoveryCase(
      recoveryCaseId,
      { operatorId: 'doctor-A', authorityType: 'DOCTOR' },
      { type: 'RESOLVE_CHANGE' }
    );
    executionBChange = publicChange();
    executionBCancel = publicCancel();
  };

  const doctorA = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-A', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' }
  );

  assert.strictEqual(doctorA.ok, true);
  assert.strictEqual(executionBRecovery.ok, false);
  assert.strictEqual(executionBRecovery.error.code, 'B6_RECOVERY_ALREADY_OWNED');
  assert.strictEqual(executionBChange.ok, true);
  assert.strictEqual(executionBCancel.ok, true);
  assert.ok(executionBChange.data.reply.indexOf('تعذّر تغيير') !== -1);
  assert.ok(executionBCancel.data.reply.indexOf('تعذّر إلغاء') !== -1);
  assert.strictEqual(createdEventCount, eventCountBeforeRecovery);
  assert.strictEqual(claim(PHONE), undefined);
  assert.strictEqual(latest(PHONE).lifecycle_state, 'RELEASED');
});

test('B6-33 — same operator re-entry requires the exact recoveryOwnerToken', function() {
  reset();
  createFailure = true;
  publicChange();
  const recoveryCaseId = latest(PHONE).recovery_case_id;

  const first = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-A', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' }
  );
  assert.strictEqual(first.ok, false);
  const token = first.error.details.recoveryOwnerToken;
  const claimAfterFirst = JSON.parse(claim(PHONE));
  assert.strictEqual(claimAfterFirst.ownershipState, 'HELD_RECOVERY');
  assert.strictEqual(claimAfterFirst.recoveryOwnerToken, token);

  const missingToken = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-A', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' }
  );
  const wrongToken = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-A', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' },
    'WRONG_TOKEN'
  );
  const correctToken = sandbox.B6LifecycleService.recoverRecoveryCase(
    recoveryCaseId,
    { operatorId: 'doctor-A', authorityType: 'DOCTOR' },
    { type: 'RESOLVE_CHANGE' },
    token
  );
  assert.strictEqual(missingToken.ok, false);
  assert.strictEqual(missingToken.error.code, 'B6_RECOVERY_ALREADY_OWNED');
  assert.strictEqual(wrongToken.ok, false);
  assert.strictEqual(wrongToken.error.code, 'B6_RECOVERY_ALREADY_OWNED');
  assert.strictEqual(correctToken.ok, false);
  assert.notStrictEqual(correctToken.error.code, 'B6_RECOVERY_ALREADY_OWNED');
  assert.strictEqual(JSON.parse(claim(PHONE)).recoveryOwnerToken, token);
});

test('B6-34 — GoogleCalendar lifecycle infrastructure persists and finds exact operation tags', function() {
  const calendarSource = fs.readFileSync(path.join(ROOT, 'Infrastructure/GoogleCalendar.js'), 'utf8');
  const tagStore = {};
  let deleted = false;
  const event = {
    getId: function() { return 'INFRA_EVENT'; },
    setTag: function(key, value) { tagStore[key] = value; return this; },
    getTag: function(key) { return tagStore[key] || ''; },
    deleteEvent: function() { deleted = true; }
  };
  const calendar = {
    getId: function() { return 'INFRA_CAL'; },
    createEvent: function() { deleted = false; return event; },
    getEventById: function(id) { return deleted ? null : (id === 'INFRA_EVENT' ? event : null); },
    getEvents: function() { return deleted ? [] : [event]; }
  };
  const isolated = vm.createContext({ CalendarApp: { getDefaultCalendar: function() { return calendar; }, getCalendarById: function() { return calendar; } } });
  vm.runInContext(calendarSource + '\nthis.GoogleCalendar = GoogleCalendar;', isolated, { filename: 'Infrastructure/GoogleCalendar.js' });
  const created = isolated.GoogleCalendar.createLifecycleEvent({
    title: 't', startTime: new Date(NOW_MS), endTime: new Date(NOW_MS + 60000), description: 'd', operationId: 'B6_INFRA'
  });
  assert.strictEqual(created.eventId, 'INFRA_EVENT');
  assert.strictEqual(tagStore.operation_id, 'B6_INFRA');
  const matches = isolated.GoogleCalendar.findLifecycleEventsByOperationId('B6_INFRA', new Date(NOW_MS), new Date(NOW_MS + 86400000), 'INFRA_CAL');
  assert.strictEqual(matches.matches.length, 1);
  const deletedResult = isolated.GoogleCalendar.deleteLifecycleEvent('INFRA_EVENT', 'INFRA_CAL', 'B6_INFRA');
  assert.strictEqual(deletedResult.status, 'ABSENCE_OBSERVED');
  assert.strictEqual(deletedResult.deleteConfirmed, true);
});

let failures = 0;
tests.forEach(function(entry) {
  try {
    entry.fn();
    console.log('PASS:', entry.name);
  } catch (error) {
    failures += 1;
    console.error('FAIL:', entry.name);
    console.error(error.stack || error.message);
  }
});

if (failures > 0) process.exit(1);
console.log('\n' + tests.length + '/' + tests.length + ' tests passed');
