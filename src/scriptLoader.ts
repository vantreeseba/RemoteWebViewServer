import { InjectScriptConfig } from "./config.js";

let cachedUrl: string | undefined;
let cachedScript: string | undefined;
let failedUrl: string | undefined;
let failedAt = 0;

// A failing URL is retried at most this often; without it a slow/unreachable
// INJECT_JS_URL blocks every device (re)connect for the full fetch timeout.
const FAILURE_RETRY_MS = 60_000;

function isAllowedProtocol(url: URL, allowHttp: boolean): boolean {
  if (url.protocol === "https:") return true;
  if (allowHttp && url.protocol === "http:") return true;
  return false;
}

function markFailed(url: string): undefined {
  failedUrl = url;
  failedAt = Date.now();
  return undefined;
}

export async function getInjectScriptFromUrl(cfg: InjectScriptConfig): Promise<string | undefined> {
  if (!cfg.url) {
    console.warn("[inject] INJECT_JS_URL is not set; script injection skipped");
    return undefined;
  }

  if (cachedUrl === cfg.url && cachedScript) {
    return cachedScript;
  }

  if (failedUrl === cfg.url && Date.now() - failedAt < FAILURE_RETRY_MS) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cfg.url);
  } catch {
    console.warn("[inject] Invalid INJECT_JS_URL; script injection skipped");
    return markFailed(cfg.url);
  }

  if (!isAllowedProtocol(parsedUrl, cfg.allowHttp)) {
    console.warn("[inject] INJECT_JS_URL must use https (or http when INJECT_JS_ALLOW_HTTP=true)");
    return markFailed(cfg.url);
  }

  if (typeof fetch !== "function") {
    console.warn("[inject] fetch is not available in this Node runtime; script injection skipped");
    return markFailed(cfg.url);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(parsedUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "application/javascript, text/javascript, text/plain;q=0.9, */*;q=0.8",
      },
    });

    if (!response.ok) {
      console.warn(`[inject] Failed to download script: HTTP ${response.status}; script injection skipped`);
      return markFailed(cfg.url);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const script = bytes.toString("utf8");
    if (!script.trim()) {
      console.warn("[inject] Downloaded script is empty; script injection skipped");
      return markFailed(cfg.url);
    }

    cachedUrl = cfg.url;
    cachedScript = script;
    failedUrl = undefined;
    return script;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[inject] Failed to download script: ${message}; script injection skipped`);
    return markFailed(cfg.url);
  } finally {
    clearTimeout(timeout);
  }
}
