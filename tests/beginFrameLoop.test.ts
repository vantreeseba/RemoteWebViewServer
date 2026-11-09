import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BeginFrameLoop, MIN_FRAME_TICK_MS, VERIFY_DELAYS_MS } from "../src/beginFrameLoop.js";

// Answers beginFrame like the headless shell: a frame has damage when the page changed since
// the last drawn frame, a screenshot always counts as damage, and so does the frame after it.
class FakeSession {
  calls: { screenshot: boolean; interval: number }[] = [];
  version = 0;               // the page's content; bump it to change the page
  private _drawn = -1;
  private _afterShot = false;
  onFrame?: (screenshot: boolean) => void;
  // When set, frames wait until release() is called.
  hold = false;
  private _held: (() => void)[] = [];

  send(method: string, params: any): Promise<any> {
    expect(method).toBe("HeadlessExperimental.beginFrame");
    const screenshot = !!params.screenshot;
    this.onFrame?.(screenshot);
    this.calls.push({ screenshot, interval: params.interval });
    const hasDamage = screenshot || this._afterShot || this.version !== this._drawn;
    this._drawn = this.version;
    this._afterShot = screenshot;
    const result = screenshot ? { hasDamage, screenshotData: `v${this.version}` } : { hasDamage };
    if (!this.hold) return Promise.resolve(result);
    return new Promise(res => this._held.push(() => res(result)));
  }

  release() { const h = this._held; this._held = []; h.forEach(f => f()); }
  shots() { return this.calls.filter(c => c.screenshot).length; }
}

function makeLoop(s: FakeSession, opts: { interval?: number; canDeliver?: () => boolean } = {}) {
  const delivered: string[] = [];
  const loop = new BeginFrameLoop(s, {
    screenshot: { format: "jpeg", quality: 80 },
    intervalMs: () => opts.interval ?? 80,
    canDeliver: opts.canDeliver ?? (() => true),
    deliver: b64 => delivered.push(b64),
  });
  return { loop, delivered };
}

describe("BeginFrameLoop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("captures once on start, then only renders a static page", async () => {
    const s = new FakeSession();
    const { loop, delivered } = makeLoop(s);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(["v0"]);
    // The frame right after the screenshot absorbs its damage.
    expect(s.calls.map(c => c.screenshot)).toEqual([true, false]);

    await vi.advanceTimersByTimeAsync(200);
    expect(s.shots()).toBe(1);
    loop.stop();
  });

  it("doesn't keep capturing a static page because of the damage screenshots leave", async () => {
    const s = new FakeSession();
    const { loop, delivered } = makeLoop(s);
    loop.start();
    await vi.advanceTimersByTimeAsync(60_000);
    // The start, then one check per delay; the last delay repeats.
    const checks = 3 + Math.floor((60_000 - 5250) / VERIFY_DELAYS_MS.at(-1)!);
    expect(s.shots()).toBeLessThanOrEqual(1 + checks + 1);
    expect(s.shots()).toBeGreaterThanOrEqual(1 + checks - 1);
    // Checks that match the last screenshot aren't delivered.
    expect(delivered).toEqual(["v0"]);
    loop.stop();
  });

  it("captures a change on the next frame", async () => {
    const s = new FakeSession();
    const { loop, delivered } = makeLoop(s);
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    s.version++;
    await vi.advanceTimersByTimeAsync(80);
    expect(delivered).toEqual(["v0", "v1"]);
    loop.stop();
  });

  it("captures an animating page without probe frames, until it stops", async () => {
    const s = new FakeSession();
    const { loop, delivered } = makeLoop(s);
    let animating = true;
    s.onFrame = () => { if (animating) s.version++; };
    loop.start();
    await vi.advanceTimersByTimeAsync(80 * 6 + 10);
    // Per tick: a screenshot and the frame absorbing its damage; after the first two ticks,
    // no probe before it.
    const kinds = s.calls.map(c => c.screenshot ? "S" : ".").join("");
    expect(kinds).toMatch(/^S\.\.S\.(S\.)+$/);
    const sent = delivered.length;
    expect(sent).toBeGreaterThanOrEqual(6);

    animating = false;
    await vi.advanceTimersByTimeAsync(80 * 3);
    // One more screenshot finds the page unchanged; probes from then on.
    expect(delivered.length).toBeLessThanOrEqual(sent + 1);
    expect(s.calls.slice(-2).every(c => !c.screenshot)).toBe(true);
    loop.stop();
  });

  it("catches a change made right after a screenshot with the check screenshot", async () => {
    const s = new FakeSession();
    const { loop, delivered } = makeLoop(s);
    // The page changes just before the frame that absorbs the screenshot's damage.
    let once = true;
    s.onFrame = (screenshot) => {
      if (!screenshot && once && s.calls.at(-1)?.screenshot) { once = false; s.version++; }
    };
    loop.start();
    await vi.advanceTimersByTimeAsync(VERIFY_DELAYS_MS[0] - 10);
    expect(delivered).toEqual(["v0"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(delivered).toEqual(["v0", "v1"]);
    loop.stop();
  });

  it("keeps rendering while the pipeline is busy and captures once it is free", async () => {
    const s = new FakeSession();
    let ready = false;
    const { loop, delivered } = makeLoop(s, { canDeliver: () => ready });
    loop.start();
    await vi.advanceTimersByTimeAsync(80 * 3);
    // Frames go on (input, animations) but nothing is encoded.
    expect(s.calls.length).toBe(4);
    expect(s.shots()).toBe(0);

    ready = true;
    await vi.advanceTimersByTimeAsync(80);
    // Still owed the first frame: captured without waiting for new damage.
    expect(s.shots()).toBe(1);
    expect(delivered.length).toBe(1);
    loop.stop();
  });

  it("delivers a frame on invalidate() even if nothing changed", async () => {
    const s = new FakeSession();
    const { loop, delivered } = makeLoop(s);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.invalidate();
    loop.requestFrame();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(["v0", "v0"]);
    loop.stop();
  });

  it("renders again right after the frame in flight when asked meanwhile", async () => {
    const s = new FakeSession();
    const { loop } = makeLoop(s);
    loop.start();
    await vi.advanceTimersByTimeAsync(100);
    const before = s.calls.length;
    s.hold = true;
    await vi.advanceTimersByTimeAsync(80);
    expect(s.calls.length).toBe(before + 1);
    loop.requestFrame();
    loop.requestFrame();
    s.release();
    await vi.advanceTimersByTimeAsync(0);
    // Once, not twice, and without waiting for the interval.
    expect(s.calls.length).toBe(before + 2);
    s.hold = false;
    s.release();
    loop.stop();
  });

  it("drops a frame that completes after stop() and issues no more", async () => {
    const s = new FakeSession();
    s.hold = true;
    const { loop, delivered } = makeLoop(s);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    s.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(delivered.length).toBe(0);
    expect(s.calls.length).toBe(1);
    loop.requestFrame();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.calls.length).toBe(1);
  });

  it("captures again on restart, since the last frame sent may be stale", async () => {
    const s = new FakeSession();
    const { loop, delivered } = makeLoop(s);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    loop.stop();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered.length).toBe(2);
    loop.stop();
  });

  it("never ticks faster than MIN_FRAME_TICK_MS and reports the tick as the frame interval", async () => {
    const s = new FakeSession();
    const { loop } = makeLoop(s, { interval: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(MIN_FRAME_TICK_MS * 10);
    // + the frame after the first screenshot
    expect(s.calls.length).toBeLessThanOrEqual(13);
    expect(s.calls.every(c => c.interval === MIN_FRAME_TICK_MS)).toBe(true);
    loop.stop();
  });
});
