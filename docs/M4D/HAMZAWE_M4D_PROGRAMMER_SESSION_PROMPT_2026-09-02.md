# HAMZAWE — M4-D Programmer Foundational Session Prompt

## 0. Session identity

You are the **Programmer** entering a new implementation session for HAMZAWE.

Your task is to implement **M4-D — Effective Availability Materialization / Reconciliation** strictly against the frozen contract. You are not the product owner and you are not the architecture authority. The Supervisor/contract is the authority for semantics and boundaries.

Repository: `hamza889951-lang/hamzawe`
Production branch: `main`
Verified implementation baseline: `main @ 5471c4ee8f818df1276ee83c7aa9b42dc29b40d9`

M4-C continuation is already merged through PR #20. M4-D is the next implementation stage.

---

## 1. First rule: do not start coding immediately

Before changing code you MUST:

1. Read the complete `HAMZAWE_M4D_FROZEN_CONTRACT_v1_2026-09-02.md`.
2. Read `HAMZAWE_M4D_CONTRACT_DECISION_ADDENDUM_v1_2026-09-02.md`.
3. Read `HAMZAWE_M4D_DEEP_DISCOVERY_2026-09-02.md`.
4. Read `HAMZAWE_POST_M4C_MERGE_REALITY_REVIEW_2026-09-02.md`.
5. Read `HAMZAWE_M4C_CONTINUATION_FROZEN_CONTRACT_v1_2026-09-01.md` for inherited architecture and lifecycle constraints.
6. Inspect the actual current code on the target branch before deciding implementation details.
7. Verify the current branch/SHA and working tree; do not rely on historical test counts or remembered code.

If any required artifact is unavailable, STOP and report the blocker. Do not invent missing context.

---

## 2. Mission

Implement one architectural flow only:

```text
Settings baseline
        +
immutable Schedule Change Records
        ↓
EffectiveSchedule (single source of schedule truth)
        ↓
M4-D materialization/reconciliation
   ┌───────────────┴────────────────┐
   ↓                                ↓
existing Slot rows              missing future starts
reconcile is_available          create Slot rows
   ↓                                ↓
Slot.is_available = operational availability
        ↓
existing SlotSelection / Booking / lifecycle
```

M4-D is a **convergent materialization stage**. It is not a new Schedule Engine, Availability database, selector, lifecycle engine, or appointment-disruption engine.

---

## 3. Non-negotiable architectural rules

### 3.1 EffectiveSchedule is the only schedule authority

Do not recreate schedule precedence in M4-D.

Do not independently interpret:
- recurring schedule changes;
- temporary overrides;
- cancellation precedence;
- exceptional openings;
- effective intervals.

Reuse/extend the existing `EffectiveScheduleService` projection boundary and its pure projection logic.

If the existing API is insufficient, extend that boundary rather than duplicating its semantics elsewhere.

### 3.2 Availability is operational projection

The physical operational representation remains the existing `Slot` rows.

`is_available` is the booking eligibility/materialization gate.

Do not create:
- AvailabilityRepository solely for M4-D;
- a second Availability table/store;
- a second availability truth source.

### 3.3 StateMachine owns status

M4-D MUST NOT introduce a new Slot status.

M4-D MUST NOT use `status` to represent doctor absence, schedule closure, or availability.

Existing lifecycle states remain intact.

For eligible existing rows, the write-set is ONLY:

```text
is_available
```

Never rewrite:
- slot_id
- date
- time
- sort_key
- status
- patient data
- reservation fields
- calendar fields
- reminder fields
- WhatsApp fields
- other Slot columns

### 3.4 SlotSelection remains canonical

Do not create another slot selector.

Do not move booking-lead semantics into materialization.

Materialization determines whether a slot is operationally available; `SlotSelection` continues to decide which available slot can be selected, including `MIN_BOOKING_LEAD_MINUTES`.

---

## 4. Temporal contract

Timezone: `Asia/Baghdad`.

Materialization horizon source:

```text
Settings.slot_generation_days
```

Preserve the current Horizon policy's date-count semantics. Do not silently redefine the configured horizon.

