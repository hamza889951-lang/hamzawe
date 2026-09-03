'use strict';

/**
 * HardeningM4F.test.js — M4-F Patient Disruption / Recovery
 *
 * Contract: HAMZAWE_M4F_FROZEN_CONTRACT_v1_2026-09-03.md
 *           + HAMZAWE_M4F_CONTRACT_CLOSURE_ADDENDUM_v1.1_2026-09-03.md
 *
 * Acceptance mapping — M4F-01..64.
 *
 * TEST BOUNDARY NOTE (deliberate): ChangeService and BookingService are
 * stubbed with recording fakes. M4-F is responsible for *delegating* to
 * those existing boundaries with the right inputs at the right time; the
 * internals of B6 ownership, Calendar correlation and recovery are already
 * covered by HardeningB4 / HardeningB6 and must not be re-tested here. Every
 * Calendar guarantee in this suite is therefore asserted in two ways:
 *   (1) delegation — the existing seam was invoked with the proposal target;
 *   (2) structure   — M4-F source contains no Calendar/Spreadsheet/provider
 *                     reference at all, so it cannot bypass those seams.
 */

process.env.TZ = 'Asia/Baghdad';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// Local (Asia/Baghdad) 2026-09-03 09:00.
const EVAL_ISO = '2026-09-03T06:00:00.000Z';
const EVAL_MS = Date.parse(EVAL_ISO);

const AVAILABILITY_HEADERS = [
  'slot_id', 'date', 'time', 'sort_key', 'status', 'is_available',
  'patient_name', 'phone', 'calendar_event_id', 'Reminder_sent',
  'whatsapp_message_id', 'reserved_until', 'reserved_until_unix'
];

const CONVERSATION_HEADERS = [
  'conversation_id', 'phone', 'state', 'temp_name', 'slot_id', 'updated_at',
  'disruption_original_slot_id', 'disruption_proposal_slot_id', 'disruption_kind',
  'disruption_created_at_ms', 'disruption_expires_at_ms', 'disruption_proposal_id',
  'disruption_notification_status'
];

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    sheets: {},
    failRead: {},
    failWrite: false,
    logs: [],
    sends: [],
    changeCalls: [],
    bookingCalls: [],
    calendar: 0,
    lockHeld: false,
    lockTimeouts: 0,
    nowIso: EVAL_ISO,
    seq: 0,
    interleaveHook: null,
    interleaveFired: false,
    changeShouldFail: false,
    changeNotChanged: false,
    confirmShouldFail: false,
    sendShouldFail: false
  };

  function sheet(name) {
    if (!state.sheets[name]) state.sheets[name] = { headers: [], rows: [] };
    return state.sheets[name];
  }

  sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sandbox.Utilities = {
    formatDate: function(date, tz, fmt) {
      const p = function(n) { return String(n).padStart(2, '0'); };
      if (fmt === 'yyyy-MM-dd') {
        return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
      }
      return p(date.getHours()) + ':' + p(date.getMinutes());
    }
  };

  function guardRead(name) {
    if (!state.sheets[name]) throw new Error('SHEET_NOT_FOUND: ' + name);
    if (state.failRead[name]) throw new Error('INJECTED_READ_FAILURE: ' + name);
  }

  sandbox.GoogleSheets = {
    getAllRows: function(name) {
      guardRead(name);
      return state.sheets[name].rows.map(function(r) { return Object.assign({}, r); });
    },
    queryRows: function(name, predicateFn) {
      return sandbox.GoogleSheets.getAllRows(name).filter(predicateFn);
    },
    getHeaders: function(name) {
      guardRead(name);
      return state.sheets[name].headers.slice();
    },
    findRowByColumn: function(name, column, value) {
      guardRead(name);
      const rows = state.sheets[name].rows;
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][column]) === String(value)) return Object.assign({}, rows[i]);
      }
      return null;
    },
    appendRow: function(name, record) {
      guardRead(name);
      if (state.failWrite) throw new Error('INJECTED_WRITE_FAILURE');
      const s = sheet(name);
      const row = {};
      s.headers.forEach(function(h) { row[h] = record[h] === undefined ? '' : record[h]; });
      s.rows.push(row);
      return true;
    },
    updateRowByColumn: function(name, column, value, fields) {
      guardRead(name);
      if (state.failWrite) throw new Error('INJECTED_WRITE_FAILURE');
      const rows = state.sheets[name].rows;
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][column]) === String(value)) {
          Object.keys(fields).forEach(function(k) { rows[i][k] = fields[k]; });
          // M4F-59: model the reservation→persistence window. Fire once,
          // immediately AFTER the candidate reservation has been committed.
          if (state.interleaveHook && !state.interleaveFired &&
              name === 'Availability' && fields.status === 'RESERVED') {
            state.interleaveFired = true;
            const hook = state.interleaveHook;
            state.interleaveHook = null;
            hook(rows[i]);
          }
          return true;
        }
      }
      return false;
    },
    updateBatch: function() { throw new Error('M4F_MUST_NOT_USE_UPDATE_BATCH'); },
    appendRows: function() { throw new Error('M4F_MUST_NOT_USE_APPEND_ROWS'); },
    deleteRowsByNumbers: function() { throw new Error('M4F_MUST_NOT_DELETE'); },
    getOrCreateSheet: function() { throw new Error('M4F_MUST_NOT_CREATE_SHEET'); }
  };

  sandbox.GoogleCalendar = {
    createEvent: function() { state.calendar += 1; return 'EVT_' + state.calendar; },
    createLifecycleEvent: function() { state.calendar += 1; return { eventId: 'EVT_' + state.calendar, calendarId: 'CAL' }; },
    deleteEvent: function() { state.calendar += 1; return true; },
    deleteLifecycleEvent: function() { state.calendar += 1; return { status: 'ABSENCE_OBSERVED' }; },
    inspectLifecycleEvent: function() { state.calendar += 1; return { status: 'MATCH', contextResolved: true, calendarId: 'CAL' }; },
    findLifecycleEventsByOperationId: function() { state.calendar += 1; return []; }
  };

  sandbox.LockService = {
    getScriptLock: function() {
      return {
        waitLock: function() {
          if (state.lockHeld) { state.lockTimeouts += 1; throw new Error('LOCK_HELD'); }
          state.lockHeld = true;
        },
        releaseLock: function() { state.lockHeld = false; }
      };
    },
    getUserLock: function() {
      return sandbox.LockService.getScriptLock();
    }
  };

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      return { getProperty: function() { return null; }, setProperty: function() {} };
    }
  };

  sandbox.LogRepository = {
    write: function(entry) { state.logs.push(entry); return true; }
  };

  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
  }

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('Clock.js', 'Clock');
  sandbox.Clock.now = function() { return new Date(state.nowIso); };
  load('Utils/ULID.js', 'ULID');
  load('Utils/IdGenerator.js', 'IdGenerator');
  load('Utils/DateUtils.js', 'DateUtils');
  load('Utils/LegacySlotTimeParser.js', 'LegacySlotTimeParser');
  load('Utils/PhoneUtils.js', 'PhoneUtils');
  load('StateMachine.js', 'StateMachine');
  load('Domain/Validators.js', 'Validators');
  load('Infrastructure/Lock.js', 'Lock');
  load('Repositories/SlotRepository.js', 'SlotRepository');
  load('ConversationRepository.js', 'ConversationRepository');
  load('Slotselection.js', 'SlotSelection');
  load('Application/AffectedAppointmentDiscoveryService.js', 'AffectedAppointmentDiscoveryService');
  load('Application/PatientDisruptionService.js', 'PatientDisruptionService');

  // ─── Recording fakes for the pre-existing boundaries M4-F delegates to ───
  sandbox.ChangeService = {
    changeConfirmedAppointment: function(phone, options) {
      state.changeCalls.push({ phone: phone, options: options || null });
      if (state.changeShouldFail) return sandbox.Result.fail('B6_TEST_FAILURE', 'injected B6 failure');
      if (state.changeNotChanged) {
        return sandbox.Result.ok({ status: 'FAILED', reply: 'تعذّر تغيير موعدك حالياً.', conversationState: 'BOOKED' });
      }
      return sandbox.Result.ok({ status: 'CHANGED', reply: 'تم تغيير موعدك بنجاح.', conversationState: 'BOOKED' });
    }
  };

  sandbox.BookingService = {
    confirmReservedSlot: function(phone, slotId) {
      state.bookingCalls.push({ phone: phone, slotId: slotId });
      if (state.confirmShouldFail) return sandbox.Result.fail('CALENDAR_CREATE_FAILED', 'injected calendar failure');
      // Mirror the real seam: RESERVED → CONFIRMED through atomicUpdate, then
      // Calendar creation (counted) and calendar_event_id persistence.
      const updated = sandbox.SlotRepository.atomicUpdate(slotId, function(fresh) {
        if (fresh.phone !== phone) {
          return sandbox.Result.fail('SLOT_OWNER_MISMATCH', 'not owned', { slotId: slotId });
        }
        const check = sandbox.Validators.validateTransition(fresh.status, 'ConfirmReservation');
        if (!check.ok) return check;
        return sandbox.Result.ok({ status: 'CONFIRMED' });
      });
      if (!updated.ok) return updated;
      state.calendar += 1;
      const stored = sandbox.SlotRepository.atomicUpdate(slotId, function() {
        return sandbox.Result.ok({ calendar_event_id: 'EVT_' + state.calendar });
      });
      if (!stored.ok) return stored;
      return sandbox.Result.ok({ slotId: slotId, calendarEventId: 'EVT_' + state.calendar, date: '', time: '', busNumber: null });
    }
  };

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;
const SVC = sandbox.PatientDisruptionService;

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function resetAll() {
  state.sheets = {
    Availability: { headers: AVAILABILITY_HEADERS.slice(), rows: [] },
    Conversations: { headers: CONVERSATION_HEADERS.slice(), rows: [] }
  };
  state.failRead = {};
  state.failWrite = false;
  state.logs = [];
  state.sends = [];
  state.changeCalls = [];
  state.bookingCalls = [];
  state.calendar = 0;
  state.lockHeld = false;
  state.lockTimeouts = 0;
  state.nowIso = EVAL_ISO;
  state.seq = 0;
  state.interleaveHook = null;
  state.interleaveFired = false;
  state.changeShouldFail = false;
  state.changeNotChanged = false;
  state.confirmShouldFail = false;
  state.sendShouldFail = false;
}

