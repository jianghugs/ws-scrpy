# ws-scrpy

[English](README.md) | **简体中文**

基于浏览器的安卓设备投屏与群控工具。打开浏览器，即可看到任意一台通过 `adb`
连接的设备的实时画面，并用鼠标和键盘进行操控。服务端负责设备发现与控制通道；
视频流直接在浏览器内解码，因此一台机器可以同时承载数十路独立直播。

专为设备机群场景设计：数十台设备并排镜像显示在仪表盘上，每个面板独立推流，
互不影响画质。

## 功能

### 安卓端

* **屏幕投射** — H.264 视频流通过 WebSocket 传输，由浏览器端内置播放器之一解码：
  * *Mse Player* — 将 NALU 流封装成 mp4，通过 Media Source Extensions 送入
    HTML5 `<video>` 元素，可调用硬件解码。
  * *Broadway Player* — 编译为 WebAssembly 的软件解码器。
  * *TinyH264 Player* — 轻量级软件解码器（WebAssembly）。
  * *WebCodecs Player* — 使用浏览器内置媒体解码器。
* **远程控制** — 触摸事件（含多点触控）、鼠标滚轮、键盘捕获、文本注入、
  剪贴板同步、设备旋转。
* **右键返回** — 在播放器内右键点击会向设备发送 `KEYCODE_BACK`，嵌入式
  仪表盘无需屏幕按钮即可获得自然的「返回」手势。
* **多设备同步控制** — 嵌入式面板把手势上报给父页面，父页面再广播给其他
  面板，让一整组设备执行相同操作。
* **文件推送** — 把 APK 拖放到页面即可推送到设备。
* **远程 shell** — 在浏览器里使用 `adb shell`（xterm.js 终端）。
* **DevTools** — 检查设备上运行的网页与 WebView。
* **文件管理** — 列表、上传与下载文件。

### 本版本的定制

| 功能 | 位置 | 说明 |
| --- | --- | --- |
| API key 认证 | `src/server/Auth.ts` | 所有 HTTP 与 WebSocket 请求都必须携带有效密钥；密钥不出现在任何被版本管理的文件中，通过 `WS_SCRCPY_API_KEY` 环境变量注入。 |
| 原生分辨率编码策略 | `src/app/googDevice/client/StreamClientScrcpy.ts` | 编码尺寸跟随设备当前视频尺寸，长边上限 1280（只缩不放）。再小的预览窗口也不会拉低推流质量。 |
| 多客户端尺寸保护 | 同上 | 已关闭「多客户端交集取最小尺寸」行为——一个小窗口不再能把同一设备的所有其他客户端一起拖到低分辨率。 |
| URL query 透传 | `src/app/index.ts` | `?query` 参数会合并进解析后的查询串，方便外部仪表盘拼装链接（如 `?hideToolbar=1`）。 |
| iframe 尺寸上报 | `src/app/index.ts` | 嵌入式面板会把自身的屏幕宽高比上报给父页面，设备旋转时仪表盘也能保持面板对齐。 |

## 环境要求

服务端：

* Node.js
* `adb` 可执行文件在 `PATH` 环境变量中
* 需要 C/C++ 工具链来编译 `node-pty`（唯一的原生依赖，用于浏览器内远程
  shell）。各平台具体命令见 [DEPLOY.md](DEPLOY.md)。

设备端：

* Android 5.0+（API 21+）
* 已开启 USB 调试
* 部分设备需要额外开启「允许通过键盘鼠标控制」一类的选项

浏览器：

* 支持 WebSockets
* 支持 Media Source Extensions 的 h264 解码（Mse Player 需要）
* 支持 WebWorkers 与 WebAssembly（wasm 播放器需要）

## 构建与启动

```shell
npm install
npm run dist    # 生产构建，输出到 dist/
npm start
```

设备端使用的 `scrcpy-server.jar` 已预编译并随仓库放在 `vendor/` 下，
首次使用时自动推送到设备。

