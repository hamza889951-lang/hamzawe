# Reporting Closure — Batch 1 Audit Record

**Plan:** `HAMZAWE-REPORTING-CLOSURE-v1`  
**Batch:** 1 — Entry-point and delivery contract  
**Status:** IN PROGRESS — audit/contract only; no implementation authorized  
**Audit date:** 2026-10-15

## Verified findings so far

1. **Doctor-facing menu gap (bounded finding).** `Application/DoctorControlInteractionService.js` exposes schedule-oriented controls (view/change schedule, temporary close/open, cancel change). No report option/handler was observed in that inspected menu. This does not prove no other entry point exists elsewhere.
2. **Generic inbound/outbound seam exists, but report path is unproven.** `Webhook.js` accepts supported inbound types, claims idempotency, calls `Router.dispatch(...)`, and sends a successful `result.data.reply` via `MessagingPolicyService.sendReply(...)`. A send failure is logged as `WEBHOOK_SEND_FAILED`. This does not establish that report requests reach report services or that Meta delivered the reply.
3. **Authorization boundary is explicit for doctor control.** `Application/DoctorControlEntry.js` requires `actorContext.authorized === true` and a non-empty `actorId`, otherwise returns `DOCTOR_UNAUTHORIZED`. It passes actorId/scope through as a control context. Any report path that exposes doctor data must reuse an approved authorization boundary; it must not infer authorization from an inbound phone number alone.
4. **M1 report generation is a read-only service boundary.** `Application/ReportService.js` composes daily/weekly/monthly report DTOs from `MetricsService`, preserves metric envelopes/provenance, and explicitly does not perform message sending or data writes.
5. **M3 is the canonical M1+M2 composition path.** `Application/EnhancedReportService.js` consumes M1 `ReportService` and M2 `RateRuleService` outputs to build one canonical FULL model and derives SUMMARY as a pure projection. It explicitly forbids recalculating rates/metrics or accessing repositories/side-effect paths.
6. **Renderers are presentation-only.** `Application/ReportRenderer.js` renders the M1 DTO; `Application/EnhancedReportRenderer.js` renders M3 FULL/SUMMARY models. Their documented boundaries prohibit data access and recalculation. Current labels include English/technical headings, a known presentation issue for a later batch—not a reason to rewrite service contracts.
7. **Threshold policy remains unconfigured.** `Application/RateRuleService.js` documents empty threshold policy and requires `NOT_EVALUABLE / RULE_NOT_CONFIGURED` where no approved threshold exists. Reporting closure must not invent or embed thresholds.
8. **Period contract remains unchanged.** Reporting periods are clinic-local; weekly periods start Saturday; intervals are start-inclusive/end-exclusive. No period semantics change is authorized by this plan.

## Current gap / limitation

The Router source file and its actual dispatch/authorization wiring have not yet been located through the inspected candidate paths. Therefore the end-to-end path from inbound physician request to `EnhancedReportService` (or `ReportService`) is **NOT VERIFIED**. We must not declare that a route exists or start implementation against a guessed seam.

## Remaining work in Batch 1

- Locate the actual Router/dispatch implementation and trace its authorization call path.
- Inspect relevant router/authorization tests and M3 tests, including whether SUMMARY preserves statuses/reasons from FULL.
- Confirm the intended product entry point: physician WhatsApp menu, another supported operator entry point, or reports are not yet intended to be user-facing.
- Freeze the request vocabulary, actor/scope rules, report type/reference semantics, service/renderer selection, failure responses, send logging, and test matrix.
- Identify the smallest safe implementation boundary without implementing it in this batch.

## Exit gate

Batch 1 remains open until the actual route and authorization path are evidenced and the written contract unambiguously defines: authorized actor/scope, request vocabulary, report type/period selection, service/renderer path, error semantics, reply/delivery behavior, and required tests. No application code implementation begins before that gate is reviewed and approved.
