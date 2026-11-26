# ws-scrcpy 部署文档（新版 · 端口 8000）

> 服务器：192.168.1.210（Proxmox VE 宿主机 pve）  
> 最后更新：2026-10-22  
> 本目录：`/data/ws-scrcpy-new/`（新版，当前线上运行）  
> 旧版目录：`/data/ws-scrcpy/`（已停用，仅作回滚备份）

---

## 〇、从部署包部署（推荐）

部署包：`ws-scrcpy-8000-<日期>.tar.gz`（含源码、构建产物、node_modules、部署文档、一键脚本），
**自带全部依赖，目标机无需外网**。

前置条件：目标机已装 **Node.js ≥ 18**（`node -v` 确认，v20 最佳）、systemd。

```bash
# 1. 解压（建议放 /data/ws-scrcpy-new，与本文档其他章节路径一致）
mkdir -p /data && tar xzf ws-scrcpy-8000-<日期>.tar.gz -C /data
cd /data/ws-scrcpy-new

# 2. 一键部署（会问你访问密钥，直接回车则自动生成随机密钥）
bash deploy.sh

# 3. 验证
systemctl status ws-scrcpy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/                 # 期望 401
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8000/?key=<你的密钥>" # 期望 200
```

`deploy.sh` 做了什么：`node_modules` 缺失时执行 `npm ci`（离线包已带，会跳过）→
生成 `/etc/systemd/system/ws-scrcpy.service`（密钥写入环境变量）→
`daemon-reload + enable --now` → 打印密钥和验证命令。

换机部署后记得：

- 改 `config.yaml` 里的 `port`（如与现有端口冲突）
- 把密钥同步给 8100 的 `auth.json`（`ws_key` 字段）和所有嵌入方
- 设备端 jar 会自动推送，无需手动

---

## 一、这是什么

[NetrisTV/ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) 的网页版安卓投屏服务：  
浏览器打开即可看到手机实时画面并用鼠标触控。服务端只做设备发现和指令通道，  
视频流由浏览器直接解码，单机可承载几十路。

**当前运行版本**：

| 项                | 值                                       |
| ---------------- | --------------------------------------- |
| 上游 commit        | `cd6cea6`（2026-09-30 master）            |
| 内置 scrcpy-server | **1.19-ws8**（支持 Android 14/15）          |
| 本地定制 1           | API 密钥认证（`src/server/Auth.ts`，上游没有）     |
| 本地定制 2           | iframe 比例上报（`src/app/index.ts`，移植自旧版定制） |
| 端口               | 8000（HTTP + WebSocket 同端口）              |
| 进程管理             | systemd：`ws-scrcpy.service`             |



---

## 二、目录结构

```
/data/ws-scrcpy-new/
├── src/                      # TypeScript 源码
│   ├── server/
│   │   ├── Auth.ts           # 【本地定制】密钥认证模块
│   │   ├── services/HttpServer.ts      # 【已改】加了认证中间件
│   │   └── services/WebSocketServer.ts # 【已改】WS 连接校验
│   └── app/
│       └── index.ts          # 【本地定制】iframe 比例上报(iframe_message_resize_)
├── dist/                     # 构建产物（线上实际运行的）
│   ├── index.js              # 服务端入口
│   └── public/bundle.js      # 前端（含比例上报）
├── config.yaml               # 运行配置（端口等）
├── node_modules/
└── package.json
```

`/etc/systemd/system/ws-scrcpy.service`：

```ini
[Unit]
Description=ws-scrcpy web client (new build, port 8000)
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/ws-scrcpy-new/dist
Environment=WS_SCRCPY_CONFIG=/data/ws-scrcpy-new/config.yaml
Environment=WS_SCRCPY_API_KEY=<访问密钥>
ExecStart=/usr/bin/node /data/ws-scrcpy-new/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/data/ws-scrcpy-new/config.yaml`：

```yaml
runGoogTracker: true
runApplTracker: false

server:
  - secure: false
    port: 8000
```

---

## 三、密钥认证机制

密钥通过环境变量 `WS_SCRCPY_API_KEY` 配置（写在 systemd unit 里）。  
**环境变量不设置时认证关闭（不推荐）。**

