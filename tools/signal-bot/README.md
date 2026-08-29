# Signal Bot — sample client

A minimal, dependency-free Node.js example of driving a SymBot **Signal Bot** from your own
code or a third-party alert (e.g. TradingView). It posts signals to the Signal Bot webhook,
which starts, funds, and closes deals on the bot you target.

## Endpoint & auth

```
POST {BASE_URL}/webhook/api/signal/{BOT_ID}
Content-Type: application/json

{ "apiToken": "<webhook token>", "action": "entry", "pair": "BTC/USD" }
```

- **`apiToken`** — the webhook credential. It can be **either** a scoped **API key**
  (Access Control → API Keys) with the **`deal.create`** capability — recommended, since it can
  be revoked or rotated on its own — **or** the legacy **Webhook API Token** from
  **Configuration → Webhook API Token** (kept for backward compatibility). A header-capable
  sender may instead pass the same value as an `api-token`/`api-key` header (checked before the
  body). See [../README.md](../README.md).
- **`action`** — one of `entry`, `add_funds`, `close`, `panic_sell`, `close_all`.
- **`pair`** — the trading pair, e.g. `BTC/USD`.
- **`volume`** — for `add_funds`, the amount to add (must be > 0).

The response is JSON `{ success, data, ... }`; `entry` returns a `deal_id`, and `close`
returns `closed: true|false` with a reason when the take-profit target isn't met.

## Safe retries (idempotency)

Signals change money — an `entry` opens a deal, `add_funds` funds one — so a blind retry after a
dropped connection risks doing it twice. To make retries safe, send a **stable idempotency key** and
reuse it if you resend:

- as an **`Idempotency-Key`** header (preferred — kept out of request-body logs), or
- as a **`signal_id`** (or `idempotency_key`) field in the JSON body, for senders such as TradingView
  that cannot set custom headers.

If the same key reaches the same bot again within a few minutes, the server ignores the repeat and
replies `{ success: true, duplicate: true }` instead of opening or funding a second deal. The key is
scoped per bot, so the same id sent to two different bots is not cross-deduplicated.

The sample generates one key per run and reuses it across a single automatic retry (so a first attempt
that actually landed is never acted on twice). Pin a key across separate runs with the
`IDEMPOTENCY_KEY` environment variable when you want to prove a resend is ignored:

```bash
IDEMPOTENCY_KEY=my-fixed-id node signal-bot.js entry BTC/USD   # opens the deal
IDEMPOTENCY_KEY=my-fixed-id node signal-bot.js entry BTC/USD   # duplicate — ignored
```

> The WebSocket API ([../websocket-client/](../websocket-client/)) is read-only and takes no
> state-changing actions, so idempotency does not apply there — only this webhook does.

## Confirming what a signal did

A sender like TradingView fires the webhook and never shows you the reply. To see what actually
happened after the fact, open the **Signal Activity** page in SymBot (or call
`GET /api/signals/activity` with a `deal.read`-scoped key). It records every authenticated signal and
its outcome — a deal *started*, funds *processed*, *rejected* (with the reason, e.g. a pair limit or an
active circuit breaker), or a *duplicate* ignored by idempotency. Only authenticated signals are
recorded, so if a signal never appears there at all, the token is wrong or webhooks are disabled.

## Usage

```bash
BASE_URL=http://localhost:3000 WEBHOOK_TOKEN=your_token BOT_ID=my-bot \
  node signal-bot.js entry BTC/USD

node signal-bot.js add_funds BTC/USD 25
node signal-bot.js close BTC/USD
node signal-bot.js panic_sell BTC/USD
```

Environment variables: `BASE_URL`, `WEBHOOK_TOKEN`, `BOT_ID`.

## Actions

| Action | Effect |
| --- | --- |
| `entry` | Start a new deal on the bot for the pair. |
| `add_funds` | Add funds (a manual safety order) to the open deal. Requires `volume > 0`. |
| `close` | Close the deal **only if** its take-profit target is met (otherwise reports why). |
| `panic_sell` | Force-close the deal immediately, regardless of profit. |
| `close_all` | Emergency close of the bot's open deal(s) — an alias of `panic_sell` (force-closes regardless of profit), **not** the take-profit-respecting `close`. |

> This is a reference example. Treat the webhook token like a password — anyone with it can
> start and close deals on that bot. Keep it out of source control and rotate it if exposed.
