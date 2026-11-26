#!/bin/bash
# =============================================================
# ws-scrcpy(8000) 一键部署脚本
# 用法: bash deploy.sh          (交互输入密钥)
#       WS_SCRCPY_API_KEY=xxx bash deploy.sh   (脚本化传密钥)
# =============================================================
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${WS_SCRCPY_PORT:-8000}"

# ---- 密钥 ----
KEY="${WS_SCRCPY_API_KEY:-}"
if [ -z "$KEY" ]; then
    read -r -p "请输入访问密钥(直接回车自动生成随机密钥): " KEY
    [ -z "$KEY" ] && KEY="$(openssl rand -hex 16)"
fi

# ---- node 检查 ----
if ! command -v node >/dev/null 2>&1; then
    echo "[错误] 未找到 node，请先安装 Node.js >= 18"; exit 1
fi
NODE_BIN="$(command -v node)"
echo "[信息] node: $NODE_BIN ($($NODE_BIN -v))"

# ---- 依赖 ----
if [ ! -d "$DIR/node_modules" ]; then
    echo "[信息] node_modules 缺失，执行 npm ci ..."
    (cd "$DIR" && npm ci --no-audit --no-fund)
else
    echo "[信息] node_modules 已存在，跳过安装"
fi

# ---- 端口检查 ----
if ss -tln | grep -q ":$PORT "; then
    echo "[警告] 端口 $PORT 已被占用："
    ss -tlnpH "sport = :$PORT" || true
    read -r -p "仍继续? (y/N): " GO
    [ "$GO" = "y" ] || exit 1
fi

# ---- 写 config.yaml ----
cat > "$DIR/config.yaml" <<EOF
# ws-scrcpy 运行配置 (由 deploy.sh 生成)
runGoogTracker: true
runApplTracker: false

server:
  - secure: false
    port: $PORT
EOF

# ---- 写 systemd unit ----
cat > /etc/systemd/system/ws-scrcpy.service <<EOF
[Unit]
Description=ws-scrcpy web client (port $PORT)
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR/dist
Environment=WS_SCRCPY_CONFIG=$DIR/config.yaml
Environment=WS_SCRCPY_API_KEY=$KEY
ExecStart=$NODE_BIN $DIR/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now ws-scrcpy
sleep 5

# ---- 验证 ----
echo
echo "================ 部署完成 ================"
echo "状态:   $(systemctl is-active ws-scrcpy)"
echo "密钥:   $KEY"
echo "地址:   http://<本机IP>:$PORT/?key=$KEY"
echo "验证:   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/          # 期望 401"
echo "        curl -s -o /dev/null -w '%{http_code}\n' \"http://127.0.0.1:$PORT/?key=$KEY\"  # 期望 200"
echo "日志:   journalctl -u ws-scrcpy -f"
echo "=========================================="
echo "提醒: 请把密钥同步到 8100 的 auth.json (ws_key 字段) 和所有嵌入方。"
