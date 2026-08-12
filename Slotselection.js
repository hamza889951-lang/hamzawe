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

    var candidates = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
      if (!SlotSelection._isAvailable(row.is_available)) return false;
      if (excludeSlotId && row.slot_id === excludeSlotId) return false;
      var sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (sortValue === null) return false;
      return sortValue >= cutoff;
    });

    if (!candidates.length) return null;

    candidates.sort(function(a, b) {
      return LegacySlotTimeParser.toComparableTime(a.sort_key) -
        LegacySlotTimeParser.toComparableTime(b.sort_key);
    });

    return candidates[0];
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
