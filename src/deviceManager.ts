import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual, readInjectScriptConfig, readScreencastConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor, JpegFrame, RGB } from "./frameProcessor.js";
import { JpegBlocks, decodeJpegBlocks, rotateJpegBlocks } from "./jpegBlocks.js";
import { beginFrameControl, preparePageAsync } from "./browser.js";
import { BeginFrameLoop } from "./beginFrameLoop.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";
import { PipelineStats, newPipelineStats } from "./pipelineStats.js";
import { FrameAckWindow } from "./frameAckWindow.js";
import { getScaledViewport, imageSize } from "./util.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  sessionId: string;
  // Frames are captured only while clients are connected.
  capturing: boolean;
  // Set when the tab renders on demand (begin-frame control): without clients it renders
  // nothing but keeps running. Otherwise frames come from the screencast, and without clients
  // the tab is hidden (see _pauseIfUnusedAsync).
  frameLoop?: BeginFrameLoop;
  // How the screencast tab was paused, to undo it on reconnect.
  paused?: { windowId: number } | 'frozen';
  // Renders a frame now (on demand only), e.g. so a touch is delivered without waiting.
  requestFrame: () => void;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner

  // trailing throttle state
  pendingB64?: string;
  pendingAtMs?: number; // when the pending frame arrived from the browser
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  // a frame is being processed; frames are processed one at a time
  processing: boolean;
  // last processed screencast frame, to skip identical ones
  processedB64?: string;

  // Screencast frames not acknowledged to Chrome yet (see _releaseScreencastAcks)
  heldAcks: number[];

  // last screencast frame, kept to re-send a full frame on request
  lastB64?: string;
  resendFullFrame: () => void;

  // frames sent but not acknowledged yet, for clients that send FrameAck
  acks: FrameAckWindow;
  handleFrameAck: (frameId: number) => void;

  stats: PipelineStats;
  // frames came smaller than the device and had to be upscaled; logged once
  scaleWarned?: boolean;
  // frames couldn't be cropped as JPEG blocks; logged once
  passthroughWarned?: boolean;
  // reused for decoding rotated frames before they are rotated
  rotateScratch?: Int16Array;
  // replaces cfg.minFrameInterval while set (the self-test sends one frame at a time)
  minFrameIntervalOverride?: number;
  // frameAtMs: when the browser delivered the frame; sentAtMs: when it was handed to the socket
  onFrameSent?: (frameAtMs: number, sentAtMs: number) => void;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');

// The broadcaster wakes a congested device as soon as its socket has written everything;
// this only covers a missed wake-up.
const CONGESTION_FALLBACK_MS = 100;
// Frames in flight to a client that acknowledges them: two let sending the next frame
// overlap with the device drawing the previous one.
const ACK_WINDOW_FRAMES = 2;
// A frame unacknowledged for this long counts as lost.
const ACK_TIMEOUT_MS = 1000;

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
// An already running browser turned out not to have the begin-frame switches.
let _onDemandUnsupported = false;
export const broadcaster = new DeviceBroadcaster();

const _pending = new Map<string, Promise<unknown>>();

// Operations on the same device id run one after another, so e.g. concurrent
// connections can't both see "no device" and each create a browser tab.
function _enqueue<T>(id: string, op: () => Promise<T>): Promise<T> {
  const prev = _pending.get(id);
  const next = (prev ?? Promise.resolve())
    .catch(() => { })
    .then(op);
  _pending.set(id, next);
  next.finally(() => {
    if (_pending.get(id) === next) _pending.delete(id);
  }).catch(() => { });
  return next;
}

export function getDevice(id: string): DeviceSession | undefined {
  return devices.get(id);
}

export function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  return _enqueue(id, () => _ensureDeviceAsync(id, cfg));
}

// Stops capturing once the last client is gone: rendering stops (on demand) or the tab is
// hidden (screencast) until a client reconnects; either way the page keeps running.
export function releaseDeviceAsync(id: string): Promise<void> {
  return _enqueue(id, () => _pauseIfUnusedAsync(id));
}

