import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { SecretBox } from './secrets.ts';
import { defaultSettings, mergeSettings, type Settings } from './settings.ts';
import { bus } from './bus.ts';

export type DestinationKind = 'microsoft-graph' | 'google-smtp' | 'teams-webhook' | 'slack';

export interface DestinationRecord {
  id: string;
  name: string;
  kind: DestinationKind;
  enabled: boolean;
  config: Record<string, unknown>;
  /** Secret values (decrypted). Never sent to the browser. */
  secrets: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface RouteMatch {
  senders: string[];
  senderDomains: string[];
  recipientDomains: string[];
}

export interface RouteRule {
  id: number;
  name: string;
  enabled: boolean;
  match: RouteMatch;
  destinationIds: string[];
  stop: boolean;
}

export type DeliveryStatus = 'queued' | 'sending' | 'retrying' | 'sent' | 'failed';
export type MessageStatus = DeliveryStatus | 'partial' | 'rejected';

export interface MessageRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  clientIp: string;
  helo: string;
  authUser: string | null;
  mailFrom: string;
  /** Mailbox the message is delivered as (MAIL FROM, or the fixed sender). */
  sendAs: string;
  rcptTo: string[];
  headerFrom: string;
  subject: string;
  messageId: string;
  size: number;
  status: MessageStatus;
  attempts: number;
  lastError: string | null;
  destinations: string[];
}

export interface DeliveryRow {
  messageId: string;
  destinationId: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  upstreamId: string | null;
}

export interface AttemptRow {
  id: number;
  messageId: string;
  destinationId: string;
  at: number;
  ok: boolean;
  code: string;
  detail: string;
  durationMs: number;
}