Linux / macOS / Windows / Docker 的完整安装步骤见 [DEPLOY.md](DEPLOY.md)。

## 认证

启动服务前设置 API key：

```shell
export WS_SCRCPY_API_KEY="<your-api-key>"
```

之后每次页面加载和 WebSocket 连接都必须出示密钥，满足以下任意一种方式即可：

| 方式 | 示例 |
| --- | --- |
| URL 参数 | `http://<server>:8000/?key=<KEY>` |
| 请求头 | `X-API-Key: <KEY>` |
| Cookie | `wskey=<KEY>`（首次带 key 加载页面时自动种上） |

校验规则：

* HTTP 层：校验失败返回 `401`（`src/server/services/HttpServer.ts`）。
* WebSocket 层：校验失败直接断开，close code `4003`
  （`src/server/services/WebSocketServer.ts`）。
* Cookie 机制：iframe 场景下浏览器只需在首次加载时带一次 key，之后页面内的
  控制连接自动复用 cookie。

若未设置 `WS_SCRCPY_API_KEY` 环境变量，则认证关闭——对任何可从网络访问的
部署都不推荐。

## 嵌入其他平台

设备列表接口：

```
ws://<server>:8000/?action=goog-device-list&key=<KEY>
→ {"id":-1,"type":"devicelist","data":{"list":[{udid, state, pid, ...}]}}
```

嵌入单台设备的推流 URL 格式：

```
http://<server>:8000/?key=<KEY>#!action=stream&udid=<UDID>&player=mse&ws=<URL编码的ws地址>
ws 地址 = ws://<server>:8000/?action=proxy-adb&remote=tcp:8886&udid=<UDID>&key=<KEY>
```

* `?key=` 必须写在 `#!` 之前。
* 父页面需监听 `iframe_message_resize_<宽高比>` 消息，在设备旋转时保持面板对齐。
* 可选参数：`fitToScreen=1`（铺满容器）、`captureKeyboard=1`（键盘捕获）、
  `hideToolbar=1`（隐藏右侧工具栏）。

两种参数写法都支持：写在 `#!` 之后（原生方式）或写在 `?query` 里（会合并进
解析后的查询串，同名参数以 `#!` 中的为准）。

右侧工具栏也可由父页面动态控制：`iframe.contentWindow.postMessage('hide', '*')`
隐藏、`'show'` 显示。

### 多设备同步控制

推流页与父页面之间通过 `postMessage` 传递触摸事件，用于「主控 → 从机」同步：

| 方向 | 消息格式 | 说明 |
| --- | --- | --- |
| iframe → 父页面 | `touch_report_<type>_<x>_<y>` | `<type>` 为 `mousedown`/`mousemove`/`mouseup`，x/y 为 **0-1 归一化坐标**（相对 `.video` 元素）。仅在鼠标按住拖动时才上报 `mousemove`。 |
| 父页面 → iframe | `touch_inject_<type>_<x>_<y>` | 注入在 **`.video .touch-layer`**（播放器的 `touchableCanvas`）上，由 `document.body` 上已有的触控监听接管。 |

采用归一化坐标，是因为各台设备分辨率和容器大小不同，从机按自己的容器尺寸
还原即可。

⚠️ 注入目标必须是 **`.touch-layer`，不能是 `.video` 容器**：
`FeaturedInteractionHandler` 会校验 `event.target === player.getTouchableElement()`，
不匹配则静默丢弃事件。事件需 `bubbles: true`，`mouseup` 时 `buttons` 置 0。

⚠️ 防回环：父页面必须只转发「主控」的上报，不要把从机的上报再转发出去。

```js
// 父页面
window.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.indexOf('touch_report_') !== 0) { return; }
    if (e.source !== masterFrame.contentWindow) { return; }   // 只认主控
    const payload = e.data.replace('touch_report_', 'touch_inject_');
    slaveFrames.forEach((f) => f.contentWindow.postMessage(payload, '*'));
});
```

### 右键 = 返回键

推流页内置（无需父页面参与，非 iframe 直接访问也生效）：

