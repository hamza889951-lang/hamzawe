/**
 * CONTRACT — SlotSelection (ADR-019)
 * - يطبّق سياسة اختيار أقرب فتحة قابلة للحجز دون تعديلها.
 * - يعيد Result.ok(slot) عند وجود مرشح، وResult.fail(NO_SLOT_AVAILABLE)
 *   عند عدم وجوده؛ لا يعيد null من دالة العمل (CAS-008).
 * - يقبل slot_id واحدًا أو قائمة IDs لاستبعاد المرشح القديم والمرشحين
 *   الذين خسروا سباق الحجز ضمن العملية الحالية.
 * - لا يحجز الفتحة ولا يملك lock؛ الحجز الذري يبقى في SlotRepository.
 * - يستخدم عقد queryResult كي لا يخلط فشل قراءة التخزين مع عدم وجود مرشح.
 */
const SlotSelection = {
  /**
   * @param {string|string[]} [excludeSlotIds]
   * @returns {Result} data: أقرب Slot قابل للحجز
   */
  findEarliestBookable: function(excludeSlotIds) {
    var excluded = SlotSelection._normalizeExclusions(excludeSlotIds);
    var cutoff = DateUtils.addMinutes(
      Clock.now(),
      Config.SYSTEM_POLICY.MIN_BOOKING_LEAD_MINUTES
    ).getTime();

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

  _normalizeExclusions: function(excludeSlotIds) {
    if (!excludeSlotIds) return [];
    if (Array.isArray(excludeSlotIds)) return excludeSlotIds.slice();
    return [excludeSlotIds];
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
