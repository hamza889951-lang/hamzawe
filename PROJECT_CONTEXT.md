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
Scheduler.js                      Daily orchestrator (Archive→Maintenance→Horizon→Disruption→Reminders→HealthCheck) + Liveness
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
AvailabilityHorizonMaintainer.js  ensureHorizon() — keeps 30-day availability horizon (ADR-022); M4-D evolution: horizon + Effective-Availability materialization point (is_available reconciled via EffectiveScheduleService pure projection, bounded by horizon, source-snapshot + fail-closed reads via queryResult)
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

Note: Repositories are inconsistently placed (some at root, some in `Repositories/`). This is a known cosmetic inconsistency, not to be "fixed" casually. (TD-05, 2026-09-03: disposition CLOSED — no mass move, no directory rewrite, no cascade import changes; layout causes no functional defect on the M4-F prerequisite path.)

**Post-v1 module addendum (TD-03 governance reconciliation, 2026-09-03)** — the file list above grew during M0 → M4-E; the modules NOT listed there (verified against their file headers, not invented):

```
Application/MetricsService.js             M1-A/M1-C — ONE metrics foundation (daily/weekly/monthly + capacity intelligence)
Application/ReportService.js              M1-B — Daily/Weekly/Monthly report consumers over MetricsService
Application/ReportRenderer.js             M1-B — pure rendering of report models
Utils/ReportPeriod.js                     M1-B — clinic-local (Asia/Baghdad) period arithmetic (start incl, end excl)
Application/RateFoundationService.js      M2 — four management rates over the appointment-EPISODE model
Application/RateRuleService.js            M2 — rules/insights layer over the rate foundation (read-only)
Application/EnhancedReportService.js      M3 — composition layer; assembles one canonical EnhancedReportModel, never re-derives metrics
Application/EnhancedReportRenderer.js     M3 — presentation of the composed model
Repositories/AttendanceAuditReadRepository.js  M1-A — strict read-only boundary over ATTENDANCE_AUDIT (source failure ≠ empty; append-only write repo untouched)
ProcessedMessagesRepository.js            B2 — atomic idempotency claim (claim() inside Lock.runExclusive('idempotency')); owns Lock + PropertiesService
Application/B6LifecycleService.js         B6 — durable lifecycle ownership, checkpoints, terminal proof, recovery audit, internal trusted-recovery seam (no public endpoint)
Repositories/B6LifecycleRepository.js     B6 lifecycle store
Repositories/B6RecoveryAlertRepository.js B6 recovery-alert store
Repositories/B6RecoveryAuditRepository.js B6 recovery audit-evidence store
Infrastructure/B6RecoveryAlert.js         B6 alert delivery adapter
Application/EffectiveScheduleService.js   M4-C — single deterministic EffectiveSchedule projection (pure; time passed in, no Clock inside; fail-closed); M4-D added source-snapshot variants (evaluateSlotFromSources / projectDayEffectiveWindowFromSources)
Application/DoctorScheduleCommandService.js M4-C — schedule-intent command boundary: fresh read under per-scope lock → validate → append-only persist; commandId idempotency; Settings is the sole slot-duration authority (Continuation)
Repositories/ScheduleChangeRepository.js  M4-C — append-only ScheduleChanges intent store (no update/delete; scope lookups)
Application/DoctorControlInteractionService.js M4-C Continuation — provider-neutral numbered Doctor Control interaction: read-only Preview (affected-booking COUNT only) → explicit Confirm → commit re-validated under the per-scope lock
Application/AffectedAppointmentDiscoveryService.js M4-E — read-only affected-appointment discovery over the current materialized view (no writes, no locks, no journal; deterministic ImpactDiscoveryResult). Consumed by M4-F as stale-able evidence; M4-F must revalidate slot state before any mutation.
```

## 4. Data Models & Sheet Structures

