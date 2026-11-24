import type { Settings } from '../settings.ts';
import { getHeader, parseHeaders, rewriteHeaders, splitMessage } from './mime.ts';

export type SenderDecision = { ok: true; sendAs: string } | { ok: false; reason: string };

/** Does `address` match an allow-list entry ("user@domain" exactly, or "@domain")? */
export function addressMatches(address: string, entry: string): boolean {
  const a = address.toLowerCase();
  const e = entry.trim().toLowerCase();
  if (e.startsWith('@')) return a.endsWith(e);
  return a === e;
}

/** Decide whether MAIL FROM may relay, and which mailbox the message is sent as. */
export function checkSender(s: Settings['sender'], mailFrom: string): SenderDecision {
  const from = mailFrom.trim();
  if (s.allowed.length && !s.allowed.some((e) => addressMatches(from, e))) {
    return { ok: false, reason: `Sender ${from || '<>'} is not allowed to relay` };
  }
  if (s.mode === 'fixed') return { ok: true, sendAs: s.fixedAddress.trim() };
  if (!from) return { ok: false, reason: 'Empty sender (<>) needs fixed-sender mode' };
  return { ok: true, sendAs: from };
}

/**
 * In fixed-sender mode the upstream mailbox must match the From header (Graph returns ErrorSendAsDenied
 * otherwise), so rewrite From and keep the original author reachable through Reply-To.
 */
export function applySenderRewrite(s: Settings['sender'], raw: Buffer): Buffer {
  if (s.mode !== 'fixed' || !s.rewriteFrom) return raw;
  return rewriteFrom(raw, s.fixedAddress);
}

/** Set the From header to `address`; the original From (if different) is kept as Reply-To unless one exists. */
export function rewriteFrom(raw: Buffer, address: string): Buffer {
  const headers = parseHeaders(splitMessage(raw).head);
  const original = getHeader(headers, 'from');
  if (original.toLowerCase().includes(address.toLowerCase())) return raw;
  const add: Record<string, string> = {};
  if (original) add['Reply-To'] = original;
  return rewriteHeaders(raw, { set: { From: address }, add });
}
