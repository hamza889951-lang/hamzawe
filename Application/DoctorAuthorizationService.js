/**
 * ═══════════════════════════════════════
 * CONTRACT — DoctorAuthorizationService
 * ═══════════════════════════════════════
 * M4-A — Doctor Identity & Authorization Boundary (Application layer).
 *
 * يضمن:
 * - استقبال is the canonical actor identity (normalized phone) و بناء
 *   ActorContext عند وجود طبيب مصرح له.
 * - Reuse PhoneUtils.normalize() + Validators.validatePhone() — لا يوجد
 *   Normalization جديد ولا أي تنسيق هوية بديل.
 * - fail-closed دائماً: أي مصدر هوية غير متاح / غير مconfigured /
 *   قراءة فاشلة / هوية غير مطابقة → Result.fail، ولا يُعطى وصول طبيب.
 * - Provider-neutral: لا يقرأ أي metadata من UltraMsg/WhatsApp/buttons.
 * - Read-only تماماً.
 *
 * لا يضمن:
 * - أي RBAC كامل / multi-clinic / secretary — هذه خارج M4-v1.
 * - أي وصول للمصادر من Application مباشرة — القراءة تمر عبر
 *   DoctorIdentityRepository (Infrastructure-backed).
 * - أي تعديل بيانات.
 *
 * Scope representation:
 * v1 يستخدم scope صريحاً لكن ضمني العيادة (clinicId = null) حتى يظل
 * التصميم قابلاً للتوسع إلى Doctor → Clinic(s) لاحقاً دون إعادة بناء
 * الـboundary.
 */
const DoctorAuthorizationService = {

  ACTOR_TYPES: {
    DOCTOR: 'DOCTOR',
    PATIENT: 'PATIENT',
    UNKNOWN: 'UNKNOWN'
  },

  /**
   * يستقبل هوية actor كاملة قادمة من Channel.
   *
   * @param {string} rawPhone
   * @returns {Result}
   *   ok({ actorType:'DOCTOR', actorId, scope, authorized:true })
   *   fail('INVALID_ACTOR_IDENTIFIER')
   *   fail('DOCTOR_IDENTITY_SOURCE_UNAVAILABLE')
   *   fail('DOCTOR_UNAUTHORIZED')
   */
  authorizeDoctor: function(rawPhone) {
    var normalized = PhoneUtils.normalize(rawPhone);
    var phoneCheck = Validators.validatePhone(normalized);
    if (!phoneCheck.ok) {
      return Result.fail(
        'INVALID_ACTOR_IDENTIFIER',
        'Actor phone is missing or malformed'
      );
    }
    var phone = phoneCheck.data;

    var sourceResult = DoctorIdentityRepository.readConfiguredDoctorPhone();
    if (!sourceResult.ok) {
      return Result.fail(
        'DOCTOR_IDENTITY_SOURCE_UNAVAILABLE',
        'Doctor identity source is unavailable',
        sourceResult.error
      );
    }

    var configuredRaw = sourceResult.data;
    var configuredPhone = typeof configuredRaw === 'string'
      ? PhoneUtils.normalize(configuredRaw)
      : '';

    if (!configuredPhone) {
      return Result.fail(
        'DOCTOR_IDENTITY_SOURCE_UNAVAILABLE',
        'No trusted doctor identity is configured'
      );
    }

    if (phone !== configuredPhone) {
      return Result.fail(
        'DOCTOR_UNAUTHORIZED',
        'Actor is not an authorized doctor'
      );
    }

    return Result.ok({
      actorType: this.ACTOR_TYPES.DOCTOR,
      actorId: phone,
      scope: {
        clinicId: null
      },
      authorized: true
    });
  }
};
