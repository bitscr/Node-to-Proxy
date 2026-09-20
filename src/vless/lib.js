'use strict';

// VLESS integration layer for Node-to-Proxy.
//
// Wraps the ported ProxyBridge VLESS stack (link parser, header codec,
// WebSocket client, Cloudflare edge pool and dialer) into the surface the
// rest of the application needs:
//   * parseVlessLink            - validate and normalise a vless:// share link
//   * getDialerForNode          - lazy, config-keyed dialer cache
//   * openVlessTunnelFromNode   - dial the node to a target, returns duplex
//   * probeVlessNode            - health probe: open tunnel + close cleanly

const crypto = require('node:crypto');
const { parseVlessLink } = require('./link');
const { VlessDialer, openVlessTunnel } = require('./dialer');

const dialerCache = new Map(); // configKey -> VlessDialer

function configKeyOf(parsed) {
  const parts = [
    parsed.uuid,
    parsed.host,
    parsed.port,
    parsed.sni,
    parsed.wsHost,
    parsed.path,
    parsed.alpn.join(','),
    parsed.fingerprint,
    parsed.allowInsecure ? 'insecure' : 'secure'
  ];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function getDialerForNode(node, { logger } = {}) {
  const parsed = typeof node.vlessLink === 'string'
    ? parseVlessLink(node.vlessLink)
    : node.vless; // already-parsed config (API object form)
  const key = configKeyOf(parsed);
  if (!dialerCache.has(key)) {
    dialerCache.set(key, new VlessDialer({ link: parsed, logger }));
  }
  return dialerCache.get(key);
}

function openVlessTunnelFromNode(node, targetHost, targetPort, { logger } = {}) {
  const dialer = getDialerForNode(node, { logger });
  return dialer.dial({ host: targetHost, port: targetPort });
}

// Health probe: opening the tunnel exercises DNS + TLS + WS upgrade + the
// upstream VLESS handshake end to end. The probe target is deliberately a
// stable, always-up endpoint; the tunnel is closed as soon as it is up.
async function probeVlessNode(node, targetHost = 'api.ipify.org', targetPort = 443) {
  const startedAt = Date.now();
  const { stream } = await openVlessTunnelFromNode(node, targetHost, targetPort);
  const latency = Date.now() - startedAt;
  setTimeout(() => stream.destroy(), 0);
  return { ok: true, latencyMs: latency };
}

module.exports = {
  parseVlessLink,
  getDialerForNode,
  openVlessTunnelFromNode,
  probeVlessNode,
  configKeyOf,
  // re-exported for the self-check tooling
  VlessDialer,
  openVlessTunnel
};