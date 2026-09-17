# STALE BOOKED Reconciliation — FINAL / FROZEN

## CONTRACT ID
`STALE-BOOKED-RECONCILIATION-v1`

## STATUS
`FROZEN`

## BASELINE
`41bddec241c316279852259effd80f148dad1f45`

## IMPLEMENTATION
`AUTHORIZED — STALE BOOKED RECONCILIATION ONLY`

## 1. Problem

A patient conversation can remain in `BOOKED` after the authoritative appointment has reached a terminal Availability status such as `COMPLETED` or `NO_SHOW`.

The existing Router dispatch is conversation-state driven. Therefore a stale `BOOKED` row can incorrectly expose Change/Cancel options even though no active appointment exists. B6 correctly rejects Change/Cancel when there is no `CONFIRMED` appointment, but the conversation remains stale unless a reconciliation boundary repairs it.

## 2. Source of Truth

`Conversation.state = BOOKED` is **not** authoritative proof that an active appointment exists.

For a patient phone, the authoritative active-appointment condition is:

- exactly one Availability row with `phone === normalizedPhone` and `status === CONFIRMED`.

The following statuses are terminal and are not active appointments:

- `COMPLETED`
- `NO_SHOW`
- `EXPIRED`
- `CANCELLED`

## 3. Reconciliation Boundary

A new Application boundary, `ActiveAppointmentReconciliationService`, is invoked by `Router` **only when the current Conversation state is `BOOKED`, before dispatching `2`, `3`, or any other patient message**.

The Router remains a dispatch boundary: it does not inspect Availability directly. The reconciliation service owns the authoritative appointment read and any stale-session repair.

## 4. Decision Matrix

### A. Exactly one active `CONFIRMED` appointment

Result:

`ACTIVE_BOOKED`

Action:

- Do not modify Conversations.
- Continue normal Router dispatch.
- `2` continues to ChangeService/B6.
- `3` continues to CancelService/B6.
- Other messages continue to BookingService.

### B. Zero active `CONFIRMED` appointments

Result:

`STALE_CLEARED`

Action:

- Treat the existing `BOOKED` conversation as stale.
- Reset the conversation to `MENU_MAIN` using `ConversationRepository.resetToMenuMain(phone)`.
- Return a user-facing message stating that the previous appointment has ended and a new booking can be started.
- Do not invoke ChangeService, CancelService, B6, Calendar, Attendance, or Scheduler logic.

### C. More than one active `CONFIRMED` appointment

Result:

`BOOKED_RECONCILIATION_AMBIGUOUS`

Action:

- Do not modify Conversations.
- Do not guess which appointment is authoritative.
- Fail closed with `Result.fail(...)`.
- No Change/Cancel/B6/Calendar mutation is allowed.

### D. Authoritative Availability read failure

Result:

`BOOKED_RECONCILIATION_READ_FAILED`

Action:

- Do not modify Conversations.
- Fail closed with `Result.fail(...)`.
- Never convert a storage/read failure into "zero active appointments".

## 5. Mutation Boundary

The reconciliation is permitted to mutate **only** the patient Conversation state from stale `BOOKED` to `MENU_MAIN` in the zero-active case.

It must never:

- change `Availability.status`;
- change `is_available`;
- delete or create Calendar events;
- enter or resolve B6 lifecycle ownership;
- write Attendance evidence;
- modify Scheduler behavior;
- alter StateMachine transitions;
- introduce new Conversation states;
- add triggers or Script Properties.

## 6. Idempotency / Replay

After `STALE_CLEARED`, a repeated inbound message observes `MENU_MAIN` and follows the normal booking conversation. Reconciliation itself must not create appointment side effects.

Repeated stale `BOOKED` requests must not create B6 ownership or Calendar side effects.

## 7. Error Semantics

All paths use the repository `Result` contract:

- `Result.ok(...)` for active or successfully-cleared reconciliation;
- `Result.fail(...)` for authoritative read failure or active-appointment ambiguity.

A read failure is never represented as an empty appointment set.

## 8. Concurrency / Safety

The reconciliation read is read-only. The zero-active repair is intentionally limited to Conversation state and does not participate in Slot/Calendar/B6 transactions.

This contract does not redefine or replace `SlotRepository.atomicUpdate`; all Availability state mutation remains subject to the existing state-machine and atomic-update contracts.

A later booking operation remains responsible for its own fresh slot re-read and transition validation.

## 9. Non-Goals

This contract does not:

- create a permanent Appointment entity;
- change the appointment-episode model;
- change B6 lifecycle ownership or recovery;
- add an automatic TTL to Conversation state;
- make AttendanceService update Conversations;
- alter Scheduler/Maintenance behavior;
- introduce automatic deletion of historical appointments.

## 10. Verification Requirements

Mandatory tests:

1. `BOOKED + one CONFIRMED` → existing dispatch continues.
2. `BOOKED + zero CONFIRMED` → Conversation resets to `MENU_MAIN`, no Change/Cancel/B6 effects.
3. `BOOKED + COMPLETED` → zero active path.
4. `BOOKED + NO_SHOW` → zero active path.
5. `BOOKED + multiple CONFIRMED` → fail closed, no mutation.
6. Availability read failure → fail closed, no mutation.
7. `BOOKED + 2` stale → stale repair occurs before ChangeService.
8. `BOOKED + 3` stale → stale repair occurs before CancelService.
9. `BOOKED + ordinary message` stale → stale repair occurs before BookingService.

## 11. Governance

This is a focused hardening change. No other contract is authorized to change with this implementation.

`main` remains unchanged until a separate Supervisor review and merge decision.
