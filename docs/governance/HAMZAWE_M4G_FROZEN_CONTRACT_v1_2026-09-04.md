# HAMZAWE — M4-G FINAL HARDENING / GOVERNANCE v1
## FROZEN STAGE CONTRACT

**Date:** 2026-09-04  
**Repository:** `hamza889951-lang/hamzawe`  
**Production branch:** `main`  
**Verified current `main` at contract drafting:** `b9324a54147f511e6fce09eb86dd41eb72b339ac`  
**Stage:** M4-G — Final Hardening / Audit / Idempotency / Regression / Governance Verification  
**Status:** FROZEN — IMPLEMENTATION AUTHORIZATION REQUIRES SEPARATE SUPERVISOR DECISION  
**Production deployment:** NONE AUTHORIZED

---

# 0. Purpose and Authority

M4-G is the final hardening and governance stage of the Doctor Control / Patient Disruption program.

M4-G exists to prove that the already-established M4-A through M4-F architecture remains correct under repetition, concurrency, stale evidence, partial failure, recovery, malformed/unavailable sources, schema drift, and regression.

M4-G is **Hardening / Controlled Evolution**, not a feature rewrite.

This contract does not reopen or redefine the frozen business semantics of M4-A, M4-B, M4-C, M4-D, M4-E, or M4-F.

Where this contract is silent, the earlier frozen contracts remain authoritative.

Where an implementation finding appears to require changing a frozen semantic rule, implementation MUST STOP and report:

`BLOCKER / EVIDENCE / IMPACT / MINIMAL PROPOSED CONTRACT CHANGE`

No semantic relaxation may be introduced silently.

---

# 1. Inherited Architectural Truth

The authoritative chain is:

```text
Doctor Identity / Authorization
        ↓
Schedule Intent / immutable Schedule Change Records
        ↓
EffectiveSchedule
        ↓
M4-D materialized Availability
        ↓
Slot.is_available
        ↓
SlotSelection
        ↓
Booking / Change / Cancel / StateMachine / Calendar
        ↓
M4-E affected appointment evidence
        ↓
M4-F fresh revalidation + disruption proposal
        ↓
existing lifecycle / B6 / Change / Calendar semantics
        ↓
M4-G hardening / audit / regression / governance
```

M4-G MUST consume these established boundaries.

It MUST NOT recreate any of them.

The following ownership is immutable for M4-G:

- `EffectiveScheduleService` — sole schedule truth.
- `AvailabilityHorizonMaintainer` / existing M4-D materialization path — sole availability materialization/reconciliation owner.
- `Availability.is_available` — operational availability gate.
- `SlotSelection` — sole slot-selection policy.
- `StateMachine` — sole `Slot.status` transition authority.
- `SlotRepository.atomicUpdate()` — sensitive Slot mutation boundary.
- `ConversationRepository` — bounded Conversation persistence.
- `ProcessedMessagesService` / `ProcessedMessagesRepository` — inbound message idempotency.
- `B6LifecycleService` and B6 repositories — B6 lifecycle/recovery ownership.
- `ChangeService` — confirmed-appointment change semantics.
- `BookingService` — ordinary confirmation and reused RESERVED finalization seam.
- `CalendarRepository` / Google Calendar adapter — Calendar boundary.
- `Scheduler` — single orchestration boundary.

---

# 2. M4-G Scope

M4-G owns only the following:

1. Cross-stage contract consistency verification.
2. Idempotency verification.
3. Concurrency / linearization hardening.
4. Failure classification and recovery-convergence verification.
5. Determinism and time-semantics verification.
6. Schema/data-integrity verification.
7. PII/security/observability verification.
8. Architecture/dependency/forbidden-write scans.
9. Full regression and `node --check` verification.
10. Git / diff / review / CI evidence verification.
11. Current-state documentation and durable-memory reconciliation.

A production behavior change is permitted only when it is the **smallest correction of a proven existing contract violation**.

M4-G does not authorize new business semantics.

---

# 3. Explicit Non-Goals

M4-G MUST NOT:

