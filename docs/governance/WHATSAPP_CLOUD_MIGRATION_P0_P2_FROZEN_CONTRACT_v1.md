# HAMZAWE — WhatsApp Cloud API Migration
## P0/P1/P2 Contract v1

Contract ID: WHATSAPP-CLOUD-MIGRATION-P0-P2-v1
Baseline: 581be1b14de007aa9c184ce83e6de71be03ee764
Implementation branch: migration/whatsapp-cloud-p0-p2
Interactive messages: reserved for a future independent contract.

### P0

1. Meta GET webhook verification is handled by the external gateway.
2. Meta POST authenticity is verified with X-Hub-Signature-256.
3. The gateway normalizes inbound events into a provider-neutral event.
4. HAMZAWE verifies the gateway HMAC envelope before business processing.
5. Meta wamid remains the idempotency identity.
6. Only TEXT messages enter the current business Router.
7. STATUS events do not enter Router or Conversation business logic.
8. Unsupported inbound message types are acknowledged/logged without business execution.

### P1

1. Conversational replies use MessagingPolicyService.sendReply.
2. Proactive notifications use MessagingPolicyService.sendProactive.
3. The service-window decision uses last_inbound_at_ms, never Conversation.updated_at.
4. Outside the 24-hour window, a proactive notification requires an explicitly configured template.
5. Missing templates fail explicitly with WHATSAPP_TEMPLATE_REQUIRED.
6. Provider failures never roll back already committed business state.
7. No lock is held across Meta HTTP I/O.

### P2

1. UltraMsg runtime endpoint and credentials are removed.
2. Meta Graph API version, phone-number ID and access token are deployment configuration.
3. Legacy WhatsApp JID suffix normalization is compatibility-only.
4. Application and Domain remain unaware of Meta credentials, Graph URLs and provider payload formats.
5. Existing hardening regression remains mandatory.

### Required Conversations columns

last_inbound_at_ms
last_inbound_message_id

### Required Apps Script properties

META_GRAPH_API_VERSION
META_PHONE_NUMBER_ID
META_ACCESS_TOKEN
WHATSAPP_GATEWAY_SECRET

Template configuration:
WHATSAPP_TEMPLATE_<KIND>_NAME
WHATSAPP_TEMPLATE_<KIND>_LANGUAGE

### Gateway environment

META_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
HAMZAWE_WEBHOOK_URL
HAMZAWE_GATEWAY_SECRET
PORT (optional)

### Out of scope

Interactive messages, buttons, lists, WhatsApp Flows, media, audio, documents, multi-channel redesign, domain/application rewrite, StateMachine changes, Scheduler redesign.

### Acceptance

The branch is implementation-ready for review when targeted P0/P1/P2 tests and the complete hardening regression are green. Production requires explicit deployment and live canary verification after the Conversations schema and Meta/Gateway secrets are provisioned.
