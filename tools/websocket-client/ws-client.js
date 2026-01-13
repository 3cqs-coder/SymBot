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


function sendApiAction(api, payload = {}, timeoutMs = 10000) {

    const id = uuidv4();

    return new Promise((resolve, reject) => {

        pending.set(id, resolve);

        socket.emit("api_action", {
            meta: { id, appId, api },
            ...payload
        });

        setTimeout(() => {

            if (pending.has(id)) {

                pending.delete(id);

                reject(new Error("Timeout waiting for reply: " + id));
            }
        }, timeoutMs);
    });
}


socket.on("data", (msg) => {

    if (msg.type === "api" && msg.message_id_client) {

        const resolve = pending.get(msg.message_id_client);

        if (resolve) {

            pending.delete(msg.message_id_client);

            resolve(msg);
        }
    }

    if (msg.type && (showTypes.size === 0 || showTypes.has(msg.type))) {

        console.log(msg);
    }
});


socket.on("connect", async () => {

    console.log("Connected to server");

    socket.emit("joinRooms", { rooms });
    socket.emit("register_client", { appId });

    if (!didStart) {

        didStart = true;

        await start();
    }
});


socket.on("connect_error", (err) => console.error("Connect error:", err.message));
socket.on("disconnect", (reason) => console.warn("Disconnected:", reason));
socket.on("error", (err) => console.error("Socket error:", err));


async function start() {

    try {

        const deals = await sendApiAction("deals");
        console.log("Deals response:", deals);

        const market = await sendApiAction("markets", { exchange: "coinbase", pair: "BTC/USDT" });
        console.log("Market response:", market);

        const ohlcv = await sendApiAction("markets/ohlcv", { exchange: "bitget", pair: "ETH/USDT", limit: 10 });
        console.log("OHLCV response:", ohlcv);
    }
    catch (err) {
 
        console.error("API error:", err.message);
    }
}
