/**
 * ═══════════════════════════════════════
 * CONTRACT — LegacySlotTimeParser
 * ═══════════════════════════════════════
 * ⚠️ ملف مؤقت بالكامل (ADR-016).
 * يضمن:
 * - تحويل قيمة sort_key بأي شكل صادر عن المولّد الحالي (نص رقمي بصيغة
 *   YYYYMMDDHHmm، أو Date، أو رقم Epoch) إلى Timestamp قابل للمقارنة
 *   فعليًا مع Clock.now().getTime() (Epoch ms حقيقي).
 * لا يضمن:
 * - أي معنى دائم لشكل البيانات — يُحذف هذا الملف بالكامل فور إعادة
 *   بناء Generator ليتوافق مع النواة (ADR-016). ليس مرجعاً تصميمياً.
 *
 * سبب الإنشاء: هذا التحويل استُخدم أولاً داخل BookingService، وتكرر
 * الآن في MaintenanceService وSlotSelection. تجنباً لمخالفة CAS-005
 * (عدم التكرار) دون فتح نقاش معماري حول بيانات مؤقتة سيُعاد بناؤها
 * أصلاً، جُمع هنا.
 *
 * ═══════════════════════════════════════
 * إصلاح (اكتُشف عمليًا أثناء الاختبار — SlotSelection.findEarliestBookable
 * كانت تعيد null دائمًا لكل الفتحات)
 * ═══════════════════════════════════════
 * الخلل: القيمة الفعلية لـ sort_key في الشيت رقم بصيغة YYYYMMDDHHmm
 * (مثال: 202608011000)، وليست Epoch. النسخة السابقة من toComparableTime
 * كانت تُعيد أي رقم كما هو دون تفكيكه، فتُقارَن قيمة صغيرة نسبيًا
 * (~2 × 10^11) مع Clock.now().getTime() (~1.7 × 10^12) — فتفشل كل
 * مقارنة >= cutoff دائمًا، بغض النظر عن التاريخ الفعلي للفتحة.
 *
 * الإصلاح: قبل افتراض أن أي رقم/نص رقمي هو Epoch جاهز، يُفحص أولاً هل
 * يطابق صيغة YYYYMMDDHHmm بالضبط (12 رقمًا، بمكونات تاريخ/وقت صالحة).
 * إن طابق، يُفكَّك فعليًا إلى سنة/شهر/يوم/ساعة/دقيقة ويُبنى منه Date
 * حقيقي عبر new Date(y, m-1, d, h, min) — نفس نمط DateUtils.fromTimestamp
 * (بناء Date من قيمة مُمرَّرة صراحة هو عملية حسابية بحتة، لا استحضارًا
 * للوقت الحالي من النظام، فلا يخالف CAS-008 بنفس المبرر الموثّق هناك).
 * إن لم يطابق (13 رقمًا مثلاً، أو خارج مدى سنوات معقول)، يُفترض أنه
 * Epoch حقيقي بالفعل كما كان سابقًا — لا تغيير على هذا المسار.
 *
 * ⚠️ افتراض بيئي: new Date(y, m-1, d, h, min) يُفسَّر بالمنطقة الزمنية
 * المضبوطة لمشروع Apps Script نفسه (Project Settings ← Time zone).
 * يجب أن تكون مضبوطة على المنطقة الزمنية الفعلية للعيادة (Asia/Baghdad
 * حسب عمود timezone في ورقة Settings) لتطابق مقارنتها مع Clock.now()
 * بمعنى "الآن" الفعلي نفسه.
 */
const LegacySlotTimeParser = {
  /**
   * @param {*} value
   * @returns {number|null}
   */
  toComparableTime(value) {
    if (value instanceof Date) return value.getTime();

    if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
      const numeric = Number(value);
      const legacyParsed = LegacySlotTimeParser._parseYYYYMMDDHHmm(numeric);
      if (legacyParsed !== null) return legacyParsed;
      return numeric; // ليست بصيغة YYYYMMDDHHmm — يُفترض Epoch جاهز كما كان سابقًا
    }

    return null;
  },

  /**
   * يفكّك رقمًا بصيغة YYYYMMDDHHmm (12 رقمًا بالضبط) إلى Epoch ms.
   * @param {number} numeric
   * @returns {number|null} null إن لم يطابق الصيغة أو كانت مكوناته غير صالحة
   */
  _parseYYYYMMDDHHmm(numeric) {
    if (!Number.isFinite(numeric) || numeric < 0) return null;

    const str = String(Math.trunc(numeric));
    if (str.length !== 12) return null;

    const year = Number(str.substring(0, 4));
    const month = Number(str.substring(4, 6));
    const day = Number(str.substring(6, 8));
    const hour = Number(str.substring(8, 10));
    const minute = Number(str.substring(10, 12));

    if (year < 2000 || year > 2100) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (hour < 0 || hour > 23) return null;
    if (minute < 0 || minute > 59) return null;

    return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  }
};