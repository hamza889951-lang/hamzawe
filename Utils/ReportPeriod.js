/**
 * ReportPeriod — M1-B (PHASE 1.3 — REPORT CONSUMERS)
 *
 * Pure clinic-local calendar arithmetic for report periods. This module
 * owns the ONE frozen M1-B period contract shared by Daily / Weekly /
 * Monthly reports:
 *
 *   clinic-local wall-clock boundary  →  instant (canonical epoch ms)
 *   start INCLUSIVE, end EXCLUSIVE (never 23:59:59.999)
 *
 * ─── FROZEN M1-B TIMEZONE CONTRACT ───
 *   CLINIC_TIME_ZONE            = 'Asia/Baghdad'
 *   CLINIC_UTC_OFFSET_MINUTES   = 180 (UTC+3)
 *
 *   Rationale (from the existing project contract, not invented here):
 *   appsscript.json pins the script timezone to Asia/Baghdad, and
 *   Iraq has observed UTC+3 year-round since 2008 (no DST), so a fixed
 *   offset is exact. Materializing the clinic timezone as an EXPLICIT
 *   constant makes wall-clock → instant conversion deterministic in
 *   every realm (Apps Script production, Node tests) with zero
 *   dependence on Session, host locale, script locale, or browser
 *   defaults. The offset is fixed, so a clinic-local calendar day is
 *   exactly 24h in canonical epoch ms.
 *
 * ─── FROZEN M1-B WEEK CONTRACT ───
 *   WEEK_STARTS_ON = 6 (Saturday; 0 = Sunday … 6 = Saturday)
 *
 *   The clinic week runs Saturday → Friday (Iraq / Asia-Baghdad
 *   calendar, consistent with the Settings working-day grid
 *   sunday…saturday consumed by SlotGenerator). The week start is an
 *   explicit frozen constant — NEVER derived from locale, culture
 *   defaults, or the executing environment — and is proven by tests
 *   (week grid, week transitions, contiguity).
 *
 * ─── LAYERING ───
 *   Pure utility: operates ONLY on values passed to it. No Clock (the
 *   current time is injected by Application callers), no repositories,
 *   no Apps Script services (no Session/Utilities), no current-time
 *   Date construction — Dates are built only from explicitly passed
 *   epoch-ms values (pure field arithmetic, the same documented
 *   discipline as LegacySlotTimeParser). Returns Result (project
 *   contract). clasp evaluates files alphabetically; this file has no
 *   cross-module references at all, so evaluation order is irrelevant
 *   here.
 */
