/**
 * SETTINGS-SCHEDULE-PROMOTION-v1
 * Activates due recurring schedule records into Settings.
 * Caller MUST already hold Lock.runExclusive (horizon currently owns it).
 * Settings writes are single-row, field-limited; history remains append-only.
 */
const SchedulePromotionService = {
  TIMEZONE: 'Asia/Baghdad',
  _scheduleFromSettings: function(settings) {
    var read = DoctorScheduleReadService._toEffectiveSchedule({ doctorId: 'promotion', clinicId: null }, settings);
    if (!read.ok) return read;
    return Result.ok({
      days: read.data.days,
      workWindow: { start: read.data.workWindow.start, end: read.data.workWindow.end }
    });
  },
  _scheduleFromPayload: function(rec) {
    var p = rec && rec.payload;
    if (!p || p.__malformed || !p.days || !p.workWindow ||
        typeof p.workWindow.start !== 'string' || typeof p.workWindow.end !== 'string') {
      return Result.fail('SCHEDULE_CHANGE_SOURCE_INVALID', 'Recurring promotion payload is malformed', { changeId: rec && rec.changeId });
    }
    var days = {};
    var keys = EffectiveScheduleService.DAY_KEYS;
    for (var i = 0; i < keys.length; i++) {
      if (p.days[keys[i]] !== true && p.days[keys[i]] !== false) {
        return Result.fail('SCHEDULE_CHANGE_SOURCE_INVALID', 'Recurring payload day flag is invalid', { changeId: rec.changeId, day: keys[i] });
      }
      days[keys[i]] = p.days[keys[i]];
    }
    var window = DoctorScheduleCommandService._validateWorkWindow(p.workWindow);
    if (!window.ok) return Result.fail('SCHEDULE_CHANGE_SOURCE_INVALID', 'Recurring payload work window is invalid', { changeId: rec.changeId });
    return Result.ok({ days: days, workWindow: window.data });
  },
  _canonical: function(schedule) {
    var out = { days: {}, workWindow: { start: schedule.workWindow.start, end: schedule.workWindow.end } };
    EffectiveScheduleService.DAY_KEYS.forEach(function(k) { out.days[k] = schedule.days[k] === true; });
    return out;
  },
  fingerprint: function(schedule) {
    return JSON.stringify(this._canonical(schedule));
  },
  _latestStates: function(events) {
    return SchedulePromotionLedgerRepository.latestByChangeId(events);
  },
  filterPromotedRecords: function(records, ledgerEvents) {
    var states = this._latestStates(ledgerEvents || []);
    if (!states.ok) return states;
    var pending = Object.keys(states.data).filter(function(id) {
      return states.data[id].state === 'PREPARED';
    });
    if (pending.length) {
      return Result.fail('SCHEDULE_PROMOTION_IN_PROGRESS', 'A recurring schedule promotion is incomplete; source projection is blocked until recovery', { changeIds: pending });
    }
    var filtered = (records || []).filter(function(rec) {
      return !(states.data[rec.changeId] && states.data[rec.changeId].state === 'COMPLETED');
    });
    return Result.ok(filtered);
  },
  activateDue: function(controlContext, nowStamp) {
    var scope = EffectiveScheduleService._scopeFromControlContext(controlContext);
    if (!scope.ok) return scope;
    var parsedNow = EffectiveScheduleService.parseLocalDateTime(nowStamp);
    if (!parsedNow.ok) return parsedNow;

    // Fresh reads while caller owns script-wide lock.
    var settingsResult = SettingsRepository.getSettingsResult();
    if (!settingsResult.ok) return settingsResult;
    var baseCheck = DoctorScheduleReadService._toEffectiveSchedule(scope.data, settingsResult.data);
    if (!baseCheck.ok) return baseCheck;

    var changesResult = ScheduleChangeRepository.listByScopeResult(scope.data.doctorId, scope.data.clinicId);
    if (!changesResult.ok) return changesResult;
    var ledgerResult = SchedulePromotionLedgerRepository.listByScopeResult(scope.data.doctorId, scope.data.clinicId);
    if (!ledgerResult.ok) return ledgerResult;
    var statesResult = this._latestStates(ledgerResult.data);
    if (!statesResult.ok) return statesResult;
    var states = statesResult.data;

    // Resolve cancellation at now; malformed records are rejected by canonical projection.
    var activeResult = EffectiveScheduleService._activeRecords(changesResult.data, parsedNow.data.stamp);
    if (!activeResult.ok) return activeResult;
    // Detect manual/out-of-band Settings drift against the latest completed
    // promotion only. Older completed entries naturally differ after a later
    // promotion and must not be misclassified as drift.
    var latestCompleted = null;
    Object.keys(states).forEach(function(id) {
      var event = states[id];
      if (event.state === 'COMPLETED' &&
          (!latestCompleted || event.effectiveFrom > latestCompleted.effectiveFrom)) latestCompleted = event;
    });
    var hasPrepared = Object.keys(states).some(function(id) {
      return states[id].state === 'PREPARED';
    });
    if (latestCompleted && !hasPrepared) {
      var currentForDrift = this._scheduleFromSettings(settingsResult.data);
      if (!currentForDrift.ok) return currentForDrift;
      if (this.fingerprint(currentForDrift.data) !== latestCompleted.targetFingerprint) {
        return Result.fail('SCHEDULE_PROMOTION_BASELINE_DRIFT', 'Settings no longer match the latest completed promotion; manual/out-of-band change requires review', { changeId: latestCompleted.changeId });
      }
    }

    var due = activeResult.data.filter(function(r) {
      return r.changeKind === ScheduleChangeRepository.KIND.RECURRING &&
        typeof r.effectiveFrom === 'string' && r.effectiveFrom <= parsedNow.data.stamp &&
        (!states[r.changeId] || states[r.changeId].state !== 'COMPLETED');
    });
    due.sort(function(a,b) {
      if (a.effectiveFrom === b.effectiveFrom) return String(a.changeId).localeCompare(String(b.changeId));
      return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
    });
    for (var i = 1; i < due.length; i++) {
      if (due[i-1].effectiveFrom === due[i].effectiveFrom) {
        return Result.fail('SCHEDULE_INTENT_CONFLICT', 'Multiple due recurring changes share effectiveFrom; promotion blocked', { changeIds: [due[i-1].changeId, due[i].changeId] });
      }
    }

    for (var j = 0; j < due.length; j++) {
      var rec = due[j];
      var targetResult = this._scheduleFromPayload(rec);
      if (!targetResult.ok) return targetResult;
      var target = this._canonical(targetResult.data);
      var targetFingerprint = this.fingerprint(target);
      var currentSettingsResult = SettingsRepository.getSettingsResult();
      if (!currentSettingsResult.ok) return currentSettingsResult;
      var currentResult = this._scheduleFromSettings(currentSettingsResult.data);
      if (!currentResult.ok) return currentResult;
      var currentFingerprint = this.fingerprint(currentResult.data);
      var state = states[rec.changeId];

      if (state && state.state === 'PREPARED') {
        // Crash recovery: either the settings write never happened, or it did.
        if (currentFingerprint === state.targetFingerprint) {
          var recovered = SchedulePromotionLedgerRepository.appendEvent({
            changeId: rec.changeId, doctorId: scope.data.doctorId, clinicId: scope.data.clinicId,
            effectiveFrom: rec.effectiveFrom, state: 'COMPLETED',
            beforeFingerprint: state.beforeFingerprint, targetFingerprint: state.targetFingerprint,
            detail: { recovered: true, method: 'TARGET_FINGERPRINT_MATCH' }
          });
          if (!recovered.ok) return recovered;
          states[rec.changeId] = recovered.data;
          continue;
        }
        if (currentFingerprint !== state.beforeFingerprint) {
          return Result.fail('SCHEDULE_PROMOTION_RECOVERY_AMBIGUOUS', 'Settings match neither prepared before nor target fingerprint; refusing overwrite', { changeId: rec.changeId });
        }
      } else if (state && state.state === 'COMPLETED') {
        continue;
      } else if (state && state.state !== 'FAILED') {
        return Result.fail('SCHEDULE_PROMOTION_LEDGER_INVALID', 'Unexpected promotion ledger state', { changeId: rec.changeId, state: state.state });
      }

      if (currentFingerprint !== targetFingerprint) {
        var prepared = SchedulePromotionLedgerRepository.appendEvent({
          changeId: rec.changeId, doctorId: scope.data.doctorId, clinicId: scope.data.clinicId,
          effectiveFrom: rec.effectiveFrom, state: 'PREPARED',
          beforeFingerprint: currentFingerprint, targetFingerprint: targetFingerprint,
          detail: { version: 1 }
        });
        if (!prepared.ok) return prepared;
        states[rec.changeId] = prepared.data;

        var fields = {};
        EffectiveScheduleService.DAY_KEYS.forEach(function(k) { fields[k] = target.days[k]; });
        fields.work_start = target.workWindow.start;
        fields.work_end = target.workWindow.end;
        var write = SettingsRepository.updateRecurringScheduleFields(fields);
        if (!write.ok) return write;

        var verifySettings = SettingsRepository.getSettingsResult();
        if (!verifySettings.ok) return verifySettings;
        var verifySchedule = this._scheduleFromSettings(verifySettings.data);
        if (!verifySchedule.ok) return verifySchedule;
        if (this.fingerprint(verifySchedule.data) !== targetFingerprint) {
          return Result.fail('SCHEDULE_PROMOTION_VERIFY_FAILED', 'Settings write did not read back as the intended schedule', { changeId: rec.changeId });
        }
      }

      var completed = SchedulePromotionLedgerRepository.appendEvent({
        changeId: rec.changeId, doctorId: scope.data.doctorId, clinicId: scope.data.clinicId,
        effectiveFrom: rec.effectiveFrom, state: 'COMPLETED',
        beforeFingerprint: currentFingerprint, targetFingerprint: targetFingerprint,
        detail: { verified: true }
      });
      if (!completed.ok) return completed;
      states[rec.changeId] = completed.data;
    }
    return Result.ok({ promoted: due.length, effectiveAt: parsedNow.data.stamp });
  }
};