// Chrome stops producing screencast frames while a few are unacknowledged. Acking a frame
// only once it is used (or dropped) moves the minFrameInterval / congestion / FrameAck
// throttling into Chrome, so it doesn't encode and ship frames that would be thrown away.
// Every path that drops the pending frame must call this, or the screencast stalls.
function _releaseScreencastAcks(dev: DeviceSession): void {
  if (dev.heldAcks.length === 0) return;
  const acks = dev.heldAcks;
  dev.heldAcks = [];
  for (const sessionId of acks)
    dev.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => { });
}

async function _pauseIfUnusedAsync(id: string): Promise<void> {
  const device = devices.get(id);
  if (!device || !device.capturing || broadcaster.getClientCount(id) > 0) return;

  device.capturing = false;
  if (device.throttleTimer) clearTimeout(device.throttleTimer);
  device.throttleTimer = undefined;
  device.pendingB64 = undefined;
  if (device.frameLoop) {
    // Scripts, timers and the page's WebSockets keep running; only rendering stops
    // (~5% Chromium CPU for a page busy with WebSocket messages), and the page stays visible.
    device.frameLoop.stop();
    console.log(`[device] Rendering paused for ${id}: no clients`);
    return;
  }
  _releaseScreencastAcks(device);
  await device.cdp.send('Page.stopScreencast').catch(() => { });
  // Otherwise the page keeps rendering nobody sees until the idle cleanup (measured 16-27%
  // Chromium CPU). A hidden page doesn't render but keeps its scripts, timers and WebSockets,
  // so a dashboard is up to date the moment a client reconnects (~5% for a page busy with
  // WebSocket messages). Only a page that doesn't count as focused is hidden.
  await device.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => { });
  try {
    const root = getRoot()!;
    const { windowId } = await root.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: device.id });
    await root.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    device.paused = { windowId };
    console.log(`[device] Screencast stopped and page hidden for ${id}: no clients`);
  } catch (e) {
    // Freezing also stops scripts, timers and WebSockets; the page reconnects once resumed.
    await device.cdp.send('Page.setWebLifecycleState', { state: 'frozen' }).catch(() => { });
    device.paused = 'frozen';
    console.log(`[device] Screencast stopped and page frozen for ${id}: no clients ` +
      `(can't hide it: ${(e as Error).message})`);
  }
}

// Undoes _pauseIfUnusedAsync for a screencast tab.
async function _unpauseAsync(device: DeviceSession): Promise<void> {
  const paused = device.paused;
  device.paused = undefined;
  if (paused === 'frozen')
    await device.cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => { });
  else if (paused)
    await getRoot()?.send('Browser.setWindowBounds', { windowId: paused.windowId, bounds: { windowState: 'normal' } })
      .catch(() => { });
  await device.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => { });
}

const SCREENCAST = readScreencastConfig();

// Whether changed tiles are cut out of Chrome's JPEG frames instead of being decoded and
// compressed again. The tile grid must fall on JPEG's 16 px MCUs; a rotated frame must be a
// whole number of MCUs (rotateJpegBlocks).
function usesPassthrough(cfg: DeviceConfig): boolean {
  return SCREENCAST.format === 'jpeg' && SCREENCAST.passthrough && cfg.tileSize % 16 === 0 &&
    (cfg.rotation === 0 || (cfg.width % 16 === 0 && cfg.height % 16 === 0));
}

// How Chrome encodes frames. With passthrough, Chrome's encode is what the device gets, so it
// uses the device's quality.
function captureFormat(cfg: DeviceConfig): { format: 'jpeg' | 'png'; quality?: number } {
  return SCREENCAST.format === 'jpeg'
    ? { format: 'jpeg', quality: usesPassthrough(cfg) ? cfg.jpegQuality : SCREENCAST.quality }
    : { format: 'png' };
}

