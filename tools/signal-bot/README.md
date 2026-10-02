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

- **`apiToken`** — the webhook credential. It can be either a scoped API key
  (Access Control → API Keys) with the `deal.create` capability — recommended, since it can
  be revoked or rotated on its own — or the legacy Webhook API Token from
  Configuration → Webhook API Token (kept for backward compatibility). A header-capable
  sender may instead pass the same value as an `api-token`/`api-key` header (checked before the
  body). See [../README.md](../README.md).
- **`action`** — one of `entry`, `add_funds`, `close`, `panic_sell`, `close_all`.
- **`pair`** — the trading pair, e.g. `BTC/USD`.
- **`volume`** — for `add_funds`, the amount to add (must be > 0).
- **`deal_id`** *(optional)* — target one specific deal for `add_funds` / `close` / `panic_sell` /
  `close_all` when the bot runs several. Use the `deal_id` that the `entry` action returned; `dealId` also
  works. Omit it to let the server resolve the bot's single active deal, which errors if several are open.
- **`dry_run`** *(optional)* — `true` validates the signal without executing it (see [Dry run](#dry-run)).
- **`timestamp`** *(optional)* — epoch seconds or milliseconds, or an `X-Signal-Timestamp` header, for the
  [staleness](#rejecting-stale-signals) check.

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
`--idempotency-key` flag when you want to prove a resend is ignored:

```bash
node signal-bot.js entry BTC/USD --token your_token --bot my-bot --idempotency-key my-fixed-id   # opens the deal
node signal-bot.js entry BTC/USD --token your_token --bot my-bot --idempotency-key my-fixed-id   # duplicate — ignored
```

> The WebSocket API ([../websocket-client/](../websocket-client/)) is read-only and takes no
> state-changing actions, so idempotency does not apply there — only this webhook does.

## Rejecting stale signals

Idempotency stops a *duplicate* from acting twice; staleness stops a *late* signal from acting at all. If a
bot has **`webhook.max_age_seconds`** configured, a signal is dropped when its timestamp is older than that
(for example an alert that was queued or replayed long after the moment it described). Supply the send time as
a **`timestamp`** body field (epoch seconds or milliseconds) or an **`X-Signal-Timestamp`** header; the server
replies `{ stale: true, reason: "too_old" | "future", ageSec }` and does nothing. When `max_age_seconds` is
not set, the timestamp is ignored, so sending it is always safe — this sample stamps it on every request.

## Dry run

Add **`dry_run: true`** (the sample's `--dry-run` flag) to VALIDATE a signal without executing it: the server
runs the same auth, capability, and deal-target checks, then returns the plan it *would* have run —

```jsonc
{ "success": true, "dry_run": true,
  "would": { "action": "close", "botId": "my-bot", "dealId": "…", "pair": "BTC/USD", "signal_id": "…" } }
```

— but starts, funds, or closes nothing. It is the safe way to test wiring, a token's scopes, or a target
before sending the real thing.

```bash
node signal-bot.js close BTC/USD --token your_token --bot my-bot --dry-run
node signal-bot.js add_funds BTC/USD 25 --token your_token --bot my-bot --deal-id <DEAL_ID> --dry-run
```

## Batching several actions

To run several actions from one alert, POST an **`actions`** array instead of a single action (at most 10,
executed **in order**). Each entry is a normal action object, and a top-level `dry_run` applies to every one
(an entry may override it):

```jsonc
POST {BASE_URL}/webhook/api/signal/{BOT_ID}
{
  "apiToken": "<webhook token>",
  "actions": [
    { "action": "add_funds", "pair": "BTC/USD", "volume": 25 },
    { "action": "close",     "pair": "ETH/USD" }
  ]
}
```

The reply aggregates the results and reports overall success only when every sub-action succeeded:

```jsonc
{ "batch": true, "count": 2, "success": true,
  "results": [ { "index": 0, "action": "add_funds", "status": 200, "result": { "success": true, … } },
               { "index": 1, "action": "close",     "status": 200, "result": { "success": true, … } } ] }
```

Each sub-action is independently gated (capability, ownership, active-deal check) and the batch continues on a
sub-action failure rather than aborting — so a re-run of an already-completed action is refused, not repeated.

## Confirming what a signal did

A sender like TradingView fires the webhook and never shows you the reply. To see what actually
happened after the fact, open the **Signal Activity** page in SymBot (or call
`GET /api/signals/activity` with a `deal.read`-scoped key). It records every authenticated signal and
its outcome — a deal *started*, funds *processed*, *rejected* (with the reason, e.g. a pair limit or an
active circuit breaker), or a *duplicate* ignored by idempotency. Only authenticated signals are
recorded, so if a signal never appears there at all, the token is wrong or webhooks are disabled.

## Usage

Configure the connection with CLI flags (preferred):

```bash
node signal-bot.js entry BTC/USD --base-url http://localhost:3000 --token your_token --bot my-bot
node signal-bot.js add_funds BTC/USD 25 --token your_token --bot my-bot
node signal-bot.js close BTC/USD --token your_token --bot my-bot
node signal-bot.js panic_sell BTC/USD --token your_token --bot my-bot
```

Flags: `--base-url`, `--token`, `--bot`, `--idempotency-key`, `--deal-id`, `--dry-run`. The environment
variables `BASE_URL`, `WEBHOOK_TOKEN`, `BOT_ID`, `IDEMPOTENCY_KEY`, `DEAL_ID`, and `DRY_RUN` are still honored
as a fallback for existing setups.

## Actions

| Action | Effect |
| --- | --- |
| `entry` | Start a new deal on the bot for the pair. |
| `add_funds` | Add funds (a manual safety order) to the open deal. Requires `volume > 0`. |
| `close` | Close the deal **only if** its take-profit target is met (otherwise reports why). |
| `panic_sell` | Force-close the deal immediately, regardless of profit. |
| `close_all` | An alias of `panic_sell`, not a whole-book liquidation: it force-closes the bot's single resolved active deal regardless of profit, and errors if several deals are open (target one by pair, or with the `deal_id` field). It is not the take-profit-respecting `close`. |

> This is a reference example. Treat the webhook token like a password — anyone with it can
> start and close deals on that bot. Keep it out of source control and rotate it if exposed.
