# HAMZAWE — M4-C Continuation / Prerequisite Closure
## FROZEN CONTRACT v1

**Date:** 2026-09-01  
**Baseline:** `main` after merged M4-C-v1 / PR #19 (`35a28ccd6708c5d16293b60f6388293982edcd66`)  
**Status:** FROZEN  
**Scope:** Correctness and completion prerequisites for the M4-C Doctor Control capability before Effective Availability Materialization.

---

## 1. Contract purpose

This contract closes the remaining M4-C continuation/prerequisite work required to make the merged M4-C-v1 baseline truthful, deterministic, safe, and usable by downstream stages.

It does **not** declare M4 overall complete and does **not** define the Effective Availability Materialization contract. M4-D (or equivalent next stage determined by architecture governance) remains a separate contract.

> M4-C-v1 is the merged historical baseline. This contract covers only continuation work whose ownership belongs to the Schedule Intent / Doctor Control boundary.

## 2. Authoritative architecture

```text
Doctor Control
    ↓
Schedule Intent / immutable Schedule Change Records
    ↓
EffectiveSchedule
    ↓
[future stage] Availability Materialization
    ↓
Availability.is_available
    ↓
Existing booking / appointment lifecycle
```

M4-C continuation MUST NOT introduce a second schedule engine, availability truth store, booking selector, Slot state machine, or provider-specific business layer.

## 3. Scope

### 3.1 In scope

1. Correct M4-C-v1 slot-duration semantics.
2. Finalize and enforce recurring effective-time semantics.
3. Preserve immutable Schedule Change Records and deterministic EffectiveSchedule behavior.
4. Complete the v1 Doctor Control channel boundary using WhatsApp text/numbered interaction.
5. Add the read-only Preview → Confirm interaction boundary for disruptive schedule commands.
6. Preserve provider neutrality and existing Webhook → ProcessedMessages → Router flow.
7. Close the required stale-read booking/reservation guard for `is_available` so downstream materialization can be truthful under concurrency.
8. Preserve scope as `(doctorId, clinicId)` with `clinicId = null` in v1.

### 3.2 Explicitly out of scope

- Availability materialization/reconciliation itself.
- Future-slot generation based on EffectiveSchedule.
- Automatic appointment cancellation or rescheduling.
- Patient disruption workflow.
- New appointment statuses.
- New Slot status for doctor absence.
- Changing slot duration from Doctor Control.
- Arbitrary per-weekday recurring work windows.
- Partial-day exceptional opening in v1.
- Bus-count-as-input / reverse slot-grid derivation.
- Calendar mutation caused by schedule changes.
- Pricing/billing/analytics.
- Full multi-clinic implementation.
- UltraMsg-specific Domain/Application semantics.
- New TransactionManager for Slot + Calendar.

## 4. Schedule duration semantics

### 4.1 Authority

`SettingsRepository` remains the sole operational source of `slotDurationMinutes`.

Doctor Control MUST NOT accept `slotDurationMinutes` as a schedule mutation input.

Recurring Schedule Change payloads created after this contract MUST NOT define or change slot duration.

### 4.2 Historical M4-C-v1 records

Historical M4-C-v1 records that contain `slotDurationMinutes` are immutable and MUST NOT be rewritten for cleanup purposes.

The field, if present historically, has no operational authority under this contract.

`EffectiveSchedule` used by subsequent stages MUST obtain operational slot duration from the configured Settings source.

### 4.3 Invalid or missing duration

A missing or invalid configured slot duration is a schedule-source/configuration error.

The new M4 path MUST NOT convert that failure silently into the 30-minute default.

`SettingsRepository` may retain its legacy/default API behavior where required by unaffected legacy callers, but any M4 schedule projection path MUST preserve configured-data provenance and fail honestly when the configured duration is not valid.

### 4.4 Granularity

M4 uses the existing slot grid. It does not support fractional slots.

A requested schedule interval is representable only when its intended effect can be applied safely to the existing slot grid.

