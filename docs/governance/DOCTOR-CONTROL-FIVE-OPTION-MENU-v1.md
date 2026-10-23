# HAMZAWE Doctor Control — Five-Option Main List Menu Contract v1

Status: IMPLEMENTATION CONTRACT — PR VALIDATION REQUIRED
Scope: Doctor Control menu presentation and interactive-list transport only.
Base: `main` at `9549c8fc7acb574e9e6527cbae7523a34c191035`.

## 1. Goal

Expose five primary Doctor Control actions in one coherent WhatsApp menu and group temporary close/open under a single visual entry, without changing schedule semantics, state-machine rules, authorization, or reporting calculations.

## 2. Verified transport constraint

The current `WhatsAppAdapter.sendInteractiveButtons` validates a maximum of three reply buttons, matching Meta's interactive reply-button message shape. Do not raise this limit to five. The five-option main menu MUST use a WhatsApp interactive **list** message (up to ten total rows under this contract), with inbound `interactive.list_reply` normalized through Cloudflare Worker and Apps Script. Existing three-button report-period and report-representation prompts remain buttons.

## 3. Main menu contract

Exactly five list rows, in this order:

1. `VIEW_SCHEDULE` — عرض جدول الدوام
2. `CHANGE_SCHEDULE` — تغيير جدول الدوام
3. `TEMPORARY_AVAILABILITY` — إغلاق / فتح مؤقت
4. `CANCEL_CHANGE` — إلغاء تغيير مجدول
5. `REPORTS` — التقارير

The main menu remains in `DOCTOR_MENU`. Rendering it clears the existing doctor draft exactly as the existing `_showMenu` contract does. Selecting a row must be routed by its opaque row ID, never by its visible title.

## 4. Temporary-action submenu

The combined row opens a submenu, still in `DOCTOR_MENU`, with exactly:

- `TEMPORARY_CLOSE` — إغلاق مؤقت
- `TEMPORARY_OPEN` — فتح استثنائي
- `BACK_TO_MENU` — رجوع إلى اللوحة

This submenu only selects an action. It MUST NOT create a schedule change or commit anything. Selecting close/open enters the pre-existing guided input path, which continues through the existing read-only preview, explicit confirmation, fresh validation, and commit path.

## 5. Routing and backward compatibility

- Preserve legacy numeric inputs: `1` view schedule, `2` recurring schedule change, `3` temporary close, `4` exceptional open, `5` cancel scheduled change, and `0` back/cancel according to the existing conversation state.
- Preserve direct intents `TEMPORARY_CLOSE`, `TEMPORARY_OPEN`, `CANCEL_CHANGE`, `REPORTS`, and existing report-period/report-run intents.
- Preserve stale `MORE` / `المزيد` input as an alias to the temporary-action submenu; it is compatibility only, not a primary menu item.
- Add unique transport IDs for the combined menu entry and back navigation. Transport IDs map to provider-neutral intents in both outbound and inbound directions.
- Cloudflare Worker must normalize only recognized Meta `interactive.list_reply` data as `INTERACTIVE_LIST`, carrying row ID in `buttonPayload` and row title in `text`. Apps Script must map row ID to the canonical intent before Router dispatch.
- Do not alter `Core/Router.js`, doctor authorization, conversation schema, `Config.VOCABULARY`, state names, schedule domain commands, report composition, or report calculations.

## 6. Transport validation and failure behavior

- Validate recipient, body, CTA title, section count, section titles, row count (maximum ten total), row IDs, unique transport IDs, row titles and optional descriptions before the Meta request.
- Invalid list data returns a structured `Result.fail`; it must not issue a network request.
- `MessagingPolicyService` tries the list transport only when `deliveryOptions.interactiveList` is supplied. On failure it logs the structured presentation failure and uses the existing plain-text fallback unless `fallbackToText === false`.
- Do not silently reinterpret a list row title as a command; use the ID exclusively.

## 7. Required verification gates

1. Unit test exact five-row main-menu order and exact three-row temporary submenu.
2. Verify each main row ID and submenu ID round-trips through outbound transport mapping and inbound `list_reply` normalization to the same canonical intent.
3. Verify duplicate IDs and over-limit rows fail closed before network send.
4. Verify Cloudflare signature validation remains unchanged and a valid `list_reply` is forwarded with `INTERACTIVE_LIST`, exact ID and title.
5. Verify messaging-policy success, structured failure logging, text fallback, and `fallbackToText=false`.
6. Verify legacy numeric inputs, direct old intents, reports, confirmation/cancellation, and existing Doctor Control / WhatsApp / full hardening regression tests.
7. PR CI must pass before merge. GitHub merge/CI does not prove Apps Script synchronization, Cloudflare deployment, or live Meta delivery; those remain separate owner-operated checks.

## 8. Explicit non-goals

No schedule logic or data mutation changes; no new conversation state or sheet columns; no report behavior changes; no automatic deployment; no credentials or secrets changes.
