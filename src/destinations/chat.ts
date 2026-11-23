/**
 * Chat destinations: post a summary of each email (subject, sender, recipients, attachment names and the
 * readable body) to a Microsoft Teams channel or a Slack channel.
 *
 * Teams: a Workflows (Power Automate) "When a Teams webhook request is received" URL. Office 365 connectors
 *        were retired, and app-only Graph can't post normal channel messages, so a webhook is the supported path.
 * Slack: an incoming-webhook URL, or a bot token + channel via chat.postMessage (also GovSlack).
 */
import type { DestinationRecord } from '../db.ts';
import { getHeader, parseHeaders, splitMessage, summarize } from '../relay/mime.ts';
import { htmlToText, readMessage, type AttachmentInfo } from '../relay/mime-body.ts';
import { retryAfterMs } from './microsoft.ts';
import { errorDetail, type DeliveryResult, type Destination, type Envelope, type TestResult } from './types.ts';

/** Chat posts render text, so the only size limit is the SMTP listener's own. */
const CHAT_MAX_RAW_BYTES = 150 * 1024 * 1024;

export interface ChatCommonConfig {
  /** Include the message body (trimmed to maxBodyChars). Off = subject, sender and attachments only. */
  includeBody: boolean;
  maxBodyChars: number;
}

export interface TeamsConfig extends ChatCommonConfig {}

export interface SlackConfig extends ChatCommonConfig {
  method: 'webhook' | 'bot';
  /** Bot mode: channel ID (C0123…) or name (#alerts). The bot must be a member of the channel. */
  channel: string;
  /** Bot mode: Web API base. https://slack.com/api, or https://slack-gov.com/api for GovSlack. */
  apiBaseUrl: string;
}

export const SLACK_API_BASES = { 'https://slack.com/api': 'Slack (slack.com)', 'https://slack-gov.com/api': 'GovSlack (slack-gov.com)' };

/** HTTPS only, except plain HTTP to this machine (for local testing with a mock). */
export function validWebhookUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function validateCommon(c: Partial<ChatCommonConfig>): string[] {
  if (!Number.isInteger(c.maxBodyChars) || c.maxBodyChars! < 0 || c.maxBodyChars! > 10_000) return ['Max body length must be 0–10000 characters'];
  return [];
}

const secretValue = (k: string, secrets: Record<string, string | null | undefined>, existing: Record<string, string>) =>
  (secrets[k] ?? '') !== '' ? (secrets[k] ?? '') : secrets[k] === null ? '' : existing[k] ?? '';

export function validateTeamsConfig(c: Partial<TeamsConfig>, secrets: Record<string, string | null | undefined>, existing: Record<string, string>): string[] {
  const errors = validateCommon(c);
  const url = secretValue('webhookUrl', secrets, existing);
  if (!url) errors.push('Workflows webhook URL is required');
  else if (!validWebhookUrl(url)) errors.push('Webhook URL must be an https:// URL');
  return errors;
}

export function validateSlackConfig(c: Partial<SlackConfig>, secrets: Record<string, string | null | undefined>, existing: Record<string, string>): string[] {
  const errors = validateCommon(c);
  if (c.method === 'bot') {
    if (!c.channel?.trim()) errors.push('Channel is required for bot mode');
    if (!c.apiBaseUrl || !validWebhookUrl(c.apiBaseUrl)) errors.push('Slack API base URL must be an https:// URL');
    const token = secretValue('botToken', secrets, existing);
    if (!token) errors.push('Bot token is required');
    else if (!/^xox[bp]-/.test(token)) errors.push('Bot token should start with xoxb- (bot) or xoxp- (user)');
  } else {
    const url = secretValue('webhookUrl', secrets, existing);
    if (!url) errors.push('Incoming webhook URL is required');
    else if (!validWebhookUrl(url)) errors.push('Webhook URL must be an https:// URL');
  }
  return errors;
}

// ---- message summary shared by both ----

export interface ChatSummary {
  subject: string;
  /** Raw From header (or envelope sender). */
  from: string;
  /** Display name from the From header, or the address when there is none. */
  fromName: string;
  /** Sender address, or '' when it is the same as fromName. */
  fromAddress: string;
  to: string;
  date: string;
  /** Body as plain text, links written as "text (url)". Capped at maxBodyChars. */
  body: string;
  /** Same body with markdown links, for Teams. Capped at maxBodyChars of visible text. */
  bodyMarkdown: string;
  /** One-paragraph preview (no URLs), like a mail client's message list. */
  preview: string;
  /** `body` was cut at maxBodyChars. */
  truncated: boolean;
  /** `bodyMarkdown` was cut at maxBodyChars. */
  markdownTruncated: boolean;
  attachments: AttachmentInfo[];
}

