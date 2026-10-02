# HAMZAWE — WhatsApp Business / Meta Cloud API Clinic Setup Runbook

**Document status:** Operational Runbook v1  
**Purpose:** Preserve the exact sequence that produced the current stable HAMZAWE WhatsApp Cloud API deployment, so a future clinic can be provisioned without repeating the investigation and failure modes encountered during the UltraMsg → Meta migration.

> This document records the **current HAMZAWE architecture and the proven setup path**. It is not a proposal to redesign the platform.

---

## 1. Current reference state

The current reference deployment has reached a stable operational state:

- Inbound WhatsApp messages reach HAMZAWE.
- Arabic/non-ASCII inbound messages pass gateway verification.
- The booking conversation completes successfully.
- Outbound WhatsApp replies work.
- HAMZAWE Attendance was re-tested from the secretary account and worked smoothly.
- The resulting behavior is functionally back at the level previously achieved with UltraMsg, but using Meta WhatsApp Cloud API.

The final Unicode failure was caused by a mismatch in HMAC verification handling for non-ASCII message content. The Apps Script side now explicitly computes the gateway HMAC using UTF-8, matching the Cloudflare Worker/TextEncoder behavior.

**Important:** Do not remove the explicit UTF-8 charset from gateway HMAC verification.

---

# 2. Architecture being documented

Current flow:

```
WhatsApp user
    ↓
Meta WhatsApp Cloud API
    ↓
Meta webhook
    ↓
Cloudflare Worker
    ↓
HMAC-signed gateway envelope
    ↓
Apps Script doPost()
    ↓
WhatsAppAdapter.parseIncomingPayload()
    ↓
ProcessedMessagesService
    ↓
Router / booking logic
    ↓
ConversationRepository
    ↓
MessagingPolicyService
    ↓
WhatsAppAdapter.sendText()
    ↓
Meta Graph API
    ↓
WhatsApp user
```

The current deployment uses:

- Meta WhatsApp Cloud API
- Cloudflare Worker
- Google Apps Script
- Google Sheets
- HAMZAWE business logic
- Meta System User access token
- Gateway HMAC between Cloudflare and Apps Script

**Current production state:** HAMZAWE is still single-tenant. This runbook does not authorize a multi-tenant code change.

**Planned clinic model:** the intended future deployment is *not* one new Meta App/project per clinic. The intended model is:

```
One Meta Business Portfolio / Meta App / WABA
        ├── Clinic A phone → Phone Number ID A
        ├── Clinic B phone → Phone Number ID B
        └── Clinic C phone → Phone Number ID C

Clinic A → own email → own Apps Script → own Sheet → own Calendar
Clinic B → own email → own Apps Script → own Sheet → own Calendar
Clinic C → own email → own Apps Script → own Sheet → own Calendar
```

The HAMZAWE code may be copied for each clinic. **Code reuse is not identity reuse:** every clinic gets its own phone identity, Phone Number ID, Apps Script deployment, Sheet, Calendar, and secret/config values.

Meta's current documentation explicitly describes the hierarchy in which one Meta business portfolio can contain WABAs and a WABA can contain multiple phone numbers. [Source: Meta — WhatsApp Business account model / WhatsApp Account Model Evolution]

This establishes that a separate Meta App/project per phone number is **not inherently required**. It does not, by itself, authorize placing unrelated client businesses under one WABA; ownership, authorization, and Meta's onboarding model must also be satisfied.

---

# 3. Critical principle: standard Cloud API, not Coexistence

This runbook documents the standard Cloud API path used by HAMZAWE.

For this architecture, the clinic phone number is treated as a Cloud API number. Do not assume that the same number can simultaneously remain operational in the ordinary WhatsApp/WhatsApp Business application unless a separately designed and verified Meta Coexistence path is being used.

The successful migration path used here was effectively:

```
ordinary WhatsApp number
        ↓
WhatsApp Business registration / migration
        ↓
Meta-compatible WhatsApp Business number
        ↓
Cloud API phone number
```

---

# 4. Clinic phone-number preparation

For every future clinic:

### 4.1 Select the clinic number

The number must:

- be a real mobile number capable of receiving SMS/voice verification;
- be controlled by the clinic;
- be available for the intended WhatsApp Business/Cloud API migration;
- not be treated as a shared personal number;
- have a clearly defined owner responsible for the Meta account.

