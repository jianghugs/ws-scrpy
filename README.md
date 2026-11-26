# ws-scrpy

**English** | [简体中文](README.zh-CN.md)

Web-based Android device mirroring and control. Open a browser, see the live
screen of any device connected over `adb`, and control it with mouse and
keyboard. The server handles device discovery and the control channel; the
video stream is decoded directly in the browser, so a single machine can host
dozens of simultaneous streams.

Built for device-farm scenarios: dozens of devices are mirrored side by side
in a dashboard, each panel streaming independently at full quality.

## Features

### Android

* **Screen casting** — H.264 video streamed over WebSocket, decoded in the
  browser by one of the bundled players:
  * *Mse Player* — builds mp4 containers from the NALU stream and feeds them
    to an HTML5 `<video>` element via Media Source Extensions; can use
    hardware acceleration.
  * *Broadway Player* — software decoder compiled to WebAssembly.
  * *TinyH264 Player* — lightweight software decoder (WebAssembly).
  * *WebCodecs Player* — uses the browser's built-in media decoder.
* **Remote control** — touch events (including multi-touch), mouse wheel
  scrolling, keyboard capture, text injection, clipboard sync, and device
  rotation.
* **Right-click = back** — a right click inside the player sends
  `KEYCODE_BACK` to the device, so embedded dashboards get a natural
  "go back" gesture without an on-screen button.
* **Multi-device synchronized control** — an embedded panel reports back
  gestures to its parent page, which broadcasts them to all other panels so
  a fleet of devices performs the same action together.
* **File push** — drag & drop an APK onto the page to push it to the device.
* **Remote shell** — `adb shell` in your browser (xterm.js terminal).
* **DevTools** — inspect web pages and WebViews running on the device.
* **File management** — list, upload and download files.

### This build's additions

| Feature | Where | Notes |
| --- | --- | --- |
| API key authentication | `src/server/Auth.ts` | All HTTP and WebSocket requests require a valid key; the key never appears in any tracked file — set it via the `WS_SCRCPY_API_KEY` environment variable. |
| Native-resolution encoding policy | `src/app/googDevice/client/StreamClientScrcpy.ts` | Encoding size follows the device's current video size, capped at a 1280 px long side (downscale only). A small viewer panel can no longer degrade the stream. |
| Multi-client size protection | same file | The "intersect bounds across clients" behaviour is disabled — one small window can no longer force every other client of the same device down to a low resolution. |
| URL query passthrough | `src/app/index.ts` | `?query` parameters are merged into the parsed query string, which makes it easy for external dashboards to compose links (e.g. `?hideToolbar=1`). |
| iframe size reporting | `src/app/index.ts` | The embedded panel reports its on-screen aspect ratio to the parent page, so dashboards can keep panels aligned while devices rotate. |

## Requirements

Server:

* Node.js
* `adb` executable available in the `PATH` environment variable
* A C/C++ toolchain to compile `node-pty` (the only native dependency, used
  for the in-browser remote shell). See [DEPLOY.md](DEPLOY.md) for the exact
  per-platform commands.

Device:

* Android 5.0+ (API 21+)
* USB debugging enabled
* On some devices an additional option must be enabled to allow control via
  keyboard and mouse

Browser:

* WebSockets
* Media Source Extensions with h264 decoding (for the Mse player)
* WebWorkers and WebAssembly (for the wasm players)

## Build and Start

```shell
npm install
npm run dist    # production build into dist/
npm start
```

The prebuilt `scrcpy-server.jar` for the device side is bundled under
`vendor/` and is pushed to each device automatically on first use.

For full installation steps on Linux, macOS, Windows and Docker, see
[DEPLOY.md](DEPLOY.md).

## Authentication

Set the API key before starting the server:

```shell
export WS_SCRCPY_API_KEY="<your-api-key>"
```

Every page load and WebSocket connection must then present the key, via one
of the following:

| Method | Example |
| --- | --- |
| URL parameter | `http://<server>:8000/?key=<KEY>` |
| Request header | `X-API-Key: <KEY>` |
| Cookie | `wskey=<KEY>` (set automatically on the first keyed page load) |

Enforcement:

* HTTP layer: invalid requests get `401` (`src/server/services/HttpServer.ts`).
* WebSocket layer: invalid connections are closed with code `4003`
  (`src/server/services/WebSocketServer.ts`).
* Cookie mechanism: in an iframe, the browser only needs the key on the first
  page load; subsequent control connections inside the page reuse the cookie.

If the `WS_SCRCPY_API_KEY` environment variable is not set, authentication is
disabled — not recommended for anything reachable from a network.

## Embedding in another platform

The device-list endpoint:

```
ws://<server>:8000/?action=goog-device-list&key=<KEY>
→ {"id":-1,"type":"devicelist","data":{"list":[{udid, state, pid, ...}]}}
```

Stream URL format for embedding a single device:

```
http://<server>:8000/?key=<KEY>#!action=stream&udid=<UDID>&player=mse&ws=<urlencoded-ws-address>
ws address = ws://<server>:8000/?action=proxy-adb&remote=tcp:8886&udid=<UDID>&key=<KEY>
```

* `?key=` must come before `#!`.
* The parent page should listen for `iframe_message_resize_<aspect-ratio>`
  messages to keep panels aligned while devices rotate.
* Optional parameters: `fitToScreen=1` (fill the container),
  `captureKeyboard=1` (keyboard capture), `hideToolbar=1` (hide the right
  toolbar).