- add a new user-facing business capability;
- change M4-F replacement-selection policy;
- change M4-F confirmation/decline/timeout semantics;
- redesign the schedule model;
- replace `EffectiveSchedule`;
- replace `Availability.is_available`;
- create a second availability store;
- create a second Slot selector;
- create a second Slot state machine;
- create a new Slot status;
- create a new Appointment entity;
- replace B6 with another recovery model;
- create a second Scheduler or trigger;
- create a second WhatsApp/provider gateway;
- move business logic into Router;
- perform mass repository/layout migration;
- reopen TD-05;
- replace the deferred TD-06 time model;
- introduce a generic global transaction manager;
- introduce a generic unbounded journal;
- perform production schema migration;
- deploy to production;
- change production triggers;
- perform live patient/WhatsApp/Sheets execution without separate explicit authorization.

---

# 4. Global Invariants

## G-INV-01 — One truth per concept

There must remain:

- one schedule truth;
- one operational availability gate;
- one Slot lifecycle authority;
- one selection policy;
- one inbound idempotency owner;
- one Scheduler orchestrator;
- one provider boundary.

## G-INV-02 — Freshness at mutation

A decision made from stale evidence MUST NOT become a sensitive mutation.

Where the existing boundary requires a fresh read, the fresh read MUST be inside the relevant mutation/serialization boundary.

## G-INV-03 — Historical preservation

M4-G MUST NOT rewrite historical business records merely to make the current state convenient.

Durable appointment, lifecycle, audit, and schedule-intent history remains historical truth.

## G-INV-04 — Fail closed

Source failure, schema failure, ambiguous state, and persistence uncertainty MUST remain observable failures or explicit recovery states.

They MUST NOT become:

- empty success;
- fabricated healthy state;
- fabricated "no affected appointments";
- `SLOT_NOT_FOUND` when the real problem is source failure.

## G-INV-05 — External I/O is not exactly-once

For external WhatsApp/Calendar boundaries, M4-G verifies business-level idempotency and safe retry semantics.

It MUST NOT claim impossible network-level exactly-once delivery.

## G-INV-06 — No lock across external wait/I/O

No global ScriptLock may be held across WhatsApp I/O or the patient waiting period.

Existing per-resource / per-phone / per-slot lock semantics remain the authority.

---

# 5. Idempotency Contract

M4-G MUST verify all currently existing idempotency boundaries:

## G-07 — Inbound Webhook claim

`ProcessedMessagesService.claim()` remains the critical-path entry before Router.

A duplicate message MUST NOT enter business processing twice.

## G-08 — M4-C command idempotency

A repeated `commandId` MUST NOT create a second effective Schedule Change Record.

It must return the existing committed outcome through the existing replay semantics.

## G-09 — M4-F proposal idempotency

A phone with an active proposal MUST NOT receive a second competing proposal/reservation.

## G-10 — Notification retry

Retry MUST reuse the existing `disruption_proposal_id`.

Retry MUST NOT re-reserve the target.

## G-11 — Scheduler repetition

Repeating the Scheduler MUST converge without duplicate disruption proposals or duplicate schedule/materialization effects.

## G-12 — M4-D repetition

Repeated materialization/reconciliation MUST converge without duplicate future slot starts.

## G-13 — Recovery repetition

Repeating a recovery sweep MUST be safe and convergent.

A previous sweep MUST NOT erase a newer interaction.

---

# 6. Concurrency / Linearization Contract

## G-14 — M4-C schedule commands

Concurrent schedule commands MUST use the established scope serialization and fresh validation semantics.

No incompatible duplicate commit may occur from one stale view.

## G-15 — Booking vs M4-D materialization

The existing per-slot atomic semantics remain authoritative.

Neither side may silently overwrite the other's successful lifecycle/availability decision.

## G-16 — M4-F candidate reservation

Candidate selection is advisory.

Final reservation MUST use fresh `SlotRepository.atomicUpdate()` validation.

## G-17 — M4-F reserve→persist gap

The bounded per-phone serialization/guard MUST prevent an inbound patient response from treating a non-durable proposal as authoritative.

A candidate reserved for a proposal that cannot be durably persisted MUST be safely cleaned up or escalated explicitly.

## G-18 — M4-F recovery sweep

A stale recovery sweep MUST NOT clear or overwrite a newer proposal interaction.

## G-19 — Cleanup ownership

Decline/timeout cleanup MUST release only a proposal target that is still owned by that proposal.

A foreign or otherwise changed slot MUST remain untouched.

