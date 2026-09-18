const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function loadScript(file, sandbox) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInNewContext(code, sandbox, { filename: file });
}

(function gatewayTests() {
  const gateway = require('../gateway/whatsapp-meta-gateway');
  const secret = 'meta-app-secret';
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: '9647001234567',
            id: 'wamid.test-1',
            timestamp: '1779000000',
            type: 'text',
            text: { body: 'مرحبا' }
          }]
        }
      }]
    }]
  });

  const signature = 'sha256=' + gateway.hexHmacSha256(secret, body);
  assert.strictEqual(gateway.verifyMetaSignature(body, signature, secret), true);
  assert.strictEqual(gateway.verifyMetaSignature(body, signature + '0', secret), false);

  const events = gateway.collectNormalizedEvents(JSON.parse(body));
  assert.strictEqual(events.messages.length, 1);
  assert.deepStrictEqual(events.messages[0], {
    channel: 'WHATSAPP',
    provider: 'META_CLOUD',
    eventType: 'MESSAGE',
    messageId: 'wamid.test-1',
    phone: '9647001234567',
    timestampMs: 1779000000000,
    messageType: 'TEXT',
    text: 'مرحبا'
  });

  const envelope = gateway.makeEnvelope(events.messages[0], 1779000010000, 'gateway-secret');
  assert.strictEqual(
    envelope.signature,
    gateway.signNormalizedEvent(events.messages[0], 'gateway-secret')
  );
  console.log('PASS: P0 gateway signature, normalization, and envelope');
})();

(function messagingPolicyTests() {
  let now = 1800000000000;
  let sentText = 0;
  let sentTemplate = 0;
  let lastTemplate = null;

  const sandbox = {
    Result: {
      ok: function(data) { return { ok: true, data: data || null, error: null }; },
      fail: function(code, message, details) {
        return { ok: false, data: null, error: { code, message, details: details || null } };
      }
    },
    Clock: { now: function() { return new Date(now); } },
    ConversationRepository: {
      findByPhone: function() {
        return { last_inbound_at_ms: String(now - 60 * 60 * 1000), updated_at: new Date(now) };
      }
    },
    WhatsAppAdapter: {
      sendText: function() { sentText += 1; return sandbox.Result.ok({}); },
      sendTemplate: function(phone, name, language, parameters) {
        sentTemplate += 1;
        lastTemplate = { phone, name, language, parameters };
        return sandbox.Result.ok({});
      }
    },
    WhatsAppTemplateRepository: {
      getTemplate: function(kind, options) {
        return sandbox.Result.ok({
          name: options.templateName || 'approved_' + kind,
          language: 'ar',
          parameters: options.templateParameters || []
        });
      }
    }
  };

  loadScript('Application/MessagingPolicyService.js', sandbox);

  let result = sandbox.MessagingPolicyService.sendProactive('9647', 'hello', {
    kind: sandbox.MessagingPolicyService.KINDS.REMINDER
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(sentText, 1);
  assert.strictEqual(sentTemplate, 0);

  now += 24 * 60 * 60 * 1000;
  result = sandbox.MessagingPolicyService.sendProactive('9647', 'hello', {
    kind: sandbox.MessagingPolicyService.KINDS.REMINDER,
    templateParameters: ['date', 'bus']
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(sentTemplate, 1);
  assert.deepStrictEqual(lastTemplate.parameters, ['date', 'bus']);

  sandbox.WhatsAppTemplateRepository.getTemplate = function() {
    return sandbox.Result.fail('WHATSAPP_TEMPLATE_REQUIRED', 'missing');
  };
  result = sandbox.MessagingPolicyService.sendProactive('9647', 'hello', {
    kind: sandbox.MessagingPolicyService.KINDS.REMINDER
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, 'WHATSAPP_TEMPLATE_REQUIRED');

  console.log('PASS: P1 messaging-window/template policy');
})();

(function structuralTests() {
  const sourceFiles = [
    'Application/MessagingPolicyService.js',
    'Application/PatientDisruptionService.js',
    'Application/BookingService.js',
    'Application/CancelService.js',
    'Changeservice.js',
    'ConversationRepository.js',
    'Core/Router.js',
    'HealthCheckService.js',
    'Infrastructure/B6RecoveryAlert.js',
    'Infrastructure/WhatsAppAdapter.js',
    'Reminderservice.js',
    'Scheduler.js',
    'ProcessedMessagesService.js',
    'Utils/PhoneUtils.js',
    'Webhook.js'
  ];

  sourceFiles.forEach(function(file) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.strictEqual(/ultramsg|api\.ultramsg\.com/i.test(text), false, file + ' still references UltraMsg');
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'appsscript.json'), 'utf8'));
  assert.ok(manifest.urlFetchWhitelist.indexOf('https://graph.facebook.com/') !== -1);
  assert.strictEqual(manifest.urlFetchWhitelist.indexOf('https://api.ultramsg.com/'), -1);

  const conversation = fs.readFileSync(path.join(ROOT, 'ConversationRepository.js'), 'utf8');
  assert.ok(conversation.indexOf('last_inbound_at_ms') !== -1);
  assert.ok(conversation.indexOf('last_inbound_message_id') !== -1);
  assert.ok(conversation.indexOf('ignoredOlderEvent') !== -1);

  const policy = fs.readFileSync(path.join(ROOT, 'Application/MessagingPolicyService.js'), 'utf8');
  assert.strictEqual(/PropertiesService/.test(policy), false);

  console.log('PASS: P2 provider-decoupling structural checks');
})();

console.log('WhatsApp Cloud migration targeted tests: 3/3 PASS');