function seedSlot(fields) {
  state.seq += 1;
  const slot = Object.assign({
    slot_id: 'SLT_M4F_' + String(state.seq).padStart(3, '0'),
    date: '2026/09/03',
    time: '10:30',
    sort_key: '202609031030',
    status: 'FREE',
    is_available: true,
    patient_name: '',
    phone: '',
    calendar_event_id: '',
    Reminder_sent: '',
    whatsapp_message_id: '',
    reserved_until: '',
    reserved_until_unix: ''
  }, fields || {});
  state.sheets.Availability.rows.push(slot);
  return slot;
}

/** An appointment that M4-E will report as affected. */
function seedAffectedAppointment(fields) {
  return seedSlot(Object.assign({
    status: 'CONFIRMED',
    is_available: false,
    patient_name: 'مريض تجريبي',
    phone: '9647800000000',
    calendar_event_id: 'EVT_OLD'
  }, fields || {}));
}

function seedConversation(phone, fields) {
  const row = Object.assign({
    conversation_id: 'CONV_' + phone,
    phone: phone,
    state: 'MENU_MAIN',
    temp_name: '',
    slot_id: '',
    updated_at: '',
    disruption_original_slot_id: '',
    disruption_proposal_slot_id: '',
    disruption_kind: '',
    disruption_created_at_ms: '',
    disruption_expires_at_ms: '',
    disruption_proposal_id: '',
    disruption_notification_status: ''
  }, fields || {});
  state.sheets.Conversations.rows.push(row);
  return row;
}

function slotById(slotId) {
  const rows = state.sheets.Availability.rows;
  for (let i = 0; i < rows.length; i++) if (rows[i].slot_id === slotId) return rows[i];
  return null;
}

function conversationOf(phone) {
  const rows = state.sheets.Conversations.rows;
  for (let i = 0; i < rows.length; i++) if (rows[i].phone === phone) return rows[i];
  return null;
}

function sendFn() {
  return function(phone, text) {
    state.sends.push({ phone: phone, text: text });
    if (state.sendShouldFail) return sandbox.Result.fail('WHATSAPP_SEND_FAILED', 'injected');
    return sandbox.Result.ok({ phone: phone });
  };
}

function runStage(overrides) {
  const options = Object.assign({ sendFn: sendFn() }, overrides || {});
  return SVC.processDisruptions(options);
}

function respond(phone, message) {
  return SVC.handleIncomingMessage(phone, message);
}

function reservedCountFor(phone) {
  return state.sheets.Availability.rows.filter(function(r) {
    return r.phone === phone && r.status === 'RESERVED';
  }).length;
}

function confirmedCountFor(phone) {
  return state.sheets.Availability.rows.filter(function(r) {
    return r.phone === phone && r.status === 'CONFIRMED';
  }).length;
}

