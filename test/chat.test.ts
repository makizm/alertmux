import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DestinationRecord } from '../src/db.ts';
import {
  SlackDestination, TeamsWebhookDestination, parseSender, slackPayload, summarizeForChat, teamsPayload,
  validateSlackConfig, validateTeamsConfig, validWebhookUrl,
} from '../src/destinations/chat.ts';
import { htmlToText, parseHeaderParams, readMessage } from '../src/relay/mime-body.ts';

const CRLF = (lines: string[]) => Buffer.from(lines.join('\r\n'));

const MULTIPART = CRLF([
  'From: "UPS 3" <ups3@contoso.com>',
  'To: ops@contoso.com',
  'Subject: =?UTF-8?Q?Battery_low_=E2=9A=A0?=',
  'Date: Thu, 20 Nov 2026 09:15:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  'preamble',
  '--outer',
  'Content-Type: multipart/alternative; boundary=inner',
  '',
  '--inner',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Battery at 12% =E2=80=94 shutdown in 5 min.=',
  ' Check <rack 4> & PDU.',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Battery at <b>12%</b></p>',
  '--inner--',
  '--outer',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake pdf bytes').toString('base64'),
  '--outer',
  'Content-Type: image/png',
  "Content-Disposition: attachment; filename*=utf-8''Gr%C3%A4fik.png",
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
  '--outer--',
  'epilogue',
  '',
]);

const HTML_ONLY = CRLF([
  'From: scanner@contoso.com',
  'Subject: Scan',
  'Content-Type: text/html; charset=iso-8859-1',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<html><head><style>p{}</style></head><body><p>Caf\xe9&nbsp;&amp; scan<br>ready</p><ul><li>one</li><li>two</li></ul><a href="https://x.example/d">Download</a></body></html>', 'latin1').toString('base64'),
  '',
]);

test('mime body: multipart picks text/plain, decodes QP + UTF-8, lists attachments (incl. RFC 2231 names)', () => {
  const m = readMessage(MULTIPART);
  assert.equal(m.fromHtml, false);
  assert.equal(m.text, 'Battery at 12% — shutdown in 5 min. Check <rack 4> & PDU.');
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType, a.size]), [
    ['report.pdf', 'application/pdf', 23],
    ['Gräfik.png', 'image/png', 4],
  ]);
});

test('mime body: HTML-only, base64, latin-1 → readable text', () => {
  const m = readMessage(HTML_ONLY);
  assert.equal(m.fromHtml, true);
  assert.equal(m.text, 'Café & scan\nready\n\n• one\n• two\n\nDownload (https://x.example/d)');
});

test('mime body: plain single-part and helpers', () => {
  assert.equal(readMessage(Buffer.from('Subject: x\r\n\r\nhello\r\nworld\r\n')).text, 'hello\nworld');
  assert.deepEqual(parseHeaderParams('text/plain; charset="utf-8"; format=flowed'), { value: 'text/plain', params: { charset: 'utf-8', format: 'flowed' } });
  assert.equal(htmlToText('a&#39;b &#x263A; &unknown;'), "a'b ☺ &unknown;");
});

test('chat summary trims the body on a word boundary and respects includeBody', () => {
  const env = { from: 'ups3@contoso.com', to: ['ops@contoso.com'] };
  const s = summarizeForChat(env, MULTIPART, { includeBody: true, maxBodyChars: 20 });
  assert.equal(s.subject, 'Battery low ⚠');
  assert.equal(s.from, '"UPS 3" <ups3@contoso.com>');
  assert.equal(s.body, 'Battery at 12% —');
  assert.equal(s.truncated, true);
  const off = summarizeForChat(env, MULTIPART, { includeBody: false, maxBodyChars: 1500 });
  assert.equal(off.body, '');
  assert.equal(off.truncated, false);
  assert.equal(off.attachments.length, 2);
});

