const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('Application/SchedulePromotionService.js', 'utf8');

function setup(options = {}) {
  const context = {
    Result: {
      ok: data => ({ ok: true, data }),
      fail: (code, message, details) => ({ ok: false, error: { code, message, details } })
    },
    Clock: { now: () => new Date('2026-10-23T05:00:00.000Z') },
    IdGenerator: { generateScheduleChangeId: (() => { let n = 0; return () => 'ledger-' + (++n); })() },
    EffectiveScheduleService: {
      TIMEZONE: 'Asia/Baghdad',
      DAY_KEYS: ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'],
      _scopeFromControlContext: () => ({ ok: true, data: { doctorId: 'doctor-1', clinicId: null } }),
      parseLocalDateTime: stamp => {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(stamp)) return { ok: false, error: { code: 'INVALID_LOCAL_DATETIME' } };
        return { ok: true, data: { stamp } };
      },
      _activeRecords: (records, at) => {
        const cancelled = new Set(records.filter(r => r.changeKind === 'CANCEL' && r.effectiveFrom <= at).map(r => r.targetChangeId));
        return { ok: true, data: records.filter(r => r.changeKind !== 'CANCEL' && !cancelled.has(r.changeId)) };
      }
    },
    ScheduleChangeRepository: { KIND: { RECURRING: 'RECURRING', TEMPORARY_CLOSE: 'TEMPORARY_CLOSE', TEMPORARY_OPEN: 'TEMPORARY_OPEN', CANCEL: 'CANCEL' } },
    DoctorScheduleCommandService: {
      _validateWorkWindow: w => {
        if (!w || !/^\d{2}:\d{2}$/.test(w.start) || !/^\d{2}:\d{2}$/.test(w.end) || w.end <= w.start) return { ok: false };
        return { ok: true, data: { start: w.start, end: w.end } };
      }
    }
  };

  const initial = {
    sunday: true, monday: true, tuesday: true, wednesday: true, thursday: true, friday: false, saturday: false,
    work_start: '09:00', work_end: '17:00', 'Slot Duration (min)': 20, slot_generation_days: 30,
    clinic_name: 'Clinic'
  };
  let settings = { ...initial, ...(options.settings || {}) };
  let changes = options.changes || [];
  let events = options.events || [];
  let failCompletedOnce = !!options.failCompletedOnce;
  let writes = 0;

  context.SettingsRepository = {
    getSettingsResult: () => ({ ok: true, data: { ...settings } }),
    getSlotDurationInfo: row => ({ minutes: Number(row['Slot Duration (min)']), source: 'CONFIGURED' }),
    updateRecurringScheduleFields: fields => {
      const allowed = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday','work_start','work_end'];
      assert.deepEqual(Object.keys(fields).sort(), allowed.sort());
      Object.assign(settings, fields);
      writes++;
      return { ok: true, data: { updatedFields: 9 } };
    }
  };
  context.DoctorScheduleReadService = {
    _toEffectiveSchedule: (scope, row) => ({
      ok: true,
      data: {
        days: Object.fromEntries(context.EffectiveScheduleService.DAY_KEYS.map(k => [k, row[k] === true || String(row[k]).toUpperCase() === 'TRUE'])),
        workWindow: { start: row.work_start, end: row.work_end },
        slotDurationMinutes: Number(row['Slot Duration (min)'])
      }
    })
  };
  context.ScheduleChangeRepository.listByScopeResult = () => ({ ok: true, data: changes });
  context.SchedulePromotionLedgerRepository = {
    listByScopeResult: () => options.ledgerReadFail
      ? { ok: false, error: { code: 'SCHEDULE_PROMOTION_LEDGER_READ_FAILED' } }
      : { ok: true, data: events.slice() },
    latestByChangeId: rows => {
      const latest = {};
      for (const e of rows) latest[e.changeId] = e;
      return { ok: true, data: latest };
    },
    appendEvent: event => {
      if (event.state === 'COMPLETED' && failCompletedOnce) {
        failCompletedOnce = false;
        return { ok: false, error: { code: 'SCHEDULE_PROMOTION_LEDGER_WRITE_FAILED' } };
      }
      const stored = { ...event, eventId: 'e' + (events.length + 1), eventAt: '2026-10-23T05:00:00.000Z', detail: event.detail || {} };
      events.push(stored);
      return { ok: true, data: stored };
    }
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.service = SchedulePromotionService;', context);
  return { service: context.service, context, get settings(){ return settings; }, get events(){ return events; }, get writes(){ return writes; } };
}

