/**
 * ReminderService.gs — كامل
 * أُضيفت: processPendingReminders(sendFn)
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

    var candidates = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.CONFIRMED) return false;
      // M4-C Continuation §15: operational availability gate — a reminder
      // is suppressed while is_available=false. No new reminder state; if
      // the slot reopens inside the window and Reminder_sent is still not
      // TRUE, the existing process sends normally.
      if (!SlotRepository.isOperationallyAvailable(row.is_available)) return false;
      if (ReminderService._isReminderAlreadySent(row.Reminder_sent)) return false;
      var startMs = LegacySlotTimeParser.toComparableTime(row.sort_key);
      if (startMs === null) return false;
      if (startMs <= nowMs) return false;
      return startMs <= windowEndMs;
    });

    var jobs = candidates.map(function(slot) {
      return {
        slotId: slot.slot_id,
        phone: slot.phone,
        message: ReminderService._buildReminderMessage(slot)
      };
    });

    return Result.ok(jobs);
  },

  processPendingReminders: function(sendFn) {
    var jobsResult = this.collectPendingReminders();
    if (!jobsResult.ok) return jobsResult;
    var jobs = jobsResult.data;
    var sent = 0;
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      var sendResult = sendFn(job.phone, job.message);
      if (sendResult.ok) {
        var markResult = ReminderService.markReminderSent(job.slotId);
        if (markResult.ok) sent++;
      }
    }
    return Result.ok({ sent: sent, total: jobs.length });
  },

  markReminderSent: function(slotId) {
    return SlotRepository.atomicUpdate(slotId, function(freshSlot) {
      return Result.ok({ Reminder_sent: 'TRUE' });
    });
  },

  _isReminderAlreadySent: function(value) {
    if (value === true) return true;
    if (typeof value === 'string' && value.trim().toUpperCase() === 'TRUE') return true;
    return false;
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

    // Fail closed for patient presentation: never reveal slot.time as a
    // fallback. Keep the reminder useful without exposing the exact slot.
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
    if (typeof text !== 'string') return null;
    var match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    var hour = parseInt(match[1], 10);
    var minute = parseInt(match[2], 10);
    if (isNaN(hour) || isNaN(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour: hour, minute: minute };
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
