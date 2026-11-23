/** Global relay settings, stored as one JSON document and edited on the Settings page. */
export interface Settings {
  smtp: {
    enabled: boolean;
    port: number;
    bindAddress: string;
    /** Name used in the SMTP banner and EHLO response. */
    hostname: string;
    /** Client networks allowed to connect (CIDR or single IP). Empty list = any address. */
    allowedNetworks: string[];
    /** Require SMTP AUTH (PLAIN/LOGIN) with a relay user. Without TLS, passwords cross the network in clear text. */
    requireAuth: boolean;
    /** Expect a PROXY protocol header (e.g. behind AWS NLB / Spectrum) to learn the real client IP. */
    proxyProtocol: boolean;
    maxMessageMb: number;
    maxRecipients: number;
  };
  sender: {
    /** envelope: send as the MAIL FROM address. fixed: always send as fixedAddress. */
    mode: 'envelope' | 'fixed';
    /** Allowed MAIL FROM values: full addresses or "@domain". Empty list = any sender. */
    allowed: string[];
    fixedAddress: string;
    /** In fixed mode, rewrite the From header to fixedAddress (original goes to Reply-To if none set). */
    rewriteFrom: boolean;
  };
  delivery: {
    maxAttempts: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
    concurrency: number;
  };
  routing: {
    /** Destination used when no routing rule matches. */
    defaultDestinationId: string | null;
  };
  retention: {
    messagesDays: number;
    eventsDays: number;
    /** Delete the stored message body once every destination has accepted it. */
    deleteBodiesAfterSend: boolean;
  };
}

export function defaultSettings(smtpPort: number): Settings {
  return {
    smtp: {
      enabled: true,
      port: smtpPort,
      bindAddress: '0.0.0.0',
      hostname: 'alertmux.local',
      allowedNetworks: ['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
      requireAuth: false,
      proxyProtocol: false,
      maxMessageMb: 25,
      maxRecipients: 100,
    },
    sender: { mode: 'envelope', allowed: [], fixedAddress: '', rewriteFrom: true },
    delivery: { maxAttempts: 8, retryBaseSeconds: 30, retryMaxSeconds: 3600, concurrency: 4 },
    routing: { defaultDestinationId: null },
    retention: { messagesDays: 30, eventsDays: 30, deleteBodiesAfterSend: true },
  };
}

/** Deep-merge stored settings over defaults so new fields get defaults after upgrades. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  if (patch && typeof patch === 'object') {
    for (const [section, values] of Object.entries(patch as Record<string, unknown>)) {
      if (!(section in out) || !values || typeof values !== 'object') continue;
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        if (k in out[section]!) out[section]![k] = v;
      }
    }
  }
  return out as unknown as Settings;
}

/** Validate and normalize settings submitted from the UI. Returns a list of human-readable errors. */
export function validateSettings(s: Settings): string[] {
  const errors: string[] = [];
  const int = (v: unknown, min: number, max: number, label: string) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) errors.push(`${label} must be a whole number between ${min} and ${max}`);
  };
  int(s.smtp.port, 1, 65535, 'SMTP port');
  int(s.smtp.maxMessageMb, 1, 150, 'Max message size (MB)');
  int(s.smtp.maxRecipients, 1, 1000, 'Max recipients');
  int(s.delivery.maxAttempts, 1, 100, 'Max attempts');
  int(s.delivery.retryBaseSeconds, 1, 86400, 'Retry base delay');
  int(s.delivery.retryMaxSeconds, 1, 604800, 'Retry max delay');
  int(s.delivery.concurrency, 1, 32, 'Concurrency');
  int(s.retention.messagesDays, 1, 3650, 'Message retention');
  int(s.retention.eventsDays, 1, 3650, 'Event retention');
  for (const n of s.smtp.allowedNetworks) if (!parseCidr(n)) errors.push(`Invalid network: ${n}`);
  for (const a of s.sender.allowed) if (!/^([^@\s]+)?@[^@\s]+\.[^@\s]+$/.test(a)) errors.push(`Invalid allowed sender: ${a}`);
  if (s.sender.mode === 'fixed' && !/^[^@\s]+@[^@\s]+$/.test(s.sender.fixedAddress)) errors.push('Fixed sender address is required in fixed mode');
  if (!s.smtp.hostname.trim()) errors.push('SMTP hostname is required');
  return errors;
}

export function parseCidr(input: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [addr, pre] = input.trim().split('/');
  if (!addr) return null;
  const family = addr.includes(':') ? 'ipv6' : 'ipv4';
  const max = family === 'ipv4' ? 32 : 128;
  const prefix = pre === undefined ? max : Number(pre);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  if (family === 'ipv4' && !/^(\d{1,3})(\.\d{1,3}){3}$/.test(addr)) return null;
  return { address: addr, prefix, family };
}
