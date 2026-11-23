import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM encryption for credentials stored in the database. */
export class SecretBox {
  readonly #key: Buffer;

  constructor(secretKey: string) {
    this.#key = createHash('sha256').update('smtp-relay:secrets:' + secretKey).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  decrypt(box: string): string {
    if (!box.startsWith('v1:')) throw new Error('Unknown secret format');
    const raw = Buffer.from(box.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/** scrypt password hash: "scrypt$<salt>$<hash>" */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}
