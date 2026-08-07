/**
 * Clock
 * غلاف وحيد حول مصدر الوقت الحقيقي (CAS-008). ممنوع استخدام
 * new Date() مباشرة في أي ملف ضمن Domain أو Application.
 *
 * ملاحظة طبقية: رغم أن الوقت الحقيقي مفهومياً تفصيل بيئة تنفيذ
 * (قريب من Infrastructure)، إلا أن Clock مصمم كبدائية عابرة للطبقات
 * (Cross-cutting primitive) يمكن لـ Domain الاعتماد عليها بأمان،
 * لأنها لا تكشف أي تفصيل عن Apps Script أو أي منصة.
 */
const Clock = {
  /** @returns {Date} الوقت الحالي الفعلي */
  now() {
    return new Date();
  }
};