/**
 * ═══════════════════════════════════════
 * CONTRACT — DateUtils
 * ═══════════════════════════════════════
 * Canonical clinic-local representations:
 *   date       YYYY-MM-DD
 *   time       HH:mm (24-hour)
 *   local stamp YYYY-MM-DDTHH:mm
 * Absolute instants remain epoch milliseconds / Date values.
 *
 * Legacy inputs are normalized at this boundary only when their shape is
 * unambiguous. Invalid or ambiguous strings are rejected (null / '') rather
 * than guessed. Current time remains the sole responsibility of Clock.now().
 */
const DateUtils = {
  CLINIC_TIME_ZONE: 'Asia/Baghdad',

  _isDate(value) {
    return Object.prototype.toString.call(value) === '[object Date]' &&
      !isNaN(value.getTime());
  },

  _validDateParts(year, month, day) {
    if (year < 1 || month < 1 || month > 12 || day < 1) return false;
    var leap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return day <= days[month - 1];
  },

  _normalizeDateString(value) {
    if (typeof value !== 'string') return null;
    var match = value.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
    if (!match) return null;
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    if (!DateUtils._validDateParts(year, month, day)) return null;
    return match[1] + '-' + match[2] + '-' + match[3];
  },

  /**
   * Normalize an unambiguous date-only value to YYYY-MM-DD.
   * Date objects are interpreted in the clinic timezone; strings must be
   * YYYY-MM-DD or the known legacy YYYY/MM/DD shape.
   */
  normalizeDate(value) {
    if (DateUtils._isDate(value)) {
      return Utilities.formatDate(value, DateUtils.CLINIC_TIME_ZONE, 'yyyy-MM-dd');
    }
    return DateUtils._normalizeDateString(value);
  },

  /**
   * Normalize an unambiguous time-only value to 24-hour HH:mm.
   * Date objects are interpreted in the clinic timezone. Strings accept
   * HH:mm or HH:mm:ss only; locale-dependent values are not guessed.
   */
  normalizeTime(value) {
    if (DateUtils._isDate(value)) {
      return Utilities.formatDate(value, DateUtils.CLINIC_TIME_ZONE, 'HH:mm');
    }
    if (typeof value !== 'string') return null;
    var match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!match) return null;
    var hour = Number(match[1]);
    var minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return (hour < 10 ? '0' : '') + hour + ':' + match[2];
  },

  /**
   * Normalize local wall-clock date/time to YYYY-MM-DDTHH:mm.
   * No timezone offset is implied by this value.
   */
  normalizeLocalDateTime(value) {
    if (DateUtils._isDate(value)) {
      return DateUtils.normalizeDate(value) + 'T' + DateUtils.normalizeTime(value);
    }
    if (typeof value !== 'string') return null;
    var text = value.trim();
    var match = text.match(/^(\d{4}[-/]\d{2}[-/]\d{2})[T ](\d{1,2}:\d{2})(?::\d{2})?$/);
    if (!match) return null;
    var date = DateUtils._normalizeDateString(match[1]);
    var time = DateUtils.normalizeTime(match[2]);
    return date && time ? date + 'T' + time : null;
  },

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
   * Invalid or absent values return null. This is an instant conversion,
   * not a local wall-clock date/time parser.
   */
  toEpochMs(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
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

  /** Format a Date as clinic-local YYYY-MM-DD. */
  formatClinicDate(dateValue) {
    if (!DateUtils._isDate(dateValue)) return '';
    return Utilities.formatDate(dateValue, DateUtils.CLINIC_TIME_ZONE, 'yyyy-MM-dd');
  },

  /** Format an epoch millisecond value as clinic-local YYYY-MM-DD. */
  formatClinicDateFromEpoch(timestampMs) {
    if (timestampMs === null || timestampMs === undefined) return '';
    var numeric = Number(timestampMs);
    if (!isFinite(numeric)) return '';
    return DateUtils.formatClinicDate(new Date(numeric));
  },

  /** Return the clinic-local calendar date N*24h before a supplied Date. */
  clinicDateDaysAgo(dateValue, days) {
    if (!DateUtils._isDate(dateValue)) return '';
    return DateUtils.formatClinicDate(
      new Date(dateValue.getTime() - Number(days) * 24 * 60 * 60 * 1000)
    );
  },

  /** Display format is canonical too: YYYY-MM-DD. */
  formatDateDisplay(dateValue) {
    return DateUtils.normalizeDate(dateValue) || '';
  },

  /** Display format is canonical too: HH:mm. */
  formatTimeDisplay(timeValue) {
    return DateUtils.normalizeTime(timeValue) || '';
  }
};

/** Preserve the existing legacy storage contract YYYY/MM/DD. */
DateUtils.formatDateForStorage = function(dateValue) {
  var date = DateUtils.normalizeDate(dateValue);
  return date ? date.replace(/-/g, '/') : '';
};

/** Preserve the existing storage contract HH:mm. */
DateUtils.formatTimeForStorage = function(timeValue) {
  return DateUtils.normalizeTime(timeValue) || '';
};

/** Canonical operational sort key: YYYYMMDDHHmm. */
DateUtils.formatSortKey = function(dateValue) {
  var date = DateUtils.normalizeDate(dateValue);
  var time = DateUtils.normalizeTime(dateValue);
  return date && time ? date.replace(/-/g, '') + time.replace(':', '') : '';
};

/** Canonical local wall-clock stamp: YYYY-MM-DDTHH:mm. */
DateUtils.formatLocalStamp = function(dateValue) {
  return DateUtils.normalizeLocalDateTime(dateValue) || '';
};

/** Next calendar date for a canonical YYYY-MM-DD string. */
DateUtils.nextLocalDateString = function(dateStr) {
  var normalized = DateUtils.normalizeDate(dateStr);
  if (!normalized) return null;
  var y = Number(normalized.substring(0, 4));
  var m = Number(normalized.substring(5, 7));
  var d = Number(normalized.substring(8, 10));
  d += 1;
  var daysInMonth = [31, ((y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0)) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d > daysInMonth[m - 1]) {
    d = 1;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  var mm = m < 10 ? '0' + m : String(m);
  var dd = d < 10 ? '0' + d : String(d);
  return y + '-' + mm + '-' + dd;
};
