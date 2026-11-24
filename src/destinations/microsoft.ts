import type { DestinationRecord } from '../db.ts';
import { buildTextMessage, extractAddresses, getHeader, parseHeaders, rewriteHeaders, splitMessage } from '../relay/mime.ts';
import { rewriteFrom } from '../relay/policy.ts';
import { entraClientAssertion } from './jwt.ts';
import { errorDetail, type DeliveryResult, type Destination, type Envelope, type TestResult } from './types.ts';

/** Microsoft cloud endpoints. GCC (moderate) uses the commercial endpoints; GCC High and DoD use .us. */
export const MICROSOFT_CLOUDS = {
  global: { label: 'Commercial / GCC', authority: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com' },
  usgov: { label: 'US Government GCC High', authority: 'https://login.microsoftonline.us', graph: 'https://graph.microsoft.us' },
  usgovdod: { label: 'US Government DoD', authority: 'https://login.microsoftonline.us', graph: 'https://dod-graph.microsoft.us' },
  china: { label: 'China (21Vianet)', authority: 'https://login.chinacloudapi.cn', graph: 'https://microsoftgraph.chinacloudapi.cn' },
  custom: { label: 'Custom endpoints', authority: '', graph: '' },
} as const;

export type MicrosoftCloud = keyof typeof MICROSOFT_CLOUDS;

export interface MicrosoftConfig {
  cloud: MicrosoftCloud;
  authorityUrl?: string;
  graphUrl?: string;
  tenantId: string;
  clientId: string;
  authMethod: 'secret' | 'certificate';
  /**
   * Optional sender override. When set, every message through this destination is sent from this mailbox
   * (Graph `/users/{sendAs}/sendMail`) and the From header is rewritten to it, with the original From kept in
   * Reply-To. Exchange Online rejects a From the app's mailbox has no Send As rights on (ErrorSendAsDenied).
   */
  sendAs?: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Graph limits the sendMail request to 4 MB; MIME is sent base64-encoded (+33%), so the raw message must stay
 * under ~3 MB. Larger messages would need the draft + upload-session flow (future work).
 */
export const GRAPH_MAX_RAW_BYTES = 3 * 1024 * 1024 - 64 * 1024;

export function validateMicrosoftConfig(c: Partial<MicrosoftConfig>, secrets: Record<string, string | null | undefined>, existingSecrets: Record<string, string>): string[] {
  const errors: string[] = [];
  if (!c.cloud || !(c.cloud in MICROSOFT_CLOUDS)) errors.push('Choose a Microsoft cloud');
  if (c.cloud === 'custom') {
    for (const k of ['authorityUrl', 'graphUrl'] as const) {
      try { new URL(c[k] ?? ''); } catch { errors.push(`${k === 'authorityUrl' ? 'Authority URL' : 'Graph URL'} must be a valid URL`); }
    }
  }
  if (!c.tenantId?.trim()) errors.push('Tenant ID is required');
  if (!c.clientId?.trim()) errors.push('Client (application) ID is required');
  if (c.sendAs?.trim() && !EMAIL.test(c.sendAs.trim())) errors.push('Send-as mailbox must be an email address');
  const has = (k: string) => (secrets[k] ?? '') !== '' ? secrets[k] !== null : !!existingSecrets[k];
  if (c.authMethod === 'certificate') {
    if (!has('certificatePem')) errors.push('Certificate (PEM) is required');
    if (!has('privateKeyPem')) errors.push('Private key (PEM) is required');
  } else if (!has('clientSecret')) errors.push('Client secret is required');
  return errors;
}

function endpoints(c: MicrosoftConfig) {
  const preset = MICROSOFT_CLOUDS[c.cloud] ?? MICROSOFT_CLOUDS.global;
  const authority = (c.cloud === 'custom' ? c.authorityUrl! : preset.authority).replace(/\/+$/, '');
  const graph = (c.cloud === 'custom' ? c.graphUrl! : preset.graph).replace(/\/+$/, '');
  return {
    tokenUrl: `${authority}/${encodeURIComponent(c.tenantId.trim())}/oauth2/v2.0/token`,
    graph,
    scope: `${graph}/.default`,
  };
}

/** Parse Retry-After (seconds or HTTP date) to milliseconds. */
export function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

/**
 * Graph takes recipients from the MIME headers, not from an SMTP envelope. Envelope recipients that are not
 * in To/Cc/Bcc (e.g. a device sending a hidden copy) are added as Bcc so they still receive the message.
 */
export function addEnvelopeBcc(mime: Buffer, envelopeTo: string[]): Buffer {
  const h = parseHeaders(splitMessage(mime).head);
  const listed = new Set(['to', 'cc', 'bcc'].flatMap((n) => extractAddresses(h.filter((x) => x.name.toLowerCase() === n).map((x) => x.value).join(', '))));
  const missing = envelopeTo.filter((a) => !listed.has(a.toLowerCase()));
  if (!missing.length) return mime;
  const existingBcc = getHeader(h, 'bcc');
  return rewriteHeaders(mime, { set: { Bcc: [existingBcc, ...missing].filter(Boolean).join(', ') } });
}

export class MicrosoftGraphDestination implements Destination {
  readonly record: DestinationRecord;
  readonly maxMessageBytes = GRAPH_MAX_RAW_BYTES;
  readonly #config: MicrosoftConfig;
  readonly #fetch: typeof fetch;
  #token: { value: string; expiresAt: number } | null = null;
  #pending: Promise<string> | null = null;

  constructor(record: DestinationRecord, fetchImpl: typeof fetch = fetch) {
    this.record = record;
    this.#config = record.config as unknown as MicrosoftConfig;
    this.#fetch = fetchImpl;
  }

  get endpoints() { return endpoints(this.#config); }

  /** The configured sender override, or '' to send as the envelope sender. */
  get sendAs(): string { return this.#config.sendAs?.trim() ?? ''; }

  /** Client-credentials token, cached until 5 minutes before expiry; concurrent callers share one request. */
  async token(force = false): Promise<string> {
    if (!force && this.#token && this.#token.expiresAt - 300_000 > Date.now()) return this.#token.value;
    if (this.#pending) return this.#pending;
    this.#pending = this.#fetchToken().finally(() => { this.#pending = null; });
    return this.#pending;
  }

  async #fetchToken(): Promise<string> {
    const { tokenUrl, scope } = this.endpoints;
    const s = this.record.secrets;
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.#config.clientId.trim(), scope });
    if (this.#config.authMethod === 'certificate') {
      form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      form.set('client_assertion', entraClientAssertion({ clientId: this.#config.clientId.trim(), tokenUrl, certificatePem: s.certificatePem ?? '', privateKeyPem: s.privateKeyPem ?? '' }));
    } else {
      form.set('client_secret', s.clientSecret ?? '');
    }
    const res = await this.#fetch(tokenUrl, { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      const err = new Error(`Token request failed (${res.status}): ${body.error ?? 'unknown'} ${body.error_description?.split('\r\n')[0] ?? ''}`.trim());
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    this.#token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async deliver(envelope: Envelope, mime: Buffer): Promise<DeliveryResult> {
    if (mime.length > this.maxMessageBytes) {
      return { kind: 'permanent', code: 'size', detail: `Message is ${mime.length} bytes; Graph sendMail accepts at most ${this.maxMessageBytes}` };
    }
    const from = this.sendAs || envelope.from;
    const body = this.sendAs ? rewriteFrom(mime, this.sendAs) : mime;
    const payload = addEnvelopeBcc(body, envelope.to).toString('base64');
    const url = `${this.endpoints.graph}/v1.0/users/${encodeURIComponent(from)}/sendMail`;

    for (let attempt = 0; attempt < 2; attempt++) {
      let token: string;
      try {
        token = await this.token(attempt > 0);
      } catch (e) {
        const status = (e as { status?: number }).status;
        // 400/401 from the token endpoint = bad tenant/client/secret: retrying won't help until config changes.
        if (status && status >= 400 && status < 500 && status !== 429) return { kind: 'permanent', code: `token-${status}`, detail: errorDetail(e) };
        return { kind: 'retry', code: 'token', detail: errorDetail(e) };
      }
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
          body: payload,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        return { kind: 'retry', code: 'network', detail: errorDetail(e) };
      }
      const requestId = res.headers.get('request-id') ?? res.headers.get('client-request-id') ?? undefined;
      if (res.status === 202 || res.status === 200) {
        return { kind: 'ok', code: String(res.status), detail: 'Accepted by Microsoft Graph', upstreamId: requestId };
      }
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 1000);
      try {
        const j = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (j.error) detail = `${j.error.code ?? ''}: ${j.error.message ?? ''}`;
      } catch { /* not JSON */ }
      if (requestId) detail += ` (request-id ${requestId})`;
      if (res.status === 401 && attempt === 0) { this.#token = null; continue; }
      if (res.status === 429 || res.status >= 500) {
        return { kind: 'retry', code: String(res.status), detail, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
      }
      return { kind: 'permanent', code: String(res.status), detail };
    }
    return { kind: 'retry', code: '401', detail: 'Unauthorized after token refresh' };
  }

  async test({ address, to }: { address?: string; to?: string }): Promise<TestResult> {
    try {
      await this.token(true);
    } catch (e) {
      return { ok: false, detail: errorDetail(e) };
    }
    if (to) return this.#sendTest(address, to);
    address ||= this.sendAs || undefined;
    const untested = 'Sending was not tested; use “Send a test message” to confirm Mail.Send and the sender mailbox.';
    if (!address) return { ok: true, detail: `Sign-in OK: got an access token for ${this.endpoints.scope}. ${untested}` };
    // Optional mailbox check: needs User.Read.All or Mail.Send scope coverage; a 403 here is informative, not fatal.
    try {
      const res = await this.#fetch(`${this.endpoints.graph}/v1.0/users/${encodeURIComponent(address)}?$select=id,mail`, {
        headers: { authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return { ok: true, detail: `Sign-in OK and mailbox ${address} exists. ${untested}` };
      if (res.status === 403) return { ok: true, detail: `Sign-in OK. Mailbox lookup for ${address} skipped: the app lacks User.Read.All. ${untested}` };
      return { ok: false, detail: `Sign-in OK, but mailbox lookup for ${address} returned ${res.status}.` };
    } catch (e) {
      return { ok: false, detail: errorDetail(e) };
    }
  }

  /** Send a real test message through Graph so the admin can see who receives it and from which mailbox. */
  async #sendTest(address: string | undefined, to: string): Promise<TestResult> {
    const from = this.sendAs || address;
    if (!from) return { ok: false, detail: 'Enter the From mailbox, or set Send as mailbox on this destination.' };
    const hostname = from.slice(from.lastIndexOf('@') + 1);
    const mime = buildTextMessage({
      from, to: [to], subject: `Alertmux test: ${this.record.name}`, hostname,
      text: `Test message from Alertmux destination "${this.record.name}", sent as ${from} through Microsoft Graph.`,
    });
    const r = await this.deliver({ from, to: [to] }, mime);
    const via = this.sendAs && address && address.toLowerCase() !== this.sendAs.toLowerCase() ? ` (send-as override; ${address} ignored)` : '';
    if (r.kind === 'ok') return { ok: true, detail: `Sign-in OK. Test message sent from ${from}${via} to ${to}${r.upstreamId ? ` (request-id ${r.upstreamId})` : ''}.` };
    return { ok: false, detail: `Sign-in OK, but sending from ${from}${via} to ${to} failed: ${r.code}: ${r.detail}` };
  }
}
