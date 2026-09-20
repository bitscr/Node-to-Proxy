'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
const managerSource = fs.readFileSync(path.join(__dirname, '../src/node-manager.js'), 'utf8');

test('HTTP 正向代理、CONNECT 与 SOCKS5 不得保留固定占位响应', () => {
  // 占位实现的标志：整段代理服务器只回固定错误码，没有任何转发逻辑
  assert.doesNotMatch(appSource, /httpProxyServer\.on\('connect'/);
  assert.doesNotMatch(appSource, /json\(res,\s*501/);
  assert.doesNotMatch(appSource, /HTTP\/1\.1 503 Service Unavailable/);
  // 真实实现必须包含上游连接与隧道建立逻辑
  assert.match(appSource, /connectThroughUpstream/);
  assert.match(appSource, /handleConnect/);
  assert.match(appSource, /socksProxyServer\s*=\s*(?:trackSockets\()?net\.createServer/);
});

test('节点管理器必须实现运行时节点选择而非仅保存模式字段', () => {
  assert.match(managerSource, /getSelectedNode\s*\(/);
  assert.match(managerSource, /roundRobinIndex|round[-_ ]?robin/i);
  assert.match(managerSource, /latency|healthy|health/i);
});