一个请求被放行，满足以下任意一条即可：

| 方式     | 示例                                     |
| ------ | -------------------------------------- |
| URL 参数 | `http://192.168.1.210:8000/?key=<KEY>` |
| 请求头    | `X-API-Key: <KEY>`                     |
| Cookie | `wskey=<KEY>`（首次带 key 访问自动种上）          |

- HTTP 层：校验失败返回 **401**（`src/server/services/HttpServer.ts` 中间件）
- WebSocket 层：校验失败直接断开，close code **4003**（`WebSocketServer.ts`）
- Cookie 机制：iframe 场景下浏览器只需在首次加载时带一次 key，  
  之后页面内的触控/指令连接自动携带 cookie

**修改密钥**（两处必须同步改）：

```bash
# 1. 改 systemd unit 里的 WS_SCRCPY_API_KEY
vim /etc/systemd/system/ws-scrcpy.service
# 2. 改 Flask 的 auth.json（8100 生成的链接会用它拼 key）
vim /root/ws-scrcpy-flask-web/auth.json
# 3. 重启两个服务
systemctl daemon-reload && systemctl restart ws-scrcpy
kill $(ss -tlnpH 'sport = :8100' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
bash /root/ws-scrcpy-flask-web/start.sh
```

---

## 四、日常运维命令

```bash
systemctl status ws-scrcpy          # 查看状态
systemctl restart ws-scrcpy         # 重启
journalctl -u ws-scrcpy -f          # 实时日志
journalctl -u ws-scrcpy -n 200      # 最近 200 行
```

健康检查：

```bash
# 无 key 应返回 401，带 key 应返回 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8000/?key=<KEY>"
# 设备追踪 WebSocket（有 key 应收到 JSON 设备清单）
```

---

## 五、重新部署 / 升级流程

```bash
cd /data/ws-scrcpy-new
npm ci --no-audit --no-fund     # 安装依赖（lock 文件锁定版本）
npm run dist                    # 构建，约 20 秒，产物写入 dist/
systemctl restart ws-scrcpy     # 重启生效
```

**修改源码后必须重新构建**，只改 src 不构建不会生效。

拉取上游更新（当前领先/落后情况先 `git fetch` 看）：

```bash
cd /data/ws-scrcpy-new
git stash                        # 暂存本地定制
git pull --rebase
git stash pop                    # 若冲突，重点看 HttpServer.ts / WebSocketServer.ts / app/index.ts
npm run dist && systemctl restart ws-scrcpy
```

⚠️ 本地定制共 4 类（6 个位置），rebase 时务必确认它们还在：

| # | 文件 | 内容 |
|---|---|---|
| 1 | `src/server/Auth.ts` | 整个文件（密钥校验模块，新增文件不会被 pull 掉，但别漏拷） |
| 2 | `src/server/services/HttpServer.ts` | express 认证中间件段 |
| 3 | `src/server/services/WebSocketServer.ts` | `Auth.checkRequest` 连接校验 |
| 4 | `src/app/index.ts` | `iframe_message_resize_` 上报段（横竖屏自适应） |
| 5 | `src/app/index.ts` | `hideToolbar` 工具栏开关段 |
| 6 | `src/app/index.ts` | 开头的 `location.search` 合并进 `parsedQuery`（让 `?query` 参数生效） |
| 7 | `src/app/index.ts` | 「多设备同步操控」段：`touch_report_` 上报 + `touch_inject_` 注入 |
| 8 | `src/app/index.ts` | 「右键 = 返回键」段：contextmenu 拦截 + `KEYCODE_BACK` 下发 |
| 9 | `src/app/index.ts` | 顶部 `KeyEvent` / `KeyCodeControlMessage` 静态 import（右键返回用） |

第 6 条最容易漏——它只有 5 行、藏在文件开头，漏了不会报错，只会让
`?hideToolbar=1` 之类的参数**静默失效**。升级后可用下面命令自检：

