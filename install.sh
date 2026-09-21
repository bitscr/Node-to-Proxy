#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/bitscr/Node-to-Proxy.git"
INSTALL_DIR="/opt/node-to-proxy"
SERVICE_USER="node2proxy"
SERVICE_NAME="node-to-proxy"
NODE_MIN_MAJOR=18

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 用户运行安装脚本。" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl sudo nftables ca-certificates openssl

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
fi

if [ "$node_major" -lt "$NODE_MIN_MAJOR" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch origin main
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch main "$REPO_URL" "$INSTALL_DIR"
fi

mkdir -p "$INSTALL_DIR/data"

if [ ! -f "$INSTALL_DIR/.env" ]; then
  token="$(openssl rand -hex 24)"
  cat > "$INSTALL_DIR/.env" <<EOF
NODE_ENV=production
BIND_HOST=::
WEB_PORT=28080
HTTP_PROXY_PORT=38080
SOCKS5_PROXY_PORT=38081
DATA_DIR=$INSTALL_DIR/data
API_TOKEN=$token
EOF
else
  token="$(sed -n 's/^API_TOKEN=//p' "$INSTALL_DIR/.env" | head -n 1)"
fi

chown root:"$SERVICE_USER" "$INSTALL_DIR"
find "$INSTALL_DIR/src" "$INSTALL_DIR/public" -type d -exec chmod 750 {} \;
find "$INSTALL_DIR/src" "$INSTALL_DIR/public" -type f -exec chmod 640 {} \;
chown -R root:"$SERVICE_USER" "$INSTALL_DIR/src" "$INSTALL_DIR/public"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR/data"
chown root:"$SERVICE_USER" "$INSTALL_DIR/server.js" "$INSTALL_DIR/package.json" "$INSTALL_DIR/.env"
chmod 640 "$INSTALL_DIR/server.js" "$INSTALL_DIR/package.json" "$INSTALL_DIR/.env"
chmod 750 "$INSTALL_DIR/scripts/firewall.sh"

cat > /etc/sudoers.d/node-to-proxy <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: $INSTALL_DIR/scripts/firewall.sh *
EOF
chmod 440 /etc/sudoers.d/node-to-proxy
visudo -cf /etc/sudoers.d/node-to-proxy >/dev/null

node_path="$(command -v node)"
cat > "/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Node-to-Proxy 多节点代理管理器
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
ExecStart=$node_path server.js
Restart=always
RestartSec=3
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/data
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 2
systemctl is-active --quiet "$SERVICE_NAME"

printf '\n安装完成。\n'
printf '控制台地址：http://服务器地址:28080/\n'
printf '控制台密码：%s\n' "$token"
printf '查看状态：systemctl status %s\n' "$SERVICE_NAME"
printf '查看日志：journalctl -u %s -f\n' "$SERVICE_NAME"
