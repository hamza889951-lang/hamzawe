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
