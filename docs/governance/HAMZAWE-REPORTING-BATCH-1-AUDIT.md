# Reporting Closure — Batch 1 Audit Record

**Plan:** `HAMZAWE-REPORTING-CLOSURE-v1`  
**Batch:** 1 — Entry-point and delivery contract  
**Status:** AUDIT COMPLETE; contract proposed for explicit approval; implementation not yet authorized  
**Audit date:** 2026-10-15

## Verified findings

1. **Doctor-facing menu gap (bounded finding).** `Application/DoctorControlInteractionService.js` exposes schedule-oriented controls (view/change schedule, temporary close/open, cancel change). No report option/handler was observed in that menu.
2. **Generic inbound/outbound seam exists.** `Webhook.js` parses supported inbound types, claims idempotency, calls `Router.dispatch(...)`, and sends a successful `result.data.reply` via `MessagingPolicyService.sendReply(...)`. A send failure is logged as `WEBHOOK_SEND_FAILED`. This proves a generic reply seam, not report delivery.
3. **Actual Router located.** The source is `Core/Router.js`. It normalizes the phone, checks `DoctorAuthorizationService.authorizeDoctor`, sends authorized doctors through `DoctorControlEntry.enter`, then delegates to `DoctorControlInteractionService.handle`. It otherwise preserves existing patient routing. Router's documented contract is routing-only; report parsing/computation should not be added there.
4. **Authorization is fail-closed.** `DoctorAuthorizationService` reads the trusted configured doctor identity, returns a doctor actor context only on a match, and fails closed when the source is absent/unavailable or the actor does not match. `ADMIN_PHONE` alone is not doctor authorization, as covered by M4-A tests.
5. **M1 report service is read-only.** `Application/ReportService.js` composes daily/weekly/monthly report DTOs from `MetricsService`, preserving metric envelopes/provenance. It does not send messages.
6. **M3 is the canonical M1+M2 composition.** `Application/EnhancedReportService.js` composes M1/M2 into FULL and derives SUMMARY as a projection. It does not recalculate metrics/rates or touch repositories/writes.
7. **Renderers are presentation-only.** `Application/ReportRenderer.js` renders M1; `Application/EnhancedReportRenderer.js` renders M3 models. Their boundaries prohibit data access and recalculation.
8. **Threshold policy remains unconfigured.** `Application/RateRuleService.js` requires honest `NOT_EVALUABLE / RULE_NOT_CONFIGURED` behavior where no approved threshold exists. No thresholds will be invented.
9. **Period semantics remain frozen.** `Utils/ReportPeriod.js` owns clinic-local period arithmetic, Asia/Baghdad, Saturday-start weekly periods, and start-inclusive/end-exclusive intervals. No UI-level period arithmetic or contract change is authorized.
10. **Regression harnesses exist.** `tests/HardeningM4A.test.js` exercises the real Router and doctor authorization boundary; `tests/HardeningM3.test.js` covers M3 FULL/SUMMARY projection, status/provenance preservation, periods, and no side effects. These are focused regression targets for any subsequent integration work.

## Proposed contract

A concrete proposal is recorded in `docs/governance/HAMZAWE-REPORTING-ENTRY-CONTRACT-v1.md`. It proposes using the existing authorized doctor WhatsApp interaction as the entry point, period types DAILY/WEEKLY/MONTHLY, SUMMARY/FULL representation, M3 as the enhanced report composition path, and the existing webhook reply boundary. It also specifies fail-closed authorization, error semantics, non-goals, and required tests.

**Important:** the proposed placement in the doctor menu and default SUMMARY behavior are product choices, not facts established by code. The contract is therefore proposed for explicit approval; implementation must not begin against these assumptions until approval is recorded.

## Batch 1 disposition

- Repository route and authorization path: **FOUND AND TRACED**.
- Existing reporting services/renderers and boundaries: **INSPECTED**.
- Relevant existing test harnesses: **IDENTIFIED**, not executed in this audit.
- End-to-end report entry point/delivery: **NOT CURRENTLY IMPLEMENTED/NOT VERIFIED**.
- Final request/response contract: **PROPOSED; approval gate remains open**.
- Code changes or test execution: **NONE in this audit**.

## Exit gate

Batch 1 can close only after explicit approval of the proposed product-facing request contract (or a recorded revision). Then Batch 2 may implement only the approved route and its tests. No implementation begins before that gate is approved.