Both parameter styles are supported: after `#!` (native) and in `?query`
(merged into the parsed query; values in `#!` win on conflict).

The right toolbar can also be controlled from the parent page:
`iframe.contentWindow.postMessage('hide', '*')` and `'show'`.

### Multi-device synchronized control

The stream page exchanges touch events with the parent page via
`postMessage`, used for "master → slave" synchronization:

| Direction | Message format | Notes |
| --- | --- | --- |
| iframe → parent | `touch_report_<type>_<x>_<y>` | `<type>` is `mousedown`/`mousemove`/`mouseup`; x/y are **0-1 normalized coordinates** (relative to the `.video` element). `mousemove` is only reported while the mouse button is held. |
| parent → iframe | `touch_inject_<type>_<x>_<y>` | Injected on **`.video .touch-layer`** (the player's `touchableCanvas`), picked up by the existing touch listener on `document.body`. |

Normalized coordinates are used because devices have different resolutions
and container sizes; each slave maps them onto its own container.

The injection target must be **`.touch-layer`, not the `.video` container**:
`FeaturedInteractionHandler` checks `event.target === player.getTouchableElement()`
and silently drops the event otherwise. Events need `bubbles: true`, and
`buttons` must be 0 on `mouseup`.

Prevent loops: the parent must forward only the *master's* reports to the
other iframes — never forward a slave's reports back out.

```js
// parent page
window.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.indexOf('touch_report_') !== 0) { return; }
    if (e.source !== masterFrame.contentWindow) { return; }   // master only
    const payload = e.data.replace('touch_report_', 'touch_inject_');
    slaveFrames.forEach((f) => f.contentWindow.postMessage(payload, '*'));
});
```

### Right-click = back

Built into the stream page (no parent-page participation needed, works even
when accessed directly):

* Right-click inside the `.video` area suppresses the context menu and sends
  `KEYCODE_BACK` (DOWN + UP) instead.
* Right-click outside the player keeps the default browser behaviour.
* The right-click's mouse events are blocked from the touch pipeline to avoid
  accidental touches with a secondary button.
* For synchronized control, a right-click inside an iframe reports
  `touch_report_back` (no coordinates); the parent broadcasts
  `touch_inject_back` so slaves go back together.

Regression test: `tests/test_rightclick_back.js`.

## Encoding quality policy

Encoding size is derived from the device's current video size
(`screenInfo.videoSize`), never from the browser container size — an
embedded panel is only a couple of hundred pixels wide, and sizing the
encoder by the container would produce an unreadable picture.

```
K = max(W, H)                                  // device video size
s = K > 1280 ? 1280 / K : 1                    // downscale only
encoding size = (round(W*s) & ~15, round(H*s) & ~15)
```

Examples: 1080×1920 → 720×1280; 1920×1072 (landscape) → 1280×704; a
720×1280 device is left untouched. Until the first frame arrives, a large
1920×1920 fallback box is used; the device encoder never upscales, so a
larger box simply means "no limit".

The Mse player additionally requests 12 Mbps / 30 fps. The regression test
for this policy is `tests/test_quality_policy.js`.

## Configuration

Environment variables:

| Variable | Purpose |
| --- | --- |
| `WS_SCRCPY_API_KEY` | API key required by all clients (see above) |
| `WS_SCRCPY_CONFIG` | Path to the configuration file (YAML) |
| `WS_SCRCPY_PATHNAME` | Base pathname if the app is not served from `/` |

Configuration file format: `src/types/Configuration.d.ts`; an example is
provided in `config.example.yaml`.

## Troubleshooting

**Device won't start, logs show `BindException: Address already in use`**

A leftover process is holding the device-side port. Clear stale scrcpy
servers on all devices:

```bash
for d in $(adb devices | grep 'device$' | awk '{print $1}'); do
  adb -s $d shell 'ps -A -o PID,ARGS | grep "[g]enymobile" | awk "{print \$1}" | xargs -r kill -9'
done
```

⚠️ Never run two ws-scrcpy instances on the same machine — they will fight
over the device-side port.

**Port is already in use**

Check with `ss -tlnp | grep <port>`. Note that adb `forward` may consume a
range of local ports.

**Wrong aspect ratio / landscape shown as a portrait box**

The front-end bundle must contain `iframe_message_resize_`
(`grep -c iframe_message_resize_ dist/public/bundle.js` should be 1) and the
parent page must have the matching listener. Hard-refresh the browser.

**A device-side server serves exactly one WebSocket client**

Once connected, the process stays alive and the port keeps listening, but it
no longer streams data to new connections — a new handshake succeeds but
delivers nothing. Kill the stale server before re-testing. Devices also wipe
`/data/local/tmp`, which drops the jar; the server then aborts with
`ClassNotFoundException: com.genymobile.scrcpy.Server`. The bundled
verification scripts detect and re-push the jar automatically.

## Known issues

* The server on the Android Emulator listens on the internal interface and
  is not available from the outside — select `proxy over adb` from the
  interfaces list.
* TinyH264Player may fail to start; reload the page if it happens.
* MsePlayer may report a high dropped-frame count in the quality
  statistics.

## Security

* There is no encryption between the browser and the node.js server unless
  you configure HTTPS yourself.
* There is no encryption between the server and the WebSocket server on the
  device.
* This build adds API key authentication (see above); keep the key out of
  version control and rotate it via the environment variable.
* The server listens on all interfaces by default and relies on the key for
  protection; for public exposure, restrict source IPs at the firewall or
  put an HTTPS reverse proxy in front.

## License

[MIT](LICENSE).
