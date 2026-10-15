# Reporting Closure Plan — HAMZAWE

**Plan ID:** `HAMZAWE-REPORTING-CLOSURE-v1`  
**Status:** FROZEN — changes require an explicit recorded decision  
**Repository:** `hamza889951-lang/hamzawe`  
**Production branch:** `main`  
**Plan created:** 2026-10-15  
**Governance mode:** Audit first; controlled evolution; no production/deployment claims without independent verification.

## Purpose

Close the reporting path from an authorized physician request to an accurate report and, where intended, a WhatsApp response. Preserve existing M1/M2/M3 metric contracts and honest status/error semantics. Do not rewrite working report services or invent business thresholds.

## Frozen execution sequence

### Batch 1 — Entry-point and delivery contract (START HERE; audit/contract only)
1. Map the actual inbound path: Meta webhook → `Webhook.js` → `Router` → authorization/doctor-control boundary → report service → renderer → `MessagingPolicyService.sendReply` → outbound provider.
2. Determine whether a physician-facing report request is an explicit product requirement and identify the intended authorized entry point. Do not infer authorization from the fact a phone sent a message.
3. Record report types, period/reference rules, role/scope checks, error behavior, response DTO, renderer choice, and delivery/observability boundaries.
4. Verify `SUMMARY` is a projection of `FULL` that preserves metric status/reason semantics; do not silently flatten unavailable/deferred/error states.
5. Deliver a written contract and gap list. **No implementation in this batch.** Exit gate: the entry point, authorization boundary, and request/response contract are unambiguous and approved.

### Batch 2 — Authorized reporting entry point
1. Implement only the approved route through the existing architecture; reuse existing services and boundaries.
2. Keep authorization fail-closed, report generation read-only, and transport-specific parsing outside application services.
3. Do not add metrics, thresholds, new business rules, sheet schema, or duplicate router/service boundaries.
4. Exit gate: focused routing/authorization tests pass; unauthorized and malformed requests cannot expose reports; existing doctor-control flows remain unchanged.

### Batch 3 — Presentation and semantic fidelity
1. Improve physician-facing Arabic presentation for technical/English labels where needed.
2. Preserve distinctions among AVAILABLE zero, DEFERRED, UNAVAILABLE, PARTIAL, and source errors.
3. Preserve the contract that SUMMARY is derived from FULL rather than recalculating metrics.
4. Exit gate: renderer tests cover all statuses/reasons, period display, Arabic labels, and FULL/SUMMARY semantic equivalence.

### Batch 4 — Integration, regression, and release verification
1. Add/complete end-to-end tests across authorized entry point, service, renderer, send adapter boundary, and delivery-failure logging.
2. Run targeted tests, complete hardening regression, syntax checks, and diff/architecture review.
3. Report separately: code/test evidence, CI result, merge state, Apps Script sync/deployment state, and live WhatsApp delivery evidence.
4. Exit gate: no unresolved P1 findings; all tests pass; deployment and live delivery are verified by the operator with recorded evidence. Merge alone is not deployment or delivery proof.

## Non-negotiable invariants

- `ReportService` remains a read-only consumer of the M1 metrics foundation; no direct sheet reads/writes or message sending inside report generation.
- `EnhancedReportService` composes existing M1/M2 outputs; no metric recalculation or status/reason flattening in SUMMARY.
- `RateRuleService` thresholds remain unconfigured unless separately specified and approved. A rate may be computable while rule evaluation remains NOT_EVALUABLE / RULE_NOT_CONFIGURED; do not invent thresholds.
- Preserve clinic-local period rules and interval semantics already defined by `ReportPeriod`; any change requires a separate contract decision.
- Do not claim a physician-facing path exists unless repository routing and authorization prove it.
- Do not claim successful WhatsApp delivery based only on a successful service result, send attempt, CI, PR merge, or Apps Script sync.
- No production edits, live sends, Apps Script deployment, or unrelated refactoring as part of this plan.
- Each batch is separately reviewed and must pass its exit gate before the next batch begins. No skipping, merging batches, or scope expansion without an explicit recorded approval.

## Current evidence at freeze

The inspected `Application/DoctorControlInteractionService.js` menu exposes schedule controls and no report choice in that menu. This is a bounded observation, not proof that no other report entry point exists anywhere. `Webhook.js` dispatches inbound messages through `Router` and sends replies through `MessagingPolicyService.sendReply`, logging `WEBHOOK_SEND_FAILED`; this alone does not prove a report service is connected to that path or that Meta delivered a report. `ReportService` documents a read-only report-composition boundary. `RateRuleService` has no configured thresholds, so rule evaluation must remain honest and non-evaluable where appropriate.

## Change control

Any change to order, scope, invariants, or exit gates must be made as a documented plan revision (v2 or a numbered amendment) with the reason and explicit authorization. Until then, this plan is the governing sequence.
