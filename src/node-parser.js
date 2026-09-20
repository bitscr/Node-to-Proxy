'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { parseVlessLink } = require('./vless/lib');

const SUPPORTED_TYPES = new Set(['http', 'https', 'socks5', 'vless']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);

function cleanText(value, maxLength = 256) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function validateNode(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('节点必须是对象');
  }

  const type = cleanText(input.type, 16).toLowerCase();
  const host = cleanText(input.host, 253).toLowerCase();
  const port = Number(input.port);

  if (!SUPPORTED_TYPES.has(type)) throw new Error(`不支持的节点协议：${type || '空'}`);
  if (!host) throw new Error('节点主机不能为空');
  if (host.includes('/') || host.includes('\\') || /\s/.test(host)) throw new Error('节点主机格式无效');
  if (net.isIP(host) === 0 && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) {
    throw new Error('节点主机格式无效');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('节点端口无效');

  const localPorts = new Set((options.localPorts || []).map(Number));
  if (LOCAL_HOSTS.has(host) && localPorts.has(port)) {
    throw new Error('节点指向本地出口端口，可能形成代理回环');
  }

  return {
    id: cleanText(input.id, 64) || crypto.randomUUID(),
    name: cleanText(input.name, 80) || `${type.toUpperCase()} ${host}:${port}`,
    type,
    host,
    port,
    username: cleanText(input.username, 256),
    password: cleanText(input.password, 1024),
    enabled: input.enabled !== false,
    vlessLink: type === 'vless' ? cleanText(input.vlessLink, 4096) : undefined
  };
}

function parseNodeLink(link, options = {}) {
  const text = cleanText(link, 4096);
  if (!text) throw new Error('节点链接不能为空');

  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('节点链接无效');
  }

  const rawScheme = url.protocol.replace(/:$/, '').toLowerCase();
  const type = rawScheme === 'socks' ? 'socks5' : rawScheme;

  if (type === 'vless') {
    const parsed = parseVlessLink(text);
    const node = {
      type: 'vless',
      host: parsed.host,
      port: parsed.port,
      username: '',
      password: '',
      name: parsed.name || `VLESS ${parsed.host}:${parsed.port}`,
      vlessLink: text
    };
    return validateNode(node, options);
  }

  if (!SUPPORTED_TYPES.has(type)) throw new Error(`不支持的节点协议：${rawScheme}`);
  if (!url.hostname) throw new Error('节点主机不能为空');

  const defaultPort = type === 'https' ? 443 : type === 'http' ? 80 : 1080;
  const node = {
    type,
    host: url.hostname,
    port: url.port ? Number(url.port) : defaultPort,
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    name: url.hash ? decodeURIComponent(url.hash.slice(1)) : ''
  };

  return validateNode(node, options);
}

function parseNodeBatch(text, options = {}) {
  const seen = new Set();
  const nodes = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const node = parseNodeLink(line.trim(), options);
    const key = `${node.type}://${node.username}:${node.password}@${node.host}:${node.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(node);
  }
  return nodes;
}

module.exports = { SUPPORTED_TYPES, validateNode, parseNodeLink, parseNodeBatch };
