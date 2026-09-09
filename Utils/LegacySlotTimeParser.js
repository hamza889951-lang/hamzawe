/**
 * ═══════════════════════════════════════
 * CONTRACT — LegacySlotTimeParser
 * ═══════════════════════════════════════
 * ⚠️ ملف مؤقت بالكامل (ADR-016).
 * يضمن:
 * - تحويل قيمة sort_key بصيغة YYYYMMDDHHmm إلى Epoch ms حقيقي.
 * - تفسير YYYYMMDDHHmm كوقت عيادة محلي في المنطقة الزمنية الثابتة
 *   للمشروع، لا كوقت المنطقة الزمنية للمضيف.
 * - الحفاظ على أرقام Epoch القديمة كما هي عندما لا تطابق صيغة
 *   YYYYMMDDHHmm.
 * لا يضمن أي معنى دائم لشكل البيانات؛ يُحذف عند إعادة بناء Generator.
 *
 * HAMZAWE frozen timezone contract: Asia/Baghdad = UTC+3، بدون DST.
 * لذلك هذا parser pure ولا يعتمد على Session أو Utilities أو host locale.
 */
const LegacySlotTimeParser = {
  CLINIC_UTC_OFFSET_MINUTES: 180,

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
      return numeric;
    }

    return null;
  },

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

    return Date.UTC(year, month - 1, day, hour, minute, 0, 0) -
      LegacySlotTimeParser.CLINIC_UTC_OFFSET_MINUTES * 60000;
  }
};