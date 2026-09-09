/**
 * CalendarRsvpConfigRepository
 * Owner-controlled Script Properties for Calendar RSVP attendance.
 */
const CalendarRsvpConfigRepository = {
  KEYS: {
    CALENDAR_ID: 'HAMZAWE_CALENDAR_ID',
    SECRETARY_EMAIL: 'ATTENDANCE_SECRETARY_EMAIL',
    SYNC_TOKEN: 'HAMZAWE_RSVP_SYNC_TOKEN',
    INITIALIZED: 'HAMZAWE_RSVP_INITIALIZED',
    ACTIVE: 'HAMZAWE_RSVP_ACTIVE',
    CHECKPOINTS: 'HAMZAWE_RSVP_RESPONSE_CHECKPOINTS'
  },
  _props() { return PropertiesService.getScriptProperties(); },
  _normalizeEmail(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; },
  getRuntimeConfig() {
    try {
      const props = this._props();
      const calendarId = String(props.getProperty(this.KEYS.CALENDAR_ID) || '').trim();
      const secretaryEmail = this._normalizeEmail(props.getProperty(this.KEYS.SECRETARY_EMAIL));
      if (!calendarId) return Result.fail('RSVP_CALENDAR_ID_UNCONFIGURED', 'HAMZAWE_CALENDAR_ID is required');
      if (!secretaryEmail) return Result.fail('RSVP_SECRETARY_EMAIL_UNCONFIGURED', 'ATTENDANCE_SECRETARY_EMAIL is required');
      return Result.ok({ calendarId, secretaryEmail });
    } catch (e) { return Result.fail('RSVP_CONFIG_READ_FAILED', e.message, e.stack); }
  },
  getSyncToken() {
    try { return Result.ok(String(this._props().getProperty(this.KEYS.SYNC_TOKEN) || '').trim() || null); }
    catch (e) { return Result.fail('RSVP_CHECKPOINT_READ_FAILED', e.message, e.stack); }
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
  getCheckpoints() {
    try {
      const raw = String(this._props().getProperty(this.KEYS.CHECKPOINTS) || '{}');
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return Result.fail('RSVP_CHECKPOINT_CORRUPT', 'RSVP response checkpoint is not an object');
      return Result.ok(value);
    } catch (e) { return Result.fail('RSVP_CHECKPOINT_READ_FAILED', e.message, e.stack); }
  },
  saveState(syncToken, initialized, checkpoints) {
    try {
      const props = this._props();
      const entries = {};
      if (syncToken) entries[this.KEYS.SYNC_TOKEN] = String(syncToken); else props.deleteProperty(this.KEYS.SYNC_TOKEN);
      entries[this.KEYS.INITIALIZED] = initialized ? 'true' : 'false';
      entries[this.KEYS.CHECKPOINTS] = JSON.stringify(checkpoints || {});
      props.setProperties(entries, false);
      return Result.ok({ saved: true });
    } catch (e) { return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, e.stack); }
  },
  clearSyncToken() {
    try { this._props().deleteProperty(this.KEYS.SYNC_TOKEN); return Result.ok({ cleared: true }); }
    catch (e) { return Result.fail('RSVP_CHECKPOINT_WRITE_FAILED', e.message, e.stack); }
  }
};
