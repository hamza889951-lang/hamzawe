/**
 * DoctorReportService — authorized doctor report orchestration.
 * FULL is canonical; SUMMARY is a projection. No repository access,
 * state mutation, metric calculation, or message delivery occurs here.
 */
const DoctorReportService = {
  REPORT_TYPES: ['DAILY', 'WEEKLY', 'MONTHLY'],
  REPRESENTATIONS: ['SUMMARY', 'FULL'],

  generate: function(reportType, representation) {
    if (this.REPORT_TYPES.indexOf(reportType) === -1) {
      return Result.fail('DOCTOR_REPORT_TYPE_INVALID', 'Unsupported doctor report period');
    }
    if (this.REPRESENTATIONS.indexOf(representation) === -1) {
      return Result.fail('DOCTOR_REPORT_REPRESENTATION_INVALID', 'Unsupported doctor report representation');
    }
    var reference = Clock.now();
    var fullResult = EnhancedReportService.generateFull(reportType, reference);
    if (!fullResult.ok) return fullResult;
    var model = fullResult.data;
    if (representation === 'SUMMARY') model = EnhancedReportService.project(model);
    var rendered = EnhancedReportRenderer.render(model);
    if (!rendered.ok) return rendered;
    return Result.ok({
      reportType: reportType,
      representation: representation,
      availability: model.availability ? model.availability.status : null,
      reply: this._arabicPresentation(rendered.data)
    });
  },

  /*
   * Translate renderer-owned labels at structural positions only. Dynamic
   * reasons, provenance, insights, recommendations and unknown identifiers
   * remain verbatim; never globally replace words inside evidence text.
   */
  _arabicPresentation: function(text) {
    var periods = { DAILY: 'يومي', WEEKLY: 'أسبوعي', MONTHLY: 'شهري' };
    var headings = {
      'ENHANCED REPORT (FULL)': 'التقرير الإداري الكامل',
      'ENHANCED REPORT (SUMMARY)': 'ملخص التقرير الإداري',
      '— M1 METRICS —': '— مؤشرات التشغيل —',
      '— M2 RATES —': '— معدلات الإدارة —',
      '— METRICS —': '— المؤشرات —',
      '— RATES —': '— المعدلات —',
      '— INSIGHTS —': '— الاستنتاجات —',
      '— MANAGEMENT NOTES —': '— ملاحظات إدارية —',
      '— DATA QUALITY —': '— جودة البيانات —'
    };
    var metrics = {
      CANCELLATION_RATE: 'معدل الإلغاء',
      CHANGE_RATE: 'معدل تغيير الموعد',
      COMPLETION_RATE: 'معدل إكمال المواعيد',
      NO_SHOW_RATE: 'معدل عدم الحضور',
      BOOKING_COUNT: 'عدد الحجوزات',
      CANCELLATION_COUNT: 'عدد الإلغاءات',
      CHANGE_COUNT: 'عدد التغييرات',
      COMPLETION_COUNT: 'عدد المواعيد المكتملة',
      NO_SHOW_COUNT: 'عدد حالات عدم الحضور',
      CONFIRMED_APPOINTMENTS: 'المواعيد المؤكدة',
      OFFICIAL_CANCELLATIONS: 'الإلغاءات المسجلة',
      OFFICIAL_CHANGES: 'التغييرات المسجلة',
      COMPLETED_APPOINTMENTS: 'المواعيد المكتملة',
      NO_SHOW_APPOINTMENTS: 'حالات عدم الحضور'
    };
    var statuses = {
      AVAILABLE: 'متاح', COMPLETE: 'مكتمل', PARTIAL: 'جزئي',
      DEFERRED: 'مؤجل', UNAVAILABLE: 'غير متاح',
      NOT_EVALUABLE: 'غير قابل للتقييم',
      INSUFFICIENT_SAMPLE: 'العينة غير كافية',
      RULE_NOT_CONFIGURED: 'سياسة التقييم غير مهيأة',
      EVALUATED: 'تم التقييم', UNKNOWN_STATUS: 'حالة غير معروفة'
    };

    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var title = line.match(/^HAMZAWE (DAILY|WEEKLY|MONTHLY) (ENHANCED REPORT \(FULL\)|ENHANCED REPORT \(SUMMARY\))$/);
      if (title) {
        lines[i] = 'تقرير HAMZAWE ' + periods[title[1]] + ' — ' + headings[title[2]];
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(headings, line)) {
        lines[i] = headings[line];
        continue;
      }
      var period = line.match(/^Period: (.*?) -> (.*?) \((.*?)\)$/);
      if (period) {
        lines[i] = 'الفترة: ' + period[1] + ' إلى ' + period[2] +
          (period[3] ? ' (' + period[3] + ')' : '');
        continue;
      }
      if (line.indexOf('Generated: ') === 0) {
        lines[i] = 'وقت إنشاء التقرير: ' + line.substring(11);
        continue;
      }
      if (line.indexOf('Availability: ') === 0) {
        lines[i] = 'توفر البيانات: ' + this._translateLeadingStatus(line.substring(13), statuses);
        continue;
      }
      var pair = line.match(/^([^:]+):(.*)$/);
      if (!pair) continue;
      var key = pair[1], value = pair[2];
      if (Object.prototype.hasOwnProperty.call(metrics, key)) key = metrics[key];
      else if (key === 'Trend') key = 'الاتجاه';
      else if (key === 'Cohort') key = 'مجموعة البيانات';
      else if (key === 'Numerator') key = 'البسط';
      else if (key === 'Denominator') key = 'المقام';
      else if (key === 'Reason') key = 'السبب';
      else if (key === 'Status') key = 'الحالة';
      value = this._translateLeadingStatus(value, statuses);
      // Rule status inside a numeric rate's brackets; preserve its reason.
      value = value.replace(/\[(RULE_NOT_CONFIGURED|NOT_EVALUABLE|INSUFFICIENT_SAMPLE|UNAVAILABLE|DEFERRED|AVAILABLE|EVALUATED)(?=[:\]])/g,
        function(match, status) { return '[' + statuses[status]; });
      lines[i] = key + ':' + value;
    }
    return 'تقرير HAMZAWE — للعرض الإداري فقط\n' + lines.join('\n');
  },

  _translateLeadingStatus: function(value, labels) {
    var text = String(value || '');
    var match = text.match(/^(\s*)(AVAILABLE|COMPLETE|PARTIAL|DEFERRED|UNAVAILABLE|NOT_EVALUABLE|INSUFFICIENT_SAMPLE|RULE_NOT_CONFIGURED|EVALUATED|UNKNOWN_STATUS)(?=$|\s|[(:])/);
    if (!match) return value;
    return match[1] + labels[match[2]] + text.substring(match[0].length);
  }
};
