'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PHONE = '9647001111111';

const sandbox = vm.createContext({ console: console });

function load(relativePath, globalName) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  vm.runInContext(source + '\nthis.' + globalName + ' = ' + globalName + ';', sandbox, {
    filename: relativePath
  });
}

load('Result.js', 'Result');
load('Config.js', 'Config');

let slots = [];
let conversationState = sandbox.Config.VOCABULARY.CONVERSATION_STATE.BOOKED;
let resetCount = 0;
let bookingCalls = 0;
let changeCalls = 0;
let cancelCalls = 0;
let queryFailure = false;
let resetWriteFailure = false;

sandbox.SlotRepository = {
  queryResult: function(predicateFn) {
    if (queryFailure) {
      return sandbox.Result.fail('SLOT_READ_FAILED', 'injected Availability read failure');
    }
    return sandbox.Result.ok(slots.filter(predicateFn).map(function(slot) {
      return Object.assign({}, slot);
    }));
  }
};

sandbox.ConversationRepository = {
  findByPhone: function() {
    return { phone: PHONE, state: conversationState };
  },
  resetToMenuMain: function() {
    resetCount += 1;
    if (!resetWriteFailure) {
      conversationState = sandbox.Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN;
    }
  }
};

sandbox.PhoneUtils = {
  normalize: function(value) {
    return String(value).replace(/\D/g, '');
  }
};

sandbox.ChangeService = {
  changeConfirmedAppointment: function() {
    changeCalls += 1;
    return sandbox.Result.ok({ reply: 'CHANGE_DISPATCHED', conversationState: 'BOOKED' });
  },
  changeReservation: function() {
    return sandbox.Result.ok({ reply: 'PRECONFIRM_CHANGE_DISPATCHED', conversationState: 'WAITING_CONFIRMATION' });
  }
};

sandbox.CancelService = {
  cancelAppointment: function() {
    cancelCalls += 1;
    return sandbox.Result.ok({ reply: 'CANCEL_DISPATCHED', conversationState: 'MENU_MAIN' });
  }
};

sandbox.BookingService = {
  handleIncomingMessage: function() {
    bookingCalls += 1;
    return sandbox.Result.ok({ reply: 'BOOKING_DISPATCHED', conversationState: 'WAITING_NAME' });
  }
};

load('Application/ActiveAppointmentReconciliationService.js', 'ActiveAppointmentReconciliationService');
load('Core/Router.js', 'Router');

function reset() {
  slots = [];
  conversationState = sandbox.Config.VOCABULARY.CONVERSATION_STATE.BOOKED;
  resetCount = 0;
  bookingCalls = 0;
  changeCalls = 0;
  cancelCalls = 0;
  queryFailure = false;
  resetWriteFailure = false;
}

function addConfirmed(slotId) {
  slots.push({
    slot_id: slotId,
    phone: PHONE,
    status: sandbox.Config.VOCABULARY.STATUS.CONFIRMED
  });
}

function addTerminal(status) {
  slots.push({
    slot_id: 'TERMINAL_' + status,
    phone: PHONE,
    status: status
  });
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test('SBR-1 — one CONFIRMED appointment keeps BOOKED routing active', function() {
  reset();
  addConfirmed('ACTIVE');
  const result = sandbox.Router.dispatch({ phone: PHONE, message: '2' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.reply, 'CHANGE_DISPATCHED');
  assert.strictEqual(changeCalls, 1);
  assert.strictEqual(cancelCalls, 0);
  assert.strictEqual(bookingCalls, 0);
  assert.strictEqual(resetCount, 0);
});

test('SBR-2 — COMPLETED appointment clears stale BOOKED without Change/Cancel/B6 dispatch', function() {
  reset();
  addTerminal(sandbox.Config.VOCABULARY.STATUS.COMPLETED);
  const result = sandbox.Router.dispatch({ phone: PHONE, message: '2' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.conversationState, sandbox.Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN);
  assert.ok(result.data.reply.indexOf('انتهى حجزك السابق') !== -1);
  assert.strictEqual(resetCount, 1);
  assert.strictEqual(changeCalls, 0);
  assert.strictEqual(cancelCalls, 0);
  assert.strictEqual(bookingCalls, 0);
});

test('SBR-3 — NO_SHOW appointment clears stale BOOKED', function() {
  reset();
  addTerminal(sandbox.Config.VOCABULARY.STATUS.NO_SHOW);
  const result = sandbox.Router.dispatch({ phone: PHONE, message: '3' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(resetCount, 1);
  assert.strictEqual(result.data.conversationState, sandbox.Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN);
  assert.strictEqual(cancelCalls, 0);
});

test('SBR-4 — zero CONFIRMED with an EXPIRED row clears stale BOOKED', function() {
  reset();
  addTerminal(sandbox.Config.VOCABULARY.STATUS.EXPIRED);
  const result = sandbox.ActiveAppointmentReconciliationService.reconcileBookedConversation(PHONE);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.staleCleared, true);
  assert.strictEqual(resetCount, 1);
  assert.strictEqual(conversationState, sandbox.Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN);
});

test('SBR-5 — multiple CONFIRMED appointments fail closed without conversation mutation', function() {
  reset();
  addConfirmed('ACTIVE_A');
  addConfirmed('ACTIVE_B');
  const result = sandbox.Router.dispatch({ phone: PHONE, message: '2' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'BOOKED_RECONCILIATION_AMBIGUOUS');
  assert.strictEqual(resetCount, 0);
  assert.strictEqual(changeCalls, 0);
  assert.strictEqual(cancelCalls, 0);
});

test('SBR-6 — Availability read failure fails closed without conversation mutation', function() {
  reset();
  queryFailure = true;
  const result = sandbox.Router.dispatch({ phone: PHONE, message: '3' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'BOOKED_RECONCILIATION_READ_FAILED');
  assert.strictEqual(resetCount, 0);
  assert.strictEqual(cancelCalls, 0);
  assert.strictEqual(changeCalls, 0);
});

test('SBR-7 — stale BOOKED ordinary message is reconciled before BookingService', function() {
  reset();
  addTerminal(sandbox.Config.VOCABULARY.STATUS.COMPLETED);
  const result = sandbox.Router.dispatch({ phone: PHONE, message: 'مرحبا' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.conversationState, sandbox.Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN);
  assert.strictEqual(resetCount, 1);
  assert.strictEqual(bookingCalls, 0);
});

test('SBR-8 — failed Conversation reset does not claim staleCleared success', function() {
  reset();
  addTerminal(sandbox.Config.VOCABULARY.STATUS.COMPLETED);
  resetWriteFailure = true;
  const result = sandbox.ActiveAppointmentReconciliationService.reconcileBookedConversation(PHONE);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'BOOKED_RECONCILIATION_RESET_FAILED');
  assert.strictEqual(resetCount, 1);
  assert.strictEqual(conversationState, sandbox.Config.VOCABULARY.CONVERSATION_STATE.BOOKED);
});

tests.forEach(function(item) {
  item.fn();
  console.log(item.name + ': PASS');
});

console.log('HardeningStaleBookedReconciliation: PASS (' + tests.length + '/' + tests.length + ')');
