/**
 * AppointmentRepository
 *
 * Compatibility boundary for confirmed appointments. B4 legacy change claims
 * remain readable/releasable for production-gated migration only. B6 lifecycle
 * ownership is a separate PropertiesService fence owned by this repository.
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
   * B4 legacy claim. Retained for safe production inventory/migration only.
   * B6 normal lifecycle execution must not depend on this claim.
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

  /**
   * B6 acquisition. A single durable ownership record fences both CHANGE and
   * CANCEL for one normalized phone. The ScriptLock is held only for claim
   * admission/persistence; no Calendar or Slot lifecycle work occurs here.
   */
  acquireB6LifecycleOwnership(phone, command) {
    const key = this._b6LifecycleClaimKey(phone);
    const legacyKey = this._changeClaimKey(phone);

    return Lock.runExclusive('b6-lifecycle-claim:' + phone, function() {
      let properties;
      let existing;
      let legacy;

      try {
        properties = PropertiesService.getScriptProperties();
        existing = properties.getProperty(key);
        legacy = properties.getProperty(legacyKey);
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_ACQUIRE_FAILED', e.message, e.stack);
      }

      if (existing !== null && existing !== undefined) {
        return Result.fail(
          'B6_LIFECYCLE_ALREADY_OWNED',
          'Confirmed appointment lifecycle ownership already exists',
          { phone: phone }
        );
      }

      if (legacy !== null && legacy !== undefined) {
        return Result.fail(
          'B6_LEGACY_CLAIM_BLOCKED',
          'Legacy B4 change claim blocks B6 lifecycle admission',
          { phone: phone }
        );
      }

      const activeResult = SlotRepository.queryResult(function(slot) {
        return slot.phone === phone &&
          slot.status === Config.VOCABULARY.STATUS.CONFIRMED;
      });
      if (!activeResult.ok) {
        return Result.fail(
          'B6_OWNERSHIP_ACQUIRE_FAILED',
          'Failed to read authoritative active appointment state',
          activeResult.error
        );
      }

      const activeAppointments = activeResult.data;
      const operationId = 'B6_' + ULID.generate();
      const ownerToken = 'B6OWN_' + ULID.generate();
      const ownershipState = activeAppointments.length === 1
        ? 'HELD_ACTIVE'
        : 'HELD_UNRESOLVED';
      const claim = {
        operation_id: operationId,
        phone: phone,
        ownerToken: ownerToken,
        ownershipState: ownershipState,
        acquiredAt: Clock.now().getTime(),
        command: command,
        oldSlotId: activeAppointments.length === 1
          ? activeAppointments[0].slot_id
          : ''
      };

      try {
        properties.setProperty(key, JSON.stringify(claim));
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_ACQUIRE_FAILED', e.message, e.stack);
      }

      if (activeAppointments.length !== 1) {
        return Result.ok({
          status: 'RECOVERY_REQUIRED',
          operationId: operationId,
          ownerToken: ownerToken,
          phone: phone,
          command: command,
          ownershipState: ownershipState,
          activeCount: activeAppointments.length,
          appointment: null
        });
      }

      return Result.ok({
        status: 'OWNERSHIP_ACQUIRED',
        operationId: operationId,
        ownerToken: ownerToken,
        phone: phone,
        command: command,
        ownershipState: ownershipState,
        appointment: activeAppointments[0]
      });
    });
  },

  getB6LifecycleOwnership(phone) {
    const key = this._b6LifecycleClaimKey(phone);

    return Lock.runExclusive('b6-lifecycle-claim:' + phone, function() {
      try {
        const raw = PropertiesService.getScriptProperties().getProperty(key);
        if (raw === null || raw === undefined) return Result.ok(null);
        try {
          return Result.ok(JSON.parse(raw));
        } catch (parseError) {
          return Result.fail('B6_OWNERSHIP_MALFORMED', parseError.message, parseError.stack);
        }
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_READ_FAILED', e.message, e.stack);
      }
    });
  },

  setB6LifecycleOwnershipState(phone, ownerToken, ownershipState, metadata) {
    const key = this._b6LifecycleClaimKey(phone);

    return Lock.runExclusive('b6-lifecycle-claim:' + phone, function() {
      let properties;
      let raw;
      let claim;

      try {
        properties = PropertiesService.getScriptProperties();
        raw = properties.getProperty(key);
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_STATE_PERSISTENCE_UNKNOWN', e.message, e.stack);
      }

      if (raw === null || raw === undefined) {
        return Result.fail('B6_OWNERSHIP_NOT_FOUND', 'B6 lifecycle ownership does not exist');
      }

      try {
        claim = JSON.parse(raw);
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_MALFORMED', e.message, e.stack);
      }

      if (!claim || claim.ownerToken !== ownerToken) {
        return Result.fail('B6_OWNERSHIP_TOKEN_MISMATCH', 'B6 lifecycle ownership belongs to another operation');
      }

      claim.ownershipState = ownershipState;
      claim.updatedAt = Clock.now().getTime();
      if (metadata) {
        Object.keys(metadata).forEach(function(keyName) {
          claim[keyName] = metadata[keyName];
        });
      }

      try {
        properties.setProperty(key, JSON.stringify(claim));
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_STATE_PERSISTENCE_UNKNOWN', e.message, e.stack);
      }

      return Result.ok(claim);
    });
  },

  beginB6RecoveryOwnership(phone, recoveryCaseId, operationId) {
    const key = this._b6LifecycleClaimKey(phone);

    return Lock.runExclusive('b6-lifecycle-claim:' + phone, function() {
      let properties;
      let raw;
      let claim;

      try {
        properties = PropertiesService.getScriptProperties();
        raw = properties.getProperty(key);
      } catch (e) {
        return Result.fail('B6_RECOVERY_OWNERSHIP_READ_FAILED', e.message, e.stack);
      }

      if (raw === null || raw === undefined) {
        claim = {
          operation_id: operationId || '',
          phone: phone,
          ownerToken: 'B6REC_' + ULID.generate(),
          ownershipState: 'HELD_RECOVERY',
          acquiredAt: Clock.now().getTime(),
          recoveryCaseId: recoveryCaseId
        };
        try {
          properties.setProperty(key, JSON.stringify(claim));
        } catch (e) {
          return Result.fail('B6_RECOVERY_OWNERSHIP_PERSISTENCE_UNKNOWN', e.message, e.stack);
        }
        return Result.ok(claim);
      }

      try {
        claim = JSON.parse(raw);
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_MALFORMED', e.message, e.stack);
      }

      if (claim.recoveryCaseId && claim.recoveryCaseId !== recoveryCaseId) {
        return Result.fail('B6_RECOVERY_CASE_MISMATCH', 'Ownership belongs to another recovery case');
      }

      claim.ownershipState = 'HELD_RECOVERY';
      claim.recoveryCaseId = recoveryCaseId;
      claim.updatedAt = Clock.now().getTime();

      try {
        properties.setProperty(key, JSON.stringify(claim));
      } catch (e) {
        return Result.fail('B6_RECOVERY_OWNERSHIP_PERSISTENCE_UNKNOWN', e.message, e.stack);
      }

      return Result.ok(claim);
    });
  },

  releaseB6LifecycleOwnership(phone, ownerToken) {
    const key = this._b6LifecycleClaimKey(phone);

    return Lock.runExclusive('b6-lifecycle-claim:' + phone, function() {
      let properties;
      let raw;
      let claim;

      try {
        properties = PropertiesService.getScriptProperties();
        raw = properties.getProperty(key);
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_RELEASE_FAILED', e.message, e.stack);
      }

      if (raw === null || raw === undefined) {
        return Result.fail('B6_OWNERSHIP_RELEASE_FAILED', 'B6 lifecycle ownership does not exist');
      }

      try {
        claim = JSON.parse(raw);
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_MALFORMED', e.message, e.stack);
      }

      if (!claim || claim.ownerToken !== ownerToken) {
        return Result.fail('B6_OWNERSHIP_TOKEN_MISMATCH', 'B6 lifecycle ownership belongs to another operation');
      }

      if (claim.ownershipState !== 'RELEASE_PENDING') {
        return Result.fail(
          'B6_RELEASE_NOT_AUTHORIZED',
          'B6 ownership may be released only from RELEASE_PENDING',
          { ownershipState: claim.ownershipState }
        );
      }

      try {
        properties.deleteProperty(key);
      } catch (e) {
        return Result.fail('B6_OWNERSHIP_RELEASE_FAILED', e.message, e.stack);
      }

      return Result.ok({
        status: 'RELEASED',
        operationId: claim.operation_id,
        phone: phone
      });
    });
  },

  _changeClaimKey(phone) {
    return 'change_claim:' + phone;
  },

  _b6LifecycleClaimKey(phone) {
    return 'b6_lifecycle_claim:' + phone;
  }
};