test('teams payload is an Adaptive Card message', () => {
  const s = summarizeForChat({ from: 'a@b.c', to: ['x@y.z'] }, MULTIPART, { includeBody: true, maxBodyChars: 1500 });
  const p = teamsPayload(s);
  assert.equal(p.type, 'message');
  assert.equal(p.attachments[0]!.contentType, 'application/vnd.microsoft.card.adaptive');
  const card = p.attachments[0]!.content;
  assert.equal(card.type, 'AdaptiveCard');
  const json = JSON.stringify(card);
  assert.match(json, /Battery low ⚠/);
  assert.match(json, /report\.pdf \(23 B\)/);
  assert.match(json, /Check <rack 4> & PDU/);
});

const NEWSLETTER = CRLF([
  'From: Acme Cloud <noreply@notifications.acme.example>',
  'Subject: New optional scopes available',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><head><style>.x{}</style></head><body><span style="display:none">hidden preheader</span>',
  '<h1>New optional scopes available</h1><p>Hi Alex,</p><p>' + 'Two connected apps added scopes. '.repeat(12) + '</p>',
  '<ul><li>Allows activating object types</li><li>Allows renaming object types</li></ul>',
  '<p><a href="https://app.example.com/review?a=1&amp;b=(2)">Review app scopes</a></p>',
  '<img src="https://t.example/pixel" style="display:none" width="1" height="1"></body></html>',
  '',
]);

const cardOf = (p: ReturnType<typeof teamsPayload>) => p.attachments[0]!.content as { body: any[] };
const find = (items: any[], pred: (x: any) => boolean): any => {
  for (const x of items) {
    if (pred(x)) return x;
    const inner = find([...(x.items ?? []), ...(x.columns ?? [])], pred);
    if (inner) return inner;
  }
};

test('sender display name is split from the address', () => {
  assert.deepEqual(parseSender('"UPS 3" <ups3@contoso.com>'), { name: 'UPS 3', address: 'ups3@contoso.com' });
  assert.deepEqual(parseSender('Acme Cloud <noreply@acme.example>'), { name: 'Acme Cloud', address: 'noreply@acme.example' });
  assert.deepEqual(parseSender('scanner@contoso.com'), { name: 'scanner@contoso.com', address: '' });
  assert.deepEqual(parseSender('<a@b.c>'), { name: 'a@b.c', address: '' });
});

test('teams card: sender header, subject, preview without URLs, expandable full body with markdown links', () => {
  const s = summarizeForChat({ from: 'bounce@acme.example', to: ['alex@contoso.com'] }, NEWSLETTER, { includeBody: true, maxBodyChars: 4000 });
  assert.equal(s.fromName, 'Acme Cloud');
  assert.ok(s.preview.startsWith('Hi Alex, Two connected apps'), 'subject repeated as a heading is skipped: ' + s.preview);
  assert.ok(s.preview.endsWith('…') && s.preview.length <= 201);
  assert.doesNotMatch(s.preview, /https?:|hidden preheader/);
  const body = cardOf(teamsPayload(s)).body;
  const json = JSON.stringify(body);
  assert.doesNotMatch(json, /"title":"(From|To|Date)"/, 'no From/To/Date facts');
  assert.ok(find(body, (x) => x.text === 'Acme Cloud' && x.weight === 'Bolder'));
  assert.ok(find(body, (x) => x.text === 'noreply@notifications.acme.example'));
  assert.equal(find(body, (x) => x.type === 'ColumnSet'), undefined, 'no avatar badge');
  assert.ok(find(body, (x) => x.text === 'New optional scopes available' && x.weight === 'Bolder'));
  assert.equal(find(body, (x) => x.maxLines === 3 && x.isSubtle).text, s.preview);
  const card = cardOf(teamsPayload(s)) as { body: any[]; actions: any[] };
  assert.equal(card.actions.length, 1);
  assert.equal(card.actions[0].type, 'Action.ShowCard', 'ShowCard works on Teams mobile; ToggleVisibility does not');
  assert.equal(card.actions[0].title, 'Show full message');
  const full = card.actions[0].card.body;
  assert.ok(find(full, (x) => x.text === '[Review app scopes](https://app.example.com/review?a=1&b=%282%29)'));
  assert.ok(find(full, (x) => x.text === '• Allows activating object types'));
  assert.doesNotMatch(json, /ToggleVisibility|isVisible/);
});

