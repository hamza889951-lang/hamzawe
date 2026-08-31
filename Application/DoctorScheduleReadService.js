/**
 * ═══════════════════════════════════════
 * CONTRACT — DoctorScheduleReadService
 * ═══════════════════════════════════════
 * M4-B — Doctor Schedule Read / Effective Schedule Boundary (read-only).
 *
 * يضمن:
 * - قراءة recurring weekly schedule الحالي عبر SettingsRepository فقط.
 * - تحويل صف Settings الخام إلى application-level Effective Schedule
 *   model دلالي، حتى لا تحتاج المراحل اللاحقة (M4-C+) إلى معرفة أسماء
 *   أعمدة Sheet.
 * - في v1: Effective Schedule = recurring Settings الحالي (لا overrides).
 * - fail-closed على المصدر: unavailable / missing / malformed / invalid
 *   → Result.fail ظاهر، وليس closed / empty / healthy / fallback صامت.
 * - استقبال scope/هوية من M4-A (controlContext) دون إعادة authorization
 *   ودون قراءة DOCTOR_PHONE / ADMIN_PHONE.
 *
 * لا يضمن:
 * - أي schedule mutation أو override persistence.
 * - أي Availability / is_available / Slot lifecycle.
 * - أي Appointment / Calendar / WhatsApp / Router / UX.
 * - أي current-time interpretation للجدول.
 *
 * Dependency direction:
 *   Application → SettingsRepository → GoogleSheets
 * ولا العكس. كل مراجع الوحدات الأخرى تُحلّ عند الاستدعاء (clasp order).
 */