### 4.2 Preserve the number before migration

Before touching Meta:

1. Confirm the phone number.
2. Confirm access to SMS/voice verification.
3. Confirm who controls the number.
4. Back up any information that must be retained from the previous WhatsApp account.
5. Understand that moving the number to Cloud API changes how the number is operated.

### 4.3 Convert/register the number as WhatsApp Business

The successful reference sequence was:

1. Remove the ordinary WhatsApp registration from the number.
2. Install/register WhatsApp Business.
3. Add/register the number in WhatsApp Business.
4. If Meta reports that the number is still registered in WhatsApp, do not repeatedly change API configuration. First resolve the existing WhatsApp registration state.
5. In the reference case, the WhatsApp Business account was deleted after the registration conflict, then the verification code was accepted on the Meta side.
6. Complete the Meta/WhatsApp Business registration.
7. Confirm that Meta reports the phone number as verified.

### Important diagnostic lesson

When Meta says a number is already registered in WhatsApp, this is a **number-registration state problem**, not an API token problem.

Do not start changing:

- Graph API versions;
- Cloudflare secrets;
- Apps Script HMAC;
- access tokens;

until the phone-number registration state itself is resolved.

---

# 5. Meta asset creation / identification

For each clinic, record these values in a private deployment sheet:

| Item | Required | Example/reference |
|---|---|---|
| Meta Business Portfolio ID | Yes | shared or clinic-specific by approved ownership model |
| WABA ID | Yes | shared WABA is possible; verify account/ownership model |
| Phone Number ID | Yes | clinic-specific |
| Meta App ID | Yes | deliberately shared in the planned model |
| Graph API version | Yes | current approved version |
| System User | Yes | clinic-specific owner/access |
| Access Token | Yes | secret; never commit |
| Webhook URL | Yes | Cloudflare endpoint |
| Webhook Verify Token | Yes | secret |
| App Secret | Yes | secret |
| Gateway Secret | Yes | secret |

### Do not confuse these IDs

The **Phone Number ID** is the ID required by the Graph endpoint:

```
https://graph.facebook.com/{GRAPH_API_VERSION}/{PHONE_NUMBER_ID}/messages
```

A WABA ID is not interchangeable with a Phone Number ID.

A major failure during the migration came from using the wrong phone-number ID. The decisive correction was replacing the incorrect ID with the actual current Meta Phone Number ID.

**Operational rule:** Always verify the Phone Number ID directly against the Meta phone object before testing send.

---

# 6. Meta WABA subscription and multi-number boundary

A WABA can contain multiple phone numbers. Meta's current 2026 documentation explicitly shows multiple phone numbers beneath a WABA. [Source: Meta — WhatsApp Business account model]

For the planned HAMZAWE model, the intended Meta layer is therefore:

```
Meta Business Portfolio
        ↓
HAMZAWE Meta App
        ↓
WABA
   ├── Clinic A Phone Number ID
   ├── Clinic B Phone Number ID
   └── Clinic C Phone Number ID
```

### 6.1 What has been verified

The architectural fact **WABA → multiple phone numbers** is verified from current Meta material. [Source: Meta — WhatsApp Business account model / WhatsApp Account Model Evolution]

### 6.2 What has NOT been established for the current account

Do not record the following as guaranteed:

- that the current unverified business can add a third number;
- that the current WABA will accept unlimited clinic numbers;
- that separate clinics can be treated as one business merely because the API technically supports multiple numbers.

Current third-party documentation consistently reports a **2-phone-number ceiling for an unverified Meta Business Manager/business portfolio**, with higher limits associated with verification and/or Meta-approved exceptions. [Operational limit references: Sinch and Twilio documentation; verify live Meta account limit before onboarding]

Therefore, because full Business Verification is currently unavailable, the clinic rollout must treat **2 active production numbers as the current planning ceiling unless Meta itself exposes a different limit for this account**.

### 6.3 Required verification before clinic #2 / #3

Before onboarding another clinic, verify in the actual Meta account:

1. Current phone-number limit/capability.
2. Current WABA phone-number list.
3. Whether **Add phone number** is available.
4. Whether the new clinic number can be attached to the intended WABA.
5. Whether Meta requires business verification at that exact step.
6. Whether the clinic is actually owned/authorized under the business represented by the Meta portfolio.

