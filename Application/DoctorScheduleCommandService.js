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

  _execute: function(commandName, controlContext, command, builder) {
    var scopeResult = this._scopeFromControlContext(controlContext);
    if (!scopeResult.ok) return scopeResult;
    var scope = scopeResult.data;

    if (!command || typeof command !== 'object') {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'Schedule command payload is required');
    }
    if (typeof command.commandId !== 'string' || !command.commandId) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'commandId is required');
    }
    if (typeof command.asOf !== 'string' || !command.asOf) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'asOf local datetime is required');
    }

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
    var from = EffectiveScheduleService.parseLocalDateTime(command.effectiveFrom);
    if (!from.ok) {
      return Result.fail('INVALID_EFFECTIVE_FROM', 'effectiveFrom must be YYYY-MM-DDTHH:mm');
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
    if (!command.workWindow) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'Exceptional open requires workWindow');
    }
    var windowCheck = this._validateWorkWindow(command.workWindow);
    if (!windowCheck.ok) return windowCheck;
    return this._buildTemporary(
      scope,
      command,
      baseline,
      records,
      ScheduleChangeRepository.KIND.TEMPORARY_OPEN,
      { intent: 'OPEN', workWindow: windowCheck.data }
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
    var duration = schedule.slotDurationMinutes;
    if (typeof duration !== 'number' || !isFinite(duration) || duration <= 0) {
      return Result.fail('INVALID_SCHEDULE_COMMAND', 'slotDurationMinutes must be a positive number');
    }
    return Result.ok({
      days: days,
      workWindow: windowCheck.data,
      slotDurationMinutes: duration
    });
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
