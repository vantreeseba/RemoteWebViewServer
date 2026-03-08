> [!About this fork]
>
> The modifications done in my fork is simple: 
> 1. Provide an on-screen Latin Alphabet / English keyboard so I can do some basic keyentries on my ESP32 powered touch display.
> 2. Create a Packet #6 that can send back the Current URL displayed on the screen back to the Client. This is safe to run on the server while the client does not have the code to process Packet #6 because there is a soft failsafe in the ESP32 Client code to ignore unknown packets

# 1. On-screen Latin Alphabet / English keyboard

There is literally no setup required on this one, I have been lazy and haven't even put together any ENVIRONMENT variables to enable/disable the keyboard.

All you need to do to trial this is to point your Docker Compose file at this GitHub repo (full example code below from Strange-V's hard work).

If you find any bugs please let me know. I might be able to fix things, but if you have a fix yourself, please put in a PR.

```yaml
services:
  rwvserver:
    #image: strangev/remote-webview-server:latest  # use :beta for pre-release
    build: https://github.com/SleepinDevil/RemoteWebViewServer.git  # this line and commenting out the above line is all you need to do to try this
    container_name: remote-webview-server
    restart: unless-stopped
    #### rest of code is all exactly the same
```

Raw Javascript that is being injected for those of you who are curious: https://github.com/SleepinDevil/RemoteWebViewServer/blob/main/unminified-keyboard-for-information-only.js

Some screenshots of the onscreen keyboard:

<img src="images/1.png" height="250px"><img src="images/2.png" height="250px"><img src="images/3.png" height="250px"><img src="images/4.png" height="250px">

# 2. Packet #6 containing URL information to send from server to client

This modification allows the user to know what webpage URL the display is currently showing. This allows automations to temporarily take over and show a different URL on the display and then revert back to the previous URL the display was on. This is just a nice-ity and nothing more.

If you build this server code without having my corresponding ESP32 Client code, then your ESP32 Client will show an unknown Packet #6 warning, but this warning can be safely ignored (or you can build your ESP32 device from my Client code too).

# Original description from Strange-V below

[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/banner-direct-single.svg)](https://stand-with-ukraine.pp.ua)

# Remote WebView Server

Headless browser that renders target web pages (e.g., Home Assistant dashboards) and streams them as image tiles over WebSocket to lightweight [clients](https://github.com/strange-v/RemoteWebViewClient) (ESP32 displays). The server supports multiple simultaneous clients, each with its own screen resolution, orientation, and per-device settings.

![Remote WebView](/images/tiled_preview.png)

## Features

- Renders pages in a headless Chromium environment and streams diffs as tiles over WebSocket.
- Tile merging with change detection to reduce packet count and CPU load
- Full-frame fallback on cadence/threshold or on demand
- Configurable tile size, JPEG quality, WS message size, and min frame interval
- Per-client settings: each connection can supply its own width, height, tileSize, jpegQuality, maxBytesPerMessage, etc.
- Hot reconfigure: reconnecting with new params reconfigures the device session and triggers a full-frame refresh.
- Smarter frame gating: throttling + content-hash dedup (skip identical frames)
- No viewers = no work: frames are ACK’d to keep Chromium streaming, but tiles aren’t encoded/queued when there are no listeners.
- Touch event bridging (down/move/up) — scrolling supported (no gestures yet)
- Client-driven navigation: the client can control which page to open.
- Built-in self-test page to visualize and measure render time
- Health endpoint for container orchestration
- Optional DevTools access via TCP proxy

## Accessing the server’s tab with Chrome DevTools
1. Make sure your server exposes the DevTools (CDP) port (e.g., 9222).
   - If you use a pure Docker container, make sure you have configured and started `debug-proxy`
   - If HA OS addon is used, enable `expose_debug_proxy`
1. In Chrome, go to chrome://inspect/#devices → Configure… → add your host: hostname_or_ip:9222.
1. You should see the page the server opened (the one you want to log into, e.g., Home Assistant). Click inspect to open a full DevTools window for that tab.

## Image Tags & Versioning

- latest — newest stable release
- beta — newest pre-release (rolling)
- Semantic versions: X.Y.Z, plus convenience tags X.Y, X on stable releases

You can pin a stable release (`1.4.0`) or track channels (`latest`, `beta`) depending on your deployment strategy.

## Docker Compose Example

```yaml
services:
  rwvserver:
    #image: strangev/remote-webview-server:latest  # use :beta for pre-release
    build: https://github.com/SleepinDevil/RemoteWebViewServer.git
    container_name: remote-webview-server
    restart: unless-stopped
    environment:
      TILE_SIZE: 32
      FULL_FRAME_TILE_COUNT: 4
      FULL_FRAME_AREA_THRESHOLD: 0.5
      FULL_FRAME_EVERY: 50
      EVERY_NTH_FRAME: 1
      MIN_FRAME_INTERVAL_MS: 80
      JPEG_QUALITY: 85
      MAX_BYTES_PER_MESSAGE: 14336
      WS_PORT: 8081
      DEBUG_PORT: 9221 # internal debug port
      HEALTH_PORT: 18080
      PREFERS_REDUCED_MOTION: false
      USER_DATA_DIR: /pw-data
      BROWSER_LOCALE: "en-US"
    ports:
      - "8081:8081"                   # WebSocket stream
      - "9222:9222"                   # external DevTools via socat
    expose:
      - "18080"                       # health endpoint (internal)
      - "9221"                        # internal DevTools port
    volumes:
      - /opt/volumes/esp32-rdp/pw-data:/pw-data
    shm_size: 1gb
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:18080 || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s

  debug-proxy:
    image: alpine/socat
    container_name: remote-webview-server-debug
    restart: unless-stopped
    network_mode: "service:rwvserver"
    depends_on:
      rwvserver:
        condition: service_healthy
    command:
      - "-d"
      - "-d"
      - "TCP-LISTEN:9222,fork,reuseaddr,keepalive" # external DevTools port
      - "TCP:127.0.0.1:9221"
```
