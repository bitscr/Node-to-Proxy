'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNodeLink, parseNodeBatch, validateNode } = require('../src/node-parser');

test('解析带鉴权的 HTTP 节点链接', () => {
  const node = parseNodeLink('http://alice:secret@proxy.example.com:8080#办公节点');
  assert.equal(node.type, 'http');
  assert.equal(node.host, 'proxy.example.com');
  assert.equal(node.port, 8080);
  assert.equal(node.username, 'alice');
  assert.equal(node.password, 'secret');
  assert.equal(node.name, '办公节点');
});

test('解析 SOCKS5 节点链接', () => {
  const node = parseNodeLink('socks5://127.0.0.1:1081#本地测试');
  assert.equal(node.type, 'socks5');
  assert.equal(node.host, '127.0.0.1');
  assert.equal(node.port, 1081);
  assert.equal(node.name, '本地测试');
});

test('批量导入忽略空行并按规范化地址去重', () => {
  const nodes = parseNodeBatch('\nhttp://a.example:8000#甲\nhttp://a.example:8000#重复\nsocks5://b.example:1080#乙\n');
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map((node) => node.type), ['http', 'socks5']);
});

test('拒绝无效协议、端口和缺失主机', () => {
  assert.throws(() => parseNodeLink('ftp://example.com:21'), /不支持|协议/);
  assert.throws(() => parseNodeLink('http://example.com:70000'), /端口|无效/);
  assert.throws(() => validateNode({ type: 'http', host: '', port: 8080 }), /主机/);
});

test('拒绝指向本地出口端口的代理回环', () => {
  assert.throws(
    () => validateNode(
      { type: 'http', host: '127.0.0.1', port: 8080 },
      { localPorts: [8080, 1080] }
    ),
    /回环|本地出口/
  );
});
