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
 * - Source snapshot: تحميل Settings + ScheduleChange records مرة واحدة في كل run،
 *   ثم إعادة استخدام نفس snapshot عبر _evaluateSlotFromSources لكل slot.
 * - Gap filling: required starts - existing starts = missing starts only.
 * - Deduplication: sort_key كمفتاح deduplication قبل الإدراج.
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
   * 2. تحميل مصادر EffectiveSchedule مرة واحدة (source snapshot)
   * 3. Reconciliation (existing non-terminal slots using pure projection)
   * 4. Generation (gap filling: required - existing = missing)
   * 5. Deduplication via sort_key
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

      // ── Step 2: Load Settings (once) ──
      var settingsResult;
      try {
        settingsResult = SettingsRepository.getSettingsResult();
      } catch (e) {
        var settingsFail = Result.fail('SETTINGS_READ_FAILED', e.message);
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: settingsFail.error.code })
        });
        return settingsFail;
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

      // ── Step 3: Build EffectiveSchedule baseline from already-loaded Settings ──
      // Use the settings we already loaded in Step 2 to avoid re-reading
      var scopeResult = EffectiveScheduleService._scopeFromControlContext(controlContext);
      if (!scopeResult.ok) return scopeResult;
      
      var baselineResult = DoctorScheduleReadService._toEffectiveSchedule(scopeResult.data, settings);
      if (!baselineResult.ok) {
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: baselineResult.error.code })
        });
        return baselineResult;
      }
      var baseline = baselineResult.data;

      var scopeResult = EffectiveScheduleService._scopeFromControlContext(controlContext);
      if (!scopeResult.ok) return scopeResult;
      var scope = scopeResult.data;

      var listResult = ScheduleChangeRepository.listByScopeResult(scope.doctorId, scope.clinicId);
      if (!listResult.ok) {
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: listResult.error.code })
        });
        return listResult;
      }
      var records = listResult.data;

      // ── Step 4: Read candidate future slots ONCE (shared snapshot) ──
      var nowMs = Clock.now().getTime();
      var targetDays = parseInt(settings.slot_generation_days, 10);
      if (isNaN(targetDays) || targetDays <= 0) {
        var daysFail = Result.fail(
          'INVALID_SLOT_GENERATION_DAYS',
          'slot_generation_days must be a positive integer',
          { value: settings.slot_generation_days }
        );
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: daysFail.error.code })
        });
        return daysFail;
      }
      
      var futureSlots;
      try {
        futureSlots = SlotRepository.query(function(row) {
          var sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
          if (sortValue === null) return false;
          var cutoff = nowMs + (targetDays * 24 * 60 * 60 * 1000);
          return sortValue >= nowMs && sortValue < cutoff;
        });
      } catch (e) {
        var slotsFail = Result.fail(
          'SLOT_QUERY_FAILED',
          'Failed to query future slots',
          e.message
        );
        LogRepository.write({
          timestamp: Clock.now(), command: 'GENERATE_AVAILABILITY', phone: '',
          slotId: '', stage: 'END', success: false, durationMs: null,
          error: JSON.stringify({ reason: slotsFail.error.code })
        });
        return slotsFail;
      }

      // ── Step 5: Reconcile existing non-terminal future slots ──
      // Uses pure projection with same source snapshot (no re-reads)
      var reconcileResult = AvailabilityHorizonMaintainer._reconcileExistingSlots(
        baseline, records, slotDuration, nowMs, futureSlots
      );

      // ── Step 6: Generate missing slots (gap filling) ──
      // Computes required operational starts - existing starts = missing
      var generateResult = AvailabilityHorizonMaintainer._generateMissingSlots(
        controlContext, baseline, records, settings, slotDuration, nowMs, futureSlots
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
        deduplicatedSkipped: generateResult.ok ? (generateResult.data.deduplicatedSkipped || 0) : 0
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
   * Reconcile existing non-terminal future slots against EffectiveSchedule.
   * Uses pre-loaded source snapshot (baseline + records) — no re-reads.
   *
   * Reconciled statuses: FREE, RESERVED, CONFIRMED
   *   (is_available is an EffectiveSchedule projection, independent of status)
   * Terminal statuses (never touched): EXPIRED, CANCELLED, COMPLETED, NO_SHOW
   */
  _reconcileExistingSlots: function(baseline, records, slotDuration, nowMs, futureSlots) {
    // futureSlots is the pre-loaded snapshot (read once in ensureHorizon)
    var TERMINAL_STATUSES = {
      EXPIRED: true,
      CANCELLED: true,
      COMPLETED: true,
      NO_SHOW: true
    };
    // Filter to non-terminal slots
    futureSlots = futureSlots.filter(function(row) {
      return !TERMINAL_STATUSES[row.status];
    });

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

      // Use pure projection with pre-loaded sources (NO re-reads)
      var evalResult = EffectiveScheduleService.evaluateSlotFromSources(
        { doctorId: null, clinicId: null }, // scope unused in pure eval
        EffectiveScheduleService.parseLocalDateTime(stampResult.data).data,
        baseline,
        records,
        slotDuration
      );

      if (!evalResult.ok) {
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
   * Generate missing slots using gap-filling approach:
   * required operational starts - existing operational starts = missing starts.
   * Uses pre-loaded source snapshot. Deduplicates by sort_key before insert.
   */
  _generateMissingSlots: function(controlContext, baseline, records, settings, slotDuration, nowMs, futureSlots) {
    // Compute the date range for generation
    var targetDays = parseInt(settings.slot_generation_days, 10);
    if (isNaN(targetDays) || targetDays <= 0) {
      return Result.fail(
        'INVALID_SLOT_GENERATION_DAYS',
        'slot_generation_days must be a positive integer',
        { value: settings.slot_generation_days }
      );
    }
    var startDate = Clock.now();
    startDate.setHours(0, 0, 0, 0);

    // Build existing slots map from pre-loaded snapshot
    var existingSlotsMap = {};  // sort_key → slot
    for (var i = 0; i < futureSlots.length; i++) {
      existingSlotsMap[futureSlots[i].sort_key] = futureSlots[i];
    }

    // Generate missing slots for each date
    var missingSlots = [];
    var failedDays = 0;
    var deduplicatedSkipped = 0;
    var currentDate = new Date(startDate.getTime());

    for (var d = 0; d < targetDays; d++) {
      try {
        var dateStr = AvailabilityHorizonMaintainer._formatDateStr(currentDate);
        var atResult = EffectiveScheduleService.parseLocalDateTime(dateStr + 'T12:00');
        if (!atResult.ok) {
          failedDays += 1;
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }

        // Use the SINGLE pure boundary for day-level projection
        var dayResult = EffectiveScheduleService.projectDayEffectiveWindowFromSources(
          atResult.data,
          baseline,
          records
        );

        if (!dayResult.ok) {
          failedDays += 1;
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }

        var dayInfo = dayResult.data;

        // If day is open and has a work window, generate required slots
        if (dayInfo.isOpen && dayInfo.workWindow) {
          var wStart = EffectiveScheduleService._clockToMinutes(dayInfo.workWindow.start);
          var wEnd = EffectiveScheduleService._clockToMinutes(dayInfo.workWindow.end);

          var currentMinutes = wStart;
          while (currentMinutes + slotDuration <= wEnd) {
            var slotTime = new Date(currentDate.getTime());
            slotTime.setHours(Math.floor(currentMinutes / 60), currentMinutes % 60, 0, 0);

            var sortKey = DateUtils.formatSortKey(slotTime);

            // Deduplicate: skip if already exists
            if (existingSlotsMap[sortKey]) {
              deduplicatedSkipped += 1;
            } else {
              missingSlots.push({
                slot_id: IdGenerator.generateSlotId(),
                date: DateUtils.formatDateForStorage(slotTime),
                time: DateUtils.formatTimeForStorage(slotTime),
                sort_key: sortKey,
                status: Config.VOCABULARY.STATUS.FREE,
                is_available: true,
                patient_name: '',
                phone: '',
                calendar_event_id: '',
                Reminder_sent: false,
                whatsapp_message_id: '',
                reserved_until: '',
                reserved_until_unix: ''
              });
              existingSlotsMap[sortKey] = true; // prevent duplicate within same batch
            }

            currentMinutes += slotDuration;
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

    // Batch insert missing slots
    var totalGenerated = 0;
    if (missingSlots.length > 0) {
      var insertResult = SlotRepository.insertBatch(missingSlots);
      if (insertResult.ok) {
        totalGenerated = insertResult.data.inserted;
      } else {
        return Result.fail(
          'INSERT_FAILED',
          'Failed to insert missing slots',
          insertResult.error
        );
      }
    }

    return Result.ok({
      generated: totalGenerated,
      failedDays: failedDays,
      deduplicatedSkipped: deduplicatedSkipped
    });
  },

  /**
   * Get temporary overrides for a date range (full day).
   */
  _getOverridesForDate: function(active, atData, dateStr) {
    var temporaryClose = null;
    var temporaryOpen = null;

    for (var i = 0; i < active.length; i++) {
      var rec = active[i];
      if (rec.changeKind !== ScheduleChangeRepository.KIND.TEMPORARY_CLOSE &&
          rec.changeKind !== ScheduleChangeRepository.KIND.TEMPORARY_OPEN) {
        continue;
      }
      if (!rec.effectiveFrom || !rec.effectiveTo) continue;

      // Check if override overlaps this date
      var dayStart = dateStr + 'T00:00';
      var dayEnd = dateStr + 'T23:59';

      if (EffectiveScheduleService.compareStamps(rec.effectiveFrom, dayEnd) <= 0 &&
          EffectiveScheduleService.compareStamps(dayStart, rec.effectiveTo) < 0) {
        if (rec.changeKind === ScheduleChangeRepository.KIND.TEMPORARY_CLOSE) {
          temporaryClose = rec;
        } else {
          temporaryOpen = rec;
        }
      }
    }

    return { temporaryClose: temporaryClose, temporaryOpen: temporaryOpen };
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
   * Fail-closed on missing/invalid duration (no silent fallback).
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

    // Fail-closed on duration (no silent fallback)
    var durationInfo = SettingsRepository.getSlotDurationInfo(settings);
    if (!durationInfo || durationInfo.source !== 'CONFIGURED') {
      return Result.fail(
        'SCHEDULE_SOURCE_INVALID',
        'Slot duration is not configured; cannot preview availability',
        { slotDurationInfo: durationInfo }
      );
    }
    var slotDuration = durationInfo.minutes;

    var ccResult;
    if (optionalControlContext) {
      ccResult = Result.ok(optionalControlContext);
    } else {
      ccResult = this._buildSchedulerControlContext();
    }
    if (!ccResult.ok) return ccResult;
    var controlContext = ccResult.data;

    // Load sources once
    var baselineResult = DoctorScheduleReadService.readCurrentEffectiveSchedule(controlContext);
    if (!baselineResult.ok) return baselineResult;
    var baseline = baselineResult.data;

    var scopeResult = EffectiveScheduleService._scopeFromControlContext(controlContext);
    if (!scopeResult.ok) return scopeResult;

    var listResult = ScheduleChangeRepository.listByScopeResult(scopeResult.data.doctorId, scopeResult.data.clinicId);
    if (!listResult.ok) return listResult;
    var records = listResult.data;

    // Compute generation plan
    var targetDays = parseInt(settings.slot_generation_days, 10) || 30;
    var today = Clock.now();
    today.setHours(0, 0, 0, 0);

    // Count existing slots
    var existingCount = 0;
    try {
      var endDate = new Date(today.getTime());
      endDate.setDate(endDate.getDate() + targetDays);
      existingCount = SlotRepository.query(function(row) {
        var sortValue = LegacySlotTimeParser.toComparableTime(row.sort_key);
        if (sortValue === null) return false;
        return sortValue >= today.getTime() && sortValue < endDate.getTime();
      }).length;
    } catch (e) {
      // ignore
    }

    // Count required slots
    var wouldGenerate = 0;
    var workingDays = 0;
    var currentDate = new Date(today.getTime());

    for (var d = 0; d < targetDays; d++) {
      var dateStr = this._formatDateStr(currentDate);
      var atResult = EffectiveScheduleService.parseLocalDateTime(dateStr + 'T12:00');
      if (atResult.ok) {
        var activeResult = EffectiveScheduleService._activeRecords(records, atResult.data.stamp);
        if (activeResult.ok) {
          var recurringResult = EffectiveScheduleService._effectiveRecurring(baseline, activeResult.data, atResult.data.stamp);
          if (recurringResult.ok) {
            var weekday = EffectiveScheduleService._weekdaySunday0(atResult.data.year, atResult.data.month, atResult.data.day);
            var dayKey = EffectiveScheduleService.DAY_KEYS[weekday];
            var dayOpen = recurringResult.data.days[dayKey] === true;

            if (dayOpen) {
              workingDays += 1;
              var effWindow = recurringResult.data.workWindow;
              var wStart = EffectiveScheduleService._clockToMinutes(effWindow.start);
              var wEnd = EffectiveScheduleService._clockToMinutes(effWindow.end);
              var currentMinutes = wStart;
              while (currentMinutes + slotDuration <= wEnd) {
                wouldGenerate += 1;
                currentMinutes += slotDuration;
              }
            }
          }
        }
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return Result.ok({
      plan: { needsGeneration: true, startDate: today, daysCount: targetDays },
      wouldGenerate: Math.max(0, wouldGenerate - existingCount),
      workingDays: workingDays
    });
  }
};
