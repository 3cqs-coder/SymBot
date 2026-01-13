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

3. (Optional) Enable SymBot Hub:

```js

const  useHub = true;

```

4. Run the script:

```bash

node ws-client.js

```

## Notes

- This script is intended as a reference and testing tool.
- Not intended for production use without modification.
