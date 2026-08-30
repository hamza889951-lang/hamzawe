'use strict';

/**
 * HardeningM4A.test.js — M4-A (DOCTOR IDENTITY & AUTHORIZATION BOUNDARY)
 *
 * Proves the M4-A part of M4-DOCTOR-CONTROL-v1 over the REAL Router and
 * the new M4-A boundary:
 *
 *   Incoming actor
 *       → canonical phone (PhoneUtils.normalize)
 *       → DoctorAuthorizationService (fail-closed)
 *       → DoctorControlEntry (authorized doctor only)
 *       → existing patient flow (everyone else)
 *
 * The tests stub ONLY the patient-facing services (Booking/Change/Cancel)
 * so the existing routing table can be verified independently of booking
 * internals. The M4-A Application/Repository files are loaded from disk.
 *
 * Contract points proven:
 *   I — identity (known / unknown / normalized equivalents / empty /
 *        malformed)
 *   A — authorization (authorized / unauthorized / source unavailable /
 *        source read failure / fail-closed)
 *   R — routing (doctor enters control, patient preserved, unknown cannot
 *        gain doctor access)
 *   P — provider neutrality (message content does not affect identity;
 *        no UltraMsg/WhatsApp coupling)
 *   D — determinism (same actor → same identity/authorization result)
 *   B — boundary robustness (null/malformed context, null entry context)
 *   X — scope (read-only; no schedule/availability/appointment/calendar/)
 *   DR — duplicate/retry delivery (no new mutations)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const DOCTOR_PHONE = '9647001111111';
const PATIENT_PHONE = '9647001111112';
const OTHER_PHONE = '9647001111113';

function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ═══════════════════════════════════════════════════════════════
// Sandbox — real Router + real M4-A boundary over mocks
// ═══════════════════════════════════════════════════════════════

function createSandbox() {
  const sandbox = vm.createContext({ console: console });
  const state = {
    props: { DOCTOR_PHONE: DOCTOR_PHONE },
    identityReadFailure: false,
    conversationState: null,
    patientCalls: []
  };

  sandbox.PropertiesService = {
    getScriptProperties: function() {
      if (state.identityReadFailure) throw new Error('INJECTED_PROPERTIES_READ_FAILURE');
      return {
        getProperty: function(key) {
          return state.props[key] || '';
        }
      };
    }
  };

  function load(rel, name) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
  }

  load('Result.js', 'Result');
  load('Config.js', 'Config');
  load('StateMachine.js', 'StateMachine');
  load('Utils/PhoneUtils.js', 'PhoneUtils');
  load('Domain/Validators.js', 'Validators');
  load('Repositories/DoctorIdentityRepository.js', 'DoctorIdentityRepository');
  load('Application/DoctorAuthorizationService.js', 'DoctorAuthorizationService');
  load('Application/DoctorControlEntry.js', 'DoctorControlEntry');
  load('Core/Router.js', 'Router');

  // Patient-facing boundary stubs (kept intentionally small).
  sandbox.ConversationRepository = {
    findByPhone: function(phone) {
      return state.conversationState ? { state: state.conversationState } : null;
    }
  };
  sandbox.BookingService = {
    handleIncomingMessage: function(phone, message) {
      state.patientCalls.push({ kind: 'book', phone: phone, message: message });
      return sandbox.Result.ok({
        reply: 'PATIENT_BOOK_REPLY',
        conversationState: sandbox.Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
      });
    }
  };
  sandbox.ChangeService = {
    changeReservation: function(phone) {
      state.patientCalls.push({ kind: 'changeReservation', phone: phone });
      return sandbox.Result.ok({ reply: 'CHANGE_RESERVATION_REPLY', conversationState: 'WAITING_CONFIRMATION' });
    },
    changeConfirmedAppointment: function(phone) {
      state.patientCalls.push({ kind: 'changeConfirmed', phone: phone });
      return sandbox.Result.ok({ reply: 'CHANGE_CONFIRMED_REPLY', conversationState: 'BOOKED' });
    }
  };
  sandbox.CancelService = {
    cancelAppointment: function(phone) {
      state.patientCalls.push({ kind: 'cancel', phone: phone });
      return sandbox.Result.ok({ reply: 'CANCEL_REPLY', conversationState: 'MENU_MAIN' });
    }
  };

  return { sandbox: sandbox, state: state };
}

const core = createSandbox();
const sandbox = core.sandbox;
const state = core.state;

const DAS = sandbox.DoctorAuthorizationService;
const DCE = sandbox.DoctorControlEntry;
const Router = sandbox.Router;

function reset() {
  state.props = { DOCTOR_PHONE: DOCTOR_PHONE };
  state.identityReadFailure = false;
  state.conversationState = null;
  state.patientCalls = [];
}

function authorize(phone) {
  return DAS.authorizeDoctor(phone);
}

// ═══════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

// ─────────────────────────────────────────────────────────────
// IDENTITY
// ─────────────────────────────────────────────────────────────

test('M4A-I1 — known doctor authorizes with canonical actor context', function() {
  reset();
  const r = authorize(DOCTOR_PHONE);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.actorType, 'DOCTOR');
  assert.strictEqual(r.data.actorId, DOCTOR_PHONE);
  assert.strictEqual(r.data.authorized, true);
});

test('M4A-I2 — normalized equivalent phone formats all map to same identity', function() {
  reset();
  const formats = [
    DOCTOR_PHONE,
    '+' + DOCTOR_PHONE,
    DOCTOR_PHONE + '@c.us',
    ' + ' + DOCTOR_PHONE.slice(0, 3) + ' ' + DOCTOR_PHONE.slice(3) + ' '
  ];
  formats.forEach(function(raw) {
    const r = authorize(raw);
    assert.strictEqual(r.ok, true, 'failed for: ' + raw);
    assert.strictEqual(r.data.actorId, DOCTOR_PHONE);
  });
});

test('M4A-I3 — unknown phone is rejected without leaking doctor identity', function() {
  reset();
  const r = authorize(OTHER_PHONE);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'DOCTOR_UNAUTHORIZED');
  assert.strictEqual(r.data, null);
  // No doctor phone value is included in the failure payload.
  const payload = JSON.stringify(r.error);
  assert.strictEqual(payload.indexOf(DOCTOR_PHONE), -1);
});

test('M4A-I4 — empty phone fails as invalid actor identifier', function() {
  reset();
  const r = authorize('');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_ACTOR_IDENTIFIER');
});

test('M4A-I5 — malformed/short phone fails as invalid actor identifier', function() {
  reset();
  assert.strictEqual(authorize('123').error.code, 'INVALID_ACTOR_IDENTIFIER');
});

// ─────────────────────────────────────────────────────────────
// AUTHORIZATION
// ─────────────────────────────────────────────────────────────

test('M4A-A1 — authorized actor returns structured authorization context', function() {
  reset();
  const r = authorize(DOCTOR_PHONE);
  assert.strictEqual(r.ok, true);
  assert.ok(r.data.hasOwnProperty('actorType'));
  assert.ok(r.data.hasOwnProperty('actorId'));
  assert.ok(r.data.hasOwnProperty('scope'));
  assert.ok(r.data.hasOwnProperty('authorized'));
});

test('M4A-A2 — non-matching actor is unauthorized (DoctorAuthorizationService)', function() {
  reset();
  assert.strictEqual(authorize(PATIENT_PHONE).error.code, 'DOCTOR_UNAUTHORIZED');
});

test('M4A-A3 — identity source not configured -> unavailable, never authorized', function() {
  reset();
  state.props = {};
  const r = authorize(DOCTOR_PHONE);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'DOCTOR_IDENTITY_SOURCE_UNAVAILABLE');
});

test('M4A-A4 — identity source read failure -> unavailable, never authorized', function() {
  reset();
  state.identityReadFailure = true;
  const r = authorize(DOCTOR_PHONE);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'DOCTOR_IDENTITY_SOURCE_UNAVAILABLE');
});

test('M4A-A5 — ADMIN_PHONE alone does NOT grant doctor authorization', function() {
  reset();
  // Only the operations/notification destination is configured.
  state.props = { ADMIN_PHONE: DOCTOR_PHONE };
  assert.strictEqual(
    authorize(DOCTOR_PHONE).error.code,
    'DOCTOR_IDENTITY_SOURCE_UNAVAILABLE'
  );
  const r = Router.dispatch({ phone: DOCTOR_PHONE, message: '1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.hasOwnProperty('entryStatus'), false);
  assert.strictEqual(state.patientCalls.length, 1);
});

test('M4A-A6 — blank DOCTOR_PHONE fails closed', function() {
  reset();
  state.props = { DOCTOR_PHONE: '   ' };
  assert.strictEqual(
    authorize(DOCTOR_PHONE).error.code,
    'DOCTOR_IDENTITY_SOURCE_UNAVAILABLE'
  );
});

test('M4A-A7 — fail-closed through Router: source unavailable never reaches DoctorControlEntry', function() {
  reset();
  state.props = {};
  const r = Router.dispatch({ phone: DOCTOR_PHONE, message: '1' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.data.reply.indexOf('PATIENT_BOOK_REPLY') !== -1);
  assert.strictEqual(state.patientCalls.length, 1);
  assert.strictEqual(state.patientCalls[0].kind, 'book');
});

// ─────────────────────────────────────────────────────────────
// ROUTING
// ─────────────────────────────────────────────────────────────

test('M4A-R1 — authorized doctor enters DoctorControlEntry; patient flow is not invoked', function() {
  reset();
  const r = Router.dispatch({ phone: DOCTOR_PHONE, message: '1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.entryStatus, 'DOCTOR_CONTROL_ENTRY_ACCEPTED');
  assert.strictEqual(r.data.controlContext.actorId, DOCTOR_PHONE);
  assert.strictEqual(state.patientCalls.length, 0);
});

test('M4A-R2 — patient with no conversation continues to BookingService', function() {
  reset();
  const r = Router.dispatch({ phone: PATIENT_PHONE, message: 'hello' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.data.reply.indexOf('PATIENT_BOOK_REPLY') !== -1);
  assert.strictEqual(state.patientCalls.length, 1);
  assert.strictEqual(state.patientCalls[0].kind, 'book');
});

test('M4A-R3 — existing WAITING_CONFIRMATION + "2" still routes to changeReservation', function() {
  reset();
  state.conversationState = sandbox.Config.VOCABULARY.CONVERSATION_STATE.WAITING_CONFIRMATION;
  const r = Router.dispatch({ phone: PATIENT_PHONE, message: '2' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.patientCalls[0].kind, 'changeReservation');
});

test('M4A-R4 — existing BOOKED + "2" still routes to changeConfirmedAppointment', function() {
  reset();
  state.conversationState = sandbox.Config.VOCABULARY.CONVERSATION_STATE.BOOKED;
  const r = Router.dispatch({ phone: PATIENT_PHONE, message: '2' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.patientCalls[0].kind, 'changeConfirmed');
});

test('M4A-R5 — existing BOOKED + "3" still routes to cancelAppointment', function() {
  reset();
  state.conversationState = sandbox.Config.VOCABULARY.CONVERSATION_STATE.BOOKED;
  const r = Router.dispatch({ phone: PATIENT_PHONE, message: '3' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(state.patientCalls[0].kind, 'cancel');
});

test('M4A-R6 — unknown/unauthorized phone cannot gain doctor access through Router', function() {
  reset();
  const r = Router.dispatch({ phone: OTHER_PHONE, message: 'doctor' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.hasOwnProperty('entryStatus'), false);
  assert.strictEqual(state.patientCalls.length, 1);
  assert.strictEqual(state.patientCalls[0].kind, 'book');
});

// ─────────────────────────────────────────────────────────────
// PROVIDER NEUTRALITY
// ─────────────────────────────────────────────────────────────

test('M4A-P1 — message/provider payload does not change doctor identity or routing', function() {
  reset();
  const messages = ['1', 'doctor', 'schedule', '@fake-button', 'x123'];
  const results = messages.map(function(msg) {
    const r = Router.dispatch({ phone: DOCTOR_PHONE, message: msg });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.entryStatus, 'DOCTOR_CONTROL_ENTRY_ACCEPTED');
    return jsonClone(r);
  });
  results.forEach(function(r) {
    assert.strictEqual(r.data.controlContext.actorId, DOCTOR_PHONE);
  });
  // Every result has the same semantic shape (no provider-specific metadata).
  assert.deepStrictEqual(results[0], results[results.length - 1]);
});

test('M4A-P2 — provider-neutrality dependency scan: no UltraMsg/WhatsApp in M4-A boundaries', function() {
  const files = [
    'Application/DoctorAuthorizationService.js',
    'Application/DoctorControlEntry.js',
    'Repositories/DoctorIdentityRepository.js'
  ];
  const forbidden = [
    /WhatsAppAdapter/, /ultramsg|ultraMsg/i, /UrlFetchApp/,
    /GoogleCalendar/, /CalendarApp/, /GoogleSheets/, /SpreadsheetApp/,
    /SettingsRepository/, /Availability/i, /SlotRepository/,
    /AppointmentRepository/, /Reminder/i, /BookingService/, /ChangeService/, /CancelService/
  ];
  files.forEach(function(rel) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    forbidden.forEach(function(rx) {
      assert.strictEqual(rx.test(code), false, rel + ' must not reference ' + rx);
    });
  });
  // The repository is the ONLY M4-A file that may know PropertiesService.
  const appAuth = stripComments(fs.readFileSync(path.join(ROOT, 'Application/DoctorAuthorizationService.js'), 'utf8'));
  const entry = stripComments(fs.readFileSync(path.join(ROOT, 'Application/DoctorControlEntry.js'), 'utf8'));
  assert.strictEqual(/PropertiesService/.test(appAuth), false, 'AuthorizationService must not know PropertiesService');
  assert.strictEqual(/PropertiesService/.test(entry), false, 'ControlEntry must not know PropertiesService');
});

test('M4A-P3 — Router stays routing-only: no Sheets/Calendar/Provider/Settings dependency', function() {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'Core/Router.js'), 'utf8'));
  [
    /GoogleSheets/, /SpreadsheetApp/, /GoogleCalendar/, /CalendarApp/, /UrlFetchApp/,
    /WhatsAppAdapter/, /ultramsg|ultraMsg/i, /SettingsRepository/, /Availability/i,
    /SlotRepository/, /AppointmentRepository/, /Reminder/i
  ].forEach(function(rx) {
    assert.strictEqual(rx.test(code), false, 'Router must not reference ' + rx);
  });
  // The routing-only integration is explicit: doctor gate delegates to
  // the M4-A boundary and never implements authorization itself.
  assert.ok(/DoctorAuthorizationService/.test(code), 'Router must integrate DoctorAuthorizationService');
  assert.ok(/DoctorControlEntry/.test(code), 'Router must integrate DoctorControlEntry');
});

// ─────────────────────────────────────────────────────────────
// SCOPE / READ-ONLY
// ─────────────────────────────────────────────────────────────

test('M4A-X1 — scope representation is present and v1 implicit-single-clinic safe', function() {
  reset();
  const r = authorize(DOCTOR_PHONE);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.scope.clinicId, null);
});

test('M4A-X2 — M4-A Application writes nothing and owns no mutation repositories', function() {
  const files = [
    'Application/DoctorAuthorizationService.js',
    'Application/DoctorControlEntry.js'
  ];
  const forbidden = [
    /\.insert\s*\(/, /\.update\s*\(/, /\.setProperty\s*\(/,
    /appendRow|appendRows|updateRowByColumn|updateBatch|deleteRowsByNumbers/,
    /SpreadsheetApp/, /GoogleSheets/, /CalendarApp/, /GoogleCalendar/,
    /Lock\.runExclusive/, /CommandExecutor/
  ];
  files.forEach(function(rel) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    forbidden.forEach(function(rx) {
      assert.strictEqual(rx.test(code), false, rel + ' must not contain mutation seam ' + rx);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// DETERMINISM
// ─────────────────────────────────────────────────────────────

test('M4A-D1 — same actor input produces identical authorization result', function() {
  reset();
  const a = jsonClone(authorize(DOCTOR_PHONE));
  const b = jsonClone(authorize(DOCTOR_PHONE));
  const c = jsonClone(authorize(DOCTOR_PHONE));
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
});

// ─────────────────────────────────────────────────────────────
// BOUNDARY ROBUSTNESS
// ─────────────────────────────────────────────────────────────

test('M4A-B1 — null Router context fails cleanly (no throw)', function() {
  reset();
  let r;
  assert.doesNotThrow(function() { r = Router.dispatch(null); });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_CONTEXT');
});

test('M4A-B2 — malformed Router context (missing phone) fails cleanly', function() {
  reset();
  let r;
  assert.doesNotThrow(function() { r = Router.dispatch({ message: 'hello' }); });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'INVALID_CONTEXT');
});

test('M4A-B3 — DoctorControlEntry rejects null/unauthorized contexts', function() {
  reset();
  [null, {}, { actorId: DOCTOR_PHONE, authorized: false }, { actorId: DOCTOR_PHONE }].forEach(function(ctx) {
    const r = DCE.enter(ctx);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'DOCTOR_UNAUTHORIZED');
  });
});

// ─────────────────────────────────────────────────────────────
// DUPLICATE / RETRY DELIVERY
// ─────────────────────────────────────────────────────────────

test('M4A-DR1 — repeated identical delivery is deterministic and side-effect free', function() {
  reset();
  const r1 = jsonClone(Router.dispatch({ phone: DOCTOR_PHONE, message: '1' }));
  const r2 = jsonClone(Router.dispatch({ phone: DOCTOR_PHONE, message: '1' }));
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(state.patientCalls.length, 0);
  assert.strictEqual(r1.data.entryStatus, 'DOCTOR_CONTROL_ENTRY_ACCEPTED');
});

test('M4A-DR2 — no mutation call sites exist in the M4-A boundary', function() {
  const files = [
    'Application/DoctorAuthorizationService.js',
    'Application/DoctorControlEntry.js',
    'Repositories/DoctorIdentityRepository.js'
  ];
  files.forEach(function(rel) {
    const code = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.strictEqual(/CommandExecutor/.test(code), false, rel + ' must not run commands');
  });
});

// ── Runner ──────────────────────────────────────────────────────

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
