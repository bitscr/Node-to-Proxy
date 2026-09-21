# Node-to-Proxy

基于 Node.js 的多节点代理管理器，支持 HTTP、HTTPS、SOCKS5 和 VLESS 节点导入，并提供手动、自动和轮询选路模式。

## 功能

- Web 管理控制台
- HTTP 与 SOCKS5 代理出口
- IPv4、IPv6 双栈支持
- IP/CIDR 白名单
- 手动、自动、轮询选路
- 轮询切换时间可按秒设置
- 节点健康检查
- systemd 后台运行和开机启动
- 仅使用 Node.js 部署，不使用 Docker

## 系统要求

- Debian 12/13、Ubuntu 22.04/24.04 或其他支持 systemd 的 Linux
- root 权限
- Node.js 18 或更高版本
- Git、curl、nftables、sudo

## 一键安装

使用 root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/bitscr/Node-to-Proxy/main/install.sh | bash
```

安装脚本会自动完成：

1. 检查�并安装系统依赖。
2. 检查 Node.js 版本，缺失时安装 Node.js。
3. 下载项目到 `/opt/node-to-proxy`。
4. 创建独立系统用户 `node2proxy`。
5. 生成控制台登录密码。
6. 配置 nftables 白名单管理权限。
7. 创建并启动 systemd 服务。
8. 设置服务开机自动启动。

安装完成后访问：

```text
http://服务器地址:28080/
```

安装脚本结束时会显示控制台密码和服务地址。

## 手动安装

### 1. 安装依赖

```bash
apt-get update
apt-get install -y git curl sudo nftables ca-certificates
```

确保 Node.js 版本不低于 18：

```bash
node --version
```

### 2. 获取源码

```bash
git clone https://github.com/bitscr/Node-to-Proxy.git /opt/node-to-proxy
cd /opt/node-to-proxy
```

项目没有第三方 npm 运行时依赖，不需要执行 `npm install`。

### 3. 创建配置

```bash
cp .env.example .env
nano .env
```

主要配置：

```dotenv
BIND_HOST=::
WEB_PORT=28080
HTTP_PROXY_PORT=38080
SOCKS5_PROXY_PORT=38081
DATA_DIR=/opt/node-to-proxy/data
API_TOKEN=请替换为高强度密码
```

### 4. 前台运行

```bash
node server.js
```

### 5. 运行测试

```bash
npm test
```

测试命令使用 Node.js 内置测试运行器，不需要安装第三方测试框架。

## 默认端口

- Web 控制台：`28080`
- HTTP 代理：`38080`
- SOCKS5 代理：`38081`

端口可以在控制台设置页修改。

## IP 白名单

代理出口端口由 IP 白名单保护。

示例：

```text
单个 IPv4：1.2.3.4
IPv4 网段：192.0.2.0/24
单个 IPv6：2001:db8::1
IPv6 网段：2001:db8::/64
全部 IPv4：0.0.0.0/0
全部 IPv6：::/0
```

同时添加 `0.0.0.0/0` 和 `::/0` 会允许任何 IPv4、IPv6 来源连接代理端口。

## 服务管理

```bash
systemctl status node-to-proxy
systemctl restart node-to-proxy
systemctl stop node-to-proxy
journalctl -u node-to-proxy -f
```

## 更新

再次执行一键安装命令即可�拉取最新代码、修复权限并重启服务：

```bash
curl -fsSL https://raw.githubusercontent.com/bitscr/Node-to-Proxy/main/install.sh | bash
```

## 卸载

```bash
systemctl disable --now node-to-proxy
rm -f /etc/systemd/system/node-to-proxy.service
rm -f /etc/sudoers.d/node-to-proxy
systemctl daemon-reload
rm -rf /opt/node-to-proxy
userdel node2proxy 2>/dev/null || true
```

## 许可证

MIT
