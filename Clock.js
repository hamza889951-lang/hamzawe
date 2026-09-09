/**
 * Clock
 * غلاف وحيد حول مصدر الوقت الحقيقي (CAS-008). ممنوع استخدام
 * new Date() مباشرة في أي ملف ضمن Domain أو Application.
 *
 * ملاحظة طبقية: رغم أن الوقت الحقيقي مفهومياً تفصيل بيئة تنفيذ
 * (قريب من Infrastructure)، إلا أن Clock مصمم كبدائية عابرة للطبقات
 * (Cross-cutting primitive) يمكن لـ Domain الاعتماد عليها بأمان،
 * لأنها لا تكشف أي تفصيل عن Apps Script أو أي منصة.
 *
 * Testability / evaluation-order seam:
 * إذا وُجد pre-bound globalThis.Clock يوفّر now() قبل تقييم هذا الملف،
 * يُعاد استخدامه. هذا لا يغيّر سلوك الإنتاج: في HAMZAWE لا يوجد هذا
 * binding المسبق، فيبقى المصدر الحقيقي هو new Date(). وتحتاج اختبارات
 * الـVM التي تعيد محاكاة ترتيب clasp إلى هذا السلوك كي لا تستبدل الساعة
 * المحقونة بساعة النظام أثناء تحميل Clock.js.
 */
const Clock = (typeof globalThis !== 'undefined' && globalThis.Clock &&
  typeof globalThis.Clock.now === 'function')
  ? globalThis.Clock
  : {
      /** @returns {Date} الوقت الحالي الفعلي */
      now() {
        return new Date();
      }
    };