/** Build the canonical happy path: one affected CONFIRMED + two free candidates. */
function happyPath(kind) {
  const original = seedAffectedAppointment({ status: kind || 'CONFIRMED' });
  if (kind === 'RESERVED') {
    original.reserved_until_unix = String(EVAL_MS + 5 * 60000);
  }
  seedConversation(original.phone, {
    state: kind === 'RESERVED' ? 'WAITING_CONFIRMATION' : 'BOOKED',
    slot_id: original.slot_id,
    temp_name: 'مريض تجريبي'
  });
  const candidate = seedSlot({ sort_key: '202609041100', date: '2026/09/04', time: '11:00' });
  seedSlot({ sort_key: '202609051200', date: '2026/09/05', time: '12:00' });
  return { original: original, candidate: candidate, phone: original.phone };
}

function sourceOf(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function strippedSourceOf(rel) {
  return sourceOf(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ═════════════════════════════════════════════════════════════════════════
// A — Discovery / ordering
// ═════════════════════════════════════════════════════════════════════════

test('M4F-01 — valid M4-E affected evidence produces one durable proposal + immediate notification', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');

  const result = runStage();

  assert.strictEqual(result.ok, true, 'stage must succeed');
  assert.strictEqual(result.data.created.length, 1);
  assert.strictEqual(result.data.created[0].kind, 'CONFIRMED');
  assert.strictEqual(result.data.created[0].originalSlotId, ctx.original.slot_id);
  assert.strictEqual(result.data.created[0].proposalSlotId, ctx.candidate.slot_id);
  assert.ok(/^DSP_/.test(result.data.created[0].proposalId), 'durable proposal identity');

  const conv = conversationOf(ctx.phone);
  assert.strictEqual(conv.state, 'WAITING_DISRUPTION_CONFIRMATION');
  assert.strictEqual(conv.disruption_notification_status, 'SENT');
  assert.strictEqual(state.sends.length, 1, 'patient notified immediately');
  assert.ok(state.sends[0].text.indexOf('الموعد البديل المقترح') !== -1);
});

test('M4F-02 — stale evidence is revalidated and rejected (appointment no longer affected)', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  // The clinic session reopened after M4-E produced its evidence.
  ctx.original.is_available = true;

  const result = runStage();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.created.length, 0, 'no proposal from stale evidence');
  assert.strictEqual(state.sends.length, 0);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE', 'no reservation');
});

test('M4F-03 — CONFIRMED affected appointments are processed before active RESERVED ones', function() {
  resetAll();
  const confirmedPhone = '9647800000001';
  const reservedPhone = '9647800000002';

  const conf = seedAffectedAppointment({ phone: confirmedPhone, status: 'CONFIRMED' });
  const res = seedAffectedAppointment({
    phone: reservedPhone,
    status: 'RESERVED',
    reserved_until_unix: String(EVAL_MS + 5 * 60000)
  });
  seedConversation(confirmedPhone, { state: 'BOOKED', slot_id: conf.slot_id });
  seedConversation(reservedPhone, { state: 'WAITING_CONFIRMATION', slot_id: res.slot_id });

  seedSlot({ sort_key: '202609041100', date: '2026/09/04', time: '11:00' });
  seedSlot({ sort_key: '202609051200', date: '2026/09/05', time: '12:00' });

  const result = runStage();

  assert.strictEqual(result.data.created.length, 2);
  assert.strictEqual(result.data.created[0].phone, confirmedPhone, 'CONFIRMED first');
  assert.strictEqual(result.data.created[1].phone, reservedPhone, 'RESERVED second');
});

test('M4F-04 — at most one pending proposal per phone (second Scheduler run is a no-op)', function() {
  resetAll();
  happyPath('CONFIRMED');

  const first = runStage();
  assert.strictEqual(first.data.created.length, 1);

  const second = runStage();
  assert.strictEqual(second.data.created.length, 0, 'no second proposal');
  assert.strictEqual(second.data.skipped.length, 1);
  assert.strictEqual(second.data.skipped[0].reason, 'M4F_PENDING_PROPOSAL_EXISTS');
  assert.strictEqual(reservedCountFor('9647800000000'), 1, 'no second reservation');
  assert.strictEqual(state.sends.length, 1, 'no second notification for a SENT proposal');
});

test('M4F-05 — multiple affected slots for one phone do not create competing proposals', function() {
  resetAll();
  const phone = '9647800000003';
  const a = seedAffectedAppointment({ phone: phone, sort_key: '202609040900' });
  const b = seedAffectedAppointment({ phone: phone, sort_key: '202609041000' });
  seedConversation(phone, { state: 'BOOKED', slot_id: a.slot_id });
  const candidate = seedSlot({ sort_key: '202609051100', date: '2026/09/05', time: '11:00' });

  const result = runStage();

  assert.strictEqual(result.data.created.length, 1, 'exactly one proposal for the phone');
  assert.strictEqual(result.data.skipped.length, 1);
  assert.strictEqual(result.data.skipped[0].reason, 'PHONE_ALREADY_HANDLED');
  assert.strictEqual(result.data.created[0].originalSlotId, a.slot_id, 'earliest affected wins');
  assert.strictEqual(reservedCountFor(phone), 1);
  assert.strictEqual(slotById(candidate.slot_id).status, 'RESERVED');
});

// ═════════════════════════════════════════════════════════════════════════
// B — Alternative selection
// ═════════════════════════════════════════════════════════════════════════

test('M4F-06 — candidate start must satisfy now + MIN_BOOKING_LEAD_MINUTES', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  // 09:45 local — inside the horizon but before the 60-minute lead cutoff.
  ctx.candidate.sort_key = '202609030945';
  slotById('SLT_M4F_003').sort_key = '202609030950';

  const result = runStage();

  assert.strictEqual(result.data.created.length, 0);
  assert.strictEqual(result.data.noAlternative.length, 1, 'no alternative → notification only');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE', 'no out-of-policy reservation');
});

test('M4F-07 — equality at the lower bound is accepted (inclusive cutoff)', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  // Exactly now + 60 minutes (09:00 + 1h = 10:00 local).
  ctx.candidate.sort_key = '202609031000';
  slotById('SLT_M4F_003').sort_key = '202609040900';

  const result = runStage();

  assert.strictEqual(result.data.created.length, 1);
  assert.strictEqual(result.data.created[0].proposalSlotId, ctx.candidate.slot_id);
});

test('M4F-08 — three-calendar-day horizon is enforced, end-exclusive', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  ctx.candidate.sort_key = '202609061000';           // day +3 → out of horizon
  slotById('SLT_M4F_003').sort_key = '202609051000'; // day +2 → third day, allowed

  const result = runStage();

  assert.strictEqual(result.data.created.length, 1);
  assert.strictEqual(result.data.created[0].proposalSlotId, 'SLT_M4F_003');
});

