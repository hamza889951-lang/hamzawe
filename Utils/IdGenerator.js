/**
 * IdGenerator
 * ينشئ هويات كيانات النظام (CAS-007، CAS-009).
 * الهوية لا تحمل أي معنى، ولا تُشتق من تاريخ/وقت/رقم صف/قاعدة بيانات.
 */
const IdGenerator = {
  generateSlotId() {
    return 'SLT_' + ULID.generate();
  },
  generateConversationId() {
    return 'CONV_' + ULID.generate();
  },
  generateAppointmentId() {
    return 'APT_' + ULID.generate();
  },
  generateScheduleChangeId() {
    return 'SCH_' + ULID.generate();
  }
};