```bash
node /data/ws-scrcpy-new/tests/test_param_parse.js      # 应输出「全部 PASS」
node /data/ws-scrcpy-new/tests/test_sync_touch.js       # 同步注入目标必须是 .touch-layer
node /data/ws-scrcpy-new/tests/test_rightclick_back.js  # 右键返回键
```

### 完全重建（换机/重装）

```bash
git clone https://github.com/NetrisTV/ws-scrcpy.git /data/ws-scrcpy-new
cd /data/ws-scrcpy-new
# 应用上述 3 处本地定制（可从本文档第二节所述文件位置对照恢复）
npm ci --no-audit --no-fund
npm run dist
# 写 /etc/systemd/system/ws-scrcpy.service（见第二节）后：
systemctl daemon-reload && systemctl enable --now ws-scrcpy
```

---

## 六、与其他服务的关系

| 端口        | 服务                                  | 关系                              |
| --------- | ----------------------------------- | ------------------------------- |
| 8100      | Flask（`/root/ws-scrcpy-flask-web/`） | 设备选择页，iframe 嵌本服务，生成的链接自动带 key  |
| 1236      | Python（`/root/smartHome4.0/`）       | 旧设备列表 API；本服务自带等价接口             |
| 8001-8048 | adb forward                         | **每台设备占一个端口（→设备8886）**，选新端口务必避开 |
| 5037      | adb server                          | 宿主机全局 adb，设备发现依赖它               |

本服务自带的设备列表接口（可替代 1236）：

```
ws://192.168.1.210:8000/?action=goog-device-list&key=<KEY>
→ {"id":-1,"type":"devicelist","data":{"list":[{udid, state, pid, ...}]}}
```

### 嵌入其他平台的 URL 格式

```
http://192.168.1.210:8000/?key=<KEY>#!action=stream&udid=<UDID>&player=mse&ws=<URL编码的ws地址>
ws地址 = ws://192.168.1.210:8000/?action=proxy-adb&remote=tcp:8886&udid=<UDID>&key=<KEY>
```

- `?key=` 必须在 `#!` 之前
- 父页面需监听 `iframe_message_resize_<宽高比>` 消息来跟随手机横竖屏调整容器
- 可选参数：`fitToScreen=1`（铺满容器）、`captureKeyboard=1`（键盘捕获）、
  **`hideToolbar=1`（隐藏右侧工具栏）**

**参数写在哪**（2026-10-27 起两种都支持）：上游原始实现只解析 `#!` 之后的
参数，写在 `?query` 里会被忽略。本地已打补丁，把 `location.search` 合并进
`parsedQuery`（同名参数以 `#!` 中的为准），因此下面两种写法等价：

```
# A. 写在 #! 之后（原生方式，推荐）
http://host:8000/?key=<KEY>#!action=stream&udid=<UDID>&player=mse&ws=<WS编码>&hideToolbar=1

# B. 写在 ?query 里（外部拼接更方便）
http://host:8000/?key=<KEY>&hideToolbar=1#!action=stream&udid=<UDID>&player=mse&ws=<WS编码>
```

⚠️ 升级上游代码时注意：这个「合并 search 参数」的补丁在
`src/app/index.ts` 的开头（`const hash = ...` 之后），**升级后要重新应用**，
否则 `?query` 写法又会静默失效（页面不报错，只是参数被忽略）。

- 右侧工具栏还支持父页面动态控制：`iframe.contentWindow.postMessage('hide','*')`
  隐藏、`'show'` 显示（8100 顶栏的「隐藏工具栏」按钮即用此机制）

### 多设备同步操控协议（2026-11-20 新增）

投屏页与父页面之间通过 postMessage 传递触摸事件，用于「主控 → 从机」同步：

| 方向 | 消息格式 | 说明 |
|---|---|---|
| iframe → 父页面 | `touch_report_<type>_<x>_<y>` | `<type>` 为 `mousedown`/`mousemove`/`mouseup`，x/y 为 **0-1 比例坐标**（相对 `.video` 元素）。仅在鼠标按住拖动时才上报 mousemove |
| 父页面 → iframe | `touch_inject_<type>_<x>_<y>` | 注入端：在 **`.video .touch-layer`**（播放器的 `touchableCanvas`，z-index 1 盖在画面上）上模拟派发对应 MouseEvent，由 `document.body` 上已有的触控监听接管 |

