import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createVerify, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SMTPServer } from 'smtp-server';
import type { DestinationRecord } from '../src/db.ts';
import { MicrosoftGraphDestination, MICROSOFT_CLOUDS, type MicrosoftCloud } from '../src/destinations/microsoft.ts';
import { GoogleSmtpDestination } from '../src/destinations/google.ts';

const MIME = Buffer.from('From: a@contoso.com\r\nTo: b@contoso.com\r\nSubject: t\r\n\r\nhi\r\n');

function record(kind: DestinationRecord['kind'], config: Record<string, unknown>, secrets: Record<string, string>): DestinationRecord {
  return { id: 'd1', name: 'test', kind, enabled: true, config, secrets, createdAt: 0, updatedAt: 0 };
}

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { f, calls };
}
const tokenOk = () => new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });

for (const cloud of ['global', 'usgov', 'usgovdod', 'china'] as MicrosoftCloud[]) {
  test(`microsoft ${cloud}: correct authority, scope and Graph endpoint`, async () => {
    const { f, calls } = fakeFetch((url) => (url.includes('/oauth2/') ? tokenOk() : new Response(null, { status: 202 })));
    const d = new MicrosoftGraphDestination(record('microsoft-graph', { cloud, tenantId: 'contoso.onmicrosoft.com', clientId: 'cid', authMethod: 'secret' }, { clientSecret: 's3cret' }), f);
    const r = await d.deliver({ from: 'scanner@contoso.com', to: ['b@contoso.com'] }, MIME);
    assert.equal(r.kind, 'ok');
    const preset = MICROSOFT_CLOUDS[cloud];
    assert.equal(calls[0]!.url, `${preset.authority}/contoso.onmicrosoft.com/oauth2/v2.0/token`);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    assert.equal(form.get('scope'), `${preset.graph}/.default`);
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('client_secret'), 's3cret');
    assert.equal(calls[1]!.url, `${preset.graph}/v1.0/users/scanner%40contoso.com/sendMail`);
    assert.equal(Buffer.from(String(calls[1]!.init.body), 'base64').toString(), MIME.toString());
    assert.equal((calls[1]!.init.headers as Record<string, string>).authorization, 'Bearer tok');
  });
}

test('microsoft: token is cached across deliveries', async () => {
  const { f, calls } = fakeFetch((url) => (url.includes('/oauth2/') ? tokenOk() : new Response(null, { status: 202 })));
  const d = new MicrosoftGraphDestination(record('microsoft-graph', { cloud: 'global', tenantId: 't', clientId: 'c', authMethod: 'secret' }, { clientSecret: 's' }), f);
  await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME);
  await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME);
  assert.equal(calls.filter((c) => c.url.includes('/oauth2/')).length, 1);
});

test('microsoft: 429 → retry with Retry-After, 403 → permanent, 401 → refresh token once', async () => {
  let status = 429;
  const { f, calls } = fakeFetch((url) => {
    if (url.includes('/oauth2/')) return tokenOk();
    if (status === 401) { status = 202; return new Response(null, { status: 401 }); }
    return new Response(status === 202 ? null : JSON.stringify({ error: { code: status === 429 ? 'ApplicationThrottled' : 'ErrorAccessDenied', message: 'nope' } }),
      { status, headers: { 'retry-after': '7' } });
  });
  const d = new MicrosoftGraphDestination(record('microsoft-graph', { cloud: 'global', tenantId: 't', clientId: 'c', authMethod: 'secret' }, { clientSecret: 's' }), f);
  const r429 = await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME);
  assert.deepEqual([r429.kind, (r429 as { retryAfterMs?: number }).retryAfterMs], ['retry', 7000]);
  status = 403;
  const r403 = await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME);
  assert.equal(r403.kind, 'permanent');
  assert.match(r403.detail, /ErrorAccessDenied/);
  status = 401;
  const before = calls.filter((c) => c.url.includes('/oauth2/')).length;
  const r401 = await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME);
  assert.equal(r401.kind, 'ok');
  assert.equal(calls.filter((c) => c.url.includes('/oauth2/')).length, before + 1);
});

test('microsoft: bad client secret is a permanent failure; network error is a retry', async () => {
  const bad = fakeFetch(() => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' }), { status: 401 }));
  const d1 = new MicrosoftGraphDestination(record('microsoft-graph', { cloud: 'global', tenantId: 't', clientId: 'c', authMethod: 'secret' }, { clientSecret: 'x' }), bad.f);
  const r1 = await d1.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME);
  assert.equal(r1.kind, 'permanent');
  assert.match(r1.detail, /AADSTS7000215/);
  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const d2 = new MicrosoftGraphDestination(record('microsoft-graph', { cloud: 'global', tenantId: 't', clientId: 'c', authMethod: 'secret' }, { clientSecret: 'x' }), down);
  assert.equal((await d2.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME)).kind, 'retry');
});

test('microsoft: oversized messages fail permanently without calling Graph', async () => {
  const { f, calls } = fakeFetch(() => tokenOk());
  const d = new MicrosoftGraphDestination(record('microsoft-graph', { cloud: 'global', tenantId: 't', clientId: 'c', authMethod: 'secret' }, { clientSecret: 's' }), f);
  const r = await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, Buffer.alloc(d.maxMessageBytes + 1));
  assert.equal(r.kind, 'permanent');
  assert.equal(calls.length, 0);
});

