'use strict';

/**
 * HardeningM4F.test.js — M4-F Patient Disruption / Recovery
 *
 * Contract: HAMZAWE_M4F_FROZEN_CONTRACT_v1_2026-09-03.md
 *           + HAMZAWE_M4F_CONTRACT_CLOSURE_ADDENDUM_v1.1_2026-09-03.md
 *
 * Acceptance mapping — M4F-01..105 (including Round 2 and post-merge hardening).
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
    failReadSlotId: null,
    readHook: null,
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
    writeHook: null,
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
      // Generic read hook: fired BEFORE the row is returned, so a test can
      // model a concurrent decision becoming visible at the exact instant a
      // sweep reads (round 2, P2).
      if (state.readHook) state.readHook(name, column, value);
      if (name === 'Availability' && state.failReadSlotId &&
          column === 'slot_id' && String(value) === String(state.failReadSlotId)) {
        throw new Error('INJECTED_READ_FAILURE: slot ' + value);
      }
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
          // Generic write hook: invoked immediately AFTER the write is
          // committed, so a test can inject an interleaving or a failure at
          // the exact point between two M4-F steps (findings #1 and #2).
          if (state.writeHook) state.writeHook(name, rows[i], fields);
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
  state.failReadSlotId = null;
  state.readHook = null;
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
  state.writeHook = null;
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
  // Post-merge test-hygiene fix: keep TD01-E4 structural assertion compatible
  // with equivalent safe formatting of the legacy catch block.
  'tests/HardeningTD01.test.js',
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
    if (f.indexOf('M4G') !== -1 || f.indexOf('HardeningM4G') !== -1) return;
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

  // Let the candidate reservation commit, then fail every later write …
  state.writeHook = function(name, row, fields) {
    if (name === 'Availability' && row.slot_id === ctx.candidate.slot_id &&
        fields.status === 'RESERVED') {
      state.writeHook = null;
      state.failWrite = true;
    }
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
  state.writeHook = function(name, row, fields) {
    if (name === 'Availability' && row.slot_id === ctx.candidate.slot_id &&
        fields.status === 'RESERVED') {
      state.writeHook = null;
      respond(ctx.phone, '1');
    }
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
// SUPERVISOR REVIEW (PR #24) — proof tests for findings #1..#15
// ═════════════════════════════════════════════════════════════════════════

/** Fail every write that happens after the confirmation seam has finished. */
function failAfterConfirmation(candidateSlotId) {
  state.writeHook = function(name, row, fields) {
    if (name === 'Availability' && row.slot_id === candidateSlotId && fields.calendar_event_id) {
      state.writeHook = null;
      state.failWrite = true;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Finding #1 — RESERVED confirmation: original release failure
// ─────────────────────────────────────────────────────────────────────────

test('M4F-65 — [F1] original release failure ⇒ M4F_RECOVERY_REQUIRED, never a clean success', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  failAfterConfirmation(ctx.candidate.slot_id);
  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.recoveryRequired, true, 'recovery is surfaced, not hidden');
  const conv = conversationOf(ctx.phone);
  assert.strictEqual(conv.state, 'WAITING_DISRUPTION_CONFIRMATION',
    'pending interaction is NOT cleared — the unresolved original stays visible');
  assert.strictEqual(conv.disruption_proposal_id !== '', true, 'ownership evidence preserved');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'CONFIRMED', 'target is confirmed');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'RESERVED', 'original is still held');
  assert.strictEqual(confirmedCountFor(ctx.phone), 1);
  assert.strictEqual(reservedCountFor(ctx.phone), 1, 'two active bookings — must be classified');
});

test('M4F-104 — [Post-merge P1] decline cannot erase recovery evidence after target confirmation', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  failAfterConfirmation(ctx.candidate.slot_id);
  const confirm = respond(ctx.phone, '1');
  assert.strictEqual(confirm.data.recoveryRequired, true);
  state.failWrite = false;

  // The patient may send a decline before the next Scheduler recovery sweep.
  // The target is already CONFIRMED while the original is still RESERVED.
  const decline = respond(ctx.phone, '2');

  assert.strictEqual(decline.ok, true, 'the inbound boundary converts recovery-required into a safe patient reply');
  assert.strictEqual(decline.data.recoveryRequired, true, 'cleanup must not hide an interrupted finalization');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'CONFIRMED');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'RESERVED');
  assert.strictEqual(conversationOf(ctx.phone).state, 'WAITING_DISRUPTION_CONFIRMATION');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id !== '', true,
    'recovery evidence remains durable');
});

test('M4F-105 — [Post-merge P1] timeout cannot erase recovery evidence after target confirmation', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  failAfterConfirmation(ctx.candidate.slot_id);
  respond(ctx.phone, '1');
  state.failWrite = false;

  const proposal = conversationOf(ctx.phone);
  state.nowIso = new Date(Number(proposal.disruption_expires_at_ms) + 60000).toISOString();

  const expired = SVC._expire(ctx.phone, {
    disruption_proposal_id: proposal.disruption_proposal_id,
    disruption_original_slot_id: proposal.disruption_original_slot_id,
    disruption_proposal_slot_id: proposal.disruption_proposal_slot_id,
    disruption_kind: proposal.disruption_kind,
    disruption_expires_at_ms: proposal.disruption_expires_at_ms
  }, new Date(state.nowIso));

  assert.strictEqual(expired.ok, false);
  assert.strictEqual(expired.error.code, 'M4F_RECOVERY_REQUIRED');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'CONFIRMED');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'RESERVED');
  assert.strictEqual(conversationOf(ctx.phone).state, 'WAITING_DISRUPTION_CONFIRMATION');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id !== '', true);
});

test('M4F-66 — [F1] the recovery sweep completes the release on a later run', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();
  failAfterConfirmation(ctx.candidate.slot_id);
  respond(ctx.phone, '1');
  state.failWrite = false;

  const result = runStage();

  assert.strictEqual(result.data.recovered.length, 1);
  assert.strictEqual(result.data.recovered[0].outcome, 'RELEASED_AND_CLEARED');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'FREE', 'original released');
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED');
  assert.strictEqual(confirmedCountFor(ctx.phone), 1, 'exactly one active appointment');
  assert.strictEqual(reservedCountFor(ctx.phone), 0, 'no leftover hold');
});

