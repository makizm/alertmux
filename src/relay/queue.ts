import type { DeliveryRow, MessageRow, Store } from '../db.ts';
import { newMessageId } from '../db.ts';
import type { DestinationRegistry } from '../destinations/index.ts';
import { errorDetail } from '../destinations/types.ts';
import { summarize } from './mime.ts';
import { applySenderRewrite, checkSender } from './policy.ts';
import { resolveDestinations } from './routing.ts';

export interface IncomingMessage {
  clientIp: string;
  helo: string;
  authUser: string | null;
  mailFrom: string;
  rcptTo: string[];
  raw: Buffer;
}

/** SMTP reply for the end of DATA. */
export interface AcceptResult {
  ok: boolean;
  /** SMTP reply code (250, 451, 550, 552). */
  code: number;
  message: string;
  id?: string;
}

/** Backoff for attempt n (1-based): base * 2^(n-1), capped, ±20% jitter. */
export function backoffMs(attempt: number, baseSec: number, maxSec: number): number {
  const ms = Math.min(baseSec * 2 ** Math.max(0, attempt - 1), maxSec) * 1000;
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/**
 * The relay pipeline: accept (policy → route → size → spool) and a worker that delivers queued messages,
 * retrying temporary failures with backoff. Survives restarts because the queue lives in SQLite.
 */
export class Relay {
  readonly #store: Store;
  readonly #registry: DestinationRegistry;
  #timer: NodeJS.Timeout | null = null;
  #purgeTimer: NodeJS.Timeout | null = null;
  #inFlight = 0;
  #ticking = false;
  #stopped = false;
  readonly #running = new Set<Promise<void>>();

  constructor(store: Store, registry: DestinationRegistry) {
    this.#store = store;
    this.#registry = registry;
  }

  accept(m: IncomingMessage): AcceptResult {
    const settings = this.#store.getSettings();
    const info = summarize(m.raw);
    const id = newMessageId();
    const base = {
      id, clientIp: m.clientIp, helo: m.helo, authUser: m.authUser, mailFrom: m.mailFrom, rcptTo: m.rcptTo,
      headerFrom: info.headerFrom, subject: info.subject, messageId: info.messageId, size: m.raw.length,
    };
    const reject = (code: number, message: string): AcceptResult => {
      this.#store.insertMessage({ ...base, sendAs: '', status: 'rejected', destinations: [], lastError: message }, null);
      this.#store.addEvent('warn', 'message.rejected', `Rejected message from ${m.mailFrom || '<>'} (${m.clientIp}): ${message}`, { id });
      return { ok: false, code, message, id };
    };

    const sender = checkSender(settings.sender, m.mailFrom);
    if (!sender.ok) return reject(550, `5.7.1 ${sender.reason}`);

    const routed = resolveDestinations(this.#store.listRoutes(), settings.routing.defaultDestinationId, { mailFrom: m.mailFrom, rcptTo: m.rcptTo });
    const destinations = routed.map((d) => this.#registry.get(d)).filter((d) => d && d.record.enabled);
    if (!destinations.length) return reject(451, '4.3.0 No delivery destination is configured for this message; try again later');

    const limit = Math.min(...destinations.map((d) => d!.maxMessageBytes));
    if (m.raw.length > limit) return reject(552, `5.3.4 Message size ${m.raw.length} exceeds the ${limit} byte limit of the destination`);

    const received = `from ${m.helo || 'unknown'} ([${m.clientIp}]) by ${settings.smtp.hostname} with ESMTP id ${id}; ${new Date().toUTCString().replace('GMT', '+0000')}`;
    const body = Buffer.concat([Buffer.from(`Received: ${received}\r\n`), applySenderRewrite(settings.sender, m.raw)]);

    this.#store.insertMessage({ ...base, sendAs: sender.sendAs, status: 'queued', destinations: destinations.map((d) => d!.record.id), lastError: null }, body);
    this.kick();
    return { ok: true, code: 250, message: `2.0.0 Ok: queued as ${id}`, id };
  }

  start() {
    this.#stopped = false;
    this.#store.resetSending();
    this.#timer = setInterval(() => this.kick(), 2000);
    this.#timer.unref();
    const purge = () => {
      try {
        const n = this.#store.purge(this.#store.getSettings());
        if (n) this.#store.addEvent('info', 'retention', `Purged ${n} old messages`);
      } catch (e) {
        console.error('[purge]', e);
      }
    };
    purge();
    this.#purgeTimer = setInterval(purge, 3600_000);
    this.#purgeTimer.unref();
    this.kick();
  }

  /** Stop picking up new work and wait for in-flight deliveries to finish. */
  async stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#purgeTimer) clearInterval(this.#purgeTimer);
    await Promise.allSettled([...this.#running]);
  }

  /** Check for due deliveries now. */
  kick() {
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      const settings = this.#store.getSettings();
      const free = settings.delivery.concurrency - this.#inFlight;
      if (free <= 0) return;
      for (const d of this.#store.claimDue(free)) {
        this.#inFlight++;
        const p = this.#deliver(d)
          .catch((e) => console.error('[relay] delivery crashed', e))
          .finally(() => {
            this.#inFlight--;
            this.#running.delete(p);
            setImmediate(() => this.kick());
          });
        this.#running.add(p);
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Resolves when the queue has no due or in-flight work (used by tests). */
  async idle(timeoutMs = 10_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      this.kick();
      if (!this.#running.size) return;
      await Promise.allSettled([...this.#running]);
    }
  }

  async #deliver(d: DeliveryRow) {
    const settings = this.#store.getSettings();
    const msg = this.#store.getMessage(d.messageId);
    if (!msg) return;
    const started = Date.now();
    const attemptNo = d.attempts + 1;
    const record = (ok: boolean, code: string, detail: string, next: Parameters<Store['recordAttempt']>[1]) =>
      this.#store.recordAttempt({ messageId: d.messageId, destinationId: d.destinationId, at: started, ok, code, detail, durationMs: Date.now() - started }, next);

    const dest = this.#registry.get(d.destinationId);
    const body = this.#store.readBody(d.messageId);
    if (!dest || !dest.record.enabled || !body) {
      const why = !body ? 'Stored message body is missing' : 'Destination was removed or disabled';
      record(false, 'internal', why, { status: 'failed', nextAttemptAt: 0, lastError: why });
      this.#store.addEvent('error', 'delivery.failed', `${msg.id}: ${why}`, { id: msg.id });
      return;
    }

    let result;
    try {
      result = await dest.deliver({ from: msg.sendAs, to: msg.rcptTo }, body);
    } catch (e) {
      result = { kind: 'retry' as const, code: 'exception', detail: errorDetail(e) };
    }

    const name = dest.record.name;
    let updated: MessageRow | undefined;
    if (result.kind === 'ok') {
      updated = record(true, result.code, result.detail, { status: 'sent', nextAttemptAt: 0, lastError: null, upstreamId: result.upstreamId ?? null });
    } else if (result.kind === 'retry' && attemptNo < settings.delivery.maxAttempts) {
      const wait = result.retryAfterMs ?? backoffMs(attemptNo, settings.delivery.retryBaseSeconds, settings.delivery.retryMaxSeconds);
      const err = `[${name}] ${result.code}: ${result.detail}`;
      updated = record(false, result.code, result.detail, { status: 'retrying', nextAttemptAt: Date.now() + wait, lastError: err });
      this.#store.addEvent('warn', 'delivery.retry', `${msg.id} to ${name} failed temporarily (attempt ${attemptNo}/${settings.delivery.maxAttempts}), retrying in ${Math.round(wait / 1000)}s: ${result.detail}`, { id: msg.id });
    } else {
      const err = `[${name}] ${result.code}: ${result.detail}`;
      updated = record(false, result.code, result.detail, { status: 'failed', nextAttemptAt: 0, lastError: err });
      this.#store.addEvent('error', 'delivery.failed', `${msg.id} to ${name} failed${result.kind === 'retry' ? ` after ${attemptNo} attempts` : ''}: ${result.detail}`, { id: msg.id });
    }
    if (updated?.status === 'sent' && settings.retention.deleteBodiesAfterSend) this.#store.deleteBody(msg.id);
  }
}