test('M4F-09 — the original affected slot is excluded from candidacy', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  // Make the original itself the only FREE/available slot in the horizon.
  ctx.original.status = 'FREE';
  ctx.original.is_available = true;
  slotById('SLT_M4F_002').is_available = false;
  slotById('SLT_M4F_003').sort_key = '202609101000';

  const selection = sandbox.SlotSelection.findEarliestWithinHorizon({
    excludedSlotIds: [ctx.original.slot_id],
    horizonDays: 3
  });

  assert.strictEqual(selection.ok, false);
  assert.strictEqual(selection.error.code, 'NO_SLOT_AVAILABLE');
});

test('M4F-10 — a lower Bus Number than the original is allowed (no "must be later" rule)', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  // Original at 16:00; candidate at 10:30 the same day (earlier bus number).
  ctx.original.sort_key = '202609031600';
  ctx.original.time = '16:00';
  ctx.candidate.sort_key = '202609031030';
  slotById('SLT_M4F_003').sort_key = '202609041100';

  const result = runStage();

  assert.strictEqual(result.data.created.length, 1);
  assert.strictEqual(result.data.created[0].proposalSlotId, ctx.candidate.slot_id,
    'an earlier slot the same day is a valid alternative');
});

test('M4F-11 — deterministic tie-break by start then slot_id ascending', function() {
  resetAll();
  const a = seedSlot({ slot_id: 'SLT_ZZZ', sort_key: '202609041100' });
  const b = seedSlot({ slot_id: 'SLT_AAA', sort_key: '202609041100' });

  const selection = sandbox.SlotSelection.findEarliestWithinHorizon({ horizonDays: 3 });

  assert.strictEqual(selection.ok, true);
  assert.strictEqual(selection.data.slot_id, 'SLT_AAA', 'slot_id breaks the start-time tie');
});

test('M4F-12 — malformed sort_key candidates are excluded safely', function() {
  resetAll();
  seedSlot({ slot_id: 'SLT_BAD', sort_key: 'not-a-sort-key' });
  const good = seedSlot({ slot_id: 'SLT_GOOD', sort_key: '202609041100' });

  const selection = sandbox.SlotSelection.findEarliestWithinHorizon({ horizonDays: 3 });

  assert.strictEqual(selection.ok, true);
  assert.strictEqual(selection.data.slot_id, good.slot_id);
});

test('M4F-13 — no candidate ⇒ notification only, no reservation and no proposal', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  slotById('SLT_M4F_002').is_available = false;
  slotById('SLT_M4F_003').sort_key = '202609201000';

  const result = runStage();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.created.length, 0);
  assert.strictEqual(result.data.noAlternative.length, 1);
  assert.strictEqual(state.sends.length, 1, 'patient is notified');
  assert.ok(state.sends[0].text.indexOf('لا يتوفر موعد بديل') !== -1);
  assert.strictEqual(reservedCountFor(ctx.phone), 0, 'no reservation');
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED', 'interaction unchanged');
});

// ═════════════════════════════════════════════════════════════════════════
// C — Proposal persistence / notification
// ═════════════════════════════════════════════════════════════════════════

test('M4F-14 — the candidate is reserved BEFORE the patient is notified', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');

  let observedAtSend = null;
  runStage({
    sendFn: function(phone, text) {
      observedAtSend = slotById(ctx.candidate.slot_id).status;
      state.sends.push({ phone: phone, text: text });
      return sandbox.Result.ok({ phone: phone });
    }
  });

  assert.strictEqual(observedAtSend, 'RESERVED', 'notification may only follow a durable reservation');
});

test('M4F-15 — the proposal carries a durable identity and a 30-minute expiry', function() {
  resetAll();
  happyPath('CONFIRMED');

  runStage();
  const conv = conversationOf('9647800000000');

  assert.ok(/^DSP_/.test(conv.disruption_proposal_id));
  const createdMs = Number(conv.disruption_created_at_ms);
  const expiresMs = Number(conv.disruption_expires_at_ms);
  assert.ok(isFinite(createdMs) && isFinite(expiresMs));
  assert.strictEqual(expiresMs - createdMs, 30 * 60 * 1000, 'expiry is 30 minutes from creation');
  assert.strictEqual(Number(slotById(conv.disruption_proposal_slot_id).reserved_until_unix), expiresMs,
    'the reservation hold is the proposal expiry, not the 5-minute timeout');
});

test('M4F-16 — notification is sent immediately after durable proposal creation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');

  runStage();

  const conv = conversationOf(ctx.phone);
  assert.strictEqual(conv.state, 'WAITING_DISRUPTION_CONFIRMATION');
  assert.strictEqual(conv.disruption_notification_status, 'SENT');
  assert.strictEqual(state.sends.length, 1);
  assert.strictEqual(state.sends[0].phone, ctx.phone);
});

test('M4F-17 — notification failure keeps the proposal durable and retryable, without a duplicate reservation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  state.sendShouldFail = true;

  const first = runStage();

  assert.strictEqual(first.data.created.length, 1, 'proposal remains durable');
  assert.strictEqual(first.data.notified[0].status, 'FAILED');
  const conv = conversationOf(ctx.phone);
  assert.strictEqual(conv.disruption_notification_status, 'FAILED');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED', 'target stays held');

  state.sendShouldFail = false;
  const second = runStage();

  assert.strictEqual(second.data.created.length, 0, 'retry creates no second proposal');
  assert.strictEqual(second.data.skipped[0].notification.retried, true);
  assert.strictEqual(reservedCountFor(ctx.phone), 1, 'still exactly one reservation');
  assert.strictEqual(conversationOf(ctx.phone).disruption_notification_status, 'SENT');
});

test('M4F-18 — a duplicate Scheduler run is idempotent (same proposal identity)', function() {
  resetAll();
  happyPath('CONFIRMED');

  const first = runStage();
  const proposalId = conversationOf('9647800000000').disruption_proposal_id;
  const second = runStage();

  assert.strictEqual(second.data.created.length, 0);
  assert.strictEqual(conversationOf('9647800000000').disruption_proposal_id, proposalId);
  assert.strictEqual(reservedCountFor('9647800000000'), 1);
  assert.strictEqual(first.data.created[0].proposalId, proposalId);
});

// ═════════════════════════════════════════════════════════════════════════
// D — Patient response
// ═════════════════════════════════════════════════════════════════════════

test('M4F-19 — finalization requires an explicit patient confirmation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  const before = slotById(ctx.candidate.slot_id).status;
  const reply = respond(ctx.phone, 'مرحبا');

  assert.strictEqual(reply.data.invalidResponse, true);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, before, 'no mutation without explicit intent');
  assert.strictEqual(state.changeCalls.length, 0);
});