test('M4F-67 — [F1] an original released between revalidation and release is not a failure', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  // A genuine race: the original hold expires and Maintenance frees it after
  // revalidation but before M4-F attempts the release. Nothing is owned by
  // the proposal any more, so this is a clean outcome, not a failure.
  state.writeHook = function(name, row, fields) {
    if (name === 'Availability' && row.slot_id === ctx.candidate.slot_id &&
        fields.status === 'CONFIRMED') {
      state.writeHook = null;
      const original = slotById(ctx.original.slot_id);
      original.status = 'FREE';
      original.phone = '';
    }
  };

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.confirmed, true);
  assert.strictEqual(reply.data.originalReleased, false);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'CONFIRMED');
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED');
  assert.strictEqual(confirmedCountFor(ctx.phone), 1);
});

test('M4F-68 — [F1] the patient is never told "success" while the case is unresolved', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();
  failAfterConfirmation(ctx.candidate.slot_id);

  const reply = respond(ctx.phone, '1');

  assert.ok(reply.data.reply.indexOf('بحاجة إلى معالجة') !== -1,
    'reply states the unresolved item: ' + reply.data.reply);
  assert.strictEqual(reply.data.confirmed, undefined, 'confirmed is not claimed');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #2 — M4F-59: real interleaving at the reserve→persist window
// ─────────────────────────────────────────────────────────────────────────

/** Run the stage with an inbound message injected exactly at the window. */
function runWithInterleave(ctx, message) {
  state.writeHook = function(name, row, fields) {
    if (name === 'Availability' && row.slot_id === ctx.candidate.slot_id &&
        fields.status === 'RESERVED') {
      state.writeHook = null;
      state.interleaved = respond(ctx.phone, message);
    }
  };
  const result = runStage();
  return { result: result, interleaved: state.interleaved };
}

test('M4F-69 — [F2] inbound CONFIRMATION inside the window cannot finalize a non-durable proposal', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  const out = runWithInterleave(ctx, '1');

  assert.strictEqual(state.changeCalls.length, 0, 'no finalization of a proposal that was not yet durable');
  assert.strictEqual(reservedCountFor(ctx.phone) <= 1, true, 'at most one reservation');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'CONFIRMED', 'original never mutated');
  const conv = conversationOf(ctx.phone);
  if (conv.state === 'WAITING_DISRUPTION_CONFIRMATION') {
    assert.strictEqual(reservedCountFor(ctx.phone), 1, 'a persisted proposal is backed by its reservation');
    assert.ok(conv.disruption_proposal_id);
  } else {
    assert.strictEqual(reservedCountFor(ctx.phone), 0, 'a refused proposal leaves no orphan');
  }
  assert.strictEqual(out.result.ok, true);
});

test('M4F-70 — [F2] inbound DECLINE inside the window cannot release a proposal that is not yet durable', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runWithInterleave(ctx, '2');

  const conv = conversationOf(ctx.phone);
  assert.strictEqual(conv.state, 'WAITING_DISRUPTION_CONFIRMATION',
    'the proposal still persists — the interleaved decline did not corrupt it');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED', 'candidate still owned by the proposal');
  assert.strictEqual(slotById(ctx.candidate.slot_id).phone, ctx.phone);
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'CONFIRMED');
});

test('M4F-71 — [F2] an arbitrary inbound message inside the window performs no mutation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  const before = Object.assign({}, slotById(ctx.original.slot_id));
  runWithInterleave(ctx, 'مرحبا');

  assert.strictEqual(slotById(ctx.original.slot_id).status, before.status);
  assert.strictEqual(slotById(ctx.original.slot_id).phone, before.phone);
  assert.strictEqual(state.changeCalls.length, 0);
  assert.strictEqual(conversationOf(ctx.phone).state, 'WAITING_DISRUPTION_CONFIRMATION');
});

test('M4F-72 — [F2] a legitimate change to the original inside the window makes Phase 3 refuse', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  // Another process legitimately cancelled the original at the exact window.
  state.writeHook = function(name, row, fields) {
    if (name === 'Availability' && row.slot_id === ctx.candidate.slot_id &&
        fields.status === 'RESERVED') {
      state.writeHook = null;
      const original = slotById(ctx.original.slot_id);
      original.status = 'FREE';
      original.phone = '';
    }
  };

  const result = runStage();

  assert.strictEqual(result.data.created.length, 0, 'Phase 3 does not persist over a legitimate change');
  const codes = result.data.failures.map(function(f) { return f.code; });
  assert.ok(codes.indexOf('M4F_STALE_ORIGINAL') !== -1, 'refusal is explicit: ' + JSON.stringify(codes));
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED', 'no proposal was persisted');
});