Unrepresentable partial-slot requests MUST be rejected explicitly; no rounding, splitting, or implicit expansion is allowed.

## 5. Effective-time semantics

### 5.1 Timezone

All Doctor Control schedule timestamps use `Asia/Baghdad` local time.

### 5.2 `createdAt`

`createdAt` records when the schedule intent was durably committed. It does not determine when the intent becomes effective.

### 5.3 Recurring schedule changes

A recurring schedule change is a calendar-day change.

Its operational effective boundary is:

```text
00:00 Asia/Baghdad
of the doctor-selected effective date
```

Exact intra-day recurring activation is not supported in this v1 contract.

### 5.4 Temporary overrides

Temporary overrides retain exact local datetime boundaries and use half-open intervals:

```text
[start, end)
```

`effectiveFrom` is inclusive. `effectiveTo` is exclusive.

### 5.5 Past protection

A newly committed change MUST NOT rewrite operational history before its effective boundary.

For the current day, only future operational instants are relevant to forward application; past slots are never rewritten by a future schedule command.

### 5.6 Projection time

Projection/materialization time is distinct from `createdAt` and `effectiveFrom`.

`EffectiveScheduleService` MUST remain deterministic when supplied the same sources and explicit projection time.

`Clock.now()` MUST NOT silently substitute for an explicit historical/as-of projection instant in the effective schedule calculation.

## 6. Schedule intent and cancellation

### 6.1 Persistence

Schedule Change Records remain append-only and immutable.

`commandId` is the idempotency identity for a logical schedule command within its scope.

### 6.2 CANCEL

CANCEL is itself a Schedule Change Record. It MUST NOT rewrite or delete the target record.

A CANCEL becomes effective only at its own effective boundary.

Before that boundary, projection retains the historical meaning of the target change.

### 6.3 Conflict handling

If applicable schedule intents create an ambiguous result and the contract has not defined precedence, the system MUST fail explicitly with a schedule conflict rather than guess.

## 7. Exceptional opening

M4-v1 supports opening a normally closed date as an exception.

The exceptional opening uses the clinic's regular Settings working window:

```text
Settings.work_start → Settings.work_end
```

The Doctor does not provide an arbitrary window for the exceptional-open command in v1.

Example:

```text
Regular window: 10:00–14:00
Tuesday: normally closed
Exceptional open Tuesday
→ effective intent: open Tuesday 10:00–14:00
```

Partial-day exceptional opening is outside this frozen contract.

## 8. Future bus-count concept

The Doctor MUST NOT specify a desired bus count as a schedule input in M4-v1.

Bus number remains a presentation projection derived from internal slot time.

It is not stored as operational schedule truth and is not used as an input to derive slot generation.

The reverse “bus count → slot grid” concept is explicitly deferred and MUST NOT be introduced implicitly through another command or abstraction.

## 9. Doctor Control channel

### 9.1 Channel

v1 Doctor Control is delivered through the existing WhatsApp text path:

```text
Webhook
  ↓
ProcessedMessages / transport idempotency
  ↓
Router
  ↓
Doctor Control boundary
```

### 9.2 Interaction model

Numbered/text interaction is sufficient for v1.

Interactive buttons are not required and are not part of this contract.

### 9.3 Provider neutrality

Numeric choices are presentation/channel representation only.

The application boundary MUST receive semantic command meanings, not UltraMsg-specific concepts.

A future official WhatsApp button payload MUST be able to map to the same application command without changing Domain/Application semantics.

### 9.4 Router boundary

Router remains routing-only.

Router MUST NOT contain schedule parsing, schedule precedence, schedule validation, or schedule business rules.

## 10. Doctor Control command surface

The exact Arabic wording of menus is presentation/UX and is not frozen here.

The semantic command families supported by this contract are:

```text
- recurring schedule change
- temporary close override
- exceptional open override
- cancel schedule change
```

The numeric mapping may be changed later without changing these semantic commands.

No command in this surface may accept `slotDurationMinutes` or bus count as a schedule input.

## 11. Preview / Commit

### 11.1 Preview

