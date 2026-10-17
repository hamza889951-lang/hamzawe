/**
 * ═══════════════════════════════════════
 * CONTRACT — DoctorIdentityRepository
 * ═══════════════════════════════════════
 * M4-A — Infrastructure-backed identity source repository.
 *
 * يضمن:
 * - قراءة هوية الطبيب الموثوقة من الإعداد المستقل
 *   `DOCTOR_PHONE` (Script Property)، دون أي جدول Doctors جديد.
 * - إرجاع Result (CAS-008).
 * - عزل أي معرفة بـ PropertiesService بعيداً عن Application/Domain.
 *
 * لا يضمن:
 * - أي Normalization — هوية Authoritative تُحمَّل هنا كما هي، و
 *   DoctorAuthorizationService يقوم بالتطبيع عبر PhoneUtils.
 * - أي Authorization — هذا الملف يقرأ الإعداد فقط.
 * - أي وصول إلى Sheets أو Calendar أو WhatsApp.
 *
 * قرار معتمد:
 * `ADMIN_PHONE` يبقى Owner / Operations notification destination
 * ولا يُستخدم للمصادقة أو لتحديد هوية الطبيب. هوية الطبيب تأتي من
 * `DOCTOR_PHONE` فقط.
 */
const DoctorIdentityRepository = {

  // مفتاح هوية الطبيب المستقل عن ADMIN_PHONE (قرار معتمد).
  PROPERTY_KEY: 'DOCTOR_PHONE',

  /**
   * يقرأ رقم الهاتف الموثوق المُهيّأ لهوية الطبيب كقيمة خام.
   * @returns {Result} ok(string) | fail(DOCTOR_IDENTITY_SOURCE_UNAVAILABLE)
   */
  readConfiguredDoctorPhone: function() {
    try { console.log('[HAMZAWE_DOCTOR_TRACE] ' + JSON.stringify({component:'DoctorIdentityRepository',stage:'IDENTITY_READ_ENTER',atMs:Clock.now().getTime()})); } catch (ignored) {}
    try {
      var props = PropertiesService.getScriptProperties();
      try { console.log('[HAMZAWE_DOCTOR_TRACE] ' + JSON.stringify({component:'DoctorIdentityRepository',stage:'BEFORE_PROPERTY_READ',atMs:Clock.now().getTime()})); } catch (ignored) {}
      var raw = props.getProperty(this.PROPERTY_KEY);
      try { console.log('[HAMZAWE_DOCTOR_TRACE] ' + JSON.stringify({component:'DoctorIdentityRepository',stage:'AFTER_PROPERTY_READ',atMs:Clock.now().getTime(),configured:raw!=null&&String(raw)!==''})); } catch (ignored) {}
      return Result.ok(raw == null ? '' : String(raw));
    } catch (e) {
      return Result.fail(
        'DOCTOR_IDENTITY_SOURCE_UNAVAILABLE',
        'Doctor identity source is unavailable',
        e && e.message ? e.message : 'Unknown Properties read failure'
      );
    }
  }
};