test('M4F-73 — [F2] the candidate is never left orphaned when the Phase-3 guard refuses', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  state.writeHook = function(name, row, fields) {
    if (name === 'Availability' && row.slot_id === ctx.candidate.slot_id &&
        fields.status === 'RESERVED') {
      state.writeHook = null;
      slotById(ctx.original.slot_id).status = 'FREE';
      slotById(ctx.original.slot_id).phone = '';
    }
  };

  runStage();

  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE', 'candidate released');
  assert.strictEqual(slotById(ctx.candidate.slot_id).phone, '', 'candidate has no orphaned owner');
  assert.strictEqual(reservedCountFor(ctx.phone), 0, 'no orphaned reservation');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #3 — full final-confirmation semantics (real BookingService)
// ─────────────────────────────────────────────────────────────────────────

function createBookingSandbox() {
  const sb = vm.createContext({ console: console });
  const st = { sheets: {}, logs: [], calendar: 0, lockHeld: false, nowIso: EVAL_ISO };

  function sheet(n) { if (!st.sheets[n]) st.sheets[n] = { headers: [], rows: [] }; return st.sheets[n]; }
  sb.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sb.Utilities = {
    formatDate: function(d, tz, fmt) {
      if (d instanceof Date) return fmt === 'yyyy-MM-dd' ? d.toISOString().slice(0, 10) : String(d);
      // Sheets returns Date cells; string seeds are a harness artefact.
      const x = new Date(String(d).replace(/\//g, '-'));
      return fmt === 'yyyy-MM-dd' ? x.toISOString().slice(0, 10) : String(d);
    }
  };
  sb.GoogleSheets = {
    getAllRows: function(n) { return sheet(n).rows.map(function(r) { return Object.assign({}, r); }); },
    queryRows: function(n, p) { return sb.GoogleSheets.getAllRows(n).filter(p); },
    getHeaders: function(n) { return sheet(n).headers.slice(); },
    findRowByColumn: function(n, c, v) {
      const r = sheet(n).rows.find(function(x) { return String(x[c]) === String(v); });
      return r ? Object.assign({}, r) : null;
    },
    appendRow: function(n, rec) {
      const s = sheet(n); const row = {};
      s.headers.forEach(function(h) { row[h] = rec[h] === undefined ? '' : rec[h]; });
      s.rows.push(row); return true;
    },
    updateRowByColumn: function(n, c, v, f) {
      const row = sheet(n).rows.find(function(x) { return String(x[c]) === String(v); });
      if (!row) return false;
      Object.keys(f).forEach(function(k) { row[k] = f[k]; });
      return true;
    }
  };
  sb.GoogleCalendar = { createEvent: function() { st.calendar += 1; return 'EVT_' + st.calendar; } };
  sb.LockService = {
    getScriptLock: function() {
      return { waitLock: function() { if (st.lockHeld) throw new Error('LOCK'); st.lockHeld = true; },
               releaseLock: function() { st.lockHeld = false; } };
    },
    getUserLock: function() { return sb.LockService.getScriptLock(); }
  };
  sb.PropertiesService = { getScriptProperties: function() { return { getProperty: function() { return null; }, setProperty: function() {} }; } };
  sb.SettingsRepository = { getSlotDurationMinutes: function() { return 30; } };
  sb.BusNumberCalculator = { fromSlot: function() { return { ok: true, data: { busNumber: 3 } }; } };
  sb.LogRepository = { write: function(e) { st.logs.push(e); return true; } };

  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sb, { filename: rel });
  }
  ['Result.js:Result', 'Config.js:Config', 'Clock.js:Clock', 'Utils/ULID.js:ULID',
   'Utils/IdGenerator.js:IdGenerator', 'Utils/DateUtils.js:DateUtils',
   'Utils/LegacySlotTimeParser.js:LegacySlotTimeParser', 'Utils/PhoneUtils.js:PhoneUtils',
   'StateMachine.js:StateMachine', 'Domain/Validators.js:Validators',
   'Infrastructure/Lock.js:Lock', 'Repositories/SlotRepository.js:SlotRepository',
   'Repositories/CalendarRepository.js:CalendarRepository',
   'ConversationRepository.js:ConversationRepository',
   'Application/CommandExecutor.js:CommandExecutor',
   'Application/BookingService.js:BookingService'
  ].forEach(function(p) { const parts = p.split(':'); load(parts[0], parts[1]); });
  sb.Clock.now = function() { return new Date(st.nowIso); };
  return { sb: sb, st: st };
}

test('M4F-74 — [F3] ordinary booking confirmation is behaviourally unchanged by the extraction', function() {
  const env = createBookingSandbox();
  const sb = env.sb, st = env.st;
  sb.sheets = st.sheets;
  st.sheets.Availability = { headers: AVAILABILITY_HEADERS.slice(), rows: [] };
  st.sheets.Conversations = { headers: CONVERSATION_HEADERS.slice(), rows: [] };
  st.sheets.Availability.rows.push({
    slot_id: 'SLT_ORD', date: '2026/09/05', time: '11:00', sort_key: '202609051100',
    status: 'RESERVED', is_available: true, patient_name: 'مريض عادي', phone: '9647800001111',
    calendar_event_id: '', reserved_until: '', reserved_until_unix: String(EVAL_MS + 5 * 60000)
  });
  st.sheets.Conversations.rows.push({
    conversation_id: 'CONV_ORD', phone: '9647800001111', state: 'WAITING_CONFIRMATION',
    temp_name: 'مريض عادي', slot_id: 'SLT_ORD', updated_at: ''
  });

  const reply = sb.BookingService.handleIncomingMessage('9647800001111', '1');
  const slot = st.sheets.Availability.rows[0];

  assert.strictEqual(reply.ok, true);
  assert.strictEqual(slot.status, 'CONFIRMED', 'RESERVED → CONFIRMED');
  assert.strictEqual(slot.calendar_event_id, 'EVT_1', 'Calendar event created and persisted');
  assert.strictEqual(st.calendar, 1);
  assert.strictEqual(st.sheets.Conversations.rows[0].state, 'BOOKED');
  assert.ok(/تم تأكيد حجزك بنجاح/.test(reply.data.reply), 'reply text unchanged');
  assert.ok(/رقم الباص: 3/.test(reply.data.reply), 'bus number presentation unchanged');
});

test('M4F-75 — [F3] ordinary booking: a non-confirmation message is unchanged', function() {
  const env = createBookingSandbox();
  const sb = env.sb, st = env.st;
  st.sheets.Availability = { headers: AVAILABILITY_HEADERS.slice(), rows: [] };
  st.sheets.Conversations = { headers: CONVERSATION_HEADERS.slice(), rows: [] };
  st.sheets.Availability.rows.push({
    slot_id: 'SLT_ORD2', date: '2026/09/05', time: '11:00', sort_key: '202609051100',
    status: 'RESERVED', is_available: true, patient_name: 'مريض', phone: '9647800002222',
    calendar_event_id: '', reserved_until: '', reserved_until_unix: String(EVAL_MS + 5 * 60000)
  });
  st.sheets.Conversations.rows.push({
    conversation_id: 'CONV_2', phone: '9647800002222', state: 'WAITING_CONFIRMATION',
    temp_name: 'مريض', slot_id: 'SLT_ORD2', updated_at: ''
  });
  sb.sheets = st.sheets;

  const reply = sb.BookingService.handleIncomingMessage('9647800002222', 'مرحبا');

  assert.strictEqual(reply.data.conversationState, 'WAITING_CONFIRMATION');
  assert.strictEqual(st.sheets.Availability.rows[0].status, 'RESERVED', 'no mutation');
  assert.strictEqual(st.calendar, 0);
});

test('M4F-76 — [F3] M4-F RESERVED confirmation orders the seam before the original release', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();

  const order = [];
  state.writeHook = function(name, row, fields) {
    if (name === 'Availability') {
      if (fields.status === 'CONFIRMED') order.push('target-confirmed');
      if (fields.status === 'FREE' && row.slot_id === ctx.original.slot_id) order.push('original-released');
    }
  };

  const reply = respond(ctx.phone, '1');

  assert.deepStrictEqual(order, ['target-confirmed', 'original-released'],
    'the target is secured before the original is released (Addendum §7)');
  assert.strictEqual(reply.data.confirmed, true);
  assert.strictEqual(confirmedCountFor(ctx.phone), 1);
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED');
});

