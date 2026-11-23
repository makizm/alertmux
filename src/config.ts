import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Config {
  dataDir: string;
  httpHost: string;
  httpPort: number;
  /** Initial SMTP port used only until the port is changed in the admin UI. */
  smtpPort: number;
  adminPassword: string;
  secretKey: string;
  /** 'auto' sets the Secure cookie flag when the request arrived over HTTPS (directly or via X-Forwarded-Proto). */
  cookieSecure: 'auto' | 'always' | 'never';
  trustProxy: boolean;
  publicDir: string;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, got "${v}"`);
  return n;
}

/**
 * SECRET_KEY encrypts stored credentials. If it isn't provided, one is generated on first start and kept in
 * DATA_DIR/secret.key so stored secrets stay readable across restarts.
 */
function loadSecretKey(dataDir: string): string {
  if (process.env.SECRET_KEY) return process.env.SECRET_KEY;
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const key = randomBytes(32).toString('base64url');
  writeFileSync(file, key + '\n', { mode: 0o600 });
  console.warn(`[config] SECRET_KEY not set; generated one at ${file}. Back it up with the database.`);
  return key;
}

export function loadConfig(): Config {
  const dataDir = resolve(process.env.DATA_DIR ?? './data');
  mkdirSync(join(dataDir, 'spool'), { recursive: true });

  const adminPassword = process.env.ADMIN_PASSWORD ?? '';
  if (adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD must be set (at least 8 characters).');
  }

  const cookieSecure = (process.env.COOKIE_SECURE ?? 'auto') as Config['cookieSecure'];
  if (!['auto', 'always', 'never'].includes(cookieSecure)) throw new Error('COOKIE_SECURE must be auto, always or never');

  return {
    dataDir,
    httpHost: process.env.HTTP_HOST ?? '0.0.0.0',
    httpPort: intEnv('HTTP_PORT', 8080),
    smtpPort: intEnv('SMTP_PORT', 25),
    adminPassword,
    secretKey: loadSecretKey(dataDir),
    cookieSecure,
    trustProxy: process.env.TRUST_PROXY === 'true',
    publicDir: resolve(import.meta.dirname, '..', 'public'),
  };
}