## G-20 — No global booking freeze

M4-G MUST preserve local concurrency boundaries instead of introducing global serialization merely to simplify reasoning.

---

# 7. Failure and Recovery Contract

The implementation MUST preserve explicit distinctions among:

- source read failure;
- schema failure;
- invalid request;
- stale original;
- stale candidate;
- conflicting proposal/action;
- proposal persistence failure;
- proposal cleanup failure;
- notification failure;
- recovery-required state;
- Calendar partial failure;
- B6 recovery-required state;
- ambiguous checkpoint/release evidence;
- Scheduler stage failure.

## G-21 — No false success

Any state where success cannot be proven MUST NOT be reported as normal success.

## G-22 — Proposal persistence failure

If candidate reservation succeeds but proposal persistence fails:

```text
reserved candidate
    ↓
attempt ownership-checked cleanup
    ↓
clean OR explicit recovery-required outcome
```

No notification may be sent.

## G-23 — Notification failure

If the proposal is durably persisted and notification fails:

- proposal remains durable;
- target reservation remains owned;
- notification state remains retryable;
- retry reuses the same proposal identity.

## G-24 — Interrupted RESERVED finalization

If target becomes `CONFIRMED` while original `RESERVED` release remains unresolved:

- recovery evidence MUST remain durable;
- decline/timeout MUST NOT erase that evidence;
- later recovery MUST be able to identify and converge the state.

## G-25 — Recovery convergence

Every interrupted operation must converge to one of:

```text
SUCCESS / TERMINAL
SAFE CLEANUP / TERMINAL
EXPLICIT RECOVERY REQUIRED
EXPLICIT RETRYABLE FAILURE
```

No silent limbo state is acceptable.

---

# 8. Determinism and Time Contract

## G-26 — Clock authority

Current-time reads MUST use `Clock.now()`.

No unauthorized `new Date()` current-time read and no `Date.now()` shortcut may be introduced.

## G-27 — Project timezone

Project timezone remains:

`Asia/Baghdad`

## G-28 — M4-C time semantics

Recurring changes remain local calendar-date based as frozen by M4-C.

Temporary intervals remain explicit half-open intervals.

Past schedule/availability MUST NOT be rewritten merely because a future change exists.

## G-29 — M4-D time semantics

Materialization continues to use the established current-instant/lower-bound semantics and configured Settings slot duration.

No unauthorized lead-time substitution may alter materialization semantics.

## G-30 — M4-E discovery window

Discovery remains explicit and deterministic.

Its affectedness basis remains materialized `Availability.is_available`.

## G-31 — M4-F expiry

A disruption proposal expires exactly 30 minutes from its durable creation timestamp under the frozen M4-F semantics.

## G-32 — Deterministic ordering

Where ordering is contractually deterministic, repeated equal inputs MUST produce the same result.

No hidden dependence on enumeration order may change business outcomes.

## G-33 — Legacy time model

`sort_key → LegacySlotTimeParser` remains the canonical interpretation under deferred TD-06.

M4-G MUST NOT introduce a second time representation merely for convenience.

---

# 9. Data and Schema Contract

## G-34 — M4-F bounded schema

The seven M4-F disruption fields remain exactly:

- `disruption_original_slot_id`
- `disruption_proposal_slot_id`
- `disruption_kind`
- `disruption_created_at_ms`
- `disruption_expires_at_ms`
- `disruption_proposal_id`
- `disruption_notification_status`

## G-35 — Notification vocabulary

`disruption_notification_status` remains bounded to:

`PENDING | SENT | FAILED`

## G-36 — No unbounded storage

M4-G MUST NOT introduce:

- JSON blobs;
- arbitrary metadata maps;
- transcripts;
- unbounded message history;
- patient name/phone fields inside the M4-F proposal schema;
- raw provider identifiers in the bounded proposal model.

## G-37 — Fail-closed schema

Missing required columns MUST fail closed.

No automatic production schema migration is permitted.

## G-38 — Existing data preservation

Hardening MUST preserve unrelated Conversation and Availability fields.

No schema cleanup may destroy historical data merely to satisfy formatting preferences.

---

# 10. Security, PII, and Observability

## G-39 — PII boundary

M4-E evidence remains PII-free.

M4-F durable proposal state remains bounded and PII-free.