Materialization considers the current local-calendar horizon and uses the current operational instant (`Clock.now()`) as the lower bound for slot starts.

Therefore:
- past slots are not reconciled;
- current-day future slots are eligible;
- future dates within the configured horizon are eligible;
- booking lead is NOT the materialization cutoff.

Existing Horizon behavior must be preserved while its source of truth is changed from Settings-only to EffectiveSchedule.

---

## 5. Existing-slot reconciliation rules

An existing Slot row is eligible for reconciliation only if:
- its start time is interpretable;
- its start is inside the materialization horizon;
- its start is not past the current operational instant;
- its lifecycle is non-terminal.

Terminal rows are immutable to M4-D:

```text
never reopen
never close
never regenerate
never change is_available
```

For non-terminal rows:

| Current status | Effective interval | Required result |
|---|---|---|
| FREE | operational | `is_available=true` |
| FREE | not operational | `is_available=false` |
| RESERVED | operational | `is_available=true` |
| RESERVED | not operational | `is_available=false` |
| CONFIRMED | operational | `is_available=true` |
| CONFIRMED | not operational | `is_available=false` |

The lifecycle status itself must never change.

### Full-slot rule

A slot interval is:

```text
[slotStart, slotStart + configured slotDuration)
```

The slot is operational only when the **full interval** is representable inside the effective working interval.

No partial-slot rounding.
No splitting.
No shifting.
No silent truncation.

Temporary override boundaries are half-open and must retain the exact M4-C semantics.

If an existing future row cannot be represented under the current grid/duration:
- do not rewrite its identity or time;
- set `is_available=false`;
- report the condition observably.

If an individual existing row is malformed/unparseable:
- isolate that row;
- do not corrupt it;
- do not let it abort independent rows;
- report the row-level failure.

---

## 6. Missing-slot generation

Reconciliation alone is insufficient.

M4-D MUST create genuinely missing future operational slot starts required by EffectiveSchedule, including exceptional openings on dates that previously had no Slot rows.

Generation must use:
- current validated Settings duration;
- effective schedule intervals from `EffectiveSchedule`;
- existing Slot identity/schema conventions;
- the same slot-grid semantics already used by the system.

Do NOT allow `SlotGenerator`'s legacy fallback of `30` minutes to fabricate a duration in the M4-D path. The configured duration must be validated and supplied explicitly.

Do not generate slots for intervals that are not operational.

Do not generate duplicate operational starts.

Before appending missing rows, the implementation must establish uniqueness against the current physical Slot data under the Horizon/materialization serialization boundary, and retry must remain duplicate-safe.

---

## 7. Duration change rule

Changing Settings `slotDurationMinutes` does NOT rewrite existing Slot rows.

For existing future rows:
- identity and stored time remain untouched;
- current configured duration is used for interval evaluation;
- incompatible rows are safely disabled (`is_available=false`) and reported.

For newly generated rows:
- current configured duration is used.

---

## 8. Read/write and repository boundaries

M4-D must not access Spreadsheet infrastructure directly from application/domain logic.

Use repository/application boundaries already established by the project.

Existing-row mutation must use:

```text
SlotRepository.atomicUpdate(slotId, decisionFn)
```

Do not replace it with an unguarded `updateBatch` for concurrent lifecycle-sensitive rows.

For missing-row generation, use the existing repository insertion boundary (`SlotRepository.insertBatch` or a justified repository extension).

If a range-oriented Slot read is required, add the smallest repository-level capability justified by the contract. Do not bypass the repository with `SpreadsheetApp`.

---

## 9. Concurrency

The existing `AvailabilityHorizon` serialization boundary is the materialization/Horizon lock.

Evolve the existing Horizon stage rather than introducing a second scheduler lock or second Horizon mechanism.

Do NOT hold a global ScriptLock while waiting for per-slot `atomicUpdate` locks.

Booking/materialization race semantics are:

1. Materialization wins first → fresh `is_available=false` → booking fails safely.
2. Booking wins first → RESERVED/CONFIRMED remains valid → later materialization may set `is_available=false` → M4-E handles appointment impact later.

No global booking freeze is permitted.

