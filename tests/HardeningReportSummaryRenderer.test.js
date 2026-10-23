const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const sandbox = vm.createContext({
  Result: {
    ok: function(data) { return { ok: true, data: data, error: null }; },
    fail: function(code, message, details) {
      return { ok: false, data: null, error: { code: code, message: message, details: details } };
    }
  }
});
const source = fs.readFileSync('Application/EnhancedReportRenderer.js', 'utf8');
vm.runInContext(source + '\nthis.EnhancedReportRenderer = EnhancedReportRenderer;', sandbox, {
  filename: 'Application/EnhancedReportRenderer.js'
});

const full = {
  representation: 'FULL',
  reportType: 'MONTHLY',
  period: {
    startWallClock: '2026-10-01T00:00:00+03:00',
    endWallClock: '2026-11-01T00:00:00+03:00',
    timeZone: 'Asia/Baghdad'
  },
  availability: { status: 'COMPLETE', reason: null },
  metadata: { generatedAtWallClock: '2026-10-23T05:24:07+03:00' },
  m1: {
    requestedMetrics: ['CONFIRMED_APPOINTMENTS', 'OFFICIAL_CANCELLATIONS'],
    metrics: {
      CONFIRMED_APPOINTMENTS: { status: 'AVAILABLE', value: 1 },
      OFFICIAL_CANCELLATIONS: { status: 'AVAILABLE', value: 2 }
    }
  },
  m2: {
    rates: {
      CANCELLATION_RATE: { status: 'AVAILABLE', value: 0.2857, reason: null },
      CHANGE_RATE: { status: 'AVAILABLE', value: 0.1429, reason: null }
    },
    rules: {
      CANCELLATION_RATE: { status: 'INSUFFICIENT_SAMPLE', reason: 'sample below minimum', trend: null },
      CHANGE_RATE: { status: 'INSUFFICIENT_SAMPLE', reason: 'sample below minimum', trend: null }
    },
    insights: [
      { explanation: 'Detailed sample explanation.', recommendation: 'Monitor future samples.' }
    ]
  }
};
const summary = {
  representation: 'SUMMARY',
  reportType: full.reportType,
  period: full.period,
  availability: full.availability,
  metadata: full.metadata,
  metrics: [
    { metric: 'CONFIRMED_APPOINTMENTS', status: 'AVAILABLE', value: 1 },
    { metric: 'OFFICIAL_CANCELLATIONS', status: 'AVAILABLE', value: 2 }
  ],
  rates: [
    { metric: 'CANCELLATION_RATE', status: 'AVAILABLE', value: 0.2857, ruleStatus: 'INSUFFICIENT_SAMPLE', severity: null, trend: { available: false } },
    { metric: 'CHANGE_RATE', status: 'AVAILABLE', value: 0.1429, ruleStatus: 'INSUFFICIENT_SAMPLE', severity: null, trend: { available: false } }
  ],
  insights: [{ explanation: 'Detailed sample explanation.' }],
  managementNotes: [{ note: 'Monitor future samples.' }],
  dataQualityWarnings: [{ scope: 'M2_COHORT', detail: '15 unattributable evidence rows' }]
};

try {
const summaryResult = sandbox.EnhancedReportRenderer.render(summary);
assert.strictEqual(summaryResult.ok, true);
const summaryText = summaryResult.data;
assert.ok(summaryText.includes('CANCELLATION_RATE: 28.57% [INSUFFICIENT_SAMPLE]'), summaryText);
assert.ok(summaryText.includes('CONFIRMED_APPOINTMENTS: 1'));
assert.ok(!summaryText.includes('— INSIGHTS —'));
assert.ok(!summaryText.includes('— MANAGEMENT NOTES —'));
assert.ok(!summaryText.includes('— DATA QUALITY —'));
assert.ok(!summaryText.includes('Detailed sample explanation.'));
assert.ok(!summaryText.includes('Monitor future samples.'));
assert.ok(!summaryText.includes('unattributable evidence'));

const fullResult = sandbox.EnhancedReportRenderer.render(full);
assert.strictEqual(fullResult.ok, true);
const fullText = fullResult.data;
assert.ok(fullText.includes('— M1 METRICS —'));
assert.ok(fullText.includes('— M2 RATES —'));
assert.ok(fullText.includes('— INSIGHTS —'));
assert.ok(fullText.includes('Detailed sample explanation.'));
assert.ok(fullText.includes('— MANAGEMENT NOTES —'));
assert.ok(fullText.includes('Monitor future samples.'));
assert.ok(fullText.includes('CANCELLATION_RATE: 28.57%'));

console.log('HardeningReportSummaryRenderer.test.js: PASS');
} catch (error) {
  console.error('FAIL: HardeningReportSummaryRenderer.test.js :: ' +
    (error && error.stack ? error.stack.replace(/\s+/g, ' ') : String(error)));
  process.exitCode = 1;
}
