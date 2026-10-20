import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createFixedProxyMiddleware } from '../server/middlewares/fixedProxy.ts';

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('fixed proxy preserves mounted paths, query strings, binary POST bodies and response headers', { timeout: 5000 }, async () => {
  const body = Buffer.from([0, 255, 128, 123, 125]);
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    assert.equal(req.url, '/v1/client?key=a%2Fb');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-proxy-test'], 'forwarded');
    assert.equal(req.headers.host, new URL(target).host);
    assert.deepEqual(Buffer.concat(chunks), body);
    res.writeHead(201, {
      'content-type': 'application/octet-stream',
      'set-cookie': ['first=one; HttpOnly', 'second=two; Secure'],
    });
    res.end(body);
  });
  const target = await listen(upstream);
  const app = express();
  const proxy = createFixedProxyMiddleware({
    target, changeOrigin: true,
    on: { proxyReq: req => req.setHeader('x-proxy-test', 'forwarded') },
  });
  app.use('/api/__clerk', proxy);
  const frontend = createServer(app);
  try {
    const origin = await listen(frontend);
    const response = await fetch(`${origin}/api/__clerk/v1/client?key=a%2Fb`, { method: 'POST', body });
    assert.equal(response.status, 201);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    assert.deepEqual(response.headers.getSetCookie(), ['first=one; HttpOnly', 'second=two; Secure']);
  } finally { await close(frontend); await close(upstream); }
});

test('fixed proxy supports response interception and explicit content lengths', { timeout: 5000 }, async () => {
  const upstream = createServer((_req, res) => { res.write('first'); res.end('second'); });
  const target = await listen(upstream);
  const proxy = createFixedProxyMiddleware({
    target, selfHandleResponse: true,
    on: { proxyRes: (incoming, _req, res) => {
      const chunks: Buffer[] = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'content-length': body.length });
        res.end(body);
      });
    } },
  });
  const frontend = createServer(express().use(proxy));
  try {
    const origin = await listen(frontend);
    const response = await fetch(origin);
    assert.equal(response.headers.get('content-length'), '11');
    assert.equal(response.headers.get('transfer-encoding'), null);
    assert.equal(await response.text(), 'firstsecond');
  } finally { await close(frontend); await close(upstream); }
});

test('unavailable upstream returns a safe 503 without connection details', { timeout: 5000 }, async () => {
  const upstream = createServer();
  const target = await listen(upstream);
  await close(upstream);
  const frontend = createServer(express().use(createFixedProxyMiddleware({ target })));
  try {
    const origin = await listen(frontend);
    const response = await fetch(origin);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.equal(body, 'The upstream service is temporarily unavailable.');
    assert.doesNotMatch(body, /127\.0\.0\.1|ECONNREFUSED|Error:/);
  } finally { await close(frontend); }
});

test('WebSocket upgrades work before any HTTP request, preserving the Vite protocol and path', { timeout: 5000 }, async () => {
  const upstream = createServer();
  upstream.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/socket?token=test');
    assert.equal(req.headers['sec-websocket-protocol'], 'vite-hmr');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n');
    socket.on('end', () => socket.end());
  });
  const target = await listen(upstream);
  const proxy = createFixedProxyMiddleware({ target });
  const frontend = createServer(express().use(proxy));
  frontend.on('upgrade', proxy.upgrade);
  try {
    const origin = await listen(frontend);
    await new Promise<void>((resolve, reject) => {
      const req = request(`${origin}/socket?token=test`, {
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-protocol': 'vite-hmr' },
      });
      req.on('error', reject);
      req.on('response', res => { res.resume(); reject(new Error(`Expected upgrade, got ${res.statusCode}`)); });
      req.on('upgrade', (res, socket) => {
        assert.equal(res.statusCode, 101);
        assert.equal(res.headers['sec-websocket-protocol'], 'vite-hmr');
        socket.end();
        resolve();
      });
      req.end();
    });
  } finally { await close(frontend); await close(upstream); }
});
