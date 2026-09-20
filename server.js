'use strict';

const path = require('node:path');
const { ConfigStore } = require('./src/config-store');
const { NodeManager } = require('./src/node-manager');
const { createApplication } = require('./src/app');

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

  const application = await createApplication({
    manager,
    apiToken: API_TOKEN,
    healthIntervalMs: HEALTH_INTERVAL_MS,
    healthTimeoutMs: HEALTH_TIMEOUT_MS,
    bindHost: BIND_HOST
  });

  await new Promise((resolve, reject) => {
    application.apiServer.once('error', reject);
    application.apiServer.listen(WEB_PORT, BIND_HOST, resolve);
  });
  await new Promise((resolve, reject) => {
    application.httpProxyServer.once('error', reject);
    application.httpProxyServer.listen(HTTP_PROXY_PORT, BIND_HOST, resolve);
  });
  await new Promise((resolve, reject) => {
    application.socksProxyServer.once('error', reject);
    application.socksProxyServer.listen(SOCKS_PORT, BIND_HOST, resolve);
  });

  console.log(`[node-to-proxy] 已启动`);
  console.log(`[node-to-proxy] Web 控制台/API: http://${BIND_HOST}:${WEB_PORT}`);
  console.log(`[node-to-proxy] HTTP 代理出口:  http://${BIND_HOST}:${HTTP_PROXY_PORT}`);
  console.log(`[node-to-proxy] SOCKS5 代理出口: socks5://${BIND_HOST}:${SOCKS_PORT}`);
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