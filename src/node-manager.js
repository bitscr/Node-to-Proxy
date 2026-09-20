'use strict';

const crypto = require('node:crypto');
const { validateNode } = require('./node-parser');

// 选路与健康状态参数（借鉴 siftlane 的判定逻辑）
const AUTO_DISABLE_FAIL_THRESHOLD = 3;          // 连续失败达到该次数自动禁用节点
const CURRENT_FAIL_SWITCH_THRESHOLD = 2;        // 当前节点失败达到该次数立即切换
const BEST_SWITCH_MIN_IMPROVEMENT_MS = 80;      // 延迟至少改善该毫秒数才切换
const BEST_SWITCH_COOLDOWN_MS = 5 * 60 * 1000;  // 低延迟切换冷却时间
const TRANSIENT_ERROR_PATTERN = /tls|ssl|握手|timeout|超时|reset|重置|socket disconnected|bad record/i;

function isTransientError(message) {
  return TRANSIENT_ERROR_PATTERN.test(String(message || ''));
}

class NodeManager {
  constructor({ store, localPorts = [] }) {
    this.store = store;
    this.localPorts = localPorts;
    this.state = {
      nodes: [],
      selectedNodeId: null,
      mode: 'manual',
      lastSwitchAt: null
    };
    this.mutation = Promise.resolve();
    this.roundRobinIndex = 0;
  }

  async load() {
    const loaded = await this.store.load(this.state);
    this.state = {
      ...this.state,
      ...loaded,
      nodes: Array.isArray(loaded.nodes) ? loaded.nodes : []
    };
    return this.getStatus();
  }

