# WebSocket API Client

This tool is a simple Node.js example demonstrating how to connect to the SymBot WebSocket API and make API requests over a live connection.

## What This Script Does

- Connects to a SymBot instance or SymBot Hub using WebSockets
- Authenticates using an API key
- Registers the application with the server
- Optionally joins log and notification channels
- Sends API requests over WebSocket
- Receives and prints API responses in real time

The connection type (direct or Hub) can be changed using a single flag.

## Quick Start

1. Install dependencies:

```bash

npm install socket.io-client

```

2. Open the script and set your API key:

```js

const  apiKey = "{API-KEY}";

```

Create a **scoped** key under **Configuration → Access Control → API Keys** and paste the
full `symb_live_…` value here. The key needs only the capabilities your WebSocket calls use
(a read-only key is enough for reading deals/logs); calls it isn't scoped for are rejected.

3. (Optional) Enable SymBot Hub:

```js

const  useHub = true;

```

4. Run the script:

```bash

node ws-client.js

```

## Read-only API (no idempotency needed)

The WebSocket API is **read-only** — its actions (`deals`, `deals/show`, `deals/completed`, `bots`,
`balances`, `markets`, `markets/ohlcv`) only fetch data and never open, fund, or close a deal. Because
replaying a read has no side effect, write-safety features such as an **`Idempotency-Key`** do not
apply here — there is nothing to deduplicate. That protection belongs on the one state-changing
surface, the Signal Bot webhook; see [../signal-bot/](../signal-bot/). If a state-changing WebSocket
action is ever added, it would be capability-gated (and would then warrant the same idempotency
handling).

## Notes

- This script is intended as a reference and testing tool.
- Not intended for production use without modification.
