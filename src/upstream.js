'use strict';

const net = require('node:net');
const { openVlessTunnelFromNode } = require('./vless/lib');

function vlessConnectTarget(node, targetHost, targetPort) {
  return openVlessTunnelFromNode(node, targetHost, targetPort).then(result => result.stream);
}

function httpConnectTarget(socket, host, port, proxy) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    const headers = [
      `CONNECT ${host}:${port} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Proxy-Connection: keep-alive',
      'User-Agent: Node-to-Proxy/1.0'
    ];
    if (proxy.username) {
      const credential = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      headers.push(`Proxy-Authorization: Basic ${credential}`);
    }
    socket.write(`${headers.join('\r\n')}\r\n\r\n`);

    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf('\r\n\r\n');
      if (index < 0) {
        if (buffer.length > 65536) fail(new Error('上游 CONNECT 响应头过大'));
        return;
      }
      const head = buffer.subarray(0, index).toString('latin1');
      const statusLine = head.split('\r\n')[0];
      const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
      const status = match ? Number(match[1]) : 0;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      if (status >= 200 && status < 300) {
        if (buffer.length > index + 4) socket.unshift(buffer.subarray(index + 4));
        resolve(socket);
      } else {
        socket.destroy();
        fail(new Error(`上游 CONNECT 失败：${statusLine.trim() || '无状态行'}`));
      }
    };
    const onError = error => fail(error);
    function fail(error) {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      reject(error);
    }
    socket.on('data', onData);
  });
}

function socks5ConnectTarget(socket, host, port, proxy) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let state = 'greeting';
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.destroy();
      reject(error);
    };
    const onError = error => fail(error);

    function connectRequest() {
      let address;
      const version = net.isIP(host);
      if (version === 4) {
        address = Buffer.from([0x01, ...host.split('.').map(Number)]);
      } else if (version === 6) {
        return fail(new Error('暂不支持通过 SOCKS5 上游连接 IPv6 目标'));
      } else {
        const encoded = Buffer.from(host, 'utf8');
        if (encoded.length > 255) return fail(new Error('SOCKS5 目标主机名过长'));
        address = Buffer.from([0x03, encoded.length, ...encoded]);
      }
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00]),
        address,
        Buffer.from([(port >> 8) & 0xff, port & 0xff])
      ]));
      state = 'reply';
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (!settled) {
          if (state === 'greeting') {
            if (buffer.length < 2) return;
            if (buffer[0] !== 0x05) throw new Error('上游 SOCKS5 握手版本无效');
            const method = buffer[1];
            buffer = buffer.subarray(2);
            if (method === 0xff) throw new Error('上游 SOCKS5 无可用认证方式');
            if (method === 0x02) {
              const user = Buffer.from(proxy.username || '', 'utf8');
              const pass = Buffer.from(proxy.password || '', 'utf8');
              if (user.length > 255 || pass.length > 255) throw new Error('上游 SOCKS5 用户名或密码过长');
              socket.write(Buffer.from([0x01, user.length, ...user, pass.length, ...pass]));
              state = 'auth';
              continue;
            }
            if (method !== 0x00) throw new Error(`上游 SOCKS5 认证方式不受支持：${method}`);
            connectRequest();
            continue;
          }
          if (state === 'auth') {
            if (buffer.length < 2) return;
            if (buffer[0] !== 0x01 || buffer[1] !== 0x00) throw new Error('上游 SOCKS5 认证失败');
            buffer = buffer.subarray(2);
            connectRequest();
            continue;
          }
          if (state === 'reply') {
            if (buffer.length < 4) return;
            if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
              throw new Error(`上游 SOCKS5 连接失败（错误码 ${buffer[1] ?? 0xff}）`);
            }
            let replyLength;
            if (buffer[3] === 0x01) replyLength = 10;
            else if (buffer[3] === 0x04) replyLength = 22;
            else if (buffer[3] === 0x03) {
              if (buffer.length < 5) return;
              replyLength = 7 + buffer[4];
            } else throw new Error('上游 SOCKS5 响应地址类型无效');
            if (buffer.length < replyLength) return;
            const remaining = buffer.subarray(replyLength);
            settled = true;
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            if (remaining.length) socket.unshift(remaining);
            resolve(socket);
            return;
          }
          return;
        }
      } catch (error) {
        fail(error);
      }
    }

    socket.on('error', onError);
    socket.on('data', onData);
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
  });
}

function connectThroughUpstream(upstream, targetHost, targetPort, method = 'http') {
  if (upstream.type === 'vless') {
    // VLESS 上游无需前置 TCP：拨号器内部完成 DNS → TLS → WS → VLESS 握手
    return vlessConnectTarget(upstream, targetHost, targetPort);
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: upstream.host, port: upstream.port });
    socket.once('error', reject);
    socket.once('connect', async () => {
      try {
        if (upstream.type === 'http') {
          socket.removeListener('error', reject);
          resolve(socket);
        } else if (upstream.type === 'https') {
          const connected = await httpConnectTarget(socket, targetHost, targetPort, upstream);
          resolve(connected);
        } else if (upstream.type === 'socks5') {
          const connected = await socks5ConnectTarget(socket, targetHost, targetPort, upstream);
          resolve(connected);
        } else {
          socket.destroy();
          reject(new Error(`不支持的上游类型：${upstream.type}`));
        }
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

function connectTunnelThroughUpstream(upstream, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    if (upstream.type === 'http') {
      // HTTP 上游：用裸 socket 完成 CONNECT 握手，隧道 socket 不含 HTTP 解析器
      const socket = net.createConnection({ host: upstream.host, port: upstream.port });
      socket.once('error', reject);
      socket.once('connect', () => {
        httpConnectTarget(socket, targetHost, targetPort, upstream)
          .then(resolve)
          .catch(error => {
            socket.destroy();
            reject(error);
          });
      });
      return;
    }
    connectThroughUpstream(upstream, targetHost, targetPort)
      .then(resolve)
      .catch(reject);
  });
}

function pipeTunnel(client, upstream) {
  client.on('error', () => {});
  upstream.on('error', () => {});
  upstream.pipe(client);
  client.pipe(upstream);
  const destroy = () => {
    client.destroy();
    upstream.destroy();
  };
  client.once('close', destroy);
  upstream.once('close', destroy);
}

module.exports = { connectThroughUpstream, connectTunnelThroughUpstream, pipeTunnel };
