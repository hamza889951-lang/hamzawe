# PROJECT_CONTEXT.md — ClinicScheduler

Engineering context for AI agents working on this repository. **This document is context, not source of truth.** Verify against actual code before modifying anything. Key governance doc: `PROJECT_CONSTITUTION.txt` (Arabic, v3.2 — the official source of truth, per its own clause CAS-014).

---

## 1. Purpose & Business Logic

A WhatsApp-based medical appointment booking system for a **single clinic** (v1.0). Patients book via WhatsApp text messages; the clinic manages availability via Google Sheets and appointments via Google Calendar. Runs entirely on **Google Apps Script**.

- Expected daily volume: ~50–90 bookings/day (operational estimate, not an architectural limit).
- The doctor decides the number of "buses" (slots) per day; the system does not cap patients.
- Patients are presented a **bus number** (e.g., "Bus 1" ≈ 16:00–16:05) instead of an exact time as the primary interface. The exact date is always shown alongside the bus number (owner decision).
- The system never assumes the exact time is the interface the doctor wants; it provides flexibility.

## 2. Architecture

Clean Architecture Style (CAS) — layered, **designed specifically so Google Sheets can later be replaced by a stronger database without rewriting Domain/Application**.

```
Domain          (no storage deps — pure)
Application     (services; must depend only on Repositories + Result/Clock/Config/Utils)
Core            Router (dispatch only, no business logic)
Repositories    storage abstraction (domain-ish operations)
Infrastructure  the ONLY layer allowed to touch Google APIs
Utils           cross-cutting helpers
Entry           Webhook (doPost) + ManualRunners (manual test functions)
```

Confirmed rules from constitution:
- CAS-002: `Infrastructure/GoogleSheets.js` is the ONLY file allowed to call `SpreadsheetApp`. (Enforced — Phase A removed the last violation from `ArchiveService.js`; see §15.)
- CAS-004: `StateMachine.js` is the only source of slot state transitions.
- CAS-008: every working function returns `Result` (no true/false/null); exception: internal `_` functions in Repositories.
- CAS-009: `Clock.now()` is the only way to read current time. `new Date()` only for pure conversions (in `DateUtils.js`, `SlotGenerator.js`, `LegacySlotTimeParser.js`).
- CAS-010: `Router` is the single message-dispatch entry point.
- ADR-013: Services never call each other (Booking/Cancel/Change are independent).

## 3. File / Directory Structure