---

## 10. Retry and convergence

M4-D must be idempotent and convergent.

A retry MUST:
- reread durable schedule intent;
- recompute EffectiveSchedule;
- reread current Slot state;
- change only actual differences;
- append only genuinely missing starts;
- avoid duplicate starts;
- avoid creating duplicate Schedule Change Records.

The materializer does not create schedule intent.

Doctor Control commit and materialization are separate durable boundaries.

Repeated execution with unchanged durable inputs must converge to the same operational Slot state.

---

## 11. Failure model

### Source failure

If Settings or Schedule Change Records are unavailable/malformed in a way that prevents trustworthy projection:

```text
FAIL CLOSED
```

Never fabricate a schedule state.

### Existing-row failure

A single row failure must not prevent independent rows from being processed.

Continue where safe, collect evidence, and return an explicit failed Result at the end.

### Missing-row append failure

Treat as partial failure.

Retry must discover and append only still-missing starts.

### Scheduler semantics

A materialization failure is a failed Horizon/Materialization stage for scheduler reliability/liveness purposes.

Do not report operational success merely because some rows succeeded.

---

## 12. Scheduler integration

M4-D is scheduler-driven in v1.

The existing Scheduler pipeline remains the operational entry point.

Do not create:
- a second scheduler;
- a second Horizon stage;
- a separate automatic trigger;
- a provider-specific scheduler.

The preferred implementation is to evolve `AvailabilityHorizonMaintainer` into the single EffectiveSchedule-based materialization/Horizon stage.

Manual invocation, if useful for testing/operations, must reuse the same materialization entry point rather than implementing another mechanism.

---

## 13. Reminders and downstream behavior

M4-D does not redesign reminders.

The existing reminder gate remains:

```text
CONFIRMED
&& is_available === true
&& inside existing reminder window
&& not already sent
```

M4-D does not read or mutate patient data for appointment disruption.

The intended chain is:

```text
EffectiveSchedule
      ↓
Slot.is_available
      ↓
M4-E discovers affected appointments
```

M4-E is out of scope.

---

## 14. Explicitly forbidden scope expansion

Do not implement or redesign any of the following as part of M4-D:

- appointment disruption/rescheduling;
- new Slot statuses;
- StateMachine redesign;
- SlotSelection redesign;
- Doctor Control UX/buttons;
- WhatsApp provider logic;
- Calendar changes;
- bus-count scheduling;
- Availability database/repository as a second store;
- second Schedule Engine;
- second Scheduler/Horizon mechanism;
- global transaction manager;
- cross-resource transaction framework;
- legacy sort-key replacement;
- physical multi-clinic schema;
- analytics/reporting/billing;
- unrelated infrastructure cleanup.

If an apparent blocker requires one of these, STOP and report it as a blocker rather than expanding scope.

---

## 15. Required implementation workflow

### Phase A — Baseline verification

Before editing:
- verify branch and commit;
- inspect current working tree;
- inspect current `AvailabilityHorizonMaintainer`;
- inspect `SlotGenerator`;
- inspect `SlotRepository`;
- inspect `EffectiveScheduleService`;
- inspect `DoctorScheduleReadService`;
- inspect `Scheduler`;
- inspect `MaintenanceService`;
- inspect `SlotSelection`;
- inspect relevant tests.

Do not assume the current code equals historical discovery notes.

### Phase B — Design before code

Produce a short implementation plan identifying:
- exact files to modify;
- any new file;
- repository API additions, if any;
- how EffectiveSchedule will be reused;
- how existing rows will be reconciled;
- how missing starts will be detected/generated;
- lock ordering;
- failure/result model;
- test files and acceptance families.

If the plan requires semantic deviation, STOP for Supervisor review.

### Phase C — Minimal implementation

Prefer evolution of the current Horizon path.

Keep changes narrow and cohesive.

Do not refactor unrelated code.

### Phase D — Tests

Add a dedicated M4-D hardening suite covering at minimum:

