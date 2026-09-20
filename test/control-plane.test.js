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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-to-proxy-'));
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

test('鉴权、健康检查、节点 CRUD、批量导入和模式切换 API', async t => {
  const store = new ConfigStore(temporaryConfig());
  const manager = new NodeManager({ store, localPorts: [18080, 11080] });
  await manager.load();
  const application = await createApplication({ manager, apiToken: 'test-token', healthIntervalMs: 60000 });
  const port = await listen(application.apiServer);
  t.after(() => application.close());

  const health = await request(port, '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  assert.equal((await request(port, '/api/nodes')).status, 401);
  const auth = { authorization: 'Bearer test-token' };

  const created = await request(port, '/api/nodes', {
    method: 'POST', headers: auth,
    body: { name: '测试节点', type: 'http', host: 'proxy.example', port: 3128 }
  });
  assert.equal(created.status, 201);
  assert.ok(created.json.data.id);
  const id = created.json.data.id;

  const updated = await request(port, `/api/nodes/${id}`, {
    method: 'PATCH', headers: auth, body: { name: '已更新节点' }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.data.name, '已更新节点');

  const imported = await request(port, '/api/nodes/import', {
    method: 'POST', headers: auth,
    body: { links: 'http://a.example:8000#甲\nsocks5://b.example:1081#乙' }
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.json.data.length, 2);

  assert.equal((await request(port, `/api/nodes/${id}/select`, { method: 'POST', headers: auth })).status, 200);
  const auto = await request(port, '/api/mode', { method: 'PUT', headers: auth, body: { mode: 'auto' } });
  assert.equal(auto.status, 200);
  assert.equal(auto.json.data.mode, 'auto');
  const roundRobin = await request(port, '/api/mode', { method: 'PUT', headers: auth, body: { mode: 'round-robin' } });
  assert.equal(roundRobin.status, 200);
  assert.equal(roundRobin.json.data.mode, 'round-robin');

  const checked = await request(port, `/api/nodes/${id}/check`, { method: 'POST', headers: auth });
  assert.equal(checked.status, 200);
  assert.ok(['healthy', 'unhealthy'].includes(checked.json.data.health));

  assert.equal((await request(port, `/api/nodes/${id}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal((await request(port, '/api/nodes', { headers: auth })).json.data.some(node => node.id === id), false);
});

test('应用同时提供 HTTP 与 SOCKS5 本地出口并可优雅关闭', async () => {
  const store = new ConfigStore(temporaryConfig());
  const manager = new NodeManager({ store, localPorts: [] });
  await manager.load();
  const application = await createApplication({ manager, apiToken: 'token', healthIntervalMs: 60000 });
  await listen(application.httpProxyServer);
  await listen(application.socksProxyServer);
  assert.ok(application.httpProxyServer.address().port > 0);
  assert.ok(application.socksProxyServer.address().port > 0);
  await application.close();
  assert.equal(application.httpProxyServer.listening, false);
  assert.equal(application.socksProxyServer.listening, false);
});
