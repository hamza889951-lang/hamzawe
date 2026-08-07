/**
 * ═══════════════════════════════════════
 * CONTRACT — AvailabilityHorizonMaintainer
 * ═══════════════════════════════════════
 * ADR-022 — Application Service
 *
 * مسؤوليته الوحيدة: ضمان وجود فتحات كافية في الأفق الزمني.
 *
 * سياسة الفشل: Best Effort (ADR-017/ADR-022)
 */
const AvailabilityHorizonMaintainer = {

  /**
   * نقطة الدخول — تُستدعى من Scheduler.main() يوميًا.
   * @returns {Result}
   */
  ensureHorizon: function() {
    return Lock.runExclusive('AvailabilityHorizon', function() {

      var settings = SettingsRepository.getAll();

      var latestResult = SlotRepository.findLatestSortKey();
      if (!latestResult.ok) return latestResult;
      var latestSortKey = latestResult.data;

      var planResult = SlotGenerator.calculateGenerationPlan(latestSortKey, settings);
      if (!planResult.ok) return planResult;
      var plan = planResult.data;

      if (!plan.needsGeneration) {
        LogRepository.write({
          timestamp: Clock.now(),
          command: 'GENERATE_AVAILABILITY',
          phone: '',
          slotId: '',
          stage: 'END',
          success: true,
          durationMs: null,
          error: JSON.stringify({ generated: 0, reason: plan.reason })
        });
        return Result.ok({ generated: 0, reason: plan.reason });
      }

      // ⭐ مدة الجلسة من مصدر رسمي واحد (CAS-005)
      var slotDuration = SettingsRepository.getSlotDurationMinutes();

      var totalGenerated = 0;
      var failedDays = 0;
      var currentDate = new Date(plan.startDate.getTime());

      for (var d = 0; d < plan.daysCount; d++) {
        try {
          if (SlotGenerator.isWorkingDay(currentDate, settings)) {
            var dailySlots = SlotGenerator.calculateDailySlots(currentDate, settings, slotDuration);
            if (dailySlots.length > 0) {
              var insertResult = SlotRepository.insertBatch(dailySlots);
              if (insertResult.ok) {
                totalGenerated += insertResult.data.inserted;
              } else {
                failedDays += 1;
                LogRepository.write({
                  timestamp: Clock.now(),
                  command: 'GENERATE_AVAILABILITY',
                  phone: '',
                  slotId: '',
                  stage: 'END',
                  success: false,
                  durationMs: null,
                  error: JSON.stringify({
                    reason: 'INSERT_FAILED',
                    date: DateUtils.formatDateForStorage(currentDate),
                    detail: insertResult.error ? JSON.stringify(insertResult.error) : ''
                  })
                });
              }
            }
          }
        } catch (e) {
          failedDays += 1;
          LogRepository.write({
            timestamp: Clock.now(),
            command: 'GENERATE_AVAILABILITY',
            phone: '',
            slotId: '',
            stage: 'END',
            success: false,
            durationMs: null,
            error: JSON.stringify({
              reason: 'DAY_FAILED',
              date: DateUtils.formatDateForStorage(currentDate),
              detail: e.message || 'Unknown error'
            })
          });
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }

      var finalReason = plan.reason + ' — generated: ' + totalGenerated;
      if (failedDays > 0) {
        finalReason += ', failedDays: ' + failedDays;
      }

      LogRepository.write({
        timestamp: Clock.now(),
        command: 'GENERATE_AVAILABILITY',
        phone: '',
        slotId: '',
        stage: 'END',
        success: true,
        durationMs: null,
        error: JSON.stringify({
          generated: totalGenerated,
          failedDays: failedDays,
          reason: finalReason
        })
      });

      return Result.ok({ generated: totalGenerated, reason: finalReason });
    });
  },

  /**
   * تشغيل تجريبي (Dry Run) — لا يكتب بيانات.
   * @returns {Result}
   */
  preview: function() {
    var settings = SettingsRepository.getAll();
    var latestResult = SlotRepository.findLatestSortKey();
    var latestSortKey = latestResult.ok ? latestResult.data : null;
    var planResult = SlotGenerator.calculateGenerationPlan(latestSortKey, settings);

    if (!planResult.ok) return planResult;
    var plan = planResult.data;

    if (!plan.needsGeneration) {
      return Result.ok({ plan: plan, wouldGenerate: 0, workingDays: 0 });
    }

    var slotDuration = SettingsRepository.getSlotDurationMinutes();
    var wouldGenerate = 0;
    var workingDays = 0;
    var currentDate = new Date(plan.startDate.getTime());

    for (var d = 0; d < plan.daysCount; d++) {
      if (SlotGenerator.isWorkingDay(currentDate, settings)) {
        workingDays += 1;
        var dailySlots = SlotGenerator.calculateDailySlots(currentDate, settings, slotDuration);
        wouldGenerate += dailySlots.length;
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return Result.ok({
      plan: plan,
      wouldGenerate: wouldGenerate,
      workingDays: workingDays
    });
  }
};