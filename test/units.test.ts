import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEnvelopeBcc, retryAfterMs } from '../src/destinations/microsoft.ts';
import { classifySmtpError } from '../src/destinations/google.ts';
import { decodeWords, getHeader, parseHeaders, rewriteHeaders, splitMessage, summarize } from '../src/relay/mime.ts';
import { applySenderRewrite, checkSender } from '../src/relay/policy.ts';
import { resolveDestinations } from '../src/relay/routing.ts';
import { backoffMs } from '../src/relay/queue.ts';
import { SecretBox, hashPassword, verifyPassword } from '../src/secrets.ts';
import { defaultSettings, mergeSettings, validateSettings } from '../src/settings.ts';
import { buildAllowList, ipAllowed } from '../src/smtp/listener.ts';
import type { RouteRule } from '../src/db.ts';

const MSG = Buffer.from([
  'From: "Scanner" <scanner@contoso.com>',
  'To: alice@contoso.com,',
  ' bob@contoso.com',
  'Subject: =?UTF-8?B?SGVsbG8g8J+Riw==?=',
  'Message-ID: <abc@contoso.com>',
  '',
  'Body line',
  '',
].join('\r\n'));

test('mime: parses folded headers and decodes encoded words', () => {
  const h = parseHeaders(splitMessage(MSG).head);
  assert.equal(getHeader(h, 'to'), 'alice@contoso.com, bob@contoso.com');
  assert.equal(decodeWords(getHeader(h, 'subject')), 'Hello 👋');
  assert.deepEqual({ ...summarize(MSG), headers: undefined }, { headerFrom: '"Scanner" <scanner@contoso.com>', subject: 'Hello 👋', messageId: '<abc@contoso.com>', headers: undefined });
});

test('mime: rewrite replaces headers and keeps the body byte-for-byte', () => {
  const out = rewriteHeaders(MSG, { set: { From: 'noreply@contoso.com' }, add: { 'Reply-To': 'x@y.z', 'Message-ID': '<ignored>' } });
  const { head, body } = splitMessage(out);
  const h = parseHeaders(head);
  assert.equal(getHeader(h, 'from'), 'noreply@contoso.com');
  assert.equal(getHeader(h, 'reply-to'), 'x@y.z');
  assert.equal(getHeader(h, 'message-id'), '<abc@contoso.com>');
  assert.equal(h.filter((x) => x.name.toLowerCase() === 'from').length, 1);
  assert.deepEqual(body, splitMessage(MSG).body);
});

test('mime: LF-only messages are handled', () => {
  const lf = Buffer.from('Subject: hi\nTo: a@b.c\n\nbody\n');
  assert.equal(getHeader(parseHeaders(splitMessage(lf).head), 'subject'), 'hi');
  assert.equal(splitMessage(rewriteHeaders(lf, { set: { From: 'x@y.z' } })).body.toString(), 'body\n');
});

test('graph: envelope-only recipients become Bcc', () => {
  const out = addEnvelopeBcc(MSG, ['alice@contoso.com', 'Hidden@Contoso.com']);
  assert.equal(getHeader(parseHeaders(splitMessage(out).head), 'bcc'), 'Hidden@Contoso.com');
  assert.equal(addEnvelopeBcc(MSG, ['bob@contoso.com']), MSG, 'unchanged when all recipients are in headers');
});

test('graph: Retry-After parsing', () => {
  assert.equal(retryAfterMs('5'), 5000);
  assert.equal(retryAfterMs(null), undefined);
  const d = retryAfterMs(new Date(Date.now() + 10_000).toUTCString())!;
  assert.ok(d > 8000 && d <= 10_000);
});

test('smtp error classification', () => {
  assert.equal(classifySmtpError({ responseCode: 550, response: '550 no' }).kind, 'permanent');
  assert.equal(classifySmtpError({ responseCode: 421, response: '421 later' }).kind, 'retry');
  assert.equal(classifySmtpError({ code: 'ECONNECTION', message: 'refused' }).kind, 'retry');
  assert.equal(classifySmtpError({ code: 'EAUTH', message: 'bad' }).kind, 'permanent');
});

