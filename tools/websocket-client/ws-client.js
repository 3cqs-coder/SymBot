const { io } = require("socket.io-client");
const crypto = require("crypto");


let useHub = false;
let hubPort = 3100;

let port = 3000;
let host = 'http://127.0.0.1';
let apiKey = '';

let webSocketPath;

if (useHub) {

    host = host + ':' + hubPort;
    webSocketPath = '/instance/' + port + '/ws';
}
else {

    host = host + ':' + port;
    webSocketPath = '/ws';
}

const appId = "App-" + uuidv4().slice(0, 6);

let rooms = ["logs", "notifications"];
let showTypes = new Set(["api", "log", "notification"]);

let didStart = false;
const pending = new Map();


const args = process.argv.slice(2);

args.forEach(arg => {

    if (arg.startsWith("--show=")) {

        showTypes = new Set(arg.replace("--show=", "").split(","));
    }
});


function uuidv4() {

    if (crypto.randomUUID) return crypto.randomUUID();

    const bytes = crypto.randomBytes(16);

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");

    return (
        hex.substr(0, 8) + "-" +
        hex.substr(8, 4) + "-" +
        hex.substr(12, 4) + "-" +
        hex.substr(16, 4) + "-" +
        hex.substr(20, 12)
    );
}


const socket = io(host, {
    path: webSocketPath,
    extraHeaders: { "api-key": apiKey, "user-agent": "WebSocket Client/1.0" },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 5000
});


// Server enforces a 15-second handler timeout and guarantees a response for
// every request. Set the client timeout slightly above that so the server
// always has a chance to respond before the client gives up.
function sendApiAction(api, payload = {}, timeoutMs = 20000) {

    const id = uuidv4();

    return new Promise((resolve, reject) => {

        pending.set(id, { resolve, reject });

        socket.emit("api_action", {
            meta: { id, appId, api },
            ...payload
        });

        setTimeout(() => {

            if (pending.has(id)) {

                pending.delete(id);

                reject(new Error("Client timeout waiting for reply: " + api));
            }
        }, timeoutMs);
    });
}


socket.on("data", (msg) => {

    if (msg.type === "api" && msg.message_id_client) {

        const entry = pending.get(msg.message_id_client);

        if (entry) {

            pending.delete(msg.message_id_client);

            // Resolve or reject based on whether the server returned an error
            if (msg.error) {

                entry.reject(new Error(msg.error));
            }
            else {

                entry.resolve(msg);
            }
        }
    }

    if (msg.type && (showTypes.size === 0 || showTypes.has(msg.type))) {

        console.log(msg);
    }
});


socket.on("connect", () => {

    console.log("Connected to server");

    socket.emit("joinRooms", { rooms });

    // Register and wait for the server acknowledgement before sending any
    // api_action events. The server only accepts api_action from registered
    // clients — sending before registration completes will return an error.
    socket.emit("register_client", { appId }, async (ack) => {

        if (!ack?.success) {

            console.error("Registration failed — cannot send API requests");
            return;
        }

        console.log("Registered successfully");

        if (!didStart) {

            didStart = true;

            await start();
        }
    });
});


socket.on("connect_error", (err) => console.error("Connect error:", err.message));
socket.on("disconnect", (reason) => console.warn("Disconnected:", reason));
socket.on("error", (err) => console.error("Socket error:", err));


async function start() {

    try {

        // Active deals
        const deals = await sendApiAction("deals");
        console.log("Active deals:", deals);

        // Completed deals (most recent 100 if no date range given)
        const completed = await sendApiAction("deals/completed");
        console.log("Completed deals:", completed);

        // Single deal by ID
        // const deal = await sendApiAction("deals/show", { dealId: "{dealId}" });
        // console.log("Deal:", deal);

        // All bots (omit active to get all)
        const bots = await sendApiAction("bots", { active: true });
        console.log("Bots:", bots);

        // Account balances
        const balances = await sendApiAction("balances");
        console.log("Balances:", balances);

        // Market ticker
        const market = await sendApiAction("markets", { exchange: "coinbase", pair: "BTC/USD" });
        console.log("Market:", market);

        // OHLCV candles
        const ohlcv = await sendApiAction("markets/ohlcv", { exchange: "bitget", pair: "ETH/USDT", limit: 10 });
        console.log("OHLCV:", ohlcv);
    }
    catch (err) {

        console.error("API error:", err.message);
    }
}