Before a disruptive schedule mutation is committed, Doctor Control MUST provide a read-only preview.

Preview MUST:

- perform no Schedule Change persistence;
- perform no Availability mutation;
- perform no appointment mutation;
- be based on the same schedule semantics that the commit will use;
- show the proposed change and its effective date/range;
- show the current number of affected bookings when the applicable impact read model is available.

Preview MUST NOT require a separate schedule engine.

### 11.2 Preview information level

v1 preview reports the **count** of affected bookings.

It does not expose patient details or a list of bus numbers.

### 11.3 Commit

Commit occurs only after explicit Doctor confirmation.

A successful commit:

1. validates the command against the fresh current schedule source;
2. persists the immutable Schedule Change Record exactly once for the `commandId`;
3. returns the committed record/result.

Availability materialization, when applicable, is a downstream responsibility and is not part of the durable intent write itself.

## 12. Concurrency prerequisite for booking

A booking/reservation operation may select a candidate optimistically, but its final reservation mutation MUST re-read the slot under the existing per-slot `SlotRepository.atomicUpdate` lock and verify:

```text
status == FREE
AND
is_available == true
```

Only then may the slot become `RESERVED`.

The same protection MUST be applied to any existing ChangeService reservation path that can reserve a replacement slot.

This is a correctness prerequisite, not optional hardening.

### 12.1 Race semantics

No global transaction is introduced.

Per-slot atomicity is authoritative:

```text
reconciliation wins first
→ fresh is_available=false
→ reservation fails
```

or:

```text
reservation wins first
→ slot becomes RESERVED/CONFIRMED according to existing lifecycle
→ later reconciliation may set is_available=false
→ appointment becomes eligible for later impact discovery
```

A schedule closure MUST NOT silently cancel or free the appointment.

## 13. Existing slot lifecycle

M4-C continuation MUST NOT change the existing Slot `status` lifecycle.

The StateMachine remains the only authority for Slot status transitions.

Doctor availability is represented separately through `is_available` in downstream materialization.

This contract does not permit introducing statuses such as `DOCTOR_CLOSED`, `DOCTOR_ABSENT`, or `UNAVAILABLE`.

## 14. Reserved and confirmed appointments

A schedule change itself MUST NOT cancel, free, confirm, reserve, or reschedule an affected appointment.

An affected `RESERVED` appointment remains under the existing reservation/expiration lifecycle.

An affected `CONFIRMED` appointment remains confirmed until a later appointment-disruption stage applies an explicitly contracted lifecycle operation.

## 15. Reminder compatibility

Reminder eligibility MUST include the operational availability guard:

```text
CONFIRMED
AND
is_available == true
AND
inside existing reminder window
AND
not already sent
```

No reminder state or reminder repository is introduced by M4.

If a slot is temporarily unavailable and later reopens while still within the existing reminder window and `Reminder_sent` is false, the existing reminder process may send normally.

## 16. Scope and extensibility

All new M4 schedule commands and records carry logical scope:

```text
(doctorId, clinicId)
```

v1 uses:

```text
clinicId = null
```

This does not implement multi-clinic behavior.

APIs and persistence models MUST NOT hard-code an irreversible global singleton where the new boundary can reasonably preserve the future scope key.

## 17. Reuse requirements

M4-C continuation MUST reuse existing boundaries where their semantics match:

- `DoctorAuthorizationService`
- `DoctorControlEntry`
- `DoctorScheduleReadService`
- `SettingsRepository`
- `ScheduleChangeRepository`
- `DoctorScheduleCommandService`
- `EffectiveScheduleService`
- `SlotRepository`
- `SlotSelection`
- `StateMachine`
- `CommandExecutor`
- `Lock`
- `ProcessedMessagesService`
- `Router`
- existing Booking / Change / Cancel services

No parallel implementation of existing schedule projection, selection policy, lifecycle transitions, or transport idempotency is permitted.

A new abstraction is justified only when repository inspection demonstrates a genuine missing boundary that cannot be expressed safely through the existing one.

## 18. Dependency direction

