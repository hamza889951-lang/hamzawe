# HAMZAWE — M4-D Session Context Index

This file is the GitHub-side entry point for a fresh M4-D Programmer session.

## Authoritative baseline

- Repository: `hamza889951-lang/hamzawe`
- Production branch: `main`
- M4-D implementation baseline: `5471c4ee8f818df1276ee83c7aa9b42dc29b40d9`
- M4-C continuation: merged through PR #20
- M4-D: contract frozen; implementation authorized; production deployment not authorized.

## Required reading order

1. `HAMZAWE_M4D_FROZEN_CONTRACT_v1_2026-09-02.md` — **FROZEN IMPLEMENTATION AUTHORITY**. Defines the complete M4-D semantic contract, acceptance matrix, failure model, concurrency, scheduler boundary, and Definition of Done.
2. `HAMZAWE_M4D_CONTRACT_DECISION_ADDENDUM_v1_2026-09-02.md` — frozen decision gates used to close the remaining M4-D semantic questions before contract drafting.
3. `HAMZAWE_M4D_DEEP_DISCOVERY_2026-09-02.md` — architecture/code discovery explaining why M4-D must evolve the existing Horizon into EffectiveSchedule-based delta materialization.
4. `HAMZAWE_POST_M4C_MERGE_REALITY_REVIEW_2026-09-02.md` — verified post-M4-C repository reality and current implementation boundaries.
5. `HAMZAWE_M4C_CONTINUATION_FROZEN_CONTRACT_v1_2026-09-01.md` — inherited M4-C constraints and architecture.
6. `HAMZAWE_M4D_PROGRAMMER_SESSION_PROMPT_2026-09-02.md` — session operating instructions and implementation workflow.

## Architectural north star

```text
Settings baseline
      +
immutable Schedule Change Records
      ↓
EffectiveSchedule — SINGLE schedule truth
      ↓
M4-D single Horizon / Materialization stage
      ├── reconcile eligible existing future Slot rows
      │      └── mutate is_available ONLY
      └── create genuinely missing future operational starts
      ↓
Slot.is_available — operational availability projection
      ↓
existing SlotSelection / Booking / lifecycle
      ↓
M4-E appointment impact discovery
```

## Non-negotiable rules

- Do not create a second Schedule Engine.
- Do not create a second Availability store/repository as a new truth source.
- Do not create a second scheduler/Horizon mechanism.
- Do not change `Slot.status` during materialization.
- Existing eligible-row write-set is exactly `is_available`.
- Do not delete-and-regenerate existing Slots.
- Preserve existing `slot_id` and all lifecycle/business fields.
- Missing future operational starts must be created exactly once.
- Use the current Settings-authoritative slot duration; never silently fall back to 30 minutes in the M4-D path.
- Full slot interval `[start, start + duration)` must be operational; no rounding/splitting/shifting.
- Past rows are untouched by forward materialization.
- `MIN_BOOKING_LEAD_MINUTES` belongs to SlotSelection, not materialization.
- Source failure is fail-closed; independent row failures are isolated and reported.
- Existing-row mutations use `SlotRepository.atomicUpdate()`.
- Scheduler uses the existing `AvailabilityHorizon` operational boundary.
- Doctor Control persistence and materialization remain separate durable boundaries.
- M4-D does not cancel/reschedule appointments; M4-E owns appointment impact.
- Programmer must not self-merge and must report the known pre-existing `HardeningM1B / M1B-X3` regression honestly if it remains.

## GitHub-side copies

The following files are intended to be committed under `docs/M4D/` on the M4-D documentation branch so a fresh programmer session can consume the context from GitHub rather than depending on chat memory.

- `HAMZAWE_M4D_PROGRAMMER_SESSION_PROMPT_2026-09-02.md`
- `HAMZAWE_M4D_SESSION_CONTEXT_INDEX_2026-09-02.md`
- `HAMZAWE_M4D_FROZEN_CONTRACT_v1_2026-09-02.md`
- `HAMZAWE_M4D_CONTRACT_DECISION_ADDENDUM_v1_2026-09-02.md`
- `HAMZAWE_M4D_DEEP_DISCOVERY_2026-09-02.md`
- `HAMZAWE_POST_M4C_MERGE_REALITY_REVIEW_2026-09-02.md`
- `HAMZAWE_M4C_CONTINUATION_FROZEN_CONTRACT_v1_2026-09-01.md`

Until these reference documents are copied verbatim, the Library versions remain the durable canonical source. Do not reinterpret this index as a replacement for the frozen contract.
