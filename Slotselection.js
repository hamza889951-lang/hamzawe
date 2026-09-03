/**
 * CONTRACT — SlotSelection (ADR-019)
 * P0 fix: is_available enforced
 */
const SlotSelection = {
  findEarliestBookable: function(excludedSlotIds) {
    var cutoff = DateUtils.addMinutes(
      Clock.now(),
      Config.SYSTEM_POLICY.MIN_BOOKING_LEAD_MINUTES
    ).getTime();

    var excluded = SlotSelection._normalizeExcludedIds(excludedSlotIds);
    var queryResult = SlotRepository.queryResult(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
      if (!SlotSelection._isAvailable(row.is_available)) return false;
      if (excluded.indexOf(row.slot_id) !== -1) return false;
      var sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (sortValue === null) return false;
      return sortValue >= cutoff;
    });

    if (!queryResult.ok) return queryResult;

    var candidates = queryResult.data;
    if (!candidates.length) {
      return Result.fail('NO_SLOT_AVAILABLE', 'No bookable slot found');
    }

    candidates.sort(function(a, b) {
      return LegacySlotTimeParser.toComparableTime(a.sort_key) -
        LegacySlotTimeParser.toComparableTime(b.sort_key);
    });

    return Result.ok(candidates[0]);
  },

  /**
   * M4-F (Contract §3.10 / §4) — bounded-horizon extension of the SAME
   * selection policy. This is not a second selector: it shares the policy
   * constants, the operational-availability truth, the canonical
   * sort_key → LegacySlotTimeParser time interpretation, and the existing
   * booking-eligibility rules with findEarliestBookable().
   *
   * It only ADDS the horizon bound the disruption flow requires and the
   * deterministic slot_id tie-break, and it returns the single earliest
   * eligible candidate (v1 proposes exactly one — Contract §4.4).
   *
   * @param {Object} [options]
   * @param {string|string[]} [options.excludedSlotIds] - original slot excluded
   * @param {number} [options.horizonDays] - clinic calendar days, end-exclusive
   * @returns {Result} ok(slot) | fail('NO_SLOT_AVAILABLE') | fail(source error)
   */
  findEarliestWithinHorizon: function(options) {
    const opts = (options !== null && typeof options === 'object') ? options : {};

    const horizonDays = (typeof opts.horizonDays === 'number' && isFinite(opts.horizonDays))
      ? opts.horizonDays
      : Config.SYSTEM_POLICY.DISRUPTION_CANDIDATE_HORIZON_DAYS;

    // Single evaluation instant for the whole operation (CAS-009: Clock only).
    const evaluationNow = Clock.now();
    const cutoff = DateUtils.addMinutes(
      evaluationNow,
      Config.SYSTEM_POLICY.MIN_BOOKING_LEAD_MINUTES
    ).getTime();

    // Horizon expressed in the canonical storage representation:
    // 'YYYYMMDD' of the day containing the evaluation instant, and of the
    // day + horizonDays. Asia/Baghdad has no DST, so advancing the instant
    // by whole days advances the calendar day by exactly the same count.
    // End-exclusive: a candidate on the horizon boundary day is out.
    const horizonStartDay = SlotSelection._localDayOf(evaluationNow);
    const horizonEndDay = SlotSelection._localDayOf(
      DateUtils.addMinutes(evaluationNow, horizonDays * 1440)
    );
    if (!horizonStartDay || !horizonEndDay) {
      return Result.fail(
        'INVALID_SELECTION_HORIZON',
        'Could not derive the M4-F candidate horizon from the evaluation instant'
      );
    }

    const excluded = SlotSelection._normalizeExcludedIds(opts.excludedSlotIds);

    const queryResult = SlotRepository.queryResult(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
      if (!SlotSelection._isAvailable(row.is_available)) return false;
      if (excluded.indexOf(row.slot_id) !== -1) return false;

      const sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
      // Malformed / unparseable time rows are excluded safely — never
      // treated as sortable, never fatal to the whole search.
      if (sortValue === null || !isFinite(sortValue)) return false;
      if (sortValue < cutoff) return false;

      const day = SlotSelection._localDayOf(DateUtils.fromTimestamp(sortValue));
      if (day === null) return false;
      return day >= horizonStartDay && day < horizonEndDay;
    });

    if (!queryResult.ok) return queryResult;

    const candidates = queryResult.data;
    if (!candidates.length) {
      return Result.fail('NO_SLOT_AVAILABLE', 'No bookable slot found within the M4-F horizon');
    }

    // Deterministic: operational start ascending, then slot_id ascending.
    candidates.sort(function(a, b) {
      const aStart = LegacySlotTimeParser.toComparableTime(a.sort_key);
      const bStart = LegacySlotTimeParser.toComparableTime(b.sort_key);
      if (aStart !== bStart) return aStart - bStart;
      const aId = String(a.slot_id);
      const bId = String(b.slot_id);
      if (aId < bId) return -1;
      if (aId > bId) return 1;
      return 0;
    });

    return Result.ok(candidates[0]);
  },

  /** @returns {string|null} 'YYYYMMDD' in the clinic-local representation */
  _localDayOf: function(dateValue) {
    if (!dateValue) return null;
    const key = DateUtils.formatSortKey(dateValue);
    return key && key.length >= 8 ? key.substring(0, 8) : null;
  },

  _normalizeExcludedIds: function(excludedSlotIds) {
    if (excludedSlotIds == null || excludedSlotIds === '') return [];
    if (Object.prototype.toString.call(excludedSlotIds) === '[object Array]') {
      return excludedSlotIds;
    }
    return [excludedSlotIds];
  },

  _isAvailable: function(value) {
    if (value === true) return true;
    if (typeof value === 'string') {
      var trimmed = value.trim().toUpperCase();
      if (trimmed === 'TRUE') return true;
    }
    return false;
  }
};
