'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { ConfigStore } = require('../src/config-store');
const { NodeManager } = require('../src/node-manager');
const { createApplication } = require('../src/app');

function temporaryConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-to-proxy-e2e-'));
  return path.join(directory, 'config.json');
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function request(port, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    body = Buffer.from(JSON.stringify(options.body));
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function startEchoServer() {
  return new Promise(resolve => {
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => socket.destroy());
      socket.on('data', data => socket.write(data));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      get port() { return server.address().port; },
      close: () => new Promise(done => {
        for (const socket of sockets) socket.destroy();
        server.close(done);
      })
    }));
  });
}

function startHttpUpstream({ proxyUsername, proxyPassword } = {}) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const auth = req.headers['proxy-authorization'] || null;
      if (proxyUsername) {
        const expected = `Basic ${Buffer.from(`${proxyUsername}:${proxyPassword}`).toString('base64')}`;
        if (auth !== expected) {
          res.writeHead(407, { 'proxy-authenticate': 'Basic realm="upstream"' });
          res.end();
          return;
        }
      }
      const target = new URL(req.url, 'http://localhost');
      const body = [`REQ:${req.method}`, `PATH:${target.pathname}`, `HOST:${target.host}`].join('\n');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    });
    server.on('connect', (req, clientSocket, head) => {
      const [host, portText] = req.url.split(':');
      const port = Number(portText) || 443;
      const auth = req.headers['proxy-authorization'] || null;
      if (proxyUsername) {
        const expected = `Basic ${Buffer.from(`${proxyUsername}:${proxyPassword}`).toString('base64')}`;
        if (auth !== expected) {
          clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          return;
        }
      }
      const target = net.createConnection({ host, port });
      const cleanup = () => {
        clientSocket.destroy();
        target.destroy();
      };
      clientSocket.on('error', cleanup);
      target.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      target.on('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) target.write(head);
        target.pipe(clientSocket);
        clientSocket.pipe(target);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      get port() { return server.address().port; },
      close: () => new Promise(done => server.close(done))
    }));
  });
}

function startSocks5Upstream({ username, password } = {}) {
  return new Promise(resolve => {
    const sockets = new Set();
    const server = net.createServer(client => {
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      client.on('error', () => client.destroy());
      let buffer = Buffer.alloc(0);
      const onData = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        try { tick(); } catch { client.destroy(); }
      };
      client.on('data', onData);
      let stage = 'greet';
      function tick() {
        if (stage === 'greet') {
          if (buffer.length < 2 || buffer[0] !== 0x05) throw new Error('bad greet');
          const n = buffer[1];
          if (buffer.length < 2 + n) return;
          const methods = [...buffer.subarray(2, 2 + n)];
          buffer = buffer.subarray(2 + n);
          if (username) {
            if (!methods.includes(0x02)) { client.write(Buffer.from([0x05, 0xff])); client.destroy(); throw new Error('no auth'); }
            client.write(Buffer.from([0x05, 0x02]));
            stage = 'auth';
          } else {
            client.write(Buffer.from([0x05, 0x00]));
            stage = 'conn';
          }
          tick();
        } else if (stage === 'auth') {
          if (buffer.length < 2) return;
          const ulen = buffer[1];
          if (buffer.length < ulen + 3) return;
          const plen = buffer[ulen + 2];
          if (buffer.length < ulen + plen + 3) return;
          const user = buffer.subarray(2, 2 + ulen).toString();
          const pass = buffer.subarray(ulen + 3, ulen + plen + 3).toString();
          buffer = buffer.subarray(ulen + plen + 3);
          if (user !== username || pass !== (password || '')) {
            client.write(Buffer.from([0x01, 0x01]));
            client.destroy();
            throw new Error('bad creds');
          }
          client.write(Buffer.from([0x01, 0x00]));
          stage = 'conn';
          tick();
        } else if (stage === 'conn') {
          if (buffer.length < 4) return;
          const type = buffer[3];
          let host;
          let port;
          let consumed;
          if (type === 0x01) {
            if (buffer.length < 10) return;
            host = [...buffer.subarray(4, 8)].join('.');
            port = buffer.readUInt16BE(8);
            consumed = 10;
          } else if (type === 0x03) {
            const len = buffer[4];
            if (buffer.length < 5 + len + 2) return;
            host = buffer.subarray(5, 5 + len).toString();
            port = buffer.readUInt16BE(5 + len);
            consumed = 5 + len + 2;
          } else {
            throw new Error('unsupported addr');
          }
          buffer = buffer.subarray(consumed);
          const target = net.createConnection({ host, port });
          target.on('error', () => client.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
          target.on('connect', () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            client.removeListener('data', onData);
            if (buffer.length) target.write(buffer);
            buffer = Buffer.alloc(0);
            target.pipe(client);
            client.pipe(target);
          });
        }
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({
      get port() { return server.address().port; },
      close: () => new Promise(done => {
        for (const socket of sockets) socket.destroy();
        server.close(done);
      })
    }));
  });
}

function startSocks5EchoServer() {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      socket.on('error', () => socket.destroy());
      socket.on('data', data => {
        if (data[0] === 0x05) {
          // 简易 SOCKS5 上游：响应选择 0x00
          socket.write(Buffer.from([0x05, 0x00]));
          return;
        }
        socket.write(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      get port() { return server.address().port; },
      close: () => new Promise(done => server.close(done))
    }));
  });
}

