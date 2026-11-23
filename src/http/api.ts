import type { DestinationKind, DestinationRecord, RouteRule, Store } from '../db.ts';
import { DESTINATION_KINDS, validateDestination, type DestinationRegistry } from '../destinations/index.ts';
import { SLACK_API_BASES } from '../destinations/chat.ts';
import { GOOGLE_DEFAULTS } from '../destinations/google.ts';
import { MICROSOFT_CLOUDS } from '../destinations/microsoft.ts';
import { buildTextMessage, parseHeaders, splitMessage } from '../relay/mime.ts';
import type { Relay } from '../relay/queue.ts';
import { hashPassword } from '../secrets.ts';
import { mergeSettings, validateSettings } from '../settings.ts';
import type { SmtpListener } from '../smtp/listener.ts';
import { HttpError, Router } from './router.ts';

export interface ApiDeps {
  store: Store;
  registry: DestinationRegistry;
  relay: Relay;
  listener: SmtpListener;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []).map((x) => String(x).trim()).filter(Boolean);
const int = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : fallback; };

/** Destination as shown to the browser: secrets replaced by "is set" flags. */
export function publicDestination(d: DestinationRecord) {
  const secretsSet = Object.fromEntries(DESTINATION_KINDS[d.kind].secretKeys.map((k) => [k, !!d.secrets[k]]));
  return { id: d.id, name: d.name, kind: d.kind, enabled: d.enabled, config: d.config, secretsSet, createdAt: d.createdAt, updatedAt: d.updatedAt };
}

/** Keep only known config fields per destination kind, with types coerced. */
function sanitizeConfig(kind: DestinationKind, c: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'microsoft-graph') {
    return {
      cloud: str(c.cloud) || 'global', authorityUrl: str(c.authorityUrl), graphUrl: str(c.graphUrl),
      tenantId: str(c.tenantId), clientId: str(c.clientId), authMethod: c.authMethod === 'certificate' ? 'certificate' : 'secret',
    };
  }
  if (kind === 'teams-webhook' || kind === 'slack') {
    const common = { includeBody: c.includeBody !== false, maxBodyChars: int(c.maxBodyChars, 4000) };
    if (kind === 'teams-webhook') return common;
    return {
      ...common, method: c.method === 'bot' ? 'bot' : 'webhook', channel: str(c.channel, 200),
      apiBaseUrl: str(c.apiBaseUrl).replace(/\/+$/, '') || 'https://slack.com/api',
    };
  }
  const mode = c.mode === 'xoauth2' ? 'xoauth2' : 'relay';
  return {
    mode, host: str(c.host) || GOOGLE_DEFAULTS[mode].host, port: int(c.port, GOOGLE_DEFAULTS[mode].port),
    security: ['starttls', 'tls', 'none'].includes(String(c.security)) ? c.security : 'starttls',
    relayAuth: c.relayAuth === 'ip' ? 'ip' : 'password', username: str(c.username), ehloName: str(c.ehloName),
  };
}

