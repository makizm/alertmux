import { createPrivateKey, createSign, randomUUID, X509Certificate } from 'node:crypto';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Sign a JWT with RS256 using a PEM private key. */
export function signJwtRS256(header: Record<string, unknown>, claims: Record<string, unknown>, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const input = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...header }))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign('RSA-SHA256').update(input).sign(key);
  return `${input}.${b64url(sig)}`;
}

/**
 * Entra ID certificate credential: a client assertion JWT whose header carries the certificate thumbprint.
 * Works the same in commercial, GCC High, DoD and China clouds.
 */
export function entraClientAssertion(o: { clientId: string; tokenUrl: string; certificatePem: string; privateKeyPem: string }): string {
  const cert = new X509Certificate(o.certificatePem);
  const sha1 = Buffer.from(cert.fingerprint.replace(/:/g, ''), 'hex');
  const sha256 = Buffer.from(cert.fingerprint256.replace(/:/g, ''), 'hex');
  const now = Math.floor(Date.now() / 1000);
  return signJwtRS256(
    { x5t: b64url(sha1), 'x5t#S256': b64url(sha256) },
    { aud: o.tokenUrl, iss: o.clientId, sub: o.clientId, jti: randomUUID(), nbf: now - 60, iat: now, exp: now + 600 },
    o.privateKeyPem,
  );
}
