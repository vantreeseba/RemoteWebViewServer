# Performance TODO

Findings from the 2026-07-05 performance review, ranked by impact.

## Pass 2 (2026-07-05, post-fix review)

- [ ] **14. Slow clients trigger a full-frame encode livelock**
  (`src/deviceManager.ts`, `src/broadcaster.ts`): when a client's queue is at
  cap, frames are still fully decoded/hashed/encoded upstream and then dropped;
  every drop re-requests a full frame, so all the wasted encodes are worst-case
  full-frame encodes and PNG dedup stays disabled. Fix: gate `flushPending` on
  broadcaster queue depth; on overflow keep an incoming full frame (it replaces
  the stale queue) instead of dropping it and re-requesting.
- [ ] **15. Server becomes a silent zombie if Chromium dies**
  (`src/cdpRoot.ts`): the root CDP connection never signals closure — sends
  after close never settle, every connect hangs forever and leaks a pending
  entry, and the health endpoint still says ok so watchdogs never restart.
  Fix: reject sends on a closed connection, surface CDP health via the health
  endpoint (503 → watchdog restart).
- [ ] **16. Touch-move throttle is global across devices**
  (`src/inputRouter.ts`): `_lastMoveAt` lives on the single shared InputRouter,
  so simultaneous drags on N devices share one 12 ms budget. Fix: track
  per-device (on `DeviceSession`).
- [ ] **17. Effective frame period is processing + minFrameInterval**
  (`src/deviceManager.ts`): `lastProcessedMs` is stamped at processing end, so
  fps sags below the configured rate exactly under load. Stamp at flush start.
- [ ] **18. `_extractRaw` copies every encoded rect** (`src/frameProcessor.ts`):
  sharp `.extract()` crops the shared raw buffer natively; the JS-side
  alloc+memcpy per rect (whole frame per full frame) is avoidable.
- [ ] **19. Grid geometry recomputed per partial frame**
  (`src/frameProcessor.ts`): `_mergeChangedTiles` rebuilds boolean grids,
  splits, and max-tile sizes (~40 allocations) per frame from immutable config.
  Compute once in `_initGrid`, reuse flat typed arrays.
- [ ] **20. Per-frame TileInfo object churn** (`src/frameProcessor.ts`): 375
  short-lived objects per frame for grid-constant data; use preallocated
  hash/changed typed arrays.
- [ ] **21. Control packets queue behind frame drains** (`src/broadcaster.ts`):
  CurrentURL/self-test packets wait behind multi-second frame drains on slow
  clients; unshift them to the queue head.
- [ ] **22. Every disconnect logs twice** (`src/index.ts`): both the
  broadcaster's own close handler and index.ts call `removeClient`.
- [ ] **23. Reconfigure recreates the tab and reloads the page**
  (`src/deviceManager.ts`): a param change tears down the target and reloads
  from about:blank (1–5 s blank screen). Apply metrics/screencast/processor
  changes in place on the existing target.

## Critical — memory / dead work under realistic client conditions

- [x] **1. WebSocket backpressure** (`src/broadcaster.ts`): `_drainAsync` calls
  `ws.send()` without checking `bufferedAmount` or using the send callback, so a
  slow client buffers unboundedly in process memory. The `await Promise.resolve()`
  between packets only yields to the microtask queue (no real pacing); queued
  frames are never coalesced, so slow clients receive stale intermediates;
  `addClient` supersedes old sockets with `close()` (graceful handshake behind
  buffered megabytes) instead of `terminate()`.
  Fix: await the `ws.send` callback per packet, cap the frame queue and drop +
  request a full frame on overflow, `terminate()` superseded sockets.
- [x] **2. CDP session leak on reconfigure** (`src/cdpRoot.ts`,
  `src/deviceManager.ts`): `CdpConnection.sessions` never deletes entries;
  `deleteDeviceAsync` closes the target but never releases the session, leaking
  the `CdpSession`, its handlers, and the captured `DeviceSession` graph
  (processor state, possibly the last pending base64 PNG) on every
  reconfigure/idle-cleanup cycle.
  Fix: `releaseSession(sessionId)` on the root, called from `deleteDeviceAsync`.