用比例坐标而不是像素，是因为各台手机的分辨率和容器大小都不同，从机按自己的
容器尺寸还原即可。

⚠️ **注入目标必须是 `.touch-layer`，不能是 `.video` 容器**：`FeaturedInteractionHandler`
会校验 `event.target === player.getTouchableElement()`（即 `.touch-layer`），target 不匹配
直接 return，事件被静默丢弃——表现为「从机完全没有反应」。事件需 `bubbles: true`
（触控监听绑在 `document.body` 上），`mouseup` 时 `buttons` 置 0。

⚠️ **防传染**：父页面必须只把「主控」的上报转发给其他 iframe，不要把从机的
上报再转发出去，否则会形成回环。（从机收到注入事件后其页内的上报监听也会触发，
靠「只认主控 iframe」这条规则阻断。）8100 的实现见 `tests/test_sync_8100.js`。

示例（把一台设备的点击同步到另外三台）：

```js
// 父页面
window.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.indexOf('touch_report_') !== 0) { return; }
    if (e.source !== masterFrame.contentWindow) { return; }   // 只认主控
    const payload = e.data.replace('touch_report_', 'touch_inject_');
    slaveFrames.forEach((f) => f.contentWindow.postMessage(payload, '*'));
});
```

### 右键 = 返回键（2026-11-20 新增）

投屏页内置（无需父页面参与，非 iframe 直接访问也生效）：

- 在 `.video` 画面区域内**右键**：屏蔽浏览器右键菜单，改为向设备下发
  `KEYCODE_BACK`（DOWN + UP，与 PC 版 scrcpy 行为一致）
- 画面外的右键（工具栏等）保持浏览器默认行为
- 右键的 mousedown/mouseup/mousemove 会被阻止进入触控链路，避免在设备上
  形成带 secondary 按钮的误触
- 多设备同步扩展：iframe 内右键会上报 `touch_report_back`（无坐标），
  父页面广播 `touch_inject_back` 让从机一起返回；该消息不做横竖屏方向过滤

相关回归测试：`tests/test_rightclick_back.js`（18 项断言）。

### 群控台画质策略（2026-11-25 新增）

**背景**：8100 群控页的投屏 iframe 面板很窄（约 168 CSS px），旧逻辑
`getMaxSize()` 按「浏览器容器宽 × devicePixelRatio」算编码尺寸 → 面板宽
×2 ≈ 336 → 手机就按 336 宽编码，播放器再用 `object-fit: contain` 把
336×176 放大铺满面板 → 糊。更糟的是这段逻辑跑在 `setScreenInfo()` 之前，
拿不到手机真实分辨率，所以**永远走这条窄路**，加码率没用（尺寸是瓶颈）。

**改动**（`src/app/googDevice/client/StreamClientScrcpy.ts` + 四个播放器的
`preferredVideoSettings`）：

| 项 | 旧行为 | 新行为 |
|---|---|---|
| `getMaxSize()` | 容器宽 × DPR（约 336） | 手机原生分辨率的「长边正方形」盒子（16 对齐、1920 封顶） |
| onDisplayInfo「同设备多客户端取最小 bounds」 | 启用（小窗客户端会把所有人拉到 336） | 禁用（`/*take-small-disabled*/`），各客户端独立推送 |
| 码率上限 | 8 Mbps | 12582912（12 Mbps） |
| 帧率上限 | 60 | 30 |
| 播放器 preferred（Mse/WebCodecs/TinyH264/Broadway） | Mse 7 Mbps/60fps/720×720，其余 480×480 | 统一 12 Mbps/30fps/1920×1920 大盒子 |

「长边正方形」盒子的取值顺序：`displayInfo.size`（服务端初始上报的显示
尺寸，不受当前编码尺寸污染、旋转安全）→ 回落 `screenInfo.videoSize` →
再回落固定 1920×1920。bounds 对服务端**只缩不放**，所以给大盒子等于
「不限制」，服务端按原生尺寸编码；取正方形是为了横竖屏旋转都放得下。

