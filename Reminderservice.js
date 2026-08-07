/**
 * ReminderService.gs — كامل
 * أُضيفت: processPendingReminders(sendFn)
 */
const ReminderService = {

  collectPendingReminders: function() {
    var now = Clock.now();
    var nowMs = now.getTime();
    var windowEndMs = DateUtils.addMinutes(now, Config.SYSTEM_POLICY.REMINDER_LEAD_MINUTES).getTime();

    var candidates = SlotRepository.query(function(row) {
      if (row.status !== Config.VOCABULARY.STATUS.CONFIRMED) return false;
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
    var appointmentDisplay = 'بتاريخ ' + DateUtils.formatDateDisplay(slot.date) +
      ' — ' + (busResult.ok
        ? 'رقم الباص: ' + busResult.data.busNumber
        : 'الساعة ' + DateUtils.formatTimeDisplay(slot.time));
    return 'تذكير: موعدك اقترب ' + appointmentDisplay +
      '. يرجى الحضور ضمن وقت دوام العيادة.';
  }
};
