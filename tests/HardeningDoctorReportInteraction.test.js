'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

function load(rel, sandbox, name) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8') +
    '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
}

(function testDoctorReportService() {
  const state = { fullCalls: [], projections: 0, renders: [], nowCalls: 0 };
  const sandbox = vm.createContext({ console: console });
  sandbox.Result = {
    ok: function(data) { return { ok: true, data: data, error: null }; },
    fail: function(code, message) { return { ok: false, data: null, error: { code: code, message: message } }; }
  };
  sandbox.Clock = { now: function() { state.nowCalls++; return new Date(123456); } };
  sandbox.EnhancedReportService = {
    generateFull: function(type, reference) {
      state.fullCalls.push({ type: type, reference: reference.getTime() });
      return { ok: true, data: { representation: 'FULL', availability: { status: 'PARTIAL' }, period: {} } };
    },
    project: function(full) {
      state.projections++;
      return { representation: 'SUMMARY', availability: full.availability, period: full.period };
    }
  };
  sandbox.EnhancedReportRenderer = {
    render: function(model) {
      state.renders.push(model.representation);
      return { ok: true, data: model.representation + '\nAVAILABLE: 0\nRULE_NOT_CONFIGURED' };
    }
  };
  load('Application/DoctorReportService.js', sandbox, 'DoctorReportService');

  const invalidType = sandbox.DoctorReportService.generate('YEARLY', 'SUMMARY');
  assert.strictEqual(invalidType.ok, false);
  assert.strictEqual(invalidType.error.code, 'DOCTOR_REPORT_TYPE_INVALID');
  assert.strictEqual(state.nowCalls, 0);

  const invalidRepresentation = sandbox.DoctorReportService.generate('DAILY', 'BRIEF');
  assert.strictEqual(invalidRepresentation.ok, false);
  assert.strictEqual(invalidRepresentation.error.code, 'DOCTOR_REPORT_REPRESENTATION_INVALID');
  assert.strictEqual(state.nowCalls, 0);

  const summary = sandbox.DoctorReportService.generate('WEEKLY', 'SUMMARY');
  assert.strictEqual(summary.ok, true);
  assert.deepStrictEqual(state.fullCalls[0], { type: 'WEEKLY', reference: 123456 });
  assert.strictEqual(state.projections, 1);
  assert.strictEqual(state.renders[0], 'SUMMARY');
  assert.strictEqual(summary.data.availability, 'PARTIAL');
  assert.ok(summary.data.reply.indexOf('متاح') !== -1);
  assert.ok(summary.data.reply.indexOf('سياسة التقييم غير مهيأة') !== -1);

  const full = sandbox.DoctorReportService.generate('MONTHLY', 'FULL');
  assert.strictEqual(full.ok, true);
  assert.strictEqual(state.projections, 1, 'FULL must not be projected');
  assert.strictEqual(state.renders[1], 'FULL');
  assert.strictEqual(state.nowCalls, 2);
})();

(function testInteractiveIntentSymmetryAndBoundaries() {
  const source = fs.readFileSync(path.join(ROOT, 'Infrastructure/WhatsAppAdapter.js'), 'utf8');
  const interaction = fs.readFileSync(path.join(ROOT, 'Application/DoctorControlInteractionService.js'), 'utf8');
  const ids = [
    'REPORTS',
    'REPORT_PERIOD_DAILY', 'REPORT_PERIOD_WEEKLY', 'REPORT_PERIOD_MONTHLY',
    'REPORT_RUN_DAILY_SUMMARY', 'REPORT_RUN_DAILY_FULL',
    'REPORT_RUN_WEEKLY_SUMMARY', 'REPORT_RUN_WEEKLY_FULL',
    'REPORT_RUN_MONTHLY_SUMMARY', 'REPORT_RUN_MONTHLY_FULL'
  ];
  ids.forEach(function(id) {
    assert.ok(source.indexOf(id + ": 'DOCTOR_" + id + "'") !== -1,
      'missing outbound Meta mapping for ' + id);
    assert.ok(source.indexOf('DOCTOR_' + id + ": '" + id + "'") !== -1,
      'missing inbound mapping for ' + id);
  });
  assert.ok(interaction.indexOf("id: 'REPORT_PERIOD_DAILY'") !== -1);
  assert.ok(interaction.indexOf("id: 'REPORT_RUN_' + reportType + '_SUMMARY'") !== -1);
  assert.ok(interaction.indexOf("id: 'REPORT_RUN_' + reportType + '_FULL'") !== -1);
  assert.ok(interaction.indexOf('DoctorReportService.generate(reportType, representation)') !== -1);
  assert.ok(interaction.indexOf("id: 'REPORTS', title: 'التقارير'") !== -1);
})();

console.log('Doctor report interaction contract tests passed');