**端到端验证**（2026-11-25，测试设备物理 1080×1920）：

```
推送:      bounds=1920x1920  bitrate=12582912  maxFps=30
服务器回显: {"bitrate":12582912,"maxFps":30,"bounds":[1920,1920]}
           screenInfo.videoSize=1072,1920
SPS 实测:  编码分辨率 1072x1920  ← 长边吃满原生（1080 按 8 对齐取 1072）
结果:      PASS
```

复现脚本（自包含，会自动杀残留/补 jar/起 server）：

```bash
cd /data/ws-scrcpy-new
node verify_encode_direct.js <udid>
```

⚠️ **设备端 scrcpy server 一个进程一生只服务一个 ws 客户端**：连过一次之后
进程还活着、端口还监听，但不再对新连接吐数据——表现为 ws 握手成功却 60 秒
无任何数据（曾长期被误认为「幽灵监听」）。测试前必须先杀干净残留再起新的，
脚本已内置该逻辑（`dev_clean.sh`）。

⚠️ 设备会清空 `/data/local/tmp`，jar 会丢，server 启动报
`ClassNotFoundException: com.genymobile.scrcpy.Server` 并 `Aborted`
（exit 134）。脚本会自动检测并重推 jar。

回归测试：`tests/test_quality_policy.js`（源码断言 + 盒子数学 + 播放器
设置 + 推送模拟，全 PASS）。

---

## 七、常见问题排查

**1. 设备起不来，日志刷 `BindException: Address already in use`**  
设备端 8886 端口被残留进程占用（常见于并行跑两个实例或异常退出后）。  
清理所有设备上的残留 scrcpy 服务：

```bash
for d in $(adb devices | grep 'device$' | awk '{print $1}'); do
  adb -s $d shell 'ps -A -o PID,ARGS | grep "[g]enymobile" | awk "{print \$1}" | xargs -r kill -9'
done
systemctl restart ws-scrcpy
```

⚠️ **严禁在宿主机同时跑两个 ws-scrcpy 实例**——会互相抢占设备端 8886  
（2026-10-22 升级时踩过坑，旧实例直接崩）。

**2. 端口 8000 起不来**  
`ss -tlnp | grep 8000` 查占用。注意 8001-8048 被 adb forward 占满，测试端口选 9000+。

**3. 手机画面比例不对 / 横屏显示成竖框**  
前端 bundle 必须包含 `iframe_message_resize_`（`grep -c iframe_message_resize_ dist/public/bundle.js`  
应为 1）。父页面必须有对应监听。浏览器 Ctrl+F5 清缓存。

**4. 升级后手机端报错**  
ws 版本变化（如 ws5→ws8）会自动重推 scrcpy-server.jar 到每台手机，旧版本残留的  
`app_process` 进程按上面第 1 条清理。设备端 jar 推送是自动的，无需手动。

**5. 服务挂了不自动拉**  
`systemctl is-enabled ws-scrcpy` 应为 enabled；`Restart=on-failure` 只在异常退出时拉起，  
正常 kill 不会自动重启（这是预期的）。

---

## 八、回滚到旧版

旧版完整保留在 `/data/ws-scrcpy/`（含 dist 与定制，内置 ws5 jar）：

```bash
systemctl disable --now ws-scrcpy                 # 停新版
# 清设备残留（上面第七节第 1 条脚本，必须做，否则旧版起不来）
cd /data/ws-scrcpy/dist && nohup node index.js &  # 旧版方式启动
```

注意旧版无认证、jar 为 ws5、启动后手机端会自动换回 ws5 jar。  
旧版回滚仅作应急，长期建议仍用新版。

---

## 九、安全提醒（遗留事项）

- 本服务 8000 对**全网段**监听，仅靠 key 保护；如需进一步收紧，  
  可在防火墙限制来源 IP，或加 nginx 反代 + HTTPS
- 宿主机 SSH 仍为 root 密码登录，建议改密钥登录
- 1236 设备 API 仍无认证（如不再使用可停掉，用本服务的 goog-device-list 替代）