## G-40 — Secrets

Secrets, tokens, and credentials MUST NOT be copied into business records or diagnostic logs.

## G-41 — Logs are diagnostic only

`LogRepository` remains a write-only diagnostic path.

Business decisions MUST NOT depend on reconstructing state from `SYSTEM_LOG`.

## G-42 — Provider isolation

Domain/Application MUST NOT contain provider-specific transport logic.

WhatsApp/Calendar calls remain behind their existing boundaries or injected neutral callbacks where already contractually established.

---

# 11. Scheduler Contract

The single Scheduler remains:

```text
Archive
  →
Maintenance
  →
Horizon
  →
Patient Disruption
  →
Reminders
  →
HealthCheck
```

## G-43 — One orchestrator

No second scheduler, trigger, timer, or background orchestrator is introduced.

## G-44 — Stage failure visibility

A failed stage MUST be reported as failed.

It MUST NOT be silently converted into success.

## G-45 — Best-effort progression

Later stages continue only according to the existing Scheduler best-effort semantics.

M4-G MUST NOT redefine those semantics.

## G-46 — Liveness

Liveness state MUST be updated only when the existing successful operational criteria are met.

A failed operational run MUST NOT silently advance liveness.

---

# 12. Architecture and Dependency Contract

## G-47 — Layering

No Domain/Application file may directly call:

- `SpreadsheetApp`
- `CalendarApp`
- `UrlFetchApp`

## G-48 — Owned infrastructure knowledge

`PropertiesService`, `LockService`, Google Sheets, Google Calendar, and WhatsApp provider knowledge must remain within their established owners.

## G-49 — Router

Router remains routing-only.

It MUST NOT gain:

- proposal-expiry logic;
- slot mutation;
- Calendar mutation;
- WhatsApp send logic;
- B6 mutation;
- schedule calculation.

## G-50 — No duplicate business boundary

M4-G MUST NOT introduce an alternate implementation of:

- schedule calculation;
- materialization;
- slot selection;
- lifecycle transitions;
- patient disruption orchestration;
- B6 recovery;
- message idempotency;
- scheduler orchestration.

---

# 13. Cross-Stage Acceptance Matrix

## Architecture / ownership

**G-01** Current `main` baseline and ancestry are verified from GitHub.  
**G-02** No new truth/store/selector/lifecycle/scheduler/gateway is introduced.  
**G-03** Existing M4 boundaries delegate to their established owners.  
**G-04** Forbidden Application/Domain infrastructure dependencies are absent.  
**G-05** `StateMachine` remains sole Slot-status authority.  
**G-06** `SlotSelection` remains sole selection policy.

## Time / determinism

**G-07** CAS-009 structural audit passes.  
**G-08** Deterministic inputs produce deterministic outputs where required.  
**G-09** Timezone/local-date boundaries are tested.  
**G-10** M4-F 30-minute expiry is preserved.

## M4-C

**G-11** Repeated `commandId` is idempotent.  
**G-12** Cancellation/correction remains append-only.  
**G-13** Concurrent schedule mutations cannot commit incompatible stale decisions.  
**G-14** Source failure is never converted into empty/fabricated success.

## M4-D

**G-15** Repeated materialization converges without duplicate starts.  
**G-16** Terminal slots remain untouched.  
**G-17** Patient/lifecycle/calendar fields remain preserved.  
**G-18** Existing-row reconciliation mutates only `is_available` where contract permits.  
**G-19** Booking/materialization races remain per-slot atomic.  
**G-20** Partial failures remain observable and retryable.

## M4-E

**G-21** Affectedness is based on materialized `is_available` within the contract window.  
**G-22** Discovery remains read-only.  
**G-23** Discovery does not become a schedule-intent engine.  
**G-24** DTO shape/order remain deterministic and PII-free.  
**G-25** Availability source failure is fail-closed.

## M4-F proposal lifecycle

**G-26** Stale M4-E evidence cannot authorize final mutation.  
**G-27** At most one active proposal exists per phone.  
**G-28** At most one owned proposal reservation exists for that proposal.  
**G-29** Proposal persistence failure cannot send notification.  
**G-30** Cleanup failure is explicit recovery evidence.  
**G-31** Notification retry keeps proposal identity.  
**G-32** PENDING/uncertain bookkeeping cannot create a second proposal.  
**G-33** Expired proposals cannot be confirmed.  
**G-34** Same-run expiry cannot immediately create an equivalent replacement interaction.  
**G-35** A later independent proposal receives a new identity.

