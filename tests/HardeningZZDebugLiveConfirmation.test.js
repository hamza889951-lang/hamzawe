'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

function loadInto(sandbox, rel, name) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(src + '\nthis.' + name + ' = ' + name + ';', sandbox, { filename: rel });
}
function formatInTimeZone(date, timeZone, fmt) {
  if (fmt !== 'HH:mm' && fmt !== 'yyyy-MM-dd') return date.toISOString();
  const options = fmt === 'HH:mm'
    ? { timeZone: timeZone, hour12: false, hour: '2-digit', minute: '2-digit' }
    : { timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit' };
  const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(date).reduce(function(acc, p) { acc[p.type] = p.value; return acc; }, {});
  return fmt === 'HH:mm'
    ? parts.hour + ':' + parts.minute
    : parts.year + '-' + parts.month + '-' + parts.day;
}

const sandbox = vm.createContext({ console: console, Intl: Intl });
const state = { sheets: Object.create(null), calendarEvents: [], lockHeld: false, nowIso: '2026-09-05T10:00:00.000Z' };
const settings = { work_start: '16:00', 'Slot Duration (min)': '15' };
sandbox.Session = { getScriptTimeZone: function() { return 'Asia/Baghdad'; } };
sandbox.Utilities = { formatDate: formatInTimeZone };
sandbox.PropertiesService = { getScriptProperties: function() { return { getProperty: function() { return null; }, setProperty: function() {} }; } };
sandbox.LockService = { getScriptLock: function() { return { waitLock: function() { if (state.lockHeld) throw new Error('LOCK_ALREADY_HELD'); state.lockHeld = true; }, releaseLock: function() { state.lockHeld = false; } }; } };
function sheet(name) { if (!state.sheets[name]) state.sheets[name] = { headers: [], rows: [] }; return state.sheets[name]; }
sandbox.GoogleSheets = {
  getAllRows: function(name) { if (name === 'Settings') return [Object.assign({}, settings)]; return sheet(name).rows.map(function(r) { return Object.assign({}, r); }); },
  queryRows: function(name, predicate) { return sandbox.GoogleSheets.getAllRows(name).filter(predicate); },
  getHeaders: function(name) { return sheet(name).headers.slice(); },
  findRowByColumn: function(name, columnName, value) { const row = sheet(name).rows.find(function(r) { return String(r[columnName]) === String(value); }); return row ? Object.assign({}, row) : null; },
  appendRow: function(name, rowObject) { const target = sheet(name); if (!target.headers.length) target.headers = Object.keys(rowObject); const row = {}; target.headers.forEach(function(h) { row[h] = Object.prototype.hasOwnProperty.call(rowObject, h) ? rowObject[h] : ''; }); target.rows.push(row); return true; },
  updateRowByColumn: function(name, columnName, value, fields) { const row = sheet(name).rows.find(function(r) { return String(r[columnName]) === String(value); }); if (!row) return false; Object.keys(fields).forEach(function(k) { row[k] = fields[k]; }); return true; }
};
sandbox.GoogleCalendar = { createEvent: function(params) { state.calendarEvents.push(params); return 'EVT_' + state.calendarEvents.length; } };
['Result.js','Config.js','Clock.js','Utils/ULID.js','Utils/IdGenerator.js','Utils/DateUtils.js','Utils/LegacySlotTimeParser.js','Utils/PhoneUtils.js','SettingsRepository.js','StateMachine.js','Domain/Validators.js','Infrastructure/Lock.js','Repositories/SlotRepository.js','Repositories/CalendarRepository.js','ConversationRepository.js','LogRepository.js','Application/CommandExecutor.js','BusNumberCalculator.js','Application/BookingService.js'].forEach(function(rel) { loadInto(sandbox, rel, rel === 'StateMachine.js' ? 'StateMachine' : rel.split('/').pop().replace('.js','')); });
sandbox.Clock.now = function() { return new Date(state.nowIso); };
state.sheets.Availability = { headers: ['slot_id','date','time','sort_key','status','is_available','patient_name','phone','calendar_event_id','reserved_until','reserved_until_unix'], rows: [{ slot_id:'SLT_LIVE_1600', date:new Date('2026-09-05T21:00:00.000Z'), time:new Date('2026-09-06T13:00:00.000Z'), sort_key:'202609061600', status:'RESERVED', is_available:true, patient_name:'مريض تجربة', phone:'9647800003333', calendar_event_id:'', reserved_until:'', reserved_until_unix:String(Date.now()+600000) }] };
state.sheets.Conversations = { headers:['conversation_id','phone','state','temp_name','slot_id','updated_at'], rows:[{conversation_id:'CONV_LIVE',phone:'9647800003333',state:'WAITING_CONFIRMATION',temp_name:'مريض تجربة',slot_id:'SLT_LIVE_1600',updated_at:''}] };
const result = sandbox.BookingService.handleIncomingMessage('9647800003333','1');
console.error('DEBUG booking result:', JSON.stringify(result));
console.error('DEBUG slot:', JSON.stringify(state.sheets.Availability.rows[0]));
console.error('DEBUG calendar events:', JSON.stringify(state.calendarEvents));
process.exit(result.ok && state.sheets.Availability.rows[0].status === 'CONFIRMED' ? 0 : 1);
