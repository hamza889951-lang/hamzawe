/**
 * ═══════════════════════════════════════
 * CONTRACT — AvailabilityHorizonMaintainer
 * ═══════════════════════════════════════
 * ADR-022 — Application Service
 *
 * M4-D evolution: Horizon + Materialization point built on EffectiveSchedule.
 *
 * مسؤوليته:
 * 1. Materialization: تقييم is_available لكل slot موجود في الأفق
 *    بناءً على EffectiveSchedule (مصدر الحقيقة للجدول).
 * 2. Generation: توليد فتحات مفقودة في الأفق بناءً على EffectiveSchedule.
 * 3. Reconciliation: تحديث is_available للفتحات الموجودة لتعكس
 *    الجدول الفعّال الحالي (بما فيه Schedule Changes).
 *
 * يضمن:
 * - EffectiveSchedule هو مصدر الحقيقة لـ is_available.
 * - Terminal lifecycle slots (EXPIRED, CANCELLED, COMPLETED, NO_SHOW) لا تُلمس إطلاقًا.
 * - FREE/RESERVED/CONFIRMED → is_available يُعاد معايَرته وفق EffectiveSchedule
 *   مع الحفاظ على status كما هو (status ملك StateMachine، is_available projection).
 * - أي mutation لـ Slot تمر عبر SlotRepository.atomicUpdate.
 * - لا rounding أو splitting أو shifting للـ slots الموجودة.
 * - Fail closed عند فشل مصدر الجدول.
 * - Single slot failure = اعزل الصف، أكمل الباقي، أرجع partial failure.
 * - Retry is idempotent: لا Schedule Change جديد، لا duplicate slots.
 * - الحد الزمني للماتيرياليزيشن هو Clock.now() (ليس booking lead).
 *
 * سياسة الفشل: Partial failure reporting (best effort per-slot).
 *
 * M4-D لا يعالج إلغاء أو إعادة جدولة المواعيد (M4-E).
 */
