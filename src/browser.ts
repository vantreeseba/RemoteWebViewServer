import env from "env-var";
import { spawn, ChildProcess } from 'child_process';
import { mkdir } from 'fs/promises';
import { createRequire } from 'module';
import { chromium } from 'playwright-core';
import { getRoot, initCdpRootAsync, waitForCdpReadyAsync } from './cdpRoot.js';

const DEBUG_PORT = +(process.env.DEBUG_PORT || 9221);
const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');
const USER_DATA_DIR = process.env.USER_DATA_DIR || (process.platform === 'win32'
  ? 'C:\\Temp\\remotewebview-profile'
  : '/var/tmp/remotewebview-profile');
const BROWSER_LOCALE = env.get("BROWSER_LOCALE").default("en-US").asString();
// Screencast frames are rendered at no more than the browser's own device scale factor, so a
// client with scale s > this value gets frames upscaled on the server (blurry). Clients with a
// lower scale still render at their own scale.
const MAX_DEVICE_SCALE_FACTOR = env.get("MAX_DEVICE_SCALE_FACTOR").default("1").asFloatPositive();
// screencast: Chromium renders whenever the page changes and pushes frames; a tab without
// clients is hidden. on-demand: the server asks for each frame (begin-frame control, see
// beginFrameLoop.ts), so Chromium renders only frames that are sent. That roughly halves
// Chromium's CPU for a page that animates constantly, but a mostly static page costs a few %
// more (it is polled for changes every frame interval) and a change waits for the next poll
// (~40 ms later at the default interval). Needs the headless shell.
const CAPTURE_MODE = env.get("CAPTURE_MODE").default("screencast").asEnum(["screencast", "on-demand"]);
const BEGIN_FRAME_SWITCHES = ['--enable-begin-frame-control', '--run-all-compositor-stages-before-draw'];

// Chromium is started directly instead of through Playwright. A Playwright launch stays
// connected and instruments every tab, including the device tabs: network, script and console
// events are serialized by Chromium and parsed in Node for nothing (measured 20-35% more
// Chromium CPU and 25-45% more server CPU on a page with a busy WebSocket). Playwright is
// still used to find the browser it installed.
//
// Switches Playwright 1.64 passes, minus the ones for Edge, macOS and its own automation.
const PLAYWRIGHT_SWITCHES = [
  '--disable-field-trial-config',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-back-forward-cache',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-component-update',
  '--no-default-browser-check',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-features=' + [
    'AvoidUnnecessaryBeforeUnloadCheckSync',
    'DestroyProfileOnBrowserClose',
    'DialMediaRouteProvider',
    'GlobalMediaControls',
    'HttpsUpgrades',
    'LensOverlay',
    'MediaRouter',
    'PaintHolding',
    'ThirdPartyStoragePartitioning',
    'Translate',
    'AutoDeElevate',
    'OptimizationHints',
    'NetworkTimeServiceQuerying',
    'AimEnabled',
  ].join(','),
  '--allow-pre-commit-input',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--disable-search-engine-choice-screen',
  '--disable-sync',
  '--enable-unsafe-swiftshader',
  // headless
  '--headless',
  '--hide-scrollbars',
  '--mute-audio',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
];

// Playwright's default fonts for headless Chromium on Linux, so pages render as they did
// when Playwright was attached (Page.setFontFamilies).
const LINUX_FONT_FAMILIES = {
  standard: 'Times New Roman',
  fixed: 'Monospace',
  serif: 'Times New Roman',
  sansSerif: 'Arial',
  cursive: 'Comic Sans MS',
  fantasy: 'Impact',
};

// Graceful close lets Chromium flush the profile (e.g. the Home Assistant login token).
const CLOSE_TIMEOUT_MS = 5000;
const STDERR_TAIL_LINES = 20;

let _child: ChildProcess | undefined;
let _closing = false;
// 'unknown': a browser that was already running, which may or may not have the switches.
let _beginFrameControl: 'on' | 'off' | 'unknown' = 'off';
const _stderrTail: string[] = [];

