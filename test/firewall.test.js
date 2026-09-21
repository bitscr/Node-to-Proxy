'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Allowlist } = require('../src/firewall');

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-to-proxy-firewall-'));
  return {
    directory,
    file: path.join(directory, 'allowlist.json'),
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('rejects 0.0.0.0/32 because it does not mean all IPv4 addresses', () => {
  const store = temporaryStore();
  try {
    const allowlist = new Allowlist(store.file);
    assert.throws(
      () => allowlist.add('0.0.0.0/32'),
      /开放全部 IPv4 请使用 0\.0\.0\.0\/0/
    );
  } finally {
    store.cleanup();
  }
});

test('rejects ::/128 because it does not mean all IPv6 addresses', () => {
  const store = temporaryStore();
  try {
    const allowlist = new Allowlist(store.file);
    assert.throws(
      () => allowlist.add('::/128'),
      /开放全部 IPv6 请使用 ::\/0/
    );
  } finally {
    store.cleanup();
  }
});

test('accepts wildcard networks with prefix length zero', () => {
  const store = temporaryStore();
  try {
    const allowlist = new Allowlist(store.file);
    assert.equal(allowlist.add('0.0.0.0/0').cidr, '0.0.0.0/0');
    assert.equal(allowlist.add('::/0').cidr, '::/0');
  } finally {
    store.cleanup();
  }
});
