/**
 * Just enough MIME parsing to post an email into a chat channel: the readable text body (text/plain, or
 * text/html converted to text) and the names of attachments. Not a general-purpose MIME library.
 */
import { decodeWords, getHeader, parseHeaders, splitMessage } from './mime.ts';

export interface AttachmentInfo {
  filename: string;
  contentType: string;
  /** Decoded size in bytes (approximate for base64). */
  size: number;
  /** An image embedded in the HTML body (has a Content-ID and isn't marked as an attachment), not a file attachment. */
  inline: boolean;
}

export interface ReadableMessage {
  text: string;
  /** True when the body came from HTML (no text/plain part). */
  fromHtml: boolean;
  /** The decoded HTML part, if any (also when `text` came from text/plain), so callers can render it their own way. */
  html: string | null;
  attachments: AttachmentInfo[];
}

/** Parse "type/subtype; a=1; b="x;y"" into type + lowercase-keyed params. Handles RFC 2231 name*=. */
export function parseHeaderParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const params: Record<string, string> = {};
  const continued: Record<string, string[]> = {};
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    const m = /^([^*]+)\*(\d+)?\*?$/.exec(key);
    if (m) {
      // RFC 2231: name*=utf-8''encoded or name*0*=..., name*1*=...
      (continued[m[1]!] ??= [])[Number(m[2] ?? 0)] = v;
    } else {
      params[key] = v;
    }
  }
  for (const [k, pieces] of Object.entries(continued)) {
    const joined = pieces.join('');
    const enc = /^([^']*)'[^']*'(.*)$/.exec(joined);
    try {
      params[k] = enc ? new TextDecoder(enc[1] || 'utf-8').decode(Buffer.from(enc[2]!.replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')) : joined;
    } catch {
      params[k] = joined;
    }
  }
  return { value: (parts[0] ?? '').trim().toLowerCase(), params };
}

function decodeQuotedPrintable(s: string): Buffer {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(src.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body.toString('latin1'));
  return body;
}

function toText(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder((charset || 'utf-8').toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** Convert HTML to readable plain text (paragraphs, line breaks, list items, links kept as "text (url)"). */
/**
 * How links come out of htmlToText:
 * - inline: `text (url)`, for plain-text destinations
 * - markdown: `[text](url)`, for renderers that make links clickable (Teams Adaptive Cards)
 * - none: just the link text, for short previews
 */
export type LinkStyle = 'inline' | 'markdown' | 'none';

export function htmlToText(html: string, links: LinkStyle = 'inline'): string {
  return html
    .replace(/<(head|style|script|title|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Source line breaks are just whitespace in HTML (except inside <pre>); structure comes from the tags.
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => body.replace(/\r?\n/g, '<br>'))
    .replace(/\s+/g, ' ')
    // Preheader text and tracking pixels that mail clients never show.
    .replace(/<(span|div|p|td)\b[^>]*style=["'][^"']*display:\s*none[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Embedded (cid:) images become a marker line; remote images (logos, trackers) are dropped.
    .replace(/<img\b[^>]*>/gi, (tag) => {
      if (links === 'none' || !/\ssrc=["']cid:/i.test(tag)) return '';
      const alt = /\salt=["']([^"']*)["']/i.exec(tag)?.[1]?.trim();
      return `\n🖼 ${alt || 'image'}\n`;
    })
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const t = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const url = href.replace(/&amp;/g, '&');
      if (!t) return links === 'none' ? '' : url;
      if (links === 'none' || t === url || url.startsWith('mailto:')) return t;
      return links === 'markdown' ? `[${t.replace(/[[\]]/g, '')}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')})` : `${t} (${url})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    // Paragraph-level blocks get a blank line after them; rows and divs a single break.
    .replace(/<\/(p|h[1-6]|ul|ol|table|blockquote)>/gi, '\n\n')
    .replace(/<\/(div|tr)>/gi, '\n')
    .replace(/<\/t[dh]>\s*(?=<t[dh][\s>])/gi, ' · ')
    .replace(/<(td|th)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#') && k !== '#39') return String.fromCodePoint(Number(k.slice(1)));
      return ENTITIES[k] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Walk the MIME tree and pull out the first text/plain, first text/html, and every attachment. */
export function readMessage(raw: Buffer): ReadableMessage {
  let plain: string | null = null;
  let html: string | null = null;
  const attachments: AttachmentInfo[] = [];

  const walk = (part: Buffer, depth: number) => {
    const { head, body } = splitMessage(part);
    const headers = parseHeaders(head);
    const ct = parseHeaderParams(getHeader(headers, 'content-type') || 'text/plain');
    const cd = parseHeaderParams(getHeader(headers, 'content-disposition'));
    const filename = decodeWords(cd.params.filename ?? ct.params.name ?? '');
    const encoding = getHeader(headers, 'content-transfer-encoding') || '7bit';

    if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 10) {
      const boundary = `--${ct.params.boundary}`;
      const text = body.toString('latin1');
      const pieces = text.split(new RegExp(`(?:^|\\r?\\n)${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
      // pieces[0] is the preamble, the last one the epilogue after the closing boundary.
      for (const p of pieces.slice(1)) if (p.trim()) walk(Buffer.from(p, 'latin1'), depth + 1);
      return;
    }
    const isAttachment = cd.value === 'attachment' || !!filename || ct.value === 'message/rfc822' ||
      !(ct.value.startsWith('text/') || ct.value.startsWith('multipart/'));
    if (isAttachment) {
      const inline = ct.value.startsWith('image/') && !!getHeader(headers, 'content-id') && cd.value !== 'attachment';
      attachments.push({ filename: filename || `(unnamed ${ct.value})`, contentType: ct.value, size: decodeBody(body, encoding).length, inline });
      return;
    }
    if (ct.value === 'text/plain' && plain === null) plain = toText(decodeBody(body, encoding), ct.params.charset);
    else if (ct.value === 'text/html' && html === null) html = toText(decodeBody(body, encoding), ct.params.charset);
  };

  walk(raw, 0);
  const p = plain as string | null;
  const hm = html as string | null;
  if (p !== null && p.trim()) return { text: p.replace(/\r\n/g, '\n').trim(), fromHtml: false, html: hm, attachments };
  if (hm !== null) return { text: htmlToText(hm), fromHtml: true, html: hm, attachments };
  return { text: (p ?? '').trim(), fromHtml: false, html: null, attachments };
}