test('M4F-77 — [F3] failure injection at target confirmation leaves the original untouched', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();
  const originalBefore = Object.assign({}, slotById(ctx.original.slot_id));
  state.confirmShouldFail = true;

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.failureCode, 'M4F_LIFECYCLE_MUTATION_FAILED');
  assert.strictEqual(slotById(ctx.original.slot_id).status, originalBefore.status);
  assert.strictEqual(slotById(ctx.original.slot_id).phone, originalBefore.phone);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED', 'target hold retained');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #4 — original is_available at final confirmation
// ─────────────────────────────────────────────────────────────────────────

test('M4F-78 — [F4] RESOLUTION: original is_available IS re-checked freshly at confirmation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();
  // The clinic session reopened while the patient was deciding.
  slotById(ctx.original.slot_id).is_available = true;

  const reply = respond(ctx.phone, '1');

  assert.strictEqual(reply.data.failureCode, 'M4F_STALE_ORIGINAL',
    'the disruption no longer exists — no silent, unnecessary move (Contract §1/§6.4)');
  assert.strictEqual(state.changeCalls.length, 0);
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED', 'proposal kept, not orphaned');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #5 — no-alternative notification semantics
// ─────────────────────────────────────────────────────────────────────────

test('M4F-79 — [F5] no-alternative creates no reservation, no proposal and no appointment mutation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  slotById('SLT_M4F_002').is_available = false;
  slotById('SLT_M4F_003').sort_key = '202609201000';
  const originalBefore = Object.assign({}, slotById(ctx.original.slot_id));

  const first = runStage();
  const second = runStage();

  assert.strictEqual(first.data.noAlternative.length, 1);
  assert.strictEqual(second.data.noAlternative.length, 1, 're-notified on a later run (v1 accepted)');
  assert.strictEqual(first.data.created.length, 0);
  assert.strictEqual(second.data.created.length, 0, 'never a duplicate proposal');
  assert.strictEqual(reservedCountFor(ctx.phone), 0, 'no reservation');
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED', 'interaction unchanged');
  const after = slotById(ctx.original.slot_id);
  assert.strictEqual(after.status, originalBefore.status, 'no appointment mutation');
  assert.strictEqual(after.calendar_event_id, originalBefore.calendar_event_id);
  assert.strictEqual(state.changeCalls.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #6 — proposal expiry inside the same Scheduler run
// ─────────────────────────────────────────────────────────────────────────

test('M4F-80 — [F6] an expired proposal is not re-offered in the same run', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();
  const firstId = conversationOf(ctx.phone).disruption_proposal_id;

  state.nowIso = new Date(EVAL_MS + 31 * 60000).toISOString();
  const result = runStage();

  assert.strictEqual(result.data.expired.length, 1);
  assert.strictEqual(result.data.created.length, 0, 'no immediate re-offer in the same run');
  const skipReasons = result.data.skipped.map(function(s) { return s.reason; });
  assert.ok(skipReasons.indexOf('PROPOSAL_EXPIRED_THIS_RUN') !== -1, JSON.stringify(skipReasons));
  assert.notStrictEqual(conversationOf(ctx.phone).disruption_proposal_id, firstId);
});

test('M4F-81 — [F6] the next run creates a NEW proposal identity, never reusing the old one', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();
  const firstId = conversationOf(ctx.phone).disruption_proposal_id;

  state.nowIso = new Date(EVAL_MS + 31 * 60000).toISOString();
  runStage(); // expires + clears

  state.nowIso = new Date(EVAL_MS + 62 * 60000).toISOString();
  const result = runStage();

  assert.strictEqual(result.data.created.length, 1, 'a later run may propose again (Contract §8)');
  const newId = result.data.created[0].proposalId;
  assert.notStrictEqual(newId, firstId, 'the proposal identity is never reused');
  assert.ok(/^DSP_/.test(newId));
  assert.strictEqual(reservedCountFor(ctx.phone), 1);
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #7 — ChangeService status extension
// ─────────────────────────────────────────────────────────────────────────

test('M4F-82 — [F7] the status extension is additive and preserves existing consumers', function() {
  const change = strippedSourceOf('Changeservice.js');
  const router = strippedSourceOf('Core/Router.js');

  assert.ok(change.indexOf("status: 'CHANGED'") !== -1, 'typed success status');
  assert.ok(change.indexOf("status: 'FAILED'") !== -1, 'typed failure status');
  // Existing consumers read reply / conversationState only.
  assert.strictEqual(/\.status\b/.test(router.replace(/conversationState/g, '')), false,
    'the Router does not consume a change result status');
  // The failure path keeps its reply semantics.
  assert.ok(change.indexOf('تعذّر تغيير موعدك حاليًا') !== -1, 'patient reply text unchanged');
  // M4-F consumes the typed status, never reply text.
  const svc = strippedSourceOf('Application/PatientDisruptionService.js');
  assert.ok(svc.indexOf("change.data.status !== 'CHANGED'") !== -1, 'M4-F uses the structured status');
  assert.strictEqual(/Result\.ok\(\{\s*success:/.test(svc), false, 'no Result.ok({success:false}) anti-pattern');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #8 — BookingService extraction must remain surgical
// ─────────────────────────────────────────────────────────────────────────

test('M4F-83 — [F8] the extraction added no duplicated or new business semantics', function() {
  const src = strippedSourceOf('Application/BookingService.js');

  // Calendar creation exists exactly once — no duplication between the
  // ordinary path and the extracted seam.
  const occurrences = src.split('CalendarRepository.createAppointmentEvent').length - 1;
  assert.strictEqual(occurrences, 1, 'Calendar creation is not duplicated');

  // The seam keeps the original command boundary and transition.
  assert.ok(src.indexOf('confirmReservedSlot(phone, slotId)') !== -1, 'the seam exists');
  assert.ok(src.indexOf('BookingService.confirmReservedSlot(phone, slotId)') !== -1,
    'the ordinary path delegates to the seam');
  assert.ok(src.indexOf('Config.VOCABULARY.COMMANDS.CONFIRM_RESERVATION') !== -1,
    'the command boundary is preserved');

  // The confirmation body is no longer inlined in the handler.
  const handler = src.slice(src.indexOf('_handleWaitingConfirmation('), src.indexOf('_handleBooked()'));
  assert.strictEqual(handler.indexOf('CalendarRepository'), -1,
    'the handler no longer duplicates the Calendar logic');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #9 — Scheduler stage failure semantics
// ─────────────────────────────────────────────────────────────────────────

function createSchedulerSandbox() {
  const sb = vm.createContext({ console: console });
  const st = { lockCalls: [], lockHeld: false, logEntries: [], props: {}, stageCalls: [], stageResults: {} };

  sb.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
  sb.Utilities = { formatDate: function() { return ''; } };
  sb.LockService = {
    getUserLock: function() {
      st.lockCalls.push('user');
      return {
        waitLock: function() { st.lockHeld = true; },
        releaseLock: function() { st.lockHeld = false; }
      };
    },
    getScriptLock: function() {
      return { waitLock: function() {}, releaseLock: function() {} };
    }
  };
  sb.PropertiesService = {
    getScriptProperties: function() {
      return {
        getProperty: function(k) { return st.props[k] || null; },
        setProperty: function(k, v) { st.props[k] = v; }
      };
    }
  };
  sb.LogRepository = { write: function(e) { st.logEntries.push(e); return true; } };

  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sb, { filename: rel });
  }
  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('Clock.js', 'Clock');
  load('Infrastructure/Lock.js', 'Lock');
  load('Scheduler.js', 'Scheduler');

  st.stageResults = {
    archive: sb.Result.ok({ archived: 0 }),
    maintenance: sb.Result.ok({ cleaned: 0 }),
    horizon: sb.Result.ok({ generated: 0 }),
    disruption: sb.Result.ok({ created: [] }),
    reminders: sb.Result.ok({ sent: 0 }),
    healthCheck: sb.Result.ok({ healthy: true, issues: [], warnings: [] })
  };
  sb.ArchiveService = { run: function() { st.stageCalls.push('archive'); return st.stageResults.archive; } };
  sb.MaintenanceService = { run: function() { st.stageCalls.push('maintenance'); return st.stageResults.maintenance; } };
  sb.AvailabilityHorizonMaintainer = { ensureHorizon: function() { st.stageCalls.push('horizon'); return st.stageResults.horizon; } };
  sb.PatientDisruptionService = { processDisruptions: function() { st.stageCalls.push('disruption'); return st.stageResults.disruption; } };
  sb.ReminderService = { processPendingReminders: function() { st.stageCalls.push('reminders'); return st.stageResults.reminders; } };
  sb.HealthCheckService = { run: function() { st.stageCalls.push('healthCheck'); return st.stageResults.healthCheck; } };
  sb.WhatsAppAdapter = { sendMessage: function() { return sb.Result.ok({}); } };

  return { sb: sb, st: st };
}

test('M4F-84 — [F9] a disruption stage failure is reported, never fabricated as success', function() {
  const env = createSchedulerSandbox();
  env.st.stageResults.disruption = env.sb.Result.fail('M4F_SCHEMA_MISSING', 'schema not provisioned');

  const result = env.sb.Scheduler.main();

  assert.strictEqual(result.ok, false, 'the run does not claim success');
  assert.strictEqual(result.error.code, 'SCHEDULER_PARTIAL_FAILURE');
  assert.strictEqual(result.error.details.stages.disruption, 'FAILED', 'the stage is reported accurately');
  assert.deepStrictEqual(env.st.stageCalls,
    ['archive', 'maintenance', 'horizon', 'disruption', 'reminders', 'healthCheck'],
    'later stages still run per the existing partial-failure pattern');
  assert.strictEqual(env.st.props.LAST_SCHEDULER_SUCCESS_MS, undefined,
    'liveness is not updated on a failed operational run');
  const logged = env.st.logEntries.filter(function(e) { return e.command === 'SCHEDULER_STAGE_FAILED'; });
  assert.strictEqual(logged.length, 1, 'the failure is observable');
  assert.ok(logged[0].error.indexOf('disruption') !== -1);
});

test('M4F-85 — [F9] a healthy disruption stage keeps the run green and updates liveness', function() {
  const env = createSchedulerSandbox();
  const result = env.sb.Scheduler.main();

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.stages.disruption, 'OK');
  assert.ok(env.st.props.LAST_SCHEDULER_SUCCESS_MS, 'liveness updated');
  assert.strictEqual(env.st.lockHeld, false, 'the orchestration lock is released');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #10 — schema prerequisite
// ─────────────────────────────────────────────────────────────────────────

test('M4F-86 — [F10] schema absence is typed, blocks partial proposals and never migrates', function() {
  resetAll();
  happyPath('CONFIRMED');
  const headers = state.sheets.Conversations.headers.slice();
  state.sheets.Conversations.headers = headers.filter(function(h) {
    return h !== 'disruption_expires_at_ms';
  });

  const session = sandbox.ConversationRepository.getDisruptionSession('9647800000000');
  assert.strictEqual(session.ok, false);
  assert.strictEqual(session.error.code, 'M4F_SCHEMA_MISSING', 'typed schema failure');
  assert.ok(session.error.message.indexOf('disruption_expires_at_ms') !== -1, 'the missing column is named');

  const before = state.sheets.Conversations.rows.length;
  const stage = runStage();

  assert.strictEqual(stage.ok, false, 'the Scheduler is not told "no affected appointments"');
  assert.strictEqual(stage.error.code, 'M4F_SCHEMA_MISSING');
  assert.strictEqual(state.sheets.Conversations.rows.length, before, 'no partial proposal written');
  assert.strictEqual(state.sheets.Conversations.headers.length, headers.length - 1,
    'no automatic migration — the sheet was not altered');
  assert.strictEqual(reservedCountFor('9647800000000'), 0, 'no reservation left behind');
  assert.strictEqual(state.sends.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #11 — fresh reads / stale evidence audit
// ─────────────────────────────────────────────────────────────────────────

test('M4F-87 — [F11] every final mutation re-reads proposal, original, target and Clock', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  // Stale target: the proposal would otherwise confirm a slot it no longer owns.
  slotById(ctx.candidate.slot_id).status = 'RESERVED';
  slotById(ctx.candidate.slot_id).phone = '9647809999999';
  let reply = respond(ctx.phone, '1');
  assert.strictEqual(reply.data.failureCode, 'M4F_STALE_CANDIDATE', 'fresh target read');

  // Stale proposal identity: the durable proposal current at mutation time no
  // longer matches the proposal this decision was taken against.
  resetAll();
  const ctx2 = happyPath('CONFIRMED');
  runStage();
  const current = Object.assign({}, conversationOf(ctx2.phone));
  const proposal = {
    disruption_proposal_id: 'DSP_SUPERSEDED',
    disruption_original_slot_id: current.disruption_original_slot_id,
    disruption_proposal_slot_id: current.disruption_proposal_slot_id,
    disruption_kind: current.disruption_kind,
    disruption_expires_at_ms: current.disruption_expires_at_ms
  };
  const stale = SVC._revalidateForConfirmation(ctx2.phone, proposal, sandbox.Clock.now());
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error.code, 'M4F_CONFLICTING_ACTION', 'fresh proposal read');

  // Clock: expiry is evaluated from the current instant, not creation time.
  resetAll();
  const ctx3 = happyPath('CONFIRMED');
  runStage();
  state.nowIso = new Date(EVAL_MS + 31 * 60000).toISOString();
  reply = respond(ctx3.phone, '1');
  assert.strictEqual(reply.data.expired, true, 'fresh Clock.now() read');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #12 — ownership checks on every cleanup path
// ─────────────────────────────────────────────────────────────────────────

test('M4F-88 — [F12] decline does not modify a slot that is no longer owned by the proposal', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();
  slotById(ctx.candidate.slot_id).phone = '9647809999999';
  const before = Object.assign({}, slotById(ctx.candidate.slot_id));

  const reply = respond(ctx.phone, '2');

  // The cleanup itself still succeeds — the pending interaction must never
  // outlive its proposal — but the release is ownership-checked and therefore
  // classified rather than performed. No silent success claiming a move.
  assert.strictEqual(reply.data.declined, true);
  assert.strictEqual(reply.data.released, false, 'nothing was released');
  assert.strictEqual(reply.data.releaseReason, 'NOT_OWNED_BY_PROPOSAL', 'classified, not a silent success');

  const after = slotById(ctx.candidate.slot_id);
  assert.strictEqual(after.status, before.status, 'unrelated slot untouched');
  assert.strictEqual(after.phone, '9647809999999', 'foreign ownership preserved');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, '', 'pending cleared');
});

test('M4F-89 — [F12] timeout does not modify a slot that is no longer owned by the proposal', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();
  slotById(ctx.candidate.slot_id).phone = '9647809999999';
  const before = Object.assign({}, slotById(ctx.candidate.slot_id));

  state.nowIso = new Date(EVAL_MS + 31 * 60000).toISOString();
  const result = runStage();

  const after = slotById(ctx.candidate.slot_id);
  assert.strictEqual(after.status, before.status, 'unrelated slot untouched on timeout');
  assert.strictEqual(after.phone, '9647809999999');
  assert.strictEqual(result.data.expired.length, 1, 'the interaction is still cleared');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, '');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #13 — logs are diagnostics only
// ─────────────────────────────────────────────────────────────────────────

test('M4F-90 — [F13] logs are write-only diagnostics and never a state source', function() {
  const src = strippedSourceOf('Application/PatientDisruptionService.js');
  const usages = src.match(/LogRepository\.\w+/g) || [];
  assert.ok(usages.length > 0, 'the service emits diagnostics');
  usages.forEach(function(u) {
    assert.strictEqual(u, 'LogRepository.write', 'log usage must be write-only: ' + u);
  });
  assert.strictEqual(/LogRepository\.read|getAllRows\('SYSTEM_LOG'\)|queryRows\('SYSTEM_LOG'/.test(src), false,
    'no decision may be rebuilt from the log');
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #14 — PII boundary
// ─────────────────────────────────────────────────────────────────────────

test('M4F-91 — [F14] the durable proposal carries no PII, transcript or Calendar identifier', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();
  const conv = conversationOf(ctx.phone);
  const fields = sandbox.ConversationRepository.DISRUPTION_FIELDS;

  // Compared as a sorted string: the array is created in the vm realm, so
  // deepStrictEqual against a host-realm literal is unreliable.
  assert.strictEqual(Array.prototype.slice.call(fields).sort().join(','), [
    'disruption_created_at_ms', 'disruption_expires_at_ms', 'disruption_kind',
    'disruption_notification_status', 'disruption_original_slot_id',
    'disruption_proposal_id', 'disruption_proposal_slot_id'
  ].join(','), 'the schema is exactly the bounded seven');

  fields.forEach(function(f) {
    assert.strictEqual(/phone|name|transcript|calendar/i.test(f), false, 'no PII field: ' + f);
    const value = String(conv[f]);
    assert.strictEqual(value.indexOf('مريض'), -1, 'no patient name stored in ' + f);
  });

  // Diagnostic payloads must not carry patient names either.
  const payloads = JSON.stringify(state.logs.map(function(l) { return l.error; }));
  assert.strictEqual(payloads.indexOf('مريض'), -1, 'no patient name in diagnostics');

  // M4-E evidence stays PII-free.
  const item = sandbox.AffectedAppointmentDiscoveryService.discoverAffected({
    from: EVAL_MS, to: EVAL_MS + 3 * 86400000
  }).data.affected[0];
  ['phone', 'patient_name', 'calendar_event_id'].forEach(function(k) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(item, k), false, 'M4-E DTO has no ' + k);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Finding #15 — cohesion / no duplicated ownership
// ─────────────────────────────────────────────────────────────────────────

test('M4F-92 — [F15] the service owns no duplicated boundary (ownership, not line count)', function() {
  const src = strippedSourceOf('Application/PatientDisruptionService.js');
  const forbidden = [
    ['Calendar semantics', 'CalendarRepository'],
    ['Calendar semantics', 'GoogleCalendar'],
    ['persistence', 'GoogleSheets'],
    ['lifecycle', 'StateMachine.transitions'],
    ['lifecycle', 'insertBatch'],
    ['selector', 'function findEarliest'],
    ['schedule truth', 'EffectiveScheduleService'],
    ['schedule intent', 'ScheduleChangeRepository'],
    ['conversation engine', 'startNew('],
    ['scheduler', 'ScriptApp.newTrigger']
  ];
  forbidden.forEach(function(pair) {
    assert.strictEqual(src.indexOf(pair[1]), -1, 'M4-F must not own ' + pair[0] + ' (' + pair[1] + ')');
  });
  // …and it must delegate to the real owners.
  ['SlotSelection.findEarliestWithinHorizon', 'SlotRepository.atomicUpdate',
   'ConversationRepository.', 'ChangeService.changeConfirmedAppointment',
   'BookingService.confirmReservedSlot'].forEach(function(token) {
    assert.ok(src.indexOf(token) !== -1, 'must reuse the existing boundary: ' + token);
  });
});


// ═════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════
// ROUND 2 — decline/timeout cleanup semantics (P1)
// ═════════════════════════════════════════════════════════════════════════

test('M4F-93 — [R2-P1] decline still frees the target when the original reopened', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  // M4-D / schedule-change recovery made the original available again. The
  // disruption that justified the proposal no longer exists — but the
  // reserved target must still be releasable by the patient.
  const original = slotById(ctx.original.slot_id);
  original.is_available = true;
  const before = Object.assign({}, original);

  const reply = respond(ctx.phone, '2');

  assert.strictEqual(reply.data.declined, true, 'the patient can still decline');
  assert.strictEqual(reply.data.released, true, 'the reserved target is freed');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE', 'target freed');
  assert.strictEqual(slotById(ctx.candidate.slot_id).phone, '', 'target ownership released');

  const after = slotById(ctx.original.slot_id);
  assert.strictEqual(after.status, before.status, 'original status untouched');
  assert.strictEqual(after.phone, before.phone, 'original ownership untouched');
  assert.strictEqual(after.is_available, true, 'original availability untouched');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, '', 'pending cleared');
  assert.strictEqual(reservedCountFor(ctx.phone), 0, 'no leaked reservation');
  assert.strictEqual(confirmedCountFor(ctx.phone), 1, 'exactly one active appointment');
});

test('M4F-94 — [R2-P1] decline still cleans up when the original changed or was cancelled', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  // The original left the proposal's expected lifecycle entirely.
  slotById(ctx.original.slot_id).status = 'CANCELLED';
  const before = Object.assign({}, slotById(ctx.original.slot_id));

  const reply = respond(ctx.phone, '2');

  assert.strictEqual(reply.data.declined, true);
  assert.strictEqual(reply.data.released, true, 'target freed');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE');

  const after = slotById(ctx.original.slot_id);
  assert.strictEqual(after.status, before.status, 'no cross-appointment mutation');
  assert.strictEqual(after.phone, before.phone, 'foreign slot untouched');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, '', 'pending cleared');
  assert.strictEqual(reservedCountFor(ctx.phone), 0);
});

test('M4F-95 — [R2-P1] one state, two semantics: confirmation refuses, decline cleans up', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  slotById(ctx.original.slot_id).is_available = true;

  // The split is proven by the SAME durable state producing two different,
  // each contract-correct, outcomes.
  const confirm = respond(ctx.phone, '1');
  assert.strictEqual(confirm.data.failureCode, 'M4F_STALE_ORIGINAL',
    'confirmation still refuses: moving is now unnecessary');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED', 'confirmation mutated nothing');

  const decline = respond(ctx.phone, '2');
  assert.strictEqual(decline.data.declined, true, 'cleanup is not gated on the original');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE', 'target freed by the decline');
  assert.strictEqual(slotById(ctx.original.slot_id).is_available, true, 'original still untouched');
});

test('M4F-96 — [R2-P1] cleanup revalidation still guards the proposal identity', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  const current = Object.assign({}, conversationOf(ctx.phone));
  const stale = {
    disruption_proposal_id: 'DSP_SUPERSEDED',
    disruption_original_slot_id: current.disruption_original_slot_id,
    disruption_proposal_slot_id: current.disruption_proposal_slot_id,
    disruption_kind: current.disruption_kind,
    disruption_expires_at_ms: current.disruption_expires_at_ms
  };

  const result = SVC._decline(ctx.phone, stale);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'M4F_CONFLICTING_ACTION', 'identity is still enforced');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'RESERVED', 'no mutation on a stale decision');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, current.disruption_proposal_id,
    'the current interaction was not cleared');
});

test('M4F-97 — [R2-P1] decline is a cleanup, not an expiry decision: it never consults the clock', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  runStage();

  const proposal = {
    disruption_proposal_id: conversationOf(ctx.phone).disruption_proposal_id,
    disruption_original_slot_id: conversationOf(ctx.phone).disruption_original_slot_id,
    disruption_proposal_slot_id: conversationOf(ctx.phone).disruption_proposal_slot_id,
    disruption_kind: conversationOf(ctx.phone).disruption_kind,
    disruption_expires_at_ms: conversationOf(ctx.phone).disruption_expires_at_ms
  };

  // Well past the 30-minute window.
  state.nowIso = new Date(EVAL_MS + 90 * 60000).toISOString();

  const result = SVC._decline(ctx.phone, proposal);

  assert.strictEqual(result.ok, true, 'an expired proposal is still cleaned up');
  assert.strictEqual(result.data.released, true, 'release, never keep');
  assert.strictEqual(slotById(ctx.candidate.slot_id).status, 'FREE');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, '', 'pending cleared');
});

// ═════════════════════════════════════════════════════════════════════════
// ROUND 2 — recovery sweep vs concurrent inbound confirmation (P2)
// ═════════════════════════════════════════════════════════════════════════

test('M4F-98 — [R2-P2] a stale sweep never clears a newer interaction', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();
  failAfterConfirmation(ctx.candidate.slot_id);
  respond(ctx.phone, '1');
  state.failWrite = false;

  // A partially completed confirmation. While the sweep releases the original
  // (phase B, outside the lock), a concurrent inbound decision replaces the
  // interaction with a NEWER proposal.
  let injected = false;
  state.writeHook = function(name, row, fields) {
    if (injected) return;
    if (name === 'Availability' && row.slot_id === ctx.original.slot_id && fields.status === 'FREE') {
      injected = true;
      state.writeHook = null;
      conversationOf(ctx.phone).disruption_proposal_id = 'DSP_NEWER';
    }
  };

  const result = runStage();

  assert.strictEqual(injected, true, 'the interleaving actually happened at the release');
  assert.strictEqual(result.data.recovered.length, 1);
  assert.strictEqual(result.data.recovered[0].outcome, 'STALE_SWEEP_ABORTED',
    'the sweep abandoned the clear');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, 'DSP_NEWER',
    'the newer interaction survived');
  assert.strictEqual(conversationOf(ctx.phone).state, 'WAITING_DISRUPTION_CONFIRMATION',
    'the newer interaction was not erased');
});

