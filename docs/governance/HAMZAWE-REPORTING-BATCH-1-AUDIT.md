# Reporting Closure — Batch 1 Audit Record

**Plan:** `HAMZAWE-REPORTING-CLOSURE-v1`  
**Batch:** 1 — Entry-point and delivery contract  
**Status:** IN PROGRESS — audit/contract only; no implementation authorized  
**Audit date:** 2026-10-15

## Initial verified observations

1. `Application/DoctorControlInteractionService.js` exposes schedule-oriented doctor controls in its inspected menu. No report option/handler was observed in that menu. Scope limitation: this does not prove no other entry point exists elsewhere in the repository.
2. `Webhook.js` accepts supported inbound message types, claims idempotency, calls `Router.dispatch(...)`, and on a successful result sends `result.data.reply` via `MessagingPolicyService.sendReply(...)`. A send failure is logged as `WEBHOOK_SEND_FAILED`. This proves the generic reply seam exists, not that reports are routed there or delivered by Meta.
3. `Application/ReportService.js` documents a read-only M1 reporting service over `MetricsService`, composing daily/weekly/monthly report DTOs and preserving metric envelopes. It explicitly does not send messages.
4. The prior audit identified `EnhancedReportService` / renderers as the M1+M2 composition and presentation layer; these must be inspected alongside Router and authorization before defining the implementation seam.
5. The prior audit identified unconfigured `RateRuleService` thresholds. Do not fill them in as part of reporting closure; keep rule evaluation non-evaluable when policy is absent.
6. The existing reporting calendar uses clinic-local period rules, including Saturday-start weekly reporting and start-inclusive/end-exclusive periods. No period-contract change is authorized here.

## Batch 1 remaining work

- Trace `Router` dispatch and the actual doctor authorization/control context end-to-end.
- Inspect `EnhancedReportService`, `EnhancedReportRenderer`, `ReportRenderer`, relevant router tests, and M3 tests.
- Establish whether report invocation is intended from the doctor WhatsApp UI or another explicitly supported operator entry point.
- Write the final request/response/error/delivery contract and test matrix.
- Identify the smallest safe next implementation boundary, but do not implement it in Batch 1.

## Exit gate

Batch 1 is not closed until the above checks are evidenced and the written contract unambiguously defines: authorized actor/scope, request vocabulary, report type/period selection, service/renderer path, error semantics, reply/delivery behavior, and required tests. No code implementation begins before that gate is reviewed and approved.
