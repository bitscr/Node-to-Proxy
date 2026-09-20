'use strict';

const path = require('node:path');
const os = require('node:os');
const { ConfigStore } = require('./src/config-store');
const { NodeManager } = require('./src/node-manager');
const { createApplication } = require('./src/app');

// 探测本机可入站的公网地址（区分真实入口 vs 仅 WARP 出站）
// WARP 隧道的 IPv4 只是出站出口，外部无法反向进入，故不算入口。
function detectPublicAddresses() {
  const ifaces = os.networkInterfaces();
  let ipv4 = null;
  let ipv6 = null;
  let warp = false;
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (name === 'warp') warp = true;
    if (name === 'lo' || name === 'docker0' || name.startsWith('veth') || name.startsWith('docker')) continue;
    for (const a of addrs || []) {
      if (!a || a.internal) continue;
      if (a.family === 'IPv4') {
        const ip = a.address;
        const isPrivate = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
        if (!isPrivate) ipv4 = ip; // 非隧道的真实入口
      } else if (a.family === 'IPv6') {
        const ip = a.address.split('%')[0];
        if (ip !== '::1' && !ip.startsWith('fe80') && !ip.startsWith('fc') && !ip.startsWith('fd')) {
          ipv6 = ip;
        }
      }
    }
  }
  return { ipv4, ipv6, warp };
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const API_TOKEN = process.env.API_TOKEN || '';
// 三个独立端口：Web 控制台/API、HTTP 代理出口、SOCKS5 代理出口
const WEB_PORT = Number(process.env.WEB_PORT || process.env.PORT || 8080);
const HTTP_PROXY_PORT = Number(process.env.HTTP_PROXY_PORT || 18999);
const SOCKS_PORT = Number(process.env.SOCKS5_PROXY_PORT || 18998);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 30000);
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 3000);

async function main() {
  const store = new ConfigStore(path.join(DATA_DIR, 'config.json'));
  const manager = new NodeManager({ store, localPorts: [HTTP_PROXY_PORT, SOCKS_PORT] });
  await manager.load();

  // 运行时端口设置（网页端可改）优先于环境变量
  let runtimePorts = {};
  try {
    const settingsText = await require('node:fs').promises.readFile(path.join(DATA_DIR, 'settings.json'), 'utf8');
    runtimePorts = JSON.parse(settingsText);
  } catch { /* 无设置文件则全部用环境变量 */ }
  const effectivePorts = {
    webPort: Number(runtimePorts.webPort) || WEB_PORT,
    httpProxyPort: Number(runtimePorts.httpProxyPort) || HTTP_PROXY_PORT,
    socksPort: Number(runtimePorts.socksPort) || SOCKS_PORT
  };

  const application = await createApplication({
    manager,
    apiToken: API_TOKEN,
    healthIntervalMs: HEALTH_INTERVAL_MS,
    healthTimeoutMs: HEALTH_TIMEOUT_MS,
    bindHost: BIND_HOST,
    dataDir: DATA_DIR,
    ports: { ...effectivePorts, network: detectPublicAddresses() },
    // 代理出口鉴权由防火墙白名单负责，这里显式关闭 Bearer 要求
    proxyAuthRequired: false
  });

  // 启动时尝试下发 IP 白名单防火墙（失败不阻断启动，稍后可手动触发）
  application.allowlist.apply().catch(error => {
    console.error('[node-to-proxy] 防火墙下发失败（稍后可通过设置页重试）:', error.message);
  });

  await new Promise((resolve, reject) => {
    application.apiServer.once('error', reject);
    application.apiServer.listen(effectivePorts.webPort, BIND_HOST, resolve);
  });
  await new Promise((resolve, reject) => {
    application.httpProxyServer.once('error', reject);
    application.httpProxyServer.listen(effectivePorts.httpProxyPort, BIND_HOST, resolve);
  });
  await new Promise((resolve, reject) => {
    application.socksProxyServer.once('error', reject);
    application.socksProxyServer.listen(effectivePorts.socksPort, BIND_HOST, resolve);
  });

  console.log(`[node-to-proxy] 已启动`);
  console.log(`[node-to-proxy] Web 控制台/API: http://${BIND_HOST}:${effectivePorts.webPort}`);
  console.log(`[node-to-proxy] HTTP 代理出口:  http://${BIND_HOST}:${effectivePorts.httpProxyPort}`);
  console.log(`[node-to-proxy] SOCKS5 代理出口: socks5://${BIND_HOST}:${effectivePorts.socksPort}`);
  console.log(`[node-to-proxy] 鉴权令牌:        ${API_TOKEN ? '已启用' : '未启用（仅限本机使用）'}`);
  console.log(`[node-to-proxy] 配置数据目录:    ${DATA_DIR}`);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[node-to-proxy] 收到 ${signal}，正在优雅关闭…`);
    const timer = setTimeout(() => {
      console.error('[node-to-proxy] 关闭超时，强制退出');
      process.exit(1);
    }, 10000);
    timer.unref();
    try {
      await application.close();
      console.log('[node-to-proxy] 已安全关闭');
      process.exit(0);
    } catch (error) {
      console.error('[node-to-proxy] 关闭出错：', error);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
  console.error('[node-to-proxy] 启动失败：', error);
  process.exit(1);
});