Only after these checks PASS may a second/third-number onboarding procedure be frozen.

### 6.4 Ownership boundary — critical

If Clinic A, Clinic B, and Clinic C are genuinely separate businesses/entities, do **not** assume that placing all their numbers under one WABA is compliant simply because the WABA supports multiple numbers.

WhatsApp's current policy requires accurate business identity and prohibits impersonation or misleading customers about the nature/affiliation of the business. [Source: WhatsApp Business Messaging Policy, updated September 23, 2026]

WhatsApp's current FAQ also states that direct API access is for a developer's own business, while offering API access to other businesses requires the appropriate partner path. [Source: WhatsApp Business FAQ — direct API access / partner onboarding]

**Governance rule:** if the clinics are separate legal businesses, ownership/partner onboarding must be resolved before production onboarding. Do not solve that boundary by falsifying business documents or identities.

---

# 7. Meta System User and access token

The current proven approach uses a Meta System User token.

For each clinic:

1. Create/identify the appropriate System User.
2. Grant the System User the required assets.
3. Ensure the application and WhatsApp assets are accessible.
4. Generate a long-lived / intended production token according to the current Meta controls.
5. Store the token only as a secret/property.
6. Never put the token in GitHub.
7. Never put the token in a diagnostic log.
8. Never send the token in ChatGPT messages.

The reference System User was granted WhatsApp management/messaging permissions and was able to:

- read the correct phone object;
- successfully send a direct Graph API message;
- successfully send through HAMZAWE after the Phone Number ID was corrected.

### Token diagnostic rule

If:

- GET phone object succeeds,
- token debugging says valid,
- direct Graph POST succeeds,

but HAMZAWE fails, investigate the **runtime configuration/path** before regenerating the token.

Do not regenerate credentials blindly.

---

# 8. Cloudflare Worker setup

Current Worker:

```
hamzawe-whatsapp-gateway
```

The Worker is the public Meta webhook boundary.

**Important multi-clinic correction:** the current Worker is single-tenant. Its configuration contains one `HAMZAWE_WEBHOOK_URL` and one `HAMZAWE_GATEWAY_SECRET`, and the current normalized event does not yet preserve `metadata.phone_number_id` as a tenant-routing field. Therefore the current Worker cannot safely fan out one shared Meta webhook stream to multiple independent clinic Apps Script projects.

It performs:

1. Meta webhook verification.
2. Raw-body signature validation using the Meta App Secret.
3. JSON parsing.
4. Event normalization.
5. Gateway HMAC generation.
6. Forwarding to Apps Script.

## 8.1 Required Worker secrets

The current Worker requires four secrets:

```
META_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
HAMZAWE_WEBHOOK_URL
HAMZAWE_GATEWAY_SECRET
```

### Meaning of each

| Secret | Purpose |
|---|---|
| META_APP_SECRET | validates Meta's webhook signature |
| META_WEBHOOK_VERIFY_TOKEN | completes Meta webhook verification |
| HAMZAWE_WEBHOOK_URL | target Apps Script doPost endpoint |
| HAMZAWE_GATEWAY_SECRET | signs normalized events sent to Apps Script |

**Never store these values in GitHub.**

Cloudflare explicitly recommends Worker Secrets for sensitive values rather than ordinary variables/configuration.

## 8.2 Worker deployment

After configuring the secrets:

1. Deploy the Worker.
2. Confirm the Worker is reachable.
3. Confirm `GET /healthz` returns success.
4. Confirm Meta webhook verification succeeds.
5. Send one inbound WhatsApp message.
6. Verify that Apps Script receives the event.

Cloudflare currently documents `wrangler secret put` as the mechanism for creating/updating Worker secrets; it creates a new Worker version and deploys it.

---

# 9. Apps Script setup

Each clinic instance should have its own Apps Script project under its designated operational account/email if the current single-tenant strategy is retained.

The current Meta adapter expects these Script Properties:

```
META_GRAPH_API_VERSION
META_PHONE_NUMBER_ID
META_ACCESS_TOKEN
WHATSAPP_GATEWAY_SECRET
```

## 9.1 Property meanings