test('teams card: short body shown whole without a toggle; body off shows sender + subject only', () => {
  const short = CRLF(['From: "UPS 3" <ups3@contoso.com>', 'Subject: On battery', '', 'Input power lost.', '']);
  const body = cardOf(teamsPayload(summarizeForChat({ from: 'ups3@contoso.com', to: ['o@c.com'] }, short, { includeBody: true, maxBodyChars: 4000 }))).body;
  assert.ok(find(body, (x) => x.text === 'Input power lost.'));
  assert.equal((cardOf(teamsPayload(summarizeForChat({ from: 'ups3@contoso.com', to: ['o@c.com'] }, short, { includeBody: true, maxBodyChars: 4000 }))) as any).actions, undefined);
  const off = cardOf(teamsPayload(summarizeForChat({ from: 'ups3@contoso.com', to: ['o@c.com'] }, NEWSLETTER, { includeBody: false, maxBodyChars: 4000 }))).body;
  assert.equal(find(off, (x) => x.isSubtle && x.maxLines === 3), undefined);
  assert.ok(find(off, (x) => x.text === 'New optional scopes available'));
});

test('teams card stays under the size limit and caps by visible length, not URL length', () => {
  const link = `<a href="https://t.example/${'x'.repeat(900)}">click</a>`;
  const big = CRLF(['From: a@b.c', 'Subject: Big', 'Content-Type: text/html', '', `<p>${(link + ' words here. ').repeat(60)}</p>`, '']);
  const s = summarizeForChat({ from: 'a@b.c', to: ['x@y.z'] }, big, { includeBody: true, maxBodyChars: 10000 });
  assert.equal(s.markdownTruncated, false, '60 × "click words here." is well under 10000 visible chars');
  const p = teamsPayload(s);
  assert.ok(JSON.stringify(p).length <= 26000, 'rebuilt without link targets');
  assert.doesNotMatch(JSON.stringify(p), /x{900}/);
});

test('inline (cid:) images are told apart from attachments and marked in the body; tables and source line breaks', () => {
  const rich = CRLF([
    'From: "UPS Rack 4" <ups3@contoso.com>',
    'Subject: Daily UPS report',
    'Content-Type: multipart/mixed; boundary=mix',
    '',
    '--mix',
    'Content-Type: multipart/related; boundary=rel',
    '',
    '--rel',
    'Content-Type: multipart/alternative; boundary=alt',
    '',
    '--alt',
    'Content-Type: text/plain',
    '',
    'UPS switched to battery twice.',
    '--alt',
    'Content-Type: text/html',
    '',
    '<img src="cid:logo@x" alt="Logo"><h2>Daily UPS report</h2><p>The UPS switched to battery',
    'twice today.</p><table><tr><th>Metric</th><th>Value</th></tr><tr><td>Load</td><td>68%</td></tr></table>',
    '<p><img src="cid:chart@x" alt="Load chart"><img src="https://t.example/p.gif" alt="tracker"></p>',
    '--alt--',
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <logo@x>',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.alloc(300).toString('base64'),
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <chart@x>',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.alloc(2000).toString('base64'),
    '--rel--',
    '--mix',
    'Content-Type: text/csv; name="events.csv"',
    'Content-Disposition: attachment; filename="events.csv"',
    '',
    'time,load',
    '--mix',
    'Content-Type: image/png',
    'Content-ID: <photo@x>',
    'Content-Disposition: attachment; filename="photo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.alloc(10).toString('base64'),
    '--mix--',
    '',
  ]);
  const m = readMessage(rich);
  assert.equal(m.text, 'UPS switched to battery twice.');
  assert.deepEqual(m.attachments.map((x) => [x.filename, x.inline]), [['logo.png', true], ['(unnamed image/png)', true], ['events.csv', false], ['photo.png', false]]);
  const s = summarizeForChat({ from: 'ups3@contoso.com', to: ['o@c.com'] }, rich, { includeBody: true, maxBodyChars: 4000 });
  assert.equal(s.bodyMarkdown, '🖼 Logo\n\nThe UPS switched to battery twice today.\n\nMetric · Value\nLoad · 68%\n\n🖼 Load chart');
  assert.equal(s.preview, 'The UPS switched to battery twice today. Metric · Value Load · 68%');
  const line = find(cardOf(teamsPayload(s)).body, (x) => /^📎/.test(x.text ?? ''));
  assert.equal(line.text, '📎 events.csv (9 B), photo.png (10 B) · 🖼 2 inline images (2 KB)');
});