### Availability sheet (`Availability`) — Source of Truth for booking
| Column | Notes |
|---|---|
| slot_id | `SLT_<ULID>` (generated) |
| date | `YYYY/MM/DD` (string, from `formatDateForStorage`) |
| time | `HH:mm` (string, from `formatTimeForStorage`) |
| sort_key | `YYYYMMDDHHmm` string — temp format, parsed by `LegacySlotTimeParser` (ADR-016) |
| status | FREE / RESERVED / CONFIRMED / COMPLETED / NO_SHOW / EXPIRED / CANCELLED (reserved) |
| is_available | bool/`TRUE` — slot bookable + doctor present. `false` = NOT bookable. Since M4-D (merged 2026-09-02) this column is the **materialized projection of the EffectiveSchedule**, kept reconciled by `AvailabilityHorizonMaintainer` for future non-terminal slots; the "doctor presence" meaning remains the future vacation-dashboard plan. The consumer contract is unchanged and protected: `is_available=false` ⇒ not bookable. |
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
  acquire UserLock — LockService.getUserLock() (B5 serialization; ScriptLock is
  deliberately NOT held across stages that re-acquire it via Lock.runExclusive;
  waitLock 1000ms; else return SKIPPED)
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
Doctor Control (M4-C Continuation) uses its own additive states — `DOCTOR_MENU`, `DOCTOR_AWAITING_INPUT`, `DOCTOR_AWAITING_CONFIRMATION` (`Config.VOCABULARY.CONVERSATION_STATE`) — reached ONLY through the M4-A fail-closed doctor gate in `Core/Router.js`; an authorized doctor never enters the patient table above, and patient rows can never reach the doctor states.
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
- `SlotRepository` legacy query methods (`findById`, `findByStatus`, `findByPhoneAndStatus`, `query`) still swallow read exceptions and return `[]`/`null` (best-effort reads; acknowledged design). **Exception since TD-01 (2026-09-03):** `SlotRepository.atomicUpdate` no longer uses the swallowing `findById()` — its fresh re-read goes through `findByIdResult()`, so a storage failure returns `Result.fail('SLOT_READ_FAILED', …)` and `SLOT_NOT_FOUND` is produced only for a genuine successful-read-with-no-row. Result-aware readers: `findByIdResult` (single row) and `queryResult` (rows); the legacy contracts are intentionally preserved for old call sites.
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
- **P2 — Application-layer storage leaks (planned hardening):** `MaintenanceService` → `GoogleSheets.updateBatch` directly; `HealthCheckService` → `GoogleSheets.getAllRows` + `PropertiesService`; `Scheduler` → `LockService` + `PropertiesService` directly; `SlotRepository.query(predicate)` passes raw rows to Application. (Archive was the first of these fixed — Phase A; `ProcessedMessagesService → PropertiesService` was listed here until the 2026-09-03 reconciliation and is **no longer accurate** — since B2 the atomic claim lives in `ProcessedMessagesRepository` and the Service touches neither Lock nor PropertiesService.)
- **FIXED (debt gate, 2026-09-03) — TD-01 `atomicUpdate` fresh-read classification:** previously the fresh re-read inside `atomicUpdate` used the swallowing `findById()`, so a GoogleSheets read failure surfaced to safe-mutation callers as `SLOT_NOT_FOUND`. Now `findByIdResult()` distinguishes failure (`SLOT_READ_FAILED`) from absence (`SLOT_NOT_FOUND`); lock key `Lock.runExclusive('slot:' + slotId, …)`, the read→decisionFn→update order, and every caller contract are preserved. Guarded by `tests/HardeningTD01.test.js` (23 tests).
- **FIXED (debt gate, 2026-09-03) — TD-02 CAS-009 violation:** `AvailabilityHorizonMaintainer.ensureHorizon()` had one bare `new Date()` in the no-existing-slots reconciliation branch; it now derives `today` from the operation's Clock-captured `nowMs`. No behavioral difference is observable today (that branch runs only when no parseable `sort_key` exists), so the fix is determinism/constitution compliance; a permanent repository-wide CAS-009 structural scan now guards it (`tests/HardeningTD02.test.js`, 7 tests — zero remaining `new Date()`/`Date.now()` current-time reads outside `Clock.js`).
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
- **Sheets required:** `Availability`, `Conversations`, `Settings`, `SYSTEM_LOG` (archive sheet auto-created). M4-C additionally requires `ScheduleChanges` (append-only schedule intent). M4-C Continuation additionally requires 7 doctor-session columns on `Conversations` (`doctor_draft_kind`, `doctor_draft_command_id`, `doctor_draft_days`, `doctor_draft_window`, `doctor_draft_effective_from`, `doctor_draft_effective_to`, `doctor_draft_target_change_id`) — missing columns fail closed (`DOCTOR_CONTROL_SCHEMA_MISSING`); Doctor Control won't operate until they exist, patient flows unaffected.
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
- **Stable v1.0**; constitution v3.2; hardening roadmap officially complete. Post-v1 program milestones M0, M1-A…M1C, M2, M3, B1–B6, M4-A…M4-F are implemented and merged on `main` (M4-F merged via PR #24 on 2026-09-03). M4-F remains production-gated: no deployment/migration/live Sheets provisioning is authorized by this document.
- **Recently completed:** ArchiveService for SYSTEM_LOG (last commits); Scheduler archive stage; Liveness fix; HealthCheck; horizon maintainer; webhook idempotency.
- **Implemented (Phase A — decouple ArchiveService from storage):** `LogArchiveRepository` created (findOlderThan / appendToArchive with read-back verify / deleteRecords with identity rule); `ArchiveService` is now policy-only (no `SpreadsheetApp`, no sheet names, no row numbers, no delete logic, no `_rowNumber`); `GoogleSheets` gained generic `getOrCreateSheet`, `deleteRowsByNumbers`, and `_openSpreadsheet`. Batch delete (merged ranges, no `deleteRow` loop). No Scheduler/LogRepository/Config/Result changes.
- **Tested (local, test-only):** `ArchiveTestHarness.js` (deletable) — in-memory GoogleSheets mock + real production code loaded read-only; 8/8 PASS covering successful archive, no-old-records, copy failure (no delete), identity-not-found (no delete), identity-ambiguous (no delete), crash-after-copy-before-delete + retry, partial-delete + retry, date normalization.
- **Pending (owner):** git commit/push of Phase A + PROJECT_CONTEXT update; Apps Script deploy; **live test of archive on real SYSTEM_LOG** (mock is faithful but not a substitute for real Sheets API behavior/quota); ArchiveTestHarness is temporary and may be deleted.
- **Planned separately:** Scheduler archive ordering (archive last); Application-layer leakage hardening (Maintenance/HealthCheck/Scheduler/ProcessedMessages → repositories); booking-path concurrency review (SlotSelection retry) — next stated goal.
- **M4-A (Doctor Identity & Authorization Boundary) — MERGED (PR #17, 2026-08-30, `1a7f589`).** Scope: `Application/DoctorAuthorizationService.js` (authorizeDoctor, canonical phone via `PhoneUtils.normalize`, fail-closed), `Application/DoctorControlEntry.js` (provider-neutral read-only control entry, no channel reply/UX text), `Repositories/DoctorIdentityRepository.js` (reads `DOCTOR_PHONE` Script Property; no Doctors table), `Core/Router.js` minimal routing-only gate, `tests/HardeningM4A.test.js` (29 tests).
  - Identity correction (2026-08-31): `ADMIN_PHONE` is **Owner / Operations notification destination only** and must NOT authorize or identify the doctor. Doctor identity source is the independent `DOCTOR_PHONE` Script Property, read only through `DoctorIdentityRepository`.
  - Decisions recorded: scope representation uses `{ clinicId: null }` for v1 implicit single-clinic while keeping future `Doctor → Clinic(s)` extensibility; no new conversation state (M4-B will define it when schedule interaction begins); no schedule/availability/appointment/calendar mutation in M4-A; no channel wording is introduced (final UX deferred to Supervisor).
  - Fail-closed: missing/unreadable/invalid `DOCTOR_PHONE` or unmatched phone → `DOCTOR_IDENTITY_SOURCE_UNAVAILABLE` / `DOCTOR_UNAUTHORIZED` → Router continues the existing patient flow; unknown actor can never reach Doctor Control. `ADMIN_PHONE` alone never grants Doctor authorization.
  - GitHub: M4-A merged to `main` as PR #17 (2026-08-30, `1a7f589`).
- **M4-B (Doctor Schedule Read / Effective Schedule Boundary) — MERGED (PR #18, 2026-08-31, `476f896`).** `Application/DoctorScheduleReadService.js` + `tests/HardeningM4B.test.js`. Path: M4-A `controlContext` → `readCurrentEffectiveSchedule` → `SettingsRepository.getSettingsResult()` / `getSlotDurationInfo()` → application Effective Schedule (`scope`, `source:'SETTINGS'`, `recurrence:'WEEKLY'`, `timezone:'Asia/Baghdad'`, `days`, `workWindow`, `slotDurationMinutes`). v1 Effective Schedule = current recurring Settings (no overrides, no `effectiveFrom`). Fail-closed: missing/unreadable Settings keep `SETTINGS_*`; malformed window/duration → `SCHEDULE_SOURCE_INVALID` (never closed/empty/healthy/silent 30). Read-only; does not modify M4-A, Router, Availability, Calendar, or WhatsApp. No doctor conversation state (channel UX is not M4-B).
- **M4-C Continuation / Prerequisite Closure v1 — implemented on `arena/01a05c2d-hamzawe` (base `218aa9b`; commits `07ad6df`, `965639c`, `3d15ed9`); subsequently reviewed and MERGED as PR #20 (2026-09-02, `5471c4e`).** Governed by `docs/M4/M4C_CONTINUATION_FROZEN_CONTRACT_v1_2026-09-01.md` + review addendum; full implementation notes in `docs/M4/M4C_CONTINUATION_IMPLEMENTATION_NOTES_v1.md`. Delivered: (1) Settings is the sole operational slot-duration authority in the M4 path (`slotDurationSource:'SETTINGS'`; missing/invalid config → `SCHEDULE_SOURCE_INVALID`, no silent 30; historical `slotDurationMinutes` payload values immutable but ignored); (2) recurring `effectiveFrom` = doctor-selected local date `T00:00` Asia/Baghdad, enforced at Application layer; (3) temporary overrides exact half-open `[from,to)`; exceptional open reuses the Settings work window (doctor window rejected; partial-day rejected); grid representability is validation-only (`UNREPRESENTABLE_SCHEDULE_INTERVAL`, no slot splitting/regeneration); (4) fresh `status==FREE && is_available==true` check inside every →RESERVED `atomicUpdate` decision function (BookingService + both ChangeService paths; `SLOT_UNAVAILABLE`; `atomicUpdate` semantics unchanged); (5) reminder eligibility gained the minimal `is_available===true` gate; (6) provider-neutral Doctor Control numbered WhatsApp-text interaction — NEW single boundary `Application/DoctorControlInteractionService.js` (justified: `DoctorControlEntry` is the frozen read-only M4-A contract), Router stays routing-only hand-off, session state = 3 additive `Config` states + 7 bounded `doctor_draft_*` Conversations columns (no JSON blob; fail-closed `DOCTOR_CONTROL_SCHEMA_MISSING`), read-only Preview (affected-booking COUNT only, zero persistence/materialization) → explicit confirm → commit reusing the preview-time `commandId` (duplicate confirm = `IDEMPOTENT_REPLAY`), temporal CANCEL via numbered list resolving to semantic `changeId`. No new Slot status, no auto-cancellation, no buttons, no Calendar mutation, no availability materialization (M4-D remains future). [Correction 2026-09-03: the parenthetical was accurate at Continuation time; M4-D materialization has since been implemented and merged (PR #21) — see below.] Tests: `tests/HardeningM4CC.test.js` 45/45 (incl. PR #20 revision: E14 schema↔docs exact match, E15 stale-preview confirm re-validation, E16 informational count, E17 mid-flow single-column fail-closed); M4-C targeted regression PASS; full regression PASS except HardeningM1B / M1B-X3 (pre-existing at baseline). PR #20 revision decision: Preview is informational (not commit-authoritative); Confirm rebuilds the command with fresh `asOf` and the command service re-validates against current state inside the per-scope lock; canonical draft columns are `ConversationRepository.DOCTOR_SESSION_FIELDS`.
- **M4-C (Schedule Intent Management) — MERGED (PR #19, 2026-08-31, `35a28cc`).** Append-only `ScheduleChanges` intent store (`Repositories/ScheduleChangeRepository.js`), single pure projection boundary (`Application/EffectiveScheduleService.js`), command boundary with fresh read + validate + append-only persist + commandId idempotency (`Application/DoctorScheduleCommandService.js`). Tests: `tests/HardeningM4C.test.js` (37). Governed by `PROJECT_MEMORY/M4_C_CONTRACT_v1.md` + `PROJECT_MEMORY/M4_C_DECISION_LAYER.md`.
- **M4-D (Effective Availability Materialization) — MERGED (PR #21, 2026-09-02, `2c04b2d`).** `AvailabilityHorizonMaintainer.ensureHorizon()` evolved into horizon + materialization: existing non-terminal future slots reconciled to the EffectiveSchedule projection (per-slot `atomicUpdate`, decision made on the fresh row, terminal statuses never touched, `is_available` only — `status` remains StateMachine-owned), missing slots gap-filled (required − existing), deduplicated by `sort_key`; all Availability reads Result-based fail-closed (`queryResult`); source snapshot loaded once per run; no new AvailabilityRepository, no new engines, no global booking freeze. Tests: `tests/HardeningM4D.test.js` 63/63; acceptance mapping `docs/M4/M4D_ACCEPTANCE_MAPPING.md` (v2.1 reconciled 2026-09-03 under TD-04).
- **M4-E (Affected Appointment Discovery / Impact Preview) — MERGED (PR #22, 2026-09-03, `aff2100`).** `Application/AffectedAppointmentDiscoveryService.js`: read-only discovery of affected bookings over the current materialized view (`is_available` operationally false inside an explicit half-open window), deterministic ordered `ImpactDiscoveryResult`, zero PII default DTO, `AVAILABILITY_SOURCE_FAILED` never collapses to empty. No writes, no locks, no journal. M4-F consumes this service as stale-able evidence and revalidates current Slot state before any mutation. Tests: `tests/HardeningM4E.test.js` 30/30.
- **Technical Debt Remediation Gate (Post M4-E / Pre M4-F, 2026-09-03) — CLOSED / MERGED (PR #23, `62654b73bf01aae818794429a2adc2c71d28fb30`).** *Correction (M4-F session, 2026-09-03, TD-03 follow-through): an earlier revision of this line read "pending Supervisor Technical-Gate closure"; the gate was merged as the pre-M4-F `main` baseline, per `HAMZAWE_M4F_CONTRACT_CLOSURE_ADDENDUM_v1.1_2026-09-03.md` §1. Historical wording below is retained for traceability.* TD-01: `atomicUpdate` fresh-read distinguishes `SLOT_READ_FAILED` from `SLOT_NOT_FOUND` (+23 tests). TD-02: CAS-009 audit — one violation found and fixed in `AvailabilityHorizonMaintainer`; permanent structural guard (+7 tests). TD-03: this reconciliation pass (PROJECT_CONTEXT + constitution notes + M4-C continuation correction). TD-04: M4-D acceptance mapping documentation reconciliation (counts/status wording only; no test/contract change). TD-05: repository layout — CLOSED, documented known debt, no mass moves. TD-06: `sort_key`/`LegacySlotTimeParser` — CLOSED/DEFERRED by architectural decision; M4-F must keep the canonical `sort_key → LegacySlotTimeParser` interpretation. Full regression at this gate: 697/698 — the single failure was the documented pre-existing `HardeningM1B / M1B-X3`, byte-identical to baseline. M4-F implementation was subsequently authorized separately and merged as PR #24; see the current M4-F post-merge record below. No production deployment is authorized.
- **M4-F (Patient Disruption / Recovery) — MERGED (PR #24, 2026-09-03, `f01dba5732200085669a1d1bc120e58ff25a471d`).** Implements stale-able M4-E consumption, bounded per-phone serialization, candidate reservation, durable proposal lifecycle, explicit confirmation/decline/timeout, recovery sweep, and retry-safe notification bookkeeping. Pre-merge targeted verification reached 103/103 before the post-merge P1 fix; post-merge hardening adds M4F-104/105 for recovery-evidence preservation. Current production gate remains CLOSED: owner-only schema provisioning, deployment, trigger changes, and live testing are not authorized.
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
