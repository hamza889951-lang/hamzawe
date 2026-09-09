/**
 * ═══════════════════════════════════════
 * CONTRACT — LegacySlotTimeParser
 * ═══════════════════════════════════════
 * ⚠️ ملف مؤقت بالكامل (ADR-016).
 * يضمن:
 * - تحويل قيمة sort_key بأي شكل صادر عن المولّد الحالي (نص رقمي بصيغة
 *   YYYYMMDDHHmm، أو Date، أو رقم Epoch) إلى Timestamp قابل للمقارنة
 *   فعليًا مع Clock.now().getTime() (Epoch ms حقيقي).
 * - تفسير YYYYMMDDHHmm كوقت محلي لمنطقة المشروع التشغيلية، وليس كوقت
 *   المنطقة الزمنية للمضيف الذي يشغّل الاختبار أو الكود.
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
 * إن طابق، يُفكَّك فعليًا إلى سنة/شهر/يوم/ساعة/دقيقة ويُبنى منه Epoch
 * مع احترام timezone المشروع التشغيلي. إن لم يطابق (13 رقمًا مثلاً،
 * أو خارج مدى سنوات معقول)، يُفترض أنه Epoch حقيقي بالفعل كما كان
 * سابقًا — لا تغيير على هذا المسار.
 *
 * ⚠️ افتراض بيئي: Session.getScriptTimeZone() يجب أن يطابق المنطقة
 * الزمنية التشغيلية للمشروع. في HAMZAWE هي Asia/Baghdad.
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

    return LegacySlotTimeParser._fromProjectLocalTime(year, month - 1, day, hour, minute);
  },

  /**
   * Converts a project-local wall-clock value into a real Epoch timestamp
   * without inheriting the host/server timezone.
   */
  _fromProjectLocalTime(year, monthIndex, day, hour, minute) {
    const baseUtcMs = Date.UTC(year, monthIndex, day, hour, minute, 0, 0);

    if (typeof Session === 'undefined' || typeof Session.getScriptTimeZone !== 'function' ||
      typeof Utilities === 'undefined' || typeof Utilities.formatDate !== 'function') {
      // Backward-compatible fallback for non-Apps-Script harnesses that do
      // not expose project timezone services.
      return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
    }

    const timeZone = Session.getScriptTimeZone();
    if (!timeZone) {
      return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
    }

    const rendered = Utilities.formatDate(
      new Date(baseUtcMs),
      timeZone,
      'yyyy-MM-dd HH:mm'
    );
    const match = rendered.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    if (!match) {
      return new Date(year, monthIndex, day, hour, minute, 0, 0).getTime();
    }

    const renderedAsUtcMs = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
      0
    );
    const offsetMs = renderedAsUtcMs - baseUtcMs;
    return baseUtcMs - offsetMs;
  }
};