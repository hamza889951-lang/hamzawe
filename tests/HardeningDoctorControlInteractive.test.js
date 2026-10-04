'use strict';

/**
 * HardeningDoctorControlInteractive.test.js
 *
 * Verifies Doctor Control Interactive Intents converge with legacy numeric
 * inputs at the existing DoctorControlInteractionService boundary.
 *
 * No Router, authorization, state-machine, repository schema, or domain
 * command implementation is duplicated here; those boundaries are mocked
 * only to isolate the interaction contract.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../Application/DoctorControlInteractionService.js'),
  'utf8'
);

const state = {
  session: {
    exists: true,
    state: 'DOCTOR_MENU',
    draft: {}
  },
  scheduleReads: 0,
  commits: 0
};

const context = {
  Result: {
    ok: data => ({ ok: true, data: data }),
    fail: (code, message, details) => ({
      ok: false,
      error: { code: code, message: message, details: details }
    })
  },
  Config: {
    VOCABULARY: {
      CONVERSATION_STATE: {
        DOCTOR_MENU: 'DOCTOR_MENU',
        DOCTOR_AWAITING_INPUT: 'DOCTOR_AWAITING_INPUT',
        DOCTOR_AWAITING_CONFIRMATION: 'DOCTOR_AWAITING_CONFIRMATION'
      }
    }
  },
  ConversationRepository: {
    DOCTOR_STATES: [
      'DOCTOR_MENU',
      'DOCTOR_AWAITING_INPUT',
      'DOCTOR_AWAITING_CONFIRMATION'
    ],
    getDoctorControlSession: function() {
      return context.Result.ok({
        exists: state.session.exists,
        state: state.session.state,
        draft: Object.assign({}, state.session.draft)
      });
    },
    getDoctorControlUxSession: function() {
      return context.Result.ok({
        exists: state.session.exists,
        state: state.session.state,
        draft: Object.assign({}, state.session.draft)
      });
    },
    setDoctorControlUxSession: function(phone, nextState, draft) {
      state.session = { exists: true, state: nextState, draft: Object.assign({}, draft || {}) };
      return context.Result.ok({ phone: phone, state: nextState, draft: Object.assign({}, draft || {}) });
    },
    setDoctorControlSession: function(phone, nextState, draft) {
      state.session = {
        exists: true,
        state: nextState,
        draft: Object.assign({}, draft || {})
      };
      return context.Result.ok({
        phone: phone,
        state: nextState,
        draft: Object.assign({}, draft || {})
      });
    },
    updateDoctorControlUxSession: function(phone, nextState, patch) {
      state.session = {
        exists: true,
        state: nextState,
        draft: Object.assign({}, state.session.draft || {}, patch || {})
      };
      return context.Result.ok({
        phone: phone,
        state: nextState,
        draft: Object.assign({}, state.session.draft)
      });
    }
  },
  DoctorScheduleReadService: {
    readCurrentEffectiveSchedule: function() {
      state.scheduleReads += 1;
      return context.Result.ok({
        days: {
          sunday: true,
          monday: true,
          tuesday: false,
          wednesday: true,
          thursday: true,
          friday: false,
          saturday: false
        },
        workWindow: { start: '09:00', end: '14:00' },
        slotDurationMinutes: 30
      });
    }
  },
  EffectiveScheduleService: {
    DAY_KEYS: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  },
  DateUtils: {
    formatLocalStamp: function() { return '2026-10-04T08:00'; },
    nextLocalDateString: function(value) { return value === '2026-10-20' ? '2026-10-21' : null; }
  },
  Clock: {
    now: function() { return new Date('2026-10-04T08:00:00Z'); }
  },
  IdGenerator: {
    generateScheduleCommandId: function() { return 'CMD_TEST'; }
  },
  console: console
};

vm.runInNewContext(source + '\nthis.__service = DoctorControlInteractionService;', context);
const service = context.__service;

function controlContext() {
  return { actorId: '9647001111111', scope: { clinicId: null } };
}

function resetMenu() {
  state.session = { exists: true, state: 'DOCTOR_MENU', draft: {} };
  state.scheduleReads = 0;
  state.commits = 0;
}

function assertMainMenu(result) {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.controlState, 'DOCTOR_MENU');
  assert.strictEqual(
    JSON.stringify(result.data.deliveryOptions.interactiveButtons.map(function(button) {
      return button.id;
    })),
    JSON.stringify(['VIEW_SCHEDULE', 'CHANGE_SCHEDULE', 'MORE'])
  );
}

resetMenu();
let legacy = service.handle(controlContext(), '1');
assertMainMenu(legacy);
assert.strictEqual(state.scheduleReads, 1);

resetMenu();
let interactive = service.handle(controlContext(), 'VIEW_SCHEDULE');
assertMainMenu(interactive);
assert.strictEqual(state.scheduleReads, 1);

assert.strictEqual(
  JSON.stringify(interactive.data.deliveryOptions.interactiveButtons),
  JSON.stringify(legacy.data.deliveryOptions.interactiveButtons)
);

resetMenu();
let more = service.handle(controlContext(), 'MORE');
assert.strictEqual(more.ok, true);
assert.strictEqual(more.data.controlState, 'DOCTOR_MENU');
assert.strictEqual(
  JSON.stringify(more.data.deliveryOptions.interactiveButtons.map(function(button) {
    return button.id;
  })),
  JSON.stringify(['TEMPORARY_CLOSE', 'TEMPORARY_OPEN', 'CANCEL_CHANGE'])
);
assert.strictEqual(state.session.state, 'DOCTOR_MENU');

resetMenu();
let legacyClose = service.handle(controlContext(), '3');
assert.strictEqual(legacyClose.ok, true);
assert.strictEqual(legacyClose.data.controlState, 'DOCTOR_AWAITING_INPUT');
assert.strictEqual(state.session.draft.doctor_draft_kind, 'TEMPORARY_CLOSE');

resetMenu();
let interactiveClose = service.handle(controlContext(), 'TEMPORARY_CLOSE');
assert.strictEqual(interactiveClose.ok, true);
assert.strictEqual(interactiveClose.data.controlState, 'DOCTOR_AWAITING_INPUT');
assert.strictEqual(state.session.draft.doctor_draft_kind, 'TEMPORARY_CLOSE');

state.session = {
  exists: true,
  state: 'DOCTOR_AWAITING_CONFIRMATION',
  draft: {
    doctor_draft_kind: 'TEMPORARY_CLOSE',
    doctor_draft_command_id: 'CMD_TEST'
  }
};
service._commandFromDraft = function() {
  return context.Result.ok({ asOf: '2026-10-04T08:00' });
};
service._runCommit = function() {
  state.commits += 1;
  return context.Result.ok({
    status: 'COMMITTED',
    record: {
      changeId: 'SCH_TEST',
      effectiveFrom: '2026-10-20T00:00',
      effectiveTo: '2026-10-21T00:00'
    }
  });
};

let numericConfirm = service.handle(controlContext(), '1');
assert.strictEqual(numericConfirm.ok, true);
assert.strictEqual(state.commits, 1);
assert.strictEqual(numericConfirm.data.controlState, 'DOCTOR_MENU');

state.session = {
  exists: true,
  state: 'DOCTOR_AWAITING_CONFIRMATION',
  draft: {
    doctor_draft_kind: 'TEMPORARY_CLOSE',
    doctor_draft_command_id: 'CMD_TEST'
  }
};

let buttonConfirm = service.handle(controlContext(), 'CONFIRM');
assert.strictEqual(buttonConfirm.ok, true);
assert.strictEqual(state.commits, 2);
assert.strictEqual(buttonConfirm.data.controlState, 'DOCTOR_MENU');

state.session = {
  exists: true,
  state: 'DOCTOR_AWAITING_CONFIRMATION',
  draft: {
    doctor_draft_kind: 'TEMPORARY_CLOSE',
    doctor_draft_command_id: 'CMD_TEST'
  }
};

let buttonCancel = service.handle(controlContext(), 'CANCEL');
assert.strictEqual(buttonCancel.ok, true);
assert.strictEqual(buttonCancel.data.controlState, 'DOCTOR_MENU');
assert.strictEqual(state.commits, 2);


service._runPreview = function() {
  return context.Result.ok({
    status: 'PREVIEWED',
    record: {
      effectiveFrom: '2026-10-20T00:00',
      effectiveTo: '2026-10-21T00:00'
    },
    baseline: {},
    records: []
  });
};
service._countAffectedBookings = function() {
  return context.Result.ok({ count: 0 });
};

resetMenu();
let guidedRecurring = service.handle(controlContext(), 'CHANGE_SCHEDULE');
assert.strictEqual(guidedRecurring.ok, true);
assert.strictEqual(state.session.draft.doctor_ux_step, 'DAYS');

let days = service.handle(controlContext(), '1,3,5');
assert.strictEqual(days.ok, true);
assert.strictEqual(state.session.draft.doctor_draft_days, 'sunday,tuesday,thursday');
assert.strictEqual(state.session.draft.doctor_ux_step, 'DAYS');

let doneDays = service.handle(controlContext(), 'تم');
assert.strictEqual(doneDays.ok, true);
assert.strictEqual(state.session.draft.doctor_ux_step, 'START_TIME');

let startTime = service.handle(controlContext(), '10:00');
assert.strictEqual(startTime.ok, true);
let endTime = service.handle(controlContext(), '14:00');
assert.strictEqual(endTime.ok, true);
let recurringPreview = service.handle(controlContext(), '2026-10-20');
assert.strictEqual(recurringPreview.ok, true);
assert.strictEqual(state.session.state, 'DOCTOR_AWAITING_CONFIRMATION');

let edit = service.handle(controlContext(), 'EDIT');
assert.strictEqual(edit.ok, true);
assert.strictEqual(edit.data.controlState, 'DOCTOR_AWAITING_INPUT');
assert.strictEqual(edit.data.deliveryOptions.interactiveButtons.length, 3);

let editDate = service.handle(controlContext(), 'EDIT_DATE');
assert.strictEqual(editDate.ok, true);
let editedPreview = service.handle(controlContext(), '2026-10-21');
assert.strictEqual(editedPreview.ok, true);
assert.strictEqual(state.session.state, 'DOCTOR_AWAITING_CONFIRMATION');

resetMenu();
let guidedClose = service.handle(controlContext(), 'TEMPORARY_CLOSE');
assert.strictEqual(guidedClose.ok, true);
assert.strictEqual(guidedClose.data.deliveryOptions.interactiveButtons.length, 3);

let fullDay = service.handle(controlContext(), 'TEMP_CLOSE_FULL_DAY');
assert.strictEqual(fullDay.ok, true);
let closePreview = service.handle(controlContext(), '2026-10-20');
assert.strictEqual(closePreview.ok, true);
assert.strictEqual(state.session.draft.doctor_draft_effective_from, '2026-10-20T00:00');
assert.strictEqual(state.session.draft.doctor_draft_effective_to, '2026-10-21T00:00');
assert.strictEqual(state.session.state, 'DOCTOR_AWAITING_CONFIRMATION');

console.log('PASS: Doctor Control Interactive Intents — menu, More navigation, legacy convergence, and confirmation/cancellation');