* 在 `.video` 画面区域内右键：屏蔽浏览器右键菜单，改为向设备下发
  `KEYCODE_BACK`（DOWN + UP）。
* 画面外的右键保持浏览器默认行为。
* 右键的鼠标事件会被阻止进入触控链路，避免在设备上形成带 secondary 按钮的误触。
* 多设备同步扩展：iframe 内右键会上报 `touch_report_back`（无坐标），父页面
  广播 `touch_inject_back` 让从机一起返回。

回归测试：`tests/test_rightclick_back.js`。

## 编码质量策略

编码尺寸取自设备当前视频尺寸（`screenInfo.videoSize`），绝不取浏览器
容器尺寸——嵌入式面板只有两三百像素宽，按容器编码会得到不可读的画面。

```
K = max(W, H)                                       // 设备视频尺寸
s = K > 1280 ? 1280 / K : 1                         // 只缩不放
编码尺寸 = (round(W*s) & ~15, round(H*s) & ~15)      // 16 对齐
```

示例：1080×1920 → 720×1280；1920×1072（横屏）→ 1280×704；720×1280 的
设备保持原样。首帧到达前使用 1920×1920 的大兜底框；设备编码器不会放大，
所以更大的框只意味着「不限制」。

Mse Player 另外请求 12 Mbps / 30 fps。该策略的回归测试是
`tests/test_quality_policy.js`。

## 配置

环境变量：

| 变量 | 用途 |
| --- | --- |
| `WS_SCRCPY_API_KEY` | 所有客户端必须出示的 API key |
| `WS_SCRCPY_CONFIG` | 配置文件（YAML）路径 |
| `WS_SCRCPY_PATHNAME` | 应用不在 `/` 下提供服务时的基础路径 |

配置文件格式见 `src/types/Configuration.d.ts`，示例见 `config.example.yaml`。

## 常见问题排查

**设备起不来，日志刷 `BindException: Address already in use`**

设备端端口被残留进程占用。清理所有设备上的残留 scrcpy 服务：

```bash
for d in $(adb devices | grep 'device$' | awk '{print $1}'); do
  adb -s $d shell 'ps -A -o PID,ARGS | grep "[g]enymobile" | awk "{print \$1}" | xargs -r kill -9'
done
```

⚠️ 严禁在同一台机器同时跑两个 ws-scrcpy 实例——会互相抢占设备端端口。

**端口被占用**

用 `ss -tlnp | grep <port>` 查占用。注意 adb `forward` 可能占用一段本地端口。

**画面比例不对 / 横屏显示成竖框**

前端 bundle 必须包含 `iframe_message_resize_`
（`grep -c iframe_message_resize_ dist/public/bundle.js` 应为 1），父页面必须有
对应监听。浏览器强制刷新清缓存。

**设备端 server 一个进程一生只服务一个 WebSocket 客户端**

连过一次之后进程仍存活、端口仍监听，但不再向新连接吐数据——新手握手成功却
收不到任何数据。重测前先杀掉残留 server。设备还会清空 `/data/local/tmp` 导致
jar 丢失，server 启动报 `ClassNotFoundException: com.genymobile.scrcpy.Server`；
随仓库的验证脚本会自动检测并重推 jar。

## 已知问题

* 安卓模拟器上的服务监听内部接口，外部不可用——请在接口列表中选择
  `proxy over adb`。
* TinyH264Player 可能启动失败，刷新页面即可。
* MsePlayer 在质量统计中可能报告较高的丢帧数。

## 安全

* 浏览器与 node.js 服务之间默认不加密，除非自行配置 HTTPS。
* 服务端与设备上的 WebSocket 服务之间不加密。
* 本版本增加了 API key 认证（见上）；请把密钥排除在版本控制之外，
  并通过环境变量轮换。
* 服务默认监听所有网段接口，仅靠 key 保护；公网暴露时请在防火墙限制来源 IP，
  或前置 HTTPS 反向代理。

## 许可证

[MIT](LICENSE).
