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
 * M4-C Continuation (FROZEN CONTRACT v1 — 2026-09-01):
 * - slotDurationMinutes التشغيلية تأتي حصراً من Settings baseline
 *   (configured provenance عبر M4-B). أي slotDurationMinutes داخل
 *   historical recurring payload هي immutable historical data وتُتجاهل
 *   كسلطة تشغيلية — لا تُعاد كتابتها ولا تُستخدم في الإسقاط.
 *
 * M4-D — slot-level availability evaluation:
 * - projectSlotAvailability: evaluates whether a specific slot interval
 *   [slotStart, slotStart + duration) should be operationally available
 *   based on the EffectiveSchedule. Read-only; no mutation.
 * - projectDayEffectiveWindow: returns the effective recurring-level
 *   work window for a given date (used by horizon materialization).
 *
 * لا يضمن:
 * - أي mutation أو Availability materialization (materialization is in
 *   AvailabilityHorizonMaintainer, which calls this service).
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
      // M4-C Continuation §4.2: operational duration is always the
      // configured Settings value carried by the M4-B baseline —
      // never a value from a (historical) schedule change record.
      slotDurationMinutes: baseline.slotDurationMinutes,
      slotDurationSource: 'SETTINGS',
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
        sourceChangeId: null
      });
    }
    var payload = chosen.payload || {};
    // Historical M4-C-v1 payloads may carry slotDurationMinutes; the field
    // is immutable historical data and is IGNORED operationally (§4.2).
    if (!payload.days || !payload.workWindow) {
      return Result.fail(
        'SCHEDULE_CHANGE_SOURCE_INVALID',
        'Recurring change payload is incomplete',
        { changeId: chosen.changeId }
      );
    }
    return Result.ok({
      days: payload.days,
      workWindow: payload.workWindow,
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
  },

  _daysInMonth: function(year, month) {
    var dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var leap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    if (leap) dim[1] = 29;
    return dim[month - 1];
  },

  _pad2: function(n) {
    return n < 10 ? '0' + n : String(n);
  },

  _pad4: function(n) {
    if (n < 10) return '000' + n;
    if (n < 100) return '00' + n;
    if (n < 1000) return '0' + n;
    return String(n);
  },

  _formatStamp: function(year, month, day, hh, mm) {
    return this._pad4(year) + '-' + this._pad2(month) + '-' + this._pad2(day) + 'T' + this._pad2(hh) + ':' + this._pad2(mm);
  },

  /**
   * Compute the stamp for slotStart + durationMinutes.
   * Handles day overflow (midnight crossing) correctly.
   */
  _addMinutesToStamp: function(at, durationMinutes) {
    var totalMin = at.minutes + durationMinutes;
    var year = at.year;
    var month = at.month;
    var day = at.day;

    while (totalMin >= 1440) {
      totalMin -= 1440;
      day += 1;
      var dim = this._daysInMonth(year, month);
      if (day > dim) {
        day = 1;
        month += 1;
        if (month > 12) { month = 1; year += 1; }
      }
    }

    var hh = Math.floor(totalMin / 60);
    var mm = totalMin % 60;
    return this._formatStamp(year, month, day, hh, mm);
  },

  /**
   * M4-D — Evaluate whether a specific slot interval should be
   * operationally available based on the EffectiveSchedule.
   *
   * The slot interval [slotStartStamp, slotStartStamp + slotDurationMinutes)
   * must fall entirely within the effective work interval.
   *
   * @param {Object} controlContext
   * @param {string} slotStartStamp — 'YYYY-MM-DDTHH:mm' Asia/Baghdad
   * @param {number} slotDurationMinutes — configured operational duration
   * @returns {Result} ok({ available: boolean, intent: string })
   */
  projectSlotAvailability: function(controlContext, slotStartStamp, slotDurationMinutes) {
    var scopeResult = this._scopeFromControlContext(controlContext);
    if (!scopeResult.ok) return scopeResult;

    var atResult = this.parseLocalDateTime(slotStartStamp);
    if (!atResult.ok) return atResult;

    if (typeof slotDurationMinutes !== 'number' || !isFinite(slotDurationMinutes) || slotDurationMinutes <= 0) {
      return Result.fail(
        'INVALID_SLOT_DURATION',
        'slotDurationMinutes must be a positive finite number',
        { value: slotDurationMinutes }
      );
    }

    var baselineResult = DoctorScheduleReadService.readCurrentEffectiveSchedule(controlContext);
    if (!baselineResult.ok) return baselineResult;

    var listResult = ScheduleChangeRepository.listByScopeResult(
      scopeResult.data.doctorId,
      scopeResult.data.clinicId
    );
    if (!listResult.ok) return listResult;

    return this.evaluateSlotFromSources(
      scopeResult.data,
      atResult.data,
      baselineResult.data,
      listResult.data,
      slotDurationMinutes
    );
  },

  /**
   * M4-D — Pure slot evaluation from already-loaded sources (no I/O).
   */
  evaluateSlotFromSources: function(scope, at, baseline, records, slotDurationMinutes) {
    var slotStartMin = at.minutes;
    var slotEndStamp = this._addMinutesToStamp(at, slotDurationMinutes);

    var activeResult = this._activeRecords(records, at.stamp);
    if (!activeResult.ok) return activeResult;
    var active = activeResult.data;

    var recurringResult = this._effectiveRecurring(baseline, active, at.stamp);
    if (!recurringResult.ok) return recurringResult;
    var recurring = recurringResult.data;

    var effWindow = recurring.workWindow;
    var wStart = this._clockToMinutes(effWindow.start);
    var wEnd = this._clockToMinutes(effWindow.end);

    var weekday = this._weekdaySunday0(at.year, at.month, at.day);
    var dayKey = this.DAY_KEYS[weekday];
    var dayOpen = recurring.days[dayKey] === true;

    // Check for applicable temporary overrides that overlap the slot interval
    var overrideCheck = this._overridesForSlotInterval(active, at.stamp, slotEndStamp);
    if (!overrideCheck.ok) return overrideCheck;
    var overrides = overrideCheck.data;

    // Determine availability
    var available = false;
    var intent = 'CLOSED';

    if (overrides.temporaryClose) {
      // TEMPORARY_CLOSE overlaps some part of the slot → not available
      intent = 'CLOSED';
      available = false;
    } else if (overrides.temporaryOpen) {
      // EXCEPTIONAL_OPEN replaces normal window
      var ow = overrides.temporaryOpen.payload && overrides.temporaryOpen.payload.workWindow;
      if (!ow) {
        return Result.fail(
          'SCHEDULE_CHANGE_SOURCE_INVALID',
          'Exceptional open override is missing workWindow',
          { changeId: overrides.temporaryOpen.changeId }
        );
      }
      var owStart = this._clockToMinutes(ow.start);
      var owEnd = this._clockToMinutes(ow.end);
      if (owStart !== null && owEnd !== null &&
          slotStartMin >= owStart && (slotStartMin + slotDurationMinutes) <= owEnd) {
        available = true;
        intent = 'EXCEPTIONAL_OPEN';
      }
    } else if (dayOpen) {
      // Normal working day — slot must fit entirely within work window
      if (wStart !== null && wEnd !== null &&
          slotStartMin >= wStart && (slotStartMin + slotDurationMinutes) <= wEnd) {
        available = true;
        intent = 'WORKING';
      }
    }

    return Result.ok({ available: available, intent: intent });
  },

  /**
   * Find temporary overrides (CLOSE or OPEN) whose [effectiveFrom, effectiveTo)
   * overlaps with [slotStartStamp, slotEndStamp).
   *
   * Overlap: A < D AND C < B for intervals [A,B) and [C,D).
   */
  _overridesForSlotInterval: function(active, slotStartStamp, slotEndStamp) {
    var temporaryClose = null;
    var temporaryOpen = null;
    var closeMatches = [];
    var openMatches = [];

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
      // Overlap: effectiveFrom < slotEndStamp AND slotStartStamp < effectiveTo
      if (this.compareStamps(rec.effectiveFrom, slotEndStamp) < 0 &&
          this.compareStamps(slotStartStamp, rec.effectiveTo) < 0) {
        if (rec.changeKind === ScheduleChangeRepository.KIND.TEMPORARY_CLOSE) {
          closeMatches.push(rec);
        } else {
          openMatches.push(rec);
        }
      }
    }

    if (closeMatches.length > 1) {
      return Result.fail(
        'SCHEDULE_INTENT_CONFLICT',
        'Multiple temporary close overrides overlap the slot interval',
        { changeIds: closeMatches.map(function(m) { return m.changeId; }) }
      );
    }
    if (openMatches.length > 1) {
      return Result.fail(
        'SCHEDULE_INTENT_CONFLICT',
        'Multiple temporary open overrides overlap the slot interval',
        { changeIds: openMatches.map(function(m) { return m.changeId; }) }
      );
    }

    return Result.ok({
      temporaryClose: closeMatches.length ? closeMatches[0] : null,
      temporaryOpen: openMatches.length ? openMatches[0] : null
    });
  },

  /**
   * M4-D — Returns the effective recurring-level schedule for a date.
   * Used by AvailabilityHorizonMaintainer for slot generation decisions.
   * Does NOT consider temporary overrides (those are per-slot during reconciliation).
   *
   * @param {Object} controlContext
   * @param {string} dateStr — 'YYYY-MM-DD'
   * @returns {Result} ok({ isWorkingDay, workWindow: {start, end}, slotDurationMinutes, source })
   */
  /**
   * M4-D — Pure day-level effective projection from pre-loaded sources (no I/O).
   * Returns the effective working interval for an entire date, considering
   * recurring schedule AND temporary overrides.
   *
   * This is the SINGLE boundary for day-level schedule interpretation.
   * The materializer must NOT implement its own override/precedence logic.
   *
   * @param {Object} at — parsed date info from parseLocalDateTime (at noon)
   * @param {Object} baseline — from DoctorScheduleReadService._toEffectiveSchedule
   * @param {Array} records — from ScheduleChangeRepository.listByScopeResult
   * @returns {Result} ok({ isOpen, workWindow, slotDurationMinutes, source, overrideKind })
   */
  projectDayEffectiveWindowFromSources: function(at, baseline, records) {
    var activeResult = this._activeRecords(records, at.stamp);
    if (!activeResult.ok) return activeResult;
    var active = activeResult.data;

    var recurringResult = this._effectiveRecurring(baseline, active, at.stamp);
    if (!recurringResult.ok) return recurringResult;
    var recurring = recurringResult.data;

    var weekday = this._weekdaySunday0(at.year, at.month, at.day);
    var dayKey = this.DAY_KEYS[weekday];
    var recurringDayOpen = recurring.days[dayKey] === true;

    // Check for temporary overrides that cover this entire date
    // Date range: [dateStr T00:00, next-day T00:00)
    var dateStr = this._pad4(at.year) + '-' + this._pad2(at.month) + '-' + this._pad2(at.day);
    var dayStartStamp = dateStr + 'T00:00';
    var dayEndStamp;
    // Compute next day
    var nextDay = at.day + 1;
    var nextMonth = at.month;
    var nextYear = at.year;
    var dim = this._daysInMonth(at.year, at.month);
    if (nextDay > dim) {
      nextDay = 1;
      nextMonth += 1;
      if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
    }
    dayEndStamp = this._pad4(nextYear) + '-' + this._pad2(nextMonth) + '-' + this._pad2(nextDay) + 'T00:00';

    // Find applicable temporary overrides for this date
    var applicableClose = null;
    var applicableOpen = null;
    var closeMatches = [];
    var openMatches = [];

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
      // Overlap: effectiveFrom < dayEndStamp AND dayStartStamp < effectiveTo
      if (this.compareStamps(rec.effectiveFrom, dayEndStamp) < 0 &&
          this.compareStamps(dayStartStamp, rec.effectiveTo) < 0) {
        if (rec.changeKind === ScheduleChangeRepository.KIND.TEMPORARY_CLOSE) {
          closeMatches.push(rec);
        } else {
          openMatches.push(rec);
        }
      }
    }

    if (closeMatches.length > 1) {
      return Result.fail('SCHEDULE_INTENT_CONFLICT', 'Multiple temporary close overrides for date', {
        changeIds: closeMatches.map(function(m) { return m.changeId; }), date: dateStr
      });
    }
    if (openMatches.length > 1) {
      return Result.fail('SCHEDULE_INTENT_CONFLICT', 'Multiple temporary open overrides for date', {
        changeIds: openMatches.map(function(m) { return m.changeId; }), date: dateStr
      });
    }
    applicableClose = closeMatches.length ? closeMatches[0] : null;
    applicableOpen = openMatches.length ? openMatches[0] : null;

    // Determine effective day state
    var isOpen = false;
    var workWindow = null;
    var overrideKind = null;

    if (applicableClose && applicableOpen) {
      return Result.fail('SCHEDULE_INTENT_CONFLICT', 'Both close and open overrides apply for date', {
        date: dateStr
      });
    }

    if (applicableOpen) {
      // Exceptional open: day becomes open with Settings workWindow
      isOpen = true;
      workWindow = { start: baseline.workWindow.start, end: baseline.workWindow.end };
      overrideKind = 'TEMPORARY_OPEN';
    } else if (applicableClose) {
      // Check if close covers the entire day
      var closeCoversFullDay = (
        this.compareStamps(applicableClose.effectiveFrom, dayStartStamp) <= 0 &&
        this.compareStamps(dayEndStamp, applicableClose.effectiveTo) <= 0
      );
      if (closeCoversFullDay) {
        // Full-day close: day is closed
        isOpen = false;
        workWindow = null;
        overrideKind = 'TEMPORARY_CLOSE_FULL';
      } else {
        // Partial close: day is still open (reconciliation handles individual slots)
        isOpen = recurringDayOpen;
        workWindow = recurringDayOpen ? { start: recurring.workWindow.start, end: recurring.workWindow.end } : null;
        overrideKind = 'TEMPORARY_CLOSE_PARTIAL';
      }
    } else {
      // No override: use recurring schedule
      isOpen = recurringDayOpen;
      workWindow = recurringDayOpen ? { start: recurring.workWindow.start, end: recurring.workWindow.end } : null;
      overrideKind = null;
    }

    return Result.ok({
      isOpen: isOpen,
      workWindow: workWindow,
      slotDurationMinutes: baseline.slotDurationMinutes,
      source: recurring.sourceChangeId ? 'RECURRING_CHANGE' : 'SETTINGS',
      overrideKind: overrideKind
    });
  },


  projectDayEffectiveWindow: function(controlContext, dateStr) {
    var scopeResult = this._scopeFromControlContext(controlContext);
    if (!scopeResult.ok) return scopeResult;

    // Build a stamp for noon on the given date to evaluate
    var atResult = this.parseLocalDateTime(dateStr + 'T12:00');
    if (!atResult.ok) return atResult;

    var baselineResult = DoctorScheduleReadService.readCurrentEffectiveSchedule(controlContext);
    if (!baselineResult.ok) return baselineResult;

    var listResult = ScheduleChangeRepository.listByScopeResult(
      scopeResult.data.doctorId,
      scopeResult.data.clinicId
    );
    if (!listResult.ok) return listResult;

    var activeResult = this._activeRecords(listResult.data, atResult.data.stamp);
    if (!activeResult.ok) return activeResult;

    var recurringResult = this._effectiveRecurring(baselineResult.data, activeResult.data, atResult.data.stamp);
    if (!recurringResult.ok) return recurringResult;
    var recurring = recurringResult.data;

    var weekday = this._weekdaySunday0(atResult.data.year, atResult.data.month, atResult.data.day);
    var dayKey = this.DAY_KEYS[weekday];
    var dayOpen = recurring.days[dayKey] === true;

    return Result.ok({
      isWorkingDay: dayOpen,
      workWindow: recurring.workWindow,
      slotDurationMinutes: baselineResult.data.slotDurationMinutes,
      source: recurring.sourceChangeId ? 'RECURRING_CHANGE' : 'SETTINGS'
    });
  }
};
