/**
 * ═══════════════════════════════════════
 * CONTRACT — DoctorScheduleCommandService
 * ═══════════════════════════════════════
 * M4-C — Application command boundary for schedule intent mutations.
 *
 * يضمن:
 * - استقبال controlContext من M4-A دون إعادة authorization.
 * - fresh read داخل قفل النطاق ثم validate ثم append-only persist.
 * - idempotency عبر commandId على نفس الـscope.
 * - Result صريح؛ تعارضات applicable غير معرّفة → SCHEDULE_INTENT_CONFLICT.
 *
 * M4-C Continuation (FROZEN CONTRACT v1 — 2026-09-01):
 * - slotDurationMinutes ليس Doctor Control input: أي أمر يحمله يُرفض
 *   صراحة؛ recurring payloads الجديدة لا تعرّف مدة. المصدر التشغيلي
 *   الوحيد للمدة هو Settings (عبر M4-B baseline). السجلات التاريخية
 *   التي تحمل الحقل تبقى immutable ويُتجاهل الحقل كسلطة تشغيلية.
 * - bus count ليس schedule input بأي صيغة.
 * - recurring effective boundary = 00:00 Asia/Baghdad للتاريخ المحلي
 *   المختار (application-level enforcement — لا يمكن لأي caller تجاوزه).
 * - exceptional open يعيد استخدام نافذة Settings المعتادة؛ لا workWindow
 *   من الطبيب، ولا partial-day open في v1 (يوم كامل [date, date+1)).
 * - representability: حدود temporary override الواقعة داخل نافذة العمل
 *   يجب أن تقع على slot grid (validation فقط — لا تقسيم/توليد/تقريب).
 *
 * Preview/Commit:
 * - previewCommand() يعيد نفس بناء/تحقق الالتزام دون أي persistence
 *   (read-only)؛ الالتزام يمر بنفس الـbuilder داخل قفل النطاق.
 *
 * لا يضمن:
 * - Availability / Slot / Calendar / WhatsApp / Router UX.
 */
