/**
 * CalendarRsvpAttendanceService
 * Calendar RSVP is an external operator signal; AttendanceService remains the
 * application boundary for every actual attendance decision.
 */
const CalendarRsvpAttendanceService = {
  RESPONSE: { ACCEPTED: 'accepted', DECLINED: 'declined', NEEDS_ACTION: 'needsAction', TENTATIVE: 'tentative' },
  RECONCILIATION: { APPLIED: 'APPLIED', ALREADY_RECONCILED: 'ALREADY_RECONCILED', OBSERVED_NO_DECISION: 'OBSERVED_NO_DECISION', SEMANTIC_REJECTION: 'SEMANTIC_REJECTION', IGNORED_CANCELLED: 'IGNORED_CANCELLED' },

  initializeBaseline() {
    const ready = this._readyConfig(); if (!ready.ok) return ready;
    const active = CalendarRsvpConfigRepository.getActive(); if (!active.ok) return active;
    if (active.data) return Result.fail('RSVP_ACTIVE_REQUIRES_DEACTIVATION', 'Calendar RSVP baseline cannot be initialized while active');
    const initialized = CalendarRsvpConfigRepository.getInitialized(); if (!initialized.ok) return initialized;
    const binding = CalendarRsvpConfigRepository.validateConfigBinding(ready.data, false); if (!binding.ok) return binding;
    if (initialized.data && binding.data.matches) return Result.fail('RSVP_BASELINE_ALREADY_INITIALIZED', 'Calendar RSVP baseline is already initialized for the current configuration');
    return this._runSync(ready.data, { baseline: true, resetCheckpoints: true });
  },

  syncNow() {
    const ready = this._readyConfig(); if (!ready.ok) return ready;
    const active = CalendarRsvpConfigRepository.getActive(); if (!active.ok) return active;
    if (!active.data) return Result.fail('RSVP_NOT_ACTIVE', 'Calendar RSVP processing is disabled until explicit activation');
    const binding = CalendarRsvpConfigRepository.validateConfigBinding(ready.data, true); if (!binding.ok) return binding;
    const initialized = CalendarRsvpConfigRepository.getInitialized(); if (!initialized.ok) return initialized;
    if (!initialized.data) return Result.fail('RSVP_NOT_INITIALIZED', 'Calendar RSVP baseline initialization is required before activation');
    const trusted = CalendarRsvpConfigRepository.validateTrustedOperator(ready.data); if (!trusted.ok) return trusted;
    return this._runSync(ready.data, { baseline: false, resetCheckpoints: false });
  },

  activate() {
    const ready = this._readyConfig(); if (!ready.ok) return ready;
    const initialized = CalendarRsvpConfigRepository.getInitialized(); if (!initialized.ok) return initialized;
    if (!initialized.data) return Result.fail('RSVP_NOT_INITIALIZED', 'Initialize the read-only Calendar RSVP baseline before activation');
    const binding = CalendarRsvpConfigRepository.validateConfigBinding(ready.data, false); if (!binding.ok) return binding;
    if (!binding.data.matches) return Result.fail('RSVP_REBASELINE_REQUIRED', 'Current Calendar RSVP configuration differs from the last baseline; reinitialize while inactive before activation', { configuredCalendarId: ready.data.calendarId, configuredSecretaryEmail: ready.data.secretaryEmail, binding: binding.data.binding || null });
    const trusted = CalendarRsvpConfigRepository.validateTrustedOperator(ready.data); if (!trusted.ok) return trusted;
    const triggerResult = CalendarRsvpTrigger.install(ready.data.calendarId); if (!triggerResult.ok) return triggerResult;
    return CalendarRsvpConfigRepository.setActive(true);
  },

  deactivate() { return CalendarRsvpConfigRepository.setActive(false); },
  _readyConfig() { return CalendarRsvpConfigRepository.getRuntimeConfig(); },
  _runSync(config, options) { return CalendarRsvpSyncRepository.withSyncLock(() => this._runSyncLocked(config, options)); },

  _runSyncLocked(config, options) {
    const tokenResult = CalendarRsvpConfigRepository.getSyncToken(); if (!tokenResult.ok) return tokenResult;
    const checkpointResult = CalendarRsvpCheckpointRepository.readAll(); if (!checkpointResult.ok) return checkpointResult;
    let syncToken = options.baseline ? null : tokenResult.data;
    let restartedFrom410 = false;
    while (true) {
      const pageResult = this._collectPages(config.calendarId, syncToken);
      if (!pageResult.ok) {
        if (pageResult.error && pageResult.error.code === 'RSVP_SYNC_TOKEN_INVALID' && syncToken && !restartedFrom410) {
          const clear = CalendarRsvpConfigRepository.clearSyncToken(); if (!clear.ok) return clear;
          syncToken = null; restartedFrom410 = true; continue;
        }
        return pageResult;
      }
      const checkpoints = options.baseline || options.resetCheckpoints ? Object.create(null) : checkpointResult.data;
      if (options.baseline || options.resetCheckpoints) {
        const clearCheckpoints = CalendarRsvpCheckpointRepository.clearAll(); if (!clearCheckpoints.ok) return clearCheckpoints;
      }
      const correlation = this._buildCorrelationIndex(); if (!correlation.ok) return correlation;
      const processed = this._processEvents(pageResult.data.items, config, !!options.baseline, correlation.data, checkpoints); if (!processed.ok) return processed;
      const checkpointWrite = CalendarRsvpCheckpointRepository.appendAll(processed.data.dirtyCheckpoints); if (!checkpointWrite.ok) return checkpointWrite;
      const save = CalendarRsvpConfigRepository.saveState(pageResult.data.nextSyncToken, true, config); if (!save.ok) return save;
      return Result.ok({ mode: options.baseline ? 'BASELINE' : 'INCREMENTAL', processedEvents: processed.data.processedEvents, decisionCandidates: processed.data.decisionCandidates, applied: processed.data.applied, skipped: processed.data.skipped, semanticRejections: processed.data.semanticRejections, unmatchedEvents: processed.data.unmatchedEvents, ambiguousEvents: processed.data.ambiguousEvents, nextSyncToken: pageResult.data.nextSyncToken, restartedFrom410 });
    }
  },

  _buildCorrelationIndex() {
    if (typeof SlotRepository === 'undefined' || !SlotRepository.queryResult) return Result.fail('RSVP_AVAILABILITY_SOURCE_UNAVAILABLE', 'SlotRepository.queryResult is required for RSVP correlation');
    const result = SlotRepository.queryResult(function() { return true; });
    if (!result.ok) return Result.fail('RSVP_AVAILABILITY_SOURCE_UNAVAILABLE', 'Failed to read Availability for RSVP correlation', result.error);
    const index = Object.create(null); const rows = Array.isArray(result.data) ? result.data : [];
    for (let i = 0; i < rows.length; i++) {
      const uid = rows[i] && typeof rows[i].calendar_event_id === 'string' ? rows[i].calendar_event_id.trim() : '';
      if (!uid) continue; if (!index[uid]) index[uid] = []; index[uid].push(rows[i]);
    }
    return Result.ok(index);
  },

  _collectPages(calendarId, syncToken) {
    const items = []; let pageToken = null;
    while (true) {
      const result = CalendarRsvpSyncRepository.listPage(calendarId, syncToken, pageToken); if (!result.ok) return result;
      items.push.apply(items, result.data.items);
      if (result.data.nextPageToken) { pageToken = result.data.nextPageToken; continue; }
      if (!result.data.nextSyncToken) return Result.fail('RSVP_SYNC_TOKEN_MISSING', 'Final Calendar sync page did not return nextSyncToken');
      return Result.ok({ items, nextSyncToken: result.data.nextSyncToken });
    }
  },

  _processEvents(items, config, baseline, correlationIndex, checkpoints) {
    let processedEvents = 0, decisionCandidates = 0, applied = 0, skipped = 0, semanticRejections = 0, unmatchedEvents = 0, ambiguousEvents = 0;
    const dirty = Object.create(null);
    for (let i = 0; i < items.length; i++) {
      processedEvents++;
      const outcome = this._processEvent(items[i] || {}, config, baseline, correlationIndex, checkpoints, dirty); if (!outcome.ok) return outcome;
      decisionCandidates += outcome.data.decisionCandidate ? 1 : 0; applied += outcome.data.applied ? 1 : 0; skipped += outcome.data.skipped ? 1 : 0; semanticRejections += outcome.data.semanticRejection ? 1 : 0; unmatchedEvents += outcome.data.unmatched ? 1 : 0; ambiguousEvents += outcome.data.ambiguous ? 1 : 0;
    }
    return Result.ok({ processedEvents, decisionCandidates, applied, skipped, semanticRejections, unmatchedEvents, ambiguousEvents, dirtyCheckpoints: dirty });
  },

  _processEvent(event, config, baseline, correlationIndex, checkpoints, dirty) {
    const key = this._checkpointKey(event); if (!key) return Result.ok({ skipped: true });
    const matches = correlationIndex[key] || [];
    if (matches.length === 0) return Result.ok({ skipped: true, unmatched: true });
    if (matches.length > 1) return Result.ok({ skipped: true, ambiguous: true });
    if (event.status === 'cancelled') return this._recordCheckpoint(key, { responseStatus: '', eventStatus: 'cancelled', outcome: this.RECONCILIATION.IGNORED_CANCELLED, updatedAt: this._nowIso() }, checkpoints, dirty);

    const attendeeResult = this._findSecretaryAttendee(event, config.calendarId, config.secretaryEmail); if (!attendeeResult.ok) return attendeeResult;
    if (attendeeResult.data.incomplete) return Result.ok({ skipped: true });
    const response = attendeeResult.data.responseStatus || 'none';
    const previous = checkpoints[key];
    if (previous && previous.responseStatus === response && previous.eventStatus !== 'cancelled') return Result.ok({ skipped: true });
    if (baseline) return this._recordCheckpoint(key, { responseStatus: response, eventStatus: event.status || 'confirmed', outcome: this.RECONCILIATION.OBSERVED_NO_DECISION, updatedAt: this._nowIso() }, checkpoints, dirty);

    const decision = this._decisionForResponse(response);
    if (!decision) return this._recordCheckpoint(key, { responseStatus: response, eventStatus: event.status || 'confirmed', outcome: this.RECONCILIATION.OBSERVED_NO_DECISION, updatedAt: this._nowIso() }, checkpoints, dirty);
    const mutation = this._applyDecision(event, config, decision);
    if (!mutation.ok) {
      if (this._isSemanticRejection(mutation)) {
        const checkpoint = this._recordCheckpoint(key, { responseStatus: response, eventStatus: event.status || 'confirmed', outcome: this.RECONCILIATION.SEMANTIC_REJECTION, reasonCode: mutation.error && mutation.error.code ? mutation.error.code : 'UNKNOWN', updatedAt: this._nowIso() }, checkpoints, dirty);
        if (!checkpoint.ok) return checkpoint; return Result.ok({ decisionCandidate: true, semanticRejection: true });
      }
      return mutation;
    }
    return this._recordCheckpoint(key, { responseStatus: response, eventStatus: event.status || 'confirmed', outcome: mutation.data.alreadyApplied ? this.RECONCILIATION.ALREADY_RECONCILED : this.RECONCILIATION.APPLIED, updatedAt: this._nowIso(), decision }, checkpoints, dirty, { decisionCandidate: true, applied: !!mutation.data.applied });
  },

  _recordCheckpoint(key, checkpoint, checkpoints, dirty, outcome) {
    checkpoints[key] = checkpoint; dirty[key] = checkpoint;
    return Result.ok(Object.assign({ skipped: false }, outcome || {}));
  },

  _findSecretaryAttendee(event, calendarId, secretaryEmail) {
    if (event.attendeesOmitted === true) {
      const fetched = CalendarRsvpSyncRepository.getEvent(calendarId, event.id); if (!fetched.ok) return fetched;
      if (!fetched.data || fetched.data.attendeesOmitted === true) return Result.ok({ incomplete: true });
      event = fetched.data;
    }
    if (!Array.isArray(event.attendees)) return Result.ok({ responseStatus: 'none' });
    const normalized = this._normalizeEmail(secretaryEmail);
    for (let i = 0; i < event.attendees.length; i++) {
      const attendee = event.attendees[i] || {};
      if (this._normalizeEmail(attendee.email) === normalized) return Result.ok({ responseStatus: String(attendee.responseStatus || 'needsAction') });
    }
    return Result.ok({ responseStatus: 'none' });
  },

  _applyDecision(event, config, decision) {
    const context = { operator: { operatorId: config.secretaryEmail }, deployment: { trustedOperatorEmail: config.trustedOperatorEmail }, calendarEvent: { eventId: event.id, calendarId: config.calendarId }, executionPrincipal: this._executionPrincipal() };
    if (decision === 'MARK_COMPLETED') return AttendanceService.markCompleted(context);
    return AttendanceService.markNoShow(context);
  },
  _decisionForResponse(response) { if (response === this.RESPONSE.ACCEPTED) return 'MARK_COMPLETED'; if (response === this.RESPONSE.DECLINED) return 'MARK_NO_SHOW'; return null; },
  _isSemanticRejection(result) { const code = result && result.error && result.error.code; return code === 'ATTENDANCE_EVENT_AMBIGUOUS' || code === 'INVALID_TRANSITION'; },
  _checkpointKey(event) { return typeof event.iCalUID === 'string' && event.iCalUID.trim() ? event.iCalUID.trim() : ''; },
  _normalizeEmail(email) { return typeof email === 'string' ? email.trim().toLowerCase() : ''; },
  _executionPrincipal() { try { return Session.getEffectiveUser().getEmail() || ''; } catch (e) { return ''; } },
  _nowIso() { return new Date().toISOString(); },
  handleEventUpdated() {
    const result = this.syncNow();
    if (!result.ok) {
      const diagnostic = { type: 'RSVP_SYNC_FAILURE', timestamp: this._nowIso(), calendarId: this._configuredCalendarId(), resultCode: result.error && result.error.code ? result.error.code : 'UNKNOWN' };
      try { console.error(JSON.stringify(diagnostic)); } catch (ignored) {}
      throw new Error('Calendar RSVP sync failed: ' + diagnostic.resultCode);
    }
    return result;
  },
  _configuredCalendarId() { try { const config = this._readyConfig(); return config.ok ? config.data.calendarId : ''; } catch (e) { return ''; } }
};