```
PROJECT_CONSTITUTION.txt          Governance doc (Arabic) — source of truth
appsscript.json                   GAS config (timeZone, V8, webapp)
Config.js                         Vocabulary (names) + SYSTEM_POLICY (timeouts). "Never changes" vocabulary.
Result.js                         { ok:true,data } | { ok:false, error:{code,message,details} }
StateMachine.js                   Slot state transitions (root level, despite Domain/ mention)
Clock.js                          Clock.now() — single time source
Webhook.js                        doPost entry → parse → idempotency → Router → reply
AttendanceAddOn.js                M0 Calendar Add-on entry surface (CardService UI only) — extracts event identity + operator (Session), calls AttendanceService, renders Result; no business logic, no storage writes
Scheduler.js                      Daily orchestrator (Archive→Maintenance→Horizon→Reminders→HealthCheck) + Liveness
ArchiveService.js                 SYSTEM_LOG archive policy (90d) only — no storage details (Phase A done)
LogArchiveRepository.js           Storage for log archiving: findOlderThan / appendToArchive(+verify) / deleteRecords (Phase A, new)
ArchiveTestHarness.js             TEST-ONLY harness for Phase A (in-memory GoogleSheets mock; deletable)
ManualRunners.js                  RUN_* manual test functions
AppointmentRepository.js          Compatibility layer for future Appointment entity (ADR-010)
LogRepository.js                  Append-only SYSTEM_LOG writer (contract: never add read/delete)
ConversationRepository.js         Conversation state ops (startNew, moveToWaitingName, ...)
SettingsRepository.js             Single-row settings + getSlotDurationMinutes() (source of truth for slot length)
ProcessedMessagesService.js       Webhook idempotency (5-min PropertiesService cache)
HealthCheckService.js             Health checks + Liveness warning (25h) + admin WhatsApp alert
Reminderservice.js                Collect + send appointment reminders (240 min lead)
Changeservice.js                  Two paths: changeReservation (pre-confirm), changeConfirmedAppointment (post-confirm)
BusNumberCalculator.js            Bus number = display-only derivation from time (ADR-021)
AvailabilityHorizonMaintainer.js  ensureHorizon() — keeps 30-day availability horizon (ADR-022)
Slotselection.js                  findEarliestBookable() — single slot-choice policy (ADR-019)
Core/Router.js                    Dispatch table by conversation state + M4-A fail-closed doctor gate
Application/BookingService.js     Full booking journey + ReserveSlot/ConfirmReservation logic (ADR-014)
Application/CancelService.js      Cancel confirmed appointment
Application/CommandExecutor.js    Wraps commands: logs START/END, converts exceptions to Result.fail
Application/DoctorAuthorizationService.js M4-A identity/authorization boundary (doctor only; fail-closed; no RBAC matrix)
Application/DoctorControlEntry.js M4-A provider-neutral Doctor Control Entry (read-only; no schedule command)
Application/DoctorScheduleReadService.js M4-B Doctor Schedule Read — Effective Schedule from SettingsRepository (read-only; no mutation)
Application/MaintenanceService.js runCleanup (expired RESERVED→FREE) + runExpiration (FREE past→EXPIRED)
Application/AttendanceService.js  M0 attendance boundary: markCompleted/markNoShow (MARK_COMPLETED / MARK_NO_SHOW) — trusted operator context + event→slot correlation (calendar_event_id, exactly-one) → StateMachine transition inside SlotRepository.atomicUpdate
Repositories/SlotRepository.js    Slot CRUD; atomicUpdate (ScriptLock + fresh re-read + decisionFn)
Repositories/DoctorIdentityRepository.js M4-A identity source read (DOCTOR_PHONE deployment property; ADMIN_PHONE remains ops-only; no Doctors table)
Repositories/CalendarRepository.js Wraps GoogleCalendar → Result
Repositories/AttendanceAuditRepository.js M0 append-only attendance decision evidence (ATTENDANCE_AUDIT sheet) — NOT the Availability source of truth; no read/delete functions; first APPLIED row timestamp = ATTENDANCE_ACTIVATION_AT
Infrastructure/GoogleSheets.js    ONLY SpreadsheetApp access (getAllRows, updateBatch, appendRow, ...)
Infrastructure/GoogleCalendar.js  ONLY CalendarApp access (createEvent/deleteEvent)
Infrastructure/Lock.js            Lock.runExclusive(key, fn) — ScriptLock wrapper; "the only file knowing LockService"
Infrastructure/WhatsAppAdapter.js ONLY ultramsg knowledge (send + parseIncomingPayload)
Utils/ULID.js                     ULID generation (Math.random — not cryptographic, ID only)
Utils/IdGenerator.js              generateSlotId/ConversationId/AppointmentId
Utils/PhoneUtils.js               normalize(): strip @c.us, +, spaces
Utils/DateUtils.js                Date math + display formatting + generator storage formats
Utils/LegacySlotTimeParser.js     sort_key → comparable ms (TEMPORARY — ADR-016, dies with generator rebuild)
Utils/Validators.js               validatePhone/validatePatientName/validateTransition (accept/reject only)
```

Note: Repositories are inconsistently placed (some at root, some in `Repositories/`). This is a known cosmetic inconsistency, not to be "fixed" casually.

## 4. Data Models & Sheet Structures

### Availability sheet (`Availability`) — Source of Truth for booking
| Column | Notes |
|---|---|
| slot_id | `SLT_<ULID>` (generated) |
| date | `YYYY/MM/DD` (string, from `formatDateForStorage`) |
| time | `HH:mm` (string, from `formatTimeForStorage`) |
| sort_key | `YYYYMMDDHHmm` string — temp format, parsed by `LegacySlotTimeParser` (ADR-016) |
| status | FREE / RESERVED / CONFIRMED / COMPLETED / NO_SHOW / EXPIRED / CANCELLED (reserved) |
| is_available | bool/`TRUE` — slot bookable + doctor present. `false` = NOT bookable. |
| patient_name, phone | set on reserve |
| calendar_event_id | stored after Calendar event created |
| Reminder_sent | `TRUE` sentinel (string) |
| whatsapp_message_id | currently unused by code |
| reserved_until | Date; reserved_until_unix | epoch ms — reservation expiry |

### Conversations sheet
`conversation_id` (`CONV_<ULID>`), `phone` (normalized), `state`, `temp_name`, `slot_id`, `updated_at` (Date).

### Settings sheet — single row (v1: one clinic)
Keys read by code: `work_start` (HH:mm), `work_end` (HH:mm), `sunday`..`saturday` (`TRUE`/false), `slot_generation_days`, `clinic_name`, `Slot Duration (min)`. `getSlotDurationMinutes()` is the single source for slot length (default 30 if unreadable). A `timezone` column is referenced in a code comment (Asia/Baghdad expected).

