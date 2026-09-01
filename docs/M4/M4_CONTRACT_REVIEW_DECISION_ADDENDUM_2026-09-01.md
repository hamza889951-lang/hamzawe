# HAMZAWE — M4 Contract Review Decision Addendum
## Date: 2026-09-01
## Status: REVIEW DECISIONS RECORDED

This addendum records the owner's decisions made during Contract Review. It supplements the M4 Contract Review Package and the frozen M4-C Continuation contract.

## 1. Doctor Control Channel

M4-v1 Doctor Control uses WhatsApp text through the existing Webhook → ProcessedMessages → Router path. Numbered/text interaction is sufficient for the current provider. Interactive buttons are deferred to the future official WhatsApp channel.

Numeric representation is a presentation/channel concern. Application commands remain semantic and provider-neutral so future button payloads can map to the same commands without changing Domain/Application semantics.

Do not introduce a button abstraction, provider-specific schedule logic, or a second gateway merely to prepare for future buttons.

Router remains routing-only; doctor-control interaction handling belongs at the appropriate control/application boundary.

## 2. Recurring Schedule Effective Boundary

Recurring schedule changes are local calendar-day changes. Their operational effective boundary is the start of the selected day at `00:00` in `Asia/Baghdad`.

Exact intra-day effective times are not part of recurring v1.

Temporary overrides remain exact half-open intervals `[effectiveFrom,effectiveTo)`.

`createdAt`, `effectiveFrom`, and projection/materialization time remain distinct concepts.

## 3. Exceptional Opening

Exceptional opening of a normally closed day is supported in v1.

For v1, the opening uses the clinic's configured regular Settings working window. The doctor does not provide an arbitrary opening duration/window for an exceptional-open command.

Example:

- Settings regular window: `10:00–14:00`
- Tuesday normally closed
- Exceptional open Tuesday → effective opening `10:00–14:00`

Partial-day exceptional opening is outside v1.

## 4. Future Bus-Count / Reverse Slot-Grid Idea

The idea of letting the doctor specify only a desired bus count and deriving the slot grid backwards is explicitly deferred.

The current architecture is time-window/grid based. Supporting bus-count-as-input would require reverse derivation and a distinct contract around slot generation semantics, adding ambiguity without enough current business value.

Bus number remains presentation-only, derived from internal slot time. It is not stored as schedule truth and is not an input to slot generation.

## 5. Preview Information

Doctor preview reports the number of currently affected bookings.

It does not expose patient-level details or a list of bus numbers.

Preview remains read-only and must not persist a Schedule Change or mutate Availability/appointments.

## 6. Replacement Selection

For later patient-disruption handling, replacement selection uses the existing booking eligibility policy and minimum booking lead.

Candidate lower bound:

`now + MIN_BOOKING_LEAD_MINUTES`

The candidate does not need to be after the original appointment time. A lower bus number is valid.

Replacement remains a proposal only; patient confirmation is required before final booking.

No second slot-selection policy is permitted.

## 7. Consequences for Contract Drafting

Frozen M4 contracts must explicitly preserve:

1. recurring effective boundary = local `00:00` of selected date;
2. temporary overrides = exact `[start,end)` intervals;
3. exceptional open = configured regular Settings window;
4. `slotDurationMinutes` not controlled by Doctor Control and Settings-authoritative;
5. bus count not a Doctor Control input;
6. preview reports affected-booking count only;
7. `is_available` is operational materialization, not durable schedule truth;
8. sensitive booking reservation paths re-check `is_available=true` under the existing per-slot atomic boundary;
9. Horizon generation and reconciliation consume the same EffectiveSchedule interpretation;
10. existing slot lifecycle/patient/calendar fields are preserved during availability reconciliation.

## 8. Status

These are owner-approved decisions. The current M4-C Continuation contract is frozen separately. Any future change to these decisions requires an explicit amendment/review.