test('M4F-20 — an invalid response performs no mutation and keeps the pending proposal', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();
  const conv0 = Object.assign({}, conversationOf(ctx.phone));

  const reply = respond(ctx.phone, '99');

  assert.strictEqual(reply.data.conversationState, 'WAITING_DISRUPTION_CONFIRMATION');
  const conv1 = conversationOf(ctx.phone);
  assert.strictEqual(conv1.disruption_proposal_id, conv0.disruption_proposal_id);
  assert.strictEqual(conv1.disruption_proposal_slot_id, conv0.disruption_proposal_slot_id);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'CONFIRMED');
});

test('M4F-21 — decline returns the proposal target RESERVED → FREE and clears pending state', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  const reply = respond(ctx.phone, '2');

  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.data.declined, true);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE');
  assert.strictEqual(slotById(ctx.candidate.slot_id).phone, '');
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED', 'CONFIRMED original → BOOKED');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, '');
});

test('M4F-22 — timeout returns the proposal target RESERVED → FREE and clears pending state', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();
  const proposalId = conversationOf(ctx.phone).disruption_proposal_id;

  // Move past the 30-minute proposal expiry.
  state.nowIso = new Date(EVAL_MS + 31 * 60000).toISOString();
  const result = runStage();

  assert.strictEqual(result.data.expired.length, 1);
  assert.strictEqual(result.data.expired[0].proposalId, proposalId);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE');
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED');
});

test('M4F-23 — an expired confirmation cannot finalize and releases the target safely', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  state.nowIso = new Date(EVAL_MS + 45 * 60000).toISOString();
  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.expired, true);
  assert.strictEqual(state.changeCalls.length, 0, 'no confirmed-change after expiry');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE', 'target released');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'CONFIRMED', 'original untouched');
});

test('M4F-24 — a duplicate confirmation resolves harmlessly (no second appointment)', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  const first = respond(ctx.phone, '1');
  const second = respond(ctx.phone, '1');

  assert.strictEqual(first.data.confirmed, true);
  assert.strictEqual(state.changeCalls.length, 1, 'the change boundary runs exactly once');
  assert.strictEqual(second.ok, true);
  // The second message arrives after the pending state was cleared.
  assert.strictEqual(second.data.conversationState, 'MENU_MAIN');
  assert.strictEqual(state.changeCalls.length, 1, 'still exactly one');
});

// ═════════════════════════════════════════════════════════════════════════
// E — CONFIRMED final mutation
// ═════════════════════════════════════════════════════════════════════════

test('M4F-25 — the confirmed-change boundary is reached only at final confirmation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  assert.strictEqual(state.changeCalls.length, 0, 'not during creation');
  respond(ctx.phone, '7'); // invalid response while waiting
  assert.strictEqual(state.changeCalls.length, 0, 'not while waiting');

  respond(ctx.phone, '1');
  assert.strictEqual(state.changeCalls.length, 1, 'only at explicit confirmation');
});

test('M4F-26 — the original appointment is revalidated freshly before finalization', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  // Patient cancelled the original independently while the proposal waited.
  slotById(ctx.original.slot_id).status = 'FREE';
  slotById(ctx.original.slot_id).phone = '';

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.failureCode, 'M4F_STALE_ORIGINAL');
  assert.strictEqual(state.changeCalls.length, 0, 'no cross-appointment mutation');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED', 'proposal kept, not orphaned');
});

test('M4F-27 — the proposal target is revalidated freshly before finalization', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  // The target lost its reservation (e.g. released by another path).
  slotById(ctx.candidate.slot_id).status = 'FREE';
  slotById(ctx.candidate.slot_id).phone = '';

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.failureCode, 'M4F_STALE_CANDIDATE');
  assert.strictEqual(state.changeCalls.length, 0);
});

test('M4F-28 — the existing ChangeService boundary is reused with the proposed target', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  respond(ctx.phone, '1');

  assert.strictEqual(state.changeCalls.length, 1);
  assert.strictEqual(state.changeCalls[0].phone, ctx.phone);
  // Compared field-by-field: the options object was created inside the vm
  // realm, so deepStrictEqual against a host-realm literal is unreliable.
  assert.strictEqual(Object.keys(state.changeCalls[0].options).join(','), 'targetSlotId');
  assert.strictEqual(state.changeCalls[0].options.targetSlotId, ctx.candidate.slot_id,
    'the already-proposed target is used — generic selection is never re-run');
});

test('M4F-29 — Calendar is not touched before explicit patient confirmation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  assert.strictEqual(state.calendar, 0, 'no Calendar work during creation');
  respond(ctx.phone, '5');
  assert.strictEqual(state.calendar, 0, 'no Calendar work while waiting');
  assert.strictEqual(strippedSourceOf('Application/PatientDisruptionService.js').indexOf('CalendarRepository'), -1,
    'M4-F has no Calendar dependency at all — all Calendar work is delegated');
});

test('M4F-30 — an original-appointment race causes a safe refusal, never a cross-mutation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  const before = Object.assign({}, slotById(ctx.original.slot_id));
  // The original slot is re-assigned to a different patient while the
  // proposal waits: a genuine ownership race on the original appointment.
  slotById(ctx.original.slot_id).phone = '9647809999999';

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.failureCode, 'M4F_STALE_ORIGINAL');
  assert.strictEqual(state.changeCalls.length, 0, 'no cross-appointment mutation');
  const after = slotById(ctx.original.slot_id);
  assert.strictEqual(after.status, before.status, 'M4-F does not mutate the raced original');
  assert.strictEqual(after.phone, '9647809999999', 'the foreign ownership is left untouched');
});

test('M4F-31 — a candidate race causes a controlled refusal', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  // Someone else took the proposal target while the patient was deciding.
  slotById(ctx.candidate.slot_id).phone = '9647809999999';

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.failureCode, 'M4F_STALE_CANDIDATE');
  assert.strictEqual(state.changeCalls.length, 0);
  assert.strictEqual(slotById(ctx.candidate.slot_id).phone, '9647809999999', 'no mutation of a foreign slot');
});

test('M4F-32 — a partial Calendar failure preserves the recovery-required outcome', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  state.changeNotChanged = true;
  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.data.recoveryRequired, true, 'recovery need is explicit, not a silent success');
  assert.strictEqual(conversationOf(ctx.phone).state, 'WAITING_DISRUPTION_CONFIRMATION',
    'pending disruption is cleared only after a durable outcome');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED');
});

// ═════════════════════════════════════════════════════════════════════════
// F — RESERVED final mutation
// ═════════════════════════════════════════════════════════════════════════

test('M4F-33 — no B6 / confirmed-change boundary is used while waiting on a RESERVED proposal', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  assert.strictEqual(state.changeCalls.length, 0, 'creation needs no B6');
  respond(ctx.phone, '3');
  assert.strictEqual(state.changeCalls.length, 0, 'waiting needs no B6');
});