### SYSTEM_LOG (diagnostic only — NOT source of truth for bookings)
Columns written by `LogRepository.write`: `timestamp`, `command`, `phone`, `slotId`, `stage` (START/END/...), `success`, `durationMs`, `error`.
Commands logged: `WEBHOOK_*`, `SCHEDULER_*`, `HEALTH_CHECK`, `MAINTENANCE_RUN`, `GENERATE_AVAILABILITY`, `ARCHIVE_RUN`, and `Config.VOCABULARY.COMMANDS` values.

### SYSTEM_LOG_ARCHIVE
Created automatically by `LogArchiveRepository.appendToArchive` (headers copied from SYSTEM_LOG). Same columns. Sheet name (`SYSTEM_LOG_ARCHIVE`) lives only in `LogArchiveRepository`.

### Slot Statuses & Transitions (StateMachine.js)
```
FREE      + ReserveSlot→RESERVED | ExpireSlot→EXPIRED
RESERVED  + ConfirmReservation→CONFIRMED | CleanupReservation→FREE
CONFIRMED + CompleteAppointment→COMPLETED | CancelAppointment→FREE | MarkNoShow→NO_SHOW
COMPLETED / NO_SHOW / EXPIRED / CANCELLED = terminal (no transitions)
```
`CANCEL_APPOINTMENT` → FREE directly (ADR-008: slot models availability only; no separate Appointment entity yet).

## 5. APIs, Integrations, External Services

| Dependency | File | Details |
|---|---|---|
| WhatsApp (UltraMsg) | `Infrastructure/WhatsAppAdapter.js` | POST `https://api.ultramsg.com/{instance}/messages/chat` (form-encoded: token, to, body). Incoming webhook payload: `{ data: { from, body, id } }`. |
| Google Calendar | `Infrastructure/GoogleCalendar.js` | `CalendarApp.getDefaultCalendar()` (no calendarId set in app code). `createEvent`, `getEventById/deleteEvent`. |
| Google Sheets | `Infrastructure/GoogleSheets.js` | `SpreadsheetApp.openById(SPREADSHEET_ID)` or `getActiveSpreadsheet()` (both routed through `_openSpreadsheet()`; `SPREADSHEET_ID` wins when set). Generics: `getAllRows`, `getHeaders`, `appendRows`, `updateBatch`, `appendRow`, `getOrCreateSheet`, `deleteRowsByNumbers`. |
| Script Properties | many | `SPREADSHEET_ID`, `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_TOKEN`, `ADMIN_PHONE` (owner/ops notification), `DOCTOR_PHONE` (M4-A doctor identity); runtime: `LAST_SCHEDULER_SUCCESS_MS`, `LAST_LIVENESS_ALERT_MS`. |

**Auth flow:** Web app deployment `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS` (ultramsg POSTs to the webapp URL with no auth). WhatsApp replies use the ultramsg token. No OAuth is handled in code (Google services run as the deploying user).

**Webhook flow (Webhook.js → Core/Router.js):**
```
doPost(e)
  → WhatsAppAdapter.parseIncomingPayload(e) → {phone, message, messageId} | null
  → ProcessedMessagesService.isDuplicate()? → OK (skip)
  → markProcessed()
  → Router.dispatch({phone, message}) → Result (patient services reply /
    DoctorControlEntry control context)
  → WhatsAppAdapter.sendMessage(phone, reply) (failure logged only)
```
M4-A: inside `Router.dispatch`, after `PhoneUtils.normalize`, the actor is checked via `DoctorAuthorizationService.authorizeDoctor`; only an authorized doctor reaches `DoctorControlEntry`. Every other actor continues through the existing patient routing.
Idempotency window: 5 min (`DUPLICATE_WINDOW_MS`); key = `msg_<messageId>` if present, else hash of `phone|message|minute`.

## 6. Main Workflows

### 6a. Booking (`Application/BookingService.js`)
1. First contact (no conversation) → `ConversationRepository.startNew` → **MENU_MAIN**.
2. Any message → move **WAITING_NAME**.
3. Name (validated, ≥2 chars) → `CommandExecutor.execute(RESERVE_SLOT)`:
   - `SlotSelection.findEarliestBookable()` (FREE + is_available + sort_key ≥ now+60min). **Read happens outside any lock** (optimistic).
   - `SlotRepository.atomicUpdate(slotId, decisionFn)`: inside ScriptLock, re-reads slot, validates `FREE→RESERVED`, writes phone/patient_name/reserved_until(+unix).
   - On success → move conversation **WAITING_CONFIRMATION** with temp_name + slot_id.
