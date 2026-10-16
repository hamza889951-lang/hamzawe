# Reporting Entry-Point Contract — HAMZAWE

**Contract ID:** `HAMZAWE-REPORTING-ENTRY-v1`  
**Plan:** `HAMZAWE-REPORTING-CLOSURE-v1`  
**Status:** PROPOSED FOR REVIEW — implementation must not begin until this contract is approved  
**Scope:** Physician-facing reporting request and reply path only

## 1. Evidence-based architecture

- `Webhook.js` parses inbound messages, claims idempotency, invokes `Router.dispatch(context)`, and sends `result.data.reply` through `MessagingPolicyService.sendReply`.
- `Core/Router.js` is the sole dispatch point. It normalizes the phone, calls `DoctorAuthorizationService.authorizeDoctor`, and sends an authorized doctor through `DoctorControlEntry.enter` to `DoctorControlInteractionService.handle`. Unauthorized/unknown actors continue through existing patient routing; they must never reach reporting.
- `DoctorControlInteractionService` currently owns the doctor menu/session. This is the narrowest candidate for a physician-facing report intent; do not add report parsing/business logic to Router.
- `ReportService` provides M1 reports. `EnhancedReportService` provides M3 FULL and SUMMARY models composed from M1/M2. Renderers are presentation-only. Report generation itself does not send messages.
- `DoctorAuthorizationService` is fail-closed against the configured `DOCTOR_PHONE`; `ADMIN_PHONE` alone is not doctor authorization.

## 2. Proposed request contract

- Entry point: the existing authorized physician WhatsApp control interaction, via a new explicit report option in the doctor menu. This is a proposed product interpretation based on the existing doctor-facing control surface and requires owner approval.
- Request vocabulary: use explicit stable intent IDs for interactive buttons and explicit numeric/text choices for the legacy text path. Transport IDs remain inside `WhatsAppAdapter`; Application receives semantic intent only.
- Initial scope: choose report period type `DAILY`, `WEEKLY`, or `MONTHLY`, and representation `SUMMARY` or `FULL`. No arbitrary date ranges, custom metrics, threshold editing, or mutations in v1.
- Reference instant: resolve one reference instant using `Clock.now()` at request handling and pass that same reference to report generation; do not let M1/M2 observe different instants.
- Period semantics remain those of `Utils/ReportPeriod.js`: Asia/Baghdad, Saturday-start week, start-inclusive/end-exclusive. No arithmetic is duplicated in UI code.
- Initial default proposal: `SUMMARY` as the default presentation; `FULL` is an explicit choice. The UI must not imply that SUMMARY recalculates metrics; it is a projection of FULL.

## 3. Authorization and data boundaries

- Only a successful `DoctorAuthorizationService` → `DoctorControlEntry` path may access physician reporting.
- Fail closed if identity configuration/source is unavailable. Never infer authorization from the message contents, button payload, conversation state, or `ADMIN_PHONE`.
- Router remains routing-only. `DoctorControlInteractionService` owns interaction state/intent only and delegates report requests to one dedicated application boundary if needed; do not put metrics computation or rendering in Router.
- Report services/renderers remain read-only and transport-neutral. They must not send WhatsApp, write sheets, or mutate schedule/appointments.
- No new sheet columns or settings are authorized by this contract.

## 4. Service and rendering selection

- M1-only reports are not the initial user-facing default because the existing enhanced report contract already composes M1+M2 into one coherent model. Use `EnhancedReportService.generateFull(reportType, reference)`, then `project(fullModel)` for SUMMARY, or the existing equivalent public API after verifying its exact signature in code.
- Render using `EnhancedReportRenderer` for enhanced models. Do not combine separate M1/M2 calls in the interaction layer.
- Preserve model availability and every metric/rate status/reason/provenance. A measured zero remains zero; non-available values must never be rendered as zero.
- Missing threshold policy remains `NOT_EVALUABLE / RULE_NOT_CONFIGURED`; no thresholds may be invented.

## 5. Error and delivery semantics

- Invalid period/representation/intent: return a safe, localized usage response; no report computation with malformed inputs.
- Authorization/source failure: reporting is never entered; existing fail-closed routing remains unchanged.
- Report generation failure: surface a safe unavailable/error response without exposing raw stack traces or internal source details to the doctor; record technical diagnostics through the existing logging boundary if the existing service path supports it.
- Renderer failure: do not send a partial or fabricated report.
- A successful service/render result means only that a reply was prepared. `Webhook.js`'s send attempt and any Meta delivery status are separate evidence. Do not claim delivery without provider status evidence.
- Preserve Webhook idempotency. Duplicate inbound message IDs must not trigger duplicate report sends through a newly added side path.

## 6. Required tests before Batch 2 can close

1. Authorized doctor can reach reporting from the approved interaction; unknown/unauthorized/patient cannot.
2. Missing/unavailable doctor identity source fails closed and cannot expose reports.
3. Router remains routing-only; patient booking, change, cancellation, and disruption routes remain unchanged.
4. Valid DAILY/WEEKLY/MONTHLY and SUMMARY/FULL combinations pass the same reference instant through the service.
5. SUMMARY is projected from FULL; metric/rate statuses, reasons, provenance/data-quality warnings remain semantically faithful.
6. Invalid input, service failure, and renderer failure return safe Results and do not send fabricated/partial reports.
7. Renderer output and WhatsApp reply stay within the supported message boundary; send failure remains observable through the existing webhook logging.
8. Existing M1/M2/M3/M4 regression suites pass.

## 7. Explicit non-goals

No threshold-policy design, no new metrics, no custom date-range reporting, no schema changes, no schedule/appointment mutation, no report scheduling/automation, no dashboard, no changes to report period arithmetic, and no deployment/live send as part of code implementation.

## Approval gate

This is a concrete proposed contract, not yet approved. In particular, the product choice to place reports in the existing doctor WhatsApp menu and the default SUMMARY behavior require explicit approval before implementation. Once approved, Batch 2 may implement only this scope.