function startScreencastAsync(session: { send(method: any, params?: any): Promise<any> }, cfg: DeviceConfig) {
  return session.send('Page.startScreencast', {
    ...captureFormat(cfg),
    maxWidth: cfg.width,
    maxHeight: cfg.height,
    everyNthFrame: cfg.everyNthFrame
  });
}

// Turns a screencast frame into what the frame processor diffs: DCT blocks when tiles can be
// cut out of Chrome's JPEG as is, otherwise RGB pixels (rescaled and rotated as needed).
async function decodeFrameAsync(dev: DeviceSession, encoded: Buffer): Promise<RGB | JpegFrame> {
  const cfg = dev.cfg, id = dev.deviceId;
  const size = imageSize(encoded);
  const sizeOk = !!size && size.width === cfg.width && size.height === cfg.height;
  if (sizeOk && usesPassthrough(cfg)) {
    // Decode into the arrays of earlier frames instead of allocating ~1 MB per frame.
    const spare = dev.processor.takeSpareCoefficients();
    let blocks: JpegBlocks | null;
    if (cfg.rotation) {
      const unrotated = decodeJpegBlocks(encoded, dev.rotateScratch);
      if (unrotated) dev.rotateScratch = unrotated.coef;
      blocks = unrotated && rotateJpegBlocks(unrotated, cfg.rotation, spare);
    } else {
      blocks = decodeJpegBlocks(encoded, spare);
    }
    if (blocks && dev.processor.acceptsJpegBlocks(blocks))
      return { width: blocks.width, height: blocks.height, jpeg: encoded, blocks, rotation: cfg.rotation };
    if (!dev.passthroughWarned) {
      dev.passthroughWarned = true;
      console.warn(`[device] ${id}: can't cut tiles out of the screencast JPEG directly, re-encoding them`);
    }
  }

  let img = sharp(encoded);
  if (size && !sizeOk) {
    // Chrome renders at most at the browser's device scale factor (MAX_DEVICE_SCALE_FACTOR),
    // and a fractional scale can be a pixel off; stretch the frame to the device size.
    if (!dev.scaleWarned && size.width < cfg.width) {
      dev.scaleWarned = true;
      console.warn(`[device] ${id}: frames are ${size.width}x${size.height} instead of ` +
        `${cfg.width}x${cfg.height}, upscaling; set MAX_DEVICE_SCALE_FACTOR >= ${cfg.scale} for sharp output`);
    }
    const { data, info } = await img.removeAlpha().resize(cfg.width, cfg.height, { fit: 'fill' })
      .raw().toBuffer({ resolveWithObject: true });
    img = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
  }
  if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

  const { data, info } = await img
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Creates the device's tab. With beginFrameControl, `onDemand` says whether it worked: false
// when the browser lacks the switches (only known for a browser that was already running).
async function _openTabAsync(root: NonNullable<ReturnType<typeof getRoot>>, cfg: DeviceConfig, beginFrameControl: boolean):
  Promise<{ targetId: string; session: any; onDemand?: boolean }> {
  // The page is laid out at cfg.width/height divided by the scale and rendered at
  // deviceScaleFactor = scale, so the frames keep the device's physical size.
  const viewport = getScaledViewport(cfg.width, cfg.height, cfg.scale);

  // Full Chrome accepts a window size only for a new window ("Target position can only be
  // set for new windows"); a separate window per device also keeps their sizes independent.
  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: viewport.width,
    height: viewport.height,
    newWindow: true,
    ...(beginFrameControl ? { enableBeginFrameControl: true } : {}),
  });

  try {
    const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true
    });
    const s = (root as any).session(sessionId);

    // Independent commands: one round trip instead of one each. CDP handles a session's
    // commands in order, so the first frame is captured with the final metrics.
    await Promise.all([
      s.send('Page.enable'),
      s.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: cfg.scale,
        mobile: true
      }),
      PREFERS_REDUCED_MOTION && s.send('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      }),
      // Needed for Inspector.targetCrashed.
      s.send('Inspector.enable').catch(() => { }),
      getInjectScriptFromUrl(readInjectScriptConfig()).then(script =>
        script && s.send('Page.addScriptToEvaluateOnNewDocument', { source: script })),
      preparePageAsync(s),
    ]);

    if (beginFrameControl) {
      const onDemand = await s.send('HeadlessExperimental.beginFrame', {}).then(() => true, () => false);
      return { targetId, session: s, onDemand };
    }
    await startScreencastAsync(s, cfg);
    return { targetId, session: s };
  } catch (e) {
    // Don't leave a half-configured tab behind.
    try { await root.send('Target.closeTarget', { targetId }); } catch { }
    throw e;
  }
}