4. User replies "1"/"تأكيد"/"نعم" → `CommandExecutor.execute(CONFIRM_RESERVATION)`:
   - `atomicUpdate`: owner check (`freshSlot.phone === phone`, else `SLOT_OWNER_MISMATCH`) + `RESERVED→CONFIRMED`.
   - Re-read slot; compute start from `sort_key` via `LegacySlotTimeParser`; end = start + slot duration (Settings).
   - `CalendarRepository.createAppointmentEvent` (title shows bus number).
   - `atomicUpdate` to store `calendar_event_id` (result checked — failure is NOT silent).
   - Move conversation → **BOOKED**. Reply shows date + bus number.

**Double-booking safety (verified):** every write path re-reads the slot under `ScriptLock` and validates the transition. Two users choosing the same slot: one wins, the other gets `INVALID_TRANSITION` → booking failure (but reply misleadingly says "no availability" — known P1, no retry to next slot).

### 6b. Reschedule (ChangeService.js)
**Pre-confirm** (`WAITING_CONFIRMATION` + "2") → `changeReservation`:
- Find old RESERVED slot by phone → pick new slot (`findEarliestBookable(oldId)`) → reserve new (RESERVED) → free old (CleanupReservation). New-first, old-second (old untouched if new fails).

**Post-confirm** (`BOOKED` + "2") → `changeConfirmedAppointment`:
- Core success (steps 1–6): find old CONFIRMED → pick new → reserve new → confirm new (owner check) → create Calendar event → store event_id. New appointment is valid once step 6 completes.
- Post-commit cleanup (7–8): delete old Calendar event → free old slot. Cleanup failure is logged (`CLEANUP_FAILED`/`CLEANUP_EXCEPTION`) and NEVER shown to the user (Patient-retention-first). If old-event deletion fails, the old slot is deliberately NOT freed (keeps `calendar_event_id` for manual tracking of the orphaned event).

### 6c. Cancellation (`Application/CancelService.js`)
`BOOKED` + "3" → `cancelAppointment`: find active CONFIRMED by phone → validate transition → delete Calendar event first (if fails, slot is NOT freed) → `atomicUpdate` CONFIRMED→FREE (clears patient data) → reset conversation to MENU_MAIN.
⚠️ Final `atomicUpdate` does NOT do an owner check (textual ADR-018 gap; low risk because CONFIRMED cannot be re-reserved by another user).

### 6d. Reminder (`Reminderservice.js`)
Scheduler stage → `processPendingReminders(sendFn)`:
- Collect CONFIRMED slots with `startMs <= now+240min`, `startMs > now`, and `Reminder_sent` not `TRUE`.
- Send WhatsApp; on success mark `Reminder_sent='TRUE'` (via atomicUpdate). Failures are skipped (retried next run; duplicates possible — acceptable).

### 6e. Scheduler (`Scheduler.js`) — one daily trigger (`RUN_scheduler`)
```
Scheduler.main()
  acquire ScriptLock (waitLock 1000ms; else return SKIPPED)
  stage: ArchiveService.run()
  stage: MaintenanceService.run()     → runCleanup + runExpiration
  stage: AvailabilityHorizonMaintainer.ensureHorizon()   (30-day horizon, batch insert)
  stage: ReminderService.processPendingReminders(...)
  stage: HealthCheckService.run()
  operationalOk = Maintenance ∧ Horizon ∧ Reminders ∧ HealthCheck all OK
  allOk = operationalOk ∧ Archive OK
  if operationalOk → set LAST_SCHEDULER_SUCCESS_MS (liveness); return Result.ok (with archiveWarning if archive failed)
  else → Result.fail('SCHEDULER_PARTIAL_FAILURE') and do NOT update liveness
  releaseLock
```
HealthCheckService.run returns `Result.ok({healthy})` always; Scheduler treats `healthy:false` as stage failure.

## 7. Conversation States & Transitions

```
(no conversation)  → startNew → MENU_MAIN
MENU_MAIN          → (any) → WAITING_NAME
WAITING_NAME       → (valid name) → WAITING_CONFIRMATION (reserves slot)
WAITING_CONFIRMATION → "1"/"تأكيد"/"نعم" → BOOKED (confirm + calendar)
WAITING_CONFIRMATION → "2" → changeReservation (stays WAITING_CONFIRMATION)
BOOKED             → "2" → changeConfirmedAppointment
BOOKED             → "3" → cancelAppointment → MENU_MAIN
Any/unknown state  → resetToMenuMain
```
Vocabulary in `Config.VOCABULARY.CONVERSATION_STATE`. Router dispatch table is documented in `Core/Router.js` header (do not change without reviewing it).

## 8. Business Rules & Constraints