export const PREVIEW_CHARS = 200;

/** Split `"Name" <a@b.c>` / `Name <a@b.c>` / `a@b.c` into a display name and address. */
export function parseSender(from: string): { name: string; address: string } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]*)>\s*$/.exec(from);
  const address = (m ? m[2]! : from).trim();
  const name = (m?.[1] ?? '').replace(/\\(.)/g, '$1').trim();
  return name && name.toLowerCase() !== address.toLowerCase() ? { name, address } : { name: address || '(unknown sender)', address: '' };
}

/** Cut on a word boundary at or before `max` characters. */
const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') : text);

/** Cap markdown text by visible length: link URLs don't count, and a link is never cut in half. */
function cutMarkdown(md: string, max: number): string {
  let visible = 0;
  let out = '';
  for (const tok of md.match(/\[[^\]]*\]\([^)]*\)|\s+|[^\s[]+|\[/g) ?? []) {
    const len = tok.startsWith('[') && tok.includes('](') ? tok.indexOf('](') - 1 : tok.length;
    if (visible + len > max) break;
    out += tok;
    visible += len;
  }
  return out.trimEnd();
}

export function summarizeForChat(envelope: Envelope, mime: Buffer, c: ChatCommonConfig): ChatSummary {
  const s = summarize(mime);
  const headers = parseHeaders(splitMessage(mime).head);
  const read = readMessage(mime);
  const max = c.includeBody ? c.maxBodyChars : 0;
  const subject = s.subject || '(no subject)';
  const from = s.headerFrom || envelope.from || '<>';
  const sender = parseSender(from);

  // Preview: links reduced to their text, whitespace collapsed, and a leading copy of the subject
  // (common in HTML newsletters) skipped.
  // Prefer the HTML part (links, embedded images) unless it is clearly thinner than the text/plain part.
  const htmlFlat = read.html !== null ? htmlToText(read.html, 'none') : null;
  const useHtml = htmlFlat !== null && (read.fromHtml || htmlFlat.length >= read.text.length / 2);
  let flat = (useHtml ? htmlFlat! : read.text).replace(/\s+/g, ' ').trim();
  if (flat.toLowerCase().startsWith(subject.toLowerCase())) flat = flat.slice(subject.length).trim();
  const preview = flat.length > PREVIEW_CHARS ? cut(flat, PREVIEW_CHARS) + '…' : flat;

  let markdown = useHtml ? htmlToText(read.html!, 'markdown') : read.text;
  // The card already shows the subject, so drop it when the body opens with it as a heading.
  // Look past a leading logo or two.
  const lines = markdown.split('\n');
  const at = lines.slice(0, 4).findIndex((l) => l.trim().toLowerCase() === subject.toLowerCase());
  if (at >= 0) markdown = [...lines.slice(0, at), ...lines.slice(at + 1)].join('\n').trim();
  const bodyMarkdown = max ? cutMarkdown(markdown, max) : '';
  return {
    subject,
    from,
    fromName: sender.name,
    fromAddress: sender.address,
    to: envelope.to.join(', '),
    date: getHeader(headers, 'date'),
    body: max ? cut(read.text, max) : '',
    bodyMarkdown,
    preview: max ? preview : '',
    truncated: max > 0 && read.text.length > max,
    markdownTruncated: max > 0 && bodyMarkdown.length < markdown.trimEnd().length,
    attachments: read.attachments,
  };
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** "📎 a.pdf (2 KB), b.csv (1 KB) · 🖼 2 inline images (88 KB)", or '' when there are none. */
const attachmentLine = (a: AttachmentInfo[]) => {
  const files = a.filter((x) => !x.inline);
  const images = a.filter((x) => x.inline);
  return [
    files.length ? `📎 ${files.map((x) => `${x.filename} (${fmtSize(x.size)})`).join(', ')}` : '',
    images.length ? `🖼 ${images.length} inline image${images.length > 1 ? 's' : ''} (${fmtSize(images.reduce((n, x) => n + x.size, 0))})` : '',
  ].filter(Boolean).join(' · ');
};

/** Map an HTTP response from a webhook/API to a delivery result. */
async function classify(res: Response, okDetail: string): Promise<DeliveryResult> {
  const text = (await res.text().catch(() => '')).slice(0, 500);
  if (res.ok) return { kind: 'ok', code: String(res.status), detail: okDetail };
  if (res.status === 429 || res.status >= 500) return { kind: 'retry', code: String(res.status), detail: text || res.statusText, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
  return { kind: 'permanent', code: String(res.status), detail: text || res.statusText };
}

async function post(fetchImpl: typeof fetch, url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response | DeliveryResult> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { kind: 'retry', code: 'network', detail: errorDetail(e) };
  }
}

// ---- Teams ----

/** Adaptive Card wrapped the way the Workflows "Teams webhook" trigger expects. */
/** Teams rejects cards much over 28 KB, so the card is rebuilt smaller when it would not fit. */
const TEAMS_MAX_CARD_BYTES = 26_000;
/** Paragraph lines rendered in the expanded view; the rest is summarised as truncated. */
const TEAMS_MAX_LINES = 200;

/**
 * The expanded body as one TextBlock per line. Teams clients differ in how they treat single newlines
 * inside one TextBlock, so separate blocks render the same everywhere. Blank lines become extra spacing.
 */
function bodyBlocks(text: string): unknown[] {
  const blocks: unknown[] = [];
  let gap = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) { gap = true; continue; }
    if (blocks.length >= TEAMS_MAX_LINES) break;
    blocks.push({ type: 'TextBlock', text: line, wrap: true, spacing: blocks.length === 0 ? 'None' : gap ? 'Medium' : 'Small' });
    gap = false;
  }
  return blocks;
}