## M4-F finalization / recovery

**G-36** CONFIRMED finalization delegates to existing ChangeService semantics.  
**G-37** RESERVED finalization delegates to existing BookingService semantics.  
**G-38** Target confirmation is secured before original RESERVED release.  
**G-39** One patient cannot end with two active appointments caused solely by M4-F.  
**G-40** Decline/timeout release only owned targets.  
**G-41** Decline/timeout cannot erase recovery evidence after target confirmation.  
**G-42** Recovery cannot erase a newer interaction.  
**G-43** Recovery is repeat-safe and convergent.  
**G-44** Calendar/B6 partial failures preserve required recovery evidence.

## Scheduler

**G-45** Single Scheduler stage order is verified.  
**G-46** Stage failures remain explicit.  
**G-47** Best-effort continuation semantics remain unchanged.  
**G-48** Liveness behavior remains correct.  
**G-49** No trigger creation/mutation is introduced.

## Data / security / observability

**G-50** Exact M4-F bounded schema is verified against code/tests and authorized owner schema evidence.  
**G-51** No automatic production migration exists.  
**G-52** Logs remain diagnostics-only.  
**G-53** No prohibited PII/provider identifiers leak into bounded business state.  
**G-54** Secrets/tokens are not written to logs/business records.

## Quality / regression / governance

**G-55** Every changed JS file passes `node --check`.  
**G-56** Every Hardening suite is executed from the current tree.  
**G-57** Full regression is reported honestly; only documented baseline exceptions may remain without being treated as new regressions.  
**G-58** Forbidden dependency/read/write scans pass.  
**G-59** Diff is bounded to the authorized scope.  
**G-60** Git history, ancestry, and exact head are verified.  
**G-61** CI is reported only when actual CI evidence exists.  
**G-62** Production deployment remains a separate authorization gate.  
**G-63** Final M4-G evidence and decision record is stored durably in Library before stage closure.

---

# 14. Testing Contract

M4-G verification MUST include, as applicable:

- happy path;
- boundary values;
- empty/zero state;
- malformed source;
- source read failure;
- stale evidence;
- race/interleaving;
- retry;
- duplicate delivery;
- repeated convergence;
- pre-existing data preservation;
- out-of-scope state preservation;
- architecture/dependency constraints.

Failure injections MUST occur at the closest real controllable layer required to prove the contract.

A test that bypasses the actual failure boundary is not sufficient evidence for that failure contract.

The acceptance report MUST distinguish:

1. official acceptance criteria;
2. supplementary hardening tests;
3. regression suites.

A single aggregate number MUST NOT obscure these categories.

---

# 15. Git / Review / Evidence Contract

Before any stage approval:

1. Verify exact base/head SHA.
2. Verify ancestry.
3. Verify PR state if applicable.
4. Verify changed-file list.
5. Inspect diff.
6. Verify reviews and review-head alignment.
7. Verify workflow/CI evidence where present.
8. Distinguish local execution evidence from GitHub evidence.
9. Verify no unauthorized file changes.
10. Record contract deviations explicitly.

If the reviewed head moves after approval, the approval is not automatically valid for the new head.

No implementation claim may be accepted solely from Programmer self-report when direct repository evidence is available.

---

# 16. Documentation / Durable Memory Contract

M4-G MUST reconcile current-state governance documentation so a future Supervisor can reconstruct reality.

At minimum, verify/update where required:

- `PROJECT_CONTEXT.md`;
- `PROJECT_CONSTITUTION.txt`;
- M4-D acceptance mapping;
- M4-E current-state references;
- M4-F current-state references;
- M4-F schema description;
- Scheduler stage ordering;
- M4-G final acceptance mapping;
- M4-G post-merge reality record.

Historical evidence MUST remain historically identifiable.

A dated current-state correction may be appended rather than rewriting an immutable historical decision record.

The final M4-G decision record MUST be stored in Library.

---

# 17. Known Baseline Exceptions / Deferred Items

## 17.1 M1B-X3

