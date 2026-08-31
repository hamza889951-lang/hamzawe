/**
 * ═══════════════════════════════════════
 * CONTRACT — EffectiveScheduleService
 * ═══════════════════════════════════════
 * M4-C — single deterministic EffectiveSchedule projection boundary.
 *
 * يضمن:
 * - EffectiveSchedule(scope, localDateTime) من:
 *     Settings baseline (M4-B)
 *   + committed recurring changes
 *   + applicable temporary overrides
 * - read-only، بلا Clock.now داخل الحساب (الزمن دخل صريح).
 * - fail-closed عند مصدر فاسد / تعارض applicable غير معرّف.
 *
 * لا يضمن:
 * - أي mutation أو Availability materialization (M4-D).
 */
const EffectiveScheduleService = {

  TIMEZONE: 'Asia/Baghdad',

  DAY_KEYS: [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday'
  ],

  /**
   * @param {Object} controlContext — M4-A controlContext
   * @param {string} localDateTime — 'YYYY-MM-DDTHH:mm' Asia/Baghdad
   * @returns {Result}
   */
  projectAt: function(controlContext, localDateTime) {
    var scopeResult = this._scopeFromControlContext(controlContext);
    if (!scopeResult.ok) return scopeResult;

    var atResult = this.parseLocalDateTime(localDateTime);
    if (!atResult.ok) return atResult;

    var baselineResult = DoctorScheduleReadService.readCurrentEffectiveSchedule(controlContext);
    if (!baselineResult.ok) return baselineResult;

    var listResult = ScheduleChangeRepository.listByScopeResult(
      scopeResult.data.doctorId,
      scopeResult.data.clinicId
    );
    if (!listResult.ok) return listResult;

    return this.projectFromSources(
      scopeResult.data,
      atResult.data,
      baselineResult.data,
      listResult.data
    );
  },

  /**
   * Pure projection over already-loaded sources (no I/O).
   * Reusable by M4-D once it supplies the same sources.
   */
  projectFromSources: function(scope, at, baseline, records) {
    var activeResult = this._activeRecords(records, at.stamp);
    if (!activeResult.ok) return activeResult;
    var active = activeResult.data;

    var recurringResult = this._effectiveRecurring(baseline, active, at.stamp);
    if (!recurringResult.ok) return recurringResult;
    var recurring = recurringResult.data;

    var overrideResult = this._applicableTemporary(active, at.stamp);
    if (!overrideResult.ok) return overrideResult;
    var override = overrideResult.data;

    var weekday = this._weekdaySunday0(at.year, at.month, at.day);
    var dayKey = this.DAY_KEYS[weekday];
    var dayOpen = recurring.days[dayKey] === true;
    var inWindow = this._minutesInWindow(at.minutes, recurring.workWindow);

    var intervalIntent = 'CLOSED';
    if (dayOpen && inWindow) intervalIntent = 'WORKING';

    if (override) {
      if (override.changeKind === ScheduleChangeRepository.KIND.TEMPORARY_CLOSE) {
        intervalIntent = 'CLOSED';
      } else if (override.changeKind === ScheduleChangeRepository.KIND.TEMPORARY_OPEN) {
        var ow = override.payload && override.payload.workWindow;
        if (!ow) {
          return Result.fail(
            'SCHEDULE_CHANGE_SOURCE_INVALID',
            'Exceptional open override is missing workWindow',
            { changeId: override.changeId }
          );
        }
        intervalIntent = this._minutesInWindow(at.minutes, ow) ? 'EXCEPTIONAL_OPEN' : 'CLOSED';
      }
    }

    return Result.ok({
      scope: {
        doctorId: scope.doctorId,
        clinicId: scope.clinicId
      },
      at: at.normalized,
      timezone: this.TIMEZONE,
      source: recurring.sourceChangeId ? 'RECURRING_CHANGE' : 'SETTINGS',
      recurrence: 'WEEKLY',
      days: recurring.days,
      workWindow: recurring.workWindow,
      slotDurationMinutes: recurring.slotDurationMinutes,
      interval: {
        intent: intervalIntent,
        appliedOverrideChangeId: override ? override.changeId : null,
        appliedRecurringChangeId: recurring.sourceChangeId || null
      }
    });
  },

  parseLocalDateTime: function(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
      return Result.fail(
        'INVALID_LOCAL_DATETIME',
        'localDateTime must be YYYY-MM-DDTHH:mm in Asia/Baghdad'
      );
    }
    var datePart = value.substring(0, 10);
    var timePart = value.substring(11);
    var y = parseInt(datePart.substring(0, 4), 10);
    var m = parseInt(datePart.substring(5, 7), 10);
    var d = parseInt(datePart.substring(8, 10), 10);
    var hh = parseInt(timePart.substring(0, 2), 10);
    var mm = parseInt(timePart.substring(3, 5), 10);
    if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) {
      return Result.fail('INVALID_LOCAL_DATETIME', 'localDateTime is out of range');
    }
    if (!this._isRealCalendarDate(y, m, d)) {
      return Result.fail('INVALID_LOCAL_DATETIME', 'localDateTime is not a real calendar date');
    }
    return Result.ok({
      year: y,
      month: m,
      day: d,
      hour: hh,
      minute: mm,
      minutes: hh * 60 + mm,
      stamp: value,
      normalized: value
    });
  },

  compareStamps: function(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  },

  _scopeFromControlContext: function(controlContext) {
    if (!controlContext || typeof controlContext !== 'object') {
      return Result.fail(
        'INVALID_CONTROL_CONTEXT',
        'EffectiveSchedule requires a control context from M4-A'
      );
    }
    var actorId = controlContext.actorId;
    if (typeof actorId !== 'string' || !actorId) {
      return Result.fail(
        'INVALID_CONTROL_CONTEXT',
        'EffectiveSchedule requires controlContext.actorId'
      );
    }
    var clinicId = null;
    if (controlContext.scope &&
        Object.prototype.hasOwnProperty.call(controlContext.scope, 'clinicId') &&
        controlContext.scope.clinicId !== undefined) {
      clinicId = controlContext.scope.clinicId;
    }
    return Result.ok({
      doctorId: actorId,
      clinicId: clinicId
    });
  },

  /**
   * Records that still apply at `atStamp`.
   * A CANCEL excludes its target only when atStamp >= cancel.effectiveFrom.
   * Earlier instants keep the historical meaning of the target.
   */
  _activeRecords: function(records, atStamp) {
    if (!records) return Result.ok([]);
    if (typeof atStamp !== 'string' || !atStamp) {
      return Result.fail(
        'INVALID_LOCAL_DATETIME',
        'Active-record projection requires an explicit local datetime'
      );
    }
    var cancelled = {};
    var i;
    for (i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec || !rec.changeId) {
        return Result.fail(
          'SCHEDULE_CHANGE_SOURCE_INVALID',
          'Schedule change record is missing changeId'
        );
      }
      if (rec.payload && rec.payload.__malformed) {
        return Result.fail(
          'SCHEDULE_CHANGE_SOURCE_INVALID',
          'Schedule change payload is malformed',
          { changeId: rec.changeId }
        );
      }
      if (rec.changeKind === ScheduleChangeRepository.KIND.CANCEL && rec.targetChangeId) {
        if (!rec.effectiveFrom) {
          return Result.fail(
            'SCHEDULE_CHANGE_SOURCE_INVALID',
            'CANCEL record is missing effectiveFrom',
            { changeId: rec.changeId }
          );
        }
        if (this.compareStamps(rec.effectiveFrom, atStamp) <= 0) {
          cancelled[rec.targetChangeId] = true;
        }
      }
    }
    var active = [];
    for (i = 0; i < records.length; i++) {
      var item = records[i];
      if (item.changeKind === ScheduleChangeRepository.KIND.CANCEL) continue;
      if (cancelled[item.changeId]) continue;
      active.push(item);
    }
    return Result.ok(active);
  },

  _effectiveRecurring: function(baseline, active, atStamp) {
    var chosen = null;
    for (var i = 0; i < active.length; i++) {
      var rec = active[i];
      if (rec.changeKind !== ScheduleChangeRepository.KIND.RECURRING) continue;
      if (!rec.effectiveFrom) {
        return Result.fail(
          'SCHEDULE_CHANGE_SOURCE_INVALID',
          'Recurring change is missing effectiveFrom',
          { changeId: rec.changeId }
        );
      }
      if (this.compareStamps(rec.effectiveFrom, atStamp) > 0) continue;
      if (!chosen || this.compareStamps(rec.effectiveFrom, chosen.effectiveFrom) > 0) {
        chosen = rec;
      } else if (chosen && rec.effectiveFrom === chosen.effectiveFrom) {
        return Result.fail(
          'SCHEDULE_INTENT_CONFLICT',
          'Two recurring changes share the same effectiveFrom',
          { changeIds: [chosen.changeId, rec.changeId] }
        );
      }
    }
    if (!chosen) {
      return Result.ok({
        days: baseline.days,
        workWindow: baseline.workWindow,
        slotDurationMinutes: baseline.slotDurationMinutes,
        sourceChangeId: null
      });
    }
    var payload = chosen.payload || {};
    if (!payload.days || !payload.workWindow || typeof payload.slotDurationMinutes !== 'number') {
      return Result.fail(
        'SCHEDULE_CHANGE_SOURCE_INVALID',
        'Recurring change payload is incomplete',
        { changeId: chosen.changeId }
      );
    }
    return Result.ok({
      days: payload.days,
      workWindow: payload.workWindow,
      slotDurationMinutes: payload.slotDurationMinutes,
      sourceChangeId: chosen.changeId
    });
  },

  _applicableTemporary: function(active, atStamp) {
    var matches = [];
    for (var i = 0; i < active.length; i++) {
      var rec = active[i];
      if (rec.changeKind !== ScheduleChangeRepository.KIND.TEMPORARY_CLOSE &&
          rec.changeKind !== ScheduleChangeRepository.KIND.TEMPORARY_OPEN) {
        continue;
      }
      if (!rec.effectiveFrom || !rec.effectiveTo) {
        return Result.fail(
          'SCHEDULE_CHANGE_SOURCE_INVALID',
          'Temporary override requires effectiveFrom and effectiveTo',
          { changeId: rec.changeId }
        );
      }
      // Half-open [effectiveFrom, effectiveTo)
      if (this.compareStamps(rec.effectiveFrom, atStamp) <= 0 &&
          this.compareStamps(atStamp, rec.effectiveTo) < 0) {
        matches.push(rec);
      }
    }
    if (matches.length === 0) return Result.ok(null);
    if (matches.length > 1) {
      return Result.fail(
        'SCHEDULE_INTENT_CONFLICT',
        'Multiple temporary overrides apply at the requested instant',
        {
          changeIds: matches.map(function(m) { return m.changeId; })
        }
      );
    }
    return Result.ok(matches[0]);
  },

  _minutesInWindow: function(minutes, window) {
    if (!window || typeof window.start !== 'string' || typeof window.end !== 'string') {
      return false;
    }
    var start = this._clockToMinutes(window.start);
    var end = this._clockToMinutes(window.end);
    if (start === null || end === null) return false;
    return minutes >= start && minutes < end;
  },

  _clockToMinutes: function(clock) {
    if (typeof clock !== 'string' || !/^\d{1,2}:\d{2}$/.test(clock.trim())) return null;
    var parts = clock.trim().split(':');
    var hour = parseInt(parts[0], 10);
    var minute = parseInt(parts[1], 10);
    if (hour > 23 || minute > 59) return null;
    return hour * 60 + minute;
  },

  _weekdaySunday0: function(year, month, day) {
    var y = year;
    var m = month;
    var t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    if (m < 3) y -= 1;
    return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + t[m - 1] + day) % 7;
  },

  _isRealCalendarDate: function(year, month, day) {
    var dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var leap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    if (leap) dim[1] = 29;
    return day <= dim[month - 1];
  }
};
