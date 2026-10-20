import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { RequestHandler } from 'express';
import { createProxyServer, type ProxyServerEventMap, type ProxyServerOptions } from 'httpxy';

type ProxyHooks = {
  [K in 'proxyReq' | 'proxyRes']?: (...args: ProxyServerEventMap[K]) => void;
};
type FixedProxyOptions = ProxyServerOptions & {
  target: string;
  pathRewrite?: (path: string) => string;
  on?: ProxyHooks;
};

/**
 * Fixed-target streaming proxy. No glob/path-pattern matching is needed here:
 * Express owns routing, so using httpxy directly avoids micromatch/braces.
 */
export function createFixedProxyMiddleware(options: FixedProxyOptions) {
  const { pathRewrite, on, ...upstream } = options;
  const proxy = createProxyServer(upstream);
  if (on?.proxyReq) proxy.on('proxyReq', on.proxyReq);
  if (on?.proxyRes) proxy.on('proxyRes', on.proxyRes);

  function fail(res: ServerResponse | Socket) {
    if (res.destroyed || res.writableEnded) return;
    if ('writeHead' in res) {
      if (res.headersSent) { res.destroy(); return; }
      const body = 'The upstream service is temporarily unavailable.';
      res.writeHead(503, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    } else {
      res.destroy();
    }
  }
  // httpxy can emit errors or reject the forwarding promise. Handle both
  // without exposing upstream URLs, request headers, or authentication secrets.
  proxy.on('error', (_error, _req, res) => { if (res) fail(res); });
  const middleware: RequestHandler = async (req, res) => {
    if (pathRewrite) req.url = pathRewrite(req.url);
    try { await proxy.web(req, res); }
    catch { fail(res); }
  };
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathRewrite && req.url) req.url = pathRewrite(req.url);
    void proxy.ws(req, socket as Socket, upstream, head).catch(() => socket.destroy());
  };
  return Object.assign(middleware, { upgrade });
}
