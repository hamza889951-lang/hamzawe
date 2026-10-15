/**
 * DoctorReportService — authorized doctor report orchestration.
 *
 * Boundary:
 * - Called only from DoctorControlInteractionService, which is reached
 *   through Router -> DoctorAuthorizationService -> DoctorControlEntry.
 * - Composes the canonical M3 report once and chooses FULL or its SUMMARY
 *   projection. Does not read repositories, mutate state, or send messages.
 * - WhatsApp delivery remains owned by Webhook/MessagingPolicyService.
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

    // One reference instant is shared by M1 and M2 through M3.
    var reference = Clock.now();
    var fullResult = EnhancedReportService.generateFull(reportType, reference);
    if (!fullResult.ok) return fullResult;

    var model = fullResult.data;
    if (representation === 'SUMMARY') {
      model = EnhancedReportService.project(model);
    }

    var rendered = EnhancedReportRenderer.render(model);
    if (!rendered.ok) return rendered;

    return Result.ok({
      reportType: reportType,
      representation: representation,
      availability: model.availability ? model.availability.status : null,
      reply: this._arabicPresentation(rendered.data)
    });
  },

  // Presentation-only vocabulary mapping. Values, statuses, reasons and
  // provenance remain intact; this does not infer or recalculate metrics.
  _arabicPresentation: function(text) {
    var labels = {
      'ENHANCED REPORT (FULL)': 'التقرير الإداري الكامل',
      'ENHANCED REPORT (SUMMARY)': 'ملخص التقرير الإداري',
      'REPORT PERIOD': 'فترة التقرير',
      'AVAILABILITY': 'توفر البيانات',
      'COMPLETE': 'مكتمل',
      'PARTIAL': 'جزئي',
      'UNAVAILABLE': 'غير متاح',
      'AVAILABLE': 'متاح',
      'NOT_EVALUABLE': 'غير قابل للتقييم',
      'RULE_NOT_CONFIGURED': 'سياسة التقييم غير مهيأة',
      '— M1 METRICS —': '— مؤشرات التشغيل —',
      '— M2 RATES —': '— معدلات الإدارة —',
      '— RULES —': '— قواعد التقييم —',
      '— INSIGHTS —': '— الاستنتاجات —',
      '— TREND —': '— الاتجاه —',
      '— DATA QUALITY —': '— جودة البيانات —',
      'DAILY': 'يومي',
      'WEEKLY': 'أسبوعي',
      'MONTHLY': 'شهري',
      'CANCELLATION_RATE': 'معدل الإلغاء',
      'CHANGE_RATE': 'معدل تغيير الموعد',
      'COMPLETION_RATE': 'معدل إكمال المواعيد',
      'NO_SHOW_RATE': 'معدل عدم الحضور',
      'BOOKING_COUNT': 'عدد الحجوزات',
      'CANCELLATION_COUNT': 'عدد الإلغاءات',
      'CHANGE_COUNT': 'عدد التغييرات',
      'COMPLETION_COUNT': 'عدد المواعيد المكتملة',
      'NO_SHOW_COUNT': 'عدد حالات عدم الحضور',
      'Management Notes': 'ملاحظات إدارية',
      'Trend': 'الاتجاه',
      'Cohort': 'مجموعة البيانات',
      'Numerator': 'البسط',
      'Denominator': 'المقام',
      'Reason': 'السبب',
      'Status': 'الحالة'
    };
    var keys = Object.keys(labels).sort(function(a, b) { return b.length - a.length; });
    var out = String(text || '');
    keys.forEach(function(key) {
      out = out.split(key).join(labels[key]);
    });
    return 'تقرير HAMZAWE — للعرض الإداري فقط\n' + out;
  }
};