async function _ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      // A new connection: frames in flight to the old one will never be acknowledged,
      // and the new client may not send acks at all.
      device.acks.reset();
      if (device.capturing) {
        device.resendFullFrame();
      } else if (device.frameLoop) {
        device.processedB64 = undefined;
        device.processor.requestFullFrame();
        device.capturing = true;
        device.frameLoop.start();
        console.log(`[device] Rendering resumed for ${id}`);
      } else {
        // The last frame we hold may be stale; the restarted screencast sends a fresh one.
        device.lastB64 = undefined;
        device.processedB64 = undefined;
        device.processor.requestFullFrame();
        await _unpauseAsync(device);
        await startScreencastAsync(device.cdp, device.cfg);
        device.capturing = true;
        console.log(`[device] Page resumed for ${id}`);
      }
      return device;
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  const bfc = _onDemandUnsupported ? 'off' : beginFrameControl();
  let tab = await _openTabAsync(root, cfg, bfc !== 'off');
  if (tab.onDemand === false) {
    _onDemandUnsupported = true;
    // A browser started without the begin-frame switches; a tab created with begin-frame
    // control may not render at all, so start over without it.
    await root.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => { });
    console.warn(`[device] ${id}: this browser can't render on demand, using the screencast`);
    tab = await _openTabAsync(root, cfg, false);
  }
  const { targetId, session } = tab;

  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
  });

  const newDevice: DeviceSession = {
    id: targetId,
    deviceId: id,
    cdp: session,
    sessionId: session.sessionId,
    capturing: true,
    frameLoop: undefined,
    requestFrame: () => { },
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    processor,
    selfTestRunner: new SelfTestRunner(broadcaster),
    pendingB64: undefined,
    throttleTimer: undefined,
    lastProcessedMs: undefined,
    processing: false,
    processedB64: undefined,
    heldAcks: [],
    lastB64: undefined,
    resendFullFrame: () => { },
    acks: new FrameAckWindow(ACK_WINDOW_FRAMES, ACK_TIMEOUT_MS),
    handleFrameAck: () => { },
    stats: newPipelineStats(),
    minFrameIntervalOverride: undefined,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  // The device may be deleted or replaced (reconfiguration, tab crash) while a frame is being
  // processed; its frames must then not reach the clients of the new session.
  const isCurrent = () => devices.get(id) === newDevice;

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;

    if (!dev.pendingB64 || !isCurrent()) {
      _releaseScreencastAcks(dev);
      return;
    }
    if (broadcaster.isCongested(id)) {
      // Keep only the newest frame until the client catches up; the diff is computed
      // against the last frame actually sent, so skipping frames is safe.
      const timer = setTimeout(flushPending, CONGESTION_FALLBACK_MS);
      dev.throttleTimer = timer;
      broadcaster.onceUncongested(id, () => {
        // Stale if the timer already fired or something else rescheduled the flush.
        if (dev.throttleTimer !== timer) return;
        clearTimeout(timer);
        flushPending();
      });
      return;
    }
    if (dev.acks.isFull(Date.now())) {
      // Same, but paced by the client's acks; handleFrameAck resumes as soon as one arrives.
      // The timer only covers a lost ack.
      const wait = Math.max(0, (dev.acks.timeoutAtMs() ?? Date.now()) - Date.now()) + 1;
      dev.throttleTimer = setTimeout(flushPending, wait);
      return;
    }

    const b64 = dev.pendingB64;
    const frameAtMs = dev.pendingAtMs ?? Date.now();
    dev.pendingB64 = undefined;
    // Chrome can prepare the next frame while this one is processed.
    _releaseScreencastAcks(dev);
    if (b64 === dev.processedB64) return;

    // Frames must be processed one at a time: FrameProcessor diffs against the previous
    // frame, and a later frame must never be sent before an earlier one.
    dev.processing = true;
    // The interval is measured from the start of processing, so minFrameInterval is the
    // frame period rather than an extra pause after each frame.
    dev.lastProcessedMs = Date.now();
    const t0 = performance.now();
    try {
      dev.processedB64 = b64;
      const encoded = Buffer.from(b64, 'base64');

      const out = await processor.processFrameAsync(await decodeFrameAsync(dev, encoded));
      if (out.rects.length > 0 && isCurrent()) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        const procMs = performance.now() - t0;
        const bytes = broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
        if (bytes > 0) dev.acks.sent(dev.frameId, Date.now());

        const s = dev.stats;
        s.framesSent++;
        if (out.isFullFrame) s.fullFrames++;
        s.bytesSent += bytes;
        s.rects += out.rects.length;
        for (const r of out.rects) s.maxRectBytes = Math.max(s.maxRectBytes, r.data.length);
        s.procMsTotal += procMs;
        s.procMsMax = Math.max(s.procMsMax, procMs);
        if (bytes > 0) dev.onFrameSent?.(frameAtMs, Date.now());
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.processing = false;
    }
    // Frames that arrived meanwhile were held back; process the newest one.
    if (dev.pendingB64) scheduleFlush();
  };

  const scheduleFlush = () => {
    if (newDevice.throttleTimer || newDevice.processing || !isCurrent()) return;
    const now = Date.now();
    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    const interval = newDevice.minFrameIntervalOverride ?? cfg.minFrameInterval;
    const delay = Math.max(0, interval - (Number.isFinite(since) ? since : 0));
    newDevice.throttleTimer = setTimeout(flushPending, delay);
  };

  // Screencast only emits frames when the page changes, so a full-frame request on a
  // static page has to re-process the last frame we received.
  newDevice.handleFrameAck = (frameId: number) => {
    const first = !newDevice.acks.supported;
    const freed = newDevice.acks.ack(frameId);
    if (first) console.log(`[device] ${id} acknowledges frames: pacing frames to the device`);
    // Waiting for this ack: process the newest pending frame right away.
    if (freed && newDevice.pendingB64 && !newDevice.processing && newDevice.throttleTimer) {
      clearTimeout(newDevice.throttleTimer);
      newDevice.throttleTimer = undefined;
      scheduleFlush();
    }
    // On demand, a changed page waits for the client to be ready; capture it now.
    if (freed) newDevice.requestFrame();
  };

  newDevice.resendFullFrame = () => {
    newDevice.processor.requestFullFrame();
    newDevice.processedB64 = undefined;
    if (newDevice.frameLoop?.running) {
      // A fresh screenshot rather than the last one, which may be older than the page.
      newDevice.frameLoop.invalidate();
      newDevice.frameLoop.requestFrame();
      return;
    }
    if (!newDevice.pendingB64 && newDevice.lastB64) {
      newDevice.pendingB64 = newDevice.lastB64;
      newDevice.pendingAtMs = Date.now();
    }
    if (newDevice.pendingB64)
      scheduleFlush();
  };

  // A captured frame, from either source, becomes the pending one.
  const acceptFrame = (b64: string) => {
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = b64;
    newDevice.pendingAtMs = Date.now();
    scheduleFlush();
  };

  if (tab.onDemand) {
    let errorLogged = false;
    const loop = new BeginFrameLoop(session, {
      screenshot: captureFormat(cfg),
      intervalMs: () => newDevice.minFrameIntervalOverride ?? cfg.minFrameInterval,
      // Capture only what is processed right away; the page keeps changing meanwhile.
      canDeliver: () => isCurrent() && !newDevice.processing && !newDevice.pendingB64 &&
        !broadcaster.isCongested(id) && !newDevice.acks.isFull(Date.now()),
      deliver: (b64) => {
        errorLogged = false;
        newDevice.lastB64 = b64;
        if (broadcaster.getClientCount(id) > 0 && isCurrent()) acceptFrame(b64);
      },
      onError: (e) => {
        // E.g. a crashed tab, which is recreated; one line until frames come again.
        if (!errorLogged && isCurrent()) console.warn(`[device] ${id}: rendering a frame failed: ${e.message}`);
        errorLogged = true;
      },
    });
    newDevice.frameLoop = loop;
    newDevice.requestFrame = () => loop.requestFrame();
    loop.start();
  }

  session.on('Page.screencastFrame', async (evt: any) => {
    newDevice.lastB64 = evt.data;
    if (broadcaster.getClientCount(newDevice.deviceId) === 0 || !isCurrent()) {
      // Nobody will consume it; the screencast is being stopped.
      session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });
      return;
    }
    // Acked once consumed, see _releaseScreencastAcks.
    newDevice.heldAcks.push(evt.sessionId);
    acceptFrame(evt.data);
  });

  const handleNavigation = (url: string) => {
    newDevice.selfTestRunner.handleNavigation(url);
    if (newDevice.url !== url) {
      newDevice.url = url;
      broadcaster.sendCurrentURL(newDevice.deviceId, url);
      console.log(`[device] URL changed to: ${url}`);
    }
  };

  session.on('Page.frameNavigated', (evt: any) => {
    // Only track the main frame, ignore iframes
    if (!evt.frame.parentId) {
      handleNavigation(evt.frame.url);
    }
  });
  session.on('Page.navigatedWithinDocument', (evt: any) => {
    handleNavigation(evt.url);
  });

  // E.g. out of memory on a heavy dashboard: without this the display stays frozen.
  session.on('Inspector.targetCrashed', () => {
    console.warn(`[device] Tab of device ${id} crashed, recreating it`);
    _enqueue(id, () => _recreateCrashedDeviceAsync(newDevice))
      .catch(e => console.warn(`[device] Failed to recreate device ${id}: ${(e as Error).message}`));
  });

  return newDevice;
}