`HardeningM1B / M1B-X3` remains a documented pre-existing baseline exception until independently resolved.

Therefore full regression MUST be reported honestly as:

`PASS except pre-existing HardeningM1B / M1B-X3`

unless later evidence proves that the baseline changed.

It MUST NOT be relabeled as an M4-G defect merely because it remains present.

## 17.2 TD-05

Repository layout debt remains closed/non-blocking.

M4-G MUST NOT reopen it through mass file moves.

## 17.3 TD-06

Legacy `sort_key → LegacySlotTimeParser` remains intentionally deferred.

M4-G MUST verify consistency rather than redesigning it.

---

# 18. Contract Deviation Policy

The following are NOT implementation-level deviations and may be fixed within M4-G only when proven necessary to satisfy this frozen contract:

- small test-harness corrections that do not change business semantics;
- documentation/status reconciliation;
- narrow hardening of an already-owned boundary;
- smallest production-code correction required to restore an already-frozen invariant.

The following ARE semantic deviations and require a contract amendment before implementation:

- changing business outcomes;
- changing lifecycle semantics;
- changing candidate-selection rules;
- changing schedule semantics;
- changing proposal expiry;
- introducing new source-of-truth rules;
- changing ownership boundaries;
- relaxing fail-closed behavior;
- creating a new parallel runtime authority.

---

# 19. Production Gate Separation

M4-G completion is NOT production authorization.

After M4-G code/review closure, a separate production gate MUST independently address, as applicable:

- exact deployment commit;
- deployment identity/version;
- required Script Properties without exposing secrets;
- exact production `Conversations` schema;
- trigger topology;
- live Sheets smoke testing;
- live WhatsApp testing;
- rollback/containment readiness;
- migration impact.

No M4-G test result may be presented as proof that production has been deployed.

No production mutation may be bundled into M4-G implementation without separate explicit authorization.

---

# 20. Stage Completion Criteria

M4-G is COMPLETE only when all of the following hold:

1. G-01..G-63 are either proven or explicitly marked not-applicable with evidence.
2. No P0 contract/architecture/lifecycle/race defect remains.
3. No unexplained new regression exists.
4. Known baseline exceptions are explicitly separated from new failures.
5. `node --check` is verified for every changed JS file.
6. Full Hardening regression is executed from the current tree.
7. Forbidden dependency/read/write scans are clean.
8. Git/diff/review state is verified.
9. Documentation and acceptance mapping are reconciled.
10. The final M4-G reality/decision artifact is stored in Library.
11. Production deployment remains separately unauthorized unless a later explicit production decision is made.

---

# 21. Supervisor Decision Boundary

This contract freezes the semantics and verification target.

It does **NOT** by itself authorize the Programmer to modify code.

Implementation authorization is a separate Supervisor decision that MUST specify:

- exact baseline SHA;
- exact implementation branch/base requirement;
- exact authorized file scope;
- required acceptance mapping;
- required verification commands;
- explicit no-deploy/no-production-execution rule.

---

# 22. Frozen Status

**M4-G FINAL HARDENING / GOVERNANCE v1 — FROZEN**

This contract governs the M4-G implementation stage and supersedes conflicting M4-G drafts.

It does not supersede the historical M4-A through M4-F contracts.

Any change to a frozen M4-G semantic rule requires an explicit reviewed contract amendment.

---

## 23. Evidence References

Primary governing records:

- `M4_DOCTOR_CONTROL_v1.md`
- `HAMZAWE_M4G_DISCOVERY_2026-09-04.md`
- M4-C frozen contract and continuation contract
- M4-D frozen contract / acceptance mapping
- M4-E implementation/reality records
- `HAMZAWE_M4F_FROZEN_CONTRACT_v1_2026-09-03.md`
- `HAMZAWE_M4F_CONTRACT_CLOSURE_ADDENDUM_v1.1_2026-09-03.md`
- `HAMZAWE_POST_M4F_INDEPENDENT_VERIFICATION_2026-09-04.md`
- current GitHub `main` evidence

---

**Governance state:**

`M4-A..F = IMPLEMENTED / MERGED`

`M4-G = FROZEN CONTRACT`

`M4-G implementation = NOT AUTHORIZED BY CONTRACT ALONE`

`Production deployment = NONE AUTHORIZED`
