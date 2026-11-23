import { BlockList, isIP } from 'node:net';
import { SMTPServer, type SMTPServerOptions, type SMTPServerSession } from 'smtp-server';
import type { Store } from '../db.ts';
import { bus } from '../bus.ts';
import type { Relay } from '../relay/queue.ts';
import { verifyPassword } from '../secrets.ts';
import { parseCidr, type Settings } from '../settings.ts';

type SmtpSettings = Settings['smtp'];

export function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

export function buildAllowList(networks: string[]): BlockList | null {
  if (!networks.length) return null;
  const list = new BlockList();
  for (const n of networks) {
    const c = parseCidr(n);
    if (c) list.addSubnet(c.address, c.prefix, c.family);
  }
  return list;
}

export function ipAllowed(list: BlockList | null, ip: string): boolean {
  if (!list) return true;
  const addr = normalizeIp(ip);
  const family = isIP(addr) === 6 ? 'ipv6' : 'ipv4';
  return list.check(addr, family);
}

const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });

export interface ListenerStatus {
  running: boolean;
  port: number | null;
  error: string | null;
  connections: number;
  since: number | null;
}

/**
 * Plain SMTP listener (port 25 or custom). STARTTLS/SMTPS are deliberately off for now; the TLS options
 * (`key`, `cert`, `secure`) of smtp-server are where that will plug in later.
 */
export class SmtpListener {
  readonly #store: Store;
  readonly #relay: Relay;
  #server: SMTPServer | null = null;
  #current: SmtpSettings | null = null;
  #authFailures = new Map<string, { n: number; until: number }>();
  status: ListenerStatus = { running: false, port: null, error: null, connections: 0, since: null };

  constructor(store: Store, relay: Relay) {
    this.#store = store;
    this.#relay = relay;
  }

  /** Start, or restart if the SMTP settings changed since the last start. */
  async apply(settings: SmtpSettings) {
    if (this.#current && JSON.stringify(this.#current) === JSON.stringify(settings) && (this.#server || !settings.enabled)) return;
    const wasRunning = !!this.#server;
    await this.stop();
    this.#current = structuredClone(settings);
    if (!settings.enabled) {
      this.#store.addEvent('info', 'smtp.stopped', 'SMTP listener disabled in settings');
      return;
    }
    await this.#start(settings, wasRunning);
  }

  async #start(s: SmtpSettings, restart: boolean) {
    const allow = buildAllowList(s.allowedNetworks);
    const opts: SMTPServerOptions = {
      name: s.hostname,
      banner: 'relay ready', // smtp-server already sends "<hostname> ESMTP" first
      secure: false,
      hideSTARTTLS: true,
      disabledCommands: ['STARTTLS'],
      authMethods: ['PLAIN', 'LOGIN'],
      authOptional: !s.requireAuth,
      // No TLS yet: AUTH must be allowed over the plain connection. The Settings page warns about this.
      allowInsecureAuth: true,
      size: s.maxMessageMb * 1024 * 1024,
      useProxy: s.proxyProtocol,
      disableReverseLookup: true,
      logger: false,
      socketTimeout: 120_000,
      closeTimeout: 10_000,

      onConnect: (session, cb) => {
        const ip = normalizeIp(session.remoteAddress);
        if (!ipAllowed(allow, ip)) {
          this.#store.addEvent('warn', 'smtp.denied', `Connection from ${ip} refused: not in allowed networks`, { ip });
          return cb(smtpError(554, '5.7.1 Your address is not allowed to use this relay'));
        }
        cb();
      },

      onAuth: (auth, session, cb) => {
        const ip = normalizeIp(session.remoteAddress);
        const lock = this.#authFailures.get(ip);
        if (lock && lock.until > Date.now() && lock.n >= 5) return cb(smtpError(454, '4.7.0 Too many failed logins, try later'));
        const user = this.#store.getRelayUserHash(auth.username ?? '');
        if (user && typeof auth.password === 'string' && verifyPassword(auth.password, user.hash)) {
          this.#authFailures.delete(ip);
          this.#store.touchRelayUser(user.id);
          return cb(null, { user: auth.username });
        }
        const n = (lock && lock.until > Date.now() ? lock.n : 0) + 1;
        this.#authFailures.set(ip, { n, until: Date.now() + 15 * 60_000 });
        this.#store.addEvent('warn', 'smtp.auth_failed', `SMTP AUTH failed for "${auth.username}" from ${ip}`, { ip });
        cb(smtpError(535, '5.7.8 Authentication credentials invalid'));
      },

      onMailFrom: (_address, session, cb) => {
        if (s.requireAuth && !session.user) return cb(smtpError(530, '5.7.0 Authentication required'));
        cb();
      },

      onRcptTo: (address, session, cb) => {
        if (session.envelope.rcptTo.length >= s.maxRecipients) return cb(smtpError(452, '4.5.3 Too many recipients'));
        if (!/^[^@\s]+@[^@\s]+$/.test(address.address)) return cb(smtpError(553, '5.1.3 Invalid recipient address'));
        cb();
      },

      onData: (stream, session, cb) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('error', (e) => cb(e));
        stream.on('end', () => {
          if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded) {
            return cb(smtpError(552, `5.3.4 Message exceeds the ${s.maxMessageMb} MB limit`));
          }
          try {
            const res = this.#relay.accept(envelopeOf(session, Buffer.concat(chunks)));
            if (res.ok) cb(null, res.message);
            else cb(smtpError(res.code, res.message));
          } catch (e) {
            console.error('[smtp] accept failed', e);
            cb(smtpError(451, '4.3.0 Local error, try again later'));
          }
        });
      },
    };

    const server = new SMTPServer(opts);
    server.on('error', (e) => {
      this.#store.addEvent('error', 'smtp.error', `SMTP server error: ${e.message}`);
    });
    server.on('connect', () => { this.status.connections++; });

    await new Promise<void>((resolve) => {
      const onError = (e: NodeJS.ErrnoException) => {
        const msg = e.code === 'EACCES'
          ? `Permission denied binding port ${s.port} (ports below 1024 need root or CAP_NET_BIND_SERVICE)`
          : e.code === 'EADDRINUSE' ? `Port ${s.port} is already in use` : e.message;
        this.status = { running: false, port: s.port, error: msg, connections: 0, since: null };
        this.#store.addEvent('error', 'smtp.start_failed', `SMTP listener could not start: ${msg}`);
        bus.emit('status', this.status);
        resolve();
      };
      server.server.once('error', onError);
      server.listen(s.port, s.bindAddress, () => {
        server.server.off('error', onError);
        this.#server = server;
        this.status = { running: true, port: s.port, error: null, connections: 0, since: Date.now() };
        this.#store.addEvent('info', restart ? 'smtp.restarted' : 'smtp.started', `SMTP listener on ${s.bindAddress}:${s.port}${s.requireAuth ? ' (AUTH required)' : ''}${s.proxyProtocol ? ' (PROXY protocol)' : ''}`);
        bus.emit('status', this.status);
        resolve();
      });
    });
  }

  async stop() {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((r) => server.close(() => r()));
    this.status = { ...this.status, running: false, since: null };
    bus.emit('status', this.status);
  }
}

function envelopeOf(session: SMTPServerSession, raw: Buffer) {
  const mailFrom = session.envelope.mailFrom;
  return {
    clientIp: normalizeIp(session.remoteAddress),
    helo: session.hostNameAppearsAs ?? '',
    authUser: typeof session.user === 'string' ? session.user : null,
    mailFrom: mailFrom ? mailFrom.address : '',
    rcptTo: session.envelope.rcptTo.map((r) => r.address),
    raw,
  };
}
