import type { DeviceSession } from "./deviceManager.js";
import { TouchKind, parseFrameStatsPacket, parseOpenURLPacket, parseTouchPacket } from "./protocol.js";
import { getScaledViewport, mapPointForRotation } from "./util.js";

export class InputRouter {
  // per device id, so one device's moves don't throttle another's
  private _lastMoveAt = new Map<string, number>();
  private readonly _moveThrottleMs: number;

  constructor(moveThrottleMs = 12) {
    this._moveThrottleMs = moveThrottleMs;
  }

  public async handleTouchPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const pkt = parseTouchPacket(buf);
    if (!pkt) return;

    if (pkt.kind === TouchKind.Move) {
      const now = Date.now();
      if (now - (this._lastMoveAt.get(dev.deviceId) ?? 0) < this._moveThrottleMs) return;
      this._lastMoveAt.set(dev.deviceId, now);
    }

    await this._dispatchTouchAsync(dev, pkt.kind, pkt.x, pkt.y);
  }

  public async handleFrameStatsPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const stats = parseFrameStatsPacket(buf);
    if (stats) dev.selfTestRunner.handleClientStats(stats);
  }

  public async handleOpenURLPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const pkt = parseOpenURLPacket(buf);
      if (!pkt) return;

      if (pkt.url === "self-test") {
        await dev.selfTestRunner.startAsync(dev);
      } else {
        dev.selfTestRunner.stop();
        
        if (dev.url !== pkt.url)
          await dev.cdp.send('Page.navigate', { url: pkt.url });
      }
  }

  private async _dispatchTouchAsync(dev: DeviceSession, kind: TouchKind, x: number, y: number): Promise<void> {
    try {
      const id = 1; // single-finger id
      const rotated = mapPointForRotation(
        x, y,
        dev.cfg.width, dev.cfg.height,
        dev.cfg.rotation
      );
      // Touches come in device pixels, CDP expects CSS pixels of the (scaled) viewport.
      const viewport = getScaledViewport(dev.cfg.width, dev.cfg.height, dev.cfg.scale);
      const cssX = rotated.x * viewport.width / dev.cfg.width;
      const cssY = rotated.y * viewport.height / dev.cfg.height;
      const points = [{ x: cssX, y: cssY, radiusX: 1, radiusY: 1, force: 1, id }];

      // A tab rendering on demand handles touches only on its next frame, and shows their
      // effect on the one after; ask for both instead of waiting for the frame interval.
      const touch = async (params: { type: 'touchStart' | 'touchMove' | 'touchEnd'; touchPoints: typeof points }) => {
        const sent = dev.cdp.send('Input.dispatchTouchEvent', params);
        dev.requestFrame();
        await sent;
        dev.requestFrame();
      };

      switch (kind) {
        case TouchKind.Down:
          await touch({ type: 'touchStart', touchPoints: points });
          break;

        case TouchKind.Move:
          await touch({ type: 'touchMove', touchPoints: points });
          break;

        case TouchKind.Up:
          await touch({ type: 'touchEnd', touchPoints: [] });
          break;

        case TouchKind.Tap:
          await touch({ type: 'touchStart', touchPoints: points });
          await touch({ type: 'touchEnd', touchPoints: [] });
          break;
      }
    } catch (e) {
      console.warn(`Failed to dispatch touch event: ${(e as Error).message}`);
    }
  }
}
