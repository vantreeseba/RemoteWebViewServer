# AGENTS.md — Remote WebView Server

## Project Overview

Remote WebView Server is a headless-browser streaming server. It renders target
web pages (e.g., Home Assistant dashboards) in headless Chromium and streams
them as image tiles over WebSocket to lightweight clients
([RemoteWebViewClient](https://github.com/strange-v/RemoteWebViewClient),
ESP32-based displays). It supports multiple simultaneous clients, each with its
own resolution, rotation, and per-device settings, and ships both as a Docker
image and a Home Assistant OS add-on (`hassio/`).

## Tech Stack

| Layer     | Technology                                                  |
| --------- | ----------------------------------------------------------- |
| Runtime   | Node.js (ESM, `"type": "module"`), TypeScript (strict)      |
| Browser   | Headless Chromium via `playwright-core` + raw CDP WebSocket  |
| Imaging   | `sharp` (rotate, raw RGB extraction, JPEG encode)            |
| Transport | `ws` WebSocket server, custom binary protocol (v1)           |
| Diffing   | Exact byte compare against the previous frame, whole rows first, then per tile (`_markChangedTiles` in `src/frameProcessor.ts`); identical screencast frames are skipped by comparing their base64 payloads |
| Config    | `env-var` + query-string params per client connection        |
| Testing   | Vitest                                                       |
| Deploy    | Docker (Playwright base image), Home Assistant add-on        |

## Project Structure

```
RemoteWebViewServer/
├── src/
│   ├── index.ts           # Entry point: WS server, message dispatch, health endpoint, idle cleanup
│   ├── config.ts          # DeviceConfig: query params > env fallbacks > DEFAULTS; per-device config store
│   ├── browser.ts         # Launches headless Chromium (persistent context) and connects CDP
│   ├── cdpRoot.ts         # Minimal raw CDP client (root connection + flattened sessions)
│   ├── deviceManager.ts   # DeviceSession lifecycle: create target, screencast, throttle, idle cleanup
│   ├── frameProcessor.ts  # Tile grid diffing, full/partial frame decision, JPEG encoding
│   ├── jpegBlocks.ts      # JPEG ↔ DCT coefficients: lossless tile crops of screencast frames
│   ├── broadcaster.ts     # Per-device client sets, ordered frame queue, chunked send
│   ├── frameAckWindow.ts  # Window of sent-but-unacknowledged frames for clients that send FrameAck
│   ├── pipelineStats.ts   # Per-device pipeline counters (used by the self-test)
│   ├── protocol.ts        # Binary protocol v1: build/parse Frame, Touch, FrameStats, OpenURL, CurrentURL, RequestFullFrame, FrameAck
│   ├── inputRouter.ts     # Touch → CDP Input events, OpenURL navigation, self-test trigger
│   ├── scriptLoader.ts    # Fetches INJECT_JS_URL script lazily on first device creation, then caches it
│   ├── selfTest.ts        # Self-test runner: measures pipeline latency using self-test/test1.html
│   ├── selfTestReport.ts  # Turns self-test measurements into a report and setting recommendations
│   └── util.ts            # Rotation math (getRotatedDimensions, mapPointForRotation), getScaledViewport
├── self-test/             # Static HTML page for render-time self-tests
├── tests/                 # Vitest unit tests (browser-free)
├── hassio/                # Home Assistant OS add-on (config.yaml, Dockerfile, run.sh)
├── dockerfile             # Multi-stage build on mcr.microsoft.com/playwright base image
├── docker-compose.rwv.yml # Example compose file
└── tsconfig.json          # strict, ESM, outDir dist/
```

## Architecture Notes

- **One Chromium, many tabs**: `browser.ts` starts (or reuses) a single headless
  Chromium exposing CDP on `DEBUG_PORT`. Each connected device id gets its own
  browser target (tab) created through the raw CDP root in `cdpRoot.ts` —
  Playwright is only used to launch the browser, never for page automation.
- **Device lifecycle** (`deviceManager.ts`): `ensureDeviceAsync(id, cfg)` reuses
  an existing session when the config is unchanged (and requests a full frame),
  or closes the tab and creates a new one when the client reconnects with new
  params. Idle sessions are cleaned up after 5 minutes by a 60s interval timer;
  the screencast is paused while a device has no clients.
- **Frame pipeline**: `Page.screencastFrame` (JPEG by default, PNG via
  `SCREENCAST_FORMAT`; base64) → hold the ACK until the frame is consumed or
  dropped (`_releaseScreencastAcks`; acked at once when nobody is connected) → trailing
  throttle by `minFrameInterval` → wait while the client's socket is congested
  or its `FrameAck` window is full → skip frames identical to the last
  processed one → either (JPEG, no rotation, tile size a multiple of 16,
  frame already device-sized) decode to DCT coefficients only
  (`src/jpegBlocks.ts`), diff tiles on those and cut changed tiles out
  losslessly, with Chrome encoding at the device's `jpegQuality`; or sharp
  resize-to-device (page scale) + rotate + raw RGB → `FrameProcessor` tile
  diff → JPEG tiles. Then → `broadcaster` chunked send
  respecting `maxBytesPerMessage`.
- **Full-frame triggers**: every `fullFrameEvery` frames, when changed area
  exceeds `fullFrameAreaThreshold`, or on demand (reconnect/reconfigure, or a
  client `RequestFullFrame`). A box that cannot fit in one message is split in
  halves until it does; a solid red placeholder only appears when
  `maxBytesPerMessage` is unrealistically small.
- **Failure handling**: CDP commands time out; a crashed tab is recreated and
  re-navigated; losing the CDP connection exits the process so the container
  is restarted.
- **Binary protocol**: documented in the header comment of `src/protocol.ts`
  (little-endian, version byte = 1). Client → server: Touch, Keepalive,
  FrameStats, OpenURL, RequestFullFrame, FrameAck. Server → client: Frame (tiled), FrameStats, CurrentURL.
  Any protocol change must stay in sync with the RemoteWebViewClient firmware.
- **Config precedence** (`config.ts`): WS query params (`w`, `h`, `ts`, `q`,
  `mbpm`, …) override env vars (`TILE_SIZE`, `JPEG_QUALITY`, …) which
  override `DEFAULTS`. `w`/`h` are required per connection. Rotation is the
  exception: `r` is query-param-only (no env fallback) and swaps width/height
  via `getRotatedDimensions`.

## Build / Dev / Test Commands

All commands run from the project root.

```bash
# Dev
npm run dev              # tsx src/index.ts (no build step)

# Build / run
npm run build            # tsc → dist/
npm start                # node dist/index.js (requires build)

# Test — `coverage` additionally requires installing @vitest/coverage-v8
# (not currently in devDependencies).
npm test                 # vitest (watch by default)
npm run test:run         # vitest run (single pass)
npm run coverage         # vitest run --coverage

# Docker
docker build -t remote-webview-server -f dockerfile .
```

The server needs a Chromium-capable environment: `playwright-core` resolves a
Playwright-managed Chromium (from `PLAYWRIGHT_BROWSERS_PATH` /
`~/.cache/ms-playwright`), never a system-installed browser — install one
locally with `npx playwright install chromium`; in Docker the Playwright base
image provides it. Key ports: `WS_PORT` 8081 (stream), `HEALTH_PORT` 18080,
`DEBUG_PORT` 9221 (internal CDP; 9222 exposed via socat/debug proxy).

## Code Style Guidelines

### TypeScript / ESM
- **Strict mode** everywhere; no implicit `any`.
- ESM throughout — **relative imports must use the `.js` extension**
  (`import { getScaledViewport } from "./util.js";`) even though sources are `.ts`.
- Async functions are usually suffixed `Async` (`ensureDeviceAsync`,
  `processFrameAsync`, `cleanupIdleAsync`). Applied loosely: `frameProcessor.ts`
  has async privates without the suffix, and `scriptLoader.ts` exports
  `getInjectScriptFromUrl` without it.
- Private class members are usually prefixed with `_` (`_cfg`, `_drainAsync`,
  `_clients`) — `cdpRoot.ts` predates this and doesn't follow it.
- Prefer `type` aliases for object shapes (`DeviceConfig`, `DeviceSession`);
  enums are used for protocol constants (`MsgType`, `Encoding`, `TouchKind`).

### Configuration
- Prefer `env-var` (`env.get("WS_PORT").default(...)`) or the validated
  helpers in `config.ts` (`intPos`, `intNonNeg`, `float01`) for env access in
  new code. Known exceptions that read `process.env` directly: `browser.ts`
  (`DEBUG_PORT`, `USER_DATA_DIR`, `PREFERS_REDUCED_MOTION`) and
  `deviceManager.ts` (`PREFERS_REDUCED_MOTION`) — remember these when
  auditing or renaming env vars.
- New tunables need all three layers: a `DEFAULTS` entry, an env fallback in
  `readEnvFallbacks()`, and a query param in `makeConfigFromParams()` — plus,
  when user-facing, the README Docker Compose example (there is no separate
  env-var table) and `hassio/remote_webview_server/config.yaml` options/schema
  and `run.sh` mapping.

### Error Handling
- The stream must never crash on a bad frame or packet: wrap per-frame and
  per-packet work in `try/catch` and `console.warn` with context
  (`[device] Failed to process frame for ${id}: ...`).
- Fire-and-forget promises always get a `.catch()`
  (`session.send(...).catch(() => {})`).
- Parsers in `protocol.ts` return `null` on malformed input instead of
  throwing; callers must handle `null`.
- Log messages are prefixed with their subsystem: `[server]`, `[device]`,
  `[broadcaster]`, `[cdp]`, `[browser]`.

### Protocol Changes
- Keep the layout comment at the top of `src/protocol.ts` up to date.
- Header-size constants (`FRAME_HEADER_BYTES`, etc.) are hand-computed sums —
  update them together with the layout.
- Bump `PROTOCOL_VERSION` for breaking changes and coordinate with the client
  firmware repo.

### Testing
- Unit tests live in `tests/*.test.ts` (Vitest). Pure logic (protocol build/parse, config parsing, rotation math,
  tile splitting) is the priority for unit tests — it needs no browser. Keep
  new logic browser-free where possible so it stays testable.

## Versioning / Release

Keep versions in sync when releasing: `package.json` and
`hassio/remote_webview_server/config.yaml` must carry the same version
(see commit history: "Sync version"). Docker tags follow semver with `latest`
and `beta` channels.
