// Renders a tab on demand (CAPTURE_MODE=on-demand). A tab created with begin-frame control
// (headless shell only) draws nothing on its own: no layout, paint or requestAnimationFrame
// until the server issues a
// HeadlessExperimental.beginFrame. Its scripts, timers and WebSockets keep running, so a page
// without clients stays live at the cost of its scripts alone.
//
// While running, the loop issues a frame every interval. A frame without a screenshot is
// cheap and reports whether anything changed; a screenshot (a full encode) is only taken when
// something did and the pipeline can process it right away, so it is never stale and nothing
// is encoded for nothing. While the page keeps changing, it captures without asking first.

export type BeginFrameSession = {
  send(method: string, params?: any): Promise<any>;
};

export type ScreenshotParams = { format: 'jpeg' | 'png'; quality?: number };

export type BeginFrameLoopOptions = {
  screenshot: ScreenshotParams;
  // Time between frames, read on every frame (the self-test changes it).
  intervalMs: () => number;
  // Whether a frame captured now would be processed at once.
  canDeliver: () => boolean;
  deliver: (b64: string) => void;
  onError?: (e: Error) => void;
};

// Even with no frame interval (the self-test's single steps), no more than ~60 frames/s.
export const MIN_FRAME_TICK_MS = 16;

// The frame after a screenshot always reports damage, so it can't tell whether the page
// changed in the meantime. That frame is issued right after the screenshot, which keeps the
// window short, and its damage is ignored; once the page is quiet, a check screenshot after
// each of these delays catches a change made in that window. A check that matches the last
// screenshot isn't delivered and moves on to the next delay; the last one repeats.
export const VERIFY_DELAYS_MS = [250, 1000, 4000, 15000];

export class BeginFrameLoop {
  private _running = false;
  private _inFlight = false;
  // Changed since the last screenshot (or never captured).
  private _dirty = true;
  // A frame was asked for while one was in flight.
  private _again = false;
  private _timer?: NodeJS.Timeout;
  private _lastShot?: string;
  // Ticks in a row whose screenshot differed from the one before; from two on, the page is
  // taken to be animating.
  private _changedStreak = 0;
  private _verifyAtMs?: number;
  private _verifyStep = 0;

  constructor(private _s: BeginFrameSession, private _opts: BeginFrameLoopOptions) { }

  get running(): boolean { return this._running; }

  // Starts with a screenshot: the last one sent may be stale.
  start(): void {
    this._dirty = true;
    if (this._running) return this.requestFrame();
    this._running = true;
    this._schedule(0);
  }

  stop(): void {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = undefined;
    this._again = false;
  }

  // Takes a screenshot on the next frame even if nothing changed.
  invalidate(): void {
    this._dirty = true;
  }

  // Issues a frame now instead of at the next interval, e.g. to deliver input: touch events
  // wait for a frame, and so does their effect on the page.
  requestFrame(): void {
    if (!this._running) return;
    if (this._inFlight) { this._again = true; return; }
    this._schedule(0);
  }

  // Ticks in the time Chromium reports to animations.
  private _tickMs(): number {
    return Math.max(MIN_FRAME_TICK_MS, this._opts.intervalMs());
  }

  private _schedule(delayMs: number): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = undefined; void this._frameAsync(); }, delayMs);
  }

  private async _frameAsync(): Promise<void> {
    if (!this._running || this._inFlight) return;
    this._inFlight = true;
    this._again = false;
    const startedMs = Date.now();
    const interval = this._tickMs();
    try {
      // While the page keeps changing, a probe frame would only confirm it: capture directly,
      // until a screenshot matches the previous one.
      const speculate = this._changedStreak >= 2 && !this._dirty && this._opts.canDeliver();
      let captured = false;
      if (!speculate && (!this._dirty || !this._opts.canDeliver())) {
        const r = await this._s.send('HeadlessExperimental.beginFrame', { interval });
        if (r?.hasDamage) this._dirty = true;
      }
      const verify = !this._dirty && !speculate && this._verifyAtMs !== undefined && Date.now() >= this._verifyAtMs;
      if ((this._dirty || verify || speculate) && this._running && this._opts.canDeliver()) {
        const r = await this._s.send('HeadlessExperimental.beginFrame', { interval, screenshot: this._opts.screenshot });
        // No data while the renderer starts up; stays dirty and is retried.
        if (r?.screenshotData && this._running) {
          const changed = r.screenshotData !== this._lastShot;
          this._verifyStep = verify && !changed ? Math.min(this._verifyStep + 1, VERIFY_DELAYS_MS.length - 1) : 0;
          if (this._dirty || changed) this._opts.deliver(r.screenshotData);
          captured = changed && !verify;
          this._dirty = false;
          this._lastShot = r.screenshotData;
          // Absorbs the screenshot's damage. Not awaited: a session runs its commands in
          // order, so the next frame still comes after it.
          this._s.send('HeadlessExperimental.beginFrame', { interval }).catch(() => { });
          this._verifyAtMs = Date.now() + VERIFY_DELAYS_MS[this._verifyStep];
        }
      }
      this._changedStreak = captured ? this._changedStreak + 1 : 0;
    } catch (e) {
      this._opts.onError?.(e as Error);
    } finally {
      this._inFlight = false;
    }
    if (!this._running) return;
    this._schedule(this._again ? 0 : Math.max(0, interval - (Date.now() - startedMs)));
  }
}
