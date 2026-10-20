import express from 'express';
import cors from 'cors';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clerkMiddleware } from '@clerk/express';
import { publishableKeyFromHost } from '@clerk/shared/keys';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { ZodError } from 'zod';
import { CLERK_PROXY_PATH,clerkProxyMiddleware,getClerkProxyHost } from './middlewares/clerkProxyMiddleware.ts';
import { HttpError } from './accounts.ts';
import { api } from './api.ts';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy',1);
  app.use(CLERK_PROXY_PATH,clerkProxyMiddleware());
  // API calls are same-origin only; Clerk's proxy handles its own transport.
  app.use(cors({credentials:true,origin:false}));
  app.use(express.json({limit:'48kb'}));
  app.use(clerkMiddleware((req) => ({
    publishableKey:publishableKeyFromHost(
      getClerkProxyHost(req) ?? '',
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })));
  app.use('/api',api);
  app.use((error: any,_req: express.Request,res: express.Response,_next: express.NextFunction) => {
    if (res.headersSent) return;
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
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  if (process.env.NODE_ENV === 'production') {
    await attachProductionSite(app);
  } else {
    const internalPort = process.env.ASTRO_INTERNAL_PORT ?? '4321';
    child = spawn(process.execPath,['node_modules/astro/bin/astro.mjs','dev','--host','127.0.0.1','--port',internalPort,'--ignore-lock'],{stdio:'inherit'});
    child.on('exit',code => {
      if (!stopping) { console.error('Astro stopped unexpectedly',code); process.exit(1); }
    });
    app.use(createProxyMiddleware({
      target:`http://127.0.0.1:${internalPort}`,ws:true,
      on:{error:(_error,_req,res) => {
        if ('writeHead' in res && !res.headersSent) { res.writeHead(503,{'Content-Type':'text/plain'}); res.end('FALK Index is starting. Please refresh shortly.'); }
      }},
    }));
  }
  const server = app.listen(Number(process.env.PORT ?? 5000),'0.0.0.0',() => console.log('FALK Index web is listening'));
  const stop = () => { stopping=true; child?.kill('SIGTERM'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0),5000).unref(); };
  process.on('SIGTERM',stop); process.on('SIGINT',stop);
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await start();
