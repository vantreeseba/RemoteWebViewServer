import { WebSocket } from "ws";
import { buildFrameStatsPacket, buildFramePackets, buildCurrentURLPacket } from "./protocol.js";
import type { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId?: number | null; packets: Buffer[] };
type BroadcasterState = { queue: OutFrame[]; sending: boolean };

// Frames a slow client may fall behind before we drop queued frames and
// request a fresh full frame instead of streaming stale deltas.
const MAX_QUEUED_FRAMES = 2;

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _state = new Map<string, BroadcasterState>();

  // Called when queued frames were dropped for a device (slow client); the
  // device should request a full frame so the client resyncs.
  public onFramesDropped?: (id: string) => void;

  // Called when the last client of a device disconnects, so the device can
  // stop paying for rendering nobody sees.
  public onClientCountZero?: (id: string) => void;

  addClient(id: string, ws: WebSocket): void {
    const old = this._clients.get(id);
    if (old && old.size) {
      // The replacement client makes old connections worthless; terminate()
      // frees their buffered data immediately instead of queueing a close
      // handshake behind it.
      for (const sock of old) {
        try { sock.terminate(); } catch {}
      }
      old.clear();
    }

    if (!this._clients.has(id)) this._clients.set(id, new Set());
    this._clients.get(id)!.add(ws);

    if (!this._state.has(id)) this._state.set(id, { queue: [], sending: false });

    console.log(`[broadcaster] Client connected to device ${id}, total clients: ${this._clients.get(id)?.size}`);
    ws.once("close", () => this.removeClient(id, ws));
    ws.once("error", () => this.removeClient(id, ws));
  }

  removeClient(id: string, ws: WebSocket): void {
    const had = this._clients.get(id)?.delete(ws) ?? false;
    if ((this._clients.get(id)?.size ?? 0) === 0) {
      this._clients.delete(id);
      this._state.delete(id);
      if (had) this.onClientCountZero?.(id);
    }
    console.log(`[broadcaster] Client disconnected from device ${id}, total clients: ${this._clients.get(id)?.size ?? 0}`);
  }

  getClientCount(id: string): number {
    return this._clients.get(id)?.size ?? 0;
  }

  // Devices check this before paying for decode/diff/encode: a frame produced
  // while the queue is at cap would be dropped anyway.
  public isQueueFull(id: string): boolean {
    const st = this._state.get(id);
    if (!st) return false;
    let frames = 0;
    for (const f of st.queue) if (f.frameId != null) frames++;
    return frames >= MAX_QUEUED_FRAMES;
  }

  public sendFrameChunked(id: string, data: FrameOut, frameId: number, maxBytes = 12_000): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return;
    if (![...peers].some(ws => ws.readyState === WebSocket.OPEN)) return;

    const st = this._ensureState(id);

    const queuedFrames = st.queue.filter(f => f.frameId != null).length;
    if (queuedFrames >= MAX_QUEUED_FRAMES) {
      // Client can't keep up: stale queued frames are worthless for a
      // display, so drop them (keeping control packets).
      const control = st.queue.filter(f => f.frameId == null);
      st.queue.length = 0;
      st.queue.push(...control);
      if (!data.isFullFrame) {
        // This delta's base may just have been dropped; drop it too and ask
        // the device for a full frame to resync.
        this.onFramesDropped?.(id);
        return;
      }
      // A full frame is complete fresh state — it replaces the dropped queue.
    }

    const packets = buildFramePackets(data.rects, data.encoding, frameId, data.isFullFrame, maxBytes);
    st.queue.push({ frameId, packets });
    this._drainAsync(id).catch(() => {});
  }

  public startSelfTestMeasurement(id: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    const packet = buildFrameStatsPacket();
    const st = this._ensureState(id);
    st.queue.push({ packets: [packet] });
    this._drainAsync(id).catch(() => {});
  }

  public sendCurrentURL(id: string, url: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    const packet = buildCurrentURLPacket(url);
    const st = this._ensureState(id);

    st.queue.push({ packets: [packet] });
    this._drainAsync(id).catch(() => {});
  }

  private _ensureState(id: string): BroadcasterState {
    let st = this._state.get(id);
    if (!st) {
      st = { queue: [], sending: false };
      this._state.set(id, st);
    }
    return st;
  }

  // Resolves true when the packet has been flushed to the socket, false on
  // send error — this is what paces the drain loop to the client's real
  // throughput instead of buffering unboundedly in ws.
  private _sendAsync(ws: WebSocket, pkt: Buffer): Promise<boolean> {
    return new Promise(resolve => {
      try {
        ws.send(pkt, { binary: true }, err => resolve(!err));
      } catch {
        resolve(false);
      }
    });
  }

  private async _drainAsync(id: string): Promise<void> {
    const st = this._ensureState(id);
    if (st.sending) return;
    st.sending = true;

    try {
      const peers = this._clients.get(id);
      if (!peers || peers.size === 0) { st.queue.length = 0; return; }

      while (st.queue.length) {
        const f = st.queue.shift()!;
        for (const pkt of f.packets) {
          const targets: WebSocket[] = [];
          for (const ws of new Set(peers)) {
            if (ws.readyState === WebSocket.OPEN) targets.push(ws);
            else peers.delete(ws);
          }
          if (targets.length === 0) { st.queue.length = 0; return; }

          const results = await Promise.all(targets.map(ws => this._sendAsync(ws, pkt)));
          for (let i = 0; i < targets.length; i++) {
            if (!results[i]) {
              try { targets[i].terminate(); } catch {}
              peers.delete(targets[i]);
            }
          }
          if (peers.size === 0) { st.queue.length = 0; return; }
        }
      }
    } finally {
      st.sending = false;
    }
  }
}