test('M4F-99 — [R2-P2] the sweep skips a phone whose interaction already moved on', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();
  failAfterConfirmation(ctx.candidate.slot_id);
  respond(ctx.phone, '1');
  state.failWrite = false;

  // The sweep enumerates the pending rows, and at the instant it performs its
  // fresh per-phone read the interaction has already been replaced by a newer
  // proposal. Its enumerated snapshot is therefore stale.
  let injected = false;
  state.readHook = function(name) {
    if (injected) return;
    if (name === 'Conversations') {
      injected = true;
      state.readHook = null;
      conversationOf(ctx.phone).disruption_proposal_id = 'DSP_NEWER';
    }
  };

  const result = runStage();

  assert.strictEqual(injected, true, 'the concurrent change landed at the sweep read');
  assert.strictEqual(result.data.recovered.length, 0, 'nothing decided from a stale snapshot');
  assert.strictEqual(slotById(ctx.original.slot_id).status, 'RESERVED', 'the sweep mutated nothing');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, 'DSP_NEWER', 'newer interaction intact');
});

test('M4F-100 — [R2-P2] the sweep still converges when the original was released concurrently', function() {
  resetAll();
  const ctx = happyPath('RESERVED');
  runStage();
  failAfterConfirmation(ctx.candidate.slot_id);
  respond(ctx.phone, '1');
  state.failWrite = false;

  // A concurrent path already released the original hold.
  const original = slotById(ctx.original.slot_id);
  original.status = 'FREE';
  original.phone = '';

  const result = runStage();

  assert.strictEqual(result.data.recovered.length, 1);
  assert.strictEqual(result.data.recovered[0].outcome, 'CLEARED', 'interaction finalized only');
  assert.strictEqual(conversationOf(ctx.phone).state, 'BOOKED', 'pending cleared');
  assert.strictEqual(confirmedCountFor(ctx.phone), 1);
  assert.strictEqual(reservedCountFor(ctx.phone), 0);
});

