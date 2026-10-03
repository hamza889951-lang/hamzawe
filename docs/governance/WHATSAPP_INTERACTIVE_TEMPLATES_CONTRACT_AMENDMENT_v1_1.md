# HAMZAWE WhatsApp Interactive Templates — Contract Amendment v1.1

Status: PROPOSED IMPLEMENTATION AMENDMENT — pending supervisor verification
Applies to: WHATSAPP-INTERACTIVE-TEMPLATES-v1
Scope: WELCOME presentation only

## Reason

Meta rejected the proposed hamzawe_welcome_booking Utility template because its content is a start-of-conversation / start-of-booking prompt rather than a message about an existing transaction. Marketing classification is explicitly rejected for this use case.

## Amendment

1. WELCOME is removed from the set of Meta-approved templates required for production.
2. The WELCOME response is sent as a WhatsApp interactive reply-button message while the customer service window is open, which is true immediately after the patient's inbound first message.
3. Button id HAMZAWE_START_BOOKING is the application action id and visible title is حجز موعد.
4. The Worker normalizes inbound interactive.button_reply events; Apps Script maps the button id to canonical START_BOOKING.
5. No State Machine, Router semantics, Conversation schema, booking lifecycle, gateway authentication, or credential model changes are permitted.
6. On outbound interactive failure, MessagingPolicyService falls back to the existing plain-text WELCOME reply.
7. The seven transactional/proactive templates remain governed by the original v1 contract and must still be approved before their corresponding template paths are considered production-ready.

## Verification gates

- Cloudflare Worker test proves inbound interactive.button_reply normalization.
- Apps Script adapter test/inspection proves HAMZAWE_START_BOOKING -> START_BOOKING.
- Transport test/inspection proves interactive button JSON is formed without a template object.
- Existing numeric command behavior remains unchanged.
- No secrets are added.
