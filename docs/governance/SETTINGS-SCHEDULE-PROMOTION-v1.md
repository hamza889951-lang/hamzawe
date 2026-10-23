# SETTINGS-SCHEDULE-PROMOTION-v1
## Status
Implementation contract — authorized by user on 2026-10-23; implementation and CI validation required before merge.

## Objective
Make the clinic's current recurring weekly schedule in the existing `Settings` row the authoritative baseline after a recurring schedule change reaches its effective local date. Preserve immutable change history and future scheduling, while preventing a promoted recurring change from being applied a second time by `EffectiveScheduleService`.

## Current verified architecture
- `SettingsRepository` reads the single-clinic Settings row and provides configured slot duration.
- `DoctorScheduleReadService.readCurrentEffectiveSchedule()` projects the current Settings row.
- `DoctorScheduleCommandService.commitRecurringChange()` validates and appends a committed change through `ScheduleChangeRepository.appendCommitted()`; it does not update Settings.
- `EffectiveScheduleService.projectFromSources()` combines Settings baseline and committed schedule changes.
- `AvailabilityHorizonMaintainer.ensureHorizon()` snapshots Settings and schedule-change records, then generates/reconciles slots using the projection.
- Google Sheets operations are not one cross-sheet atomic transaction. Recovery and idempotency must be explicit.

## Frozen rules
1. A future recurring change MUST NOT update Settings before its effectiveFrom (local midnight Asia/Baghdad).
2. At/after effectiveFrom, a committed, non-cancelled recurring change becomes eligible for promotion to Settings.
3. Promotion updates only the recurring schedule fields represented by the change: seven weekday flags plus `work_start` and `work_end`. It MUST NOT change slot duration, slot generation horizon, clinic identity, or unrelated Settings columns.
4. Original ScheduleChanges records remain immutable. Do not delete, rewrite, or overload existing change records to mark promotion.
5. A separate append-only promotion ledger MUST record change ID, scope, effectiveFrom, expected schedule fingerprint, completion timestamp, and promotion outcome/version sufficient to detect duplicate application and recover interrupted writes. Existing schema/headers must be inspected and reused only if semantically compatible; otherwise add a dedicated sheet without altering existing columns.
6. Promotion must be idempotent across retries and fail closed on ambiguous duplicate effective changes, invalid payloads, invalid current Settings, scope mismatch, or unreadable ledger. Never guess which change wins.
7. Promotion MUST run under a consistent lock compatible with the existing schedule-change and Settings write topology; no nested acquisition of the same lock. Re-read settings and change records inside the lock immediately before deciding.
8. Do not promote cancelled changes. Cancellation after promotion is not a rollback: if existing UX allows it, reject it explicitly unless a separate safe compensating-change contract exists. Preserve existing cancellation semantics for unpromoted changes.
9. EffectiveSchedule must apply only recurring changes that have not been promoted and are not cancelled; temporary close/open overrides continue to apply by their intervals and are not promoted into recurring Settings.
10. The horizon materializer must activate due recurring changes before taking its Settings/changes source snapshot. If activation fails or state is ambiguous, fail closed and do not generate/reconcile slots from stale/ambiguous sources.
11. Keep historical before/after snapshots and audit records immutable. Promotion does not rewrite Availability rows or appointment/calendar state directly; existing safe horizon reconciliation remains responsible for availability projection.
12. Preserve configured slot duration as Settings-authoritative. No fallback/default duration may be treated as valid during schedule activation.
13. All date/time comparisons use the existing Asia/Baghdad local timestamp contract and recurring effective boundary 00:00.
14. Existing numeric commands, direct intents, WhatsApp routing, reports, and temporary override semantics remain unchanged.
15. Add structured logs for promotion started/succeeded/failed/recovered without logging patient data or secrets.
16. No production spreadsheet mutation, clasp push, Apps Script deployment, or Worker changes as part of CI. Merge only after all relevant tests pass.

## Required test evidence
- future change does not mutate Settings before effective date;
- due change updates only intended Settings fields;
- duplicate run is a no-op;
- crash/retry after Settings write but before ledger completion recovers safely;
- cancelled change is not promoted;
- multiple future recurring changes promote in effective-date order;
- same-effective-date ambiguity fails closed;
- malformed or unreadable source/ledger prevents horizon generation;
- promoted recurring change is not applied twice;
- temporary overrides remain effective and unpromoted;
- unrelated Settings values and slot duration are preserved;
- existing schedule command, EffectiveSchedule, horizon, cancellation, and regression suites pass.

## Acceptance / closure
PR CI passing is necessary but not sufficient. Before merge, review diff and prove all required tests pass. After merge, synchronize the changed Apps Script files and verify deployed code identity; run operational verification in a controlled test, confirming Settings promotion and slot generation. Production closure requires explicit evidence of both Settings values and effective schedule/slot behavior.