- `MIN_BOOKING_LEAD_MINUTES: 60` — slot must start ≥1h from now.
- `RESERVATION_TIMEOUT_MINUTES: 5` — RESERVED slots expire after 5 min (cleaned by Maintenance → FREE).
- `REMINDER_LEAD_MINUTES: 240` — reminders 4h before start.
- Archive retention: 90 days (`ArchiveService.RETENTION_MS`).
- Bus number = `floor((slotMinutes − workStartMinutes) / slotDuration) + 1`; **display only, never stored** (ADR-021).
- `is_available=false` → not bookable. Meaning: slot validity/doctor presence. Do NOT change (future doctor vacation dashboard plan).
- `duplicate archive record` is acceptable; `data loss` is not. Copy must be verified before delete. Delete requires **identity safety**: a record is deletable only if it has exactly one full-content match in the source (0 or >1 matches → fail, no delete). No stable unique ID exists in SYSTEM_LOG (no `log_id`); identity is content-based.
- WhatsApp send failure never causes appointment loss (booking is committed in Sheets before any message).
- Single active appointment per phone (findActiveByPhone returns first CONFIRMED).

## 9. Timezone & Date/Time Handling

- `appsscript.json`: `timeZone: "Asia/Baghdad"`, runtime V8.
- `Clock.now()` is the sole current-time source (CAS-009).
- Storage formats: date `YYYY/MM/DD`, time `HH:mm`, `sort_key` `YYYYMMDDHHmm` (all via `DateUtils` storage helpers).
- Display: `DateUtils.formatDateDisplay/formatTimeDisplay` use `Session.getScriptTimeZone()`.
- Sheets return `date`/`time` cells as `Date` objects; code converts for display (never string-concatenates raw Date).
- `LegacySlotTimeParser` builds dates in the script timezone; mismatch between project timezone and clinic timezone would break `sort_key` comparisons against `Clock.now()`.

## 10. Error Handling & Edge Cases