export function apiRoutes(router: Router, { store, registry, relay, listener }: ApiDeps) {
  // ---- status / stats ----
  router.get('/api/status', () => {
    const lastByDest = store.db.prepare(`SELECT a.destination_id AS id, a.at, a.ok, a.code, a.detail FROM attempts a
      JOIN (SELECT destination_id, MAX(id) AS id FROM attempts GROUP BY destination_id) l ON l.id = a.id`).all() as any[];
    const pending = store.db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('queued','sending','retrying')`).get() as any;
    return {
      listener: listener.status,
      queue: { pending: pending.n as number },
      destinations: store.listDestinations().map((d) => {
        const last = lastByDest.find((l) => l.id === d.id);
        return { id: d.id, name: d.name, kind: d.kind, enabled: d.enabled, last: last ? { at: last.at, ok: !!last.ok, code: last.code, detail: last.detail } : null };
      }),
      stats: { last24h: store.stats(Date.now() - 86400_000), last7d: store.stats(Date.now() - 7 * 86400_000) },
    };
  });

  router.get('/api/meta', () => ({
    destinationKinds: Object.fromEntries(Object.entries(DESTINATION_KINDS).map(([k, v]) => [k, v.label])),
    destinationCategories: Object.fromEntries(Object.entries(DESTINATION_KINDS).map(([k, v]) => [k, v.category])),
    microsoftClouds: MICROSOFT_CLOUDS,
    googleDefaults: GOOGLE_DEFAULTS,
    slackApiBases: SLACK_API_BASES,
  }));

  // ---- settings ----
  router.get('/api/settings', () => store.getSettings());
  router.put('/api/settings', async (ctx) => {
    const body = await ctx.json();
    const current = store.getSettings();
    const next = mergeSettings(current, { ...body, routing: current.routing });
    next.smtp.allowedNetworks = strList(next.smtp.allowedNetworks);
    next.sender.allowed = strList(next.sender.allowed);
    const errors = validateSettings(next);
    if (errors.length) throw new HttpError(400, 'Settings not saved', errors);
    store.saveSettings(next);
    store.addEvent('info', 'settings.changed', 'Settings updated', { ip: ctx.ip });
    await listener.apply(next.smtp);
    return next;
  });

  // ---- destinations ----
  router.get('/api/destinations', () => store.listDestinations().map(publicDestination));
  router.get('/api/destinations/:id', (ctx) => {
    const d = store.getDestination(ctx.params.id!);
    if (!d) throw new HttpError(404, 'Destination not found');
    return publicDestination(d);
  });

  const saveDestination = async (ctx: Parameters<Parameters<Router['post']>[1]>[0], id?: string) => {
    const body = await ctx.json();
    const existing = id ? store.getDestination(id) : undefined;
    if (id && !existing) throw new HttpError(404, 'Destination not found');
    const kind = (existing?.kind ?? body.kind) as DestinationKind;
    if (!(kind in DESTINATION_KINDS)) throw new HttpError(400, 'Unknown destination type');
    const name = str(body.name, 100);
    const config = sanitizeConfig(kind, body.config ?? {});
    const secrets: Record<string, string | null> = {};
    for (const k of DESTINATION_KINDS[kind].secretKeys) {
      const v = body.secrets?.[k];
      if (v === null || typeof v === 'string') secrets[k] = v === null ? null : v.trim();
    }
    const errors = [...(name ? [] : ['Name is required']), ...validateDestination(kind, config, secrets, existing?.secrets ?? {})];
    if (errors.length) throw new HttpError(400, 'Destination not saved', errors);
    const savedId = store.saveDestination({ id, name, kind, enabled: body.enabled !== false, config, secrets });
    // The first destination becomes the default route automatically.
    const s = store.getSettings();
    if (!s.routing.defaultDestinationId) { s.routing.defaultDestinationId = savedId; store.saveSettings(s); }
    store.addEvent('info', 'destination.saved', `Destination "${name}" ${existing ? 'updated' : 'created'}`, { id: savedId });
    return publicDestination(store.getDestination(savedId)!);
  };
  router.post('/api/destinations', (ctx) => saveDestination(ctx));
  router.put('/api/destinations/:id', (ctx) => saveDestination(ctx, ctx.params.id));

  router.delete('/api/destinations/:id', (ctx) => {
    const d = store.getDestination(ctx.params.id!);
    if (!d) throw new HttpError(404, 'Destination not found');
    store.deleteDestination(d.id);
    const s = store.getSettings();
    if (s.routing.defaultDestinationId === d.id) { s.routing.defaultDestinationId = null; store.saveSettings(s); }
    store.replaceRoutes(store.listRoutes().map((r) => ({ ...r, destinationIds: r.destinationIds.filter((x) => x !== d.id) })));
    store.addEvent('info', 'destination.deleted', `Destination "${d.name}" deleted`);
  });

  router.post('/api/destinations/:id/test', async (ctx) => {
    const dest = registry.get(ctx.params.id!);
    if (!dest) throw new HttpError(404, 'Destination not found');
    const body = await ctx.json();
    const result = await dest.test({ address: str(body.address) || undefined });
    store.addEvent(result.ok ? 'info' : 'warn', 'destination.test', `Test of "${dest.record.name}": ${result.detail}`);
    return result;
  });

  // ---- routing ----
  router.get('/api/routes', () => ({ rules: store.listRoutes(), defaultDestinationId: store.getSettings().routing.defaultDestinationId }));
  router.put('/api/routes', async (ctx) => {
    const body = await ctx.json();
    const ids = new Set(store.listDestinations().map((d) => d.id));
    const errors: string[] = [];
    const rules: Omit<RouteRule, 'id'>[] = (Array.isArray(body.rules) ? body.rules : []).map((r: any, i: number) => {
      const destinationIds = strList(r.destinationIds).filter((x) => ids.has(x));
      if (!destinationIds.length) errors.push(`Rule ${i + 1}: choose at least one destination`);
      return {
        name: str(r.name, 100) || `Rule ${i + 1}`, enabled: r.enabled !== false, stop: !!r.stop, destinationIds,
        match: { senders: strList(r.match?.senders), senderDomains: strList(r.match?.senderDomains), recipientDomains: strList(r.match?.recipientDomains) },
      };
    });
    const def = body.defaultDestinationId ? String(body.defaultDestinationId) : null;
    if (def && !ids.has(def)) errors.push('Default destination does not exist');
    if (errors.length) throw new HttpError(400, 'Routing not saved', errors);
    store.replaceRoutes(rules);
    const s = store.getSettings();
    s.routing.defaultDestinationId = def;
    store.saveSettings(s);
    store.addEvent('info', 'routing.changed', `Routing updated (${rules.length} rules)`);
    return { rules: store.listRoutes(), defaultDestinationId: def };
  });

  // ---- relay users ----
  router.get('/api/users', () => store.listRelayUsers());
  router.post('/api/users', async (ctx) => {
    const b = await ctx.json();
    const username = str(b.username, 200);
    const password = typeof b.password === 'string' ? b.password : '';
    if (!/^[\w.@+-]{2,200}$/.test(username)) throw new HttpError(400, 'Username may contain letters, digits and . _ @ + -');
    if (password.length < 12) throw new HttpError(400, 'Password must be at least 12 characters');
    if (store.getRelayUserHash(username)) throw new HttpError(409, 'That username already exists');
    store.addRelayUser(username, hashPassword(password), str(b.note, 200));
    store.addEvent('info', 'user.created', `Relay user "${username}" created`);
    return store.listRelayUsers();
  });
  router.put('/api/users/:id/password', async (ctx) => {
    const b = await ctx.json();
    if (typeof b.password !== 'string' || b.password.length < 12) throw new HttpError(400, 'Password must be at least 12 characters');
    store.setRelayUserPassword(Number(ctx.params.id), hashPassword(b.password));
    store.addEvent('info', 'user.password', `Relay user #${ctx.params.id} password changed`);
  });
  router.delete('/api/users/:id', (ctx) => {
    store.deleteRelayUser(Number(ctx.params.id));
    store.addEvent('info', 'user.deleted', `Relay user #${ctx.params.id} deleted`);
  });

  // ---- messages ----
  router.get('/api/messages', (ctx) => {
    const q = ctx.url.searchParams;
    const date = (v: string | null, endOfDay = false) => (v ? Date.parse(v + (endOfDay ? 'T23:59:59.999' : 'T00:00:00')) || undefined : undefined);
    return store.listMessages({
      status: q.get('status') || undefined, q: q.get('q') || undefined, since: date(q.get('from')), until: date(q.get('to'), true),
      before: q.get('before') || undefined, limit: int(q.get('limit'), 50),
    });
  });
  router.get('/api/messages/:id', (ctx) => {
    const m = store.getMessage(ctx.params.id!);
    if (!m) throw new HttpError(404, 'Message not found');
    const names = Object.fromEntries(store.listDestinations().map((d) => [d.id, d.name]));
    const body = store.readBody(m.id);
    return {
      message: m,
      deliveries: store.listDeliveries(m.id).map((d) => ({ ...d, destinationName: names[d.destinationId] ?? '(deleted)' })),
      attempts: store.listAttempts(m.id).map((a) => ({ ...a, destinationName: names[a.destinationId] ?? '(deleted)' })),
      headers: body ? parseHeaders(splitMessage(body).head) : null,
      bodyStored: !!body,
    };
  });
  router.get('/api/messages/:id/raw', (ctx) => {
    const body = store.readBody(ctx.params.id!);
    if (!body) throw new HttpError(404, 'Message body is not stored');
    ctx.res.writeHead(200, { 'content-type': 'message/rfc822', 'content-disposition': `attachment; filename="${ctx.params.id}.eml"` });
    ctx.res.end(body);
  });
  router.post('/api/messages/:id/retry', (ctx) => {
    const m = store.getMessage(ctx.params.id!);
    if (!m) throw new HttpError(404, 'Message not found');
    if (!store.readBody(m.id)) throw new HttpError(409, 'The message body is no longer stored, so it cannot be retried');
    if (!store.retryMessage(m.id)) throw new HttpError(409, 'Nothing to retry for this message');
    store.addEvent('info', 'message.retry', `Manual retry of ${m.id}`);
    relay.kick();
    return store.getMessage(m.id);
  });
  router.delete('/api/messages/:id', (ctx) => {
    store.deleteMessage(ctx.params.id!);
    store.addEvent('info', 'message.deleted', `Message ${ctx.params.id} deleted`);
  });

  // ---- events ----
  router.get('/api/events', (ctx) => {
    const q = ctx.url.searchParams;
    return store.listEvents({ beforeId: q.get('before') ? int(q.get('before'), 0) : undefined, level: q.get('level') || undefined, q: q.get('q') || undefined, limit: int(q.get('limit'), 100) });
  });

  // ---- test send ----
  router.post('/api/test-send', async (ctx) => {
    const b = await ctx.json();
    const from = str(b.from);
    const to = strList(b.to);
    if (!/^[^@\s]+@[^@\s]+$/.test(from)) throw new HttpError(400, 'Enter a valid From address');
    if (!to.length || !to.every((a) => /^[^@\s]+@[^@\s]+$/.test(a))) throw new HttpError(400, 'Enter valid To addresses');
    const settings = store.getSettings();
    const raw = buildTextMessage({ from, to, subject: str(b.subject) || 'Alertmux test', text: typeof b.text === 'string' ? b.text : 'Test message from the Alertmux admin UI.', hostname: settings.smtp.hostname });
    return relay.accept({ clientIp: ctx.ip, helo: 'admin-ui', authUser: 'admin', mailFrom: from, rcptTo: to, raw });
  });
}
