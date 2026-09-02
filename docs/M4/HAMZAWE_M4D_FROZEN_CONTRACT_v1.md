# HAMZAWE — M4-D Effective Availability Materialization
## FROZEN CONTRACT v1

**Date:** 2026-09-02  
**Baseline:** `main` after M4-C Continuation  
**Status:** FROZEN  

---

## 1. Contract Purpose

This contract defines the Effective Availability Materialization stage (M4-D) that bridges the EffectiveSchedule (M4-C source of truth) to the operational `Slot.is_available` flag used by the booking pipeline.

It evolves `AvailabilityHorizonMaintainer` to become the single Horizon + Materialization point built on EffectiveSchedule, while preserving all existing lifecycle, booking, and concurrency properties.

## 2. Authoritative Architecture

```text
Doctor Schedule Intent (Schedule Change Records)
    ↓
EffectiveScheduleService (pure projection, read-only)
    ↓
AvailabilityHorizonMaintainer (Horizon + Materialization)
    ↓
Slot.is_available (operational projection)
    ↓
Existing booking pipeline (unchanged)
```

## 3. Core Principles

1. **EffectiveSchedule is the source of truth** for the schedule.
2. **`Slot.is_available`** is the operational projection of that schedule.
3. **No new engines**: no new Schedule Engine, AvailabilityRepository, Scheduler, or StateMachine.
4. **Slot.status is unchanged**: only `is_available` is the operational mutation target.
5. **All slot mutations** go through `SlotRepository.atomicUpdate`.
6. **Terminal slots** (non-FREE status) are never touched.
7. **Materialization boundary** is `Clock.now()`, not booking lead.
8. **Slot evaluation**: `[slotStart, slotStart + configuredDuration)` must fall entirely within the effective work interval.
9. **No rounding, splitting, or shifting** of existing slots.
10. **No silent fallback**: missing/invalid configured duration = fail closed.
11. **Fail closed**: schedule source failure → no materialization.
12. **Partial failure**: single slot failure → isolate, continue, report.
13. **Idempotent retry**: no duplicate Schedule Changes, no duplicate slots.
14. **No global booking freeze**: preserve existing concurrency model.

## 4. New EffectiveScheduleService APIs

### 4.1 `projectSlotAvailability(controlContext, slotStartStamp, slotDurationMinutes)`

Evaluates whether a specific slot interval should be operationally available.

- **Input**: control context, slot start stamp ('YYYY-MM-DDTHH:mm'), duration in minutes
- **Output**: `Result<{ available: boolean, intent: string }>`
- **Semantics**: Checks that [slotStart, slotStart + duration) falls entirely within the effective work interval, considering recurring changes and temporary overrides.
- **Fail-closed**: Returns `Result.fail` on any source failure.

### 4.2 `projectDayEffectiveWindow(controlContext, dateStr)`

Returns the effective recurring-level schedule for a given date (used for generation decisions).

- **Input**: control context, date string ('YYYY-MM-DD')
- **Output**: `Result<{ isWorkingDay: boolean, workWindow: {start, end}, slotDurationMinutes: number, source: string }>`
- **Semantics**: Returns the effective work window for the day based on Settings + recurring changes. Does NOT consider temporary overrides (those are handled per-slot during reconciliation).

## 5. Evolved AvailabilityHorizonMaintainer

### 5.1 `ensureHorizon(optionalControlContext)`

Main entry point (called from Scheduler). Evolved to:

1. Build control context (from `DoctorIdentityRepository` or parameter)
2. Get configured slot duration (fail closed if not configured)
3. **Reconcile** existing FREE future slots against EffectiveSchedule
4. **Generate** missing slots for working days in the horizon
5. Report partial failures

### 5.2 Reconciliation

For each FREE slot where `slotStart >= Clock.now()`:
- Evaluate via `EffectiveScheduleService.projectSlotAvailability()`
- If `is_available` differs from evaluation → update via `SlotRepository.atomicUpdate()`
- Terminal slots are never touched
- Single slot failure → logged, continues with others

### 5.3 Generation

For each day in the horizon plan:
- Evaluate via `EffectiveScheduleService.projectDayEffectiveWindow()`
- If working day: generate slots using EffectiveSchedule-derived work window
- If not working: skip
- Single day failure → logged, continues with others

## 6. Override Handling

### 6.1 TEMPORARY_CLOSE

A TEMPORARY_CLOSE whose `[effectiveFrom, effectiveTo)` overlaps with a slot's `[start, start+duration)` marks that slot as not available.

### 6.2 EXCEPTIONAL_OPEN

An EXCEPTIONAL_OPEN opens a normally-closed day using the Settings work window. Slots within the exceptional window that fit entirely within the Settings work window are available.

## 7. Out of Scope (M4-E+)

- Appointment cancellation/rescheduling (M4-E)
- Calendar integration
- SlotSelection changes
- Patient disruption workflow
- Multi-clinic schema
- Reporting/billing changes

## 8. Test Coverage

`tests/HardeningM4D.test.js` — 49 tests covering:
- A: EffectiveSchedule as source of truth
- B: Existing slot reconciliation
- C: Missing slot generation
- D: Terminal slot preservation
- E: Fail-closed behavior
- F: Partial failure / isolation
- G: Idempotency / retry / convergence
- H: Duration semantics
- I: Override handling (TEMPORARY_CLOSE, EXCEPTIONAL_OPEN)
- J: Layering constraints
- K: Concurrency
- L: Slot interval containment
- M: Day-level effective window projection
- N: Materialization boundary = Clock.now()
- O: Helper functions
- P: No silent fallback