async function _recreateCrashedDeviceAsync(crashed: DeviceSession): Promise<void> {
  const id = crashed.deviceId;
  if (devices.get(id) !== crashed) return; // already replaced or removed

  const url = crashed.url;
  await deleteDeviceAsync(crashed, true);
  const device = await _ensureDeviceAsync(id, crashed.cfg);
  if (url && url !== 'about:blank')
    await device.cdp.send('Page.navigate', { url });
  await _pauseIfUnusedAsync(id);
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs && broadcaster.getClientCount(d.deviceId) === 0)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await _enqueue(id, async () => {
        // A client may have connected while earlier devices were being removed.
        if (devices.get(id) === dev && broadcaster.getClientCount(id) === 0)
          await deleteDeviceAsync(dev);
      }).catch(() => { /* swallow */ });
    }
  } finally {
    _cleanupRunning = false;
  }
}

async function deleteDeviceAsync(device: DeviceSession, crashed = false) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);
  device.frameLoop?.stop();
  device.selfTestRunner.stop();
  if (!crashed) _releaseScreencastAcks(device);

  // A crashed tab doesn't answer, so don't wait for the command to time out.
  if (!crashed && device.capturing && !device.frameLoop)
    await device.cdp.send("Page.stopScreencast").catch(() => { });
  await root?.send("Target.closeTarget", { targetId: device.id }).catch(() => { });
  root?.removeSession(device.sessionId);
}
