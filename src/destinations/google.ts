import nodemailer from 'nodemailer';
import type { DestinationRecord } from '../db.ts';
import { signJwtRS256 } from './jwt.ts';
import { errorDetail, type DeliveryResult, type Destination, type Envelope, type TestResult } from './types.ts';

export interface GoogleConfig {
  /**
   * relay:   Google Workspace SMTP relay service (smtp-relay.gmail.com). Auth by SMTP AUTH (user + app
   *          password) or by the sending IP being allowlisted in the Admin console.
   * xoauth2: smtp.gmail.com with a service account using domain-wide delegation, sending as the envelope sender.
   */
  mode: 'relay' | 'xoauth2';
  host: string;
  port: number;
  /** starttls (587), tls (465), or none (testing only). */
  security: 'starttls' | 'tls' | 'none';
  /** relay mode only: 'password' = SMTP AUTH, 'ip' = rely on the IP allowlist. */
  relayAuth: 'password' | 'ip';
  username: string;
  /** Name sent in EHLO. Google's relay rejects generic names, so use a real hostname in your domain. */
  ehloName: string;
}

export const GOOGLE_DEFAULTS: Record<GoogleConfig['mode'], { host: string; port: number }> = {
  relay: { host: 'smtp-relay.gmail.com', port: 587 },
  xoauth2: { host: 'smtp.gmail.com', port: 587 },
};

export const GOOGLE_MAX_RAW_BYTES = 25 * 1024 * 1024;

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

export function parseServiceAccount(json: string): ServiceAccount | null {
  try {
    const sa = JSON.parse(json) as ServiceAccount;
    return sa.client_email && sa.private_key ? sa : null;
  } catch {
    return null;
  }
}

export function validateGoogleConfig(c: Partial<GoogleConfig>, secrets: Record<string, string | null | undefined>, existing: Record<string, string>): string[] {
  const errors: string[] = [];
  if (c.mode !== 'relay' && c.mode !== 'xoauth2') errors.push('Choose a Google mode');
  if (!c.host?.trim()) errors.push('Host is required');
  if (!Number.isInteger(c.port) || c.port! < 1 || c.port! > 65535) errors.push('Port must be 1–65535');
  if (!c.ehloName?.trim()) errors.push('EHLO name is required');
  const value = (k: string) => (secrets[k] ?? '') !== '' ? (secrets[k] ?? '') : existing[k] ?? '';
  if (c.mode === 'relay' && c.relayAuth === 'password') {
    if (!c.username?.trim()) errors.push('Username is required for SMTP AUTH');
    if (!value('password')) errors.push('App password is required for SMTP AUTH');
  }
  if (c.mode === 'xoauth2') {
    const sa = value('serviceAccountJson');
    if (!sa) errors.push('Service account JSON key is required');
    else if (!parseServiceAccount(sa)) errors.push('Service account JSON must contain client_email and private_key');
  }
  return errors;
}

/** Map an SMTP/nodemailer error to retry vs permanent. */
export function classifySmtpError(e: unknown): DeliveryResult {
  const err = e as { responseCode?: number; code?: string; response?: string; message?: string };
  const detail = err.response ?? errorDetail(e);
  const code = err.responseCode ? String(err.responseCode) : err.code ?? 'error';
  if (err.responseCode && err.responseCode >= 500) return { kind: 'permanent', code, detail };
  if (err.responseCode && err.responseCode >= 400) return { kind: 'retry', code, detail };
  if (err.code === 'EAUTH') return { kind: 'permanent', code, detail };
  return { kind: 'retry', code, detail };
}

export class GoogleSmtpDestination implements Destination {
  readonly record: DestinationRecord;
  readonly maxMessageBytes = GOOGLE_MAX_RAW_BYTES;
  readonly #config: GoogleConfig;
  readonly #fetch: typeof fetch;
  readonly #tokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(record: DestinationRecord, fetchImpl: typeof fetch = fetch) {
    this.record = record;
    this.#config = record.config as unknown as GoogleConfig;
    this.#fetch = fetchImpl;
  }

  /** OAuth2 access token for `subject` via the service account JWT-bearer grant (domain-wide delegation). */
  async token(subject: string): Promise<string> {
    const cached = this.#tokens.get(subject);
    if (cached && cached.expiresAt - 300_000 > Date.now()) return cached.value;
    const sa = parseServiceAccount(this.record.secrets.serviceAccountJson ?? '');
    if (!sa) throw new Error('Service account JSON key is missing or invalid');
    const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const assertion = signJwtRS256({}, { iss: sa.client_email, sub: subject, scope: 'https://mail.google.com/', aud, iat: now, exp: now + 3600 }, sa.private_key);
    const res = await this.#fetch(aud, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      const err = new Error(`Google token request failed (${res.status}): ${body.error ?? ''} ${body.error_description ?? ''}`.trim());
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    this.#tokens.set(subject, { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  async #transport(sender: string) {
    const c = this.#config;
    let auth: Record<string, string> | undefined;
    if (c.mode === 'xoauth2') auth = { type: 'OAuth2', user: sender, accessToken: await this.token(sender) };
    else if (c.relayAuth === 'password') auth = { user: c.username, pass: this.record.secrets.password ?? '' };
    return nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.security === 'tls',
      requireTLS: c.security === 'starttls',
      ignoreTLS: c.security === 'none',
      name: c.ehloName,
      auth: auth as never,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 120_000,
    });
  }

  async deliver(envelope: Envelope, mime: Buffer): Promise<DeliveryResult> {
    if (mime.length > this.maxMessageBytes) {
      return { kind: 'permanent', code: 'size', detail: `Message is ${mime.length} bytes; Google accepts at most ${this.maxMessageBytes}` };
    }
    let transport;
    try {
      transport = await this.#transport(envelope.from);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 429) return { kind: 'permanent', code: `token-${status}`, detail: errorDetail(e) };
      return { kind: 'retry', code: 'token', detail: errorDetail(e) };
    }
    try {
      const info = await transport.sendMail({ envelope: { from: envelope.from, to: envelope.to }, raw: mime });
      return { kind: 'ok', code: '250', detail: String(info.response ?? 'Accepted'), upstreamId: info.messageId };
    } catch (e) {
      return classifySmtpError(e);
    } finally {
      transport.close();
    }
  }

  async test({ address }: { address?: string }): Promise<TestResult> {
    const c = this.#config;
    if (c.mode === 'xoauth2' && !address) return { ok: false, detail: 'Enter a mailbox address to impersonate for the XOAUTH2 test.' };
    try {
      const t = await this.#transport(address ?? c.username);
      try {
        await t.verify();
      } finally {
        t.close();
      }
      return { ok: true, detail: `Connected to ${c.host}:${c.port}${c.mode === 'xoauth2' ? ` and authenticated as ${address}` : c.relayAuth === 'password' ? ` and authenticated as ${c.username}` : ' (IP allowlist mode: relay permission is only checked when a message is sent)'}.` };
    } catch (e) {
      return { ok: false, detail: classifySmtpError(e).detail };
    }
  }
}