- **Result contract:** services return `Result.ok(data)` or `Result.fail(code, message, details)`. Never `Result.ok({success:false})` to represent real failure.
- `CommandExecutor.execute` logs START/END around every command and converts thrown exceptions to `Result.fail('UNEXPECTED_ERROR', ...)`.
- Scheduler wraps each stage in try/catch; stage failures are logged (`SCHEDULER_STAGE_FAILED`) and aggregated.
- `Lock.runExclusive` distinguishes `LOCK_TIMEOUT` from inner failures; releases lock in `finally`.
- `SlotRepository` query methods swallow read exceptions and return `[]`/`null` (silent-failure risk on read; acknowledged design — reads are best-effort, writes are strict).
- Partial-failure patterns (documented in file headers): ADR-006 (Slot↔Calendar not atomic; logged, no auto-rollback), Patient-retention-first in ChangeService, Calendar-delete-before-slot-free in CancelService.
- Archive data safety (Phase A): strict READ→COPY→VERIFY→DELETE; `LogArchiveRepository.appendToArchive` verifies by read-back (not just `inserted === length`); failed copy/verify blocks delete; `LogArchiveRepository.deleteRecords` requires exactly one identity match per record, otherwise `Result.fail` and no delete. (Note: if the source sheet is missing, `GoogleSheets._getSheet` throws — surfaced as an exception, per the codebase's read path contract.)
- `GoogleSheets.updateBatch` writes from a single snapshot per call (safe for non-overlapping row targets).
- Webhook: any exception → `WEBHOOK_CRASH` log → `ERROR_LOGGED`; parse failure → `IGNORED`.

## 11. Known Bugs / Technical Debt

Ranked by severity (P0=worst). All confirmed by code inspection.

- **P1 — ~~`ArchiveService.js` architectural leakage (CAS-002 violation)~~ RESOLVED (Phase A).** No longer calls `SpreadsheetApp`/`getSheetByName`/`deleteRow`/`_rowNumber`; storage moved to `LogArchiveRepository` (read-only tested). Remaining related observation: `deleteRowsByNumbers` still does one `getRange`-backed API call per contiguous row-range (small constant), and the first archive after 90 days may still be large/slow.
- **P1 — Scheduler archive ordering:** Archive runs FIRST (before operational stages). A slow/large archive can consume the execution budget and starve operational stages, contradicting "archive must not block operational work". Archive-order fix is a separate approved-future task.
- **P1 — SlotSelection optimistic read:** `findEarliestBookable()` reads outside the lock; on race the loser gets a misleading "no appointments available" reply with no retry to the next slot.
- **P2 — Nested ScriptLock (unverified):** `Scheduler.main` holds ScriptLock then `ensureHorizon` calls `Lock.runExclusive` (waits 5s). Reentrancy behavior of Apps Script ScriptLock is unverified — must be tested in the live environment.
- **P2 — Global ScriptLock coupling:** a webhook arriving during a long scheduler run waits 5s then `LOCK_TIMEOUT` → booking failure.
- **P2 — Liveness vs constitution conflict:** constitution §9.3 says HealthCheck is "best effort, doesn't stop Scheduler", but code makes `healthy:false` fail the whole scheduler (operationalOk=false). Code matches the owner's newer spec; conflict is undocumented.
- **P2 — Application-layer storage leaks (planned hardening):** `MaintenanceService` → `GoogleSheets.updateBatch` directly; `HealthCheckService` → `GoogleSheets.getAllRows` + `PropertiesService`; `Scheduler` → `LockService` + `PropertiesService` directly; `ProcessedMessagesService` → `PropertiesService`; `SlotRepository.query(predicate)` passes raw rows to Application. (Archive was the first of these fixed — Phase A.)
- **P3 — `sort_key`/`LegacySlotTimeParser`** temporary (ADR-016); dies with generator rebuild.
- **P3 — `Reminder_sent: 'TRUE'`** string sentinel hardcoded in Application.
- **P3 — PropertiesService key accumulation** (500-key limit; documented in constitution §12).
- **P3 — `updateRowByColumn`** linear scan (documented debt after ~2000 rows).
- **P4 — CancelService final atomicUpdate lacks owner check** (ADR-018 textual violation, low practical risk).
- **P4 — Unused code:** `SlotRepository.findAvailableByDate`, `AppointmentRepository.attachCalendarEvent`, `IdGenerator.generateAppointmentId`, `whatsapp_message_id` column. Do NOT delete without checking (may be compatibility/planned).
- **P4 — `DateUtils.js` formatting** is a concatenation artifact (valid JS, ugly). Leave alone.
- **Deployment note:** `.clasp.json` is gitignored; triggers are configured manually in Apps Script UI (not in code).

## 12. Key Implementation Decisions & Why

- **Layered CAS architecture** — deliberately so Google Sheets can be swapped for a real DB (PostgreSQL/Cloud SQL) later without rewriting Domain/Application. Confirmed by owner: goal is "system is strong DESPITE Sheets", not "make Sheets stronger".
- **Slot = availability only** (ADR-008); Cancel → FREE directly; CANCELLED reserved for a future Appointment entity.
- **`atomicUpdate(slotId, decisionFn)` pattern** — lock + fresh re-read + transition validation + owner check. This is the core double-booking defense; do not bypass it.
- **Bus-number presentation** (ADR-021) — patient sees bus number + date; doctor controls how many slots per day.
- **Patient-retention-first** in reschedule — once the new appointment is confirmed, cleanup failures never surface to the patient.
- **Webhook idempotency** (ADR-023) — 5-min dedup to survive ultramsg retries.
- **Result-only returns** (CAS-008) — uniform success/failure signaling; no silent true/false.
- **`LogRepository` append-only** — diagnostic log; never a read/delete API (archived reads/deletes live in `LogArchiveRepository`).
- **Archive identity safety (Phase A)** — no stable unique ID in SYSTEM_LOG; delete only on exactly-one full-content match, never on row number alone. Simple, safe, no schema change; a future `log_id` column would improve it (not needed now).
- **Best-effort background ops** (ADR-017) — Maintenance/Reminders/HealthCheck failures log but don't cascade, EXCEPT operational stages gate liveness by design.
- **Single daily trigger** — one `RUN_scheduler`; do not add triggers without explicit approval.
- **Scheduler serialization ≠ repository atomicity (B5, PR #8):** `Scheduler.main` serializes Scheduler executions with `LockService.getUserLock()`; `Lock.runExclusive()` keeps owning the global `ScriptLock` for repository data atomicity. **Deployment precondition (verify at deploy time):** every Scheduler invocation — the single daily time-driven trigger and manual `RUN_scheduler` — must run as the same owner user (webapp `executeAs: USER_DEPLOYING` per `appsscript.json`; trigger configured manually by the owner per §11). If a trigger is ever created under a different Google user, UserLock-based Scheduler serialization no longer holds.

## 13. Dependencies & Configuration Requirements

- **Script Properties (required):** `SPREADSHEET_ID`, `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_TOKEN`, `ADMIN_PHONE` (owner/ops notification). M4-A additionally requires `DOCTOR_PHONE` for the doctor identity/authorization boundary; `ADMIN_PHONE` never grants doctor access.
- **Sheets required:** `Availability`, `Conversations`, `Settings`, `SYSTEM_LOG` (archive sheet auto-created).
- **Google services enabled:** Spreadsheet, Calendar, UrlFetch, Properties. Web app deployed as USER_DEPLOYING/ANYONE_ANONYMOUS.
- **External:** ultramsg WhatsApp instance + webhook pointing at the deployed webapp URL.
- **Settings row must contain:** work_start, work_end, day flags, `Slot Duration (min)`, `slot_generation_days`. HealthCheck flags incomplete settings as unhealthy.
- Go-live checklist in `PROJECT_CONSTITUTION.txt` §9.1.

## 14. Must NOT Be Changed Without Understanding Impact

- `Config.VOCABULARY` — statuses, commands, conversation states, sheet names ("system language", never changes).
- `StateMachine.transitions` — single source of truth for slot state (CAS-004).
- `Result` contract semantics.
- `LogRepository` append-only contract (no reads/deletes added).
- `SlotRepository.atomicUpdate` semantics (lock + fresh read + transition check).
- `is_available` meaning (slot bookability/doctor presence).
- `Clock.now()` time-source rule (CAS-009).
- The single daily Scheduler trigger / `RUN_scheduler`.
- Sheet columns without auditing all readers/writers (bookings are the source of truth; SYSTEM_LOG is diagnostic only).
- Any `Config`/sheet-name literal that other files reference (archive sheet name lives in `LogArchiveRepository`; do not move back to Application).

## 15. Current Project Status

- **M0 (Phase 1.1 — Management Intelligence) — CLOSED: approved (second architectural review) and merged as PR #10 on 2026-08-24.** Authoritative baseline after M0: `b6aed067b86dd09d1aef59482e6114b65a3f697c`. Attendance Capture Foundation: `Application/AttendanceService.js` (MARK_COMPLETED / MARK_NO_SHOW, explicit only), `Repositories/AttendanceAuditRepository.js` (append-only ATTENDANCE_AUDIT evidence), `AttendanceAddOn.js` (Calendar Add-on surface), `tests/HardeningM0.test.js` (33 tests).
  - **Final state (live-verified on a separate TEST Apps Script project, owner-executed; production NOT deployed):** manifest = `currentEventAccess: READ` + `calendar.addons.current.event.read` (demonstrated necessity: METADATA does not deliver the event context); runtime delivers the documented Calendar-event fields flattened under top-level `e.calendar` where `calendar.id` = opened EVENT id (decisively verified via CalendarApp.getEventById) and `calendar.calendarId` = parent calendar. Four live experiments (MARK COMPLETED / duplicate / MARK NO-SHOW / negative path) returned expected results on the TEST spreadsheet only.
  - Architecture: correlation by slot-row `calendar_event_id` (stable id, exactly-one rule); transitions only via StateMachine inside `SlotRepository.atomicUpdate` (duplicate = deterministic no-op `ALREADY_APPLIED`, zero cell writes; conflicting concurrent decisions cannot both win — `INVALID_TRANSITION` on fresh re-read or `LOCK_TIMEOUT`); operator authorization is a DERIVED trust boundary (identity from Session + `ATTENDANCE_OPERATOR_EMAIL` deployment policy; service derives DOCTOR on exact match; entry layer never claims authority); ADD-ON NEVER CALLS CalendarApp; attendance state lives in Availability only (T5 closed, no event mutation).
  - Activation boundary for M1: `ATTENDANCE_ACTIVATION_AT` = timestamp of the first APPLIED audit row (no permanent setting); PENDING ATTENDANCE stays derived (CONFIRMED + no APPLIED record); ATTENDANCE_AUDIT is evidence, not source of truth. Attendance correction (COMPLETED↔NO_SHOW editing) = future Attendance Correction Contract.
  - Production status: v7 / PRE-BASELINE continues to run; the Calendar Add-on exists in `main` but is NOT deployed to production (no add-on deployment, no UltraMsg change, no v7 modification).
- **Stable v1.0**; constitution v3.2; hardening roadmap officially complete.
- **Recently completed:** ArchiveService for SYSTEM_LOG (last commits); Scheduler archive stage; Liveness fix; HealthCheck; horizon maintainer; webhook idempotency.
- **Implemented (Phase A — decouple ArchiveService from storage):** `LogArchiveRepository` created (findOlderThan / appendToArchive with read-back verify / deleteRecords with identity rule); `ArchiveService` is now policy-only (no `SpreadsheetApp`, no sheet names, no row numbers, no delete logic, no `_rowNumber`); `GoogleSheets` gained generic `getOrCreateSheet`, `deleteRowsByNumbers`, and `_openSpreadsheet`. Batch delete (merged ranges, no `deleteRow` loop). No Scheduler/LogRepository/Config/Result changes.
- **Tested (local, test-only):** `ArchiveTestHarness.js` (deletable) — in-memory GoogleSheets mock + real production code loaded read-only; 8/8 PASS covering successful archive, no-old-records, copy failure (no delete), identity-not-found (no delete), identity-ambiguous (no delete), crash-after-copy-before-delete + retry, partial-delete + retry, date normalization.
- **Pending (owner):** git commit/push of Phase A + PROJECT_CONTEXT update; Apps Script deploy; **live test of archive on real SYSTEM_LOG** (mock is faithful but not a substitute for real Sheets API behavior/quota); ArchiveTestHarness is temporary and may be deleted.
- **Planned separately:** Scheduler archive ordering (archive last); Application-layer leakage hardening (Maintenance/HealthCheck/Scheduler/ProcessedMessages → repositories); booking-path concurrency review (SlotSelection retry) — next stated goal.
- **M4-A (Doctor Identity & Authorization Boundary) — implemented on working branch, pending supervisor review.** Scope: `Application/DoctorAuthorizationService.js` (authorizeDoctor, canonical phone via `PhoneUtils.normalize`, fail-closed), `Application/DoctorControlEntry.js` (provider-neutral read-only control entry, no channel reply/UX text), `Repositories/DoctorIdentityRepository.js` (reads `DOCTOR_PHONE` Script Property; no Doctors table), `Core/Router.js` minimal routing-only gate, `tests/HardeningM4A.test.js` (29 tests).
  - Identity correction (2026-08-31): `ADMIN_PHONE` is **Owner / Operations notification destination only** and must NOT authorize or identify the doctor. Doctor identity source is the independent `DOCTOR_PHONE` Script Property, read only through `DoctorIdentityRepository`.
  - Decisions recorded: scope representation uses `{ clinicId: null }` for v1 implicit single-clinic while keeping future `Doctor → Clinic(s)` extensibility; no new conversation state (M4-B will define it when schedule interaction begins); no schedule/availability/appointment/calendar mutation in M4-A; no channel wording is introduced (final UX deferred to Supervisor).
  - Fail-closed: missing/unreadable/invalid `DOCTOR_PHONE` or unmatched phone → `DOCTOR_IDENTITY_SOURCE_UNAVAILABLE` / `DOCTOR_UNAUTHORIZED` → Router continues the existing patient flow; unknown actor can never reach Doctor Control. `ADMIN_PHONE` alone never grants Doctor authorization.
  - GitHub: M4-A merged to `main` as PR #17 (2026-08-30, `1a7f589`).
- **M4-B (Doctor Schedule Read / Effective Schedule Boundary) — implemented, pending supervisor review.** `Application/DoctorScheduleReadService.js` + `tests/HardeningM4B.test.js`. Path: M4-A `controlContext` → `readCurrentEffectiveSchedule` → `SettingsRepository.getSettingsResult()` / `getSlotDurationInfo()` → application Effective Schedule (`scope`, `source:'SETTINGS'`, `recurrence:'WEEKLY'`, `timezone:'Asia/Baghdad'`, `days`, `workWindow`, `slotDurationMinutes`). v1 Effective Schedule = current recurring Settings (no overrides, no `effectiveFrom`). Fail-closed: missing/unreadable Settings keep `SETTINGS_*`; malformed window/duration → `SCHEDULE_SOURCE_INVALID` (never closed/empty/healthy/silent 30). Read-only; does not modify M4-A, Router, Availability, Calendar, or WhatsApp. No doctor conversation state (channel UX is not M4-B).
- **Always manual (owner):** git commit/push, Apps Script deploy, trigger setup, live testing. The agent only produces code.

## 16. How to Work on This Project Safely

1. Follow the golden rule: **Understand → Inspect → Analyze → Propose → Approve → Implement → Verify**. If asked to "review/analyze", write no code.
2. This is a HARDENING project, not a rewrite. Do not refactor, re-architect, move files, rename globals, delete legacy code, or change contracts without explicit approval.
3. Do not touch: Scheduler trigger, StateMachine, Result, LogRepository contract, Config vocabulary, atomicUpdate semantics — unless the task explicitly requires it and you've explained the impact first.
4. Prefer the smallest safe change (one file over five). Before touching any sheet column, audit every consumer.
5. Verify facts against actual code — this document can drift. Update it only when the difference matters.
6. Double-check concurrency: assume Webhook and Scheduler can run simultaneously; check lock scope, lock timeout, and retry/idempotency for every booking/archive/state change.
7. Never use `Result.ok({success:false})` to represent failure. Keep operational success distinct from housekeeping (archive) success.
8. Never claim changes are pushed/deployed — the owner handles git + Apps Script deployment. Provide a commit message when asked.
9. Do not add features or triggers that weren't requested; put unsolicited improvements under "OPTIONAL FUTURE IMPROVEMENT".
10. Report findings in the owner's format (STATUS / What I inspected / Findings / Risk / ...) with P0–P4 severity, and recommend the simplest correct option.
