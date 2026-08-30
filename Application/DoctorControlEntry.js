/**
 * ═══════════════════════════════════════
 * CONTRACT — DoctorControlEntry
 * ═══════════════════════════════════════
 * M4-A — Provider-neutral Doctor Control Entry.
 *
 * يضمن:
 * - أن يدخل Actor مصرح له إلى Doctor Control Flow عبرResult واحد.
 * - لا ينفذ أي schedule/availability/appointment/calendar mutation.
 * - لا يقرأ أو يكتب أي بيانات أعمال.
 * - لا يعرف أي شيء عن UltraMsg/buttons/WhatsApp/Sheets.
 * - entry operation effectively idempotent: نفسActorContext يعيد نفس
 *   Result، ولا يوجد side-effect مكرر.
 *
 * لا يضمن:
 * - أي أمر Schedule — هذا يأتي في M4-B.
 * - أي نصوص Channel نهائية — هذه المرحلة لا تعتمد على Reply، ولا تعلن
 *   أي نص UX نهائي.
 */
const DoctorControlEntry = {

  ENTRY_STATUS: 'DOCTOR_CONTROL_ENTRY_ACCEPTED',

  /**
   * @param {Object} actorContext — ActorContext من DoctorAuthorizationService
   * @returns {Result}
   *   ok({ entryStatus, controlContext }) | fail('DOCTOR_UNAUTHORIZED')
   */
  enter: function(actorContext) {
    if (!actorContext ||
        actorContext.authorized !== true ||
        typeof actorContext.actorId !== 'string' ||
        !actorContext.actorId) {
      return Result.fail(
        'DOCTOR_UNAUTHORIZED',
        'Doctor control entry requires an authorized doctor context'
      );
    }

    return Result.ok({
      entryStatus: this.ENTRY_STATUS,
      controlContext: {
        actorId: actorContext.actorId,
        scope: actorContext.scope || null
      }
    });
  }
};
