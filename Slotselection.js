/**
 * CONTRACT — SlotSelection (ADR-019)
 * P0 fix: is_available enforced
 */
const SlotSelection = {
  findEarliestBookable: function(excludeSlotId) {
    var cutoff = DateUtils.addMinutes(
      Clock.now(),
      Config.SYSTEM_POLICY.MIN_BOOKING_LEAD_MINUTES
    ).getTime();

    var excludedIds = SlotSelection._asExcludeList(excludeSlotId);

    var queryResult = SlotRepository.queryResult(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
      if (!SlotSelection._isAvailable(row.is_available)) return false;
      if (excludedIds.indexOf(row.slot_id) !== -1) return false;
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

  _asExcludeList: function(excludeSlotId) {
    if (excludeSlotId == null || excludeSlotId === '') return [];
    if (Object.prototype.toString.call(excludeSlotId) === '[object Array]') {
      return excludeSlotId;
    }
    return [excludeSlotId];
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
