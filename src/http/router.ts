import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

export class HttpError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  ip: string;
  /** Parsed JSON body (max 1 MB). */
  json<T = any>(): Promise<T>;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type Route = { method: string; re: RegExp; keys: string[]; handler: Handler };

/** Minimal router: exact methods, ":param" segments, JSON responses for returned values. */
export class Router {
  readonly #routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_m, k: string) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.#routes.push({ method, re, keys, handler });
    return this;
  }
  get(p: string, h: Handler) { return this.on('GET', p, h); }
  post(p: string, h: Handler) { return this.on('POST', p, h); }
  put(p: string, h: Handler) { return this.on('PUT', p, h); }
  delete(p: string, h: Handler) { return this.on('DELETE', p, h); }

  /** Returns false when no route matched the path. */
  async dispatch(ctx: Omit<Ctx, 'params'>): Promise<boolean> {
    const path = ctx.url.pathname;
    let pathMatched = false;
    for (const r of this.#routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== ctx.req.method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      const out = await r.handler({ ...ctx, params });
      if (out !== undefined && !ctx.res.headersSent) sendJson(ctx.res, 200, out);
      else if (!ctx.res.headersSent && !ctx.res.writableEnded) { ctx.res.statusCode = 204; ctx.res.end(); }
      return true;
    }
    if (pathMatched) throw new HttpError(405, 'Method not allowed');
    return false;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

export async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

/** Resolve a URL path to a file under `root` ("/messages" → messages.html, "/" → index.html). */
export function resolveStatic(root: string, pathname: string): string | null {
  let p = decodeURIComponent(pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (!extname(p)) p += '.html';
  const file = normalize(join(root, p));
  if (!file.startsWith(root + sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function serveFile(res: ServerResponse, file: string) {
  const ext = extname(file);
  const st = statSync(file);
  const etag = `W/"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
  // Always revalidate (cheap 304s) so a new version of the UI is picked up right after an upgrade.
  if (res.req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache', etag });
  createReadStream(file).pipe(res);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