function teamsCard(s: ChatSummary, body: string) {
  const header = [
    { type: 'TextBlock', text: s.fromName, weight: 'Bolder', size: 'Medium', wrap: true },
    ...(s.fromAddress ? [{ type: 'TextBlock', text: s.fromAddress, isSubtle: true, size: 'Small', spacing: 'None', wrap: true }] : []),
  ];
  const items: unknown[] = [...header, { type: 'TextBlock', text: s.subject, weight: 'Bolder', wrap: true, spacing: 'Medium' }];

  const lines = bodyBlocks(body);
  // A short body is shown whole; a longer one shows the preview with a toggle to the full text.
  const expandable = s.preview.length > 0 && (s.preview.endsWith('…') || lines.length > 3);
  if (!expandable && lines.length) {
    items.push({ type: 'Container', spacing: 'Small', items: lines });
  } else if (expandable) {
    items.push({ type: 'TextBlock', text: s.preview, isSubtle: true, wrap: true, maxLines: 3, spacing: 'Small' });
  }
  if (s.attachments.length) {
    items.push({ type: 'TextBlock', text: attachmentLine(s.attachments), isSubtle: true, size: 'Small', wrap: true, spacing: 'Medium' });
  }
  // Action.ShowCard rather than Action.ToggleVisibility: the Teams mobile apps don't reliably toggle
  // isVisible, but every client supports ShowCard (Adaptive Cards 1.0). Tapping it again collapses the card.
  const actions = expandable ? [{
    type: 'Action.ShowCard',
    title: 'Show full message',
    card: {
      type: 'AdaptiveCard',
      body: [...lines, ...(s.markdownTruncated ? [{ type: 'TextBlock', text: '…message truncated', isSubtle: true, size: 'Small', wrap: true }] : [])],
    },
  }] : [];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
        body: items, ...(actions.length ? { actions } : {}), msteams: { width: 'Full' },
      },
    }],
  };
}

/** Adaptive Card laid out like a mail list entry: sender, subject, preview, and an expandable full body. */
export function teamsPayload(s: ChatSummary) {
  let card = teamsCard(s, s.bodyMarkdown);
  // Long tracking URLs can push the card past Teams' limit: drop link targets first, then halve the body.
  if (JSON.stringify(card).length > TEAMS_MAX_CARD_BYTES) card = teamsCard({ ...s, markdownTruncated: s.truncated }, s.body.replace(/ \((?:https?|mailto):[^)\s]*\)/g, ''));
  for (let text = s.body; JSON.stringify(card).length > TEAMS_MAX_CARD_BYTES && text.length > 200;) {
    text = cut(text, Math.floor(text.length / 2));
    card = teamsCard({ ...s, markdownTruncated: true }, text);
  }
  return card;
}

const TEST_BODY = 'If you can read this, the relay can post to this channel.';
const testSummary = (to: string): ChatSummary => ({
  subject: 'Alertmux test', from: 'Alertmux', fromName: 'Alertmux', fromAddress: '', to,
  date: new Date().toUTCString(), body: TEST_BODY, bodyMarkdown: TEST_BODY, preview: TEST_BODY, truncated: false, markdownTruncated: false, attachments: [],
});

export class TeamsWebhookDestination implements Destination {
  readonly record: DestinationRecord;
  readonly maxMessageBytes = CHAT_MAX_RAW_BYTES;
  readonly #config: TeamsConfig;
  readonly #fetch: typeof fetch;

