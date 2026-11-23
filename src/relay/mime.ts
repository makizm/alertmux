/**
 * Minimal RFC 5322 header handling: enough to show messages in the log and to add/replace a few headers
 * without touching the body.
 */

export interface SplitMessage {
  /** Raw header block including the trailing blank line separator. */
  head: string;
  body: Buffer;
  eol: '\r\n' | '\n';
}

export function splitMessage(raw: Buffer): SplitMessage {
  let idx = raw.indexOf('\r\n\r\n');
  let eol: '\r\n' | '\n' = '\r\n';
  const lf = raw.indexOf('\n\n');
  if (idx === -1 || (lf !== -1 && lf < idx)) {
    if (lf !== -1) { idx = lf; eol = '\n'; }
  }
  if (idx === -1) return { head: raw.toString('latin1') + '\r\n\r\n', body: Buffer.alloc(0), eol: '\r\n' };
  const sep = eol.length * 2;
  return { head: raw.subarray(0, idx + sep).toString('latin1'), body: raw.subarray(idx + sep), eol };
}

/** Parsed headers in order, with folded lines joined. Names keep their original case. */
export function parseHeaders(head: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (line === '') break;
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1]!.value += ' ' + line.trim();
      continue;
    }
    const i = line.indexOf(':');
    if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out;
}

export function getHeader(headers: { name: string; value: string }[], name: string): string {
  const n = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === n)?.value ?? '';
}

/** Decode RFC 2047 encoded-words (=?charset?B|Q?...?=) for display. */
export function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      try {
        const bytes = enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        return new TextDecoder(charset.toLowerCase().replace(/\*.*$/, '')).decode(bytes);
      } catch {
        return text;
      }
    });
}

/** Extract bare email addresses from an address-list header value. */
export function extractAddresses(value: string): string[] {
  const found = value.match(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/g) ?? [];
  return found.map((a) => a.toLowerCase());
}

/** Summary used for the message log. */
export function summarize(raw: Buffer) {
  const { head } = splitMessage(raw);
  const h = parseHeaders(head);
  return {
    headerFrom: decodeWords(getHeader(h, 'from')).slice(0, 500),
    subject: decodeWords(getHeader(h, 'subject')).slice(0, 500),
    messageId: getHeader(h, 'message-id').slice(0, 500),
    headers: h,
  };
}

/**
 * Return a copy of the message with headers changed. `set` replaces every existing header of that name
 * (or adds it), `add` only adds when the header isn't present. Body bytes are untouched.
 */
export function rewriteHeaders(raw: Buffer, changes: { set?: Record<string, string>; add?: Record<string, string> }): Buffer {
  const { head, body, eol } = splitMessage(raw);
  const lines = head.split(/\r?\n/);
  // Drop the trailing empty lines (separator) and rebuild header units (header + continuation lines).
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const units: string[][] = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && units.length) units[units.length - 1]!.push(l);
    else units.push([l]);
  }
  const nameOf = (u: string[]) => u[0]!.slice(0, Math.max(0, u[0]!.indexOf(':'))).trim().toLowerCase();
  let kept = units;
  const extra: string[] = [];
  for (const [name, value] of Object.entries(changes.set ?? {})) {
    kept = kept.filter((u) => nameOf(u) !== name.toLowerCase());
    extra.push(`${name}: ${value}`);
  }
  for (const [name, value] of Object.entries(changes.add ?? {})) {
    if (!kept.some((u) => nameOf(u) === name.toLowerCase())) extra.push(`${name}: ${value}`);
  }
  const newHead = [...extra, ...kept.map((u) => u.join(eol))].join(eol) + eol + eol;
  return Buffer.concat([Buffer.from(newHead, 'latin1'), body]);
}

/** Build a simple text/plain message (used by the Test send page). */
export function buildTextMessage(o: { from: string; to: string[]; subject: string; text: string; hostname: string }): Buffer {
  const encSubject = /^[\x20-\x7e]*$/.test(o.subject) ? o.subject : `=?UTF-8?B?${Buffer.from(o.subject).toString('base64')}?=`;
  const id = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${o.hostname}>`;
  const head = [
    `From: ${o.from}`,
    `To: ${o.to.join(', ')}`,
    `Subject: ${encSubject}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ].join('\r\n');
  const body = Buffer.from(o.text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${head}\r\n\r\n${body}\r\n`, 'utf8');
}
