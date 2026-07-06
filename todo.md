# Performance TODO

Findings from the 2026-07-05 performance review, ranked by impact.

## Pass 3 (2026-07-05, second post-fix review)

- [x] **24. REGRESSION: stale-frame guard dropped all frames on rotated
  displays** (`src/deviceManager.ts`): the guard compared post-rotation decoded
  dims against the pre-rotation viewport config — every frame of a 90°/270°
  non-square display was silently dropped. Fixed and covered by a rotated
  smoke-test session.
- [x] **25. Concurrent connects for one id created orphan renderer zombies**
  (`src/deviceManager.ts`): no per-id in-flight guard in `ensureDeviceAsync`;
  now serialized through a per-id promise queue.
- [x] **26. Setup failure after Target.createTarget leaked the tab**
  (`src/deviceManager.ts`): the target wasn't in the devices map yet, so the
  idle sweep could never reclaim it; now closed + session released on failure.
- [x] **27. Static-page devices torn down under a live client**
  (`src/index.ts`): only frames and Keepalive packets bumped `lastActive`; now
  every client message and WS pongs count as liveness.
- [x] **28. Disconnect racing an in-place reconfigure left the screencast
  running with zero clients** (`src/deviceManager.ts`): added the post-start
  zero-client recheck, mirroring `pauseScreencastAsync`.
- [x] **29. PNG screencast was the most expensive capture choice**
  (`src/deviceManager.ts`, `src/config.ts`): new `SCREENCAST_FORMAT`
  (jpeg|png, default jpeg) and `SCREENCAST_QUALITY` (default 90); JPEG is
  4-10x smaller on the CDP socket and faster to decode; set png for lossless.
- [x] **30. Unbounded Chromium profile growth / dead `--headless=new` flag**
  (`src/browser.ts`): capped the disk cache at 100MB (the profile only needs
  cookies/localStorage) and removed the inert headless flag (Playwright's
  headless shell passes its own).
- [x] **31. Control packets delivered newest-first** (`src/broadcaster.ts`):
  blind unshift reversed the order of e.g. a redirect chain's CurrentURLs;
  now inserted FIFO after control packets already at the head.

## Pass 4 (2026-07-05, "CPU while idle" investigation)

- [x] **32. Client messages sent right after connect were silently dropped**
  (`src/index.ts`): the ws message handler attached only after the awaited
  device setup (~100–500 ms), so an OpenURL sent immediately on connect was
  lost — the display sat on about:blank until the client resent or
  reconnected. Handlers now attach first and early packets are buffered and
  replayed. (Found because it invalidated every CPU measurement.)
- [x] **33. Immediate screencast acks made Chromium encode+ship every damaged
  frame** (`src/deviceManager.ts`): at 60 fps damage vs a 5 fps device, ~90%
  of capture encodes and CDP traffic were discarded work. Acks are now held
  until a frame is consumed (CDP flow control), pushing the minFrameInterval
  throttle upstream: measured 60 → ~15 frames/s delivered (Chromium's ~3-frame
  in-flight window), client fps unchanged, server pipeline CPU −27%. Idle
  pages already cost zero server CPU (verified); remaining idle CPU is
  Chromium compositing the page itself.

## Pass 2 (2026-07-05, post-fix review)

- [x] **14. Slow clients trigger a full-frame encode livelock**
  (`src/deviceManager.ts`, `src/broadcaster.ts`): when a client's queue is at
  cap, frames are still fully decoded/hashed/encoded upstream and then dropped;
  every drop re-requests a full frame, so all the wasted encodes are worst-case
  full-frame encodes and PNG dedup stays disabled. Fix: gate `flushPending` on
  broadcaster queue depth; on overflow keep an incoming full frame (it replaces
  the stale queue) instead of dropping it and re-requesting.
- [x] **15. Server becomes a silent zombie if Chromium dies**
  (`src/cdpRoot.ts`): the root CDP connection never signals closure — sends
  after close never settle, every connect hangs forever and leaks a pending
  entry, and the health endpoint still says ok so watchdogs never restart.
  Fix: reject sends on a closed connection, surface CDP health via the health
  endpoint (503 → watchdog restart).
- [x] **16. Touch-move throttle is global across devices**
  (`src/inputRouter.ts`): `_lastMoveAt` lives on the single shared InputRouter,
  so simultaneous drags on N devices share one 12 ms budget. Fix: track
  per-device (on `DeviceSession`).
- [x] **17. Effective frame period is processing + minFrameInterval**
  (`src/deviceManager.ts`): `lastProcessedMs` is stamped at processing end, so
  fps sags below the configured rate exactly under load. Stamp at flush start.
- [x] **18. `_extractRaw` copies every encoded rect** (`src/frameProcessor.ts`):
  sharp `.extract()` crops the shared raw buffer natively; the JS-side
  alloc+memcpy per rect (whole frame per full frame) is avoidable.
- [x] **19. Grid geometry recomputed per partial frame**
  (`src/frameProcessor.ts`): `_mergeChangedTiles` rebuilds boolean grids,
  splits, and max-tile sizes (~40 allocations) per frame from immutable config.
  Compute once in `_initGrid`, reuse flat typed arrays.
- [x] **20. Per-frame TileInfo object churn** (`src/frameProcessor.ts`): 375
  short-lived objects per frame for grid-constant data; use preallocated
  hash/changed typed arrays.
- [x] **21. Control packets queue behind frame drains** (`src/broadcaster.ts`):
  CurrentURL/self-test packets wait behind multi-second frame drains on slow
  clients; unshift them to the queue head.
- [x] **22. Every disconnect logs twice** (`src/index.ts`): both the
  broadcaster's own close handler and index.ts call `removeClient`.
- [x] **23. Reconfigure recreates the tab and reloads the page**
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
