# 部署指南（Linux / macOS / Windows / Docker）

> 本文档面向任意部署者，覆盖 ws-scrcpy 服务端在三大桌面平台与 Docker 的安装步骤。
> 项目简介与功能说明见 [README.md](./README.md)（英文）/ [README.zh-CN.md](./README.zh-CN.md)（中文）。

---

## 一、部署方式总览

| 方式 | 适用场景 | 难度 | 前置要求 |
| --- | --- | --- | --- |
| **Docker** | 追求环境一致、快速起服务 | ★☆☆ | Docker 已装 |
| **源码部署** | 需要定制源码、长期维护 | ★★☆ | Node.js + 平台编译工具链 |
| **部署包（离线）** | 目标机无外网 | ★☆☆ | Node.js ≥ 18 + systemd（Linux） |

三种方式产出的服务完全等价：一个 HTTP + WebSocket 同端口的网页投屏服务，默认端口 **8000**。

---

## 二、通用前置条件

无论哪种部署方式，被控制的设备端要求一致：

- **Android 5.0+（API 21+）**，开启「USB 调试」（部分机型需额外开启「允许模拟点击/按键」）
- 设备通过 USB 连接到服务器，或通过 `adb connect` 远程接入
- 设备端 `scrcpy-server.jar` 已内置，首次使用自动推送，无需手动安装

服务端运行期只需一个可执行文件 `adb` 在 `PATH` 中（Docker 镜像已内置）。

---

## 三、Docker 部署

### 3.1 构建镜像

```bash
git clone https://github.com/jianghugs/ws-scrpy.git
cd ws-scrpy
docker build -t ws-scrpy:0.9.0 .
```

多阶段构建会自动完成：安装 node-pty 编译工具链 → `npm ci` → `npm run dist` → 产出精简运行镜像（内置 adb）。

### 3.2 运行

**基本运行**（无配置文件，走内置默认：端口 8000、Android 追踪开启）：

```bash
docker run -d --name ws-scrcpy \
  -p 8000:8000 \
  -e WS_SCRCPY_API_KEY=<你的密钥> \
  ws-scrpy:0.9.0
```

**接入 USB 设备**（宿主机 USB 设备透传给容器）：

```bash
docker run -d --name ws-scrcpy \
  -p 8000:8000 \
  -e WS_SCRCPY_API_KEY=<你的密钥> \
  --privileged \
  -v /dev/bus/usb:/dev/bus/usb \
  ws-scrpy:0.9.0
```

**自定义配置**（端口 / HTTPS / iOS 追踪等，挂载 config.yaml）：

```bash
docker run -d --name ws-scrcpy \
  -p 8000:8000 \
  -e WS_SCRCPY_API_KEY=<你的密钥> \
  -e WS_SCRCPY_CONFIG=/app/config.yaml \
  -v $(pwd)/config.yaml:/app/config.yaml \
  ws-scrpy:0.9.0
```

### 3.3 验证

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/                 # 期望 401
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8000/?key=<你的密钥>" # 期望 200
```

> **说明**：`WS_SCRCPY_API_KEY` 环境变量未设置时认证关闭（不推荐，服务将无保护暴露）。

---

## 四、源码部署

### 4.0 克隆与依赖安装（三平台通用）

```bash
git clone https://github.com/jianghugs/ws-scrpy.git
cd ws-scrpy
npm ci --no-audit --no-fund
npm run dist        # 构建，产物写入 dist/
```

> 唯一需要本地编译的原生依赖是 `node-pty`（浏览器内 adb shell 终端功能），
> 它要求目标机具备 C/C++ 编译工具链。以下各平台章节给出具体安装方法。

### 4.1 Linux（Ubuntu / Debian）

**安装依赖：**

```bash
# 1. Node.js（建议 20.x，18+ 可）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. adb
sudo apt-get install -y adb