| Script Property | Purpose |
|---|---|
| META_GRAPH_API_VERSION | Graph API version used by the adapter |
| META_PHONE_NUMBER_ID | exact Meta Phone Number ID for this clinic |
| META_ACCESS_TOKEN | Meta System User access token |
| WHATSAPP_GATEWAY_SECRET | must match Cloudflare's HAMZAWE_GATEWAY_SECRET |

### Critical distinction

Cloudflare's:

```
HAMZAWE_GATEWAY_SECRET
```

must equal Apps Script's:

```
WHATSAPP_GATEWAY_SECRET
```

The Meta access token is **not** the gateway secret.

---

# 10. The four-key deployment contract

There are two different credential groups.

## Cloudflare — four secrets

```
META_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
HAMZAWE_WEBHOOK_URL
HAMZAWE_GATEWAY_SECRET
```

## Apps Script — four properties

```
META_GRAPH_API_VERSION
META_PHONE_NUMBER_ID
META_ACCESS_TOKEN
WHATSAPP_GATEWAY_SECRET
```

A deployment is not considered configured until both groups are complete.

---

# 11. Exact testing sequence

Do not test the whole system randomly.

Use this gate order.

## Gate A — Meta phone identity

Verify:

- Phone Number ID exists.
- Phone is verified.
- Phone belongs to the intended WABA.
- GET phone object succeeds.

**PASS → continue.**

---

## Gate B — WABA subscription

Verify:

- intended Meta App is subscribed to the WABA;
- webhook application is the intended application.

**PASS → continue.**

---

## Gate C — direct Meta send

Using the same current token and Phone Number ID:

1. Perform a direct Graph API POST.
2. Confirm HTTP success.
3. Confirm Meta returns a message ID.
4. Confirm the message reaches WhatsApp.

If this fails, do not debug HAMZAWE yet.

---

## Gate D — Cloudflare inbound

Send a WhatsApp message to the clinic number.

Verify:

- Meta sends the webhook;
- Worker receives it;
- Worker validates Meta signature;
- Worker produces the gateway envelope;
- Worker forwards to Apps Script.

---

## Gate E — Apps Script parser

Verify:

- `doPost` executes;
- gateway version is valid;
- timestamp is fresh;
- gateway secret is present;
- gateway HMAC matches;
- message ID exists;
- phone normalizes successfully.

### Unicode regression test

Always test at least:

1. English text.
2. Arabic text.
3. A mixed Arabic/English message if the clinic workflow can produce one.

This gate exists because the production failure encountered during migration affected Arabic/non-ASCII content while English text continued to work.

---

## Gate F — business flow

Test the actual workflow:

1. Start booking.
2. Provide requested information.
3. Complete booking.
4. Confirm outbound reply.
5. Confirm conversation persistence.
6. Confirm Attendance can read/use the resulting data.

Only after this gate is PASS should the clinic be considered operational.

---

# 12. Failure modes already encountered and their prevention

## Failure 1 — wrong Phone Number ID

**Symptom:** Meta returned HTTP 400 / code 100 Authorization Error despite apparently valid credentials.

**Cause:** the runtime Apps Script Phone Number ID was wrong.

**Prevention:**

Always verify:

```
META_PHONE_NUMBER_ID
        =
Meta's actual current Phone Number ID
```

Do not infer it from:

- WABA ID;
- App ID;
- old UltraMsg number;
- old test-number ID;
- screenshots.

---

## Failure 2 — old/expired token

**Symptom:** HTTP 401 / OAuthException code 190.

**Prevention:**

Validate the token directly before changing application code.

---

## Failure 3 — Apps Script ↔ Cloudflare gateway HMAC mismatch

**Symptom:** inbound event reaches the system but `WEBHOOK_PARSE_FAILED` occurs.

**Critical discovery:** Arabic content failed while English content worked.

**Root cause:** the Apps Script HMAC computation was not explicitly aligned to the Cloudflare Worker UTF-8 representation.

**Fix:**

Apps Script now explicitly uses:

```
Utilities.Charset.UTF_8
```

for HMAC calculation.

The Worker uses UTF-8 via `TextEncoder`.

**Do not weaken the signature by excluding message text from the signed event.**

---

## Failure 4 — stale diagnostic rows