function schedule(days, start = '10:00', end = '16:00') {
  return { days: { sunday: !!days, monday: !!days, tuesday: !!days, wednesday: !!days, thursday: !!days, friday: false, saturday: false }, workWindow: { start, end } };
}
function change(id, effectiveFrom, sched, kind = 'RECURRING') {
  return { changeId: id, changeKind: kind, effectiveFrom, effectiveTo: null, payload: sched, targetChangeId: null };
}
const cc = { actorId: 'doctor-1', scope: { clinicId: null } };
const now = '2026-10-23T08:00';

// Future change must not update Settings.
{
  const env = setup({ changes: [change('future', '2026-10-24T00:00', schedule(false))] });
  const before = JSON.stringify(env.settings);
  const result = env.service.activateDue(cc, now);
  assert.equal(result.ok, true);
  assert.equal(env.writes, 0);
  assert.equal(JSON.stringify(env.settings), before);
}

// Due change updates only schedule fields; slot duration and unrelated values survive.
{
  const env = setup({ changes: [change('due', '2026-10-23T00:00', schedule(false, '10:00', '16:00'))] });
  const result = env.service.activateDue(cc, now);
  assert.equal(result.ok, true);
  assert.equal(env.settings.work_start, '10:00');
  assert.equal(env.settings.work_end, '16:00');
  assert.equal(env.settings.monday, false);
  assert.equal(env.settings['Slot Duration (min)'], 20);
  assert.equal(env.settings.slot_generation_days, 30);
  assert.equal(env.settings.clinic_name, 'Clinic');
  assert.equal(env.events.at(-1).state, 'COMPLETED');
}

// Repeated activation is a no-op.
{
  const env = setup({ changes: [change('once', '2026-10-23T00:00', schedule(false))] });
  assert.equal(env.service.activateDue(cc, now).ok, true);
  const count = env.events.length;
  assert.equal(env.service.activateDue(cc, now).ok, true);
  assert.equal(env.events.length, count);
  assert.equal(env.writes, 1);
}

// Same-effective-date ambiguity fails closed.
{
  const env = setup({ changes: [
    change('a', '2026-10-23T00:00', schedule(false)),
    change('b', '2026-10-23T00:00', schedule(true))
  ] });
  const result = env.service.activateDue(cc, now);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SCHEDULE_INTENT_CONFLICT');
  assert.equal(env.writes, 0);
}

// Recovery when Settings write succeeded but COMPLETED ledger append failed.
{
  const env = setup({ changes: [change('recover', '2026-10-23T00:00', schedule(false))], failCompletedOnce: true });
  const first = env.service.activateDue(cc, now);
  assert.equal(first.ok, false);
  assert.equal(env.settings.monday, false);
  assert.equal(env.events.at(-1).state, 'PREPARED');
  const second = env.service.activateDue(cc, now);
  assert.equal(second.ok, true);
  assert.equal(env.events.at(-1).state, 'COMPLETED');
  assert.equal(env.writes, 1);
}

// Cancelled recurring change is not promoted.
{
  const env = setup({ changes: [
    change('cancel-me', '2026-10-23T00:00', schedule(false)),
    { changeId: 'cancel-event', changeKind: 'CANCEL', targetChangeId: 'cancel-me', effectiveFrom: '2026-10-22T12:00' }
  ] });
  assert.equal(env.service.activateDue(cc, now).ok, true);
  assert.equal(env.writes, 0);
}

// Temporary overrides are never promoted into Settings.
{
  const env = setup({ changes: [change('temp', '2026-10-23T00:00', schedule(false), 'TEMPORARY_CLOSE')] });
  assert.equal(env.service.activateDue(cc, now).ok, true);
  assert.equal(env.writes, 0);
}

// Unreadable ledger blocks promotion.
{
  const env = setup({ changes: [change('due', '2026-10-23T00:00', schedule(false))], ledgerReadFail: true });
  const result = env.service.activateDue(cc, now);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SCHEDULE_PROMOTION_LEDGER_READ_FAILED');
  assert.equal(env.writes, 0);
}

console.log('SETTINGS-SCHEDULE-PROMOTION-v1 tests: PASS (8 scenarios)');
