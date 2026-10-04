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

console.log('PASS: Doctor Control Interactive Intents — menu, More navigation, legacy convergence, and confirmation/cancellation');
