import express from 'express';
import compression from 'compression';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clerkMiddleware } from '@clerk/express';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { createFixedProxyMiddleware } from './middlewares/fixedProxy.ts';
import { ZodError } from 'zod';
import { CLERK_PROXY_PATH,clerkProxyMiddleware,getClerkProxyHost } from './middlewares/clerkProxyMiddleware.ts';
import { HttpError } from './accounts.ts';
import { api } from './api.ts';
import { loadCatalogue } from './catalogue.ts';
import { waitForDatabase } from './db.ts';

// Baseline browser protections. Scripts are not restricted by CSP yet: Clerk loads its own.
// Framing is blocked only in production, because Replit's preview pane shows the dev site in a frame.
function securityHeaders(_req: express.Request,res: express.Response,next: express.NextFunction) {
  const production = process.env.NODE_ENV === 'production';
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');
  // Images only from this site and Clerk (member photos, sign-in icons), so no page can make
  // a visitor's browser report to a server someone else chose.
  res.setHeader('Content-Security-Policy',`base-uri 'self'; object-src 'none'; img-src 'self' data: https://img.clerk.com${production ? "; frame-ancestors 'none'" : ''}`);
  if (production) {
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Strict-Transport-Security','max-age=31536000');
  }
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy',1);
  app.use((req,res,next) => {
    const started = process.hrtime.bigint();
    res.once('finish',() => {
      const durationMs = Number(process.hrtime.bigint()-started)/1_000_000;
      if (req.path === '/' && (durationMs >= 1000 || res.statusCode >= 500)) {
        console.log(JSON.stringify({
          event:'http.request.slow_or_failed',
          method:req.method,
          path:req.path,
          statusCode:res.statusCode,
          durationMs:Math.round(durationMs),
        }));
      }
    });
    res.once('close',() => {
      if (!res.writableFinished && req.path === '/') {
        console.warn(JSON.stringify({event:'http.request.aborted',method:req.method,path:req.path}));
      }
    });
    next();
  });
  app.use(securityHeaders);
  app.use(compression());
  app.use(CLERK_PROXY_PATH,clerkProxyMiddleware());
  app.use(express.json({limit:'48kb'}));
  app.use(clerkMiddleware((req) => ({
    publishableKey:publishableKeyFromHost(
      getClerkProxyHost(req) ?? '',
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })));
  app.use('/api',api);
  app.use((error: any,_req: express.Request,res: express.Response,_next: express.NextFunction) => {
    // Too late for a JSON error: close the half-sent response instead of leaving the client hanging.
    if (res.headersSent) { console.error('Request failed mid-response',error.name ?? 'Error',error.code ?? 'unknown'); res.destroy(); return; }
    if (error instanceof HttpError) { res.status(error.status).json({error:error.message}); return; }
    if (error instanceof ZodError) { res.status(400).json({error:error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}); return; }
    if (error.code === '23505') { res.status(409).json({error:'That username or record already exists.'}); return; }
    if (error.type === 'entity.too.large') { res.status(413).json({error:'The submitted content is too large.'}); return; }
    if (error.type === 'entity.parse.failed') { res.status(400).json({error:'Invalid JSON.'}); return; }
    // Never serialize provider exceptions, SQL, tokens, or request payloads.
    console.error('Request failed',error.name ?? 'Error',error.code ?? 'unknown');
    res.status(503).json({error:'The service is temporarily unavailable. Please try again.'});
  });
  return app;
}
export async function attachProductionSite(app: express.Express) {
  // The Astro middleware adapter does not serve its client assets itself.
  // Never let a successful HTML response conceal broken JS/CSS after Publish.
  app.use(express.static(resolve('dist/client'),{
    index:false,
    setHeaders:(res,file) => {
      res.setHeader('Cache-Control',file.includes('/_astro/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
    },
  }));
  const { handler } = await import(pathToFileURL(resolve('dist/server/entry.mjs')).href);
  app.use(handler);
}
export async function start() {
  const app = createApp();
  const startupStarted = process.hrtime.bigint();
  let child: ReturnType<typeof spawn> | undefined;
  let devProxy: ReturnType<typeof createFixedProxyMiddleware> | undefined;
  let stopping = false;
  if (process.env.NODE_ENV === 'production') {
    // Every page reads the catalogue from the database. Load it once before listening, so a cold database is awake
    // and the deploy health check on "/" gets a fast answer. If it is still unreachable, serve anyway and let requests retry.
    await waitForDatabase(loadCatalogue);
    await attachProductionSite(app);
  } else {
    const internalPort = process.env.ASTRO_INTERNAL_PORT ?? '4321';
    child = spawn(process.execPath,['node_modules/astro/bin/astro.mjs','dev','--host','127.0.0.1','--port',internalPort,'--ignore-lock'],{stdio:'inherit'});
    child.on('exit',code => {
      if (!stopping) { console.error('Astro stopped unexpectedly',code); process.exit(1); }
    });
    devProxy = createFixedProxyMiddleware({ target:`http://127.0.0.1:${internalPort}` });
    app.use(devProxy);
  }
  const port = Number(process.env.PORT ?? 5000);
  const server = app.listen(port,'0.0.0.0',() => console.log(JSON.stringify({
    event:'server.ready',
    port,
    mode:process.env.NODE_ENV ?? 'development',
    startupDurationMs:Math.round(Number(process.hrtime.bigint()-startupStarted)/1_000_000),
  })));
  if (devProxy) server.on('upgrade', devProxy.upgrade);
  const stop = () => { stopping=true; child?.kill('SIGTERM'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0),5000).unref(); };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await start();
