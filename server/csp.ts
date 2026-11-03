import express, { Router, type RequestHandler } from 'express';

/**
 * Content Security Policy, report-only phase.
 *
 * Astro builds the page policy (astro.config.mjs → security.csp), hashing every inline script, and sends it as a
 * Content-Security-Policy header. Until the reports are clean, that header is renamed to
 * Content-Security-Policy-Report-Only so browsers report violations without blocking anything. The baseline policy
 * set in securityHeaders (images, framing, plugins) is separate and stays enforced.
 *
 * To start enforcing, set CSP_ENFORCE=1: Astro's header is then sent unchanged.
 */
export const REPORT_PATH = '/csp-report';
const ENFORCE = () => process.env.CSP_ENFORCE === '1';

type Headers = Record<string, string | number | string[] | undefined>;
/** Rename a content-security-policy entry in an outgoing headers object, whatever its case. */
export function toReportOnly(headers: Headers) {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'content-security-policy') continue;
    headers['Content-Security-Policy-Report-Only'] = headers[name];
    delete headers[name];
  }
  return headers;
}

/**
 * When enforcing, Astro's content-security-policy entry would replace the baseline header set by securityHeaders
 * (frame-ancestors, the image list). Send both instead: browsers enforce every policy they receive.
 */
export function keepBaseline(headers: Headers, baseline: ReturnType<import('express').Response['getHeader']>) {
  if (typeof baseline !== 'string') return headers;
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() !== 'content-security-policy') continue;
    const page = headers[name];
    headers[name] = [baseline, ...(Array.isArray(page) ? page : page === undefined ? [] : [String(page)])];
  }
  return headers;
}

/** Mount just before the Astro handler, so only Astro's page policy is affected. */
export function pagePolicy(): RequestHandler {
  return (_req, res, next) => {
    // Tells Reporting-API browsers where the policy's `report-to csp` goes; older ones use report-uri.
    res.setHeader('Reporting-Endpoints', `csp="${REPORT_PATH}"`);
    const enforce = ENFORCE();
    // Astro writes its headers through writeHead(status, headers); a header it set directly would come through setHeader.
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => typeof res;
    res.writeHead = ((...args: unknown[]) => {
      const headers = args.find((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a)) as Headers | undefined;
      if (headers) enforce ? keepBaseline(headers, res.getHeader('content-security-policy')) : toReportOnly(headers);
      return writeHead(...args);
    }) as typeof res.writeHead;
    if (enforce) return next();
    const setHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: string | number | readonly string[]) =>
      setHeader(name.toLowerCase() === 'content-security-policy' ? 'Content-Security-Policy-Report-Only' : name, value)) as typeof res.setHeader;
    next();
  };
}

type Violation = { page?: string; directive?: string; blocked?: string; source?: string; line?: number; sample?: string };
/** Path only: query strings and fragments can carry search terms or tokens. */
const path = (url: unknown) => {
  if (typeof url !== 'string' || !url) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url.slice(0, 40); // 'inline', 'eval', 'data', 'blob'…
  try { const u = new URL(url); return `${u.origin}${u.pathname}`.slice(0, 300); } catch { return undefined; }
};
/**
 * Accept every report shape browsers send: report-uri's {"csp-report": {...}}, the Reporting API's [{type, body}]
 * (Chrome), and a single Reporting API object sent as application/csp-report (Safari/WebKit, seen 2026-11-03).
 */
export function violations(body: unknown): Violation[] {
  const legacy = (body as any)?.['csp-report'];
  if (legacy && typeof legacy === 'object') return [{
    page:path(legacy['document-uri']), directive:legacy['effective-directive'] ?? legacy['violated-directive'],
    blocked:path(legacy['blocked-uri']), source:path(legacy['source-file']), line:legacy['line-number'], sample:legacy['script-sample'],
  }];
  const reports = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  return reports.filter(r => r?.type === 'csp-violation' && r.body && typeof r.body === 'object').map(({ body: b }) => ({
    page:path(b.documentURL), directive:b.effectiveDirective, blocked:path(b.blockedURL),
    source:path(b.sourceFile), line:b.lineNumber, sample:b.sample,
  }));
}

// Browsers send reports without credentials or a same-origin Origin, so this lives outside /api and its checks.
// Reports are only logged, never stored, and the log volume per instance is capped.
const PER_MINUTE = 100;
export function reportReceiver() {
  const router = Router();
  let minute = 0, logged = 0;
  router.post(REPORT_PATH, express.json({ type:['application/csp-report','application/reports+json','application/json'], limit:'16kb' }), (req, res) => {
    const now = Math.floor(Date.now() / 60000);
    if (now !== minute) { minute = now; logged = 0; }
    for (const v of violations(req.body).filter(v => v.directive)) {
      if (logged++ >= PER_MINUTE) break;
      const sample = typeof v.sample === 'string' ? v.sample.slice(0, 80) : undefined;
      console.warn(JSON.stringify({ event:'csp.violation', ...v, sample, line:Number(v.line) || undefined }));
    }
    res.status(204).end();
  });
  return router;
}
