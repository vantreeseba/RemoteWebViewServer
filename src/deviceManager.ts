import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual, readInjectScriptConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  sessionId: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  prevFrameHash: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner

  // trailing throttle state
  pendingB64?: string;
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  processing: boolean;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();
// Deltas are only valid in sequence; after the broadcaster drops frames for
// a lagging client, resync it with a full frame.
broadcaster.onFramesDropped = (id) => devices.get(id)?.processor.requestFullFrame();
// Without a screencast consumer Chromium still composites and PNG-encodes
// every frame; stop it while nobody is watching (restarted on reconnect).
broadcaster.onClientCountZero = (id) => {
  pauseScreencastAsync(id).catch(e =>
    console.warn(`[device] Failed to pause screencast for ${id}: ${(e as Error).message}`));
};

const screencastParams = (cfg: DeviceConfig) => ({
  format: 'png' as const,
  maxWidth: cfg.width,
  maxHeight: cfg.height,
  everyNthFrame: cfg.everyNthFrame,
});

async function pauseScreencastAsync(id: string): Promise<void> {
  const dev = devices.get(id);
  if (!dev || broadcaster.getClientCount(id) > 0) return;

  dev.lastActive = Date.now();
  await dev.cdp.send('Page.stopScreencast');
  console.log(`[device] Screencast paused for idle device ${id}`);

  // A client may have connected while stopScreencast was in flight, and CDP
  // applies commands in order — make sure the stream is running again.
  if (broadcaster.getClientCount(id) > 0 && devices.get(id) === dev) {
    await dev.cdp.send('Page.startScreencast', screencastParams(dev.cfg));
    dev.processor.requestFullFrame();
  }
}

export async function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      // Screencast may be paused from a zero-client period; (re)starting is
      // idempotent and the client needs a full frame either way.
      await device.cdp.send('Page.startScreencast', screencastParams(cfg));
      device.processor.requestFullFrame();
      return device;
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: cfg.width,
    height: cfg.height,
  });

  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  });
  const session = (root as any).session(sessionId);

  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: 1,
    mobile: true
  });
  if (PREFERS_REDUCED_MOTION) {
    await session.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }

  const keyboardScript = await getInjectScriptFromUrl(readInjectScriptConfig());
  if (keyboardScript) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: keyboardScript });
  }

  await session.send('Page.startScreencast', screencastParams(cfg));

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
    sessionId,
    cdp: session,
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    prevFrameHash: 0,
    processor,
    selfTestRunner: new SelfTestRunner(broadcaster),
    pendingB64: undefined,
    throttleTimer: undefined,
    lastProcessedMs: undefined,
    processing: false,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;
    if (dev.processing) return;

    const b64 = dev.pendingB64;
    dev.pendingB64 = undefined;
    if (!b64) return;

    dev.processing = true;
    try {
      const pngFull = Buffer.from(b64, 'base64');

      const h32 = hash32(pngFull);
      if (dev.prevFrameHash === h32) {
        dev.lastProcessedMs = Date.now();
        return;
      }
      dev.prevFrameHash = h32;

      let img = sharp(pngFull);
      if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

      // Screencast PNGs are opaque RGB(A); decoding without ensureAlpha
      // avoids paying for a 4th channel in every downstream copy/hash/encode.
      let { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
      if (info.channels < 3) {
        // Grayscale PNGs shouldn't occur from the screencast; normalize.
        let fb = sharp(pngFull).toColourspace('srgb').ensureAlpha();
        if (dev.cfg.rotation) fb = fb.rotate(dev.cfg.rotation);
        ({ data, info } = await fb.raw().toBuffer({ resolveWithObject: true }));
      }
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height, channels: info.channels });
      if (out.rects.length > 0) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.processing = false;
      dev.lastProcessedMs = Date.now();
      // A frame that arrived mid-processing found the timer unset and
      // processing true; schedule it now so it isn't stranded.
      if (dev.pendingB64 && !dev.throttleTimer) {
        dev.throttleTimer = setTimeout(flushPending, cfg.minFrameInterval);
      }
    }
  };

  session.on('Page.screencastFrame', async (evt: any) => {
    // ACK immediately to keep producer running
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });

    if (broadcaster.getClientCount(newDevice.deviceId) === 0)
      return;
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = evt.data;

    const now = Date.now();
    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    // `processing` guards against scheduling a second, concurrent flush while
    // an earlier one is still mid-pipeline (flushPending re-arms on exit).
    if (!newDevice.throttleTimer && !newDevice.processing) {
      const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
      newDevice.throttleTimer = setTimeout(flushPending, delay);
    }
  });

  const handleNavigation = (url: string) => {
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
  
  return newDevice;
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await deleteDeviceAsync(dev).catch(() => { /* swallow */ });
    }
  } finally {
    _cleanupRunning = false;
  }
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);
  device.selfTestRunner.stop();

  try { await device.cdp.send("Page.stopScreencast").catch(() => { }); } catch { }
  try { await root?.send("Target.closeTarget", { targetId: device.id }); } catch { }
  root?.releaseSession(device.sessionId);
}
