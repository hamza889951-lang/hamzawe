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

(function testDoctorReportServiceAndArabicPresentation() {
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
      return { ok: true, data: { representation: 'FULL', availability: { status: 'PARTIAL' } } };
    },
    project: function(full) {
      state.projections++;
      return { representation: 'SUMMARY', availability: full.availability };
    }
  };
  sandbox.EnhancedReportRenderer = {
    render: function(model) {
      state.renders.push(model.representation);
      return { ok: true, data: [
        'HAMZAWE WEEKLY ENHANCED REPORT (SUMMARY)',
        'Period: 2026-10-10T00:00 -> 2026-10-17T00:00 (Asia/Baghdad)',
        'Generated: 2026-10-16T08:00',
        'Availability: PARTIAL — upstream AVAILABLE text is part of the reason',
        '— METRICS —',
        'OFFICIAL_CANCELLATIONS: 0',
        'CANCELLATION_RATE: AVAILABLE: 0 [RULE_NOT_CONFIGURED: policy AVAILABLE not configured]',
        'OTHER_METRIC: INSUFFICIENT_SAMPLE (reason contains AVAILABLE and RULE_NOT_CONFIGURED)',
        '— INSIGHTS —',
        'Source says AVAILABLE and RULE_NOT_CONFIGURED; preserve this narrative.'
      ].join('\n') };
    }
  };
  load('Application/DoctorReportService.js', sandbox, 'DoctorReportService');

  const invalidType = sandbox.DoctorReportService.generate('YEARLY', 'SUMMARY');
  assert.strictEqual(invalidType.ok, false);
  assert.strictEqual(invalidType.error.code, 'DOCTOR_REPORT_TYPE_INVALID');
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
  const reply = summary.data.reply;
  assert.ok(reply.includes('ملخص التقرير الإداري'));
  assert.ok(reply.includes('الفترة: 2026-10-10T00:00 إلى 2026-10-17T00:00 (Asia/Baghdad)'));
  assert.ok(reply.includes('وقت إنشاء التقرير: 2026-10-16T08:00'));
  assert.ok(reply.includes('توفر البيانات: جزئي — upstream AVAILABLE text is part of the reason'),
    'only the status is translated; its dynamic reason is unchanged');
  assert.ok(reply.includes('الإلغاءات المسجلة: 0'), 'measured zero is preserved');
  assert.ok(reply.includes('معدل الإلغاء: متاح: 0 [سياسة التقييم غير مهيأة: policy AVAILABLE not configured]'),
    'status label is translated but rule reason is unchanged');
  assert.ok(reply.includes('OTHER_METRIC: العينة غير كافية (reason contains AVAILABLE and RULE_NOT_CONFIGURED)'),
    'unknown metric identifier and dynamic reason are retained while the known status is translated');
  assert.ok(reply.includes('Source says AVAILABLE and RULE_NOT_CONFIGURED; preserve this narrative.'),
    'dynamic narrative must not be globally rewritten');

  const statuses = ['DEFERRED', 'UNAVAILABLE', 'NOT_EVALUABLE', 'INSUFFICIENT_SAMPLE', 'RULE_NOT_CONFIGURED'];
  const labels = ['مؤجل', 'غير متاح', 'غير قابل للتقييم', 'العينة غير كافية', 'سياسة التقييم غير مهيأة'];
  const map = {
    DEFERRED: 'مؤجل', UNAVAILABLE: 'غير متاح', NOT_EVALUABLE: 'غير قابل للتقييم',
    INSUFFICIENT_SAMPLE: 'العينة غير كافية', RULE_NOT_CONFIGURED: 'سياسة التقييم غير مهيأة'
  };
  statuses.forEach(function(status, index) {
    assert.strictEqual(sandbox.DoctorReportService._translateLeadingStatus(status, map), labels[index]);
  });

  const full = sandbox.DoctorReportService.generate('MONTHLY', 'FULL');
  assert.strictEqual(full.ok, true);
  assert.strictEqual(state.projections, 1, 'FULL must not be projected');
  assert.strictEqual(state.renders[1], 'FULL');
  assert.strictEqual(state.nowCalls, 2, 'one reference instant per report');
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