# 3. node-pty 编译工具链（make + g++ + python3）
sudo apt-get install -y build-essential python3
```

**构建与启动：**

```bash
cd ws-scrpy
npm ci --no-audit --no-fund
npm run dist
WS_SCRCPY_API_KEY=<你的密钥> node dist/index.js
```

**以 systemd 常驻（可选）：**

创建 `/etc/systemd/system/ws-scrcpy.service`：

```ini
[Unit]
Description=ws-scrcpy web client
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/ws-scrcpy/dist
Environment=WS_SCRCPY_CONFIG=/path/to/ws-scrcpy/config.yaml
Environment=WS_SCRCPY_API_KEY=<你的密钥>
ExecStart=/usr/bin/node /path/to/ws-scrcpy/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ws-scrcpy
```

### 4.2 macOS

**安装依赖：**

```bash
# 1. Node.js（Homebrew）
brew install node

# 2. adb（android-platform-tools）
brew install --cask android-platform-tools

# 3. node-pty 编译工具链（Xcode 命令行工具）
xcode-select --install
```

**构建与启动：**

```bash
cd ws-scrcpy
npm ci --no-audit --no-fund
npm run dist
WS_SCRCPY_API_KEY=<你的密钥> node dist/index.js
```

> macOS 上如需控制 **iOS** 设备（走 `appl-device` / WebDriverAgent），需额外安装
> 完整 Xcode，并在构建时通过 `build.config.override.json` 启用 `INCLUDE_APPL`。
> Android 设备控制无需 Xcode，命令行工具即可。

### 4.3 Windows

**安装依赖：**

1. **Node.js**：从 <https://nodejs.org> 下载安装 LTS（20.x）
2. **adb**：下载 [platform-tools](https://developer.android.com/tools/releases/platform-tools)，
   解压后把目录加入系统 `PATH`
3. **node-pty 编译工具链**：安装
   [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，
   勾选「使用 C++ 的桌面开发」工作负载（含 MSVC + Windows SDK）；
   Python 3.x 加入 `PATH`

**构建与启动（PowerShell）：**

```powershell
cd ws-scrcpy
npm ci --no-audit --no-fund
npm run dist
$env:WS_SCRCPY_API_KEY = "<你的密钥>"
node dist\index.js
```

> Windows 下 adb 需能从命令行直接调用（`adb --version` 有输出即正常）。

---

## 五、离线部署包

若目标机无外网，可从 GitHub Release 下载预打包的部署包
`ws-scrcpy-0.9.0-deploy.tar.gz`（含源码、构建产物、node_modules、一键脚本）：

```bash
# 1. 解压
mkdir -p /data && tar xzf ws-scrcpy-0.9.0-deploy.tar.gz -C /data
cd /data/ws-scrcpy-new

# 2. 一键部署（Linux + systemd；会提示设置访问密钥）
bash deploy.sh

# 3. 验证
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/
```

> 部署包自带全部依赖，目标机仅需 Node.js ≥ 18 与 systemd（Linux）。

---

## 六、部署后验证清单

```bash
# 1. 无 key 应返回 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/

# 2. 带 key 应返回 200
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8000/?key=<KEY>"

# 3. 设备已接入
adb devices          # 应列出 device 状态的设备

# 4. 浏览器打开控制台
#    http://127.0.0.1:8000/?key=<KEY>
#    能看到设备列表并能点开投屏即成功
```

---

## 七、配置说明

服务端配置通过 YAML 文件（`WS_SCRCPY_CONFIG` 环境变量指定路径）或内置默认值提供。
**不提供配置文件时**，使用内置默认：端口 `8000`、Android 追踪开启、iOS 关闭。

示例配置（`config.example.yaml`）：

```yaml
runGoogTracker: true    # Android 设备追踪
runApplTracker: false   # iOS 设备追踪（需 INCLUDE_APPL 构建 + macOS）

server:
  - secure: false
    port: 8000
```

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `WS_SCRCPY_API_KEY` | 访问密钥，所有 HTTP/WS 请求均需校验；未设置则认证关闭 |
| `WS_SCRCPY_CONFIG` | 配置文件路径（YAML） |
| `WS_SCRCPY_PATHNAME` | 服务挂载在非根路径时的 base pathname |

---

## 八、安全提醒

- 服务默认监听所有网段接口，仅靠 key 保护；公网暴露时务必设置 `WS_SCRCPY_API_KEY`，
  并建议前置 nginx 反代 + HTTPS
- `WS_SCRCPY_API_KEY` 不要提交进版本库，通过环境变量注入