test('M4F-34 — the target reaches CONFIRMED through the existing ConfirmReservation semantics', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.ok, true);
  assert.strictEqual(state.bookingCalls.length, 1, 'the existing finalization seam is used');
  assert.strictEqual(state.bookingCalls[0].slotId, ctx.candidate.slot_id);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'CONFIRMED');
  assert.strictEqual(slotById(ctx.candidate.slot_id).calendar_event_id, 'EVT_1', 'Calendar proof persisted');
});

test('M4F-35 — confirming a RESERVED proposal frees the original and leaves exactly one CONFIRMED', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.originalReleased, true);
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'FREE', 'original reservation released');
  assert.strictEqual(slotById(ctx.original.slot_id).phone, '');
  assert.strictEqual(confirmedCountFor(ctx.phone), 1, 'exactly one confirmed appointment');
  assert.strictEqual(reservedCountFor(ctx.phone), 0, 'no leftover hold');
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED');
});

test('M4F-36 — no Calendar mutation happens in the RESERVED path before confirmation', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  assert.strictEqual(state.calendar, 0, 'proposal creation performs no Calendar work');
  respond(ctx.phone, '2'); // decline
  assert.strictEqual(state.calendar, 0, 'decline performs no Calendar work');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE');
});

// ═════════════════════════════════════════════════════════════════════════
// G — Scheduler / architecture
// ═════════════════════════════════════════════════════════════════════════

test('M4F-37 — the existing single Scheduler gained one disruption stage, no second trigger', function() {
  const scheduler = strippedSourceOf('Scheduler.js');
  assert.ok(scheduler.indexOf('PatientDisruptionService.processDisruptions') !== -1,
    'the disruption stage lives in the existing Scheduler');
  // Archive → Maintenance → Horizon → Disruption → Reminders → HealthCheck
  const order = ['ArchiveService.run', 'MaintenanceService.run', 'AvailabilityHorizonMaintainer.ensureHorizon',
                 'PatientDisruptionService.processDisruptions', 'ReminderService.processPendingReminders',
                 'HealthCheckService.run'];
  let cursor = -1;
  order.forEach(function(token) {
    const at = scheduler.indexOf(token, cursor + 1);
    assert.ok(at > cursor, token + ' must appear in the documented stage order');
    cursor = at;
  });
  assert.ok(strippedSourceOf('Application/PatientDisruptionService.js').indexOf('ScriptApp.newTrigger') === -1);
});

test('M4F-38 — no global booking freeze: the lock is never held across WhatsApp I/O', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');

  let lockDuringSend = null;
  runStage({
    sendFn: function(phone, text) {
      lockDuringSend = state.lockHeld;
      state.sends.push({ phone: phone, text: text });
      return sandbox.Result.ok({ phone: phone });
    }
  });

  assert.strictEqual(lockDuringSend, false, 'notification must happen outside the serialization lock');
  assert.strictEqual(state.lockHeld, false, 'lock released after the stage');
});

test('M4F-39 — no second selector / state machine / conversation engine / gateway', function() {
  const src = strippedSourceOf('Application/PatientDisruptionService.js');
  ['SlotSelection.findEarliestWithinHorizon', 'SlotRepository.atomicUpdate', 'ConversationRepository.']
    .forEach(function(token) {
      assert.ok(src.indexOf(token) !== -1, 'M4-F must reuse ' + token);
    });
  ['new SlotSelection', 'new StateMachine', 'new Scheduler', 'new ConversationRepository',
   'UrlFetchApp', 'WhatsAppAdapter'].forEach(function(token) {
    assert.strictEqual(src.indexOf(token), -1, 'M4-F must not introduce ' + token);
  });
});

test('M4F-40 — no schedule recomputation inside M4-F', function() {
  const src = strippedSourceOf('Application/PatientDisruptionService.js');
  ['EffectiveScheduleService', 'ScheduleChangeRepository', 'DoctorScheduleCommandService']
    .forEach(function(token) {
      assert.strictEqual(src.indexOf(token), -1, 'M4-F must not read/recompute schedule intent: ' + token);
    });
});

test('M4F-41 — M4-F never mutates is_available', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  const before = state.sheets.Availability.rows.map(function(r) { return String(r.is_available); });

  runStage();
  respond(ctx.phone, '1');

  const after = state.sheets.Availability.rows.map(function(r) { return String(r.is_available); });
  assert.deepStrictEqual(after, before, 'is_available belongs to M4-D only');
  assert.strictEqual(strippedSourceOf('Application/PatientDisruptionService.js').indexOf('is_available:'), -1,
    'the service never writes is_available');
});

// ═════════════════════════════════════════════════════════════════════════
// H — Debt closure / governance
// ═════════════════════════════════════════════════════════════════════════