  _locked(operation) {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => {});
    return next;
  }

  async _save() {
    await this.store.save(this.state);
  }

  listNodes() {
    return this.state.nodes.map(node => ({ ...node }));
  }

  getStatus() {
    const usableCount = this.state.nodes.filter(node => this._usable(node)).length;
    return {
      selectedNodeId: this.state.selectedNodeId,
      mode: this.state.mode,
      nodeCount: this.state.nodes.length,
      usableNodeCount: usableCount
    };
  }

  _usable(node) {
    return Boolean(node) && node.enabled !== false && !node.autoDisabled;
  }

  _healthy(node) {
    return this._usable(node) && node.health === 'healthy' && Number.isFinite(node.latencyMs);
  }

  _latency(node) {
    return Number.isFinite(node?.latencyMs) ? node.latencyMs : Number.MAX_SAFE_INTEGER;
  }

  _bestHealthy(pool, excludeId = null) {
    return (pool || [])
      .filter(node => this._healthy(node) && node.id !== excludeId)
      .sort((a, b) => this._latency(a) - this._latency(b))[0] || null;
  }

  // 自主选择（auto）：当前节点连续失败≥2 立即故障切换；
  // 否则仅在延迟改善达到阈值且冷却期结束后切换到更优节点。
  _decideBestSwitch(nowMs = Date.now()) {
    const pool = this.state.nodes.filter(node => this._usable(node));
    if (!pool.length) return null;
    const current = pool.find(node => node.id === this.state.selectedNodeId) || null;

    if (!current) {
      const best = this._bestHealthy(pool) || pool[0];
      return { node: best, reason: 'initial' };
    }

    if ((current.failCount || 0) >= CURRENT_FAIL_SWITCH_THRESHOLD) {
      const failover = this._bestHealthy(pool, current.id) || pool.find(node => node.id !== current.id) || null;
      return failover ? { node: failover, reason: 'current_failed' } : null;
    }

    const best = this._bestHealthy(pool);
    if (!best || best.id === current.id) return null;

    const lastSwitch = this.state.lastSwitchAt ? Date.parse(this.state.lastSwitchAt) : 0;
    const cooledDown = !Number.isFinite(lastSwitch) || lastSwitch <= 0 || nowMs - lastSwitch >= BEST_SWITCH_COOLDOWN_MS;
    if (!cooledDown) return null;
    if (this._latency(best) + BEST_SWITCH_MIN_IMPROVEMENT_MS <= this._latency(current)) {
      return { node: best, reason: 'better_latency' };
    }
    return null;
  }

  _applySwitch(decision, nowMs) {
    this.state.selectedNodeId = decision.node.id;
    this.state.lastSwitchAt = new Date(nowMs).toISOString();
    return decision;
  }

  // 手动 / 自主 / 轮询 的运行时选路（每次代理请求调用）
  getSelectedNode() {
    const pool = this.state.nodes.filter(node => this._usable(node));
    if (!pool.length) throw new Error('没有可用的上游节点');

    if (this.state.mode === 'manual') {
      const selected = pool.find(node => node.id === this.state.selectedNodeId);
      if (!selected) throw new Error('未选择可用的上游节点');
      return { ...selected };
    }

    if (this.state.mode === 'auto') {
      const decision = this._decideBestSwitch();
      if (decision) this._applySwitch(decision, Date.now());
      const selected = pool.find(node => node.id === this.state.selectedNodeId) || pool[0];
      return { ...selected };
    }

    // round-robin：在可用节点（启用且未被自动禁用）间轮换
    const index = this.roundRobinIndex % pool.length;
    const selected = pool[index];
    this.roundRobinIndex = (index + 1) % pool.length;
    this.state.selectedNodeId = selected.id;
    return { ...selected };
  }

  // 健康检查完成后的自主重选（带冷却与延迟改善阈值，防止抖动）
  refreshAutoSelection() {
    if (this.state.mode !== 'auto') return null;
    const decision = this._decideBestSwitch();
    if (decision) {
      this._applySwitch(decision, Date.now());
      return decision;
    }
    return null;
  }

  // 健康检查结果记账（借鉴 siftlane applySpeedtestResultsToNodes）：
  // 成功重置失败计数并恢复；失败累加，连续失败超过阈值自动禁用；
  // 瞬时错误且节点此前健康时保留原健康状态，避免单次抖动误判。
  applyHealthResult(id, { ok, latencyMs = null, error = null }) {
    return this._locked(async () => {
      const node = this.state.nodes.find(item => item.id === id);
      if (!node) throw new Error('节点不存在');
      const now = new Date().toISOString();
      if (ok) {
        node.health = 'healthy';
        node.latencyMs = latencyMs;
        node.failCount = 0;
        node.successCount = (node.successCount || 0) + 1;
        node.autoDisabled = false;
        node.error = null;
        node.lastCheckedAt = now;
      } else {
        const failCount = (node.failCount || 0) + 1;
        const disableNow = failCount >= AUTO_DISABLE_FAIL_THRESHOLD;
        const keepPreviousUp = !disableNow && isTransientError(error)
          && node.health === 'healthy' && Number.isFinite(node.latencyMs);
        if (!keepPreviousUp) {
          node.health = 'unhealthy';
          node.latencyMs = null;
        }
        node.failCount = failCount;
        node.successCount = 0;
        node.autoDisabled = disableNow;
        node.error = error || '健康检查失败';
        node.lastCheckedAt = now;
      }
      await this._save();
      return { ...node };
    });
  }

  addNode(input) {
    return this._locked(async () => {
      const value = validateNode(input, { localPorts: this.localPorts });
      const node = {
        ...value,
        id: crypto.randomUUID(),
        enabled: input.enabled !== false,
        health: 'unknown',
        latencyMs: null,
        failCount: 0,
        successCount: 0,
        autoDisabled: false,
        error: null,
        lastCheckedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.state.nodes.push(node);
      await this._save();
      return { ...node };
    });
  }

  updateNode(id, patch) {
    return this._locked(async () => {
      const index = this.state.nodes.findIndex(node => node.id === id);
      if (index < 0) throw new Error('节点不存在');
      const current = this.state.nodes[index];
      const value = validateNode({ ...current, ...patch }, { localPorts: this.localPorts });
      const updated = {
        ...current,
        ...value,
        enabled: patch.enabled ?? current.enabled,
        health: patch.health ?? current.health,
        latencyMs: patch.latencyMs === undefined ? current.latencyMs : patch.latencyMs,
        autoDisabled: patch.autoDisabled === undefined ? current.autoDisabled : patch.autoDisabled,
        failCount: patch.failCount === undefined ? current.failCount : patch.failCount,
        successCount: patch.successCount === undefined ? current.successCount : patch.successCount,
        error: patch.error === undefined ? current.error : patch.error,
        lastCheckedAt: patch.lastCheckedAt ?? current.lastCheckedAt,
        updatedAt: new Date().toISOString()
      };
      // 用户手动重新启用节点时清除自动禁用标记
      if (patch.enabled === true) updated.autoDisabled = false;
      this.state.nodes[index] = updated;
      await this._save();
      return { ...updated };
    });
  }

  deleteNode(id) {
    return this._locked(async () => {
      const index = this.state.nodes.findIndex(node => node.id === id);
      if (index < 0) throw new Error('节点不存在');
      const [removed] = this.state.nodes.splice(index, 1);
      if (this.state.selectedNodeId === id) this.state.selectedNodeId = null;
      await this._save();
      return { ...removed };
    });
  }

  selectNode(id) {
    return this.activateNode(id, { mode: 'manual' });
  }

  activateNode(id, { mode = this.state.mode } = {}) {
    return this._locked(async () => {
      const node = this.state.nodes.find(item => item.id === id);
      if (!node) throw new Error('节点不存在');
      if (!this._usable(node)) throw new Error('节点已禁用');
      this.state.selectedNodeId = id;
      this.state.mode = mode;
      this.state.lastSwitchAt = new Date().toISOString();
      await this._save();
      return { ...node };
    });
  }

  setMode(mode) {
    return this._locked(async () => {
      const allowed = new Set(['manual', 'auto', 'round-robin']);
      if (!allowed.has(mode)) throw new Error('无效的运行模式');
      this.state.mode = mode;
      if (mode === 'auto' || mode === 'round-robin') {
        this.roundRobinIndex = 0;
      }
      await this._save();
      return this.getStatus();
    });
  }
}

module.exports = { NodeManager };