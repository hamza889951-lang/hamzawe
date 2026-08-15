/**
 * ═══════════════════════════════════════
 * CONTRACT — AppointmentRepository
 * ═══════════════════════════════════════
 * يضمن:
 *   - واجهة موحّدة لبيانات "الحجز الفعلي" بصرف النظر عن مكان تخزينها فعلياً.
 * لا يضمن:
 *   - وجود مصدر بيانات مستقل عن Slot في v1.
 *
 * تصنيف رسمي (ADR-010): Compatibility Layer.
 * ليس "تغليفاً" مؤقتاً عابراً، بل قرار معماري متعمد: يجوز إنشاء Repository
 * لكيان لم ينفصل تخزينياً بعد، إذا كان وجوده يمنع تعديل Application مستقبلاً
 * عند فصل هذا الكيان فعلياً. BookingService سيتحدث مع هذا الملف من اليوم
 * الأول، وعند فصل Appointment تخزينياً مستقبلاً، يُعاد كتابة هذا الملف فقط.
 */
const AppointmentRepository = {

  findBySlotId(slotId) {
    return SlotRepository.findById(slotId);
  },

  findActiveByPhone(phone) {
    return SlotRepository.findByPhoneAndStatus(phone, Config.VOCABULARY.STATUS.CONFIRMED);
  },

  attachCalendarEvent(slotId, calendarEventId) {
    return SlotRepository.atomicUpdate(slotId, function() {
      return Result.ok({ calendar_event_id: calendarEventId });
    });
  },

  /**
   * B4 — Atomically establishes durable ownership of a confirmed-appointment
   * change. The ScriptLock protects only the PropertiesService read/write; it
   * is released before ChangeService starts any slot or Calendar work.
   *
   * Claims deliberately have no TTL. An existing value, including a malformed
   * one, blocks takeover until an explicit owner-token-checked release occurs.
   */
  acquireChangeClaim(phone, oldSlotId) {
    const key = this._changeClaimKey(phone);

    return Lock.runExclusive('change-claim:' + phone, function() {
      let properties;
      let existing;

      try {
        properties = PropertiesService.getScriptProperties();
        existing = properties.getProperty(key);
      } catch (e) {
        return Result.fail(
          'CLAIM_ACQUIRE_FAILED',
          'Failed to read change ownership claim',
          e.message
        );
      }

      if (existing !== null && existing !== undefined) {
        return Result.fail(
          'CHANGE_ALREADY_IN_PROGRESS',
          'A change operation is already in progress for this appointment',
          { phone: phone, oldSlotId: oldSlotId }
        );
      }

      // The claim must own the one unambiguous active appointment identified
      // by the caller. This closes the release-before-cleanup window: after a
      // replacement commits, old + new are both CONFIRMED until cleanup, so a
      // later acquisition is rejected before it can create another replacement.
      const activeResult = SlotRepository.queryResult(function(slot) {
        return slot.phone === phone &&
          slot.status === Config.VOCABULARY.STATUS.CONFIRMED;
      });
      if (!activeResult.ok) {
        return Result.fail(
          'CLAIM_ACQUIRE_FAILED',
          'Failed to verify active appointment identity',
          activeResult.error
        );
      }

      const activeAppointments = activeResult.data;
      if (activeAppointments.length !== 1) {
        return Result.fail(
          'ACTIVE_APPOINTMENT_AMBIGUOUS',
          'Change requires exactly one active confirmed appointment',
          { phone: phone, activeCount: activeAppointments.length }
        );
      }
      if (activeAppointments[0].slot_id !== oldSlotId) {
        return Result.fail(
          'ACTIVE_APPOINTMENT_CHANGED',
          'Active confirmed appointment changed before claim acquisition',
          {
            phone: phone,
            expectedSlotId: oldSlotId,
            actualSlotId: activeAppointments[0].slot_id
          }
        );
      }

      const ownerToken = 'CHG_' + ULID.generate();
      const claim = {
        ownerToken: ownerToken,
        phone: phone,
        oldSlotId: oldSlotId,
        acquiredAtMs: Clock.now().getTime()
      };

      try {
        properties.setProperty(key, JSON.stringify(claim));
      } catch (e) {
        return Result.fail(
          'CLAIM_ACQUIRE_FAILED',
          'Failed to persist change ownership claim',
          e.message
        );
      }

      return Result.ok({
        status: 'CLAIM_ACQUIRED',
        ownerToken: ownerToken,
        phone: phone,
        oldSlotId: oldSlotId
      });
    });
  },

  /**
   * Releases a B4 claim only when the durable owner token matches. There is no
   * age-based or stale-claim takeover path.
   */
  releaseChangeClaim(phone, ownerToken) {
    const key = this._changeClaimKey(phone);

    return Lock.runExclusive('change-claim:' + phone, function() {
      let properties;
      let raw;

      try {
        properties = PropertiesService.getScriptProperties();
        raw = properties.getProperty(key);
      } catch (e) {
        return Result.fail(
          'CLAIM_RELEASE_FAILED',
          'Failed to read change ownership claim during release',
          e.message
        );
      }

      if (raw === null || raw === undefined) {
        return Result.fail(
          'CLAIM_RELEASE_FAILED',
          'Change ownership claim does not exist',
          { phone: phone }
        );
      }

      let claim;
      try {
        claim = JSON.parse(raw);
      } catch (e) {
        return Result.fail(
          'CLAIM_RELEASE_FAILED',
          'Change ownership claim is malformed',
          e.message
        );
      }

      if (!claim || claim.ownerToken !== ownerToken) {
        return Result.fail(
          'CLAIM_OWNER_MISMATCH',
          'Change ownership claim belongs to another operation',
          { phone: phone }
        );
      }

      try {
        properties.deleteProperty(key);
      } catch (e) {
        return Result.fail(
          'CLAIM_RELEASE_FAILED',
          'Failed to delete change ownership claim',
          e.message
        );
      }

      return Result.ok({
        status: 'CLAIM_RELEASED',
        phone: phone,
        oldSlotId: claim.oldSlotId
      });
    });
  },

  _changeClaimKey(phone) {
    return 'change_claim:' + phone;
  }
};
