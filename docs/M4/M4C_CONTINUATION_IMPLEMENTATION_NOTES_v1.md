# M4-C Continuation / Prerequisite Closure v1 — Implementation Notes

Status: IMPLEMENTED on branch `arena/01a05c2d-hamzawe`, pending supervisor review.
Governing contract: `docs/M4/M4C_CONTINUATION_FROZEN_CONTRACT_v1_2026-09-01.md`
(+ `docs/M4/M4_CONTRACT_REVIEW_DECISION_ADDENDUM_2026-09-01.md`).
Date: 2026-09-01.

---

## 0. Governance note (baseline)

The contract references historical baseline `35a28ccd`. That commit is not
reachable in this repository (history was squashed). The accepted operational
baseline for this work is `218aa9b9d45bac044d0435f7c1602c0bcdcdae75` (`main`),
recorded by owner decision as a governance note, not a blocker. All commits
below are on `arena/01a05c2d-hamzawe` branched from `218aa9b`.

Commits:

| Commit | Phase | Content |
|---|---|---|
| `07ad6df` | A+B | Settings-authoritative slot duration; recurring 00:00 boundary; Settings-window exceptional open; grid representability validation |
| `965639c` | C+D | Fresh `is_available` guard inside reservation `atomicUpdate` paths; reminder operational availability gate |
| `3d15ed9` | E | Provider-neutral Doctor Control numbered interaction: read-only Preview → explicit Confirm → Commit |
| (this)   | F | Documentation only |

---

## 1. What changed, by contract correction (§19)

### 1.1 `slotDurationMinutes` operational authority neutralized (§19.1–19.2)