test('slack payload escapes mrkdwn, splits long bodies, keeps fallback text', () => {
  const body = 'x'.repeat(6000) + ' <b>&';
  const s = { subject: 'S', from: '<a@b.c>', fromName: 'a@b.c', fromAddress: '', to: 'x@y.z', date: '', body, bodyMarkdown: body, preview: '', truncated: true, markdownTruncated: true, attachments: [] };
  const p = slackPayload(s);
  const sections = p.blocks.filter((b: any) => b.type === 'section' && b.text);
  assert.equal(sections.length, 3);
  assert.ok(sections.every((b: any) => b.text.text.length <= 3000));
  assert.match(JSON.stringify(p.blocks), /&lt;a@b\.c&gt;/);
  assert.match(JSON.stringify(p.blocks), /&lt;b&gt;&amp;/);
  assert.match(JSON.stringify(p.blocks), /message truncated/);
  assert.equal(p.text, '📧 S — from <a@b.c>');
});

test('validation of chat configs', () => {
  assert.ok(validWebhookUrl('https://prod-12.westus.logic.azure.com/workflows/abc'));
  assert.ok(validWebhookUrl('http://127.0.0.1:4010/teams/x'));
  assert.ok(!validWebhookUrl('http://example.com/hook'));
  assert.ok(!validWebhookUrl('not a url'));
  const common = { includeBody: true, maxBodyChars: 1500 };
  assert.deepEqual(validateTeamsConfig(common, { webhookUrl: 'https://x.example/hook' }, {}), []);
  assert.deepEqual(validateTeamsConfig(common, {}, { webhookUrl: 'https://stored.example' }), [], 'stored secret counts');
  assert.equal(validateTeamsConfig(common, { webhookUrl: null }, { webhookUrl: 'https://stored.example' }).length, 1, 'cleared secret');
  assert.equal(validateTeamsConfig({ ...common, maxBodyChars: 99999 }, { webhookUrl: 'https://x.example' }, {}).length, 1);
  const bot = { ...common, method: 'bot' as const, channel: '#alerts', apiBaseUrl: 'https://slack-gov.com/api' };
  assert.deepEqual(validateSlackConfig(bot, { botToken: 'xoxb-1' }, {}), []);
  assert.equal(validateSlackConfig(bot, { botToken: 'nope' }, {}).length, 1);
  assert.equal(validateSlackConfig({ ...bot, channel: '' }, { botToken: 'xoxb-1' }, {}).length, 1);
  assert.deepEqual(validateSlackConfig({ ...common, method: 'webhook', channel: '', apiBaseUrl: '' }, { webhookUrl: 'https://hooks.slack.com/services/T/B/x' }, {}), []);
});

// ---- delivery behaviour with a fake fetch ----

