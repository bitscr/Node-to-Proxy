'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../src/config-store');
const { NodeManager } = require('../src/node-manager');

test('节点 CRUD、选择与配置持久化', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-to-proxy-'));
  const file = path.join(dir, 'config.json');
  const store = new ConfigStore(file);
  const manager = new NodeManager({ store, localPorts: [8080, 1080] });
  await manager.load();

  const first = await manager.addNode({
    name: '节点甲', type: 'http', host: 'proxy.example.com', port: 3128
  });
  assert.ok(first.id);
  assert.equal(manager.listNodes().length, 1);

  const updated = await manager.updateNode(first.id, { name: '节点甲改' });
  assert.equal(updated.name, '节点甲改');
  await manager.selectNode(first.id);
  assert.equal(manager.getStatus().selectedNodeId, first.id);

  const reloaded = new NodeManager({ store: new ConfigStore(file), localPorts: [8080, 1080] });
  await reloaded.load();
  assert.equal(reloaded.listNodes()[0].name, '节点甲改');
  assert.equal(reloaded.getStatus().selectedNodeId, first.id);

  await reloaded.deleteNode(first.id);
  assert.equal(reloaded.listNodes().length, 0);
});

test('拒绝本地出口回环并保护并发切换', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-to-proxy-'));
  const manager = new NodeManager({
    store: new ConfigStore(path.join(dir, 'config.json')),
    localPorts: [8080, 1080]
  });
  await manager.load();

  await assert.rejects(
    manager.addNode({ name: '回环', type: 'http', host: '127.0.0.1', port: 8080 }),
    /回环|本地端口/
  );

  const a = await manager.addNode({ name: '甲', type: 'http', host: 'a.example', port: 8000 });
  const b = await manager.addNode({ name: '乙', type: 'socks5', host: 'b.example', port: 1081 });
  await Promise.all([manager.selectNode(a.id), manager.selectNode(b.id)]);
  assert.ok([a.id, b.id].includes(manager.getStatus().selectedNodeId));
});
