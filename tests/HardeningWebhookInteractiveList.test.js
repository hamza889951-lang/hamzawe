'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '../Webhook.js'), 'utf8');
const state = { claims: [], dispatched: [], logs: [] };
const context = {
  WhatsAppAdapter: {
    parseIncomingPayload: function() {
      return {
        eventType: 'MESSAGE',
        messageType: 'INTERACTIVE_LIST',
        phone: '9647001111111',
        message: 'TEMPORARY_AVAILABILITY',
        messageId: 'wamid.list-test',
        timestampMs: 1792738800000
      };
    }
  },
  Clock: { now: function() { return new Date('2026-10-23T07:00:00Z'); } },
  LogRepository: { write: function(row) { state.logs.push(row); } },
  ProcessedMessagesService: {
    claim: function(id, phone, message) {
      state.claims.push({ id: id, phone: phone, message: message });
      return { ok: true, data: { status: 'CLAIMED' } };
    }
  },
  Router: {
    dispatch: function(input) {
      state.dispatched.push(input);
      return { ok: true, data: { reply: 'submenu', deliveryOptions: { interactiveList: {} } } };
    }
  },
  ConversationRepository: {
    recordInboundMessage: function() { return { ok: true }; }
  },
  MessagingPolicyService: {
    sendReply: function(phone, reply, options) {
      state.reply = { phone: phone, reply: reply, options: options };
      return { ok: true };
    }
  },
  ContentService: {
    createTextOutput: function(value) { return { value: value }; }
  }
};
vm.runInNewContext(source, context);
const response = context.doPost({ postData: { contents: '{}' } });

assert.strictEqual(response.value, 'OK');
assert.strictEqual(state.claims.length, 1, 'interactive list must pass idempotency claim');
assert.strictEqual(state.claims[0].message, 'TEMPORARY_AVAILABILITY');
assert.strictEqual(state.dispatched.length, 1, 'interactive list must reach Router');
assert.strictEqual(state.dispatched[0].message, 'TEMPORARY_AVAILABILITY');
assert.strictEqual(state.reply.reply, 'submenu');
assert.strictEqual(state.logs.some(function(row) {
  return row.command === 'WEBHOOK_UNSUPPORTED_MESSAGE';
}), false, 'interactive list must not be logged as unsupported');

console.log('PASS: Webhook accepts INTERACTIVE_LIST and routes canonical intent');
