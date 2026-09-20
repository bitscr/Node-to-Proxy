'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseNodeBatch } = require('./node-parser');
const { connectThroughUpstream, connectTunnelThroughUpstream, pipeTunnel } = require('./upstream');
const { probeVlessNode } = require('./vless/lib');
const { Allowlist, isCidr, familyOf, normalizeCidr } = require('./firewall');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function bearerMatches(header, token) {
  if (!token) return true;
  return constantTimeEqual(header, `Bearer ${token}`);
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON 格式无效');
  }
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    if (server.activeSockets) {
      for (const socket of server.activeSockets) socket.destroy();
    }
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
  });
}

function trackSockets(server) {
  const sockets = new Set();
  server.activeSockets = sockets;
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return server;
}

function serveStatic(res, pathname, configJson) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    return json(res, 404, { ok: false, error: '界面文件不存在' });
  }
  fs.readFile(file, (error, content) => {
    if (error) return json(res, 404, { ok: false, error: '界面文件不存在' });
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    }[path.extname(file).toLowerCase()] || 'application/octet-stream';
    let body = content;
    // 注入运行配置（API 令牌、出口端口），前端 window.__CONFIG__ 消费
    if (type === 'text/html; charset=utf-8' && configJson) {
      const injected = Buffer.from(
        `<script>window.__CONFIG__ = ${JSON.stringify(configJson)};</script>`,
        'utf8'
      );
      body = Buffer.concat([injected, content]);
    }
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      'cache-control': 'no-cache'
    });
    res.end(body);
  });
}

