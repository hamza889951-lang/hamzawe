/**
 * CalendarRsvpAttendanceService
 *
 * Calendar RSVP is an external operator signal. This service reconciles it
 * against Availability and delegates the actual state transition to the
 * existing AttendanceService boundary.
 */
const CalendarRsvpAttendanceService = {
  RESPONSE: {
    ACCEPTED: 'accepted',
    DECLINED: 'declined',
    NEEDS_ACTION: 'needsAction',
    TENTATIVE: 'tentative'
  },

  RECONCILIATION: {
    APPLIED: 'APPLIED',
    ALREADY_RECONCILED: 'ALREADY_RECONCILED',
    OBSERVED_NO_DECISION: 'OBSERVED_NO_DECISION',
    SEMANTIC_REJECTION: 'SEMANTIC_REJECTION'
  },

  initializeBaseline() {
    const ready = this._readyConfig();
    if (!ready.ok) return ready;
    return this._runSync(ready.data, { baseline: true });
  },

  syncNow() {
    const ready = this._readyConfig();
    if (!ready.ok) return ready;
    const initialized = CalendarRsvpConfigRepository.getInitialized();
    if (!initialized.ok) return initialized;
    if (!initialized.data) return Result.fail('RSVP_NOT_INITIALIZED', 'Calendar RSVP baseline initialization is required before activation');
    return this._runSync(ready.data, { baseline: false });
  },

  activate() {
    const ready = this._readyConfig();
    if (!ready.ok) return ready;
    const initialized = CalendarRsvpConfigRepository.getInitialized();
    if (!initialized.ok) return initialized;
    if (!initialized.data) return Result.fail('RSVP_NOT_INITIALIZED', 'Initialize the read-only Calendar RSVP baseline before activation');
    return CalendarRsvpTrigger.install(ready.data.calendarId);
  },

  _readyConfig() {
    return CalendarRsvpConfigRepository.getRuntimeConfig();
  },

  _runSync(config, options) {
    return CalendarRsvpSyncRepository.withSyncLock(() => this._runSyncLocked(config, options));
  },

  _runSyncLocked(config, options) {
    const tokenResult = CalendarRsvpConfigRepository.getSyncToken();
    if (!tokenResult.ok) return tokenResult;
    const checkpointResult = CalendarRsvpConfigRepository.getCheckpoints();
    if (!checkpointResult.ok) return checkpointResult;

    let syncToken = options.baseline ? null : tokenResult.data;
    const checkpoints = checkpointResult.data;
    let restartedFrom410 = false;

    while (true) {
      const pageResult = this._collectPages(config.calendarId, syncToken);
      if (!pageResult.ok) {
        if (pageResult.error && pageResult.error.code === 'RSVP_SYNC_TOKEN_INVALID' && syncToken && !restartedFrom410) {
          const clear = CalendarRsvpConfigRepository.clearSyncToken();
          if (!clear.ok) return clear;
          syncToken = null;
          restartedFrom410 = true;
          continue;
        }
        return pageResult;
      }

      const working = Object.assign({}, checkpoints);
      const processed = this._processEvents(pageResult.data.items, config, working, !!options.baseline);
      if (!processed.ok) return processed;

      const save = CalendarRsvpConfigRepository.saveState(
        pageResult.data.nextSyncToken,
        true,
        processed.data.checkpoints
      );
      if (!save.ok) return save;

      return Result.ok({
        mode: options.baseline ? 'BASELINE' : 'INCREMENTAL',
        processedEvents: processed.data.processedEvents,
        decisionCandidates: processed.data.decisionCandidates,
        applied: processed.data.applied,
        skipped: processed.data.skipped,
        semanticRejections: processed.data.semanticRejections,
        nextSyncToken: pageResult.data.nextSyncToken,
        restartedFrom410: restartedFrom410
      });
    }
  },

  _collectPages(calendarId, syncToken) {
    const items = [];
    let pageToken = null;
    while (true) {
      const result = CalendarRsvpSyncRepository.listPage(calendarId, syncToken, pageToken);
      if (!result.ok) return result;
      items.push.apply(items, result.data.items);
      if (result.data.nextPageToken) {
        pageToken = result.data.nextPageToken;
        continue;
      }
      if (!result.data.nextSyncToken) return Result.fail('RSVP_SYNC_TOKEN_MISSING', 'Final Calendar sync page did not return nextSyncToken');
      return Result.ok({ items: items, nextSyncToken: result.data.nextSyncToken });
    }
  },

  _processEvents(items, config, checkpoints, baseline) {
    let processedEvents = 0;
    let decisionCandidates = 0;
    let applied = 0;
    let skipped = 0;
    let semanticRejections = 0;

    for (let i = 0; i < items.length; i++) {
      const event = items[i] || {};
      processedEvents++;
      const outcome = this._processEvent(event, config, checkpoints, baseline);
      if (!outcome.ok) return outcome;
      decisionCandidates += outcome.data.decisionCandidate ? 1 : 0;
      applied += outcome.data.applied ? 1 : 0;
      skipped += outcome.data.skipped ? 1 : 0;
      semanticRejections += outcome.data.semanticRejection ? 1 : 0;
    }

    return Result.ok({ checkpoints, processedEvents, decisionCandidates, applied, skipped, semanticRejections });
  },

  _processEvent(event, config, checkpoints, baseline) {
    const key = this._checkpointKey(event);
    if (!key) return Result.ok({ skipped: true });

    if (event.status === 'cancelled') {
      checkpoints[key] = { responseStatus: 'cancelled', outcome: 'IGNORED_CANCELLED', updatedAt: this._nowIso() };
      return Result.ok({ skipped: true });
    }

    const attendeeResult = this._findSecretaryAttendee(event, config.calendarId, config.secretaryEmail);
    if (!attendeeResult.ok) return attendeeResult.result;
    const response = attendeeResult.responseStatus || 'none';
    const previous = checkpoints[key];
    if (previous && previous.responseStatus === response) return Result.ok({ skipped: true });

    if (baseline) {
      checkpoints[key] = { responseStatus: response, outcome: this.RECONCILIATION.OBSERVED_NO_DECISION, updatedAt: this._nowIso() };
      return Result.ok({ skipped: true });
    }

    const decision = this._decisionForResponse(response);
    if (!decision) {
      checkpoints[key] = { responseStatus: response, outcome: this.RECONCILIATION.OBSERVED_NO_DECISION, updatedAt: this._nowIso() };
      return Result.ok({ skipped: true });
    }

    const mutation = this._applyDecision(event, config, decision);
    if (!mutation.ok) {
      if (this._isSemanticRejection(mutation)) {
        checkpoints[key] = {
          responseStatus: response,
          outcome: this.RECONCILIATION.SEMANTIC_REJECTION,
          reasonCode: mutation.error && mutation.error.code ? mutation.error.code : 'UNKNOWN',
          updatedAt: this._nowIso()
        };
        return Result.ok({ decisionCandidate: true, semanticRejection: true });
      }
      return mutation;
    }

    checkpoints[key] = {
      responseStatus: response,
      outcome: mutation.data.alreadyApplied ? this.RECONCILIATION.ALREADY_RECONCILED : this.RECONCILIATION.APPLIED,
      updatedAt: this._nowIso()
    };
    return Result.ok({ decisionCandidate: true, applied: !!mutation.data.applied });
  },

  _findSecretaryAttendee(event, calendarId, secretaryEmail) {
    if (event.attendeesOmitted === true) {
      const fetched = CalendarRsvpSyncRepository.getEvent(calendarId, event.id);
      if (!fetched.ok) return { ok: false, result: fetched };
      if (!fetched.data || fetched.data.attendeesOmitted === true) {
        return { ok: true, complete: false, responseStatus: 'none', incomplete: true };
      }
      event = fetched.data;
    }

    if (!Array.isArray(event.attendees)) return { ok: true, complete: true, responseStatus: 'none' };
    const normalized = this._normalizeEmail(secretaryEmail);
    for (let i = 0; i < event.attendees.length; i++) {
      const attendee = event.attendees[i] || {};
      if (this._normalizeEmail(attendee.email) === normalized) {
        return { ok: true, complete: true, responseStatus: String(attendee.responseStatus || 'needsAction') };
      }
    }
    return { ok: true, complete: true, responseStatus: 'none' };
  },

  _applyDecision(event, config, decision) {
    const context = {
      operator: { operatorId: config.secretaryEmail },
      deployment: { trustedOperatorEmail: config.secretaryEmail },
      calendarEvent: { eventId: event.id, calendarId: config.calendarId },
      executionPrincipal: this._executionPrincipal()
    };
    if (decision === 'MARK_COMPLETED') return AttendanceService.markCompleted(context);
    return AttendanceService.markNoShow(context);
  },

  _decisionForResponse(response) {
    if (response === this.RESPONSE.ACCEPTED) return 'MARK_COMPLETED';
    if (response === this.RESPONSE.DECLINED) return 'MARK_NO_SHOW';
    return null;
  },

  _isSemanticRejection(result) {
    const code = result && result.error && result.error.code;
    return code === 'ATTENDANCE_EVENT_NOT_CORRELATED' ||
      code === 'ATTENDANCE_EVENT_AMBIGUOUS' ||
      code === 'INVALID_TRANSITION' ||
      code === 'ATTENDANCE_EVENT_CORRELATION_LOST';
  },

  _checkpointKey(event) {
    return typeof event.iCalUID === 'string' && event.iCalUID.trim() ? event.iCalUID.trim() : '';
  },

  _normalizeEmail(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
  },

  _executionPrincipal() {
    try {
      return Session.getEffectiveUser().getEmail() || '';
    } catch (e) {
      return '';
    }
  },

  _nowIso() {
    return new Date().toISOString();
  },

  handleEventUpdated() {
    return this.syncNow();
  }
};