Old `WEBHOOK_PARSE_FAILED` rows may describe historical failures.

Never treat an old diagnostic row as evidence of a current failure without checking:

- timestamp;
- gateway age;
- row number;
- current deployment version;
- whether the failure occurred during the current test.

---

## Failure 5 — Apps Script runtime mismatch

An old file named `whatsapp-meta-gateway.gs` produced:

```
ReferenceError: require is not defined
```

The file was deleted.

**Rule:** Apps Script code must match the Apps Script runtime and must not assume Node/CommonJS APIs such as `require()`.

---

## Failure 6 — direct Graph works but HAMZAWE fails

Do not immediately regenerate Meta credentials.

Compare:

1. Phone Number ID.
2. Graph version.
3. token source.
4. endpoint.
5. request body.
6. Apps Script runtime.
7. actual `WhatsAppAdapter.sendText()` path.
8. provider error code/subcode/fbtrace ID.

The V6 diagnostic was created specifically to isolate this class of contradiction.

---

# 13. Production diagnostic rule

Diagnostics must never expose:

- access tokens;
- App Secrets;
- Gateway Secrets;
- Authorization headers;
- full patient/user phone numbers;
- raw sensitive message content.

Safe diagnostics may use:

- SHA-256 fingerprints;
- lengths;
- presence flags;
- HTTP status;
- Meta error code;
- Meta error subcode;
- error type;
- provider trace ID;
- deployment/version identifiers.

---

# 14. Per-clinic duplication strategy — current architecture

The proposed interim strategy is technically viable **only if each clinic remains an isolated deployment**.

For Clinic A:

```
Clinic A WhatsApp number
        ↓
Clinic A Meta assets
        ↓
Clinic A Cloudflare Worker
        ↓
Clinic A Apps Script
        ↓
Clinic A Google Sheets
```

For Clinic B:

```
Clinic B WhatsApp number
        ↓
Clinic B Meta assets
        ↓
Clinic B Cloudflare Worker
        ↓
Clinic B Apps Script
        ↓
Clinic B Google Sheets
```

This preserves the current single-tenant architecture.

## Important consequence

Copying only the Apps Script is **not sufficient**.

The current Cloudflare Worker has:

```
HAMZAWE_WEBHOOK_URL
```

as its forwarding destination.

Therefore, if Clinic B receives a webhook through the same Worker, the current single-tenant Worker does not automatically know that the event belongs to Clinic B.

### Therefore the safe interim model is:

**one clinic = one isolated Meta configuration + one Apps Script + one Worker configuration/deployment**

unless the Worker is deliberately redesigned as a multi-tenant router.

---

# 15. Recommended clinic onboarding template

For each clinic create a private record:

```
CLINIC_ID:
CLINIC_NAME:
OPERATIONAL_EMAIL:
PHONE_NUMBER:

META:
  BUSINESS_PORTFOLIO_ID:
  WABA_ID:
  PHONE_NUMBER_ID:
  APP_ID:
  GRAPH_API_VERSION:
  SYSTEM_USER:

CLOUDFLARE:
  WORKER_NAME:
  WEBHOOK_URL:
  META_APP_SECRET: [SECRET — NEVER COMMIT]
  META_WEBHOOK_VERIFY_TOKEN: [SECRET — NEVER COMMIT]
  HAMZAWE_WEBHOOK_URL: [SECRET — NEVER COMMIT]
  HAMZAWE_GATEWAY_SECRET: [SECRET — NEVER COMMIT]

APPS_SCRIPT:
  PROJECT:
  DEPLOYMENT_URL:
  META_GRAPH_API_VERSION:
  META_PHONE_NUMBER_ID:
  META_ACCESS_TOKEN: [SECRET — NEVER COMMIT]
  WHATSAPP_GATEWAY_SECRET: [SECRET — NEVER COMMIT]

VALIDATION:
  Meta phone verified: PASS/FAIL
  WABA subscribed: PASS/FAIL
  Direct Graph send: PASS/FAIL
  Cloudflare inbound: PASS/FAIL
  English inbound: PASS/FAIL
  Arabic inbound: PASS/FAIL
  Booking flow: PASS/FAIL
  Outbound reply: PASS/FAIL
  Attendance: PASS/FAIL
```

