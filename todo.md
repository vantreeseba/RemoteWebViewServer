# Performance TODO

Findings from the 2026-07-05 performance reviews (passes 1–4), re-checked
against the code on 2026-10-12 after merging upstream's pipeline rework
(`7f1592b`, `df1e4b3`). On 2026-10-27 (upstream unchanged since `8ae7efa`)
the dropped items were re-ported onto upstream's code and measured; see the
benchmark below. The merge replaced `deviceManager.ts`,
`frameProcessor.ts`, `cdpRoot.ts`, `broadcaster.ts`, `inputRouter.ts`,
`browser.ts` and most of `index.ts` with upstream's versions, so several
fork fixes were superseded by upstream's own and others were dropped and are
open again. Item numbers are the original ones. The fork's implementations of
the open items are in git history before `7f1592b`.

## Benchmark (2026-10-27)

End-to-end, local headless shell, one 800x480 client acking frames after
25 ms, default settings (80 ms interval), 20 s per run, two interleaved runs
each. Before = `a7ccb88`, after = `a67dfb5`.

| Page                        | Server CPU | Chromium CPU | Server RSS   | Client fps | To device   |
| --------------------------- | ---------- | ------------ | ------------ | ---------- | ----------- |
| Dashboard + live clock      | 23% → 15%  | 63% → 50%    | 276 → 240 MB | 12.2       | +15% bytes  |
| Half-screen CSS animation   | 34% → 18%  | 101% → 55%   | 300 → 242 MB | 12.2       | +4% bytes   |
| Static page                 | 0          | 0            | 160 MB       | —          | —           |

The extra bytes come from re-encoding JPEG capture noise (#29). Capture
quality 95/100 removes them but costs Chromium CPU and drops to 9–11 fps.

## Open

- [ ] **23. Reconfigure recreates the tab and reloads the page**
  (`src/deviceManager.ts`): a param change calls `deleteDeviceAsync` and
  builds a new target from about:blank (1–5 s blank screen, lost page state).
  Fix: apply the metrics override (scaled viewport), screencast restart and a
  fresh processor on the existing target. Chrome delivers one frame with the
  old layout right after the change; skip it by aspect ratio instead of
  letting the scale path stretch it. Latency only, not CPU/RAM; the fork's
  version is before `7f1592b`.
- [ ] **30b. `--headless=new` flag** (`src/browser.ts`): the fork removed it
  as inert under Playwright's headless shell; upstream passes it again.
  Re-verify before removing, since upstream's `newWindow` target creation was
  written with full Chrome in mind.
- [ ] **34. Chromium renders at 60 fps no matter how few frames are used**
  (idea, not measured): paced acks (#33) stop capture work, but the page is
  still laid out, painted and composited at display rate; that is most of the
  remaining Chromium CPU. `HeadlessExperimental.beginFrame` with
  `--enable-begin-frame-control` would let the server render only the frames
  it sends, but it replaces the screencast entirely (screenshots per frame),
  so it is a pipeline rewrite.
- [ ] **35. Native memory outside the JS heap** (measured): ~240 MB RSS with
  a ~50 MB JS heap and ~1 MB in sharp's cache. `MALLOC_ARENA_MAX=2` saved
  ~35 MB but CPU looked worse and noisier; jemalloc (`LD_PRELOAD` in the
  dockerfile) is the other option sharp recommends. Needs a longer run to
  judge fragmentation over hours, not 20 s.

## Resolved — 2026-10-27 (re-ported and new)

- [x] **33. Screencast acks held until a frame is consumed** (`50e0eb0`):
  `_releaseScreencastAcks` runs on consume, stale session, stop and delete.
- [x] **29. JPEG screencast capture** (`bfb6767`): `SCREENCAST_FORMAT` /
  `SCREENCAST_QUALITY` (default jpeg/90); `imageSize` in `util.ts` reads
  PNG and JPEG headers for the page-scale check.
- [x] **18/19/20. Frame processor allocation churn** (`59f3789`): sharp
  crops boxes from the shared frame, grid geometry and flag arrays are built
  once per frame size, no per-tile objects. Output byte-identical.
- [x] **36. Tile diff did one compare per tile row** (new, `59f3789`):
  whole pixel rows are compared first, tile segments only on rows that
  differ. Unchanged 800x480 frame 1.35 → 0.1 ms.
- [x] **37. sharp threads per image** (new, `a67dfb5`): `concurrency(1)`
  instead of cores-1; ~25% less server CPU, same latency.
- [x] **1b, 21, 22. Broadcaster** (`3b96a6c`): superseded sockets are
  terminated, disconnects log once, control packets go ahead of frames in
  FIFO order.
- [x] **12, 10b. Connect latency** (`f040902`): setup commands run in
  parallel; the inject script is fetched at startup, with in-flight sharing.
- [x] **30. Chromium disk cache capped at 100 MB** (`c0df918`).

- [x] **38. Changed tiles were compressed twice with JPEG capture** (new):
  `src/jpegBlocks.ts` decodes Chrome's JPEG to DCT coefficients only, the
  processor diffs tiles on those and cuts changed tiles out losslessly
  (`jpegtran -crop` style), with Chrome encoding at the device's quality.
  Falls back to the pixel path for rotation, rescaled frames, tile sizes
  that aren't a multiple of 16, and unsupported JPEGs; `SCREENCAST_PASSTHROUGH=false`
  turns it off. Measured against the re-encode path (4 paired runs, noisy
  machine): server CPU ~20% lower, server RSS 25–45 MB lower, bytes per frame
  back to the PNG-capture level. Not yet tried on real ESP32 hardware.

## Measured, not worth changing

- `sharp.cache(false)`: the operation cache holds ~1 MB here; no CPU or RSS
  difference.
- Chromium flags `--disable-gpu`, `--disable-software-rasterizer`,
  `--num-raster-threads=1`, `--disable-gpu-compositing`: no CPU difference
  on a quiet machine (Playwright already passes the usual background-work
  switches).

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
  against the previous frame (`_markChangedTiles`), exact rather than sampled. Cost:
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