// ═════════════════════════════════════════════════════════════════════════
// ROUND 2 — notification retry requires a freshly verified target (P2)
// ═════════════════════════════════════════════════════════════════════════

test('M4F-101 — [R2-P2] a retry never sends when the target cannot be read', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  state.sendShouldFail = true;
  runStage();
  const proposalId = conversationOf(ctx.phone).disruption_proposal_id;

  state.sendShouldFail = false;
  state.sends.length = 0;
  state.failReadSlotId = ctx.candidate.slot_id;

  const result = runStage();
  const notification = result.data.skipped[0].notification;

  assert.strictEqual(notification.retried, false);
  assert.strictEqual(notification.reason, 'TARGET_READ_FAILED', 'classified for recovery');
  assert.strictEqual(notification.staleCandidate, true);
  assert.strictEqual(state.sends.length, 0, 'no notification was sent');
  assert.strictEqual(conversationOf(ctx.phone).disruption_proposal_id, proposalId,
    'the proposal is retained for recovery, not silently dropped');
});

test('M4F-102 — [R2-P2] a retry never sends when the target is no longer the proposal’s reservation', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  state.sendShouldFail = true;
  runStage();

  state.sendShouldFail = false;
  state.sends.length = 0;
  // Maintenance released the reserved target meanwhile.
  slotById(ctx.candidate.slot_id).status = 'FREE';
  slotById(ctx.candidate.slot_id).phone = '';

  const result = runStage();
  const notification = result.data.skipped[0].notification;

  assert.strictEqual(notification.retried, false);
  assert.strictEqual(notification.reason, 'STALE_CANDIDATE', 'classified, never notified');
  assert.strictEqual(notification.staleCandidate, true);
  assert.strictEqual(state.sends.length, 0, 'no truncated message reached the patient');
});

test('M4F-103 — [R2-P2] a verified target is retried with the same proposal identity', function() {
  resetAll();
  const ctx = happyPath('CONFIRMED');
  state.sendShouldFail = true;
  runStage();
  const proposalId = conversationOf(ctx.phone).disruption_proposal_id;

  state.sendShouldFail = false;
  state.sends.length = 0;

  const result = runStage();
  const notification = result.data.skipped[0].notification;

  assert.strictEqual(notification.retried, true, 'a verified reservation is retried');
  assert.strictEqual(notification.proposalId, proposalId, 'same proposal identity');
  assert.strictEqual(state.sends.length, 1, 'exactly one retry notification');
  assert.strictEqual(state.sends[0].text.indexOf('غير محدد'), -1,
    'the retry never offers an undefined slot');
  assert.strictEqual(reservedCountFor(ctx.phone), 1, 'no second reservation');
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