const ReportPeriod = {

  // ─── Frozen M1-B constants ─────────────────────────────────────
  CLINIC_TIME_ZONE: 'Asia/Baghdad',
  CLINIC_UTC_OFFSET_MINUTES: 180, // UTC+3, no DST since 2008
  WEEK_STARTS_ON: 6,              // Saturday (0 = Sunday … 6 = Saturday)

  REPORT_TYPES: {
    DAILY: 'DAILY',
    WEEKLY: 'WEEKLY',
    MONTHLY: 'MONTHLY'
  },

  MINUTE_MS: 60000,
  HOUR_MS: 3600000,
  DAY_MS: 86400000,

  PERIOD_SEMANTICS:
    'start inclusive, end exclusive (clinic-local wall-clock boundaries converted to canonical epoch-ms instants)',

  // ─── Wall-clock ↔ instant primitives ───────────────────────────

  /**
   * Instant (epoch ms) → "wall clock read as UTC" ms. Reading the UTC
   * fields of this value yields the clinic-local wall-clock fields.
   * Pure arithmetic; valid because the clinic offset is fixed.
   * @param {number} instantMs
   * @returns {number}
   */
  toWallMs: function(instantMs) {
    return instantMs + this.CLINIC_UTC_OFFSET_MINUTES * this.MINUTE_MS;
  },

  /**
   * "Wall clock read as UTC" ms → instant (epoch ms).
   * @param {number} wallMs
   * @returns {number}
   */
  fromWallMs: function(wallMs) {
    return wallMs - this.CLINIC_UTC_OFFSET_MINUTES * this.MINUTE_MS;
  },

  /**
   * Clinic-local wall-clock calendar fields of an instant.
   * @param {number} instantMs
   * @returns {{year:number, month:number(1-12), day:number, hour:number, minute:number, second:number, weekday:number(0=Sunday..6=Saturday)}}
   */
  wallFields: function(instantMs) {
    var wall = new Date(this.toWallMs(instantMs));
    return {
      year: wall.getUTCFullYear(),
      month: wall.getUTCMonth() + 1,
      day: wall.getUTCDate(),
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
      second: wall.getUTCSeconds(),
      weekday: wall.getUTCDay()
    };
  },

  /**
   * Clinic-local wall-clock instant → ISO-like string with explicit
   * fixed offset, e.g. '2026-08-24T00:00:00+03:00'. Built by pure
   * string arithmetic (no Utilities/Session dependency).
   * @param {number} instantMs
   * @returns {string}
   */
  formatWallClock: function(instantMs) {
    var f = this.wallFields(instantMs);
    return this._pad(f.year, 4) + '-' + this._pad(f.month, 2) + '-' +
      this._pad(f.day, 2) + 'T' + this._pad(f.hour, 2) + ':' +
      this._pad(f.minute, 2) + ':' + this._pad(f.second, 2) +
      this._offsetString();
  },

  _offsetString: function() {
    var sign = this.CLINIC_UTC_OFFSET_MINUTES < 0 ? '-' : '+';
    var abs = Math.abs(this.CLINIC_UTC_OFFSET_MINUTES);
    return sign + this._pad(Math.floor(abs / 60), 2) + ':' + this._pad(abs % 60, 2);
  },

  _pad: function(value, width) {
    var out = String(Math.trunc(Math.abs(value)));
    while (out.length < width) out = '0' + out;
    return value < 0 ? '-' + out : out;
  },

  /**
   * Clinic-local wall-clock (y, m(1-12), d, h, min) → instant (epoch ms).
   * The inverse of wallFields; the composition law of this module.
   * @param {number} year
   * @param {number} month 1-12
   * @param {number} day
   * @param {number} [hour=0]
   * @param {number} [minute=0]
   * @returns {number}
   */
  instantOf: function(year, month, day, hour, minute) {
    return this.fromWallMs(Date.UTC(
      year, month - 1, day, hour || 0, minute || 0, 0, 0
    ));
  },

  // ─── Input validation ──────────────────────────────────────────

  /**
   * Accepts a Date or finite epoch-ms number; returns epoch ms or null.
   * Strings are rejected (no ambiguous parsing — same discipline as
   * MetricsService._toEpochMs).
   * @param {Date|number} value
   * @returns {number|null}
   */
  toInstantMs: function(value) {
    if (value instanceof Date) {
      var ms = value.getTime();
      return isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number' && isFinite(value)) return value;
    return null;
  },

  // ─── Calendar periods (each: start inclusive, end exclusive) ──

  /**
   * One clinic-local calendar day containing the reference instant.
   * start = start of the clinic-local day; end = start of the
   * FOLLOWING clinic-local day (never 23:59:59.999).
   * @param {Date|number} reference
   * @returns {Result} ok({startMs, endMs}) | fail(REPORT_PERIOD_INVALID)
   */
  dailyPeriod: function(reference) {
    var refMs = this.toInstantMs(reference);
    if (refMs === null) {
      return Result.fail(
        'REPORT_PERIOD_INVALID',
        'Report reference must be a Date or finite epoch-ms value',
        { reference: reference }
      );
    }
    var wall = new Date(this.toWallMs(refMs));
    var dayStartWall = Date.UTC(
      wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 0, 0, 0, 0
    );
    var startMs = this.fromWallMs(dayStartWall);
    return Result.ok({ startMs: startMs, endMs: startMs + this.DAY_MS });
  },

  /**
   * The clinic-local calendar week (Saturday → Friday, frozen M1-B
   * contract) containing the reference instant. 7 × 24h exactly; the
   * week start is always a day start on the same clinic-local grid.
   * @param {Date|number} reference
   * @returns {Result} ok({startMs, endMs}) | fail(REPORT_PERIOD_INVALID)
   */
  weeklyPeriod: function(reference) {
    var refMs = this.toInstantMs(reference);
    if (refMs === null) {
      return Result.fail(
        'REPORT_PERIOD_INVALID',
        'Report reference must be a Date or finite epoch-ms value',
        { reference: reference }
      );
    }
    var wall = new Date(this.toWallMs(refMs));
    var dayStartWall = Date.UTC(
      wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 0, 0, 0, 0
    );
    var weekday = new Date(dayStartWall).getUTCDay(); // 0=Sunday … 6=Saturday
    var daysSinceWeekStart = (weekday - this.WEEK_STARTS_ON + 7) % 7;
    var weekStartWall = dayStartWall - daysSinceWeekStart * this.DAY_MS;
    var startMs = this.fromWallMs(weekStartWall);
    return Result.ok({ startMs: startMs, endMs: startMs + 7 * this.DAY_MS });
  },

  /**
   * The clinic-local calendar month containing the reference instant.
   * start = first day of month 00:00 clinic-local; end = first day of
   * the NEXT month 00:00 clinic-local (never last-day 23:59:59.999).
   * Date.UTC rolls month 12 / year boundaries over automatically.
   * @param {Date|number} reference
   * @returns {Result} ok({startMs, endMs}) | fail(REPORT_PERIOD_INVALID)
   */
  monthlyPeriod: function(reference) {
    var refMs = this.toInstantMs(reference);
    if (refMs === null) {
      return Result.fail(
        'REPORT_PERIOD_INVALID',
        'Report reference must be a Date or finite epoch-ms value',
        { reference: reference }
      );
    }
    var wall = new Date(this.toWallMs(refMs));
    var year = wall.getUTCFullYear();
    var monthIndex = wall.getUTCMonth();
    var startMs = this.fromWallMs(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
    var endMs = this.fromWallMs(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
    return Result.ok({ startMs: startMs, endMs: endMs });
  },

  /**
   * Dispatch: report type → its period constructor.
   * @param {string} reportType one of ReportPeriod.REPORT_TYPES
   * @param {Date|number} reference
   * @returns {Result} ok({startMs, endMs}) | fail(REPORT_TYPE_UNKNOWN | REPORT_PERIOD_INVALID)
   */
  periodFor: function(reportType, reference) {
    if (reportType === this.REPORT_TYPES.DAILY) return this.dailyPeriod(reference);
    if (reportType === this.REPORT_TYPES.WEEKLY) return this.weeklyPeriod(reference);
    if (reportType === this.REPORT_TYPES.MONTHLY) return this.monthlyPeriod(reference);
    return Result.fail(
      'REPORT_TYPE_UNKNOWN',
      'Unknown report type: ' + reportType,
      { requested: reportType, available: Object.keys(this.REPORT_TYPES) }
    );
  },

  // ─── Period description (report DTO metadata) ─────────────────

  /**
   * Human/provenance metadata describing a period on the clinic-local
   * wall clock. Pure; recomputable from startMs/endMs alone.
   * @param {string} reportType
   * @param {{startMs:number, endMs:number}} period
   * @returns {{timeZone, utcOffsetMinutes, periodSemantics, startWallClock, endWallClock, wallClock:{start,end}, weekStartsOn?}}
   */
  describe: function(reportType, period) {
    var meta = {
      timeZone: this.CLINIC_TIME_ZONE,
      utcOffsetMinutes: this.CLINIC_UTC_OFFSET_MINUTES,
      periodSemantics: this.PERIOD_SEMANTICS,
      startWallClock: this.formatWallClock(period.startMs),
      endWallClock: this.formatWallClock(period.endMs),
      wallClock: {
        start: this.wallFields(period.startMs),
        end: this.wallFields(period.endMs)
      }
    };
    if (reportType === this.REPORT_TYPES.WEEKLY) {
      // Explicit frozen week-start provenance on weekly reports.
      meta.weekStartsOn = this.WEEK_STARTS_ON;
    }
    return meta;
  }
};
