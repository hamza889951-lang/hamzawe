/**
 * StateMachine
 * المصدر الرسمي الوحيد لانتقالات حالة Slot (CAS-004، ADR-004).
 *
 * قرار معتمد (ADR-008):
 * في الإصدار الأول، يمثل Slot حالة التوفر فقط (لا كيان Appointment مستقل بعد).
 * لذلك CancelAppointment يعيد Slot إلى FREE مباشرة، دون المرور بـ CANCELLED.
 * عند فصل Appointment مستقبلاً، تنتقل دلالة CANCELLED لتصبح خاصية له حصراً،
 * بينما يبقى Slot.status = FREE يمثل التوفر فقط.
 */
const StateMachine = {

  transitions: {
    FREE: {
      ReserveSlot: Config.VOCABULARY.STATUS.RESERVED,
      ExpireSlot: Config.VOCABULARY.STATUS.EXPIRED
    },
    RESERVED: {
      ConfirmReservation: Config.VOCABULARY.STATUS.CONFIRMED,
      CleanupReservation: Config.VOCABULARY.STATUS.FREE
    },
    CONFIRMED: {
      CompleteAppointment: Config.VOCABULARY.STATUS.COMPLETED,
      CancelAppointment: Config.VOCABULARY.STATUS.FREE,  // راجع ADR-008 أعلاه
      MarkNoShow: Config.VOCABULARY.STATUS.NO_SHOW
    },
    COMPLETED: {},
    NO_SHOW: {},
    EXPIRED: {},
    CANCELLED: {}
  },

  /**
   * @param {string} from - الحالة الحالية
   * @param {string} command - اسم الأمر المطلوب تنفيذه
   * @returns {string|null} الحالة الجديدة، أو null إن كان الانتقال غير معرَّف
   */
  resolve(from, command) {
    const allowed = this.transitions[from];
    if (!allowed || !allowed.hasOwnProperty(command)) return null;
    return allowed[command];
  },

  /** @returns {boolean} فحص سريع دون الحاجة للحالة الناتجة */
  canExecute(from, command) {
    return this.resolve(from, command) !== null;
  }
};