/**
 * EnhancedReportRenderer — M3 (ENHANCED REPORT PRESENTATION)
 *
 * FROZEN CONTRACT: M3-ENHANCED-REPORT-v1
 *
 * PRESENTATION ONLY (contract §18): converts an already-composed
 * EnhancedReportModel (FULL or SUMMARY) into a human-readable plain-text
 * block.
 *
 *   EnhancedReportModel → human-readable representation
 *
 * ─── HARD BOUNDARIES (contract §18) ───
 *   The renderer performs NO repository / MetricsService /
 *   RateFoundationService / RateRuleService / ReportService calls, NO
 *   rate / severity / trend calculation, NO business decisions, and NO
 *   current-time semantic decisions. It prints ONLY what the model
 *   already carries. Model first, presentation second.
 *
 * ─── HONESTY (contract §9, §11, §19) ───
 *   AVAILABLE value prints as its number (0 is a VALID measured zero).
 *   A non-AVAILABLE metric/rate prints its status (+ reason) and NEVER a
 *   fabricated value. Report-level availability is DATA availability —
 *   the renderer never restyles UNAVAILABLE as "healthy" or "0".
 *   Recommendations render under "Management Notes" — never "Actions"
 *   (contract §13). Trend renders as a compact direction marker only
 *   (contract §12) — never a causal sentence. Insights are printed in
 *   the model's canonical order — the renderer introduces no ranking
 *   and no "Top Findings" (contract §11).
 *
 * ─── DETERMINISM (contract §20) ───
 *   Pure function of the model. All period / generatedAt strings are
 *   read from the model (precomputed at composition time), so rendering
 *   the same model twice yields byte-identical output. No Clock, no
 *   randomness, no side effects.
 *
 * ─── EVALUATION-ORDER NOTE (clasp alphabetical) ───
 *   This file sorts before Result.js; the only cross-module reference
 *   (Result) is resolved at CALL time.
 */
