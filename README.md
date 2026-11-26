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

## Authentication

Set the API key before starting the server:

```shell
export WS_SCRCPY_API_KEY="<your-api-key>"
```

Every page load and WebSocket connection must then present the key, either
as a query parameter or in the `Authorization` header:

```
http://<server>:8000/?key=<your-api-key>
```

See [README-部署文档.md](README-部署文档.md) for the full deployment guide
(systemd unit, key rotation, URL formats, embedded-dashboard protocol and
troubleshooting). The document is written in Chinese.

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

## License

[MIT](LICENSE).
