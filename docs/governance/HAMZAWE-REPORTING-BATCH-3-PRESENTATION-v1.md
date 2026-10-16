# HAMZAWE Reporting Batch 3 — Arabic Presentation Contract v1

Status: IMPLEMENTATION CONTRACT FOR REVIEW
Parent plan: HAMZAWE-REPORTING-CLOSURE-v1
Scope: presentation and semantic fidelity only.

## Invariants
- The M3 FULL model remains canonical. SUMMARY must remain a projection of FULL.
- Rendering/presentation must not calculate metrics, infer thresholds, modify values, alter period boundaries, or change source provenance.
- A numeric zero with status AVAILABLE is a measured value and must remain zero.
- Status, reason, report-level availability, per-metric status, and rule-evaluation status are distinct fields/meanings and must not be collapsed.
- Unknown metric identifiers, unknown statuses, source reasons, provenance, insight text, and recommendations must remain verbatim rather than be guessed or globally rewritten.
- No schema, authorization, Router, delivery, or deployment changes are in scope.

## Approved Arabic vocabulary for fixed labels
| Source label/status | Arabic presentation |
| --- | --- |
| ENHANCED REPORT (FULL) | التقرير الإداري الكامل |
| ENHANCED REPORT (SUMMARY) | ملخص التقرير الإداري |
| Period | الفترة |
| Generated | وقت إنشاء التقرير |
| Availability | توفر البيانات |
| M1 METRICS | مؤشرات التشغيل |
| M2 RATES | معدلات الإدارة |
| METRICS | المؤشرات |
| RATES | المعدلات |
| INSIGHTS | الاستنتاجات |
| MANAGEMENT NOTES | ملاحظات إدارية |
| DATA QUALITY | جودة البيانات |
| DAILY / WEEKLY / MONTHLY | يومي / أسبوعي / شهري |
| AVAILABLE | متاح |
| COMPLETE | مكتمل |
| PARTIAL | جزئي |
| DEFERRED | مؤجل |
| UNAVAILABLE | غير متاح |
| NOT_EVALUABLE | غير قابل للتقييم |
| INSUFFICIENT_SAMPLE | العينة غير كافية |
| RULE_NOT_CONFIGURED | سياسة التقييم غير مهيأة |
| EVALUATED | تم التقييم |
| UNKNOWN_STATUS | حالة غير معروفة |

Known metric identifiers may be translated only when they occur as the metric key at the start of a renderer-generated line. Unknown keys stay unchanged. The clinic timezone identifier (for example, Asia/Baghdad) and all date/time values stay unchanged.

## Dynamic text handling
Only renderer-owned labels and recognized status tokens in structural positions are translated. Dynamic reason/provenance text, insight explanations, recommendations, and other source-owned narrative are preserved byte-for-byte in this batch. This avoids corrupting evidence but means some dynamic prose may remain English; full narrative localization is not claimed.

## Exit gate
- Tests cover known fixed labels, dates/timezone, numeric zero, common availability/evaluation statuses, unknown identifiers/statuses, and reasons/narrative containing words that resemble statuses.
- FULL/SUMMARY orchestration remains unchanged: one FULL composition per request and SUMMARY projection only.
- Targeted report tests and the full hardening regression suite pass.
- PR review confirms no business, period, threshold, authorization, schema, delivery, or deployment scope creep.
- Passing CI and merging do not establish Apps Script sync or live Meta delivery.