test('sender policy', () => {
  const s = defaultSettings(25).sender;
  assert.deepEqual(checkSender(s, 'a@x.com'), { ok: true, sendAs: 'a@x.com' });
  assert.equal(checkSender(s, '').ok, false);
  const restricted = { ...s, allowed: ['@contoso.com', 'ops@fabrikam.com'] };
  assert.equal(checkSender(restricted, 'scanner@CONTOSO.com').ok, true);
  assert.equal(checkSender(restricted, 'ops@fabrikam.com').ok, true);
  assert.equal(checkSender(restricted, 'x@evilcontoso.com').ok, false);
  const fixed = { ...s, mode: 'fixed' as const, fixedAddress: 'noreply@contoso.com' };
  assert.deepEqual(checkSender(fixed, ''), { ok: true, sendAs: 'noreply@contoso.com' });
  const rewritten = parseHeaders(splitMessage(applySenderRewrite(fixed, MSG)).head);
  assert.equal(getHeader(rewritten, 'from'), 'noreply@contoso.com');
  assert.equal(getHeader(rewritten, 'reply-to'), '"Scanner" <scanner@contoso.com>');
});

test('routing: fan-out, stop, default', () => {
  const rule = (o: Partial<RouteRule>): RouteRule => ({ id: 0, name: '', enabled: true, stop: false, destinationIds: [], match: { senders: [], senderDomains: [], recipientDomains: [] }, ...o });
  const rules = [
    rule({ match: { senders: [], senderDomains: ['fabrikam.com'], recipientDomains: [] }, destinationIds: ['google'], stop: true }),
    rule({ match: { senders: [], senderDomains: [], recipientDomains: ['@partner.org'] }, destinationIds: ['m365', 'archive'] }),
    rule({ enabled: false, destinationIds: ['never'] }),
  ];
  assert.deepEqual(resolveDestinations(rules, 'm365', { mailFrom: 'a@fabrikam.com', rcptTo: ['x@partner.org'] }), ['google']);
  assert.deepEqual(resolveDestinations(rules, 'm365', { mailFrom: 'a@contoso.com', rcptTo: ['x@partner.org'] }), ['m365', 'archive']);
  assert.deepEqual(resolveDestinations(rules, 'm365', { mailFrom: 'a@contoso.com', rcptTo: ['x@other.org'] }), ['m365']);
  assert.deepEqual(resolveDestinations(rules, null, { mailFrom: 'a@contoso.com', rcptTo: ['x@other.org'] }), []);
});

test('settings: merge keeps defaults for missing fields, validation catches bad input', () => {
  const s = mergeSettings(defaultSettings(25), { smtp: { port: 2525, bogus: 1 }, nope: {} });
  assert.equal(s.smtp.port, 2525);
  assert.equal(s.smtp.maxRecipients, 100);
  assert.equal((s.smtp as Record<string, unknown>).bogus, undefined);
  assert.deepEqual(validateSettings(s), []);
  s.smtp.allowedNetworks = ['10.0.0.0/33'];
  s.sender.allowed = ['not-an-address'];
  s.sender.mode = 'fixed';
  assert.equal(validateSettings(s).length, 3);
});

test('secrets: round trip, tamper detection, password hashing', () => {
  const box = new SecretBox('k1');
  const enc = box.encrypt('hunter2');
  assert.notEqual(enc, box.encrypt('hunter2'), 'random IV');
  assert.equal(box.decrypt(enc), 'hunter2');
  assert.throws(() => new SecretBox('k2').decrypt(enc));
  const h = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
});

test('ip allowlist incl. IPv4-mapped IPv6', () => {
  const list = buildAllowList(['192.168.1.0/24', '10.1.2.3', 'fd00::/8']);
  assert.ok(ipAllowed(list, '192.168.1.77'));
  assert.ok(ipAllowed(list, '::ffff:192.168.1.5'));
  assert.ok(ipAllowed(list, '10.1.2.3'));
  assert.ok(!ipAllowed(list, '10.1.2.4'));
  assert.ok(ipAllowed(list, 'fd12::1'));
  assert.ok(!ipAllowed(list, '8.8.8.8'));
  assert.ok(ipAllowed(buildAllowList([]), '8.8.8.8'), 'empty list = any');
});

test('backoff doubles and caps', () => {
  for (let i = 0; i < 20; i++) {
    const a1 = backoffMs(1, 30, 3600);
    assert.ok(a1 >= 24_000 && a1 <= 36_000);
    const a3 = backoffMs(3, 30, 3600);
    assert.ok(a3 >= 96_000 && a3 <= 144_000);
    assert.ok(backoffMs(20, 30, 3600) <= 3600 * 1200);
  }
});
