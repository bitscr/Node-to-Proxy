'use strict';

// 代理端口入口防火墙：白名单（allowlist）→ nftables 规则。
// 只有白名单内的 IP/CIDR 能访问 HTTP/SOCKS 代理出口端口，
// 其余来源一律 RST 拒绝。Web 控制台端口（28080）不受限，靠密码登录保护。
//
// 服务以 node2proxy 运行，nftables 规则通过预先配置的 sudoers
// NOPASSWD 条目调用 scripts/firewall.sh 生效。

const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'firewall.sh');

// 接受裸 IP（1.2.3.4 / 2001:db8::1）与 CIDR（1.2.3.0/24）
function isCidr(value) {
  const text = String(value || '').trim();
  const parts = text.split('/');
  if (parts.length === 1) {
    // 裸 IP → 按完整前缀处理
    const family = net.isIP(parts[0]);
    return family === 4 || family === 6;
  }
  if (parts.length !== 2) return false;
  const bits = Number(parts[1]);
  if (!Number.isInteger(bits) || bits < 0) return false;
  if (net.isIP(parts[0]) === 4) return bits <= 32;
  if (net.isIP(parts[0]) === 6) return bits <= 128;
  return false;
}

// 归一化：裸 IP → CIDR 全前缀形式（1.2.3.4 → 1.2.3.4/32, 2001:db8::1 → 2001:db8::1/128）
function normalizeCidr(value) {
  let text = String(value || '').trim();
  if (!text.includes('/')) {
    const family = net.isIP(text);
    if (family === 4) text += '/32';
    else if (family === 6) text += '/128';
  }
  return text;
}

function familyOf(value) {
  const host = String(value || '').split('/')[0];
  const family = net.isIP(host);
  if (family === 4) return 'v4';
  if (family === 6) return 'v6';
  return null;
}

function runScript(args) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['-n', SCRIPT_PATH, ...args], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`防火墙脚本执行失败：${(stderr || stdout || error.message).trim().slice(0, 300)}`));
      resolve(String(stdout || '').trim());
    });
  });
}

class Allowlist {
  constructor(storePath, { webPort = 28080, proxyPorts = [38080, 38081] } = {}) {
    this.storePath = storePath;
    this.webPort = webPort;
    this.proxyPorts = proxyPorts;
    this.entries = this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      return Array.isArray(data.entries) ? data.entries : [];
    } catch {
      return [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify({ entries: this.entries }, null, 2));
  }

  list() {
    return this.entries.map(entry => ({ ...entry }));
  }

  add(value) {
    const raw = String(value || '').trim();
    if (!isCidr(raw)) throw new Error(`无效的 IP/CIDR：${raw}（支持 IPv4/IPv6，可用前缀如 1.2.3.4 或 2001:db8::/32）`);
    const cidr = normalizeCidr(raw);
    const family = familyOf(cidr);
    if (this.entries.some(entry => entry.cidr === cidr)) throw new Error(`已在白名单中：${cidr}`);
    const entry = { id: crypto.randomUUID(), cidr, family, createdAt: new Date().toISOString() };
    this.entries.push(entry);
    this._save();
    return { ...entry };
  }

  remove(id) {
    const index = this.entries.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error('白名单条目不存在');
    const [removed] = this.entries.splice(index, 1);
    this._save();
    return { ...removed };
  }

  async apply() {
    const result = await runScript([
      '--allowlist', this.storePath,
      '--web-port', String(this.webPort),
      '--ports', this.proxyPorts.join(',')
    ]);
    return result;
  }
}

module.exports = { Allowlist, isCidr, familyOf, normalizeCidr, SCRIPT_PATH };