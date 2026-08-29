# Tools

Small utility scripts that demonstrate how to interact with SymBot services and APIs. They
are simple, practical examples you can run locally or use as references when building your own
integrations.

- **[signal-bot/](signal-bot/)** — drive a Signal Bot (start / fund / close deals) via the
  webhook, from your own code or a third-party alert.
- **[websocket-client/](websocket-client/)** — connect to the real-time WebSocket API.

## Authentication

SymBot has two credential types; pick the one for the surface you're calling.

### Scoped API keys (the HTTP + WebSocket API)

Create keys under **Configuration → Access Control → API Keys**. Each key is:

- **Scoped** — you grant it only the capabilities it needs (e.g. a read-only reporting key vs
  a key that can start/stop bots). A key can never exceed your own permissions.
- **Shown once** — copy the full `symb_live_…` key at creation; only a hash is stored.
- **Revocable / disable-able** at any time, with last-used tracking in the audit log.

Send the key as a header (the request is rejected, `403`, on any route the key isn't scoped
for):

```bash
# either header works
curl -H "api-key: symb_live_xxxx" http://localhost:3000/api/deals
curl -H "Authorization: Bearer symb_live_xxxx" http://localhost:3000/api/deals
```

For the WebSocket API, pass the key as the `api-key` handshake header (see
[websocket-client/](websocket-client/)).

### Webhook credential (the Signal Bot webhook)

The Signal Bot webhook (`/webhook/api/signal/:botId`) authenticates with a token sent as
`apiToken` in the JSON body (the body is used because senders such as TradingView cannot set
custom headers). That token can be **either**:

- a **scoped API key** (Access Control → API Keys) with the **`deal.create`** capability —
  recommended, since it can be revoked or rotated on its own; or
- the legacy **Webhook API Token** from **Configuration → Webhook API Token** (deprecated, kept
  for backward compatibility).

A header-capable sender may instead pass the same value as an `api-token`/`api-key` header. See
[signal-bot/](signal-bot/).

Because the webhook changes money, it accepts an optional **`Idempotency-Key`** header (or a
`signal_id` / `idempotency_key` body field) so a retried signal is ignored rather than opening or
funding a deal twice — see [signal-bot/](signal-bot/). The read-only WebSocket API has no
state-changing actions, so idempotency does not apply there.

> Both credentials are sensitive. Keep them out of source control, and revoke/rotate on any
> suspected exposure. Every key/user change and state-changing action is recorded in the audit
> log (Access Control → Audit Log).