- [x] **3. Screencast runs with zero clients / dead sockets**
  (`src/deviceManager.ts`, `src/index.ts`): frames are ACK'd but Chromium keeps
  compositing + PNG-encoding for the full 5-min idle TTL after the last client
  leaves; a client that vanishes without FIN stays `readyState OPEN` (no
  ping/pong liveness), keeping the whole pipeline encoding for a dead peer.
  Fix: `Page.stopScreencast` when client count hits zero, restart on reconnect;
  server-initiated ping/pong that terminates unresponsive sockets.
- [x] **4. Throttle race → concurrent frame processing**
  (`src/deviceManager.ts`): `flushPending` clears `throttleTimer` on entry but
  updates `lastProcessedMs` only in `finally`, so a frame arriving mid-processing
  schedules a second concurrent `flushPending` exactly when processing time
  approaches `minFrameInterval`.
  Fix: a `processing` flag; re-arm the timer on completion if a frame is pending.

## Hot path — per-frame CPU and allocation churn

- [x] **5. Per-tile alloc+copy just to hash** (`src/frameProcessor.ts`):
  `_extractRaw` (alloc + row-by-row memcpy) runs for every tile every frame
  solely to feed `hash32`; ~375 allocs / ~1.5 MB memcpy per 800×480 frame,
  discarded immediately.
  Fix: hash tiles in place with a strided walk over the frame buffer.
- [x] **6. Serialized JPEG encodes** (`src/frameProcessor.ts`): full-frame,
  partial-frame, and red-replacement paths `await` each `_encode` in a loop,
  paying sum-of-encodes instead of max-of-encodes despite `sharp.concurrency`.
  Fix: `Promise.all` the rect encodes.
- [x] **7. `ensureAlpha()` inflates every frame by 33%**
  (`src/deviceManager.ts`, `src/frameProcessor.ts`): screencast PNGs are opaque;
  forcing RGBA grows every downstream copy/hash/encode.
  Fix: drop `ensureAlpha`, parameterize the processor on `info.channels`.
- [x] **8. Red placeholder re-encoded every time** (`src/frameProcessor.ts`):
  `_makeRedFrameAsync` allocates, fills, and JPEG-encodes a deterministic buffer
  on every oversized tile — potentially every frame on busy pages.
  Fix: memoize by `${w}x${h}:${enc}`.
- [x] **9. `buildFramePacket` extra copy** (`src/protocol.ts`): header-per-tile
  allocs + `Buffer.concat` cost a full redundant memcpy of the payload per packet.
  Fix: compute exact size, `allocUnsafe` once, write in place.

## Found and fixed during verification

- [x] **A. Device setup errors crashed the whole server**: an exception in the
  async `wss.on("connection")` handler (bad params, CDP failure) was an
  unhandled rejection that killed the process for all devices.
- [x] **B. Full-frame requests swallowed by PNG dedup on static pages**: a
  (re)connecting client's requested full frame was dropped because the next
  screencast frame is byte-identical to the last processed one; full-frame
  requests now also reset the device-level dedup hash.

## Lower priority

- [x] **10. Failed inject-script fetches never negatively cached**
  (`src/scriptLoader.ts`): an unreachable `INJECT_JS_URL` adds up to 5 s to every
  device (re)connect, serialized inside `ensureDeviceAsync`.
  Fix: negative-cache failures with a short TTL; warm the cache at startup.
- [x] **11. Self-test timers survive device deletion**
  (`src/deviceManager.ts`): `deleteDeviceAsync` never calls
  `selfTestRunner.stop()`; up to three timers (5s/70s/125s) retain the runner and
  can push stale FrameStats packets into a new session reusing the same id.
- [x] **12. Device setup serializes independent CDP round trips**
  (`src/deviceManager.ts`): `Page.enable`, metrics override, emulated media, and
  the script fetch are awaited sequentially; ~10–25 ms avoidable per (re)connect.
  Fix: kick off the script fetch early, `Promise.all` the independent commands.
- [x] **13. Config store never evicts** (`src/config.ts`): one entry per unique
  `?id=` forever — and `getConfigFor` has no callers at all, so the store is
  write-only dead memory. Fix: remove the store.