const DoctorScheduleReadService = {

  SOURCE: 'SETTINGS',
  RECURRENCE: 'WEEKLY',
  TIMEZONE: 'Asia/Baghdad',

  DAY_KEYS: [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday'
  ],

  /**
   * يقرأ الجدول الفعّال الحالي للطبيب المصرّح له.
   *
   * @param {Object} controlContext — من DoctorControlEntry / ActorContext
   *        يتطلب actorId؛ scope.clinicId اختياري (v1: null).
   * @returns {Result}
   *   ok(effectiveSchedule) |
   *   fail('INVALID_CONTROL_CONTEXT') |
   *   fail('SETTINGS_NOT_CONFIGURED' | 'SETTINGS_READ_FAILED') |
   *   fail('SCHEDULE_SOURCE_INVALID')
   */
  readCurrentEffectiveSchedule: function(controlContext) {
    var scopeResult = this._scopeFromControlContext(controlContext);
    if (!scopeResult.ok) return scopeResult;

    var settingsResult = SettingsRepository.getSettingsResult();
    if (!settingsResult.ok) return settingsResult;

    return this._toEffectiveSchedule(scopeResult.data, settingsResult.data);
  },

  /**
   * @param {Object} controlContext
   * @returns {Result} ok({ doctorId, clinicId })
   */
  _scopeFromControlContext: function(controlContext) {
    if (!controlContext || typeof controlContext !== 'object') {
      return Result.fail(
        'INVALID_CONTROL_CONTEXT',
        'Doctor schedule read requires a control context from M4-A'
      );
    }
    var actorId = controlContext.actorId;
    if (typeof actorId !== 'string' || !actorId) {
      return Result.fail(
        'INVALID_CONTROL_CONTEXT',
        'Doctor schedule read requires controlContext.actorId'
      );
    }
    var clinicId = null;
    if (controlContext.scope &&
        Object.prototype.hasOwnProperty.call(controlContext.scope, 'clinicId') &&
        controlContext.scope.clinicId !== undefined) {
      clinicId = controlContext.scope.clinicId;
    }
    return Result.ok({
      doctorId: actorId,
      clinicId: clinicId
    });
  },

  /**
   * يحول صف Settings إلى نموذج دلالي. لا يُرجع الصف الخام.
   *
   * @param {{doctorId: string, clinicId: *}} scope
   * @param {Object} settings
   * @returns {Result}
   */
  _toEffectiveSchedule: function(scope, settings) {
    if (!settings || typeof settings !== 'object') {
      return Result.fail(
        'SCHEDULE_SOURCE_INVALID',
        'Settings row is missing or unreadable'
      );
    }

    var start = this._clockString(settings.work_start);
    var end = this._clockString(settings.work_end);
    if (!start.ok) {
      return Result.fail(
        'SCHEDULE_SOURCE_INVALID',
        'Settings work_start is missing or malformed',
        { work_start: settings.work_start }
      );
    }
    if (!end.ok) {
      return Result.fail(
        'SCHEDULE_SOURCE_INVALID',
        'Settings work_end is missing or malformed',
        { work_end: settings.work_end }
      );
    }

    var startMin = this._clockToMinutes(start.data);
    var endMin = this._clockToMinutes(end.data);
    if (startMin === null || endMin === null || endMin <= startMin) {
      return Result.fail(
        'SCHEDULE_SOURCE_INVALID',
        'Settings work_start / work_end values are invalid or work_end <= work_start',
        {
          work_start: start.data,
          work_end: end.data,
          startMin: startMin,
          endMin: endMin
        }
      );
    }

    var durationInfo = SettingsRepository.getSlotDurationInfo(settings);
    if (!durationInfo || durationInfo.source !== 'CONFIGURED') {
      return Result.fail(
        'SCHEDULE_SOURCE_INVALID',
        'Slot duration is not configured; silent default is not a schedule',
        {
          slotDurationInfo: durationInfo || null,
          key: SettingsRepository.SLOT_DURATION_SETTINGS_KEY
        }
      );
    }
    if (typeof durationInfo.minutes !== 'number' ||
        !isFinite(durationInfo.minutes) ||
        durationInfo.minutes <= 0) {
      return Result.fail(
        'SCHEDULE_SOURCE_INVALID',
        'Configured slot duration is invalid',
        { slotDurationInfo: durationInfo }
      );
    }

    var days = {};
    var keys = this.DAY_KEYS;
    for (var i = 0; i < keys.length; i++) {
      days[keys[i]] = this._isWorkingDayFlag(settings[keys[i]]);
    }

    return Result.ok({
      scope: {
        doctorId: scope.doctorId,
        clinicId: scope.clinicId
      },
      source: this.SOURCE,
      recurrence: this.RECURRENCE,
      timezone: this.TIMEZONE,
      days: days,
      workWindow: {
        start: start.data,
        end: end.data
      },
      slotDurationMinutes: durationInfo.minutes
    });
  },

  /**
   * يقبل فقط H:mm أو HH:mm بعد trim، دون تطبيع parseInt الجزئي.
   * يحافظ على النص كما خُزّن (بعد trim) دون إعادة تنسيق.
   *
   * @param {*} value
   * @returns {Result} ok(string)
   */
  _clockString: function(value) {
    if (typeof value !== 'string') {
      return Result.fail('SCHEDULE_SOURCE_INVALID', 'Clock value is not a string');
    }
    var trimmed = value.trim();
    if (!/^\d{1,2}:\d{2}$/.test(trimmed)) {
      return Result.fail('SCHEDULE_SOURCE_INVALID', 'Clock value is not H:mm or HH:mm');
    }
    var parts = trimmed.split(':');
    var hour = parseInt(parts[0], 10);
    var minute = parseInt(parts[1], 10);
    if (hour > 23 || minute > 59) {
      return Result.fail('SCHEDULE_SOURCE_INVALID', 'Clock value is out of range');
    }
    return Result.ok(trimmed);
  },

  /**
   * @param {string} clock
   * @returns {number|null}
   */
  _clockToMinutes: function(clock) {
    var parts = String(clock).split(':');
    if (parts.length < 2) return null;
    var hour = parseInt(parts[0], 10);
    var minute = parseInt(parts[1], 10);
    if (isNaN(hour) || isNaN(minute)) return null;
    return hour * 60 + minute;
  },

  /**
   * نفس حقيقة SlotGenerator.isWorkingDay لقيمة علم اليوم:
   * true / "TRUE" فقط = يوم عمل. أي قيمة أخرى تبقى غير مفعّلة.
   *
   * @param {*} value
   * @returns {boolean}
   */
  _isWorkingDayFlag: function(value) {
    if (value === true) return true;
    if (typeof value === 'string' && value.trim().toUpperCase() === 'TRUE') return true;
    return false;
  }
};
