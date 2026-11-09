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
- [ ] **35. Native memory outside the JS heap** (measured): ~240 MB RSS with
  a ~50 MB JS heap and ~1 MB in sharp's cache. `MALLOC_ARENA_MAX=2` saved
  ~35 MB but CPU looked worse and noisier; jemalloc (`LD_PRELOAD` in the
  dockerfile) is the other option sharp recommends. Needs a longer run to
  judge fragmentation over hours, not 20 s.

## Resolved — 2026-11-08 (idle and average CPU)

End-to-end, local headless shell, one 800x480 client acking frames after 25 ms, a page
with a 100 ms clock and a 50 msg/s WebSocket, 15 s connected then 10 s disconnected, two
interleaved runs each (machine noisy; old = `cc39410`).

| Phase        | Server CPU    | Chromium CPU                        |
| ------------ | ------------- | ----------------------------------- |
| Connected    | 13–16% → 6%   | 28–31% → 27–30% (clock-bound page)  |
| Disconnected | 1.3–1.6% → 0  | 16–17% → 0–0.1%                     |

- [x] **39. Playwright stayed attached to every tab** (`src/browser.ts`): a
  `launchPersistentContext` browser auto-attaches to all targets, including the
  device tabs, and enables Network/Runtime/Log/Console events there. Chromium is
  now spawned directly with Playwright's switches; `preparePageAsync` re-applies its
  per-tab defaults (focus emulation, locale, Linux default fonts, dialogs dismissed,
  beforeunload accepted) and downloads are denied. Microbenchmark on a page with a
  busy WebSocket: Chromium 20–35% and Node 25–45% less CPU. Pages report the same
  language, focus state, user agent and font metrics as before. Signals now close
  the browser gracefully (old exit code on SIGTERM was 1, via the lost-CDP path).
- [x] **40. Pages of disconnected devices kept rendering** (`src/deviceManager.ts`):
  the tab is hidden (window minimized, focus emulation off, or Chrome keeps it
  visible) together with the screencast stop, and restored on reconnect (first frame
  ~60 ms after reconnecting). A hidden page doesn't render but keeps its scripts,
  timers and WebSockets, so the dashboard stays live: 16–17% → ~4–5% Chromium on the
  test page. Freezing was tried first (0%) but closes the page's WebSockets; it is
  kept as the fallback when the window can't be minimized.
- [x] **41. Self-test left Runtime events on** (`src/selfTest.ts`): removed the
  binding and disabled Runtime once the device leaves the test/result page or the
  test is stopped.
- [x] **42. ~1 MB coefficient array allocated per JPEG frame** (`src/jpegBlocks.ts`,
  `src/frameProcessor.ts`): decode and rotate take an output array; the processor
  hands back the array of the frame it no longer holds (`takeSpareCoefficients`).
  0.34 ms allocation → 0.03 ms clearing per 800x480 frame, plus less GC.
- [x] **43. Congested devices polled every 10 ms** (`src/broadcaster.ts`): the
  broadcaster counts sends not yet written out and wakes waiters
  (`onceUncongested`) when the queue and sockets are empty; a 100 ms timer only
  covers a missed wake-up.
- [x] **45. The CDP socket was compressed** (`src/cdpRoot.ts`): Chromium offers
  permessage-deflate and `ws` accepts it by default, so every message, frames
  included, was deflated by Chromium and inflated by the server over localhost.
  Turned off: ~2 points less server CPU at 12 fps.
- [x] **34. Chromium rendered at 60 fps no matter how few frames were used**
  (`src/beginFrameLoop.ts`, opt-in `CAPTURE_MODE=on-demand`): tabs are created with
  begin-frame control and the server issues each frame. A frame without a screenshot
  is cheap and reports damage; a screenshot is taken only when the page changed and
  the pipeline can process it at once. The frame after a screenshot always reports
  damage, so it is issued right away and ignored, and a quiet page gets check
  screenshots after 0.25/1/4/15 s to catch a change made in that window. After two
  changed captures in a row it skips the probe until a screenshot comes out unchanged,
  and the absorbing frame isn't awaited; without these, scrolling topped out at 16 fps.
  Touches request frames, since a touch is only delivered on the next frame. Measured
  (800x480, interleaved runs, noisy machine):

  | Page, client connected               | screencast              | on-demand                 |
  | ------------------------------------ | ----------------------- | ------------------------- |
  | CSS animation                        | 40–67% Chromium         | 22–36% Chromium           |
  | Static                               | ~0%                     | ~3% Chromium, ~0.7% Node  |
  | Changes once a second                | 2% Chromium, 0.9% Node  | 6.5% Chromium, 1.5% Node  |
  | ... change → frame at 80 ms interval | ~17 ms                  | ~60 ms                    |
  | Self-test single change / scrolling  | 27 ms / 59 fps          | 25 ms / 59 fps            |

  The self-test runs its single changes without a frame interval, so it doesn't show
  the wait for the next poll. Not the default: most dashboards are static or change now
  and then, where the screencast is cheaper and faster. Worth it for dashboards that
  animate constantly. Needs the headless shell; a browser without the switches falls
  back to the screencast.

## Open — found 2026-11-08

- [ ] **44. Every frame is fully entropy-decoded** (`src/jpegBlocks.ts`): ~3.5 ms
  per 800x480 frame, ~4% of a core at 12 fps. Checkpointing decoder state per MCU
  row and skipping the byte-identical prefix of the scan would save most of it for
  changes low on the screen. Not measured.

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
  Rotated displays are rotated in the DCT domain too (`jpegtran -rotate`
  style) when the frame is a whole number of 16 px MCUs. Falls back to the
  pixel path for rescaled frames, tile sizes that aren't a multiple of 16,
  rotated displays whose size isn't, and unsupported JPEGs; `SCREENCAST_PASSTHROUGH=false`
  turns it off. Measured against the re-encode path (4 paired runs, noisy
  machine): server CPU ~20% lower, bytes per frame back to the PNG-capture
  level. Server RSS looked 25–45 MB lower in those runs but varies a lot
  between runs. Rotated 800x480 display: server CPU 21% -> 17%. Not yet tried on real ESP32 hardware.

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