const DoctorScheduleCommandService = {

  commitRecurringChange: function(controlContext, command) {
    return this._execute(
      Config.VOCABULARY.COMMANDS.COMMIT_RECURRING_SCHEDULE_CHANGE,
      controlContext,
      command,
      this._buildRecurring.bind(this)
    );
  },

  commitTemporaryClose: function(controlContext, command) {
    return this._execute(
      Config.VOCABULARY.COMMANDS.COMMIT_TEMPORARY_CLOSE_OVERRIDE,
      controlContext,
      command,
      this._buildTemporaryClose.bind(this)
    );
  },

  commitExceptionalOpen: function(controlContext, command) {
    return this._execute(
      Config.VOCABULARY.COMMANDS.COMMIT_EXCEPTIONAL_OPEN_OVERRIDE,
      controlContext,
      command,
      this._buildTemporaryOpen.bind(this)
    );
  },

  cancelChange: function(controlContext, command) {
    return this._execute(
      Config.VOCABULARY.COMMANDS.CANCEL_SCHEDULE_CHANGE,
      controlContext,
      command,
      this._buildCancel.bind(this)
    );
  },

  // ─────────────────────────────────────────────────────────
  // Preview boundary (M4-C Continuation §11) — read-only.
  // نفس الـvalidation والـbuilder اللذين يستخدمهما الالتزام،
  // دون أي قفل كتابة أو append. لا يُنشئ changeId ولا يغيّر
  // Availability/Appointment/Calendar.
  // ─────────────────────────────────────────────────────────

  previewRecurringChange: function(controlContext, command) {
    return this._preview(controlContext, command, this._buildRecurring.bind(this));
  },

  previewTemporaryClose: function(controlContext, command) {
    return this._preview(controlContext, command, this._buildTemporaryClose.bind(this));
  },

  previewExceptionalOpen: function(controlContext, command) {
    return this._preview(controlContext, command, this._buildTemporaryOpen.bind(this));
  },

  previewCancelChange: function(controlContext, command) {
    return this._preview(controlContext, command, this._buildCancel.bind(this));
  },

  _preview: function(controlContext, command, builder) {
    var envelope = this._validateEnvelope(controlContext, command);
    if (!envelope.ok) return envelope;
    var scope = envelope.data;

    var existing = ScheduleChangeRepository.findByCommandIdResult(
      scope.doctorId,
      scope.clinicId,
      command.commandId
    );
    if (!existing.ok) return existing;
    if (existing.data) {
      return Result.ok({
        status: 'ALREADY_COMMITTED',
        record: existing.data
      });
    }

    var baselineResult = DoctorScheduleReadService.readCurrentEffectiveSchedule({
      actorId: scope.doctorId,
      scope: { clinicId: scope.clinicId }
    });
    if (!baselineResult.ok) return baselineResult;

    var listResult = ScheduleChangeRepository.listByScopeResult(scope.doctorId, scope.clinicId);
    if (!listResult.ok) return listResult;

    var built = builder(scope, command, baselineResult.data, listResult.data);
    if (!built.ok) return built;

    return Result.ok({
      status: 'PREVIEW',
      record: built.data.record,
      baseline: baselineResult.data,
      records: listResult.data
    });
  },

  _validateEnvelope: function(controlContext, command) {
    var scopeResult = this._scopeFromControlContext(controlContext);
    if (!scopeResult.ok) return scopeResult;
    if (!command || typeof command !== 'object') {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'Schedule command payload is required');
    }
    if (typeof command.commandId !== 'string' || !command.commandId) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'commandId is required');
    }
    if (typeof command.asOf !== 'string' || !command.asOf) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'asOf local datetime is required');
    }
    var forbidden = this._rejectNonScheduleInputs(command);
    if (!forbidden.ok) return forbidden;
    return scopeResult;
  },

  /**
   * M4-C Continuation §4.1/§8: slot duration and bus count are never
   * schedule inputs. Fail explicitly — no silent stripping.
   */
  _rejectNonScheduleInputs: function(command) {
    if (Object.prototype.hasOwnProperty.call(command, 'slotDurationMinutes')) {
      return Result.fail(
        'INVALID_SCHEDULE_COMMAND',
        'slotDurationMinutes is not a Doctor Control input; slot duration is Settings-authoritative'
      );
    }
    if (Object.prototype.hasOwnProperty.call(command, 'busCount') ||
        Object.prototype.hasOwnProperty.call(command, 'busNumber')) {
      return Result.fail(
        'INVALID_SCHEDULE_COMMAND',
        'Bus count is presentation-only and is not a schedule input'
      );
    }
    return Result.ok(true);
  },


  _execute: function(commandName, controlContext, command, builder) {
    var envelope = this._validateEnvelope(controlContext, command);
    if (!envelope.ok) return envelope;
    var scope = envelope.data;

    var self = this;
    return CommandExecutor.execute(commandName, { phone: scope.doctorId, slotId: '' }, function() {
      return ScheduleChangeRepository.runExclusiveForScope(scope.doctorId, scope.clinicId, function() {
        var existing = ScheduleChangeRepository.findByCommandIdResult(
          scope.doctorId,
          scope.clinicId,
          command.commandId
        );
        if (!existing.ok) return existing;
        if (existing.data) {
          return Result.ok({
            status: 'IDEMPOTENT_REPLAY',
            record: existing.data
          });
        }

        var baselineResult = DoctorScheduleReadService.readCurrentEffectiveSchedule({
          actorId: scope.doctorId,
          scope: { clinicId: scope.clinicId }
        });
        if (!baselineResult.ok) return baselineResult;

        var listResult = ScheduleChangeRepository.listByScopeResult(scope.doctorId, scope.clinicId);
        if (!listResult.ok) return listResult;

        var built = builder(scope, command, baselineResult.data, listResult.data);
        if (!built.ok) return built;

        var appended = ScheduleChangeRepository.appendCommitted(built.data.record);
        if (!appended.ok) return appended;

        return Result.ok({
          status: 'COMMITTED',
          record: appended.data,
          before: built.data.record.before,
          after: built.data.record.after
        });
      });
    });
  },

  _buildRecurring: function(scope, command, baseline, records) {
    var asOf = EffectiveScheduleService.parseLocalDateTime(command.asOf);
    if (!asOf.ok) return asOf;

    // M4-C Continuation §5.3: recurring change is a calendar-day change.
    // The doctor selects a local date; the operational boundary is
    // 00:00 Asia/Baghdad of that date. Enforced here (application level)
    // so no caller can bypass it.
    var effectiveStamp = null;
    if (typeof command.effectiveDate === 'string' && command.effectiveDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(command.effectiveDate)) {
        return Result.fail('INVALID_EFFECTIVE_FROM', 'effectiveDate must be YYYY-MM-DD');
      }
      effectiveStamp = command.effectiveDate + 'T00:00';
    } else {
      effectiveStamp = command.effectiveFrom;
    }
    var from = EffectiveScheduleService.parseLocalDateTime(effectiveStamp);
    if (!from.ok) {
      return Result.fail('INVALID_EFFECTIVE_FROM', 'effectiveFrom must be YYYY-MM-DDTHH:mm');
    }
    if (from.data.minutes !== 0) {
      return Result.fail(
        'RECURRING_EFFECTIVE_BOUNDARY_INVALID',
        'Recurring changes start at 00:00 Asia/Baghdad of the selected local date; intra-day recurring activation is not supported in v1'
      );
    }
    if (EffectiveScheduleService.compareStamps(from.data.stamp, asOf.data.stamp) < 0) {
      return Result.fail(
        'CHANGE_EFFECTIVE_IN_PAST',
        'Recurring change must not rewrite past operational time'
      );
    }

    var payloadResult = this._validateRecurringPayload(command.schedule);
    if (!payloadResult.ok) return payloadResult;

    var conflict = this._recurringEffectiveFromConflict(records, asOf.data.stamp, from.data.stamp);
    if (!conflict.ok) return conflict;

    var before = this._snapshot(baseline, records);
    var record = {
      scope: scope,
      actorId: scope.doctorId,
      commandId: command.commandId,
      changeKind: ScheduleChangeRepository.KIND.RECURRING,
      effectiveFrom: from.data.stamp,
      effectiveTo: null,
      payload: payloadResult.data,
      targetChangeId: null,
      before: before,
      after: {
        kind: ScheduleChangeRepository.KIND.RECURRING,
        effectiveFrom: from.data.stamp,
        schedule: payloadResult.data
      }
    };
    return Result.ok({ record: record });
  },

  _buildTemporaryClose: function(scope, command, baseline, records) {
    return this._buildTemporary(
      scope,
      command,
      baseline,
      records,
      ScheduleChangeRepository.KIND.TEMPORARY_CLOSE,
      { intent: 'CLOSED' }
    );
  },

  _buildTemporaryOpen: function(scope, command, baseline, records) {
    // M4-C Continuation §7: exceptional open reuses the clinic's regular
    // configured Settings working window. The doctor provides only the
    // date; a custom window or partial-day open is rejected explicitly.
    if (Object.prototype.hasOwnProperty.call(command, 'workWindow')) {
      return Result.fail(
        'INVALID_SCHEDULE_COMMAND',
        'Exceptional open uses the regular Settings working window; a custom workWindow is not a v1 input'
      );
    }

    var dateStr = null;
    if (typeof command.date === 'string' && command.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(command.date)) {
        return Result.fail('INVALID_SCHEDULE_COMMAND', 'Exceptional open date must be YYYY-MM-DD');
      }
      dateStr = command.date;
    } else if (typeof command.effectiveFrom === 'string' &&
               /^\d{4}-\d{2}-\d{2}T00:00$/.test(command.effectiveFrom)) {
      // Full-day boundary form is accepted only when it exactly matches
      // [date T00:00, next-day T00:00) — anything else is partial-day.
      dateStr = command.effectiveFrom.substring(0, 10);
      var expectedTo = this._nextLocalDate(dateStr);
      if (!expectedTo.ok) return expectedTo;
      if (command.effectiveTo !== expectedTo.data + 'T00:00') {
        return Result.fail(
          'PARTIAL_DAY_EXCEPTIONAL_OPEN_UNSUPPORTED',
          'Partial-day exceptional opening is outside the v1 frozen contract'
        );
      }
    } else {
      return Result.fail(
        'PARTIAL_DAY_EXCEPTIONAL_OPEN_UNSUPPORTED',
        'Exceptional open accepts a whole local date only (partial-day opening is outside v1)'
      );
    }

    var next = this._nextLocalDate(dateStr);
    if (!next.ok) return next;

    var openCommand = Object.assign({}, command, {
      effectiveFrom: dateStr + 'T00:00',
      effectiveTo: next.data + 'T00:00'
    });

    return this._buildTemporary(
      scope,
      openCommand,
      baseline,
      records,
      ScheduleChangeRepository.KIND.TEMPORARY_OPEN,
      {
        intent: 'OPEN',
        workWindow: {
          start: baseline.workWindow.start,
          end: baseline.workWindow.end
        },
        workWindowSource: 'SETTINGS'
      }
    );
  },

  _buildTemporary: function(scope, command, baseline, records, kind, payload) {
    var asOf = EffectiveScheduleService.parseLocalDateTime(command.asOf);
    if (!asOf.ok) return asOf;
    var from = EffectiveScheduleService.parseLocalDateTime(command.effectiveFrom);
    var to = EffectiveScheduleService.parseLocalDateTime(command.effectiveTo);
    if (!from.ok) {
      return Result.fail('INVALID_EFFECTIVE_FROM', 'effectiveFrom must be YYYY-MM-DDTHH:mm');
    }
    if (!to.ok) {
      return Result.fail('INVALID_EFFECTIVE_TO', 'effectiveTo must be YYYY-MM-DDTHH:mm');
    }
    if (EffectiveScheduleService.compareStamps(from.data.stamp, asOf.data.stamp) < 0) {
      return Result.fail(
        'CHANGE_EFFECTIVE_IN_PAST',
        'Temporary override must not rewrite past operational time'
      );
    }
    if (EffectiveScheduleService.compareStamps(to.data.stamp, from.data.stamp) <= 0) {
      return Result.fail(
        'INVALID_EFFECTIVE_INTERVAL',
        'effectiveTo must be strictly after effectiveFrom ([start, end))'
      );
    }

    // M4-C Continuation §4.4: validation only — an override boundary that
    // falls strictly inside the applicable working window must land on the
    // existing slot grid. No rounding, splitting, or generation.
    var representable = this._validateGridRepresentability(
      baseline,
      records,
      [from.data, to.data]
    );
    if (!representable.ok) return representable;

    var overlap = this._temporaryOverlapConflict(
      records,
      asOf.data.stamp,
      from.data.stamp,
      to.data.stamp
    );
    if (!overlap.ok) return overlap;

    var before = this._snapshot(baseline, records);
    var record = {
      scope: scope,
      actorId: scope.doctorId,
      commandId: command.commandId,
      changeKind: kind,
      effectiveFrom: from.data.stamp,
      effectiveTo: to.data.stamp,
      payload: payload,
      targetChangeId: null,
      before: before,
      after: {
        kind: kind,
        effectiveFrom: from.data.stamp,
        effectiveTo: to.data.stamp,
        payload: payload
      }
    };
    return Result.ok({ record: record });
  },

  _buildCancel: function(scope, command, baseline, records) {
    var asOf = EffectiveScheduleService.parseLocalDateTime(command.asOf);
    if (!asOf.ok) return asOf;
    if (typeof command.targetChangeId !== 'string' || !command.targetChangeId) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'targetChangeId is required');
    }

    var target = null;
    var i;
    for (i = 0; i < records.length; i++) {
      if (records[i].changeId === command.targetChangeId) {
        target = records[i];
        break;
      }
    }
    if (!target) {
      return Result.fail('CHANGE_TARGET_NOT_FOUND', 'No schedule change matches targetChangeId');
    }
    if (target.scope.doctorId !== scope.doctorId ||
        String(target.scope.clinicId || '') !== String(scope.clinicId || '')) {
      return Result.fail('CHANGE_TARGET_WRONG_SCOPE', 'Target change belongs to another scope');
    }
    if (target.changeKind === ScheduleChangeRepository.KIND.CANCEL) {
      return Result.fail('CHANGE_NOT_CANCELLABLE', 'A cancellation record cannot be cancelled');
    }

    for (i = 0; i < records.length; i++) {
      if (records[i].changeKind === ScheduleChangeRepository.KIND.CANCEL &&
          records[i].targetChangeId === target.changeId) {
        return Result.fail('CHANGE_ALREADY_CANCELLED', 'Target change is already cancelled');
      }
    }

    var before = this._snapshot(baseline, records);
    var record = {
      scope: scope,
      actorId: scope.doctorId,
      commandId: command.commandId,
      changeKind: ScheduleChangeRepository.KIND.CANCEL,
      effectiveFrom: asOf.data.stamp,
      effectiveTo: null,
      payload: { targetChangeId: target.changeId },
      targetChangeId: target.changeId,
      before: before,
      after: {
        kind: ScheduleChangeRepository.KIND.CANCEL,
        targetChangeId: target.changeId
      }
    };
    return Result.ok({ record: record });
  },

  _validateRecurringPayload: function(schedule) {
    if (!schedule || typeof schedule !== 'object') {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'Recurring change requires a schedule payload');
    }
    // M4-C Continuation §4.1: duration/bus-count must not ride inside
    // the schedule payload either.
    if (Object.prototype.hasOwnProperty.call(schedule, 'slotDurationMinutes')) {
      return Result.fail(
        'INVALID_SCHEDULE_COMMAND',
        'slotDurationMinutes is not a Doctor Control input; slot duration is Settings-authoritative'
      );
    }
    if (Object.prototype.hasOwnProperty.call(schedule, 'busCount') ||
        Object.prototype.hasOwnProperty.call(schedule, 'busNumber')) {
      return Result.fail(
        'INVALID_SCHEDULE_COMMAND',
        'Bus count is presentation-only and is not a schedule input'
      );
    }
    var days = {};
    var keys = EffectiveScheduleService.DAY_KEYS;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (!Object.prototype.hasOwnProperty.call(schedule, key) &&
          !(schedule.days && Object.prototype.hasOwnProperty.call(schedule.days, key))) {
        return Result.fail('INVALID_SCHEDULE_COMMAND', 'Recurring schedule is missing day ' + key);
      }
      var raw = schedule.days ? schedule.days[key] : schedule[key];
      if (raw !== true && raw !== false) {
        return Result.fail(
          'INVALID_SCHEDULE_COMMAND',
          'Recurring day ' + key + ' must be boolean true or false'
        );
      }
      days[key] = raw;
    }
    var windowSource = schedule.workWindow || {
      start: schedule.workStart || schedule.work_start,
      end: schedule.workEnd || schedule.work_end
    };
    var windowCheck = this._validateWorkWindow(windowSource);
    if (!windowCheck.ok) return windowCheck;
    return Result.ok({
      days: days,
      workWindow: windowCheck.data
    });
  },

  /**
   * §4.4 grid representability — VALIDATION ONLY.
   * A boundary instant strictly inside the working window effective at
   * that instant must be aligned to the configured Settings slot grid
   * (offset from window start divisible by the configured duration).
   * Boundaries at/outside the window edges are trivially representable.
   */
  _validateGridRepresentability: function(baseline, records, boundaries) {
    var duration = baseline.slotDurationMinutes;
    if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) {
      return Result.fail(
        'SCHEDULE_SOURCE_INVALID',
        'Configured slot duration is required to validate grid representability'
      );
    }
    for (var i = 0; i < boundaries.length; i++) {
      var boundary = boundaries[i];
      var active = EffectiveScheduleService._activeRecords(records, boundary.stamp);
      if (!active.ok) return active;
      var recurring = EffectiveScheduleService._effectiveRecurring(
        baseline,
        active.data,
        boundary.stamp
      );
      if (!recurring.ok) return recurring;
      var startMin = EffectiveScheduleService._clockToMinutes(recurring.data.workWindow.start);
      var endMin = EffectiveScheduleService._clockToMinutes(recurring.data.workWindow.end);
      if (startMin === null || endMin === null) {
        return Result.fail(
          'SCHEDULE_SOURCE_INVALID',
          'Effective working window is malformed; cannot validate representability'
        );
      }
      var m = boundary.minutes;
      if (m > startMin && m < endMin && ((m - startMin) % duration !== 0)) {
        return Result.fail(
          'UNREPRESENTABLE_SCHEDULE_INTERVAL',
          'Requested boundary ' + boundary.stamp + ' does not align to the existing slot grid (' +
            recurring.data.workWindow.start + ' + n×' + duration + 'min); partial-slot requests are rejected',
          {
            boundary: boundary.stamp,
            workWindow: recurring.data.workWindow,
            slotDurationMinutes: duration
          }
        );
      }
    }
    return Result.ok(true);
  },

  /**
   * Pure next-calendar-day helper for full-day override boundaries.
   * Single implementation lives in DateUtils (shared with the doctor
   * interaction boundary).
   */
  _nextLocalDate: function(dateStr) {
    var next = DateUtils.nextLocalDateString(dateStr);
    if (!next) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'Date is not a real calendar date: ' + dateStr);
    }
    return Result.ok(next);
  },

  _validateWorkWindow: function(window) {
    if (!window || typeof window.start !== 'string' || typeof window.end !== 'string') {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'workWindow.start/end are required');
    }
    var start = DoctorScheduleReadService._clockString(window.start);
    var end = DoctorScheduleReadService._clockString(window.end);
    if (!start.ok || !end.ok) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'workWindow clock values are malformed');
    }
    var startMin = DoctorScheduleReadService._clockToMinutes(start.data);
    var endMin = DoctorScheduleReadService._clockToMinutes(end.data);
    if (startMin === null || endMin === null || endMin <= startMin) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'workWindow is invalid');
    }
    return Result.ok({ start: start.data, end: end.data });
  },

  _recurringEffectiveFromConflict: function(records, asOfStamp, stamp) {
    var active = EffectiveScheduleService._activeRecords(records, asOfStamp);
    if (!active.ok) return active;
    for (var i = 0; i < active.data.length; i++) {
      var rec = active.data[i];
      if (rec.changeKind === ScheduleChangeRepository.KIND.RECURRING &&
          rec.effectiveFrom === stamp) {
        return Result.fail(
          'SCHEDULE_INTENT_CONFLICT',
          'A recurring change already exists at this effectiveFrom',
          { changeId: rec.changeId }
        );
      }
    }
    return Result.ok(true);
  },

  _temporaryOverlapConflict: function(records, asOfStamp, fromStamp, toStamp) {
    var active = EffectiveScheduleService._activeRecords(records, asOfStamp);
    if (!active.ok) return active;
    for (var i = 0; i < active.data.length; i++) {
      var rec = active.data[i];
      if (rec.changeKind !== ScheduleChangeRepository.KIND.TEMPORARY_CLOSE &&
          rec.changeKind !== ScheduleChangeRepository.KIND.TEMPORARY_OPEN) {
        continue;
      }
      if (!rec.effectiveFrom || !rec.effectiveTo) continue;
      var overlaps = EffectiveScheduleService.compareStamps(fromStamp, rec.effectiveTo) < 0 &&
        EffectiveScheduleService.compareStamps(rec.effectiveFrom, toStamp) < 0;
      if (overlaps) {
        return Result.fail(
          'SCHEDULE_INTENT_CONFLICT',
          'Temporary override overlaps an existing override',
          { changeId: rec.changeId }
        );
      }
    }
    return Result.ok(true);
  },

  _snapshot: function(baseline, records) {
    var ids = [];
    for (var i = 0; i < records.length; i++) {
      ids.push(records[i].changeId);
    }
    return {
      baseline: {
        days: baseline.days,
        workWindow: baseline.workWindow,
        slotDurationMinutes: baseline.slotDurationMinutes,
        source: baseline.source
      },
      existingChangeIds: ids
    };
  },

  _scopeFromControlContext: function(controlContext) {
    if (!controlContext || typeof controlContext !== 'object' ||
        typeof controlContext.actorId !== 'string' || !controlContext.actorId) {
      return Result.fail(
        'INVALID_CONTROL_CONTEXT',
        'Schedule commands require a control context from M4-A'
      );
    }
    var clinicId = null;
    if (controlContext.scope &&
        Object.prototype.hasOwnProperty.call(controlContext.scope, 'clinicId') &&
        controlContext.scope.clinicId !== undefined) {
      clinicId = controlContext.scope.clinicId;
    }
    return Result.ok({
      doctorId: controlContext.actorId,
      clinicId: clinicId
    });
  }
};
