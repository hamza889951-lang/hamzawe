# HAMZAWE WhatsApp Meta Webhook Gateway

This gateway is the P0 security boundary between Meta WhatsApp Cloud API and the HAMZAWE Apps Script Web App.

Required environment variables:
- META_APP_SECRET
- META_WEBHOOK_VERIFY_TOKEN
- HAMZAWE_WEBHOOK_URL
- HAMZAWE_GATEWAY_SECRET
- optional PORT (default 8080)

Request flow:

Meta
  -> GET /webhook (verification)
  -> POST /webhook + X-Hub-Signature-256
  -> normalized MESSAGE event
  -> signed HAMZAWE envelope
  -> Apps Script doPost

The gateway never calls Router or any business service.

The current migration supports TEXT business processing. Non-text message types are forwarded as normalized events and then ignored by HAMZAWE until a future explicit interactive/media contract is implemented.

The gateway signs each normalized event using HMAC-SHA256 and HAMZAWE_GATEWAY_SECRET. HAMZAWE independently verifies that signature and rejects stale gateway envelopes.

This file uses only Node.js standard library so it can be deployed on a Node.js 20 compatible runtime without adding provider-specific application dependencies.
