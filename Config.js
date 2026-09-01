/**
 * Config
 * المعجم الثابت للنظام، مقسّم داخليًا إلى ثلاثة أقسام واضحة (بتوجيه المشرف G):
 *
 * - VOCABULARY: لغة النظام الأساسية (أسماء حالات/أوامر/أوراق) — لا تتغير.
 * - SYSTEM_POLICY: سياسات تشغيل النظام (مهلات، حدود زمنية) تختلف عن
 *   Business Rules الحقيقية الموجودة في Domain، ولا تُخلط بها.
 * - DEFAULTS: قيم افتراضية عامة (فارغ حاليًا)، محجوزة للنمو المستقبلي.
 *
 * ملاحظة: هذا الملف لا يحتوي أي إعداد قابل للتغيير من قِبل العيادة
 * نفسها — تلك مسؤولية SettingsRepository (ورقة Settings) وفق CAS-006.
 */
const Config = {
  VOCABULARY: {
    SHEETS: {
      AVAILABILITY: 'Availability',
      CONVERSATIONS: 'Conversations',
      SETTINGS: 'Settings',
      SYSTEM_LOG: 'SYSTEM_LOG',
      SCHEDULE_CHANGES: 'ScheduleChanges'
    },
    STATUS: {
      FREE: 'FREE',
      RESERVED: 'RESERVED',
      CONFIRMED: 'CONFIRMED',
      CANCELLED: 'CANCELLED', // محجوزة لكيان Appointment مستقبلاً — راجع ADR-008
      COMPLETED: 'COMPLETED',
      NO_SHOW: 'NO_SHOW',
      EXPIRED: 'EXPIRED'
    },
    COMMANDS: {
      RESERVE_SLOT: 'ReserveSlot',
      CONFIRM_RESERVATION: 'ConfirmReservation',
      CLEANUP_RESERVATION: 'CleanupReservation',
      CANCEL_APPOINTMENT: 'CancelAppointment',
      CHANGE_APPOINTMENT: 'ChangeAppointment',
      COMPLETE_APPOINTMENT: 'CompleteAppointment',
      MARK_NO_SHOW: 'MarkNoShow',
      EXPIRE_SLOT: 'ExpireSlot',
      GENERATE_AVAILABILITY: 'GenerateAvailability',
      COMMIT_RECURRING_SCHEDULE_CHANGE: 'CommitRecurringScheduleChange',
      COMMIT_TEMPORARY_CLOSE_OVERRIDE: 'CommitTemporaryCloseOverride',
      COMMIT_EXCEPTIONAL_OPEN_OVERRIDE: 'CommitExceptionalOpenOverride',
      CANCEL_SCHEDULE_CHANGE: 'CancelScheduleChange'
    },
    CONVERSATION_STATE: {
      MENU_MAIN: 'MENU_MAIN',
      WAITING_NAME: 'WAITING_NAME',
      WAITING_CONFIRMATION: 'WAITING_CONFIRMATION',
      BOOKED: 'BOOKED',
      // M4-C Continuation — Doctor Control interaction states (additive).
      // Doctor rows in Conversations are unreachable by patient routing:
      // the M4-A gate diverts the authorized doctor before patient flows.
      DOCTOR_MENU: 'DOCTOR_MENU',
      DOCTOR_AWAITING_INPUT: 'DOCTOR_AWAITING_INPUT',
      DOCTOR_AWAITING_CONFIRMATION: 'DOCTOR_AWAITING_CONFIRMATION'
    }
  },

  /**
   * سياسات تشغيل النظام (ليست قواعد عمل منطقية Business Rules) —
   * حدود تشغيلية ثابتة لإصدار v1. راجعها المشرف وأبقاها هنا مؤقتًا
   * (لا تظهر في ورقة Settings حسب توثيق المشروع الأصلي).
   */
  SYSTEM_POLICY: {
    RESERVATION_TIMEOUT_MINUTES: 5,
    MIN_BOOKING_LEAD_MINUTES: 60,
    // نافذة تذكير واحدة فقط في v1: 4 ساعات قبل الموعد.
    REMINDER_LEAD_MINUTES: 240
  },
  /**
   * قيم افتراضية عامة — محجوزة للنمو المستقبلي، فارغة حاليًا عمدًا.
   */
  DEFAULTS: {}
};