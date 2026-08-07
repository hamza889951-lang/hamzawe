/**
 * ═══════════════════════════════════════
 * CONTRACT — MaintenanceService
 * ═══════════════════════════════════════
 *
 * يضمن:
 * - تنظيف الفتحات RESERVED التي انتهت مهلة حجزها → FREE.
 * - تحويل الفتحات FREE التي فات وقتها → EXPIRED.
 * - استخدام updateBatch دفعة واحدة.
 * - تسجيل ملخص واحد في SYSTEM_LOG.
 * - الالتزام الكامل بـ ADR-013.
 *
 * لا يضمن:
 * - توليد مواعيد جديدة (ADR-016/ADR-022).
 *
 * سياسة الفشل: Best Effort (ADR-017).
 */
const MaintenanceService = {

  runCleanup: function() {
    var nowMs = Clock.now().getTime();

    var expiredReservations = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.RESERVED) return false;
      var until = Number(row.reserved_until_unix);
      if (isNaN(until)) return false;
      return until < nowMs;
    });

    if (expiredReservations.length === 0) return Result.ok({ cleaned: 0 });

    var updates = expiredReservations.map(function(slot) {
      return {
        columnName: 'slot_id',
        value: slot.slot_id,
        fields: {
          status: Config.VOCABULARY.STATUS.FREE,
          patient_name: '',
          phone: '',
          reserved_until: '',
          reserved_until_unix: ''
        }
      };
    });

    var result = GoogleSheets.updateBatch(Config.VOCABULARY.SHEETS.AVAILABILITY, updates);

    if (!result.ok) return result;

    return Result.ok({ cleaned: result.data.updated });
  },

  runExpiration: function() {
    var nowMs = Clock.now().getTime();

    var passedSlots = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.FREE) return false;
      var slotTime = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (slotTime === null) return false;
      return slotTime < nowMs;
    });

    if (passedSlots.length === 0) return Result.ok({ expired: 0 });

    var updates = passedSlots.map(function(slot) {
      return {
        columnName: 'slot_id',
        value: slot.slot_id,
        fields: { status: Config.VOCABULARY.STATUS.EXPIRED }
      };
    });

    var result = GoogleSheets.updateBatch(Config.VOCABULARY.SHEETS.AVAILABILITY, updates);

    if (!result.ok) return result;

    return Result.ok({ expired: result.data.updated });
  },

  run: function() {
    var cleanupResult = this.runCleanup();
    var expirationResult = this.runExpiration();

    var cleaned = (cleanupResult.ok) ? cleanupResult.data.cleaned : 0;
    var expired = (expirationResult.ok) ? expirationResult.data.expired : 0;

    LogRepository.write({
      timestamp: Clock.now(),
      command: 'MAINTENANCE_RUN',
      phone: '',
      slotId: '',
      stage: 'END',
      success: true,
      durationMs: null,
      error: JSON.stringify({ cleaned: cleaned, expired: expired })
    });

    return Result.ok({ cleaned: cleaned, expired: expired });
  }
};