export interface EventRow {
  id: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  data: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS destinations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL, secrets TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, position INTEGER NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
  match TEXT NOT NULL, destination_ids TEXT NOT NULL, stop INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS relay_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, client_ip TEXT NOT NULL,
  helo TEXT NOT NULL, auth_user TEXT, mail_from TEXT NOT NULL, send_as TEXT NOT NULL DEFAULT '', rcpt_to TEXT NOT NULL, header_from TEXT NOT NULL,
  subject TEXT NOT NULL, message_id TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, destinations TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_status ON messages(status);
CREATE TABLE IF NOT EXISTS deliveries (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, destination_id TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
  last_error TEXT, upstream_id TEXT, PRIMARY KEY (message_id, destination_id));
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL,
  duration_ms INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_message ON attempts(message_id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, type TEXT NOT NULL,
  message TEXT NOT NULL, data TEXT);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
`;

type Row = Record<string, any>;
const json = <T>(v: unknown, fallback: T): T => {
  try { return v == null ? fallback : (JSON.parse(String(v)) as T); } catch { return fallback; }
};

export function newMessageId(): string {
  return Date.now().toString(36).padStart(9, '0') + randomBytes(5).toString('hex');
}

/** All persistence. Raw message bodies live in DATA_DIR/spool/<id>.eml; everything else in SQLite. */
export class Store {
  readonly db: DatabaseSync;
  readonly #spoolDir: string;
  readonly #box: SecretBox;
  readonly #defaultPort: number;

  constructor(dataDir: string, box: SecretBox, defaultSmtpPort: number, filename = 'relay.db') {
    this.db = new DatabaseSync(filename === ':memory:' ? ':memory:' : join(dataDir, filename));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.#spoolDir = join(dataDir, 'spool');
    mkdirSync(this.#spoolDir, { recursive: true });
    this.#box = box;
    this.#defaultPort = defaultSmtpPort;
  }

  close() { this.db.close(); }

  // ---- settings ----
  getSettings(): Settings {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get('settings') as Row | undefined;
    return mergeSettings(defaultSettings(this.#defaultPort), json(row?.value, {}));
  }

  saveSettings(s: Settings) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('settings', JSON.stringify(s));
  }

  // ---- destinations ----
  #toDestination(r: Row): DestinationRecord {
    const enc = json<Record<string, string>>(r.secrets, {});
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(enc)) {
      try { secrets[k] = this.#box.decrypt(v); } catch { /* wrong SECRET_KEY: treat as unset */ }
    }
    return {
      id: r.id, name: r.name, kind: r.kind, enabled: !!r.enabled, config: json(r.config, {}), secrets,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  listDestinations(): DestinationRecord[] {
    return (this.db.prepare('SELECT * FROM destinations ORDER BY name').all() as Row[]).map((r) => this.#toDestination(r));
  }

  getDestination(id: string): DestinationRecord | undefined {
    const r = this.db.prepare('SELECT * FROM destinations WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#toDestination(r) : undefined;
  }

  /**
   * Insert or update. `secrets` entries: a string sets the value, null clears it, and a missing key keeps the
   * stored value (the UI never receives secrets, so an empty field means "unchanged").
   */
  saveDestination(d: { id?: string; name: string; kind: DestinationKind; enabled: boolean; config: Record<string, unknown>; secrets: Record<string, string | null> }): string {
    const now = Date.now();
    const existing = d.id ? this.getDestination(d.id) : undefined;
    const merged: Record<string, string> = { ...(existing?.secrets ?? {}) };
    for (const [k, v] of Object.entries(d.secrets)) {
      if (v === null) delete merged[k];
      else if (v !== '') merged[k] = v;
    }
    const enc = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, this.#box.encrypt(v)]));
    if (existing) {
      this.db.prepare('UPDATE destinations SET name=?, kind=?, enabled=?, config=?, secrets=?, updated_at=? WHERE id=?')
        .run(d.name, d.kind, d.enabled ? 1 : 0, JSON.stringify(d.config), JSON.stringify(enc), now, existing.id);
      return existing.id;
    }
    const id = d.id ?? randomUUID();
    this.db.prepare('INSERT INTO destinations (id, name, kind, enabled, config, secrets, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, d.name, d.kind, d.enabled ? 1 : 0, JSON.stringify(d.config), JSON.stringify(enc), now, now);
    return id;
  }

  deleteDestination(id: string) {
    this.db.prepare('DELETE FROM destinations WHERE id = ?').run(id);
  }

  // ---- routes ----
  listRoutes(): RouteRule[] {
    return (this.db.prepare('SELECT * FROM routes ORDER BY position, id').all() as Row[]).map((r) => ({
      id: r.id, name: r.name, enabled: !!r.enabled,
      match: { senders: [], senderDomains: [], recipientDomains: [], ...json<Partial<RouteMatch>>(r.match, {}) },
      destinationIds: json(r.destination_ids, []), stop: !!r.stop,
    }));
  }

  /** Replace the whole ordered rule list (the UI edits it as one table). */
  replaceRoutes(rules: Omit<RouteRule, 'id'>[]) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM routes');
      const ins = this.db.prepare('INSERT INTO routes (position, name, enabled, match, destination_ids, stop) VALUES (?,?,?,?,?,?)');
      rules.forEach((r, i) => ins.run(i, r.name, r.enabled ? 1 : 0, JSON.stringify(r.match), JSON.stringify(r.destinationIds), r.stop ? 1 : 0));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- relay users ----
  listRelayUsers() {
    return (this.db.prepare('SELECT id, username, note, created_at, last_used_at FROM relay_users ORDER BY username').all() as Row[])
      .map((r) => ({ id: r.id as number, username: r.username as string, note: r.note as string, createdAt: r.created_at as number, lastUsedAt: r.last_used_at as number | null }));
  }

  getRelayUserHash(username: string): { id: number; hash: string } | undefined {
    const r = this.db.prepare('SELECT id, password_hash FROM relay_users WHERE username = ?').get(username) as Row | undefined;
    return r ? { id: r.id, hash: r.password_hash } : undefined;
  }

  addRelayUser(username: string, passwordHash: string, note: string) {
    this.db.prepare('INSERT INTO relay_users (username, password_hash, note, created_at) VALUES (?,?,?,?)').run(username, passwordHash, note, Date.now());
  }

  setRelayUserPassword(id: number, passwordHash: string) {
    this.db.prepare('UPDATE relay_users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  touchRelayUser(id: number) {
    this.db.prepare('UPDATE relay_users SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteRelayUser(id: number) {
    this.db.prepare('DELETE FROM relay_users WHERE id = ?').run(id);
  }

  // ---- messages ----
  #toMessage(r: Row): MessageRow {
    return {
      id: r.id, createdAt: r.created_at, updatedAt: r.updated_at, clientIp: r.client_ip, helo: r.helo, authUser: r.auth_user,
      mailFrom: r.mail_from, sendAs: r.send_as, rcptTo: json(r.rcpt_to, []), headerFrom: r.header_from, subject: r.subject, messageId: r.message_id,
      size: r.size, status: r.status, attempts: r.attempts, lastError: r.last_error, destinations: json(r.destinations, []),
    };
  }

  spoolPath(id: string) { return join(this.#spoolDir, `${id}.eml`); }

  readBody(id: string): Buffer | null {
    try { return readFileSync(this.spoolPath(id)); } catch { return null; }
  }

  deleteBody(id: string) { rmSync(this.spoolPath(id), { force: true }); }

  /** Store an accepted message with one queued delivery per destination. */
  insertMessage(m: Omit<MessageRow, 'createdAt' | 'updatedAt' | 'attempts'>, body: Buffer | null): MessageRow {
    const now = Date.now();
    if (body) writeFileSync(this.spoolPath(m.id), body, { mode: 0o600 });
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO messages (id, created_at, updated_at, client_ip, helo, auth_user, mail_from, send_as, rcpt_to, header_from,
        subject, message_id, size, status, destinations, last_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(m.id, now, now, m.clientIp, m.helo, m.authUser, m.mailFrom, m.sendAs, JSON.stringify(m.rcptTo), m.headerFrom, m.subject,
          m.messageId, m.size, m.status, JSON.stringify(m.destinations), m.lastError);
      const ins = this.db.prepare('INSERT INTO deliveries (message_id, destination_id, status, next_attempt_at) VALUES (?,?,?,?)');
      if (m.status === 'queued') for (const d of m.destinations) ins.run(m.id, d, 'queued', now);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      if (body) this.deleteBody(m.id);
      throw e;
    }
    const row = this.getMessage(m.id)!;
    bus.emit('message', row);
    return row;
  }

  getMessage(id: string): MessageRow | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? this.#toMessage(r) : undefined;
  }

  listMessages(f: { status?: string; q?: string; since?: number; until?: number; before?: string; limit?: number }): MessageRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.status) { where.push('status = ?'); params.push(f.status); }
    if (f.q) {
      const like = `%${f.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      where.push(`(mail_from LIKE ? ESCAPE '\\' OR rcpt_to LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' OR client_ip LIKE ? ESCAPE '\\' OR id = ? OR message_id LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, f.q, like);
    }
    if (f.since) { where.push('created_at >= ?'); params.push(f.since); }
    if (f.until) { where.push('created_at <= ?'); params.push(f.until); }
    if (f.before) { where.push('id < ?'); params.push(f.before); }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
    const sql = `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.#toMessage(r));
  }

  deleteMessage(id: string) {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    this.deleteBody(id);
  }

  listDeliveries(messageId: string): DeliveryRow[] {
    return (this.db.prepare('SELECT * FROM deliveries WHERE message_id = ?').all(messageId) as Row[]).map((r) => ({
      messageId: r.message_id, destinationId: r.destination_id, status: r.status, attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at, lastError: r.last_error, upstreamId: r.upstream_id,
    }));
  }

  listAttempts(messageId: string): AttemptRow[] {
    return (this.db.prepare('SELECT * FROM attempts WHERE message_id = ? ORDER BY id').all(messageId) as Row[]).map((r) => ({
      id: r.id, messageId: r.message_id, destinationId: r.destination_id, at: r.at, ok: !!r.ok, code: r.code, detail: r.detail, durationMs: r.duration_ms,
    }));
  }

  /** Atomically claim due deliveries (queued/retrying → sending). */
  claimDue(limit: number): DeliveryRow[] {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = (this.db.prepare(`SELECT * FROM deliveries WHERE status IN ('queued','retrying') AND next_attempt_at <= ?
        ORDER BY next_attempt_at LIMIT ?`).all(now, limit) as Row[]);
      const upd = this.db.prepare(`UPDATE deliveries SET status = 'sending' WHERE message_id = ? AND destination_id = ?`);
      for (const r of rows) upd.run(r.message_id, r.destination_id);
      this.db.exec('COMMIT');
      const touched = new Set(rows.map((r) => r.message_id as string));
      for (const id of touched) this.refreshMessageStatus(id);
      return rows.map((r) => ({ messageId: r.message_id, destinationId: r.destination_id, status: 'sending', attempts: r.attempts,
        nextAttemptAt: r.next_attempt_at, lastError: r.last_error, upstreamId: r.upstream_id }));
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** After a crash, deliveries stuck in "sending" are put back in the queue. */
  resetSending() {
    const ids = (this.db.prepare(`SELECT DISTINCT message_id FROM deliveries WHERE status = 'sending'`).all() as Row[]).map((r) => r.message_id as string);
    this.db.prepare(`UPDATE deliveries SET status = 'retrying', next_attempt_at = ? WHERE status = 'sending'`).run(Date.now());
    for (const id of ids) this.refreshMessageStatus(id);
  }

  recordAttempt(a: Omit<AttemptRow, 'id'>, next: { status: DeliveryStatus; nextAttemptAt: number; lastError: string | null; upstreamId?: string | null }) {
    this.db.prepare('INSERT INTO attempts (message_id, destination_id, at, ok, code, detail, duration_ms) VALUES (?,?,?,?,?,?,?)')
      .run(a.messageId, a.destinationId, a.at, a.ok ? 1 : 0, a.code, a.detail.slice(0, 4000), a.durationMs);
    this.db.prepare(`UPDATE deliveries SET status = ?, attempts = attempts + 1, next_attempt_at = ?, last_error = ?, upstream_id = COALESCE(?, upstream_id)
      WHERE message_id = ? AND destination_id = ?`)
      .run(next.status, next.nextAttemptAt, next.lastError, next.upstreamId ?? null, a.messageId, a.destinationId);
    return this.refreshMessageStatus(a.messageId);
  }

  /** Re-queue failed (or all unfinished) deliveries of a message for one more round of attempts. */
  retryMessage(id: string): boolean {
    const res = this.db.prepare(`UPDATE deliveries SET status = 'queued', attempts = 0, next_attempt_at = ?
      WHERE message_id = ? AND status IN ('failed','retrying')`).run(Date.now(), id);
    this.refreshMessageStatus(id);
    return Number(res.changes) > 0;
  }

  /** Recompute the message's overall status from its deliveries and broadcast it. */
  refreshMessageStatus(id: string): MessageRow | undefined {
    const ds = this.listDeliveries(id);
    if (ds.length) {
      const has = (s: DeliveryStatus) => ds.some((d) => d.status === s);
      const attempts = ds.reduce((n, d) => n + d.attempts, 0);
      let status: MessageStatus;
      if (has('sending')) status = 'sending';
      else if (has('retrying') || has('queued')) status = attempts > 0 ? 'retrying' : 'queued';
      else if (ds.every((d) => d.status === 'sent')) status = 'sent';
      else if (ds.every((d) => d.status === 'failed')) status = 'failed';
      else status = 'partial';
      const lastError = ds.map((d) => d.lastError).filter(Boolean).join(' | ') || null;
      this.db.prepare('UPDATE messages SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(status, attempts, status === 'sent' ? null : lastError, Date.now(), id);
    }
    const row = this.getMessage(id);
    if (row) bus.emit('message', row);
    return row;
  }

  stats(since: number) {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY status').all(since) as Row[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n as number])) as Record<string, number>;
  }

  // ---- events ----
  addEvent(level: EventRow['level'], type: string, message: string, data?: unknown): EventRow {
    const at = Date.now();
    const res = this.db.prepare('INSERT INTO events (at, level, type, message, data) VALUES (?,?,?,?,?)')
      .run(at, level, type, message, data === undefined ? null : JSON.stringify(data));
    const ev: EventRow = { id: Number(res.lastInsertRowid), at, level, type, message, data: data ?? null };
    bus.emit('event', ev);
    return ev;
  }

  listEvents(f: { afterId?: number; beforeId?: number; level?: string; q?: string; limit?: number }): EventRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.afterId !== undefined) { where.push('id > ?'); params.push(f.afterId); }
    if (f.beforeId !== undefined) { where.push('id < ?'); params.push(f.beforeId); }
    if (f.level) { where.push('level = ?'); params.push(f.level); }
    if (f.q) { where.push('(message LIKE ? OR type LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
    const order = f.afterId !== undefined ? 'ASC' : 'DESC';
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ${order} LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({ id: r.id, at: r.at, level: r.level, type: r.type, message: r.message, data: json(r.data, null) }));
  }

  /** Delete old rows and spool files according to retention settings. */
  purge(s: Settings) {
    const msgCutoff = Date.now() - s.retention.messagesDays * 86400_000;
    const old = this.db.prepare(`SELECT id FROM messages WHERE created_at < ? AND status NOT IN ('queued','sending','retrying')`).all(msgCutoff) as Row[];
    for (const r of old) this.deleteMessage(r.id);
    this.db.prepare('DELETE FROM events WHERE at < ?').run(Date.now() - s.retention.eventsDays * 86400_000);
    return old.length;
  }
}