async function fetchJsonVersionAsync(): Promise<{ webSocketDebuggerUrl: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// The headless shell Playwright uses for `headless: true`; full Chromium if it isn't installed.
function resolveExecutable(): { path: string; headlessShell: boolean } {
  try {
    const require = createRequire(import.meta.url);
    const { registry } = require('playwright-core/lib/coreBundle').registry;
    const path = registry.findExecutable('chromium-headless-shell')?.executablePath();
    if (path) return { path, headlessShell: true };
  } catch { /* internal API moved; fall back */ }
  return { path: chromium.executablePath(), headlessShell: false };
}

// Whether device tabs should be created with begin-frame control. 'unknown' means try it and
// fall back to the screencast if the browser doesn't support it.
export function beginFrameControl(): 'on' | 'off' | 'unknown' {
  return _beginFrameControl;
}

function stderrTail(): string {
  return _stderrTail.length ? `\n${_stderrTail.join('\n')}` : '';
}

async function startHeadlessIfNeededAsync(): Promise<void> {
  const info = await fetchJsonVersionAsync();
  if (info?.webSocketDebuggerUrl) {
    if (CAPTURE_MODE === 'on-demand') _beginFrameControl = 'unknown';
    return;
  }

  const exe = resolveExecutable();
  // Full Chromium has no begin-frame control.
  const onDemand = CAPTURE_MODE === 'on-demand' && exe.headlessShell;
  if (CAPTURE_MODE === 'on-demand' && !onDemand)
    console.warn('[browser] Rendering on demand needs the Chromium headless shell; using the screencast');

  await mkdir(USER_DATA_DIR, { recursive: true });
  const args = [
    ...PLAYWRIGHT_SWITCHES,
    `--user-data-dir=${USER_DATA_DIR}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-sandbox',
    `--force-device-scale-factor=${MAX_DEVICE_SCALE_FACTOR}`,
    '--headless=new',
    // The profile persists (in the add-on it is inside the backed-up /data volume); without a
    // cap its HTTP/code cache grows by hundreds of MB over months.
    '--disk-cache-size=104857600',
    ...(PREFERS_REDUCED_MOTION ? ['--force-prefers-reduced-motion'] : []),
    // With these, every tab renders only on request, so all of them must be created with
    // begin-frame control.
    ...(onDemand ? BEGIN_FRAME_SWITCHES : []),
  ];

  if (PREFERS_REDUCED_MOTION)
    console.log('[browser] Launching with prefers-reduced-motion');

  const child = spawn(exe.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  _child = child;
  // Read stderr so a chatty browser can't block on a full pipe; keep the end for errors.
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      _stderrTail.push(line);
      if (_stderrTail.length > STDERR_TAIL_LINES) _stderrTail.shift();
    }
  });
  child.once('exit', (code, signal) => {
    if (_child === child) _child = undefined;
    if (_closing && code === 0) console.log('[browser] Chromium closed');
    else console.warn(`[browser] Chromium exited (${signal ?? `code ${code}`})${stderrTail()}`);
  });
  const spawnError = new Promise<never>((_, rej) => child.once('error', rej));
  spawnError.catch(() => { });

  const t0 = Date.now();
  for (;;) {
    const j = await Promise.race([fetchJsonVersionAsync(), spawnError]);
    if (j?.webSocketDebuggerUrl) break;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Chromium exited during startup (${exe.path})${stderrTail()}`);
    if (Date.now() - t0 > 10000) throw new Error(`Timed out waiting for CDP /json/version${stderrTail()}`);
    await new Promise(r => setTimeout(r, 200));
  }
  _beginFrameControl = onDemand ? 'on' : 'off';
  console.log(`[browser] Started ${exe.path} (pid ${child.pid}), ` +
    (onDemand ? 'rendering on demand' : 'screencast'));
}

// Never leave a browser behind, e.g. on process.exit() after losing the CDP connection.
process.on('exit', () => {
  try { _child?.kill('SIGKILL'); } catch { }
});

// Closes the browser this process started (a reused one is left running).
export async function closeBrowserAsync(): Promise<void> {
  const child = _child;
  if (!child) return;
  _closing = true;
  const exited = new Promise<void>(res => child.once('exit', () => res()));
  getRoot()?.send('Browser.close').catch(() => { });
  const timer = setTimeout(() => child.kill('SIGKILL'), CLOSE_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

type PageSession = {
  send(method: string, params?: any): Promise<any>;
  on(method: string, cb: (params: any) => void): void;
};

// What Playwright used to apply to every tab it attached to, so pages behave the same.
// The returned promise settles once every setting is applied.
export function preparePageAsync(s: PageSession): Promise<unknown> {
  // Without a handler, alert()/confirm()/prompt() would block the page for good.
  // Like Playwright: dismiss dialogs, but let beforeunload navigate away.
  s.on('Page.javascriptDialogOpening', (evt: any) => {
    s.send('Page.handleJavaScriptDialog', { accept: evt?.type === 'beforeunload' }).catch(() => { });
  });
  return Promise.all([
    // The page counts as focused (focus events, :focus, document.hasFocus()). Turned off while
    // the tab is hidden (see deviceManager).
    s.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
    // navigator.language, Intl and the Accept-Language header.
    s.send('Emulation.setLocaleOverride', { locale: BROWSER_LOCALE }),
    s.send('Emulation.setUserAgentOverride', { userAgent: '', acceptLanguage: BROWSER_LOCALE }),
    process.platform === 'linux' && s.send('Page.setFontFamilies', { fontFamilies: LINUX_FONT_FAMILIES }),
  ]);
}

export async function bootstrapAsync(): Promise<void> {
  await startHeadlessIfNeededAsync();

  const info = await fetchJsonVersionAsync();
  if (!info?.webSocketDebuggerUrl) throw new Error('CDP not available');

  await initCdpRootAsync(info.webSocketDebuggerUrl);
  await waitForCdpReadyAsync();
  // A display has no use for downloads; Playwright used to catch them in a temp directory.
  await getRoot()?.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => { });
  console.log('[cdp] ready:', info.webSocketDebuggerUrl);
}
