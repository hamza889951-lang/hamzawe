# HAMZAWE WhatsApp Gateway — Cloudflare Workers Deployment

This document deploys the existing P0 gateway contract without changing the Apps Script or application layers.

## 1. Cloudflare Worker

Create a Worker from the GitHub repository:

- Repository: hamza889951-lang/hamzawe
- Branch: main for the production Worker
- Wrangler configuration: wrangler.jsonc
- Worker entry: gateway/cloudflare-worker.mjs

Cloudflare Workers Builds can connect a GitHub repository and automatically deploy on push. The Cloudflare dashboard path is:

Workers & Pages → Create application → Get started → Import a repository.

Use the repository root as the project/root directory because wrangler.jsonc is at the repository root.

## 2. Required secrets

Add these as Cloudflare Worker Secrets, not plaintext variables:

- META_APP_SECRET
- META_WEBHOOK_VERIFY_TOKEN
- HAMZAWE_WEBHOOK_URL
- HAMZAWE_GATEWAY_SECRET

Cloudflare exposes these through the Worker's env object.

Do not commit the values to GitHub.

## 3. HAMZAWE_WEBHOOK_URL

Use the currently deployed Apps Script Web App URL ending in /exec.

Example:

https://script.google.com/macros/s/XXXXXXXXXXXXXXXX/exec

Do not use a /dev URL.

## 4. Pre-Meta checks

After deployment, open:

https://<worker-subdomain>/healthz

Expected body:

{"ok":true}

Then verify the webhook endpoint using:

GET /webhook?hub.mode=subscribe&hub.verify_token=<same verify token>&hub.challenge=HAMZAWE_TEST

Expected response:

HAMZAWE_TEST

## 5. Meta configuration

In the Meta App:

WhatsApp → Configuration → Webhooks

Set:

- Callback URL: https://<worker-subdomain>/webhook
- Verify Token: the same META_WEBHOOK_VERIFY_TOKEN

Then use Verify and Save.

Subscribe the WhatsApp Business Account to the app and enable the messages field.

## 6. Apps Script properties

Keep these in Apps Script Script Properties:

- META_GRAPH_API_VERSION
- META_PHONE_NUMBER_ID
- META_ACCESS_TOKEN
- WHATSAPP_GATEWAY_SECRET

WHATSAPP_GATEWAY_SECRET must equal the Cloudflare secret HAMZAWE_GATEWAY_SECRET.

## 7. Canary order

1. Verify Cloudflare /healthz.
2. Verify Meta GET challenge.
3. Subscribe WABA / messages.
4. Send one text message to the Meta test number.
5. Confirm Apps Script SYSTEM_LOG.
6. Confirm Conversations.last_inbound_at_ms.
7. Confirm Conversations.last_inbound_message_id contains the Meta wamid.
8. Confirm the HAMZAWE text reply is received.
9. Only then replace the temporary Meta token with the production System User token.
10. Only then move from the Meta test number to the real clinic number.

## 8. Security boundary

The intended flow is:

Meta
  -> Cloudflare Worker
  -> X-Hub-Signature-256 verification
  -> normalized event
  -> HMAC signed envelope
  -> Apps Script doPost
  -> gateway HMAC verification
  -> ProcessedMessagesService / Router
  -> MessagingPolicyService
  -> Meta Graph API

Meta must never call Apps Script directly.

## 9. Failure interpretation

- /healthz 503: one or more Worker secrets are missing.
- Meta Verify fails: verify Callback URL, Verify Token, and Worker deployment.
- POST returns 401: Meta signature verification failed; do not bypass it.
- POST returns 502: forwarding to Apps Script failed.
- Meta webhook succeeds but no Conversation row updates: inspect Apps Script WEBHOOK_PARSE_FAILED, gateway-auth, Router, or WEBHOOK_* log entries.

Never put access tokens, app secrets, or gateway secrets into chat, GitHub issues, or committed files.