function httpRequestThroughProxy(proxyPort, target, options = {}) {
  const headers = { host: `${target.host}:${target.port}`, ...(options.headers || {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: '/echo?x=1', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectTunnel(proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
      let buffer = Buffer.alloc(0);
      socket.on('data', function onData(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        const index = buffer.indexOf('\r\n\r\n');
        if (index < 0) return;
        socket.removeListener('data', onData);
        const head = buffer.subarray(0, index).toString('latin1');
        const status = Number(/^HTTP\/\d\.\d\s+(\d{3})/.exec(head)[1]);
        if (status !== 200) return reject(new Error('CONNECT 失败 ' + head.split('\r\n')[0]));
        const rest = buffer.subarray(index + 4);
        socket.write('ping-through-connect');
        resolve({ socket, rest });
      });
    });
  });
}

function socks5Connect(proxyPort, targetHost, targetPort, { username, password } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    let buffer = Buffer.alloc(0);
    let settled = false;
    let stage = 'connecting';
    const timer = setTimeout(() => {
      fail(new Error(`SOCKS5 测试连接超时，当前阶段：${stage}`));
    }, 5000);
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onData) socket.removeListener('data', onData);
      socket.destroy();
      reject(error);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onData) socket.removeListener('data', onData);
      resolve(value);
    };
    let onData;
    socket.once('error', fail);
    socket.once('connect', () => {
      stage = 'greet';
      onData = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        try { tick(); } catch (error) { fail(error); }
      };
      const methods = username ? [0x00, 0x02] : [0x00];
      socket.on('data', onData);
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
      function tick() {
        if (stage === 'greet') {
          if (buffer.length < 2) return;
          const chosen = buffer[1];
          buffer = buffer.subarray(2);
          if (chosen === 0x02) {
            if (!username) throw new Error('服务器要求认证');
            const user = Buffer.from(username);
            const pass = Buffer.from(password || '');
            socket.write(Buffer.from([0x01, user.length, ...user, pass.length, ...pass]));
            stage = 'auth';
          } else if (chosen === 0x00) {
            stage = 'conn';
          } else {
            throw new Error('认证方式被拒 0xff');
          }
          tick();
        } else if (stage === 'auth') {
          if (buffer.length < 2) return;
          const status = buffer[1];
          buffer = buffer.subarray(2);
          if (status !== 0x00) throw new Error('认证失败');
          stage = 'conn';
          tick();
        } else if (stage === 'conn') {
          const hostParts = targetHost.split('.').map(Number);
          const addr = Buffer.from([0x01, ...hostParts]);
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00]),
            addr,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
          ]);
          socket.write(req);
          stage = 'rep';
          tick();
        } else if (stage === 'rep') {
          if (buffer.length < 10) return;
          const reply = buffer[1];
          buffer = buffer.subarray(10);
          if (reply !== 0x00) throw new Error('SOCKS5 连接拒绝 0x' + reply.toString(16));
          succeed({ socket, rest: buffer });
        }
      }
    });
  });
}

