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

## 认证

启动服务前设置 API key：

```shell
export WS_SCRCPY_API_KEY="<your-api-key>"
```

之后每次页面加载和 WebSocket 连接都必须出示密钥，方式为 query 参数或
`Authorization` 请求头：

```
http://<server>:8000/?key=<your-api-key>
```

跨平台部署步骤（Linux / macOS / Windows / Docker）见 [DEPLOY.md](DEPLOY.md)。
完整部署文档（systemd 单元、密钥轮换、URL 格式、嵌入式仪表盘协议、
故障排查）见 [README-部署文档.md](README-部署文档.md)（中文）。

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

## 许可证

[MIT](LICENSE).
