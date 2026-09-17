/**
 * ═══════════════════════════════════════
 * CONTRACT — DateUtils
 * ═══════════════════════════════════════
 * Pure date/time conversions only. Current time remains the sole responsibility
 * of Clock.now().
 */
const DateUtils = {
  /**
   * @param {Date} date
   * @param {number} minutes
   * @returns {Date} date copy shifted by minutes
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
  },

  /**
   * Convert a Date / numeric / date-string value to epoch ms.
   * Invalid or absent values return null.
   */
  toEpochMs(value) {
    if (value instanceof Date) {
      var dateMs = value.getTime();
      return isNaN(dateMs) ? null : dateMs;
    }
    if (typeof value === 'number') {
      return isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      var parsedMs = new Date(value).getTime();
      return isNaN(parsedMs) ? null : parsedMs;
    }
    return null;
  },

  /**
   * Format a Date as clinic-local YYYY-MM-DD.
   */
  formatClinicDate(dateValue) {
    if (!dateValue) return '';
    return Utilities.formatDate(dateValue, 'Asia/Baghdad', 'yyyy-MM-dd');
  },

  /**
   * Format an epoch millisecond value as clinic-local YYYY-MM-DD.
   * The Date construction is deliberately kept inside DateUtils so CAS-009
   * callers never construct Date objects from numeric timestamps themselves.
   */
  formatClinicDateFromEpoch(timestampMs) {
    if (timestampMs === null || timestampMs === undefined) return '';
    var numeric = Number(timestampMs);
    if (!isFinite(numeric)) return '';
    return DateUtils.formatClinicDate(new Date(numeric));
  },

  /**
   * Return the clinic-local calendar date N*24h before a supplied Date.
   */
  clinicDateDaysAgo(dateValue, days) {
    if (!(dateValue instanceof Date) || isNaN(dateValue.getTime())) return '';
    return DateUtils.formatClinicDate(
      new Date(dateValue.getTime() - Number(days) * 24 * 60 * 60 * 1000)
    );
  },

  /**
   * Format Date for display as YYYY-MM-DD.
   */
  formatDateDisplay(dateValue) {
    if (!dateValue) return '';
    return Utilities.formatDate(dateValue, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  },

  /**
   * Format Date for display as HH:mm.
   */
  formatTimeDisplay(timeValue) {
    if (!timeValue) return '';
    return Utilities.formatDate(timeValue, Session.getScriptTimeZone(), 'HH:mm');
  }
};

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