test('本地 HTTP 上游：GET 转发端到端', async t => {
  const target = await startEchoServer();
  t.after(() => target.close());
  const upstream = await startHttpUpstream();
  t.after(() => upstream.close());

  const manager = new NodeManager({
    store: new ConfigStore(temporaryConfig()),
    localPorts: [18080, 11080]
  });
  await manager.load();
  const app = await createApplication({ manager, apiToken: 'secret', healthIntervalMs: 60000 });
  const proxyPort = await listen(app.httpProxyServer);
  t.after(() => app.close());

  await manager.addNode({ name: '本地HTTP', type: 'http', host: '127.0.0.1', port: upstream.port, enabled: true });
  await manager.selectNode(manager.listNodes()[0].id);

  // 未带代理鉴权 → 407
  const denied = await httpRequestThroughProxy(proxyPort, target, {});
  assert.equal(denied.status, 407);

  // 带 Bearer 令牌 → 200 且响应来自上游
  const ok = await httpRequestThroughProxy(proxyPort, target, {
    headers: { 'proxy-authorization': 'Bearer secret' }
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.text.includes('REQ:GET'));
  assert.ok(ok.text.includes('PATH:/echo'));
  t.diagnostic('HTTP GET 经上游转发成功: ' + ok.text);

  // CONNECT 隧道（经 HTTP 上游转发到本地回显目标）
  const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接超时')), 4000);
    socket.on('connect', () => { clearTimeout(timer); resolve(); });
  });
  socket.write('CONNECT 127.0.0.1:' + target.port + ' HTTP/1.1\r\nHost: 127.0.0.1:' + target.port + '\r\nProxy-Authorization: Bearer secret\r\n\r\n');
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CONNECT 响应超时')), 4000);
    const onData = chunk => {
      const text = chunk.toString('latin1');
      if (!text.includes('\r\n\r\n')) return;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      const status = Number(/^HTTP\/\d\.\d\s+(\d{3})/.exec(text)[1]);
      resolve(status);
    };
    socket.on('data', onData);
  });
  assert.equal(response, 200, 'CONNECT 应返回 200');
  socket.write('ping-through-tunnel');
  const echo = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('隧道回显超时')), 4000);
    socket.once('data', data => { clearTimeout(timer); resolve(data.toString()); });
  });
  assert.equal(echo, 'ping-through-tunnel');
  socket.destroy();
});