test('M4F-42 — TD-01: atomicUpdate distinguishes a read failure from a missing row', function() {
  resetAll();
  const slot = seedSlot({ slot_id: 'SLT_TD01', status: 'FREE' });
  state.failRead.Availability = true;

  const result = sandbox.SlotRepository.atomicUpdate(slot.slot_id, function() {
    return sandbox.Result.ok({ status: 'RESERVED' });
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'SLOT_READ_FAILED',
    'a storage failure must never masquerade as SLOT_NOT_FOUND');
});

test('M4F-43 — TD-02: M4-F source reads the current time only through Clock', function() {
  const src = strippedSourceOf('Application/PatientDisruptionService.js');
  assert.strictEqual(/\bnew Date\(\s*\)/.test(src), false, 'no bare new Date()');
  assert.strictEqual(/Date\.now\s*\(/.test(src), false, 'no Date.now()');
  assert.ok(src.indexOf('Clock.now()') !== -1, 'Clock.now() is the time source');
});

test('M4F-44 — TD-03: governance documents record the current post-M4-E baseline', function() {
  const context = sourceOf('PROJECT_CONTEXT.md');
  assert.ok(context.indexOf('62654b73bf01aae818794429a2adc2c71d28fb30') !== -1,
    'current main TD-gate baseline is recorded');
  assert.ok(context.indexOf('Technical Debt Remediation Gate') !== -1, 'debt gate is recorded');
  assert.ok(context.indexOf('CLOSED / MERGED (PR #23') !== -1,
    'the gate closure supersedes the stale "pending closure" wording');
  const constitution = sourceOf('PROJECT_CONSTITUTION.txt');
  assert.ok(constitution.indexOf('62654b73bf01aae818794429a2adc2c71d28fb30') !== -1,
    'the constitution records the authorized M4-F baseline');
});

test('M4F-45 — TD-04: the M4-D acceptance mapping drift is corrected in place', function() {
  const mapping = sourceOf('docs/M4/M4D_ACCEPTANCE_MAPPING.md');
  assert.ok(mapping.indexOf('2.1') !== -1, 'reconciled mapping version present');
  assert.ok(mapping.indexOf('TD-04') !== -1, 'TD-04 reconciliation is documented');
});

test('M4F-46 — TD-05: repository layout debt is recorded and out of M4-F scope', function() {
  const context = sourceOf('PROJECT_CONTEXT.md');
  assert.ok(context.indexOf('TD-05') !== -1, 'TD-05 is recorded');
  assert.ok(context.indexOf('CLOSED') !== -1, 'TD-05 is closed for M4-F design purposes');
});

test('M4F-47 — TD-06: the temporary time model is retained consistently', function() {
  const src = strippedSourceOf('Application/PatientDisruptionService.js');
  assert.ok(src.indexOf('LegacySlotTimeParser.toComparableTime') !== -1,
    'M4-F uses the canonical sort_key → LegacySlotTimeParser interpretation');
  ['formatSortKey =', 'new DateParser', 'moment('].forEach(function(token) {
    assert.strictEqual(src.indexOf(token), -1, 'no second time representation: ' + token);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// I — Regression / quality
// ═════════════════════════════════════════════════════════════════════════

const CHANGED_FILES = [
  'Application/PatientDisruptionService.js',
  'Application/BookingService.js',
  'Changeservice.js',
  'Config.js',
  'ConversationRepository.js',
  'Core/Router.js',
  'Scheduler.js',
  'Slotselection.js',
  'Utils/IdGenerator.js',
  'tests/HardeningB5.test.js',
  'tests/HardeningM4F.test.js',
  // Governance reconciliation files authorized by Contract §14
  // ("governance documentation files for TD-02 through TD-06").
  'PROJECT_CONTEXT.md',
  'PROJECT_CONSTITUTION.txt'
];

test('M4F-48 — full hardening regression: PASS except the pre-existing HardeningM1B / M1B-X3', function() {
  const files = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(function(f) { return /^Hardening.*\.test\.js$/.test(f) && f !== 'HardeningM4F.test.js'; })
    .sort();

  const failed = [];
  files.forEach(function(f) {
    try {
      execFileSync(process.execPath, [path.join('tests', f)], { cwd: ROOT, stdio: 'pipe' });
    } catch (e) {
      const out = String(e.stdout || '') + String(e.stderr || '');
      const matches = out.match(/FAIL: .*/g) || [];
      matches.forEach(function(m) { failed.push(f + ' :: ' + m.trim()); });
      if (!matches.length) failed.push(f + ' :: SUITE_ERROR');
    }
  });

  assert.deepStrictEqual(failed, ['HardeningM1B.test.js :: FAIL: M1B-X3 — clasp alphabetical evaluation-order independence (call-time bindings), full stack'],
    'regression must be PASS except the documented pre-existing HardeningM1B / M1B-X3');
});

test('M4F-49 — node --check passes for every changed JavaScript file', function() {
  CHANGED_FILES.filter(function(f) { return f.endsWith('.js'); }).forEach(function(f) {
    execFileSync(process.execPath, ['--check', f], { cwd: ROOT, stdio: 'pipe' });
  });
  assert.ok(true);
});

test('M4F-50 — forbidden dependency / mutation scans pass', function() {
  const src = strippedSourceOf('Application/PatientDisruptionService.js');
  ['SpreadsheetApp', 'UrlFetchApp', 'CalendarApp', 'LockService', 'PropertiesService', 'GmailApp']
    .forEach(function(token) {
      assert.strictEqual(src.indexOf(token), -1, 'Application must not touch infrastructure: ' + token);
    });
});

const BASELINE = '62654b73bf01aae818794429a2adc2c71d28fb30';

test('M4F-51 — only authorized files were changed on this branch', function() {
  // Union of committed-vs-baseline and working-tree changes, so the guard
  // holds whether or not the owner has committed the work yet.
  const committed = execFileSync('git', ['diff', '--name-only', BASELINE, 'HEAD'],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').map(function(l) { return l.trim(); });
  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map(function(l) { return l.trim(); })
    .filter(Boolean)
    .map(function(l) { return l.split(/\s+/).slice(1).join(' ').trim(); });

  const changed = committed.concat(porcelain)
    .filter(Boolean)
    .filter(function(v, i, arr) { return arr.indexOf(v) === i; });

  changed.forEach(function(f) {
    assert.ok(CHANGED_FILES.indexOf(f) !== -1, 'unauthorized file change: ' + f);
  });
  assert.ok(changed.length > 0, 'the M4-F change set must be present');
});

test('M4F-52 — no CI success claim is made without CI evidence', function() {
  // There is no CI configuration in this repository; nothing can be claimed green.
  assert.strictEqual(fs.existsSync(path.join(ROOT, '.github')), false,
    'no CI evidence exists — no CI success may be claimed');
});

test('M4F-53 — no production/deployment claim without deployment evidence', function() {
  assert.strictEqual(fs.existsSync(path.join(ROOT, '.clasp.json')), false,
    'no Apps Script deployment configuration is present in the repository');
});

// ═════════════════════════════════════════════════════════════════════════
// Additional criteria (Closure Addendum §14) — M4F-54..64
// ═════════════════════════════════════════════════════════════════════════

test('M4F-54 — the branch derives from the verified TD-gate merge baseline', function() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  // The addendum requires the branch to descend from the TD-gate merge; once
  // the M4-F work is committed, HEAD is the M4-F commit itself, so ancestry
  // — not equality — is the correct assertion.
  execFileSync('git', ['merge-base', '--is-ancestor', BASELINE, head], { cwd: ROOT });
  const subject = execFileSync('git', ['log', '-1', '--pretty=%s', BASELINE],
    { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.ok(/^Merge pull request #23/.test(subject),
    'the baseline is the Technical-Debt-Gate merge required by the addendum: ' + subject);

  // NOTE: ancestry against the M4-E planning baseline aff21006… cannot be
  // verified in this working clone — its history is shallow and that commit
  // is not present. The addendum itself designates 62654b73… as the
  // authoritative implementation baseline, which is asserted above.
});

test('M4F-55 — required M4-F Conversation columns are schema-checked and fail closed', function() {
  resetAll();
  happyPath('CONFIRMED');
  // Drop a required column, as an unprovisioned Conversations sheet would.
  state.sheets.Conversations.headers = state.sheets.Conversations.headers.filter(function(h) {
    return h !== 'disruption_proposal_id';
  });

  const session = sandbox.ConversationRepository.getDisruptionSession('9647800000000');
  assert.strictEqual(session.ok, false);
  assert.strictEqual(session.error.code, 'M4F_SCHEMA_MISSING');

  const stage = runStage();
  assert.strictEqual(stage.ok, false, 'the stage fails closed instead of writing an unreadable proposal');
  assert.strictEqual(reservedCountFor('9647800000000'), 0, 'no reservation is left behind');
});

test('M4F-56 — reservation + persistence failure triggers cleanup and explicit recovery reporting', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');

  // Let the candidate reservation succeed, then fail the Conversation write …
  state.interleaveHook = function(row) {
    if (row.slot_id === ctx.candidate.slot_id) state.failWrite = true;
  };

  const result = runStage();

  assert.strictEqual(result.ok, true, 'a row-level failure is reported, not fatal');
  assert.strictEqual(result.data.created.length, 0);
  const failureCodes = result.data.failures.map(function(f) { return f.code; });
  assert.ok(failureCodes.indexOf('M4F_PROPOSAL_PERSIST_FAILED') !== -1 ||
            failureCodes.indexOf('M4F_PROPOSAL_CLEANUP_REQUIRED') !== -1,
    'explicit persistence/cleanup outcome: ' + JSON.stringify(failureCodes));
  assert.strictEqual(state.sends.length, 0, 'the patient is never told about a non-durable proposal');
});

test('M4F-57 — the notification lifecycle is durably bounded (PENDING → SENT / FAILED)', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');

  // Observe the PENDING state before the send result is recorded.
  let statusAtSend = null;
  runStage({
    sendFn: function(phone, text) {
      statusAtSend = conversationOf(phone).disruption_notification_status;
      state.sends.push({ phone: phone, text: text });
      return sandbox.Result.ok({ phone: phone });
    }
  });

  assert.strictEqual(statusAtSend, 'PENDING', 'proposal is persisted with a bounded PENDING state');
  assert.strictEqual(conversationOf(ctx.phone).disruption_notification_status, 'SENT');
});

test('M4F-58 — duplicate Scheduler processing cannot create a second reservation/proposal', function() {
  resetAll();
  happyPath('CONFIRMED');

  runStage();
  runStage();
  runStage();

  assert.strictEqual(reservedCountFor('9647800000000'), 1);
  assert.strictEqual(state.sends.length, 1, 'a SENT proposal is never re-notified');
  assert.strictEqual(conversationOf('9647800000000').state, 'WAITING_DISRUPTION_CONFIRMATION');
});

test('M4F-59 — an inbound response cannot cross the reservation→persistence window', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');

  // Simulate an inbound patient message arriving immediately AFTER the
  // candidate was reserved but BEFORE the proposal was persisted.
  state.interleaveHook = function() {
    respond(ctx.phone, '1');
  };

  const result = runStage();

  assert.strictEqual(result.ok, true);
  // Invariants after the interleaving: at most one proposal, no orphan hold,
  // and a conversation state consistent with the durable proposal.
  const conv = conversationOf(ctx.phone);
  assert.ok(conversationOf(ctx.phone), 'conversation exists');
  const reserved = reservedCountFor(ctx.phone);
  assert.ok(reserved <= 1, 'at most one reservation for the phone');
  assert.strictEqual(state.changeCalls.length, 0,
    'the inbound message could not finalize a proposal that was not yet durable');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'CONFIRMED', 'original never mutated');
  if (conv.state === 'WAITING_DISRUPTION_CONFIRMATION') {
    assert.strictEqual(reserved, 1, 'a persisted proposal is backed by its reservation');
    assert.ok(conv.disruption_proposal_id, 'proposal identity is durable');
  } else {
    assert.strictEqual(reserved, 0, 'a refused proposal leaves no orphan reservation');
  }
});

test('M4F-60 — confirming a RESERVED disruption frees the original and yields one confirmed outcome', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.confirmed, true);
  assert.strictEqual(confirmedCountFor(ctx.phone), 1);
  assert.strictEqual(reservedCountFor(ctx.phone), 0);
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'FREE');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'CONFIRMED');
});

