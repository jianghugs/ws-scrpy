# ws-scrcpy 生产镜像
# 多阶段构建：先编译 node-pty 原生模块 + webpack 构建，再产出精简运行镜像
#
# 构建：
#   docker build -t ws-scrcpy:0.9.0 .
#
# 运行（Android 设备需 USB 或远程 adb）：
#   docker run -d --name ws-scrcpy \
#     -p 8000:8000 \
#     -e WS_SCRCPY_API_KEY=<你的密钥> \
#     --privileged -v /dev/bus/usb:/dev/bus/usb \
#     ws-scrcpy:0.9.0

# ---------- 阶段 1：构建（含 node-pty 原生编译） ----------
FROM node:20-bookworm-slim AS build

# node-pty 编译所需工具链（make + g++ + python3）
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 复制源码与静态资源
COPY . .

# 生产构建（webpack → dist/）
RUN npm run dist

# ---------- 阶段 2：运行 ----------
FROM node:20-bookworm-slim AS runtime

# 运行期需要：adb（连接 Android 设备）与 glibc 等基础库
RUN apt-get update && apt-get install -y --no-install-recommends \
        adb \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

# 只复制构建产物与运行期依赖（node-pty 原生二进制已随 node_modules 一起拷入）
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/config.example.yaml ./config.example.yaml

# 无需配置文件即可运行：内置默认端口 8000、Android 追踪默认开启。
# 如需自定义端口/HTTPS/iOS，可挂载自己的配置：
#   -v $(pwd)/config.yaml:/app/config.yaml -e WS_SCRCPY_CONFIG=/app/config.yaml

# 暴露 HTTP + WebSocket 同端口（默认 8000）
EXPOSE 8000

# 密钥通过环境变量注入；不设置则认证关闭（不推荐）
CMD ["node", "dist/index.js"]