test('SOCKS5 上游：真实 SOCKS5 握手协商并把请求转发到目标', async t => {
  const target = await startEchoServer();
  t.after(() => target.close());
  const upstream = await startSocks5Upstream({ username: 'upuser', password: 'uppass' });
  t.after(() => upstream.close());

  const manager = new NodeManager({
    store: new ConfigStore(temporaryConfig()),
    localPorts: [18081, 11081]
  });
  await manager.load();
  const app = await createApplication({ manager, apiToken: '', healthIntervalMs: 60000 });
  const socksPort = await listen(app.socksProxyServer);
  t.after(() => app.close());

  await manager.addNode({
    name: '本地SOCKS5', type: 'socks5',
    host: '127.0.0.1', port: upstream.port,
    username: 'upuser', password: 'uppass', enabled: true
  });
  await manager.selectNode(manager.listNodes()[0].id);

  const session = await socks5Connect(socksPort, '127.0.0.1', target.port);
  session.socket.write('hello-via-socks5');
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SOCKS5 转发超时')), 4000);
    session.socket.once('data', data => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
  assert.equal(response, 'hello-via-socks5');
  session.socket.destroy();
});

test('SOCKS5 出口鉴权：合法令牌通过、非法令牌被拒', async t => {
  const target = await startEchoServer();
  t.after(() => target.close());
  const upstream = await startSocks5Upstream();
  t.after(() => upstream.close());

  const manager = new NodeManager({
    store: new ConfigStore(temporaryConfig()),
    localPorts: [18082, 11082]
  });
  await manager.load();
  const app = await createApplication({ manager, apiToken: 'tok-123', healthIntervalMs: 60000 });
  const socksPort = await listen(app.socksProxyServer);
  t.after(() => app.close());

  await manager.addNode({ name: '本地SOCKS5', type: 'socks5', host: '127.0.0.1', port: upstream.port, enabled: true });
  await manager.selectNode(manager.listNodes()[0].id);

  await assert.rejects(
    () => socks5Connect(socksPort, '127.0.0.1', target.port, { username: 'wrong', password: 'x' }),
    /认证失败|0xff|被拒|拒绝/
  );

  const session = await socks5Connect(socksPort, '127.0.0.1', target.port, { username: 'tok-123', password: '' });
  session.socket.write('socks-auth-ok');
  const response = session.rest.length
    ? session.rest.toString()
    : await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.socket.destroy();
        reject(new Error('转发超时'));
      }, 4000);
      session.socket.once('data', data => {
        clearTimeout(timer);
        resolve(data.toString());
      });
    });
  assert.equal(response, 'socks-auth-ok');
  session.socket.destroy();
});

test('代理回环防护：目标指向本地出口端口时拒绝建立隧道', async t => {
  const manager = new NodeManager({
    store: new ConfigStore(temporaryConfig()),
    localPorts: [18083, 11083]
  });
  await manager.load();
  const app = await createApplication({ manager, apiToken: 'secret', healthIntervalMs: 60000 });
  const proxyPort = await listen(app.httpProxyServer);
  const socksPort = await listen(app.socksProxyServer);
  t.after(() => app.close());

  const upstream = await startSocks5Upstream();
  t.after(() => upstream.close());
  await manager.addNode({ name: '上游', type: 'socks5', host: '127.0.0.1', port: upstream.port, enabled: true });
  await manager.selectNode(manager.listNodes()[0].id);

  const response = await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    socket.on('connect', () => {
      socket.write('CONNECT 127.0.0.1:18083 HTTP/1.1\r\nHost: 127.0.0.1:18083\r\nProxy-Authorization: Bearer secret\r\n\r\n');
    });
    socket.on('error', () => resolve('error'));
    socket.on('data', data => {
      const text = data.toString();
      socket.destroy();
      resolve(text.split('\r\n')[0]);
    });
  });
  assert.match(response, /400/);
});

test('轮询模式：连续选择会依次切换健康节点', async t => {
  const upstreamA = await startHttpUpstream();
  const upstreamB = await startHttpUpstream();
  t.after(() => upstreamA.close());
  t.after(() => upstreamB.close());

  const manager = new NodeManager({
    store: new ConfigStore(temporaryConfig()),
    localPorts: [18084, 11084]
  });
  await manager.load();
  const store = manager.store;
  const app = await createApplication({ manager, apiToken: '', healthIntervalMs: 60000 });
  const proxyPort = await listen(app.httpProxyServer);
  t.after(() => app.close());

  const a = await manager.addNode({ name: 'A', type: 'http', host: '127.0.0.1', port: upstreamA.port });
  const b = await manager.addNode({ name: 'B', type: 'http', host: '127.0.0.1', port: upstreamB.port });
  await manager.setMode('round-robin');
  // 先做健康检查，让两个节点都是 healthy
  await manager.updateNode(a.id, { health: 'healthy', latencyMs: 10 });
  await manager.updateNode(b.id, { health: 'healthy', latencyMs: 20 });

  const picked = [];
  for (let i = 0; i < 4; i++) {
    const node = manager.getSelectedNode();
    picked.push(node.name);
  }
  assert.deepEqual(picked, ['A', 'B', 'A', 'B']);
});