function rec(kind: DestinationRecord['kind'], config: Record<string, unknown>, secrets: Record<string, string>): DestinationRecord {
  return { id: 'c1', name: 'chat', kind, enabled: true, config: { includeBody: true, maxBodyChars: 1500, ...config }, secrets, createdAt: 0, updatedAt: 0 };
}
function fake(respond: (url: string, body: any, headers: Record<string, string>) => Response) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const f = (async (u: string | URL | Request, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    calls.push({ url: String(u), body, headers });
    return respond(String(u), body, headers);
  }) as typeof fetch;
  return { f, calls };
}
const ENV = { from: 'ups3@contoso.com', to: ['ops@contoso.com'] };

test('teams: 202 ok, 429 retry with Retry-After, 404 permanent, network error retry', async () => {
  let status = 202;
  const { f, calls } = fake(() => new Response(status === 202 ? null : 'nope', { status, headers: { 'retry-after': '3' } }));
  const d = new TeamsWebhookDestination(rec('teams-webhook', {}, { webhookUrl: 'https://flow.example/hook' }), f);
  assert.equal((await d.deliver(ENV, MULTIPART)).kind, 'ok');
  assert.equal(calls[0]!.url, 'https://flow.example/hook');
  assert.equal(calls[0]!.body.attachments[0].content.type, 'AdaptiveCard');
  status = 429;
  const r = await d.deliver(ENV, MULTIPART);
  assert.deepEqual([r.kind, (r as any).retryAfterMs], ['retry', 3000]);
  status = 404;
  assert.equal((await d.deliver(ENV, MULTIPART)).kind, 'permanent');
  const down = new TeamsWebhookDestination(rec('teams-webhook', {}, { webhookUrl: 'https://flow.example/hook' }), (async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
  assert.equal((await down.deliver(ENV, MULTIPART)).kind, 'retry');
});

test('slack webhook: posts blocks; 410 channel_is_archived is permanent', async () => {
  let status = 200;
  const { f, calls } = fake(() => new Response(status === 200 ? 'ok' : 'channel_is_archived', { status }));
  const d = new SlackDestination(rec('slack', { method: 'webhook' }, { webhookUrl: 'https://hooks.slack.com/services/T/B/x' }), f);
  assert.equal((await d.deliver(ENV, MULTIPART)).kind, 'ok');
  assert.equal(calls[0]!.body.blocks[0].type, 'header');
  assert.equal(calls[0]!.body.channel, undefined);
  status = 410;
  const r = await d.deliver(ENV, MULTIPART);
  assert.equal(r.kind, 'permanent');
  assert.match(r.detail, /channel_is_archived/);
});

test('slack bot: chat.postMessage with bearer token and channel; API errors mapped', async () => {
  let reply: any = { ok: true, channel: 'C123', ts: '1.2' };
  const { f, calls } = fake(() => new Response(JSON.stringify(reply), { status: 200 }));
  const d = new SlackDestination(rec('slack', { method: 'bot', channel: 'C123', apiBaseUrl: 'https://slack-gov.com/api/' }, { botToken: 'xoxb-abc' }), f);
  const ok = await d.deliver(ENV, MULTIPART);
  assert.equal(ok.kind, 'ok');
  assert.equal((ok as any).upstreamId, '1.2');
  assert.equal(calls[0]!.url, 'https://slack-gov.com/api/chat.postMessage');
  assert.equal(calls[0]!.headers.authorization, 'Bearer xoxb-abc');
  assert.equal(calls[0]!.body.channel, 'C123');
  reply = { ok: false, error: 'not_in_channel' };
  const nic = await d.deliver(ENV, MULTIPART);
  assert.equal(nic.kind, 'permanent');
  assert.match(nic.detail, /invite the bot/);
  reply = { ok: false, error: 'ratelimited' };
  assert.equal((await d.deliver(ENV, MULTIPART)).kind, 'retry');
});