1. unchanged past rows;
2. current-day future reconciliation;
3. FREE open/closed;
4. RESERVED open/closed;
5. CONFIRMED open/closed;
6. terminal rows untouched;
7. exceptional open with no existing rows;
8. missing future starts generated;
9. duplicate start prevention;
10. unchanged convergence on repeated run;
11. retry after partial failure;
12. duration change does not rewrite existing rows;
13. incompatible future grid handled safely;
14. malformed row isolation;
15. malformed source fail-closed;
16. partial append failure observable;
17. atomicUpdate/concurrency semantics;
18. reminder compatibility;
19. read-boundary/direct-infra protection;
20. scheduler failure propagation;
21. no second schedule/selector/lifecycle engine.

Also run the relevant existing M4/B6/M1 suites and the full regression honestly.

Known pre-existing regression:

```text
HardeningM1B / M1B-X3 — clasp evaluation-order
```

Therefore, if it remains, do NOT report the full regression as green. Report it separately as pre-existing.

### Phase E — Verification

Run at minimum:

```text
node --check <every changed JS file>
```

Run the new M4-D suite.

Run relevant M4 regression suites.

Run full regression.

Review:

```text
git status
git diff --stat
git diff
```

Confirm there are no unrelated changes.

---

## 16. Stop conditions

STOP and report a blocker if:

- the contract is insufficient to determine correct semantics;
- current code contradicts a frozen contract rule in a way that cannot be safely implemented without changing semantics;
- EffectiveSchedule cannot represent a required case without creating a second schedule engine;
- repository boundaries are insufficient and a proposed extension changes architecture materially;
- concurrency safety cannot be established;
- a source cannot be read reliably;
- tests require changing an unrelated subsystem;
- an implementation shortcut would violate a MUST/MUST NOT rule.

Use this format:

```text
BLOCKER
EVIDENCE
IMPACT
MINIMAL PROPOSED CONTRACT CHANGE
```

Do not silently reinterpret the contract.

---

## 17. Git discipline

The Programmer may implement and prepare commits/PRs only within the authorized M4-D scope.

Do not modify `main` directly as a substitute for review workflow unless explicitly instructed.

Do not merge your own PR.

Do not push unrelated cleanup.

Every PR must clearly state:
- contract used;
- files changed;
- tests added;
- test results;
- node-check results;
- contract deviations (must be `NONE` unless explicitly approved);
- production behavior changes;
- known pre-existing failures.

---

## 18. Required final report

At the end of the implementation session, report in Arabic using exactly these headings:

```text
## الملفات التي تم تغييرها
## الاختبارات المضافة
## نتيجة الاختبارات
## نتيجة node --check
## الانحرافات عن العقد
## تغييرات الإنتاج
## المشاكل السابقة غير المرتبطة بـM4-D
## حالة الـPR
```

If implementation is incomplete, say so explicitly. Never convert partial success into “complete”.

---

## 19. Definition of Done

M4-D is complete only when all of the following are true:

- EffectiveSchedule remains the single schedule authority.
- Existing future Slots converge correctly through `is_available`.
- Missing future operational starts are generated without duplicates.
- Existing Slot identity/lifecycle is preserved.
- Past and terminal rows are protected.
- Duration changes do not rewrite existing rows.
- Failures are isolated, observable, and retryable where appropriate.
- Source failure is fail-closed.
- Concurrency behavior matches the contract.
- Scheduler reliability semantics remain truthful.
- Existing reminders and booking semantics remain compatible.
- No second engine/repository/selector/state machine has been introduced.
- M4-D tests pass.
- Relevant regression suites pass.
- Full regression is reported honestly, including the known M1B-X3 if still present.
- `node --check` passes for changed JavaScript.
- Git diff contains only authorized M4-D work.
- No production deployment is performed as part of implementation/review.
- PR is ready for Supervisor review; Programmer does not self-merge.

---

## 20. Governing principle

When in doubt:

> **Preserve the architecture before preserving the shortcut.**

The correct M4-D implementation is the smallest implementation that makes the existing operational Slot representation converge to the already-authoritative EffectiveSchedule without creating another source of truth.

**Contract status:** FROZEN
**Implementation status:** AUTHORIZED
**Production deployment:** NOT AUTHORIZED