const EnhancedReportRenderer = {

  TREND_MARKERS: {
    TREND_UP: '↑',
    TREND_DOWN: '↓',
    TREND_FLAT: '→'
  },

  /**
   * Render a FULL or SUMMARY EnhancedReportModel as plain text.
   * @param {Object} model an EnhancedReportModel (representation FULL or SUMMARY)
   * @returns {Result} ok(string) | fail(ENHANCED_REPORT_INVALID)
   */
  render: function(model) {
    if (!this._isValidModel(model)) {
      return Result.fail(
        'ENHANCED_REPORT_INVALID',
        'Renderer input is not a valid EnhancedReportModel',
        { model: model }
      );
    }
    return model.representation === 'SUMMARY'
      ? this._renderSummary(model)
      : this._renderFull(model);
  },

  // ─── Validation ────────────────────────────────────────────────

  _isValidModel: function(model) {
    return !!model && typeof model === 'object' &&
      (model.representation === 'FULL' || model.representation === 'SUMMARY') &&
      typeof model.reportType === 'string' &&
      !!model.period && typeof model.period === 'object' &&
      typeof model.period.startWallClock === 'string' &&
      typeof model.period.endWallClock === 'string' &&
      !!model.availability && typeof model.availability === 'object' &&
      typeof model.availability.status === 'string';
  },

  // ─── FULL rendering ────────────────────────────────────────────

  _renderFull: function(model) {
    var lines = [];
    this._header(lines, model, 'ENHANCED REPORT (FULL)');

    lines.push('');
    lines.push('— M1 METRICS —');
    var names = model.m1.requestedMetrics && model.m1.requestedMetrics.length
      ? model.m1.requestedMetrics
      : Object.keys(model.m1.metrics);
    for (var i = 0; i < names.length; i++) {
      lines.push(names[i] + ': ' + this._envelopeText(model.m1.metrics[names[i]]));
    }

    lines.push('');
    lines.push('— M2 RATES —');
    var rateNames = Object.keys(model.m2.rates);
    for (var r = 0; r < rateNames.length; r++) {
      var rate = model.m2.rates[rateNames[r]];
      var rule = model.m2.rules ? model.m2.rules[rateNames[r]] : null;
      lines.push(rateNames[r] + ': ' + this._rateText(rate, rule));
    }

    var insightLines = this._insightLines(model.m2.insights);
    if (insightLines.length) {
      lines.push('');
      lines.push('— INSIGHTS —');
      for (var a = 0; a < insightLines.length; a++) lines.push(insightLines[a]);
    }

    var noteLines = this._managementNoteLinesFromInsights(model.m2.insights);
    if (noteLines.length) {
      lines.push('');
      lines.push('— MANAGEMENT NOTES —');
      for (var b = 0; b < noteLines.length; b++) lines.push(noteLines[b]);
    }

    return Result.ok(lines.join('\n'));
  },

  // ─── SUMMARY rendering ─────────────────────────────────────────

  _renderSummary: function(model) {
    var lines = [];
    this._header(lines, model, 'ENHANCED REPORT (SUMMARY)');

    lines.push('');
    lines.push('— METRICS —');
    for (var i = 0; i < model.metrics.length; i++) {
      var m = model.metrics[i];
      lines.push(m.metric + ': ' + this._valueOrStatus(m.status, m.value, m.reason));
    }

    lines.push('');
    lines.push('— RATES —');
    for (var r = 0; r < model.rates.length; r++) {
      var rate = model.rates[r];
      lines.push(rate.metric + ': ' + this._summaryRateText(rate));
    }

    if (model.insights && model.insights.length) {
      lines.push('');
      lines.push('— INSIGHTS —');
      for (var a = 0; a < model.insights.length; a++) {
        var ins = model.insights[a];
        lines.push('• ' + ins.explanation);
      }
    }

    if (model.managementNotes && model.managementNotes.length) {
      lines.push('');
      lines.push('— MANAGEMENT NOTES —');
      for (var n = 0; n < model.managementNotes.length; n++) {
        lines.push('• ' + model.managementNotes[n].note);
      }
    }

    if (model.dataQualityWarnings && model.dataQualityWarnings.length) {
      lines.push('');
      lines.push('— DATA QUALITY —');
      for (var w = 0; w < model.dataQualityWarnings.length; w++) {
        var warn = model.dataQualityWarnings[w];
        lines.push('• ' + warn.scope + (warn.metric ? ' ' + warn.metric : '') + ': ' + warn.detail);
      }
    }

    return Result.ok(lines.join('\n'));
  },

  // ─── Shared building blocks ────────────────────────────────────

  _header: function(lines, model, title) {
    lines.push('HAMZAWE ' + model.reportType + ' ' + title);
    lines.push(
      'Period: ' + model.period.startWallClock + ' -> ' + model.period.endWallClock +
      ' (' + (model.period.timeZone || '') + ')'
    );
    if (model.metadata && typeof model.metadata.generatedAtWallClock === 'string') {
      lines.push('Generated: ' + model.metadata.generatedAtWallClock);
    }
    // Report-level DATA availability (never business health).
    lines.push('Availability: ' + model.availability.status +
      (model.availability.reason ? ' — ' + model.availability.reason : ''));
  },

  /** M1 metric envelope → honest text (FULL). */
  _envelopeText: function(envelope) {
    if (envelope && envelope.status === 'AVAILABLE' && typeof envelope.value === 'number') {
      return String(envelope.value);
    }
    return this._statusReason(envelope && envelope.status, envelope && envelope.reason);
  },

  /** M2 rate fact + rule → honest text with brief trend marker (FULL). */
  _rateText: function(rate, rule) {
    var body;
    if (rate && rate.status === 'AVAILABLE' && typeof rate.value === 'number') {
      body = this._fmtPct(rate.value) + '%';
      if (rule && rule.status === 'EVALUATED' && rule.severity) {
        body += ' [' + rule.severity + ']';
      } else if (rule && rule.status && rule.status !== 'EVALUATED') {
        body += ' [' + rule.status + (rule.reason ? ': ' + rule.reason : '') + ']';
      }
    } else {
      body = this._statusReason(rate && rate.status, rate && rate.reason);
    }
    var marker = this._trendMarker(rule && rule.trend);
    return marker ? body + ' ' + marker : body;
  },

  /** SUMMARY rate line. */
  _summaryRateText: function(rate) {
    var body;
    if (rate.status === 'AVAILABLE' && typeof rate.value === 'number') {
      body = this._fmtPct(rate.value) + '%';
      if (rate.ruleStatus === 'EVALUATED' && rate.severity) {
        body += ' [' + rate.severity + ']';
      }
    } else {
      body = this._statusReason(rate.status, rate.reason);
    }
    var marker = this._trendMarker(rate.trend);
    return marker ? body + ' ' + marker : body;
  },

  /** Compact direction marker only (contract §12 — never causal). */
  _trendMarker: function(trend) {
    if (!trend || trend.available !== true || !trend.direction) return '';
    return this.TREND_MARKERS[trend.direction] || '';
  },

  _insightLines: function(insights) {
    var out = [];
    if (!insights) return out;
    for (var i = 0; i < insights.length; i++) {
      if (insights[i] && insights[i].explanation) out.push('• ' + insights[i].explanation);
    }
    return out;
  },

  _managementNoteLinesFromInsights: function(insights) {
    var out = [];
    if (!insights) return out;
    for (var i = 0; i < insights.length; i++) {
      if (insights[i] && insights[i].recommendation) out.push('• ' + insights[i].recommendation);
    }
    return out;
  },

  _valueOrStatus: function(status, value, reason) {
    if (status === 'AVAILABLE' && typeof value === 'number') return String(value);
    return this._statusReason(status, reason);
  },

  _statusReason: function(status, reason) {
    var label = typeof status === 'string' ? status : 'UNKNOWN_STATUS';
    var suffix = typeof reason === 'string' && reason !== '' ? ' (' + reason + ')' : '';
    return label + suffix;
  },

  _fmtPct: function(value) {
    return String(Math.round(value * 100) / 100);
  }
};
