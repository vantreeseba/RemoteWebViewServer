import WebSocket from 'ws';

type CdpMsg = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
  sessionId?: string;
};
type Pending = { resolve: (v: any) => void; reject: (e: any) => void };

class CdpConnection {
  private ws: WebSocket;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, CdpSession>();
  private _closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('close', () => this._onClosed(new Error('CDP connection closed')));
    ws.on('error', (err) => this._onClosed(err));
    ws.on('message', (data) => this._onMessage(data));
  }

  static async connect(wsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return new CdpConnection(ws);
  }

  get closed(): boolean { return this._closed; }

  send<T = any>(method: string, params?: any): Promise<T> {
    return this.sendCommand<T>(method, params);
  }

  // Single send path for root and session commands. Commands after the
  // connection closes reject immediately — ws.send on a closed socket
  // without a callback silently drops the payload, which previously left
  // callers hanging forever and leaked their pending entries.
  sendCommand<T = any>(method: string, params?: any, sessionId?: string): Promise<T> {
    if (this._closed) return Promise.reject(new Error('CDP connection closed'));

    const id = this.seq++;
    const payload = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private _onClosed(err: Error): void {
    if (this._closed) return;
    this._closed = true;
    console.error(`[cdp] Connection lost: ${err.message} — device setup will fail until restart; health endpoint now reports failure`);
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.sessions.clear();
  }

  session(sessionId: string): CdpSession {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = new CdpSession(this, sessionId);
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // Sessions are never removed otherwise; without this, every closed target
  // leaks its CdpSession, its handlers, and the device state they capture.
  releaseSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private _onMessage(data: WebSocket.RawData) {
    const msg = JSON.parse(String(data)) as CdpMsg;
    // Route session-scoped events
    if (msg.sessionId && msg.method) {
      const s = this.sessions.get(msg.sessionId);
      s?.emit(msg.method, msg.params);
      return;
    }
    // Resolve command responses
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
    }
  }
}

type Handler = (p: any) => void;
export class CdpSession {
  constructor(private root: CdpConnection, public sessionId: string) { }
  private handlers = new Map<string, Set<Handler>>();

  send<T = any>(method: string, params?: any): Promise<T> {
    return this.root.sendCommand<T>(method, params, this.sessionId);
  }
  on(method: string, cb: Handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(cb);
  }
  emit(method: string, params: any) {
    this.handlers.get(method)?.forEach(fn => fn(params));
  }
}

let root: CdpConnection | null = null;
let sharedContextId = '';
let readyPromise: Promise<void> | null = null;

export async function initCdpRootAsync(wsUrl: string): Promise<void> {
  if (readyPromise) return readyPromise;
  
  readyPromise = (async () => {
    root = await CdpConnection.connect(wsUrl);

    try {
      const info = await root.send<any>('SystemInfo.getInfo');
      console.log('[cdp] GPU vendor/renderer:', info?.gpu?.auxAttributes);
    } catch { /* ignore */ }
  })();
  
  return readyPromise;
}

export function waitForCdpReadyAsync(): Promise<void> {
  if (readyPromise) return readyPromise;
  return Promise.reject(new Error('CDP not initialized'));
}

export function getRoot() { return root; }
export function getSharedContextId() { return sharedContextId; }

// Health-check hook: false once the browser connection has died, so
// orchestrator watchdogs (HA add-on, docker healthcheck) restart the server
// instead of leaving a zombie that can't create devices.
export function isCdpHealthy(): boolean {
  return root != null && !root.closed;
}