The following boundaries remain mandatory:

```text
Infrastructure
    ↑
Repositories
    ↑
Application
    ↑
Domain / pure helpers
```

Business/application code MUST NOT directly access `SpreadsheetApp`, raw Sheet operations, Calendar infrastructure, or WhatsApp provider APIs.

## 19. Required implementation corrections

The implementation of this frozen contract MUST address all of the following before the stage can be considered complete:

1. Neutralize operational `slotDurationMinutes` authority in M4 recurring commands/projection while preserving historical immutable records.
2. Ensure M4 EffectiveSchedule path uses configured Settings duration and fails honestly on missing/invalid configuration.
3. Enforce recurring effective boundary at local `00:00`.
4. Keep temporary overrides exact and half-open.
5. Preserve append-only intent and temporal CANCEL semantics.
6. Implement/complete provider-neutral Doctor Control numbered interaction.
7. Implement read-only Preview → explicit confirmation → commit flow.
8. Add fresh `is_available=true` verification inside sensitive reservation `atomicUpdate` paths.
9. Preserve Slot status and appointment lifecycle boundaries.
10. Preserve existing transport idempotency and Schedule `commandId` idempotency.

## 20. Acceptance criteria

### Schedule semantics
- recurring change starts at 00:00 of selected local date;
- temporary interval is `[start,end)`;
- `effectiveFrom` is inclusive;
- future changes do not rewrite past operational availability;
- CANCEL does not delete/rewrite historical records;
- ambiguous applicable schedule intent fails explicitly;
- slot duration cannot be changed by Doctor Control;
- bus count cannot be submitted as a schedule input;
- exceptional opening uses the regular Settings working window;
- partial-day exceptional opening is rejected/not supported;
- unrepresentable fractional-slot request is rejected.

### Doctor Control
- unauthorized doctor cannot execute schedule commands;
- numeric interaction maps to semantic application commands;
- Router remains free of schedule business rules;
- preview produces no persistent mutation;
- commit requires explicit confirmation;
- duplicate command delivery does not create duplicate Schedule Change Records.

### Concurrency
- stale optimistic candidate cannot be reserved after `is_available` becomes false;
- reservation still succeeds when the fresh slot is FREE and available;
- closure does not convert RESERVED/CONFIRMED to another lifecycle state;
- reconciliation/booking race follows the per-slot atomic semantics defined above.

### Operational compatibility
- reminder is suppressed when `is_available=false`;
- reminder behavior otherwise follows existing window/idempotency rules;
- existing StateMachine semantics remain unchanged.

### Quality / governance
- `node --check` passes for changed JavaScript files;
- targeted M4 tests pass;
- M4 regression passes;
- full regression is reported honestly, including `HardeningM1B / M1B-X3` if still pre-existing;
- changed/untouched files are verified against scope;
- no direct Application/Domain infrastructure access is introduced;
- Library documentation is updated before merge.

## 21. Completion boundary

When all acceptance criteria pass, M4-C continuation/prerequisite closure is complete.

That completion does **not** imply that Effective Availability Materialization is complete.

The next stage must consume:

```text
immutable Schedule Change Records
        ↓
deterministic EffectiveSchedule
```

and may then own:

```text
EffectiveSchedule
        ↓
future Availability materialization/reconciliation
```

without recreating any schedule semantics.

## 22. Git / review gate

Implementation MUST remain reviewable as a bounded change.

Before PR/merge, record:

- base commit;
- branch;
- commits;
- changed files;
- untouched files relevant to adjacent boundaries;
- targeted tests;
- M4 regression;
- full regression and known baseline failures;
- any intentional contract deviation (none permitted without contract amendment).

No unrelated fix may be bundled merely because it was discovered during implementation.

## 23. Frozen status

**FROZEN — M4-C Continuation / Prerequisite Closure v1**

This contract supersedes conflicting draft guidance for the scope described above.

It does not supersede M4-C-v1 historical records; those remain immutable.

Any change to a frozen semantic rule requires an explicit contract amendment and review before implementation.
