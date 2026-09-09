/**
 * CalendarRsvpConfigRepository
 * Owner-controlled Script Properties for Calendar RSVP attendance.
 *
 * Business truth remains in Availability/AttendanceAudit. These properties are
 * only configuration, sync cursor and technical idempotency checkpoints.
 */
const CalendarRsvpConfigRepository = {
  KEYS: {
    CALENDAR_ID: 'HAMZAWE_CALENDAR_ID',
    SECRETARY_EMAIL: 'ATTENDANCE_SECRETARY_EMAIL',
    ATTENDANCE_OPERATOR_EMAIL: 'ATTENDANCE_OPERATOR_EMAIL',
    BOUND_CALENDAR_ID: 'HAMZAWE_RSVP_BOUND_CALENDAR_ID',
    BOUND_SECRETARY_EMAIL: 'HAMZAWE_RSVP_BOUND_SECRETARY_EMAIL',
    SYNC_TOKEN: 'HAMZAWE_RSVP_SYNC_TOKEN',
    INITIALIZED: 'HAMZAWE_RSVP_INITIALIZED',
    ACTIVE: 'HAMZAWE_RSVP_ACTIVE',
    CHECKPOINT_PREFIX: 'HAMZAWE_RSVP_CP_'
  },
  _props() { return PropertiesService.getScriptProperties(); },
  _normalizeEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; },
  _checkpointKey(iCalUID) { return this.KEYS.CHECKPOINT_PREFIX + encodeURIComponent(String(iCalUID || '').trim()); },
  getRuntimeConfig() {
    try {
      const props = this._props();
      const calendarId = String(props.getProperty(this.KEYS.CALENDAR_ID) || '').trim();
      const secretaryEmail = this._normalizeEmail(props.getProperty(this.KEYS.SECRETARY_EMAIL));
      const trustedOperatorEmail = this._normalizeEmail(props.getProperty(this.KEYS.ATTENDANCE_OPERATOR_EMAIL));
      if (!calendarId) return Result.fail('RSVP_CALENDAR_ID_UNCONFIGURED', 'HAMZAWE_CALENDAR_ID is required');
      if (!secretaryEmail) return Result.fail('RSVP_SECRETARY_EMAIL_UNCONFIGURED', 'ATTENDANCE_SECRETARY_EMAIL is required');
      return Result.ok({ calendarId, secretaryEmail, trustedOperatorEmail });
    } catch (e) { return Result.fail('RSVP_CONFIG_READ_FAILED', e.message, e.stack); }
  },
  getInitialized() {
    try { return Result.ok(this._props().getProperty(this.KEYS.INITIALIZED) === 'true'); }
    catch (e) { return Result.fail('RSVP_CHECKPOINT_READ_FAILED', e.message, e.stack); }
  },
  getActive() {
    try { return Result.ok(this._props().getProperty(this.KEYS.ACTIVE) === 'true'); }
    catch (e) { return Result.fail('RSVP_CHECKPOINT_READ_FAILED', e.message, e.stack); }
  },
  setActive(value) {
    try { this._props().setProperty(this.KEYS.ACTIVE, value ? 'true' : 'false'); return Result.ok({ active: !!value }); }
    catch (e) { return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, e.stack); }
  },
  getBinding() {
    try {
      const props = this._props();
      const calendarId = String(props.getProperty(this.KEYS.BOUND_CALENDAR_ID) || '').trim();
      const secretaryEmail = this._normalizeEmail(props.getProperty(this.KEYS.BOUND_SECRETARY_EMAIL));
      if (!calendarId || !secretaryEmail) return Result.ok(null);
      return Result.ok({ calendarId, secretaryEmail });
    } catch (e) { return Result.fail('RSVP_CHECKPOINT_READ_FAILED', e.message, e.stack); }
  },
  validateConfigBinding(config, active) {
    const binding = this.getBinding();
    if (!binding.ok) return binding;
    if (!binding.data) return Result.ok({ matches: false, bound: false });
    const matches = binding.data.calendarId === config.calendarId && binding.data.secretaryEmail === config.secretaryEmail;
    if (active && !matches) {
      return Result.fail('RSVP_ACTIVE_CONFIG_MISMATCH', 'Active Calendar RSVP configuration no longer matches its activation binding', {
        boundCalendarId: binding.data.calendarId,
        configuredCalendarId: config.calendarId,
        boundSecretaryEmail: binding.data.secretaryEmail,
        configuredSecretaryEmail: config.secretaryEmail
      });
    }
    return Result.ok({ matches, bound: true, binding: binding.data });
  },
  validateTrustedOperator(config) {
    if (!config.trustedOperatorEmail) return Result.fail('RSVP_ATTENDANCE_OPERATOR_UNCONFIGURED', 'ATTENDANCE_OPERATOR_EMAIL is required for Calendar RSVP attendance');
    if (config.trustedOperatorEmail !== config.secretaryEmail) {
      return Result.fail('RSVP_OPERATOR_POLICY_MISMATCH', 'ATTENDANCE_OPERATOR_EMAIL must exactly match ATTENDANCE_SECRETARY_EMAIL for RSVP activation', {
        secretaryEmail: config.secretaryEmail, trustedOperatorEmail: config.trustedOperatorEmail
      });
    }
    return Result.ok({ trustedOperatorEmail: config.trustedOperatorEmail });
  },
  getSyncToken() {
    try { return Result.ok(String(this._props().getProperty(this.KEYS.SYNC_TOKEN) || '').trim() || null); }
    catch (e) { return Result.fail('RSVP_CHECKPOINT_READ_FAILED', e.message, e.stack); }
  },
  getCheckpoint(iCalUID) {
    if (!iCalUID) return Result.ok(null);
    try {
      const raw = this._props().getProperty(this._checkpointKey(iCalUID));
      if (!raw) return Result.ok(null);
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return Result.fail('RSVP_CHECKPOINT_CORRUPT', 'RSVP response checkpoint is not an object', { iCalUID });
      return Result.ok(value);
    } catch (e) { return Result.fail('RSVP_CHECKPOINT_READ_FAILED', e.message, e.stack); }
  },
  saveCheckpoint(iCalUID, checkpoint) {
    if (!iCalUID) return Result.fail('RSVP_CHECKPOINT_KEY_REQUIRED', 'iCalUID is required for an RSVP checkpoint');
    try {
      this._props().setProperty(this._checkpointKey(iCalUID), JSON.stringify(checkpoint || {}));
      return Result.ok({ saved: true, iCalUID: String(iCalUID).trim() });
    } catch (e) { return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, { iCalUID }); }
  },
  clearCheckpoints() {
    try {
      const props = this._props();
      const all = props.getProperties();
      const keys = Object.keys(all);
      let removed = 0;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i].indexOf(this.KEYS.CHECKPOINT_PREFIX) === 0) { props.deleteProperty(keys[i]); removed++; }
      }
      return Result.ok({ removed });
    } catch (e) { return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, e.stack); }
  },
  saveState(syncToken, initialized, config) {
    try {
      const props = this._props();
      const state = {
        [this.KEYS.INITIALIZED]: initialized ? 'true' : 'false',
        [this.KEYS.BOUND_CALENDAR_ID]: config.calendarId,
        [this.KEYS.BOUND_SECRETARY_EMAIL]: config.secretaryEmail
      };
      if (syncToken) state[this.KEYS.SYNC_TOKEN] = String(syncToken);
      else props.deleteProperty(this.KEYS.SYNC_TOKEN);
      props.setProperties(state, false);
      return Result.ok({ saved: true });
    } catch (e) { return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, e.stack); }
  },
  clearSyncToken() {
    try { this._props().deleteProperty(this.KEYS.SYNC_TOKEN); return Result.ok({ cleared: true }); }
    catch (e) { return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, e.stack); }
  }
};