test('microsoft: certificate credential sends a signed client assertion with thumbprint', async (t) => {
  let pem: { cert: string; key: string };
  try {
    const dir = mkdtempSync(join(tmpdir(), 'cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    pem = { cert: readFileSync(join(dir, 'c.pem'), 'utf8'), key: readFileSync(join(dir, 'k.pem'), 'utf8') };
  } catch {
    return t.skip('openssl not available');
  }
  const { f, calls } = fakeFetch((url) => (url.includes('/oauth2/') ? tokenOk() : new Response(null, { status: 202 })));
  const d = new MicrosoftGraphDestination(record('microsoft-graph', { cloud: 'usgov', tenantId: 't', clientId: 'cid', authMethod: 'certificate' }, { certificatePem: pem.cert, privateKeyPem: pem.key }), f);
  assert.equal((await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME)).kind, 'ok');
  const form = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(form.get('client_secret'), null);
  assert.equal(form.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  const [h, p, s] = form.get('client_assertion')!.split('.');
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
  const cert = new X509Certificate(pem.cert);
  assert.equal(header.alg, 'RS256');
  assert.equal(Buffer.from(header.x5t, 'base64url').toString('hex'), cert.fingerprint.replace(/:/g, '').toLowerCase());
  assert.equal(claims.aud, 'https://login.microsoftonline.us/t/oauth2/v2.0/token');
  assert.equal(claims.iss, 'cid');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(cert.publicKey, Buffer.from(s!, 'base64url')));
});

// ---- Google: run against a local smtp-server ----

async function smtpMock(opts: { authCheck: (a: { method: string; username?: string; password?: string; accessToken?: string }) => boolean; rcptCode?: number }) {
  const received: { from: string; to: string[]; data: string; user: unknown }[] = [];
  const server = new SMTPServer({
    secure: false, authOptional: true, disabledCommands: ['STARTTLS'], authMethods: ['PLAIN', 'LOGIN', 'XOAUTH2'], allowInsecureAuth: true, logger: false,
    onAuth(auth, _s, cb) {
      if (opts.authCheck(auth as never)) return cb(null, { user: auth.username });
      cb(Object.assign(new Error('5.7.8 bad credentials'), { responseCode: 535 }));
    },
    onRcptTo(_a, _s, cb) {
      if (opts.rcptCode) return cb(Object.assign(new Error(`${opts.rcptCode} nope`), { responseCode: opts.rcptCode }));
      cb();
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        received.push({ from: (session.envelope.mailFrom as { address: string }).address, to: session.envelope.rcptTo.map((r) => r.address), data: Buffer.concat(chunks).toString(), user: session.user });
        cb(null, 'OK queued');
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  return { server, port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('google relay: SMTP AUTH with app password, envelope preserved', async () => {
  const m = await smtpMock({ authCheck: (a) => a.username === 'relay@contoso.com' && a.password === 'app-pass' });
  try {
    const d = new GoogleSmtpDestination(record('google-smtp', { mode: 'relay', host: '127.0.0.1', port: m.port, security: 'none', relayAuth: 'password', username: 'relay@contoso.com', ehloName: 'relay.contoso.com' }, { password: 'app-pass' }));
    const r = await d.deliver({ from: 'scanner@contoso.com', to: ['b@contoso.com', 'hidden@contoso.com'] }, MIME);
    assert.equal(r.kind, 'ok');
    assert.deepEqual(m.received[0]!.to, ['b@contoso.com', 'hidden@contoso.com']);
    assert.equal(m.received[0]!.from, 'scanner@contoso.com');
    assert.match(m.received[0]!.data, /Subject: t/);
    assert.equal((await d.test({})).ok, true);
  } finally { await m.close(); }
});

test('google relay: wrong password → permanent; 451 → retry; 550 → permanent', async () => {
  const m = await smtpMock({ authCheck: () => false });
  try {
    const d = new GoogleSmtpDestination(record('google-smtp', { mode: 'relay', host: '127.0.0.1', port: m.port, security: 'none', relayAuth: 'password', username: 'u', ehloName: 'x.example' }, { password: 'bad' }));
    assert.equal((await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME)).kind, 'permanent');
  } finally { await m.close(); }
  for (const [code, kind] of [[451, 'retry'], [550, 'permanent']] as const) {
    const m2 = await smtpMock({ authCheck: () => true, rcptCode: code });
    try {
      const d = new GoogleSmtpDestination(record('google-smtp', { mode: 'relay', host: '127.0.0.1', port: m2.port, security: 'none', relayAuth: 'ip', username: '', ehloName: 'x.example' }, {}));
      const r = await d.deliver({ from: 'a@b.c', to: ['x@y.z'] }, MIME);
      assert.equal(r.kind, kind, `RCPT ${code}: ${r.code} ${r.detail}`);
    } finally { await m2.close(); }
  }
});

test('google xoauth2: service-account JWT grant, then XOAUTH2 as the sender', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = JSON.stringify({ client_email: 'relay@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' });
  const { f, calls } = fakeFetch(() => new Response(JSON.stringify({ access_token: 'ya29.tok', expires_in: 3600 }), { status: 200 }));
  const m = await smtpMock({ authCheck: (a) => a.method === 'XOAUTH2' && a.username === 'scanner@contoso.com' && a.accessToken === 'ya29.tok' });
  try {
    const d = new GoogleSmtpDestination(record('google-smtp', { mode: 'xoauth2', host: '127.0.0.1', port: m.port, security: 'none', relayAuth: 'password', username: '', ehloName: 'x.example' }, { serviceAccountJson: sa }), f);
    const r = await d.deliver({ from: 'scanner@contoso.com', to: ['x@y.z'] }, MIME);
    assert.equal(r.kind, 'ok', r.detail);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, s] = form.get('assertion')!.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    assert.equal(claims.sub, 'scanner@contoso.com');
    assert.equal(claims.scope, 'https://mail.google.com/');
    assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url')));
  } finally { await m.close(); }
});