- `Application/DoctorScheduleCommandService.js`: recurring command payloads no
  longer accept or persist a doctor-supplied duration as authority. Historical
  M4-C-v1 records that contain `slotDurationMinutes` remain **immutable and
  untouched** (owner condition #7) — they are operationally **ignored**.
- `Application/EffectiveScheduleService.js`: projection duration always comes
  from Settings (`SettingsRepository`), reported as
  `slotDurationSource: 'SETTINGS'`. Missing/invalid configured duration in the
  M4 path → honest `SCHEDULE_SOURCE_INVALID`. **No silent 30-minute fallback
  in the M4 path.** The legacy `getSlotDurationMinutes()` fallback is preserved
  for legacy callers only.

### 1.2 Recurring effective boundary (§19.3)

- Doctor selects a local date (`YYYY-MM-DD`); persisted `effectiveFrom` is that
  date `T00:00` Asia/Baghdad. Enforced in the Application layer
  (`RECURRING_EFFECTIVE_BOUNDARY_INVALID` on any non-midnight boundary), not
  only in text parsing — no caller can bypass it. Current time is never used
  as a boundary.

### 1.3 Temporary overrides and exceptional open (§19.4)

- Overrides are exact half-open `[effectiveFrom, effectiveTo)` Asia/Baghdad.
- Exceptional open v1: payload is `{commandId, asOf, date}` only. A
  doctor-supplied work window is **rejected**; the Settings work window is
  applied and recorded as `workWindowSource: 'SETTINGS'`. Partial-day
  exceptional open → `PARTIAL_DAY_EXCEPTIONAL_OPEN_UNSUPPORTED`.
- Representability (C8) is **validation only**: intervals not aligned to the
  configured slot grid → `UNREPRESENTABLE_SCHEDULE_INTERVAL`. No slot
  splitting, rounding, regeneration, or Availability change.

### 1.4 Append-only intent + temporal CANCEL (§19.5)

Unchanged and preserved: schedule intents are append-only; CANCEL appends a
new record referencing `targetChangeId`; the original record is never edited.

### 1.5 Doctor Control numbered interaction (§19.6–19.7)

New boundary: `Application/DoctorControlInteractionService.js` — the **single**
new application boundary (owner condition #3). Written justification (also in
the file header): `Application/DoctorControlEntry.js` is the frozen merged
M4-A entry contract — read-only, no repositories, no CommandExecutor, enforced
structurally by merged M4-A tests. The interaction flow requires conversation
session state, a read-only booking-impact count, and commits through
`DoctorScheduleCommandService`; extending the entry would rewrite the frozen
M4-A boundary. Responsibilities remain separated:
Router (routing) → DoctorAuthorization/Entry (identity, frozen) →
InteractionService (presentation/session) → DoctorScheduleCommandService
(schedule semantics).

Flow (WhatsApp text, numbers = presentation only, no buttons):

1. Any first message from the authorized doctor → numbered menu
   (1 عرض الجدول، 2 تعديل الجدول الأسبوعي، 3 إغلاق مؤقت، 4 فتح استثنائي،
   5 إلغاء تغيير مجدول، 0 رجوع).
2. Option input formats:
   - recurring: `1,2,4 | 10:00-14:00 | 2026-09-15` (days 1=الأحد…7=السبت)
   - temporary close: `2026-09-20` (full day) or
     `2026-09-20 10:00 | 2026-09-20 12:00`
   - exceptional open: date only (Settings window applied)
3. **Preview** (strictly read-only): renders the requested change and
   `الحجوزات المتأثرة حاليًا: N` — an affected-booking **count only** (no
   patient names, phones, or appointment details). Preview never materializes
   Availability, never creates slots, never flips `is_available`, never writes
   ScheduleChanges. Impact = future RESERVED/CONFIRMED slots whose projected
   interval flips open→CLOSED under the hypothetical record, computed via the
   same `EffectiveScheduleService` semantics the commit uses.
4. **Explicit confirmation** (`1` = تنفيذ, `2`/`0` = تجاهل). The `commandId`
   (`SCMD_` + ULID) is generated once at input-parse time, stored in the
   session draft, and reused at commit → a redelivered/duplicate confirm is an
   `IDEMPOTENT_REPLAY` ("كان منفذًا سابقًا") with **no duplicate record**.
5. Cancel flow: numbered list of active, non-expired changes (deterministic
   sort by `effectiveFrom`, then `changeId`); the selected index resolves
   immediately to the semantic `changeId` stored in the draft; commit appends
   a CANCEL record; the target record is untouched.

#### Preview → Confirm temporal semantics (PR #20 review decision)

**Preview is an INFORMATIONAL preview, not a commit-authoritative snapshot.**
There is no persistent preview snapshot and no snapshot subsystem.

Mechanics (verified in code, enforced by tests M4CC-E15/E16):

- The preview result object is **never passed into the commit path**. The only
  state carried from Preview to Confirm is the bounded draft (the semantic
  command inputs + the preview-time `commandId` for idempotency).
- On Confirm, the semantic command is rebuilt from the draft with a **fresh
  `asOf` from `Clock.now()`**, and `DoctorScheduleCommandService.commit*`
  re-runs the **full** validation / baseline read / record listing /
  projection / conflict detection **against current state inside the
  per-scope lock** (`runExclusiveForScope`).
- If data changed between Preview and Confirm, the commit fails honestly
  (e.g. `SCHEDULE_INTENT_CONFLICT` for a newly overlapping override) — it is
  never executed on the basis of a stale preview (M4CC-E15).
- The affected-booking count is informational only: it is not a commit
  precondition and the commit neither re-checks nor acts on it — bookings are
  never auto-cancelled regardless of the count (M4CC-E16).
- No new locking and no Availability mutation were added for this.

Session state (owner condition #1 — bounded schema, no JSON blob):
`ConversationRepository` gained doctor-session operations on the existing
Conversations sheet — `DOCTOR_SESSION_FIELDS` = 7 clear-purpose columns
(**canonical names, PR #20 review decision — single naming everywhere**):
`doctor_draft_kind`, `doctor_draft_command_id`, `doctor_draft_days`,
`doctor_draft_window`, `doctor_draft_effective_from`,
`doctor_draft_effective_to`, `doctor_draft_target_change_id` — plus the three
additive `Config` conversation states `DOCTOR_MENU` / `DOCTOR_AWAITING_INPUT`
/ `DOCTOR_AWAITING_CONFIRMATION` on the existing `state` column. Unknown draft
keys are rejected (`INVALID_DOCTOR_SESSION_FIELD`); every write sets **all**
draft fields (unspecified → `''`) so no stale residue survives a state change.
Missing doctor columns fail closed with `DOCTOR_CONTROL_SCHEMA_MISSING`
(because `Infrastructure/GoogleSheets.js` silently drops unknown columns, a
schema check is mandatory — see §4 deployment). The single source of truth
for the column list is `ConversationRepository.DOCTOR_SESSION_FIELDS`; test
**M4CC-E14** enforces that this document, `PROJECT_CONTEXT.md`, and the test
fixtures all list exactly those names — no alternative schema is accepted,
silently or otherwise (M4CC-E10 all-columns-missing, M4CC-E17 single column
missing mid-flow: fail closed before any command execution or partial write).

Router (owner condition #2): `Core/Router.js` only hands
`controlContext + raw message` to the interaction service after the frozen
M4-A entry accepts, behind a `typeof` fail-closed guard (older bundles keep
the M4-A read-only entry behavior). No parsing, wording, or schedule
references in Router — verified structurally by test M4CC-E12.

### 1.6 Fresh `is_available` guard in reservation paths (§19.8)

Owner condition #5 inventory — every →RESERVED `atomicUpdate` path, audited
**before** the change (full inventory recorded in commit `965639c` message):

| Path | Fresh check inside decisionFn | Protected |
|---|---|---|
| Initial booking (`BookingService._reserveEarliestBookable`) | `status==FREE && is_available==true` via `SlotRepository.isOperationallyAvailable` | ✅ |
| Pre-confirm reschedule (`ChangeService._reserveAlternativeSlot`) | same | ✅ |
| Post-confirm replacement (`ChangeService._reserveAlternativeSlot`) | same | ✅ |

RESERVED→CONFIRMED is lifecycle progression and intentionally not gated.
`SlotRepository.atomicUpdate` semantics untouched (existing lock + fresh
reread + decision function remain the linearization boundary; no new locks).
Retry loops exclude candidates on `INVALID_TRANSITION` **or** the new
`SLOT_UNAVAILABLE`.

### 1.7 Lifecycle preservation (§19.9) and reminder gate (§19.10)

- No new Slot status; StateMachine untouched; closure never auto-cancels
  RESERVED/CONFIRMED appointments (no automatic cancellation/rescheduling —
  affected bookings are surfaced as a count for the doctor's awareness only).
- `Reminderservice.js`: eligibility predicate extended minimally —
  `CONFIRMED && is_available === true && window && not sent`. No new reminder
  subsystem, state, scheduler change, or retry-model change (verified
  structurally by M4CC-D4).

---

## 2. Files changed / untouched

Changed: `Application/DoctorScheduleCommandService.js`,
`Application/EffectiveScheduleService.js`, `Application/BookingService.js`,
`Changeservice.js`, `Reminderservice.js`, `Repositories/SlotRepository.js`,
`ConversationRepository.js`, `Core/Router.js`, `Config.js`,
`Utils/DateUtils.js`, `Utils/IdGenerator.js`.
New: `Application/DoctorControlInteractionService.js`.
Tests: `tests/HardeningM4CC.test.js` (new, 41 tests),
`tests/HardeningM4C.test.js` (updated for new semantics + DateUtils load),
`tests/HardeningB6.test.js` (mock gained `isOperationallyAvailable`).

Deliberately untouched: `Application/DoctorControlEntry.js`,
`Application/DoctorAuthorizationService.js`,
`Repositories/DoctorIdentityRepository.js`, `Domain/StateMachine.js`,
`Repositories/ScheduleChangeRepository.js` storage semantics,
`SlotRepository.atomicUpdate` core, Scheduler/trigger model, Calendar
integration, patient booking flows beyond the guard, historical
ScheduleChanges rows.

Forbidden items confirmed absent: no second schedule engine / availability
store / SlotSelection policy / StateMachine; no new Slot status; no global
lock or TransactionManager (lock kinds remain `slot:`, `schedule-intent:`,
`maintenance` — test M4CC-C6); no bus-count input; no slot-duration doctor
control; no automatic cancellation/rescheduling or patient-disruption
workflow; no buttons; no Calendar mutations; no pricing/analytics/multi-clinic.
Scope key stays `(doctorId, clinicId)` with `clinicId = null` in v1.

---

## 3. Tests & regression

- `tests/HardeningM4CC.test.js`: 45/45 — sections A (duration authority),
  B (boundaries/representability), C (reservation guard + lock whitelist),
  D (reminder gate, structural), E (interaction: menu, read-only preview with
  count-only impact, confirm/discard, idempotent replay, unrepresentable
  input, exceptional open, cancel flow, fail-closed schema, invalid context,
  structural routing-only / provider-neutrality / frozen-entry scans,
  half-open full-day close verified through projection; PR #20 revision:
  E14 schema↔documentation exact-match, E15 stale-preview confirm re-validation,
  E16 informational count / lifecycle boundary, E17 single-column mid-flow
  fail-closed).
- `tests/HardeningM4C.test.js`: 37/37. `tests/HardeningM4A.test.js`: 29/29
  (frozen entry unaffected). `tests/HardeningB6.test.js`: 34/34.
- `node --check` clean on all changed files.
- **M4-C targeted regression PASS; Full regression PASS except
  HardeningM1B / M1B-X3 (pre-existing)** — 16 of 17 suites fully green;
  M1B-X3 (clasp alphabetical evaluation-order test) failed identically at
  baseline `218aa9b` before any change.

Test determinism note: `DateUtils.formatLocalStamp(Clock.now())` is host-TZ
dependent under Node; tests use effective dates far in the future and never
assert exact `asOf` values.

---

## 4. Deployment preconditions (manual, owner)

1. **Conversations sheet**: add the 7 columns (exact names — these are the
   canonical `ConversationRepository.DOCTOR_SESSION_FIELDS`, enforced against
   this document by test M4CC-E14):
   `doctor_draft_kind`, `doctor_draft_command_id`, `doctor_draft_days`,
   `doctor_draft_window`, `doctor_draft_effective_from`,
   `doctor_draft_effective_to`, `doctor_draft_target_change_id`
   **before** enabling Doctor Control. `GoogleSheets.js` silently drops
   writes to unknown columns; the code fails closed
   (`DOCTOR_CONTROL_SCHEMA_MISSING`) rather than losing drafts, so Doctor
   Control simply won't operate until the columns exist. Patient flows are
   unaffected either way.
2. `ScheduleChanges` sheet and `DOCTOR_PHONE` Script Property as per M4-A/M4-C.
3. Settings must contain a valid `Slot Duration (min)` — the M4 path now
   fails honestly (`SCHEDULE_SOURCE_INVALID`) instead of assuming 30.
4. Historical ScheduleChanges rows require **no migration** — old
   `slotDurationMinutes` values stay in place and are ignored operationally.

---

## 5. Known limitations / remaining risks (classified)

- **P2** — Preview impact count reads slots via `sort_key` string projection;
  unparseable legacy sort_keys are skipped (best-effort read). Projection
  failure during preview fails honestly rather than showing a wrong count.
- **P2** — `DoctorControlInteractionService._cancellableChanges` calls
  `EffectiveScheduleService._activeRecords` (private cross-call). Documented
  precedent from the command service; a future shared internal helper module
  would remove the underscore coupling. Not fixed here (owner condition #10 —
  no scope expansion).
- **P3** — Recurring input requires ≥1 working day (presentation-level
  decision; a doctor wanting zero recurring days uses temporary close).
- **P3** — Doctor session shares the Conversations row keyed by phone; if a
  doctor's phone were ever also a patient phone, states would collide.
  Impossible under current single-doctor `DOCTOR_PHONE` policy; revisit at
  multi-doctor.
- Pre-existing, out of boundary: HardeningM1B / M1B-X3 failure (clasp
  evaluation-order harness), present at baseline.

Out of scope, unchanged, and NOT implemented (per contract): availability
materialization (M4-D), automatic cancel/reschedule, patient disruption /
replacement flows, calendar mutations, pricing, analytics, multi-clinic.

---

## 6. PR #20 revision (Supervisor REQUEST CHANGES) — 2026-09-02

### 6.1 Issues addressed

1. **Deployment schema mismatch** — the code previously used shortened
   column names for the interval fields (`…_draft_from` / `…_draft_to`)
   while this document specified
   `doctor_draft_effective_from` / `doctor_draft_effective_to`. Resolved by
   renaming the **code** to the supervisor-preferred canonical names (more
   precise semantics). One naming now exists across
   `ConversationRepository.DOCTOR_SESSION_FIELDS` (single source of truth),
   `DoctorControlInteractionService`, tests, this document, and
   `PROJECT_CONTEXT.md`. No data migration (feature not yet deployed; no
   historical data uses the old names). No alternative schema is accepted
   silently; fail-closed behavior unchanged. Test **M4CC-E14** proves the
   documented deployment schema equals the code schema exactly.
2. **Preview → Confirm temporal semantics** — decision recorded above
   (§1.5 "Preview → Confirm temporal semantics"): informational preview;
   Confirm rebuilds the command with fresh `asOf` and the command service
   re-validates against current state inside the per-scope lock. No code
   change was required — the implementation already behaved this way;
   regression tests **M4CC-E15** (stale preview → honest
   `SCHEDULE_INTENT_CONFLICT`, no commit) and **M4CC-E16** (count is
   informational, commit never gates on it, bookings untouched) now pin it.
3. **Draft schema robustness** — **M4CC-E17** added: a single missing doctor
   column mid-flow (at confirmation) fails closed with
   `DOCTOR_CONTROL_SCHEMA_MISSING` before any command execution, with zero
   partial writes (session row byte-identical).

### 6.2 DoctorControlInteractionService boundary audit (item 3)

Audited against the "second Schedule Engine" checklist — findings:

| Concern | Finding |
|---|---|
| Recurring schedule semantics | NOT duplicated — day/window/effective-boundary validation and record building live only in `DoctorScheduleCommandService._buildRecurring`; the interaction layer does input-format parsing only (digits→day keys, `HH:mm-HH:mm` split) |
| Temporal projection | NOT duplicated — impact count calls `EffectiveScheduleService.projectFromSources` / `parseLocalDateTime` / `compareStamps`; no local projection math |
| Cancellation semantics | NOT duplicated — commit delegates to `DoctorScheduleCommandService.cancelChange`; the cancellable list reuses `ScheduleChangeRepository.listByScopeResult` + `EffectiveScheduleService._activeRecords` |
| Settings parsing | NOT duplicated — schedule rendering reads via `DoctorScheduleReadService.readCurrentEffectiveSchedule`; exceptional-open window is resolved inside the command service |
| Booking policy / SlotSelection | NOT duplicated — impact count is a read-only `SlotRepository.queryResult` over RESERVED/CONFIRMED; no selection, reservation, or retry logic |
| Infrastructure access | none (structural test M4CC-E12) |

Remaining coupling: the `EffectiveScheduleService._activeRecords` private
cross-call — genuine reuse (not duplication); promoting it to a public API is
a refactor beyond PR #20 scope → stays recorded as **P2** in §5. No new
abstraction was created in this revision.

### 6.3 Frozen decisions — confirmed unchanged in this revision

Settings duration authority; recurring `T00:00` Asia/Baghdad boundary;
Settings-window exceptional open; `[start,end)` overrides; read-only
count-only preview; `FREE && is_available` atomic reservation guard;
reminder `is_available` gate; appointment/slot lifecycle, cancellation
semantics, RESERVED expiration; no new engine/truth/lock/provider logic.
The frozen contract file was **not** modified; no contract amendment needed.