const AvailabilityHorizonMaintainer = {

  /**
   * نقطة الدخول الرئيسية — تُستدعى من Scheduler.main() يوميًا.
   * تطورت في M4-D لتشمل:
   * 1. بناء control context (من DoctorIdentityRepository أو parameter)
   * 2. Materialization (reconcile existing slots)
   * 3. Generation (missing slots)
   *
   * @param {Object} [optionalControlContext] — للاختبار؛ إن لم يُمرر يُبنى تلقائيًا
   * @returns {Result}
   */
  ensureHorizon: function(optionalControlContext) {
    return Lock.runExclusive('AvailabilityHorizon', function() {

      // ── Step 1: Build control context ──
      var ccResult;
      if (optionalControlContext) {
        ccResult = Result.ok(optionalControlContext);
      } else {
        ccResult = AvailabilityHorizonMaintainer._buildSchedulerControlContext();
      }
      if (!ccResult.ok) {
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: 'CONTROL_CONTEXT_FAILED', detail: ccResult.error })
        });
        return ccResult;
      }
      var controlContext = ccResult.data;

      // ── Step 2: Get EffectiveSchedule sources for slot duration ──
      var settingsResult;
      try {
        settingsResult = SettingsRepository.getSettingsResult();
      } catch (e) {
        return Result.fail('SETTINGS_READ_FAILED', e.message);
      }
      if (!settingsResult.ok) {
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: settingsResult.error.code })
        });
        return settingsResult;
      }
      var settings = settingsResult.data;

      var durationInfo = SettingsRepository.getSlotDurationInfo(settings);
      if (!durationInfo || durationInfo.source !== 'CONFIGURED') {
        var durFail = Result.fail(
          'SCHEDULE_SOURCE_INVALID',
          'Slot duration is not configured; cannot materialize availability',
          { slotDurationInfo: durationInfo }
        );
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: 'SCHEDULE_SOURCE_INVALID' })
        });
        return durFail;
      }
      var slotDuration = durationInfo.minutes;

      // ── Step 3: Determine horizon plan ──
      var latestResult = SlotRepository.findLatestSortKey();
      if (!latestResult.ok) return latestResult;
      var latestSortKey = latestResult.data;

      var planResult = SlotGenerator.calculateGenerationPlan(latestSortKey, settings);
      if (!planResult.ok) return planResult;
      var plan = planResult.data;

      // ── Step 4: Reconcile existing FREE future slots ──
      var nowMs = Clock.now().getTime();
      var reconcileResult = AvailabilityHorizonMaintainer._reconcileExistingSlots(
        controlContext, nowMs, slotDuration
      );

      // ── Step 5: Generate missing slots ──
      var generateResult = AvailabilityHorizonMaintainer._generateMissingSlots(
        controlContext, plan, settings, slotDuration
      );

      // ── Step 6: Aggregate results ──
      var totalGenerated = generateResult.ok ? generateResult.data.generated : 0;
      var totalReconciled = reconcileResult.ok ? reconcileResult.data.reconciled : 0;
      var reconcileErrors = reconcileResult.ok ? reconcileResult.data.errors : 0;
      var generateErrors = generateResult.ok ? generateResult.data.failedDays : 0;
      var hasErrors = reconcileErrors > 0 || generateErrors > 0 ||
                      !reconcileResult.ok || !generateResult.ok;

      var summary = {
        generated: totalGenerated,
        reconciled: totalReconciled,
        reconcileErrors: reconcileErrors,
        generateFailedDays: generateErrors,
        planReason: plan.reason
      };

      LogRepository.write({
        timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
        slotId: '', stage: 'END', success: !hasErrors, durationMs: null,
        error: JSON.stringify(summary)
      });

      if (hasErrors && (!reconcileResult.ok || !generateResult.ok)) {
        return Result.fail(
          'HORIZON_PARTIAL_FAILURE',
          'One or more horizon maintenance stages failed',
          summary
        );
      }

      return Result.ok(summary);
    });
  },

  /**
   * Build a control context from the configured doctor identity.
   * Used when ensureHorizon is called from Scheduler (no user context).
   */
  _buildSchedulerControlContext: function() {
    var identityResult = DoctorIdentityRepository.readConfiguredDoctorPhone();
    if (!identityResult.ok) return identityResult;
    var doctorPhone = identityResult.data;
    if (!doctorPhone || typeof doctorPhone !== 'string' || !doctorPhone.trim()) {
      return Result.fail(
        'DOCTOR_IDENTITY_NOT_CONFIGURED',
        'Cannot build control context: no doctor identity configured'
      );
    }
    return Result.ok({
      actorId: doctorPhone.trim(),
      scope: { clinicId: null }
    });
  },

  /**
   * Reconcile existing future slots against EffectiveSchedule.
   * For each non-terminal slot where slotStart >= now:
   * - Evaluate slot availability via EffectiveScheduleService
   * - If is_available differs from effective → update via atomicUpdate
   *
   * Reconciled statuses: FREE, RESERVED, CONFIRMED
   *   (is_available is an EffectiveSchedule projection, independent of status)
   * Terminal statuses (never touched): EXPIRED, CANCELLED, COMPLETED, NO_SHOW
   */
  _reconcileExistingSlots: function(controlContext, nowMs, slotDuration) {
    var TERMINAL_STATUSES = {
      EXPIRED: true,
      CANCELLED: true,
      COMPLETED: true,
      NO_SHOW: true
    };
    var futureSlots;
    try {
      futureSlots = SlotRepository.query(function(row) {
        if (TERMINAL_STATUSES[row.status]) return false;
        var sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
        if (sortValue === null) return false;
        return sortValue >= nowMs;
      });
    } catch (e) {
      return Result.fail(
        'SLOT_QUERY_FAILED',
        'Failed to query future slots for reconciliation',
        e.message
      );
    }

    var reconciled = 0;
    var errors = 0;
    var errorDetails = [];

    for (var i = 0; i < futureSlots.length; i++) {
      var slot = futureSlots[i];
      var stampResult = AvailabilityHorizonMaintainer._slotToStamp(slot);
      if (!stampResult.ok) {
        errors += 1;
        errorDetails.push({ slotId: slot.slot_id, reason: 'INVALID_STAMP' });
        continue;
      }

      var evalResult = EffectiveScheduleService.projectSlotAvailability(
        controlContext, stampResult.data, slotDuration
      );

      if (!evalResult.ok) {
        // Fail isolated: log and continue
        errors += 1;
        errorDetails.push({
          slotId: slot.slot_id,
          reason: evalResult.error.code,
          stamp: stampResult.data
        });
        continue;
      }

      var shouldBeAvailable = evalResult.data.available;
      var currentlyAvailable = SlotRepository.isOperationallyAvailable(slot.is_available);

      if (shouldBeAvailable !== currentlyAvailable) {
        var updateResult = SlotRepository.atomicUpdate(slot.slot_id, function() {
          return Result.ok({ is_available: shouldBeAvailable });
        });

        if (!updateResult.ok) {
          errors += 1;
          errorDetails.push({
            slotId: slot.slot_id,
            reason: updateResult.error ? updateResult.error.code : 'UPDATE_FAILED'
          });
          continue;
        }
        reconciled += 1;
      }
    }

    return Result.ok({
      reconciled: reconciled,
      errors: errors,
      errorDetails: errorDetails,
      totalScanned: futureSlots.length
    });
  },

  /**
   * Generate missing slots for the horizon plan using EffectiveSchedule.
   * Uses the effective recurring schedule (not raw Settings) for day decisions.
   */
  _generateMissingSlots: function(controlContext, plan, settings, slotDuration) {
    if (!plan.needsGeneration) {
      return Result.ok({ generated: 0, failedDays: 0, reason: plan.reason });
    }

    var totalGenerated = 0;
    var failedDays = 0;
    var currentDate = new Date(plan.startDate.getTime());

    for (var d = 0; d < plan.daysCount; d++) {
      try {
        // Use EffectiveSchedule to determine if this day is working
        var dateStr = AvailabilityHorizonMaintainer._formatDateStr(currentDate);
        var dayResult = EffectiveScheduleService.projectDayEffectiveWindow(
          controlContext, dateStr
        );

        if (!dayResult.ok) {
          failedDays += 1;
          LogRepository.write({
            timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
            slotId: '', stage: 'END', success: false, durationMs: null,
            error: JSON.stringify({
              reason: 'EFFECTIVE_SCHEDULE_FAILED',
              date: dateStr,
              detail: dayResult.error.code
            })
          });
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }

        var daySchedule = dayResult.data;

        if (daySchedule.isWorkingDay) {
          // Build settings-like object for SlotGenerator from effective window
          var effectiveSettings = {
            work_start: daySchedule.workWindow.start,
            work_end: daySchedule.workWindow.end
          };
          var dailySlots = SlotGenerator.calculateDailySlots(
            currentDate, effectiveSettings, slotDuration
          );

          if (dailySlots.length > 0) {
            var insertResult = SlotRepository.insertBatch(dailySlots);
            if (insertResult.ok) {
              totalGenerated += insertResult.data.inserted;
            } else {
              failedDays += 1;
              LogRepository.write({
                timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
                slotId: '', stage: 'END', success: false, durationMs: null,
                error: JSON.stringify({
                  reason: 'INSERT_FAILED',
                  date: dateStr,
                  detail: insertResult.error ? JSON.stringify(insertResult.error) : ''
                })
              });
            }
          }
        }
      } catch (e) {
        failedDays += 1;
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({
            reason: 'DAY_FAILED',
            date: AvailabilityHorizonMaintainer._formatDateStr(currentDate),
            detail: e.message || 'Unknown error'
          })
        });
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    var reason = plan.reason + ' — generated: ' + totalGenerated;
    if (failedDays > 0) {
      reason += ', failedDays: ' + failedDays;
    }

    return Result.ok({
      generated: totalGenerated,
      failedDays: failedDays,
      reason: reason
    });
  },

  /**
   * Convert a slot row to a local stamp 'YYYY-MM-DDTHH:mm'.
   * Uses sort_key (YYYYMMDDHHmm) for deterministic conversion.
   */
  _slotToStamp: function(slot) {
    if (!slot || !slot.sort_key) {
      return Result.fail('INVALID_SLOT', 'Slot missing sort_key');
    }
    var str = typeof slot.sort_key === 'string' ? slot.sort_key : String(slot.sort_key);
    if (str.length < 12) {
      return Result.fail('INVALID_SORT_KEY', 'sort_key too short: ' + str);
    }
    var year = str.substring(0, 4);
    var month = str.substring(4, 6);
    var day = str.substring(6, 8);
    var hh = str.substring(8, 10);
    var mm = str.substring(10, 12);
    return Result.ok(year + '-' + month + '-' + day + 'T' + hh + ':' + mm);
  },

  /**
   * Format a Date as 'YYYY-MM-DD' for EffectiveScheduleService.projectDayEffectiveWindow.
   */
  _formatDateStr: function(date) {
    var yyyy = date.getFullYear();
    var mm = String(date.getMonth() + 1);
    if (mm.length < 2) mm = '0' + mm;
    var dd = String(date.getDate());
    if (dd.length < 2) dd = '0' + dd;
    return yyyy + '-' + mm + '-' + dd;
  },

  /**
   * تشغيل تجريبي (Dry Run) — لا يكتب بيانات.
   * @param {Object} [optionalControlContext]
   * @returns {Result}
   */
  preview: function(optionalControlContext) {
    var settings;
    try {
      settings = SettingsRepository.getAll();
    } catch (e) {
      return Result.fail('SETTINGS_READ_FAILED', e.message);
    }

    var ccResult;
    if (optionalControlContext) {
      ccResult = Result.ok(optionalControlContext);
    } else {
      ccResult = this._buildSchedulerControlContext();
    }
    if (!ccResult.ok) return ccResult;
    var controlContext = ccResult.data;

    var latestResult = SlotRepository.findLatestSortKey();
    var latestSortKey = latestResult.ok ? latestResult.data : null;
    var planResult = SlotGenerator.calculateGenerationPlan(latestSortKey, settings);

    if (!planResult.ok) return planResult;
    var plan = planResult.data;

    if (!plan.needsGeneration) {
      return Result.ok({ plan: plan, wouldGenerate: 0, workingDays: 0 });
    }

    var durationInfo = SettingsRepository.getSlotDurationInfo(settings);
    var slotDuration = (durationInfo && durationInfo.source === 'CONFIGURED')
      ? durationInfo.minutes
      : SettingsRepository.getSlotDurationMinutes();

    var wouldGenerate = 0;
    var workingDays = 0;
    var currentDate = new Date(plan.startDate.getTime());

    for (var d = 0; d < plan.daysCount; d++) {
      var dateStr = this._formatDateStr(currentDate);
      var dayResult = EffectiveScheduleService.projectDayEffectiveWindow(
        controlContext, dateStr
      );
      if (dayResult.ok && dayResult.data.isWorkingDay) {
        workingDays += 1;
        var effectiveSettings = {
          work_start: dayResult.data.workWindow.start,
          work_end: dayResult.data.workWindow.end
        };
        var dailySlots = SlotGenerator.calculateDailySlots(
          currentDate, effectiveSettings, slotDuration
        );
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