---

# 16. What must NOT be copied blindly between clinics

Never copy these values from Clinic A into Clinic B:

- Meta access token;
- Meta App Secret;
- Meta Verify Token;
- Phone Number ID;
- WABA ID;
- Gateway Secret;
- Apps Script deployment URL;
- Cloudflare `HAMZAWE_WEBHOOK_URL`.

Code can be copied.

**Identity and credentials cannot.**

---

# 17. Business verification and document-integrity gate

The reference deployment reached functional testing without completing full Meta Business Verification.

For the current project, **do not treat falsified documents as an operational workaround**. Meta's current policy requires accurate business identity information and prohibits impersonation or misleading affiliation. [Source: WhatsApp Business Messaging Policy, updated September 23, 2026]

If verification is unavailable, the runbook remains valid for the currently permitted/tested scope, but clinic-count expansion must stop at the account's actual Meta limit rather than being achieved through fabricated identity/documentation.

Legitimate fallback paths to evaluate later are:

1. operate within the number limit Meta currently grants this account;
2. have a genuinely separate clinic/business onboard its own Meta business assets where appropriate;
3. use Meta's supported partner/solution-provider onboarding path if HAMZAWE is later offered as a service to independent businesses. WhatsApp's current FAQ distinguishes direct API access for one's own business from providing API access to other businesses. [Source: WhatsApp Business FAQ — direct API access / partner onboarding]

This is a **governance boundary**, not a coding limitation.

---

# 18. WhatsApp policy constraints relevant to HAMZAWE

The technical system being operational does not remove Meta policy requirements.

Current WhatsApp Business policy states, among other things:

- business-initiated conversations require approved message templates;
- user-initiated conversations can be answered without a template during the applicable 24-hour customer-service window;
- automated responses are permitted during that window, but an appropriate human escalation path is expected;
- businesses must obtain required consent/opt-in and respect opt-out requests;
- applicable privacy and data-protection obligations remain the business's responsibility.

For clinic deployments, there is an additional important healthcare-data consideration: WhatsApp's policy restricts certain healthcare/telemedicine uses where applicable regulations prohibit the use of systems that do not meet the required health-information protections.

This must be reviewed before moving from technical testing into real patient-data operation.

---

# 19. Cloudflare production recommendation

The current `workers.dev` endpoint works for the current deployment.

Cloudflare currently recommends Workers routes or Custom Domains for production applications rather than relying on a `workers.dev` subdomain for business-critical workloads.

For the current controlled phase, do not change the public endpoint merely for aesthetics.

When production hardening begins, evaluate:

- Custom Domain;
- DNS ownership;
- TLS;
- Worker environment separation;
- secret management;
- deployment/version control;
- rollback procedure.

Cloudflare Custom Domains can create the required DNS record and certificate automatically when the Worker is the origin.

---

# 20. Future multi-clinic architecture

The current duplication strategy is an **interim validation strategy**, not the final architecture.

When the project can support a more capable stack, the target should become:

```
                    ┌── Clinic A Meta/WABA/Phone
                    │
                    ├── Clinic B Meta/WABA/Phone
                    │
Meta Webhooks ──────┤
                    ├── Clinic C Meta/WABA/Phone
                    │
                    └── ...
                              ↓
                    Multi-tenant webhook gateway
                              ↓
                    Tenant resolution
                              ↓
                    Tenant configuration
                              ↓
                    Shared application services
                              ↓
                    Clinic-specific data isolation
```

The tenant identity should be resolved from a stable Meta-side identifier such as the configured phone/WABA context, not from an arbitrary user-supplied field.

The future system should separate:

- tenant identity;
- Meta credentials;
- phone/WABA configuration;
- conversation storage;
- clinic data;
- business rules;
- AI configuration;
- audit/logging;
- permissions.

---

# 21. Future AI response layer

Adding an AI reply capability later should be treated as a separate architectural layer.

The future flow should resemble:

```
Incoming WhatsApp message
        ↓
Tenant resolution
        ↓
Security / policy checks
        ↓
Conversation state
        ↓
Business-rule decision
        ↓
AI assistance where allowed
        ↓
Human/business-policy guard
        ↓
WhatsApp response
```

AI must not become the authority for:

- appointment availability;
- booking state;
- cancellation state;
- patient identity;
- authorization;
- medical decisions.

The deterministic HAMZAWE business layer should remain authoritative. AI can interpret language and assist with responses, but should not silently replace the source of truth.

---

# 22. Reprovisioning checklist — condensed version

When onboarding a new clinic:

### Meta

- [ ] Clinic number confirmed
- [ ] Confirm clinic ownership/authorization model
- [ ] Confirm current account phone-number limit
- [ ] Confirm whether the number can be added to the intended WABA
- [ ] Number migrated/registered appropriately
- [ ] WhatsApp Business registration complete
- [ ] Meta Business Portfolio identified
- [ ] WABA created/identified
- [ ] Phone Number ID verified
- [ ] Meta App identified
- [ ] WABA subscribed to app
- [ ] If Meta App/WABA is shared, record the clinic Phone Number ID explicitly
- [ ] Confirm webhook routing model before production
- [ ] System User configured
- [ ] Access token generated
- [ ] Direct phone GET succeeds
- [ ] Direct Graph POST succeeds

### Cloudflare

- [ ] Worker/gateway model selected: isolated or approved shared router
- [ ] Worker created/deployed
- [ ] META_APP_SECRET configured
- [ ] META_WEBHOOK_VERIFY_TOKEN configured
- [ ] HAMZAWE_WEBHOOK_URL configured
- [ ] HAMZAWE_GATEWAY_SECRET configured
- [ ] /healthz succeeds
- [ ] Meta webhook verification succeeds

### Apps Script

- [ ] Dedicated project/account created
- [ ] Current HAMZAWE code synchronized
- [ ] META_GRAPH_API_VERSION configured
- [ ] META_PHONE_NUMBER_ID configured
- [ ] META_ACCESS_TOKEN configured
- [ ] WHATSAPP_GATEWAY_SECRET configured
- [ ] doPost deployment accessible

### End-to-end

- [ ] inbound English message
- [ ] inbound Arabic message
- [ ] booking flow
- [ ] outbound reply
- [ ] conversation persistence
- [ ] Attendance
- [ ] no new SYSTEM_LOG failure
- [ ] rollback point recorded

---

# 23. Golden rule for future troubleshooting

When something fails, classify the layer first.

```
NUMBER REGISTRATION
        ↓
META ASSETS
        ↓
TOKEN / PERMISSIONS
        ↓
META WEBHOOK
        ↓
CLOUDFLARE
        ↓
GATEWAY HMAC
        ↓
APPS SCRIPT
        ↓
BUSINESS LOGIC
        ↓
META OUTBOUND
        ↓
WHATSAPP DELIVERY
```

Never change several layers simultaneously.

One failed gate → isolate that gate → prove it → freeze it → continue.

This is the main lesson from the migration.

---

# 24. Current governance state

The system has now demonstrated:

- inbound delivery;
- gateway verification;
- Arabic/non-ASCII handling;
- booking completion;
- outbound messaging;
- Attendance compatibility.

The diagnostic PR that was used during the investigation remains separate from this operational documentation and should not be treated as automatically merge-approved.

The UTF-8 HMAC change should be retained as part of the production code path because it was exercised successfully by the Arabic booking test.

---

# 25. Source references

Meta / WhatsApp:

- Meta's 2026 WhatsApp account-model material: a WABA can contain multiple phone numbers. [Source: Meta — WhatsApp Business account model]
- Meta's 2026 WhatsApp Account Model Evolution material. [Source: Meta — WhatsApp Account Model Evolution]
- WhatsApp Business Messaging Policy, updated September 23, 2026. [Source: WhatsApp Business Messaging Policy, updated September 23, 2026]
- WhatsApp Business FAQ covering direct API access and partner onboarding. [Source: WhatsApp Business FAQ — direct API access / partner onboarding]

Operational limit note:

- Current third-party documentation reports a 2-number ceiling for unverified Meta business accounts and higher limits after verification/approval; this limit must be rechecked against the actual Meta account at each onboarding event. [Operational limit references: Sinch and Twilio documentation; verify live Meta account limit before onboarding]

The runbook intentionally does not store any credential values. Meta account limits and onboarding rules are subject to change and must be verified against the live account before each new clinic.

This runbook intentionally does not store any credential values.
