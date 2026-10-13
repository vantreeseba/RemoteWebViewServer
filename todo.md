# Performance TODO

Findings from the 2026-07-05 performance reviews (passes 1–4), re-checked
against the code on 2026-10-12 after merging upstream's pipeline rework
(`7f1592b`, `df1e4b3`). The merge replaced `deviceManager.ts`,
`frameProcessor.ts`, `cdpRoot.ts`, `broadcaster.ts`, `inputRouter.ts`,
`browser.ts` and most of `index.ts` with upstream's versions, so several
fork fixes were superseded by upstream's own and others were dropped and are
open again. Item numbers are the original ones. The fork's implementations of
the open items are in git history before `7f1592b`.

## Open — dropped in the upstream merge

### Capture cost

- [ ] **33. Immediate screencast acks make Chromium encode and ship every
  damaged frame** (`src/deviceManager.ts`): the `Page.screencastFrame` handler
  acks at once, so at 60 fps damage vs a 5 fps device ~90% of capture encodes
  and CDP traffic are discarded work. Fix: hold acks until a frame is consumed
  (measured in the fork: 60 → ~15 frames/s delivered, client fps unchanged,
  server pipeline CPU −27%). Must release held acks on every path that drops
  the pending frame (stop, delete, congestion wait).
- [ ] **29. PNG screencast is the most expensive capture choice**
  (`src/deviceManager.ts`): `startScreencastAsync` hardcodes `format: 'png'`.
  JPEG is 4–10x smaller on the CDP socket and faster to decode. A port has to
  deal with `pngSize()`, which reads the PNG header to detect frames that need
  upscaling for the page-scale feature.

### Connect / reconfigure latency

- [ ] **23. Reconfigure recreates the tab and reloads the page**
  (`src/deviceManager.ts`): a param change calls `deleteDeviceAsync` and
  builds a new target from about:blank (1–5 s blank screen, lost page state).
  Fix: apply the metrics override (scaled viewport), screencast restart and a
  fresh processor on the existing target. Chrome delivers one frame with the
  old layout right after the change; skip it by aspect ratio instead of
  letting the scale path stretch it.
- [ ] **12. Device setup serializes independent CDP round trips**
  (`src/deviceManager.ts`): `Page.enable`, metrics override, emulated media,
  the script fetch and `Inspector.enable` are awaited one by one; ~10–25 ms
  avoidable per (re)connect. Fix: start the script fetch early, `Promise.all`
  the independent commands.
- [ ] **10b. Inject-script cache is no longer warmed at startup**
  (`src/index.ts`): the first device connect pays the fetch (up to 5 s for a
  slow URL). The cache and the failure back-off in `src/scriptLoader.ts` are
  still in place. The README still says the script is fetched at startup.

### Frame processor allocation churn (`src/frameProcessor.ts`)

- [ ] **18. `_extractRaw` copies every encoded rect**: alloc + row-by-row
  memcpy per box (a whole frame per full frame), and again for each half when
  `_encodeFittingAsync` splits an oversize box. sharp `.extract()` can crop
  the shared raw buffer natively.
- [ ] **19. Grid geometry recomputed per partial frame**:
  `_mergeChangedTiles` rebuilds two boolean grids and calls `_calcGridSplits`
  and `_getMaxFullTileSize` (which re-runs `_splitWholeFrame`) every frame
  from immutable config. Compute once in `_initGrid`, reuse flat typed arrays.
- [ ] **20. Per-frame `TileInfo` object churn**: one short-lived object per
  tile per frame (375 for 800×480 at 32 px) for grid-constant data.

### Broadcaster / connection handling

- [ ] **1b. Superseded sockets are closed gracefully** (`src/broadcaster.ts`):
  `addClient` uses `close()`, which queues the close handshake behind whatever
  the old socket still has buffered; `terminate()` frees it at once.
