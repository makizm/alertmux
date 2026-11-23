import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { hashPassword, verifyPassword } from '../secrets.ts';
import { parseCookies } from './router.ts';

export const SESSION_COOKIE = 'relay_session';
const SESSION_TTL_MS = 12 * 3600_000;

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Admin authentication. Sessions are stateless HMAC-signed cookies ("<expiry>.<nonce>.<sig>"), so they keep
 * working across restarts and multiple replicas sharing SECRET_KEY. The CSRF token is derived from the cookie
 * and must be sent back in the X-CSRF-Token header on every state-changing request.
 */
export class AdminAuth {
  readonly #key: Buffer;
  readonly #passwordHash: string;
  readonly #failures = new Map<string, { n: number; until: number }>();

  constructor(secretKey: string, adminPassword: string) {
    this.#key = createHmac('sha256', 'smtp-relay:session').update(secretKey).digest();
    this.#passwordHash = hashPassword(adminPassword);
  }

  #sign(s: string) { return createHmac('sha256', this.#key).update(s).digest('base64url'); }

  /** Returns a new cookie value, or throws a message for the UI. */
  login(password: string, ip: string): string {
    const f = this.#failures.get(ip);
    if (f && f.until > Date.now() && f.n >= 10) throw new Error('Too many failed attempts. Try again in 15 minutes.');
    if (!verifyPassword(password, this.#passwordHash)) {
      const n = (f && f.until > Date.now() ? f.n : 0) + 1;
      this.#failures.set(ip, { n, until: Date.now() + 15 * 60_000 });
      throw new Error('Wrong password.');
    }
    this.#failures.delete(ip);
    const payload = `${Date.now() + SESSION_TTL_MS}.${randomBytes(12).toString('base64url')}`;
    return `${payload}.${this.#sign('s:' + payload)}`;
  }

  /** The valid session cookie value, or null. */
  session(req: IncomingMessage): string | null {
    const v = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!v) return null;
    const i = v.lastIndexOf('.');
    const payload = v.slice(0, i);
    if (i < 0 || !eq(v.slice(i + 1), this.#sign('s:' + payload))) return null;
    if (Number(payload.split('.')[0]) < Date.now()) return null;
    return v;
  }

  csrfFor(session: string) { return this.#sign('c:' + session); }

  checkCsrf(req: IncomingMessage, session: string): boolean {
    const h = req.headers['x-csrf-token'];
    return typeof h === 'string' && eq(h, this.csrfFor(session));
  }

  cookie(value: string, secure: boolean, clear = false): string {
    return [
      `${SESSION_COOKIE}=${clear ? '' : value}`,
      'Path=/', 'HttpOnly', 'SameSite=Strict',
      clear ? 'Max-Age=0' : `Max-Age=${SESSION_TTL_MS / 1000}`,
      secure ? 'Secure' : '',
    ].filter(Boolean).join('; ');
  }
}
