/**
 * Local stand-in for the Microsoft identity platform + Graph sendMail, and for Teams/Slack webhooks and the
 * Slack Web API, for development and tests.
 * Microsoft: cloud "Custom endpoints", Authority URL and Graph URL = http://127.0.0.1:4010.
 * Teams:     webhook URL http://127.0.0.1:4010/teams/alerts   (any path; "/gone" → 404)
 * Slack:     webhook URL http://127.0.0.1:4010/slack/alerts, or bot mode with API base
 *            http://127.0.0.1:4010/slack-api and token xoxb-mock (channel "missing" → channel_not_found).
 * Posted chat payloads are printed to stdout.
 *
 * Behaviour is picked from the recipient addresses in the MIME message:
 *   contains "throttle"  → 429 with Retry-After: 2
 *   contains "denied"    → 403 ErrorAccessDenied
 *   anything else        → 202 Accepted
 *
 *   node scripts/mock-graph.ts [port]
 */
import { createServer, type Server } from 'node:http';

export function startMockGraph(port = 4010): Promise<Server & { sent: { sender: string; mime: string }[]; chat: { path: string; body: any }[] }> {
  const sent: { sender: string; mime: string }[] = [];
  const chat: { path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url ?? '/', 'http://x');

    if (req.method === 'POST' && /\/oauth2\/v2\.0\/token$/.test(url.pathname)) {
      const form = new URLSearchParams(body);
      if (form.get('client_secret') === 'wrong') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'mock-token', expires_in: 3600, token_type: 'Bearer' }));
    }

    const m = /^\/v1\.0\/users\/([^/]+)\/sendMail$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      if (req.headers.authorization !== 'Bearer mock-token') { res.writeHead(401); return res.end(); }
      const mime = Buffer.from(body, 'base64').toString();
      const headerBlock = mime.split(/\r?\n\r?\n/)[0] ?? '';
      if (/throttle/i.test(headerBlock)) {
        res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'ApplicationThrottled', message: 'Too many requests' } }));
      }
      if (/denied/i.test(headerBlock)) {
        res.writeHead(403, { 'content-type': 'application/json', 'request-id': 'mock-req-403' });
        return res.end(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } }));
      }
      sent.push({ sender: decodeURIComponent(m[1]!), mime });
      res.writeHead(202, { 'request-id': `mock-${sent.length}` });
      return res.end();
    }

    // Chat webhooks: http://127.0.0.1:<port>/teams/<anything> and /slack/<anything>; "/gone" in the path → 404.
    if (req.method === 'POST' && /^\/(teams|slack)\//.test(url.pathname)) {
      if (url.pathname.includes('/gone')) { res.writeHead(404); return res.end('no_service'); }
      chat.push({ path: url.pathname, body: JSON.parse(body) });
      res.writeHead(url.pathname.startsWith('/teams') ? 202 : 200, { 'content-type': 'text/plain' });
      return res.end(url.pathname.startsWith('/slack') ? 'ok' : '');
    }
    // Slack Web API: base URL http://127.0.0.1:<port>/slack-api, token "xoxb-mock", channel "missing" → channel_not_found.
    if (req.method === 'POST' && url.pathname === '/slack-api/chat.postMessage') {
      const payload = JSON.parse(body) as { channel: string };
      const reply = req.headers.authorization !== 'Bearer xoxb-mock' ? { ok: false, error: 'invalid_auth' }
        : payload.channel === 'missing' ? { ok: false, error: 'channel_not_found' }
        : (chat.push({ path: url.pathname, body: payload }), { ok: true, channel: payload.channel, ts: `${Date.now() / 1000}` });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(reply));
    }

    if (req.method === 'GET' && /^\/v1\.0\/users\//.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: '1', mail: decodeURIComponent(url.pathname.split('/')[3]!) }));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(Object.assign(server, { sent, chat }))));
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 4010);
  const s = await startMockGraph(port);
  console.log(`Mock Microsoft identity + Graph, Teams and Slack on http://127.0.0.1:${port}`);
  let shown = 0;
  setInterval(() => {
    for (; shown < s.chat.length; shown++) console.log(`[chat] ${s.chat[shown]!.path} ${JSON.stringify(s.chat[shown]!.body).slice(0, 300)}`);
  }, 500);
}