test('M4F-61 — RESERVED confirmation performs Calendar creation only through the existing seam', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  assert.strictEqual(state.calendar, 0);
  respond(ctx.phone, '1');

  assert.strictEqual(state.calendar, 1, 'Calendar is created once, after confirmation');
  assert.strictEqual(state.bookingCalls.length, 1, 'and only via the existing finalization seam');
  assert.strictEqual(slotById(ctx.candidate.slot_id).calendar_event_id, 'EVT_1');
});

test('M4F-62 — decline/timeout does not mutate the original appointment lifecycle', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  const before = Object.assign({}, slotById(ctx.original.slot_id));
  respond(ctx.phone, '2');

  const after = slotById(ctx.original.slot_id);
  assert.strictEqual(after.status, before.status, 'original stays CONFIRMED');
  assert.strictEqual(after.phone, before.phone);
  assert.strictEqual(after.calendar_event_id, before.calendar_event_id, 'no Calendar change');
  assert.strictEqual(state.changeCalls.length, 0);
});

test('M4F-63 — notification retry reuses the same proposal identity and never re-reserves', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  state.sendShouldFail = true;
  runStage();

  const proposalId = conversationOf(ctx.phone).disruption_proposal_id;
  const reservationStamp = slotById(ctx.candidate.slot_id).reserved_until_unix;

  state.sendShouldFail = false;
  const second = runStage();

  assert.strictEqual(second.data.skipped[0].notification.proposalId, proposalId, 'same proposal identity');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, proposalId);
  assert.strictEqual(slotById(ctx.candidate.slot_id).reserved_until_unix, reservationStamp,
    'the reservation was not re-created');
  assert.strictEqual(reservedCountFor(ctx.phone), 1);
});

test('M4F-64 — uncertain notification bookkeeping is retry uncertainty, not a new proposal', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');

  // Simulate a crash between persistence and status bookkeeping.
  state.interleaveHook = null;
  runStage();
  conversationOf(ctx.phone).disruption_notification_status = 'PENDING';
  const proposalId = conversationOf(ctx.phone).disruption_proposal_id;
  state.sends = [];

  const second = runStage();

  assert.strictEqual(second.data.created.length, 0, 'PENDING never authorizes a second proposal');
  assert.strictEqual(second.data.skipped[0].reason, 'M4F_PENDING_PROPOSAL_EXISTS');
  assert.strictEqual(second.data.skipped[0].notification.retried, true);
  assert.strictEqual(second.data.skipped[0].notification.proposalId, proposalId);
  assert.strictEqual(reservedCountFor(ctx.phone), 1, 'still exactly one reservation');
});

// ═════════════════════════════════════════════════════════════════════════

let failures = 0;
tests.forEach(function(t, i) {
  try {
    t.fn();
    console.log('PASS: ' + t.name);
  } catch (e) {
    failures += 1;
    console.log('FAIL: ' + t.name);
    console.log('    ' + (e && e.message ? e.message : String(e)));
  }
});

console.log('');
console.log((tests.length - failures) + '/' + tests.length + ' tests passed');
if (failures) process.exitCode = 1;