  constructor(record: DestinationRecord, fetchImpl: typeof fetch = fetch) {
    this.record = record;
    this.#config = record.config as unknown as TeamsConfig;
    this.#fetch = fetchImpl;
  }

  async deliver(envelope: Envelope, mime: Buffer): Promise<DeliveryResult> {
    const res = await post(this.#fetch, this.record.secrets.webhookUrl ?? '', teamsPayload(summarizeForChat(envelope, mime, this.#config)));
    return res instanceof Response ? classify(res, 'Posted to Teams') : res;
  }

  async test(): Promise<TestResult> {
    const r = await post(this.#fetch, this.record.secrets.webhookUrl ?? '', teamsPayload(testSummary(this.record.name)));
    if (!(r instanceof Response)) return { ok: false, detail: r.detail };
    const res = await classify(r, 'Posted a test card to the channel.');
    return { ok: res.kind === 'ok', detail: res.kind === 'ok' ? res.detail : `${res.code}: ${res.detail}` };
  }
}

// ---- Slack ----

/** Slack mrkdwn needs &, < and > escaped. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackPayload(s: ChatSummary) {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: s.subject.slice(0, 150), emoji: true } },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*From*\n${esc(s.from)}` },
      { type: 'mrkdwn', text: `*To*\n${esc(s.to).slice(0, 1900)}` },
    ] },
  ];
  // Section text is limited to 3000 characters, so long bodies become several sections.
  for (let i = 0; i < s.body.length && blocks.length < 45; i += 2900) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: esc(s.body.slice(i, i + 2900)) } });
  }
  const context = [
    ...(s.attachments.length ? [esc(attachmentLine(s.attachments))] : []),
    ...(s.truncated ? ['…message truncated'] : []),
    ...(s.date ? [esc(s.date)] : []),
  ];
  if (context.length) blocks.push({ type: 'context', elements: context.map((t) => ({ type: 'mrkdwn', text: t.slice(0, 2000) })) });
  return { text: `📧 ${s.subject} — from ${s.from}`.slice(0, 3000), blocks, unfurl_links: false, unfurl_media: false };
}

/** Slack Web API errors that are worth retrying; everything else (channel_not_found, invalid_auth, …) is permanent. */
const SLACK_RETRYABLE = new Set(['ratelimited', 'internal_error', 'fatal_error', 'request_timeout', 'service_unavailable']);

export class SlackDestination implements Destination {
  readonly record: DestinationRecord;
  readonly maxMessageBytes = CHAT_MAX_RAW_BYTES;
  readonly #config: SlackConfig;
  readonly #fetch: typeof fetch;

  constructor(record: DestinationRecord, fetchImpl: typeof fetch = fetch) {
    this.record = record;
    this.#config = record.config as unknown as SlackConfig;
    this.#fetch = fetchImpl;
  }

  async #send(payload: Record<string, unknown>): Promise<DeliveryResult> {
    const c = this.#config;
    if (c.method !== 'bot') {
      const res = await post(this.#fetch, this.record.secrets.webhookUrl ?? '', payload);
      return res instanceof Response ? classify(res, 'Posted to Slack') : res;
    }
    const res = await post(this.#fetch, `${c.apiBaseUrl.replace(/\/+$/, '')}/chat.postMessage`, { ...payload, channel: c.channel.trim() },
      { authorization: `Bearer ${this.record.secrets.botToken ?? ''}` });
    if (!(res instanceof Response)) return res;
    if (!res.ok) return classify(res, '');
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string; channel?: string };
    if (body.ok) return { kind: 'ok', code: '200', detail: `Posted to Slack channel ${body.channel ?? c.channel}`, upstreamId: body.ts };
    const err = body.error ?? 'unknown_error';
    const hint = err === 'not_in_channel' ? ' (invite the bot to the channel)' : err === 'channel_not_found' ? ' (check the channel ID; private channels need the bot invited)' : '';
    return SLACK_RETRYABLE.has(err) ? { kind: 'retry', code: err, detail: err } : { kind: 'permanent', code: err, detail: err + hint };
  }

  deliver(envelope: Envelope, mime: Buffer): Promise<DeliveryResult> {
    return this.#send(slackPayload(summarizeForChat(envelope, mime, this.#config)));
  }

  async test(): Promise<TestResult> {
    const r = await this.#send(slackPayload(testSummary(this.record.name)));
    return r.kind === 'ok' ? { ok: true, detail: 'Posted a test message to the channel.' } : { ok: false, detail: `${r.code}: ${r.detail}` };
  }
}