async function createApplication({ manager, apiToken = '', healthIntervalMs = 30000, healthTimeoutMs = 3000, proxyAuthRequired, bindHost = '127.0.0.1', ports = {}, dataDir = path.join(__dirname, '..', 'data') }) {
  let closed = false;

  async function checkNode(id) {
    const node = manager.listNodes().find(item => item.id === id);
    if (!node) throw new Error('节点不存在');
    const started = Date.now();
    let ok = false;
    let error = null;
    try {
      if (node.type === 'vless') {
        // VLESS 节点无法用裸 TCP 探测：真实拨号一条隧道到探测目标，
        // 隧道建立成功即视为健康（覆盖 DNS→TLS→WS→VLESS 全链路）。
        const result = await probeVlessNode(node, 'api.ipify.org', 443);
        ok = true;
        return manager.applyHealthResult(id, { ok, latencyMs: result.latencyMs, error: null });
      }
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: node.host, port: node.port });
        const timer = setTimeout(() => socket.destroy(new Error('健康检查超时')), healthTimeoutMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.destroy();
          resolve();
        });
        socket.once('error', error => {
          clearTimeout(timer);
          reject(error);
        });
      });
      ok = true;
    } catch (err) {
      error = err.message || '健康检查失败';
    }
    return manager.applyHealthResult(id, {
      ok,
      latencyMs: ok ? Date.now() - started : null,
      error
    });
  }

  async function checkAll() {
    const enabled = manager.listNodes().filter(node => node.enabled);
    await Promise.allSettled(enabled.map(node => checkNode(node.id)));
    manager.refreshAutoSelection();
  }

  const healthTimer = setInterval(() => void checkAll(), healthIntervalMs);
  healthTimer.unref?.();

  const endpoints = {
    webPort: Number(ports.webPort) || 8080,
    httpProxyPort: Number(ports.httpProxyPort) || 18999,
    socksPort: Number(ports.socksPort) || 18998,
    // 可入站地址探测（warp 仅出站时 ipv4 为 null）
    network: ports.network || { ipv4: null, ipv6: null, warp: false }
  };

  const settingsFile = path.join(dataDir, 'settings.json');

  async function readSettings() {
    try {
      return JSON.parse(await fs.promises.readFile(settingsFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async function writeSettings(patch) {
    const current = await readSettings();
    const next = { ...current, ...patch };
    await fs.promises.writeFile(settingsFile, JSON.stringify(next, null, 2));
    return next;
  }

  const allowlist = new Allowlist(path.join(dataDir, 'allowlist.json'), {
    webPort: endpoints.webPort,
    proxyPorts: [endpoints.httpProxyPort, endpoints.socksPort]
  });

  const apiServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, status: manager.getStatus(), endpoints });
      }
      if (!url.pathname.startsWith('/api/')) {
        // 注意：绝不注入 apiToken（它是控制台登录密码）；页面只在登录框里输入
        return serveStatic(res, url.pathname, { endpoints });
      }
      if (!bearerMatches(req.headers.authorization, apiToken)) {
        res.setHeader('www-authenticate', 'Bearer');
        return json(res, 401, { ok: false, error: '未授权' });
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        return json(res, 200, { ok: true, data: { ...manager.getStatus(), endpoints } });
      }
      if (url.pathname === '/api/nodes' && req.method === 'GET') {
        return json(res, 200, { ok: true, data: manager.listNodes() });
      }
      if (url.pathname === '/api/nodes' && req.method === 'POST') {
        return json(res, 201, { ok: true, data: await manager.addNode(await readJson(req)) });
      }
      if (url.pathname === '/api/nodes/import' && req.method === 'POST') {
        const body = await readJson(req);
        const parsed = parseNodeBatch(body.links, { localPorts: manager.localPorts });
        const imported = [];
        for (const node of parsed) imported.push(await manager.addNode(node));
        return json(res, 201, { ok: true, data: imported });
      }
      if (url.pathname === '/api/mode' && req.method === 'PUT') {
        const body = await readJson(req);
        return json(res, 200, { ok: true, data: await manager.setMode(body.mode) });
      }
      if (url.pathname === '/api/nodes/check-all' && req.method === 'POST') {
        await checkAll();
        return json(res, 200, { ok: true, data: manager.listNodes() });
      }
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        const saved = await readSettings();
        return json(res, 200, { ok: true, data: { endpoints, settings: saved } });
      }
      if (url.pathname === '/api/settings' && req.method === 'PATCH') {
        const body = await readJson(req);
        const patch = {};
        for (const key of ['httpProxyPort', 'socksPort', 'webPort']) {
          if (body[key] !== undefined) {
            const port = Number(body[key]);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              throw new Error(`端口无效：${key}`);
            }
            patch[key] = port;
          }
        }
        if (Object.keys(patch).length === 0) throw new Error('没有可修改的设置');
        const saved = await writeSettings(patch);
        // 端口变更需要重启监听：先回响应，再让 systemd 拉起新进程
        setTimeout(() => process.exit(0), 250);
        return json(res, 200, { ok: true, data: { endpoints: { ...endpoints, ...patch }, settings: saved }, restarting: true });
      }
      if (url.pathname === '/api/allowlist' && req.method === 'GET') {
        return json(res, 200, { ok: true, data: allowlist.list() });
      }
      if (url.pathname === '/api/allowlist' && req.method === 'POST') {
        const body = await readJson(req);
        const values = (Array.isArray(body.cidrs) ? body.cidrs : [body.cidr || body.value]).filter(Boolean);
        if (values.length === 0) throw new Error('缺少要添加的 IP/CIDR');
        const added = [];
        for (const value of values) added.push(allowlist.add(value));
        const applied = await allowlist.apply();
        return json(res, 201, { ok: true, data: allowlist.list(), added, firewall: applied });
      }
      if (url.pathname === '/api/allowlist/apply' && req.method === 'POST') {
        const applied = await allowlist.apply();
        return json(res, 200, { ok: true, data: allowlist.list(), firewall: applied });
      }
      const allowMatch = url.pathname.match(/^\/api\/allowlist\/([^/]+)$/);
      if (allowMatch && req.method === 'DELETE') {
        const removed = allowlist.remove(decodeURIComponent(allowMatch[1]));
        const applied = await allowlist.apply();
        return json(res, 200, { ok: true, data: allowlist.list(), removed, firewall: applied });
      }

      const match = url.pathname.match(/^\/api\/nodes\/([^/]+)(?:\/(select|check))?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const action = match[2];
        if (!action && req.method === 'PATCH') {
          return json(res, 200, { ok: true, data: await manager.updateNode(id, await readJson(req)) });
        }
        if (!action && req.method === 'DELETE') {
          return json(res, 200, { ok: true, data: await manager.deleteNode(id) });
        }
        if (action === 'select' && req.method === 'POST') {
          return json(res, 200, { ok: true, data: await manager.selectNode(id) });
        }
        if (action === 'check' && req.method === 'POST') {
          return json(res, 200, { ok: true, data: await checkNode(id) });
        }
      }
      return json(res, 404, { ok: false, error: '接口不存在' });
    } catch (error) {
      return json(res, /不存在/.test(error.message) ? 404 : 400, { ok: false, error: error.message });
    }
  });

  const requireProxyAuth = proxyAuthRequired !== undefined ? Boolean(proxyAuthRequired) : Boolean(apiToken);

  function assertLocalPortSafe(host, port) {
    const localHosts = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
    if (localHosts.has(host.toLowerCase()) && manager.localPorts.map(Number).includes(Number(port))) {
      throw new Error('目标指向本地出口端口，已拒绝转发');
    }
  }

  const httpProxyServer = trackSockets(net.createServer(client => {
    client.on('error', () => client.destroy());
    let buffer = Buffer.alloc(0);

    client.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index < 0) {
        if (buffer.length > 64 * 1024) client.destroy();
        return;
      }
      const head = buffer.subarray(0, index).toString('latin1');
      buffer = buffer.subarray(index + 4);
      const lines = head.split('\r\n');
      const requestLine = lines.shift() || '';
      const [method, rawUrl] = requestLine.split(' ');
      const headers = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      if (method === 'CONNECT') return handleConnect(rawUrl, headers, client);
      return handleRequest(method, rawUrl, headers, client);
    });

    function replyError(socket, status, text, extraHeaders = {}) {
      const body = JSON.stringify({ ok: false, error: text });
      const payload = Buffer.from(body);
      const headerLines = [
        `HTTP/1.1 ${status} ${text}`,
        'content-type: application/json; charset=utf-8',
        'content-length: ' + payload.length,
        'connection: close',
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`)
      ];
      socket.end(headerLines.join('\r\n') + '\r\n\r\n' + body);
    }

    function proxyAuthorizedFor(headers) {
      if (!requireProxyAuth) return true;
      const header = String(headers['proxy-authorization'] || '');
      if (bearerMatches(header, apiToken)) return true;
      const basic = header.startsWith('Basic ')
        ? Buffer.from(header.slice(6), 'base64').toString('utf8')
        : '';
      if (basic) {
        const [user, pass] = basic.split(':');
        if (user && manager.listNodes().some(node => node.username === user && node.password === pass)) {
          return true;
        }
      }
      return false;
    }

    function parseTarget(rawUrl, headers) {
      const url = new URL(rawUrl, `http://${headers.host || 'localhost'}`);
      const host = url.hostname;
      const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
      if (!host) throw new Error('缺少目标主机');
      return { host, port, path: `${url.pathname}${url.search}` };
    }

    function handleRequest(method, rawUrl, headers, socket) {
      if (!proxyAuthorizedFor(headers)) return replyError(socket, 407, '代理需要认证', { 'proxy-authenticate': 'Bearer' });
      let upstream;
      try {
        upstream = manager.getSelectedNode();
      } catch (error) {
        return replyError(socket, 502, error.message);
      }
      let target;
      try {
        target = parseTarget(rawUrl, headers);
        assertLocalPortSafe(target.host, target.port);
      } catch (error) {
        return replyError(socket, 400, error.message);
      }

      if (upstream.type === 'http') {
        // 上游是普通 HTTP 代理：直接转发绝对形式请求
        const forwardedHeaders = { ...headers };
        delete forwardedHeaders['proxy-authorization'];
        delete forwardedHeaders['proxy-connection'];
        delete forwardedHeaders.connection;
        const outgoing = http.request({
          host: upstream.host,
          port: upstream.port,
          method,
          path: rawUrl,
          headers: forwardedHeaders
        }, upstreamRes => {
          // IncomingMessage 已经对 chunked 响应解码，不能原样转发
          // transfer-encoding，否则客户端会把普通正文误解析为分块长度。
          const chunks = [];
          upstreamRes.on('data', chunk => chunks.push(chunk));
          upstreamRes.on('end', () => {
            const body = Buffer.concat(chunks);
            const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || ''}`;
            const responseLines = [statusLine];
            for (const [key, value] of Object.entries(upstreamRes.headers)) {
              if (key === 'transfer-encoding' || key === 'content-length' || key === 'connection') continue;
              if (Array.isArray(value)) for (const item of value) responseLines.push(`${key}: ${item}`);
              else if (value !== undefined) responseLines.push(`${key}: ${value}`);
            }
            responseLines.push(`content-length: ${body.length}`);
            responseLines.push('connection: close');
            socket.end(Buffer.concat([Buffer.from(responseLines.join('\r\n') + '\r\n\r\n'), body]));
          });
          upstreamRes.on('error', () => replyError(socket, 502, '上游响应失败'));
        });
        outgoing.on('error', () => replyError(socket, 502, '上游转发失败'));
        outgoing.end(buffer);
        buffer = Buffer.alloc(0);
        return;
      }

      // HTTPS/SOCKS5 上游：先建隧道，再以原始请求转发
      connectTunnelThroughUpstream(upstream, target.host, target.port)
        .then(client => {
          if (closed) return client.destroy();
          client.on('error', () => {});
          const forwardedHeaders = { ...headers };
          delete forwardedHeaders['proxy-authorization'];
          delete forwardedHeaders['proxy-connection'];
          delete forwardedHeaders.connection;
          delete forwardedHeaders['content-length'];
          const rawLines = [`${method} ${target.path} HTTP/1.1`, `Host: ${target.host}:${target.port}`];
          for (const [key, value] of Object.entries(forwardedHeaders)) {
            if (key === 'host' || key === 'content-length') continue;
            rawLines.push(`${key}: ${value}`);
          }
          client.write(rawLines.join('\r\n') + '\r\n\r\n');
          if (buffer.length) client.write(buffer);

          let responseBuffer = Buffer.alloc(0);
          let headerParsed = false;
          client.on('data', data => {
            if (!headerParsed) {
              responseBuffer = Buffer.concat([responseBuffer, data]);
              const end = responseBuffer.indexOf('\r\n\r\n');
              if (end < 0) return;
              const responseHead = responseBuffer.subarray(0, end).toString('latin1');
              const responseLines = responseHead.split('\r\n');
              const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/.exec(responseLines.shift() || '');
              const statusCode = statusMatch ? Number(statusMatch[1]) : 502;
              const responseHeaders = {};
              for (const line of responseLines) {
                const colon = line.indexOf(':');
                if (colon > 0) responseHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
              }
              const outLines = [`HTTP/1.1 ${statusCode} ${statusMatch ? statusMatch[2] : ''}`];
              let chunked = false;
              for (const [key, value] of Object.entries(responseHeaders)) {
                if (key === 'connection' || key === 'proxy-connection') continue;
                if (key === 'transfer-encoding' && value.toLowerCase() === 'chunked') chunked = true;
                outLines.push(`${key}: ${value}`);
              }
              outLines.push('connection: close');
              socket.write(outLines.join('\r\n') + '\r\n\r\n');
              socket.write(responseBuffer.subarray(end + 4));
              headerParsed = true;
              if (chunked) {
                client.pipe(socket);
              } else {
                const contentLength = Number(responseHeaders['content-length'] || 0);
                let received = responseBuffer.length - (end + 4);
                if (received >= contentLength) return socket.end();
                client.on('data', data => {
                  received += data.length;
                  if (received >= contentLength) {
                    socket.end(data);
                  } else {
                    socket.write(data);
                  }
                });
              }
            }
          });
          client.on('end', () => {
            if (!socket.destroyed && !socket.writableEnded) socket.end();
          });
        })
        .catch(() => replyError(socket, 502, '无法连接上游节点'));
    }

    function handleConnect(rawUrl, headers, socket) {
      if (!proxyAuthorizedFor(headers)) {
        return replyError(socket, 407, 'Proxy Authentication Required', { 'proxy-authenticate': 'Bearer' });
      }
      let upstream;
      try {
        upstream = manager.getSelectedNode();
      } catch (error) {
        return replyError(socket, 502, error.message);
      }
      const [host, portText] = rawUrl.split(':');
      const port = Number(portText) || 443;
      try {
        assertLocalPortSafe(host, port);
      } catch (error) {
        return replyError(socket, 400, error.message);
      }
      connectTunnelThroughUpstream(upstream, host, port)
        .then(client => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (buffer.length) client.write(buffer);
          buffer = Buffer.alloc(0);
          pipeTunnel(socket, client);
        })
        .catch(() => replyError(socket, 502, 'Bad Gateway'));
    }
  }));

  const socksProxyServer = trackSockets(net.createServer(client => {
    client.on('error', () => client.destroy());
    let buffer = Buffer.alloc(0);
    let state = 'greeting';
    let tunneling = false;

    function onData(chunk) {
      if (tunneling) return;
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (state === 'greeting') handleGreeting();
        else if (state === 'auth') handleAuth();
        else if (state === 'connect') handleConnect();
      } catch {
        client.destroy();
      }
    }
    client.on('data', onData);

    function consume(n) {
      const rest = buffer.subarray(n);
      buffer = rest;
    }

    function handleGreeting() {
      if (buffer.length < 2 || buffer[0] !== 0x05) throw new Error('无效的 SOCKS5 握手');
      const count = buffer[1];
      if (buffer.length < 2 + count) return;
      const methods = [...buffer.subarray(2, 2 + count)];
      consume(2 + count);
      if (requireProxyAuth) {
        if (!methods.includes(0x02)) {
          client.write(Buffer.from([0x05, 0xff]));
          client.destroy();
          throw new Error('客户端不支持用户名密码认证');
        }
        client.write(Buffer.from([0x05, 0x02]));
        state = 'auth';
      } else {
        client.write(Buffer.from([0x05, 0x00]));
        state = 'connect';
      }
      if (state === 'auth') handleAuth();
      else handleConnect();
    }

    function handleAuth() {
      if (buffer.length < 2) return;
      if (buffer[0] !== 0x01) throw new Error('无效的 SOCKS5 认证');
      const userLength = buffer[1];
      if (buffer.length < 2 + userLength + 1) return;
      const passLength = buffer[2 + userLength];
      if (buffer.length < 2 + userLength + 1 + passLength) return;
      const user = buffer.subarray(2, 2 + userLength).toString('utf8');
      const pass = buffer.subarray(2 + userLength + 1, 2 + userLength + 1 + passLength).toString('utf8');
      consume(2 + userLength + 1 + passLength);
      const ok = (user === apiToken && !pass) ||
        manager.listNodes().some(node => node.username === user && node.password === pass);
      if (!ok) {
        // 先完整发送 RFC 1929 认证失败响应，再有序关闭连接。
        // 直接 write() 后 destroy() 可能丢弃响应，导致客户端一直等待。
        client.end(Buffer.from([0x01, 0x01]));
        return;
      }
      client.write(Buffer.from([0x01, 0x00]));
      state = 'connect';
      handleConnect();
    }

    function handleConnect() {
      if (buffer.length < 4) return;
      if (buffer[0] !== 0x05 || buffer[1] !== 0x01) {
        throw new Error('仅支持 SOCKS5 CONNECT');
      }
      const addressType = buffer[3];
      let host;
      let port;
      let consumed;
      if (addressType === 0x01) {
        if (buffer.length < 4 + 4 + 2) return;
        host = [...buffer.subarray(4, 8)].join('.');
        port = buffer.readUInt16BE(8);
        consumed = 10;
      } else if (addressType === 0x03) {
        const length = buffer[4];
        if (buffer.length < 5 + length + 2) return;
        host = buffer.subarray(5, 5 + length).toString('utf8');
        port = buffer.readUInt16BE(5 + length);
        consumed = 5 + length + 2;
      } else if (addressType === 0x04) {
        if (buffer.length < 4 + 16 + 2) return;
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(4 + i).toString(16));
        host = parts.join(':');
        port = buffer.readUInt16BE(20);
        consumed = 22;
      } else {
        throw new Error('不支持的 SOCKS5 地址类型');
      }
      consume(consumed);

      assertLocalPortSafe(host, port);
      let upstream;
      try {
        upstream = manager.getSelectedNode();
      } catch (error) {
        client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
        return;
      }

      connectThroughUpstream(upstream, host, port)
        .then(target => {
          tunneling = true;
          client.removeListener('data', onData);
          // BND.ADDR 按客户端地址族构造；无法判定时退化为 0.0.0.0:0
          const local = client.localAddress;
          let reply;
          if (local && net.isIP(local) === 6) {
            const words = [];
            for (let i = 0; i < 8; i += 1) words.push(local.split(':')[i] || '0');
            const bytes = Buffer.alloc(16);
            words.forEach((word, i) => bytes.writeUInt16BE(parseInt(word, 16) || 0, i * 2));
            reply = Buffer.from([0x05, 0x00, 0x00, 0x04, ...bytes, 0, 0]);
          } else {
            const v4 = local && net.isIP(local) === 4 ? local.split('.').map(Number) : [0, 0, 0, 0];
            reply = Buffer.from([0x05, 0x00, 0x00, 0x01, ...v4, 0, 0]);
          }
          client.write(reply);
          if (buffer.length) target.unshift(buffer);
          pipeTunnel(client, target);
        })
        .catch((error) => {
          console.error('[node-to-proxy] SOCKS5 上游连接失败:', error && error.message);
          client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.destroy();
        });
    }

  }));

  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(healthTimer);
    await Promise.all([
      closeServer(apiServer),
      closeServer(httpProxyServer),
      closeServer(socksProxyServer)
    ]);
  }

  return {
    apiServer,
    httpProxyServer,
    socksProxyServer,
    checkNode,
    checkAll,
    close,
    allowlist,
    get requireProxyAuth() { return requireProxyAuth; }
  };
}

module.exports = { createApplication };