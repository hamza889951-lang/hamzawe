# HAMZAWE — M4-C Persistence / Effective Schedule Decision
## Supervisor decision — 2026-08-31

### Decision
Adopt **immutable Schedule Change Records + deterministic EffectiveSchedule projection**.

Do NOT persist independent mutable "Schedule Versions" as the primary semantic source.

### Canonical chain
Recurring Settings baseline
+
Immutable dated Schedule Change Records
→ deterministic EffectiveSchedule(scope, date/time)
→ later M4-D availability materialization/reconciliation

### Why
1. Preserves durable history of what was requested and when.
2. Corrections/cancellations can be represented as new explicit records instead of silently editing history.
3. Temporary date/time exceptions fit naturally without cloning full schedules.
4. M4-D can consume one deterministic projection instead of maintaining a second schedule interpretation.
5. Supports future multi-clinic scope without making a single mutable schedule snapshot the permanent identity.
6. Keeps operational availability separate from schedule intent.

### Record rules
Each committed change record carries, at minimum:
- immutable changeId
- logical scope (doctorId, clinicId)
- actorId
- commandId / idempotency identity
- change kind
- effectiveFrom
- optional effectiveTo for bounded overrides
- schedule payload relevant to the change
- createdAt
- result/status metadata required by the audit contract

Records are append-only at the semantic level. A correction/cancellation is represented explicitly rather than by silent in-place mutation of historical intent.

### Recurring changes
A recurring schedule change establishes the recurring baseline from its effectiveFrom onward until a later recurring change supersedes it for the same scope.

### Temporary overrides
A temporary/date-specific override applies only to its declared effective interval and does not rewrite the recurring baseline.

### Conflict rule
No silent precedence engine is introduced. If two applicable schedule intents are incompatible and the contract does not define an explicit relationship, the command fails with an explicit conflict.

### EffectiveSchedule
EffectiveSchedule is a pure/deterministic projection over:
- current recurring Settings baseline
- applicable committed recurring changes
- applicable temporary/date-specific overrides

The projection must be reusable by later future-slot generation and M4-D reconciliation. It must not mutate storage.

### Cancellation/correction
A future change is not deleted or silently edited. Cancellation/correction uses an explicit command/change record referencing the target changeId, subject to validation that the target is still cancellable in the requested scope/time window.

### Non-goals
This decision does not define:
- patient disruption/rescheduling
- appointment lifecycle changes
- availability reconciliation implementation
- WhatsApp UX
- multi-clinic implementation
- billing/pricing
