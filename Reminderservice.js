/**
 * ReminderService.gs — كامل
 * Reliability hardening: surface read, send, and marker-persistence failures.
 *
 * Patient presentation rule:
 * - show appointment date + derived bus number + clinic work-start
 * - never expose the exact appointment slot time to the patient
 * - if presentation data cannot be derived reliably, do not substitute slot.time
 */
const ReminderService = {

  collectPendingReminders: function() {
    var now = Clock.now();
    var nowMs = now.getTime();
    var windowEndMs = DateUtils.addMinutes(now, Config.SYSTEM_POLICY.REMINDER_LEAD_MINUTES).getTime();

    // Use the Result-based repository boundary: query() intentionally maps
    // storage errors to [], which would make a failed read look like no work.
    var queryResult = SlotRepository.queryResult(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.CONFIRMED) return false;
      // M4-C Continuation §15: suppress reminders while operationally closed.
      if (!SlotRepository.isOperationallyAvailable(row.is_available)) return false;
      if (ReminderService._isReminderAlreadySent(row.Reminder_sent)) return false;
      var startMs = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (startMs === null) return false;
      if (startMs <= nowMs) return false;
      return startMs <= windowEndMs;
    });
    if (!queryResult || !queryResult.ok) {
      return queryResult || Result.fail(
        'REMINDER_CANDIDATE_READ_FAILED',
        'Reminder candidate query returned no result'
      );
    }

    try {
      var jobs = queryResult.data.map(function(slot) {
        return {
          slotId: slot.slot_id,
          phone: slot.phone,
          message: ReminderService._buildReminderMessage(slot),
          deliveryOptions: ReminderService._buildReminderDeliveryOptions(slot)
        };
      });
      return Result.ok(jobs);
    } catch (e) {
      return Result.fail(
        'REMINDER_CANDIDATE_PREPARATION_FAILED',
        'Failed to prepare one or more reminder jobs',
        { message: e.message || String(e) }
      );
    }
  },

  processPendingReminders: function(sendFn) {
    if (typeof sendFn !== 'function') {
      return Result.fail('REMINDER_SEND_FUNCTION_INVALID', 'A reminder send function is required');
    }

    var jobsResult = this.collectPendingReminders();
    if (!jobsResult || !jobsResult.ok) return jobsResult || Result.fail(
      'REMINDER_CANDIDATE_READ_FAILED',
      'Unable to collect pending reminders'
    );

    var jobs = jobsResult.data || [];
    var sent = 0;
    var sendFailed = 0;
    var markFailed = 0;
    var failures = [];

    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var sendResult;
      try {
        sendResult = sendFn(job.phone, job.message, job.deliveryOptions);
      } catch (e) {
        sendFailed++;
        var thrownFailure = {
          slotId: job.slotId || null,
          phase: 'SEND',
          code: 'REMINDER_SEND_EXCEPTION',
          message: e && e.message ? e.message : String(e)
        };
        failures.push(thrownFailure);
        this._writeFailureLog(thrownFailure);
        continue;
      }

      if (!sendResult || sendResult.ok !== true) {
        sendFailed++;
        var sendError = sendResult && sendResult.error ? sendResult.error : {};
        var sendFailure = {
          slotId: job.slotId || null,
          phase: 'SEND',
          code: sendError.code || 'REMINDER_SEND_FAILED',
          message: sendError.message || 'Send function did not confirm success'
        };
        failures.push(sendFailure);
        this._writeFailureLog(sendFailure);
        continue;
      }

      // Sending and persisting Reminder_sent are not atomic. Do not claim
      // completion unless both operations succeed; marker failure can permit
      // a later retry and therefore a duplicate provider send.
      var markResult;
      try {
        markResult = ReminderService.markReminderSent(job.slotId);
      } catch (e) {
        markResult = Result.fail(
          'REMINDER_MARK_EXCEPTION',
          e && e.message ? e.message : String(e)
        );
      }

      if (markResult && markResult.ok === true) {
        sent++;
      } else {
        markFailed++;
        var markError = markResult && markResult.error ? markResult.error : {};
        var markFailure = {
          slotId: job.slotId || null,
          phase: 'MARK',
          code: markError.code || 'REMINDER_MARK_FAILED',
          message: markError.message || 'Reminder was sent but its sent marker was not confirmed'
        };
        failures.push(markFailure);
        this._writeFailureLog(markFailure);
      }
    }

    var summary = {
      sent: sent,
      total: jobs.length,
      sendFailed: sendFailed,
      markFailed: markFailed,
      failed: sendFailed + markFailed
    };

    if (summary.failed > 0) {
      return Result.fail(
        'REMINDER_PARTIAL_FAILURE',
        'One or more reminders could not be completed',
        { counts: summary, failures: failures }
      );
    }
    return Result.ok(summary);
  },

  markReminderSent: function(slotId) {
    return SlotRepository.atomicUpdate(slotId, function(freshSlot) {
      return Result.ok({ Reminder_sent: 'TRUE' });
    });
  },

  _writeFailureLog: function(failure) {
    try {
      LogRepository.write({
        timestamp: Clock.now(),
        command: 'REMINDER_' + failure.phase + '_FAILED',
        phone: '',
        slotId: failure.slotId || '',
        stage: 'REMINDERS',
        success: false,
        durationMs: null,
        error: JSON.stringify({
          code: failure.code,
          message: failure.message
        })
      });
    } catch (e) {
      // Logging is best-effort and must not prevent processing other jobs.
    }
  },

  _isReminderAlreadySent: function(value) {
    if (value === true) return true;
    if (typeof value === 'string' && value.trim().toUpperCase() === 'TRUE') return true;
    return false;
  },

  _buildReminderDeliveryOptions: function(slot) {
    var busResult = BusNumberCalculator.fromSlot(slot);
    var workStartResult = ReminderService._getClinicWorkStartDisplay();
    var dateDisplay = DateUtils.formatDateDisplay(slot.date);

    if (busResult.ok && workStartResult.ok) {
      return {
        kind: 'REMINDER',
        templateParameters: [dateDisplay, busResult.data.busNumber, workStartResult.data],
        buttonPayloads: [
          'HAMZAWE_CHANGE',
          'HAMZAWE_CANCEL'
        ]
      };
    }

    return {
      kind: 'REMINDER_NO_BUS',
      templateParameters: [dateDisplay],
      buttonPayloads: [
        'HAMZAWE_CHANGE',
        'HAMZAWE_CANCEL'
      ]
    };
  },

  _buildReminderMessage: function(slot) {
    var busResult = BusNumberCalculator.fromSlot(slot);
    var workStartResult = ReminderService._getClinicWorkStartDisplay();
    var dateDisplay = DateUtils.formatDateDisplay(slot.date);

    if (busResult.ok && workStartResult.ok) {
      return 'تذكير: موعدك اقترب بتاريخ ' + dateDisplay +
        ' — رقم الباص: ' + busResult.data.busNumber +
        '\nيبدأ دوام العيادة الساعة ' + workStartResult.data +
        '. يرجى الحضور ضمن وقت دوام العيادة.';
    }

    // Fail closed for patient presentation: never reveal slot.time as a fallback.
    return 'تذكير: موعدك اقترب بتاريخ ' + dateDisplay +
      '. تعذّر تحديد رقم الباص حاليًا؛ يرجى التواصل مع العيادة.';
  },

  _getClinicWorkStartDisplay: function() {
    try {
      var settings = SettingsRepository.getAll();
      var parsed = ReminderService._parseHourMinuteText(settings.work_start);
      if (!parsed) return Result.fail('PATIENT_PRESENTATION_UNAVAILABLE', 'Invalid work_start in Settings');
      return Result.ok(ReminderService._formatArabicClinicTime(parsed.hour, parsed.minute));
    } catch (e) {
      return Result.fail(
        'PATIENT_PRESENTATION_UNAVAILABLE',
        e.message || 'Unable to read clinic work_start for patient presentation'
      );
    }
  },

  _parseHourMinuteText: function(text) {
    var normalized = DateUtils.normalizeTime(text);
    if (!normalized) return null;
    var parts = normalized.split(':');
    return { hour: Number(parts[0]), minute: Number(parts[1]) };
  },

  _formatArabicClinicTime: function(hour, minute) {
    var suffix = hour < 12 ? 'صباحًا' : 'مساءً';
    var displayHour = hour % 12;
    if (displayHour === 0) displayHour = 12;
    var hh = displayHour < 10 ? '0' + displayHour : String(displayHour);
    var mm = minute < 10 ? '0' + minute : String(minute);
    return hh + ':' + mm + ' ' + suffix;
  }
};
