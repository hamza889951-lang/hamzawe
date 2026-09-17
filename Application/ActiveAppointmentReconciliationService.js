/**
 * ActiveAppointmentReconciliationService
 *
 * Contract: docs/Hardening/STALE_BOOKED_RECONCILIATION_CONTRACT_v1.md
 *
 * Purpose:
 * - Reconcile a patient Conversation row that says BOOKED against the
 *   authoritative active appointment state in Availability.
 * - Never infer active-appointment existence from Conversation.state alone.
 * - Repair only the stale Conversation state when zero confirmed appointments
 *   remain.
 *
 * This service does not mutate Availability, Calendar, B6, Attendance, or
 * Scheduler state.
 */
const ActiveAppointmentReconciliationService = {

  reconcileBookedConversation(phone) {
    if (!phone || typeof phone !== 'string') {
      return Result.fail(
        'BOOKED_RECONCILIATION_INVALID_PHONE',
        'A normalized patient phone is required for BOOKED reconciliation'
      );
    }

    let activeResult;
    try {
      activeResult = SlotRepository.queryResult(function(slot) {
        return slot.phone === phone &&
          slot.status === Config.VOCABULARY.STATUS.CONFIRMED;
      });
    } catch (e) {
      return Result.fail(
        'BOOKED_RECONCILIATION_READ_FAILED',
        'Unable to read authoritative active appointment state',
        e.message || e.stack
      );
    }

    if (!activeResult || !activeResult.ok) {
      return Result.fail(
        'BOOKED_RECONCILIATION_READ_FAILED',
        'Unable to read authoritative active appointment state',
        activeResult && activeResult.error ? activeResult.error : null
      );
    }

    const activeAppointments = activeResult.data || [];

    if (activeAppointments.length === 1) {
      return Result.ok({
        activeAppointmentFound: true,
        staleCleared: false,
        appointment: activeAppointments[0]
      });
    }

    if (activeAppointments.length > 1) {
      return Result.fail(
        'BOOKED_RECONCILIATION_AMBIGUOUS',
        'More than one confirmed appointment exists for the same phone',
        { phone: phone, activeCount: activeAppointments.length }
      );
    }

    try {
      ConversationRepository.resetToMenuMain(phone);
    } catch (e) {
      return Result.fail(
        'BOOKED_RECONCILIATION_RESET_FAILED',
        'Unable to reset stale BOOKED conversation state',
        e.message || e.stack
      );
    }

    return Result.ok({
      activeAppointmentFound: false,
      staleCleared: true,
      activeCount: 0,
      reply: 'انتهى حجزك السابق. يمكنك الآن حجز موعد جديد. أرسل أي رسالة للبدء.',
      conversationState: Config.VOCABULARY.CONVERSATION_STATE.MENU_MAIN
    });
  }
};
