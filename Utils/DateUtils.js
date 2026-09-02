/**
 * ═══════════════════════════════════════
 * CONTRACT — DateUtils
 * ═══════════════════════════════════════
 * يضمن:
 * - عمليات حسابية بحتة على تواريخ/أوقات مُمرَّرة إليه (إضافة دقائق،
 *   بناء Date من Timestamp).
 * لا يضمن:
 * - "الوقت الحالي" — ذلك حصراً من مسؤولية Clock.now().
 * - أي منطق عمل (Business Rules) — عمليات رياضية على التواريخ فقط.
 *
 * ملاحظة طبقية: استخدام new Date() هنا لا يخالف CAS-008 لأن الوظائف
 * تعمل على قيم مُمرَّرة إليها (Pure Functions)، ولا "تجلب" الوقت الحالي
 * من النظام — تماماً كما ورد في تبرير Clock نفسه كـ Cross-cutting primitive.
 */
const DateUtils = {
  /**
   * @param {Date} date
   * @param {number} minutes
   * @returns {Date} تاريخ جديد دون تعديل الأصل
   */
  addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60000);
  },

  /**
   * @param {number} timestampMs
   * @returns {Date}
   */
  fromTimestamp(timestampMs) {
    return new Date(timestampMs);
  }
,/**
   * تنسيق كائن Date (تاريخ فقط) إلى نص مقروء "YYYY-MM-DD" لعرضه للمريض.
   * ⚠️ إضافة جديدة (إصلاح: حقول date/time القادمة من Google Sheets هي
   * كائنات Date خام، ودمجها مباشرة في نص الرد ينتج toString() افتراضيًا
   * غير مقروء). دالة عرض بحتة — لا علاقة لها بأي منطق عمل.
   * @param {Date} dateValue
   * @returns {string}
   */
  formatDateDisplay(dateValue) {
    if (!dateValue) return '';
    return Utilities.formatDate(dateValue, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  },

  /**
   * تنسيق كائن Date (وقت فقط) إلى نص مقروء "HH:mm" لعرضه للمريض.
   * ⚠️ إضافة جديدة — نفس المبرر أعلاه، لحقل time تحديدًا.
   * @param {Date} timeValue
   * @returns {string}
   */
  formatTimeDisplay(timeValue) {
    if (!timeValue) return '';
    return Utilities.formatDate(timeValue, Session.getScriptTimeZone(), 'HH:mm');
  }};
  /**
 * ═══════════════════════════════════════
 * DateUtils.gs — إضافات المولّد (ADR-022)
 * ═══════════════════════════════════════
 *
 * الصق هذا الملف بعد DateUtils الأصلي مباشرة.
 * سيُضيف 3 دوال جديدة إلى الكائن الموجود.
 */
DateUtils.formatDateForStorage = function(dateValue) {
  if (!dateValue) return '';
  var yyyy = dateValue.getFullYear();
  var mm = String(dateValue.getMonth() + 1);
  if (mm.length < 2) mm = '0' + mm;
  var dd = String(dateValue.getDate());
  if (dd.length < 2) dd = '0' + dd;
  return yyyy + '/' + mm + '/' + dd;
};

DateUtils.formatTimeForStorage = function(dateValue) {
  if (!dateValue) return '';
  var hh = String(dateValue.getHours());
  if (hh.length < 2) hh = '0' + hh;
  var mm = String(dateValue.getMinutes());
  if (mm.length < 2) mm = '0' + mm;
  return hh + ':' + mm;
};

DateUtils.formatSortKey = function(dateValue) {
  if (!dateValue) return '';
  var yyyy = dateValue.getFullYear();
  var Mnth = String(dateValue.getMonth() + 1);
  if (Mnth.length < 2) Mnth = '0' + Mnth;
  var dy = String(dateValue.getDate());
  if (dy.length < 2) dy = '0' + dy;
  var hr = String(dateValue.getHours());
  if (hr.length < 2) hr = '0' + hr;
  var mn = String(dateValue.getMinutes());
  if (mn.length < 2) mn = '0' + mn;
  return '' + yyyy + Mnth + dy + hr + mn;
};

/**
 * M4-C Continuation — local schedule stamp 'YYYY-MM-DDTHH:mm'.
 * Pure conversion of a passed-in Date using local getters; production
 * runtime is pinned to Asia/Baghdad (appsscript.json), so this yields
 * the clinic-local stamp used by the M4 schedule boundary.
 */
DateUtils.formatLocalStamp = function(dateValue) {
  if (!dateValue) return '';
  var yyyy = dateValue.getFullYear();
  var mm = String(dateValue.getMonth() + 1);
  if (mm.length < 2) mm = '0' + mm;
  var dd = String(dateValue.getDate());
  if (dd.length < 2) dd = '0' + dd;
  var hh = String(dateValue.getHours());
  if (hh.length < 2) hh = '0' + hh;
  var mn = String(dateValue.getMinutes());
  if (mn.length < 2) mn = '0' + mn;
  return yyyy + '-' + mm + '-' + dd + 'T' + hh + ':' + mn;
};

/**
 * M4-C Continuation — next calendar date for a 'YYYY-MM-DD' string.
 * Pure Gregorian arithmetic (no Date object, no timezone dependency).
 * Single implementation shared by the M4 schedule boundary.
 */
DateUtils.nextLocalDateString = function(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  var y = parseInt(dateStr.substring(0, 4), 10);
  var m = parseInt(dateStr.substring(5, 7), 10);
  var d = parseInt(dateStr.substring(8, 10), 10);
  var dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var leap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
  if (leap) dim[1] = 29;
  if (m < 1 || m > 12 || d < 1 || d > dim[m - 1]) return null;
  d += 1;
  if (d > dim[m - 1]) {
    d = 1;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  var mm = m < 10 ? '0' + m : String(m);
  var dd = d < 10 ? '0' + d : String(d);
  return y + '-' + mm + '-' + dd;
};
