'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore } = require('../src/config-store');
const { NodeManager } = require('../src/node-manager');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'node-to-proxy-select-'));
}

async function makeManager() {
  const dir = tempDir();
  const manager = new NodeManager({
    store: new ConfigStore(path.join(dir, 'config.json')),
    localPorts: [18999, 18998]
  });
  await manager.load();
  return manager;
}

function weekAgo() {
  return new Date(Date.now() - 10 * 60 * 1000).toISOString();
}

test('自主选择：auto 模式按最低延迟选中健康节点', async () => {
  const manager = await makeManager();
  const slow = await manager.addNode({ name: '慢', type: 'http', host: 'slow.example', port: 8080 });
  const fast = await manager.addNode({ name: '快', type: 'http', host: 'fast.example', port: 8081 });
  await manager.updateNode(slow.id, { health: 'healthy', latencyMs: 200 });
  await manager.updateNode(fast.id, { health: 'healthy', latencyMs: 30 });

  await manager.setMode('auto');
  const picked = manager.getSelectedNode();
  assert.equal(picked.id, fast.id);
});

test('故障切换：当前节点连续失败达阈值后切到更优健康节点', async () => {
  const manager = await makeManager();
  const current = await manager.addNode({ name: '当前', type: 'http', host: 'cur.example', port: 8080 });
  const backup = await manager.addNode({ name: '备用', type: 'http', host: 'back.example', port: 8081 });
  await manager.updateNode(current.id, { health: 'healthy', latencyMs: 20 });
  await manager.updateNode(backup.id, { health: 'healthy', latencyMs: 40 });
  await manager.setMode('auto');
  manager.state.lastSwitchAt = weekAgo();
  assert.equal(manager.getSelectedNode().id, current.id);

  // 第一次失败：未达切换阈值，保持当前节点
  await manager.applyHealthResult(current.id, { ok: false, error: '连接被重置' });
  assert.equal(manager.getSelectedNode().id, current.id);

  // 第二次失败：达到阈值，立即故障切换到备用节点
  await manager.applyHealthResult(current.id, { ok: false, error: '连接被拒绝' });
  assert.equal(manager.getSelectedNode().id, backup.id);
});

test('连续失败自动禁用节点，成功检查恢复', async () => {
  const manager = await makeManager();
  const node = await manager.addNode({ name: '脆弱', type: 'http', host: 'weak.example', port: 8080 });
  await manager.setMode('auto');

  for (let i = 0; i < 3; i++) {
    await manager.applyHealthResult(node.id, { ok: false, error: '健康检查超时' });
  }
  const afterFails = manager.listNodes().find(item => item.id === node.id);
  assert.equal(afterFails.autoDisabled, true);
  assert.equal(afterFails.health, 'unhealthy');

  // 自动禁用后不再参与选路
  assert.throws(() => manager.getSelectedNode(), /没有可用的上游节点/);

  // 恢复：下一次健康检查成功即回到候选池
  await manager.applyHealthResult(node.id, { ok: true, latencyMs: 55 });
  const recovered = manager.listNodes().find(item => item.id === node.id);
  assert.equal(recovered.autoDisabled, false);
  assert.equal(recovered.failCount, 0);
  assert.equal(recovered.health, 'healthy');
  assert.equal(manager.getSelectedNode().id, node.id);
});

test('瞬时错误不误判：节点此前健康时保留健康状态', async () => {
  const manager = await makeManager();
  const node = await manager.addNode({ name: '抖动', type: 'http', host: 'jitter.example', port: 8080 });
  await manager.updateNode(node.id, { health: 'healthy', latencyMs: 40 });

  await manager.applyHealthResult(node.id, { ok: false, error: '健康检查超时' });
  const after = manager.listNodes().find(item => item.id === node.id);
  assert.equal(after.health, 'healthy');
  assert.equal(after.autoDisabled, false);
  assert.equal(after.failCount, 1);
});

test('低延迟切换受冷却期与最小改善阈值约束', async () => {
  const manager = await makeManager();
  const cur = await manager.addNode({ name: '当前', type: 'http', host: 'c.example', port: 8080 });
  const cand = await manager.addNode({ name: '更优', type: 'http', host: 'b.example', port: 8081 });
  await manager.updateNode(cur.id, { health: 'healthy', latencyMs: 100 });
  await manager.updateNode(cand.id, { health: 'healthy', latencyMs: 95 });
  await manager.setMode('auto');
  // 先手工确立当前节点，避免首次选路走 initial 分支（无当前节点时忽略冷却）
  await manager.activateNode(cur.id, { mode: 'auto' });

  // 刚切换过（冷却期内）→ 即使候选更快也不切
  manager.state.lastSwitchAt = new Date().toISOString();
  assert.equal(manager.getSelectedNode().id, cur.id);

  // 冷却期结束但改善不足 80ms → 不切
  manager.state.lastSwitchAt = weekAgo();
  assert.equal(manager.getSelectedNode().id, cur.id);

  // 改善达标（200 → 95）→ 切换
  await manager.updateNode(cur.id, { health: 'healthy', latencyMs: 200 });
  manager.state.lastSwitchAt = weekAgo();
  assert.equal(manager.getSelectedNode().id, cand.id);
});

test('轮询模式按时间窗口保持节点，到期后切换并跳过禁用节点', async () => {
  const manager = await makeManager();
  const a = await manager.addNode({ name: 'A', type: 'http', host: 'a.example', port: 8080 });
  const b = await manager.addNode({ name: 'B', type: 'http', host: 'b.example', port: 8081 });
  const c = await manager.addNode({ name: 'C', type: 'http', host: 'c.example', port: 8082 });
  await manager.updateNode(a.id, { health: 'healthy', latencyMs: 10 });
  await manager.updateNode(b.id, { health: 'healthy', latencyMs: 20 });
  await manager.updateNode(c.id, { health: 'healthy', latencyMs: 30 });

  await manager.setRoundRobinInterval(30);
  await manager.setMode('round-robin');
  assert.deepEqual(
    [manager.getSelectedNode().name, manager.getSelectedNode().name],
    ['A', 'A']
  );

  manager.state.nextRoundRobinAt = new Date(Date.now() - 1).toISOString();
  assert.equal(manager.getSelectedNode().name, 'B');
  assert.equal(manager.getSelectedNode().name, 'B');

  await manager.updateNode(c.id, { enabled: false });
  manager.state.nextRoundRobinAt = new Date(Date.now() - 1).toISOString();
  assert.equal(manager.getSelectedNode().name, 'A');
});

test('手动模式忽略健康状态，始终返回所选节点', async () => {
  const manager = await makeManager();
  const node = await manager.addNode({ name: '手选', type: 'http', host: 'm.example', port: 8080 });
  await manager.updateNode(node.id, { health: 'unhealthy', latencyMs: null, failCount: 5 });
  await manager.selectNode(node.id);
  assert.equal(manager.getSelectedNode().id, node.id);
});

test('手动重新启用节点时清除自动禁用标记', async () => {
  const manager = await makeManager();
  const node = await manager.addNode({ name: '重开', type: 'http', host: 'r.example', port: 8080 });
  await manager.updateNode(node.id, { autoDisabled: true });
  assert.equal(manager.listNodes()[0].autoDisabled, true);
  await manager.updateNode(node.id, { enabled: true });
  assert.equal(manager.listNodes()[0].autoDisabled, false);
});