- [ ] **21. Control packets queue behind frames** (`src/broadcaster.ts`):
  CurrentURL and FrameStats packets are pushed to the tail. Impact is smaller
  than before — congestion gating keeps at most about one frame queued — but a
  large full frame on a slow link still delays them. If reinstated, insert
  after control packets already at the head so their order is kept (old #31).
- [ ] **22. Every disconnect logs twice** (`src/index.ts`,
  `src/broadcaster.ts`): the broadcaster's own close handler and the close
  handler in `index.ts` both call `removeClient`.

### Browser

- [ ] **30. Unbounded Chromium profile growth / `--headless=new` flag**
  (`src/browser.ts`): no `--disk-cache-size`, so the persistent profile (in
  the add-on's backed-up `/data` volume) grows over months; the fork capped it
  at 100 MB. The fork also removed `--headless=new` as inert under
  Playwright's headless shell; upstream passes it again — re-verify before
  removing, since upstream's `newWindow` target creation was written with
  full Chrome in mind.

## Resolved — by upstream's implementation

These fork fixes were replaced by upstream code that solves the same problem.

- [x] **1. WebSocket backpressure**: `isCongested()` (queue, in-flight drain
  or `bufferedAmount > 0`) gates `flushPending`, so no frame is encoded while
  the client is behind, and clients that send `FrameAck` are paced by a
  2-frame window. Nothing is dropped, so no full-frame resync is needed.
  `_drainAsync` itself still sends without awaiting the send callback.
- [x] **14. Slow clients trigger a full-frame encode livelock**: gone with the
  queue cap — see #1.
- [x] **2. CDP session leak**: `removeSession` in `deleteDeviceAsync`, and on
  `Target.detachedFromTarget`.
- [x] **3. Screencast runs with zero clients**: `releaseDeviceAsync` stops it
  when the last client leaves and it resumes on reconnect. (The dead-socket
  half is the fork's heartbeat, below.)
- [x] **4. Throttle race → concurrent frame processing**: `processing` flag
  plus `scheduleFlush`.
- [x] **17. Effective frame period is processing + minFrameInterval**:
  `lastProcessedMs` is stamped at the start of processing.
- [x] **5. Per-tile alloc+copy just to hash**: tiles are compared in place
  against the previous frame (`_tileDiffers`), exact rather than sampled. Cost:
  one raw RGB frame is retained per device.
- [x] **6. Serialized JPEG encodes**: boxes are encoded with `Promise.all`.
- [x] **7. `ensureAlpha()` inflates every frame**: frames are decoded with
  `removeAlpha()` to packed RGB.
- [x] **15. Server becomes a silent zombie if Chromium dies**: CDP commands
  time out and reject on a closed connection, the process exits when the CDP
  connection closes, the health endpoint returns 500, and a crashed tab is
  recreated.
- [x] **16. Touch-move throttle is global across devices**: per-device map in
  `InputRouter`.
- [x] **25. Concurrent connects for one id created orphan tabs**: per-id
  operation queue (`_enqueue`).
- [x] **26. Setup failure after `Target.createTarget` leaked the tab**: the
  target is closed in the catch; its session is dropped on detach.
- [x] **32. Client messages sent right after connect were dropped**: the
  message handler is attached first and each message chains on the setup
  promise.
- [x] **A. Device setup errors crashed the whole server**: the connection
  handler is synchronous, setup failures close the socket, and there is an
  `unhandledRejection` handler.
- [x] **B. Full-frame requests swallowed by frame dedup on static pages**:
  `resendFullFrame` clears `processedB64` and re-processes the last frame.
- [x] **11. Self-test timers survive device deletion**: `deleteDeviceAsync`
  calls `selfTestRunner.stop()`.
- [x] **27. Static-page devices torn down under a live client**: the idle
  sweep only removes devices with zero clients.

## Resolved — fork changes that survived the merge

- [x] **3 (liveness half). Dead sockets keep the pipeline running**
  (`src/index.ts`): server ping/pong heartbeat terminates clients that miss an
  interval; pongs also bump `lastActive`.
- [x] **9. `buildFramePacket` extra copy** (`src/protocol.ts`): exact-size
  `allocUnsafe`, headers and tile data written in place.
- [x] **10. Failed inject-script fetches never negatively cached**
  (`src/scriptLoader.ts`): script cache plus a 60 s failure back-off. (The
  startup warm-up was lost — see 10b.)
- [x] **13. Config store never evicts** (`src/config.ts`): the store is
  removed.

## No longer applicable

- **8. Red placeholder re-encoded every time**: oversize boxes are now split
  until they fit; the red tile only appears when a box under 2 px still
  doesn't fit.
- **24. Stale-frame guard dropped all frames on rotated displays**: the guard
  belonged to in-place reconfigure (#23) and is gone with it.
- **28. Disconnect racing an in-place reconfigure**: same; screencast
  stop/start now runs through the per-id queue.
- **31. Control packets delivered newest-first**: packets are plain FIFO
  again (see #21).
