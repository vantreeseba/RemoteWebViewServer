import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { WebSocket } from "ws";
import { DeviceBroadcaster } from "../src/broadcaster.js";
import { Encoding } from "../src/protocol.js";

// Just enough of a ws socket: send() keeps its callback until flush() "writes it out".
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  pending: (() => void)[] = [];
  send(_data: Buffer, _opts: object, cb: () => void) { this.pending.push(cb); }
  flush() { const p = this.pending; this.pending = []; p.forEach(cb => cb()); }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  close() { this.terminate(); }
}

const frame = (bytes: number) => ({
  rects: [{ x: 0, y: 0, w: 16, h: 16, data: Buffer.alloc(bytes) }],
  isFullFrame: false,
  encoding: Encoding.JPEG,
});

const settle = () => new Promise(r => setTimeout(r, 0));

describe("DeviceBroadcaster.onceUncongested", () => {
  it("wakes the waiter once every packet has been written out, not before", async () => {
    const b = new DeviceBroadcaster();
    const ws = new FakeSocket();
    b.addClient("d", ws as unknown as WebSocket);

    // Two messages: the frame doesn't fit into one.
    b.sendFrameChunked("d", { ...frame(100), rects: [frame(100).rects[0], frame(100).rects[0]] }, 1, 150);
    let woken = 0;
    b.onceUncongested("d", () => woken++);
    expect(woken).toBe(0); // never synchronously

    await settle();
    expect(ws.pending.length).toBe(2);
    expect(woken).toBe(0);

    ws.pending.shift()!();
    expect(woken).toBe(0);
    ws.flush();
    expect(woken).toBe(1);

    // One-shot.
    b.sendFrameChunked("d", frame(10), 2);
    await settle();
    ws.flush();
    expect(woken).toBe(1);
  });

  it("wakes waiters when the last client leaves", async () => {
    const b = new DeviceBroadcaster();
    const ws = new FakeSocket();
    b.addClient("d", ws as unknown as WebSocket);
    b.sendFrameChunked("d", frame(10), 1);
    let woken = 0;
    b.onceUncongested("d", () => woken++);
    b.removeClient("d", ws as unknown as WebSocket);
    expect(woken).toBe(1);
  });

  it("doesn't wake a waiter registered with nothing in flight", async () => {
    const b = new DeviceBroadcaster();
    const ws = new FakeSocket();
    b.addClient("d", ws as unknown as WebSocket);
    let woken = 0;
    b.onceUncongested("d", () => woken++);
    await settle();
    expect(woken).toBe(0);
  });
});
