# HAMZAWE WhatsApp Meta Webhook Gateway

The gateway is the P0 security boundary between Meta WhatsApp Cloud API and the HAMZAWE Apps Script Web App.

## Production runtime

The production deployment target is **Cloudflare Workers**:

- Worker entry: gateway/cloudflare-worker.mjs
- Wrangler config: wrangler.jsonc
- Cloudflare deployment guide: gateway/CLOUDFLARE_DEPLOYMENT.md

Request flow:

Meta
  -> GET /webhook (verification)
  -> POST /webhook + X-Hub-Signature-256
  -> normalized MESSAGE event
  -> HMAC-signed HAMZAWE envelope
  -> Apps Script doPost

The Worker also exposes /healthz for deployment/configuration checks.

## Required secrets

Cloudflare Worker Secrets:

- META_APP_SECRET
- META_WEBHOOK_VERIFY_TOKEN
- HAMZAWE_WEBHOOK_URL
- HAMZAWE_GATEWAY_SECRET

Do not commit secret values.

## Runtime contract

The gateway:

1. Verifies Meta GET webhook challenges.
2. Verifies Meta POST authenticity with X-Hub-Signature-256.
3. Normalizes WhatsApp Cloud message events into a provider-neutral HAMZAWE event.
4. Keeps Meta wamid as messageId.
5. Does not forward STATUS events to Apps Script business processing.
6. Forwards message events to HAMZAWE through an HMAC-SHA256 signed envelope.
7. Leaves Router and business logic entirely inside Apps Script.

HAMZAWE independently verifies the gateway HMAC and rejects stale or invalid envelopes.

The current migration supports TEXT business processing. Unsupported inbound message types are acknowledged/logged by HAMZAWE without entering business logic until a future explicit contract is authorized.

## Local/reference Node runtime

gateway/whatsapp-meta-gateway.js remains the Node.js standard-library reference implementation used by the migration tests. The Cloudflare Worker is the production runtime adapter for the same gateway contract.
