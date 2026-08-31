# HAMZAWE — M4-C Schedule Intent Management v1
## FROZEN STAGE CONTRACT

### 1. Purpose
M4-C owns durable doctor schedule intent management. It allows the authorized doctor to create future recurring schedule changes and date/time-bounded temporary exceptions while preserving the existing recurring Settings baseline.

M4-C produces a deterministic EffectiveSchedule projection. Availability materialization/reconciliation belongs to M4-D.

### 2. Architectural position
M4-A → Doctor Identity / Authorization
M4-B → Current Schedule Read
M4-C → Schedule Intent Management
M4-D → Effective Availability Materialization / Reconciliation
M4-E → Affected Appointment Discovery / Impact Preview
M4-F → Hybrid Patient Disruption / Rescheduling
M4-G → Final Hardening / Audit / Idempotency / Regression

### 3. Source of truth
- Existing Settings remain the recurring baseline.
- Settings are not converted into a historical event log.
- Durable schedule changes are stored separately as immutable Schedule Change Records.
- Availability.is_available is not a schedule history store.

### 4. Schedule Change Record
A committed record must contain, at minimum:
- changeId
- scope: doctorId and clinicId boundary (clinicId may be null in v1)
- actorId
- commandId / idempotency key
- change kind
- effectiveFrom
- optional effectiveTo for bounded overrides
- relevant schedule payload
- createdAt
- explicit lifecycle/result metadata required for audit

Historical records are not silently rewritten. Corrections/cancellations are explicit operations referencing the relevant changeId.

### 5. Recurring schedule changes
A recurring change applies from its doctor-selected effective local Asia/Baghdad date/time boundary forward.

A later recurring change supersedes the prior recurring baseline for the same scope from its effectiveFrom onward.

M4-C does not rewrite historical materialized availability before the effective boundary.

### 6. Temporary/date-specific overrides
Temporary overrides are separate from recurring baseline changes.
They may:
- close a normally working date/time interval;
- open an exceptional date/time interval;
- define an explicit bounded effective interval.

They do not modify the recurring baseline.

Time-window support is allowed where the existing slot granularity can represent it safely.

### 7. EffectiveSchedule projection
EffectiveSchedule is deterministic and read-only.

For a requested scope/date/time it combines:
1. current recurring Settings baseline,
2. applicable committed recurring changes,
3. applicable temporary/date-specific overrides.

It returns the resulting schedule intent without mutating storage.

The same calculation boundary must be reusable by future availability generation and M4-D reconciliation.

### 8. Conflict handling
M4-C must not invent an undocumented global priority system.

If applicable changes are incompatible and their relationship is not explicitly defined by the contract, reject the command with an explicit conflict result.

### 9. Commands
Schedule mutations are Application commands. They must:
- receive an authorized doctor control context from M4-A;
- validate input against a fresh read of current applicable schedule intent;
- use existing lock/command infrastructure where appropriate;
- persist exactly the intended schedule change;
- be idempotent under repeated transport delivery;
- return an explicit Result.

At minimum the command boundary must support the semantics of:
- recurring schedule change;
- temporary close override;
- exceptional open override;
- explicit cancellation/correction of an existing future change.

Exact command names are implementation-level and may differ without changing semantics.

### 10. Cancellation / correction
A future schedule change is not deleted or silently edited.
Cancellation/correction is an explicit command referencing the target changeId and produces an auditable record/result.

If the target cannot be safely cancelled/corrected under the current contract, the command fails explicitly.

### 11. Concurrency
Schedule mutation uses the strongest existing lock/atomicity boundary appropriate to the schedule scope.

Sensitive mutation flow:

fresh read → validate → lock-protected persistence → explicit result

Do not rely on weak multi-row updates as if they were a transaction.

### 12. Idempotency
Repeated delivery of the same commandId must not create duplicate effective schedule changes.

Reuse existing webhook/message idempotency and command infrastructure where semantics fit.

### 13. Audit
Each committed schedule mutation must preserve enough information to answer:
- who
- what
- when
- scope
- effective-from / effective-to
- before
- after / resulting intent
- result
- command identity

Use existing command/log infrastructure where possible.

### 14. Layering
Allowed direction:

Channel/Router → Authorization → Application Command → Schedule policy/model → Repository → Infrastructure

Application/Domain must not directly call SpreadsheetApp, CalendarApp, or WhatsApp infrastructure.

M4-C must not mutate Availability directly.

### 15. Explicit non-goals
M4-C does NOT:
- reconcile Availability.is_available;
- modify Slot.status;
- create a new Slot status for doctor absence;
- cancel/reschedule appointments;
- send patient disruption messages;
- mutate Calendar;
- implement multi-clinic behavior;
- implement rich per-weekday recurring schedules beyond the existing Settings model;
- implement billing/pricing;
- implement analytics/reporting.

### 16. Data honesty
Invalid or unavailable schedule source data must fail explicitly.
Do not turn missing/invalid values into closed, empty, healthy, or fabricated schedules.

### 17. Time semantics
- Project timezone: Asia/Baghdad.
- Doctor-selected effective boundary is inclusive.
- Past schedule/availability is not rewritten by a future change.
- Current-day changes affect only future operational time; past slots remain untouched.

### 18. Multi-clinic extensibility
v1 may use clinicId=null, but schedule records, commands, repositories, and models must carry a logical scope boundary that does not hard-code a permanent global single-doctor model.

### 19. Reuse-first requirement
Reuse:
- SettingsRepository
- M4-B schedule model/boundary
- SlotGenerator schedule primitives where semantics match
- existing lock/command/log infrastructure
- existing Router/Webhook/ProcessedMessagesService boundaries

Create new code only for genuine missing boundaries: durable schedule changes and the deterministic EffectiveSchedule projection.

### 20. Acceptance gates
Before M4-C stage approval:
1. architecture review;
2. contract audit;
3. deterministic hardening tests;
4. node --check;
5. M0–M4-B regression;
6. forbidden dependency/read-write scans;
7. mutation/atomicity tests;
8. idempotency tests;
9. diff review;
10. Git state verification;
11. durable-memory update.

The known pre-existing M1B-X3 baseline failure must remain reported separately and must not be described as full-regression green.

### 21. Status
FROZEN — M4-C-v1.
No implementation is included in this contract.
