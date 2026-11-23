/**
 * End to end: real SMTP listener + admin HTTP API + SSE + queue, delivering to the mock Graph server.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { startMockGraph } from '../scripts/mock-graph.ts';

const rand = () => 20000 + Math.floor(Math.random() * 20000);
const SMTP_PORT = rand();
const MOCK_PORT = SMTP_PORT + 1;
const dataDir = mkdtempSync(join(tmpdir(), 'relay-e2e-'));
const config: Config = {
  dataDir, httpHost: '127.0.0.1', httpPort: 0, smtpPort: SMTP_PORT, adminPassword: 'e2e-password-123',
  secretKey: 'e2e-secret', cookieSecure: 'never', trustProxy: false, publicDir: join(import.meta.dirname, '..', 'public'),
};

let app: ReturnType<typeof createApp>;
let base = '';
let mock: Awaited<ReturnType<typeof startMockGraph>>;
let cookie = '';
let csrf = '';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { cookie, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

function send(o: { from?: string; to: string[]; subject?: string; auth?: { user: string; pass: string } }) {
  const t = nodemailer.createTransport({ host: '127.0.0.1', port: SMTP_PORT, secure: false, ignoreTLS: true, auth: o.auth });
  return t.sendMail({ from: o.from ?? 'scanner@contoso.com', to: o.to, subject: o.subject ?? 'e2e', text: 'hello' })
    .then((i) => ({ ok: true as const, response: i.response }))
    .catch((e) => ({ ok: false as const, code: e.responseCode as number, response: String(e.response ?? e.message) }));
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

before(async () => {
  mock = await startMockGraph(MOCK_PORT);
  app = createApp(config);
  const { httpPort } = await app.start();
  base = `http://127.0.0.1:${httpPort}`;
});

after(async () => {
  await app.stop();
  mock.close();
});

test('admin API requires sign-in, rejects wrong password, and enforces CSRF', async () => {
  assert.equal((await call('GET', '/api/settings')).status, 401);
  assert.equal((await call('GET', '/messages')).status, 302);
  assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  const login = await call('POST', '/api/login', { password: config.adminPassword });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const session = await call('GET', '/api/session');
  csrf = session.json.csrf;
  assert.equal((await call('PUT', '/api/settings', {}, { 'x-csrf-token': 'bad' })).status, 403);
  assert.equal((await call('GET', '/messages')).status, 200);
});

test('no destination yet → 451 temporary rejection', async () => {
  const r = await send({ to: ['a@contoso.com'] });
  assert.equal(r.ok, false);
  assert.equal((r as { code: number }).code, 451);
});

test('create a Microsoft destination (secret never returned) and deliver over SMTP; SSE reports status', async () => {
  const bad = await call('POST', '/api/destinations', { kind: 'microsoft-graph', name: 'x', config: { cloud: 'global' }, secrets: {} });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.details.length >= 3);

  const created = await call('POST', '/api/destinations', {
    kind: 'microsoft-graph', name: 'Mock M365',
    config: { cloud: 'custom', authorityUrl: `http://127.0.0.1:${MOCK_PORT}`, graphUrl: `http://127.0.0.1:${MOCK_PORT}`, tenantId: 'contoso', clientId: 'cid', authMethod: 'secret' },
    secrets: { clientSecret: 'super-secret' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json.secretsSet.clientSecret, true);
  assert.ok(!JSON.stringify(created.json).includes('super-secret'));
  assert.equal((await call('GET', '/api/routes')).json.defaultDestinationId, created.json.id, 'first destination becomes default');
  assert.equal((await call('POST', `/api/destinations/${created.json.id}/test`, {})).json.ok, true);

  // Listen to SSE while sending.
  const ac = new AbortController();
  const sse = await fetch(base + '/api/stream?types=message', { headers: { cookie }, signal: ac.signal });
  const events: any[] = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of sse.body!) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();

  const r = await send({ to: ['alice@contoso.com'], subject: 'Hello e2e' });
  assert.equal(r.ok, true);
  const id = /queued as (\w+)/.exec((r as { response: string }).response)![1]!;
  await waitFor(() => events.some((e) => e.id === id && e.status === 'sent'));
  ac.abort();
  assert.ok(events.some((e) => e.id === id && e.status === 'queued'));
  const sent = mock.sent.at(-1)!;
  assert.equal(sent.sender, 'scanner@contoso.com');
  assert.match(sent.mime, /Subject: Hello e2e/);
  assert.match(sent.mime, /^Received: from .* with ESMTP id /);

  const detail = await call('GET', `/api/messages/${id}`);
  assert.equal(detail.json.message.status, 'sent');
  assert.equal(detail.json.attempts[0].ok, true);
  assert.equal(detail.json.bodyStored, false, 'body deleted after send by default');
});

test('permanent (403) and throttled (429 → retries → failed) deliveries, then manual retry', async () => {
  await call('PUT', '/api/settings', { delivery: { maxAttempts: 2, retryBaseSeconds: 1, retryMaxSeconds: 1, concurrency: 4 } });
  const denied = await send({ to: ['denied@contoso.com'] });
  const throttled = await send({ to: ['throttle@contoso.com'] });
  const idOf = (r: any) => /queued as (\w+)/.exec(r.response)![1]!;
  const dId = idOf(denied);
  const tId = idOf(throttled);
  await waitFor(() => app.store.getMessage(dId)?.status === 'failed');
  assert.match(app.store.getMessage(dId)!.lastError!, /ErrorAccessDenied/);
  assert.equal(app.store.getMessage(dId)!.attempts, 1, '403 is not retried');
  await waitFor(() => app.store.getMessage(tId)?.status === 'failed', 10_000);
  assert.equal(app.store.getMessage(tId)!.attempts, 2);

  const retry = await call('POST', `/api/messages/${tId}/retry`);
  assert.equal(retry.status, 200);
  await waitFor(() => app.store.getMessage(tId)?.status === 'failed' && app.store.getMessage(tId)!.attempts === 2 && app.store.listAttempts(tId).length === 4, 10_000);
});

test('sender allow-list → 550; settings change restarts listener; AUTH required → 530, relay user works', async () => {
  let s = await call('PUT', '/api/settings', { sender: { allowed: ['@contoso.com'] } });
  assert.equal(s.status, 200);
  const r = await send({ from: 'evil@elsewhere.com', to: ['a@contoso.com'] });
  assert.equal((r as { code: number }).code, 550);
  const rejected = (await call('GET', '/api/messages?status=rejected')).json;
  assert.ok(rejected.some((m: any) => m.mailFrom === 'evil@elsewhere.com'));

  assert.equal((await call('POST', '/api/users', { username: 'printer', password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/users', { username: 'printer', password: 'long-enough-password' })).status, 200);
  s = await call('PUT', '/api/settings', { smtp: { requireAuth: true } });
  assert.equal(s.status, 200);
  assert.equal(app.listener.status.running, true);
  assert.equal((await send({ to: ['a@contoso.com'] }) as { code: number }).code, 530);
  assert.equal((await send({ to: ['a@contoso.com'], auth: { user: 'printer', pass: 'wrong-password-xx' } }) as { code: number }).code, 535);
  const ok = await send({ to: ['a@contoso.com'], auth: { user: 'printer', pass: 'long-enough-password' } });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  s = await call('PUT', '/api/settings', { smtp: { allowedNetworks: ['10.99.0.0/16'] } });
  assert.equal(s.status, 200);
  const blocked = await send({ to: ['a@contoso.com'], auth: { user: 'printer', pass: 'long-enough-password' } });
  assert.equal(blocked.ok, false);
  assert.match((blocked as { response: string }).response, /not allowed/);
  await call('PUT', '/api/settings', { smtp: { allowedNetworks: ['127.0.0.0/8'], requireAuth: false } });
});

test('invalid settings are refused with field errors', async () => {
  const r = await call('PUT', '/api/settings', { smtp: { port: 70000, allowedNetworks: ['nope'] } });
  assert.equal(r.status, 400);
  assert.equal(r.json.details.length, 2);
});

test('routing fan-out: one email → Microsoft 365 + Teams + Slack bot, each tracked separately', async () => {
  const mk = async (body: unknown) => {
    const r = await call('POST', '/api/destinations', body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!JSON.stringify(r.json).match(/xoxb-mock|\/teams\/ops/), 'secrets never returned');
    return r.json.id as string;
  };
  const teams = await mk({ kind: 'teams-webhook', name: 'Mock Teams', config: { includeBody: true, maxBodyChars: 500 }, secrets: { webhookUrl: `http://127.0.0.1:${MOCK_PORT}/teams/ops` } });
  const slack = await mk({ kind: 'slack', name: 'Mock Slack', config: { method: 'bot', channel: 'C0ALERTS', apiBaseUrl: `http://127.0.0.1:${MOCK_PORT}/slack-api`, includeBody: true, maxBodyChars: 500 }, secrets: { botToken: 'xoxb-mock' } });
  const badSlack = await call('POST', '/api/destinations', { kind: 'slack', name: 'x', config: { method: 'bot' }, secrets: { botToken: 'bad' } });
  assert.equal(badSlack.status, 400);

  assert.equal((await call('POST', `/api/destinations/${teams}/test`, {})).json.ok, true);
  assert.equal((await call('POST', `/api/destinations/${slack}/test`, {})).json.ok, true);

  const m365 = (await call('GET', '/api/routes')).json.defaultDestinationId;
  const routes = await call('PUT', '/api/routes', {
    defaultDestinationId: m365,
    rules: [{ name: 'UPS alerts', match: { senders: ['ups3@contoso.com'] }, destinationIds: [m365, teams, slack], stop: true }],
  });
  assert.equal(routes.status, 200, JSON.stringify(routes.json));

  const before = mock.chat.length;
  const r = await send({ from: 'ups3@contoso.com', to: ['ops@contoso.com'], subject: 'Battery low on UPS 3' });
  assert.equal(r.ok, true);
  const id = /queued as (\w+)/.exec((r as { response: string }).response)![1]!;
  await waitFor(() => app.store.getMessage(id)?.status === 'sent');
  const ds = app.store.listDeliveries(id);
  assert.deepEqual(ds.map((d) => d.destinationId).sort(), [m365, teams, slack].sort());
  assert.ok(ds.every((d) => d.status === 'sent'));

  const posted = mock.chat.slice(before);
  const card = posted.find((p) => p.path === '/teams/ops')!;
  assert.match(JSON.stringify(card.body), /Battery low on UPS 3/);
  const bot = posted.find((p) => p.path === '/slack-api/chat.postMessage')!;
  assert.equal(bot.body.channel, 'C0ALERTS');
  assert.match(bot.body.text, /Battery low on UPS 3/);

  // A sender not matching the rule goes only to the default destination.
  const other = await send({ to: ['a@contoso.com'], subject: 'Normal mail' });
  const otherId = /queued as (\w+)/.exec((other as { response: string }).response)![1]!;
  await waitFor(() => app.store.getMessage(otherId)?.status === 'sent');
  assert.deepEqual(app.store.listDeliveries(otherId).map((d) => d.destinationId), [m365]);

  // One destination failing permanently while others succeed → "partial".
  await call('PUT', `/api/destinations/${slack}`, { name: 'Mock Slack', config: { method: 'bot', channel: 'missing', apiBaseUrl: `http://127.0.0.1:${MOCK_PORT}/slack-api`, includeBody: true, maxBodyChars: 500 }, secrets: {} });
  const p = await send({ from: 'ups3@contoso.com', to: ['ops@contoso.com'], subject: 'Partial' });
  const pId = /queued as (\w+)/.exec((p as { response: string }).response)![1]!;
  await waitFor(() => app.store.getMessage(pId)?.status === 'partial');
  assert.match(app.store.getMessage(pId)!.lastError!, /channel_not_found/);

  await call('PUT', '/api/routes', { defaultDestinationId: m365, rules: [] });
});

test('queue resumes deliveries interrupted by a crash', async () => {
  const id = 'zzresume0001';
  const dest = app.store.listDestinations()[0]!.id;
  app.store.insertMessage({
    id, clientIp: '127.0.0.1', helo: 'x', authUser: null, mailFrom: 'scanner@contoso.com', sendAs: 'scanner@contoso.com', rcptTo: ['a@contoso.com'],
    headerFrom: '', subject: 'resume', messageId: '', size: 10, status: 'queued', destinations: [dest], lastError: null,
  }, Buffer.from('Subject: resume\r\nTo: a@contoso.com\r\n\r\nhi\r\n'));
  app.store.db.prepare(`UPDATE deliveries SET status = 'sending' WHERE message_id = ?`).run(id);
  app.store.resetSending();
  app.relay.kick();
  await waitFor(() => app.store.getMessage(id)?.status === 'sent');
});
