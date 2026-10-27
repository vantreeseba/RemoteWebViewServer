import { WebSocket } from "ws";
import { buildFrameStatsPacket, buildFramePackets, buildCurrentURLPacket } from "./protocol.js";
import type { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId?: number | null; packets: Buffer[] };
type BroadcasterState = { queue: OutFrame[]; sending: boolean };

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _state = new Map<string, BroadcasterState>();

  addClient(id: string, ws: WebSocket): void {
    const old = this._clients.get(id);
    if (old && old.size) {
      // terminate(), not close(): close() waits behind the frames still buffered for the old
      // socket, which keeps that memory and the half-dead connection around.
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

  // Called by both this class's and the server's close handlers; only the first one counts.
  removeClient(id: string, ws: WebSocket): void {
    if (!this._clients.get(id)?.delete(ws)) return;
    if ((this._clients.get(id)?.size ?? 0) === 0) {
      this._clients.delete(id);
      this._state.delete(id);
    }
    console.log(`[broadcaster] Client disconnected from device ${id}, total clients: ${this._clients.get(id)?.size ?? 0}`);
  }

  getClientCount(id: string): number {
    return this._clients.get(id)?.size ?? 0;
  }

  // True while a client's socket still holds unsent data, i.e. the link is slower than
  // the frame rate. Encoding more frames then would only queue up stale ones.
  // Data already handed to the OS send buffer isn't visible here.
  isCongested(id: string): boolean {
    const st = this._state.get(id);
    if (st && (st.sending || st.queue.length > 0)) return true;
    const peers = this._clients.get(id);
    if (!peers) return false;
    for (const ws of peers) {
      if (ws.bufferedAmount > 0) return true;
    }
    return false;
  }

  // Returns the number of bytes queued (0 when there is nobody to send to).
  public sendFrameChunked(id: string, data: FrameOut, frameId: number, maxBytes = 12_000): number {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return 0;

    const packets = buildFramePackets(data.rects, data.encoding, frameId, data.isFullFrame, maxBytes);

    const st = this._ensureState(id);
    st.queue.push({ frameId, packets });
    this._drainAsync(id).catch(() => {});
    return packets.reduce((n, p) => n + p.length, 0);
  }

  // Asks the client for its render stats since the previous request (it resets them on reply).
  public requestFrameStats(id: string): boolean {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return false;

    this._queueControl(id, buildFrameStatsPacket());
    return true;
  }

  public sendCurrentURL(id: string, url: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    this._queueControl(id, buildCurrentURLPacket(url));
  }

  // Control packets go ahead of queued frames (a large frame on a slow link would delay
  // them), but after control packets already waiting, so their order is kept.
  private _queueControl(id: string, packet: Buffer): void {
    const st = this._ensureState(id);
    let i = 0;
    while (i < st.queue.length && st.queue[i].frameId == null) i++;
    st.queue.splice(i, 0, { packets: [packet] });
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
          for (const ws of new Set(peers)) {
            if (ws.readyState !== WebSocket.OPEN) {
              peers.delete(ws);
              continue;
            }
            try {
              ws.send(pkt, { binary: true });
            } catch {
              // drop on send error
              try { ws.close(); } catch {}
              peers.delete(ws);
            }
          }
          if (peers.size === 0) { st.queue.length = 0; return; }
          await Promise.resolve();
        }
      }
    } finally {
      st.sending = false;
    }
  }
}
