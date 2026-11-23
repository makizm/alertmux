import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from '../config.ts';
import { bus } from '../bus.ts';
import { apiRoutes, type ApiDeps } from './api.ts';
import { AdminAuth } from './auth.ts';
import { HttpError, readJson, resolveStatic, Router, sendJson, serveFile } from './router.ts';

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0]!.trim();
  }
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

function isHttps(req: IncomingMessage, trustProxy: boolean) {
  return (req.socket as { encrypted?: boolean }).encrypted === true || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

/**
 * Server-Sent Events: pushes message status changes, system events and listener status to the admin UI.
 * On reconnect the browser sends Last-Event-ID and missed system events are replayed from the database.
 */
function stream(req: IncomingMessage, res: ServerResponse, deps: ApiDeps, url: URL) {
  const want = new Set((url.searchParams.get('types') ?? 'message,event,status').split(','));
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const send = (type: string, data: unknown, id?: number) => {
    res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const lastId = Number(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId'));
  if (want.has('event') && Number.isInteger(lastId) && lastId > 0) {
    for (const ev of deps.store.listEvents({ afterId: lastId, limit: 500 })) send('event', ev, ev.id);
  }
  const onMessage = (m: unknown) => want.has('message') && send('message', m);
  const onEvent = (e: { id: number }) => want.has('event') && send('event', e, e.id);
  const onStatus = (s: unknown) => want.has('status') && send('status', s);
  bus.on('message', onMessage);
  bus.on('event', onEvent);
  bus.on('status', onStatus);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('message', onMessage);
    bus.off('event', onEvent);
    bus.off('status', onStatus);
  });
}

export function createHttpServer(config: Config, deps: ApiDeps): Server {
  const auth = new AdminAuth(config.secretKey, config.adminPassword);
  const router = new Router();
  apiRoutes(router, deps);
  const publicPages = new Set(['/login', '/login.html', '/app.css', '/favicon.svg', '/logo.svg', '/login.js']);

  return createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = clientIp(req, config.trustProxy);
    const secure = config.cookieSecure === 'always' || (config.cookieSecure === 'auto' && isHttps(req, config.trustProxy));
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, smtp: deps.listener.status.running });

      // ---- login / logout / session ----
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const cookie = auth.login(String(body.password ?? ''), ip);
          res.setHeader('set-cookie', auth.cookie(cookie, secure));
          deps.store.addEvent('info', 'admin.login', `Admin signed in from ${ip}`);
          return sendJson(res, 200, { ok: true });
        } catch (e) {
          deps.store.addEvent('warn', 'admin.login_failed', `Failed admin sign-in from ${ip}`);
          return sendJson(res, 401, { error: (e as Error).message });
        }
      }

      const session = auth.session(req);

      if (url.pathname.startsWith('/api/')) {
        if (!session) return sendJson(res, 401, { error: 'Not signed in' });
        if (url.pathname === '/api/session') return sendJson(res, 200, { csrf: auth.csrfFor(session) });
        if (req.method !== 'GET' && req.method !== 'HEAD' && !auth.checkCsrf(req, session)) {
          return sendJson(res, 403, { error: 'Missing or invalid CSRF token. Reload the page.' });
        }
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          res.setHeader('set-cookie', auth.cookie('', secure, true));
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/stream' && req.method === 'GET') return stream(req, res, deps, url);
        const handled = await router.dispatch({ req, res, url, ip, json: () => readJson(req) });
        if (!handled) sendJson(res, 404, { error: 'Not found' });
        return;
      }

      // ---- static admin UI ----
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      if (!session && !publicPages.has(url.pathname)) {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      const file = resolveStatic(config.publicDir, url.pathname);
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found');
      }
      serveFile(res, file);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, details: e.details });
      console.error('[http]', e);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    }
  });
}
