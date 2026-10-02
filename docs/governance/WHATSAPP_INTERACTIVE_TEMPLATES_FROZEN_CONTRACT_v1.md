# HAMZAWE WhatsApp Interactive Templates — FROZEN CONTRACT v1

Contract ID: WHATSAPP-INTERACTIVE-TEMPLATES-v1
Status: FROZEN — IMPLEMENTATION AUTHORIZED
Baseline: 67350f96334ff33e44fc6fd58dfacfdb7b438e94
Scope: WhatsApp presentation + inbound normalization only.

## 1. Objective
Replace patient-facing numeric choice instructions such as 1 / 2 / 3 with WhatsApp Quick Reply buttons carried by approved Meta message templates, without changing the business State Machine, appointment lifecycle, or Router decision semantics.

The existing numeric text inputs remain supported as a compatibility fallback.

## 2. Architectural boundary
MUST NOT change: StateMachine transitions; Conversation states/schema; BookingService business semantics; ChangeService business semantics; CancelService business semantics; PatientDisruptionService decision semantics; Appointment/Calendar/B6 lifecycle contracts; Gateway authentication/HMAC contract; Meta token/configuration model.

MAY change: Cloudflare Worker inbound normalization; WhatsAppAdapter inbound normalization/template transport; WhatsAppTemplateRepository; MessagingPolicyService presentation dispatch; patient-facing Result metadata; tests/docs.

## 3. Canonical button payloads
HAMZAWE_CONFIRM -> 1
HAMZAWE_CHANGE -> 2
HAMZAWE_CANCEL -> 3
HAMZAWE_DECLINE -> 2
HAMZAWE_START_BOOKING -> START_BOOKING

The adapter maps known button payloads to the existing textual command representation before Router dispatch. Unknown payloads fail closed.

## 4. Inbound Meta types
The Worker MUST normalize ordinary text and Meta template Quick Reply callbacks (type=button). button.text remains presentation metadata; button.payload is the canonical action source. Apps Script accepts normalized button events and converts known payloads to the canonical message used by the existing Router. No State Machine change is permitted.

## 5. Outbound template transport
WhatsAppAdapter.sendTemplate remains the single provider transport boundary. It MUST support body text parameters and zero or more Quick Reply button payload parameters while remaining backward compatible with existing template calls. Meta's template send contract uses button/quick_reply/index/payload components. Source: Meta WhatsApp Cloud API Postman collection.

## 6. Template configuration
Template names/language remain deployment configuration using WHATSAPP_TEMPLATE_<KIND>_NAME and WHATSAPP_TEMPLATE_<KIND>_LANGUAGE.

Required v1 kinds:
WELCOME
BOOKING_CONFIRMATION
BOOKED_ACTIONS
CHANGE_CONFIRMATION
DISRUPTION_PROPOSAL
DISRUPTION_NO_ALTERNATIVE
REMINDER
REMINDER_NO_BUS

Templates containing Quick Replies require approved button order to match application payload order.

## 7. Required template designs
WELCOME: button حجز موعد -> HAMZAWE_START_BOOKING.
BOOKING_CONFIRMATION: parameters date, bus number, clinic work start; buttons تأكيد الحجز -> HAMZAWE_CONFIRM, تغيير الموعد -> HAMZAWE_CHANGE.
BOOKED_ACTIONS: buttons تغيير الموعد -> HAMZAWE_CHANGE, إلغاء الموعد -> HAMZAWE_CANCEL.
CHANGE_CONFIRMATION: parameters date, bus number, clinic work start; button تأكيد الحجز -> HAMZAWE_CONFIRM.
DISRUPTION_PROPOSAL: parameter proposed appointment display; buttons تأكيد الموعد البديل -> HAMZAWE_CONFIRM, رفض الموعد البديل -> HAMZAWE_DECLINE.
DISRUPTION_NO_ALTERNATIVE: text-only Utility template.
REMINDER: parameters date, bus number, clinic work start; buttons تغيير الموعد -> HAMZAWE_CHANGE, إلغاء الموعد -> HAMZAWE_CANCEL.
REMINDER_NO_BUS: parameter date; buttons تغيير الموعد -> HAMZAWE_CHANGE, إلغاء الموعد -> HAMZAWE_CANCEL.

Meta supports Quick Reply buttons in message templates and returns button text/payload in the webhook callback.

## 8. Presentation fallback
Template delivery MUST NOT become a business-logic dependency. If a conversational template is missing/rejected, MessagingPolicyService MUST fall back to the existing plain-text reply and log the template failure. Business operations are not rolled back because presentation failed. Existing proactive failure semantics remain unchanged.

## 9. Compatibility
Existing Arabic/English numeric commands, proactive templates, plain text replies, gateway HMAC verification, and current single-clinic deployment remain supported.

## 10. Idempotency/stale actions
Button events use Meta message ID through ProcessedMessagesService. A stale button is subject to the same current Conversation state and business guards as the equivalent numeric input. A button never bypasses Router or StateMachine validation.

## 11. Acceptance gates
1. Worker maps Quick Reply callback without dropping it.
2. Apps Script accepts the event.
3. Known payload maps to the same canonical input as its numeric equivalent.
4. Router dispatch code is not structurally changed.
5. Existing numeric tests remain green.
6. Button tests prove confirm/change/cancel/decline mapping.
7. Template send tests prove body + button components.
8. Missing conversational template falls back to plain text.
9. Arabic inbound remains valid under UTF-8 HMAC verification.
10. No secrets committed.

## 12. Explicit non-goals
WhatsApp Flows; multi-tenant Meta routing; new database/state fields; State Machine redesign; replacement of the current single-clinic architecture.