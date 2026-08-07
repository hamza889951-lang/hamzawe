/**
 * ═══════════════════════════════════════
 * CONTRACT — SlotSelection
 * ═══════════════════════════════════════
 * (ADR-019)
 *
 * يضمن:
 * - تعريف معنى "أفضل فتحة قابلة للحجز" وفق سياسة النظام الحالية،
 *   كمسؤولية مستقلة عن أي Service. مُستخدَم من BookingService و
 *   ChangeService كليهما — مصدر الحقيقة الوحيد لهذا المنطق (CAS-005).
 *
 * لا يضمن:
 * - أي تعديل على الفتحات — قراءة فقط عبر SlotRepository.query.
 * - أي معرفة بالمحادثة أو الحجز أو التقويم أو الـ Service المستدعي.
 *
 * ═══════════════════════════════════════
 * ملاحظة تصميمية (ADR-019)
 * ═══════════════════════════════════════
 * هذا الملف ليس Repository (لا يعرف تخزينًا) وليس Service (لا يمثل
 * Use Case مستقل ولا يُستدعى من Router مباشرة) — بل Application
 * Helper مسؤوليته الوحيدة "سياسة الاختيار". اليوم: أقرب فتحة بعد حد
 * الاستباق الأدنى. مستقبلاً قد تتسع السياسة (طبيب معيّن، فترة، نوع
 * خدمة) دون أن يتغير أي سطر داخل BookingService أو ChangeService.
 *
 * ⚠️ يعتمد على LegacySlotTimeParser (ملف مؤقت بالكامل وفق ADR-016).
 * أي منطق هنا مرتبط بشكل sort_key الحالي يُعتبر مؤقتًا وقابلاً للحذف
 * فور اعتماد الـ Generator الجديد.
 */
const SlotSelection = {
  /**
   * يبحث عن أقرب فتحة حرة (FREE) تحقق حد الاستباق الأدنى
   * (MIN_BOOKING_LEAD_MINUTES)، مع إمكانية استبعاد فتحة محددة
   * (يُستخدم في ChangeService لضمان عدم اقتراح نفس الفتحة القديمة).
   *
   * @param {string} [excludeSlotId] - معرّف فتحة يُستبعد من النتائج
   * @returns {Object|null}
   */
  findEarliestBookable(excludeSlotId) {
    const cutoff = DateUtils.addMinutes(
      Clock.now(),
      Config.SYSTEM_POLICY.MIN_BOOKING_LEAD_MINUTES
    ).getTime();

    const candidates = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
      if (excludeSlotId && row.slot_id === excludeSlotId) return false;
      const sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (sortValue === null) return false;
      return sortValue >= cutoff;
    });

    if (!candidates.length) return null;

    candidates.sort(function(a, b) {
      return LegacySlotTimeParser.toComparableTime(a.sort_key) -
        LegacySlotTimeParser.toComparableTime(b.sort_key);
    });

    return candidates[0];
  }
};