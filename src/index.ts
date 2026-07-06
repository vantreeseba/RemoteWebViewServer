import http from 'http';
import { WebSocketServer } from "ws"
import env from "env-var";
import { makeConfigFromParams, logDeviceConfig, readInjectScriptConfig } from "./config.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';
import { isCdpHealthy } from './cdpRoot.js';
import { MsgType } from './protocol.js';

const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });
const inputRouter = new InputRouter();

// Liveness: a client that vanishes without a FIN (e.g. ESP32 dropping off
// WiFi) otherwise stays readyState OPEN until the TCP timeout, keeping the
// whole render pipeline running for a dead peer. RFC 6455 requires clients
// to answer pings; terminate after a missed interval (~90s worst case).
const HEARTBEAT_INTERVAL_MS = 45_000;
const alive = new WeakMap<object, boolean>();
setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      console.warn("[server] Terminating unresponsive client");
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    try { ws.ping(); } catch { }
  }
}, HEARTBEAT_INTERVAL_MS);

await bootstrapAsync();

// Warm the inject-script cache so the first device connect doesn't pay the fetch.
const injectCfg = readInjectScriptConfig();
if (injectCfg.url) void getInjectScriptFromUrl(injectCfg);

wss.on("connection", async (ws, req) => {
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));

  const url = new URL(req.url || "", `ws://localhost:${WS_PORT}`);
  const id = url.searchParams.get("id") || "default";

  let dev;
  try {
    const cfg = makeConfigFromParams(url.searchParams);
    logDeviceConfig(id, cfg);

    broadcaster.addClient(id, ws);
    dev = await ensureDeviceAsync(id, cfg);
  } catch (e) {
    // A rejection escaping this async listener would crash the process.
    console.warn(`[server] Failed to set up device ${id}: ${(e as Error).message}`);
    try { ws.close(); } catch { }
    return;
  }

  // Liveness for the idle TTL: with the screencast paused on static pages,
  // frames no longer bump lastActive, so count every sign of a live client —
  // any message and WS pongs — or a connected-but-quiet display gets its
  // device torn down at the 5-minute TTL and freezes.
  ws.on("pong", () => { dev.lastActive = Date.now(); });

  ws.on("message", (msg, isBinary) => {
    if (!isBinary) return;
    dev.lastActive = Date.now();

    const buf: Buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
    switch (buf.readUInt8(0)) {
      case MsgType.Touch:
        inputRouter.handleTouchPacketAsync(dev, buf).catch(e => console.warn(`Failed to handle touch packet: ${(e as Error).message}`));
        break;
      case MsgType.Keepalive:
        // lastActive already bumped above for every message.
        break;
      case MsgType.FrameStats:
        inputRouter.handleFrameStatsPacketAsync(dev, buf).catch(() => console.warn(`Failed to handle Self test packet`));
        break;
      case MsgType.OpenURL:
        inputRouter.handleOpenURLPacketAsync(dev, buf).catch(e => console.warn(`Failed to handle OpenURL packet: ${(e as Error).message}`));
        break;
    }
  })

  // The broadcaster's own once("close"/"error") handlers remove the client;
  // calling removeClient here too double-logged every disconnect.
  ws.on("close", () => {
    dev.lastActive = Date.now();
  })
});

http.createServer(async (req, res) => {
  try {
    if (isCdpHealthy()) {
      res.writeHead(200); res.end('ok');
    } else {
      // Browser connection is gone; report unhealthy so the watchdog
      // (HA add-on / docker healthcheck) restarts us.
      res.writeHead(503); res.end('cdp down');
    }
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
}).listen(HEALTH_PORT);

setInterval(() => cleanupIdleAsync(), 60_000);

console.log(`[server] WebSocket listening on :${WS_PORT}`);
