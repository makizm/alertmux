import type { DestinationKind, DestinationRecord, Store } from '../db.ts';
import { SlackDestination, TeamsWebhookDestination, validateSlackConfig, validateTeamsConfig } from './chat.ts';
import { GoogleSmtpDestination, validateGoogleConfig } from './google.ts';
import { MicrosoftGraphDestination, validateMicrosoftConfig } from './microsoft.ts';
import type { Destination } from './types.ts';

type Validator = (config: Record<string, unknown>, secrets: Record<string, string | null>, existing: Record<string, string>) => string[];

/**
 * Every destination type. Adding a type = one entry here plus its class. The UI's "Add destination" menu
 * is built from this list.
 */
export const DESTINATION_KINDS: Record<DestinationKind, {
  label: string;
  /** 'mail' delivers the original message; 'chat' posts a summary to a channel. */
  category: 'mail' | 'chat';
  secretKeys: string[];
  validate: Validator;
  build: (record: DestinationRecord, fetchImpl: typeof fetch) => Destination;
}> = {
  'microsoft-graph': {
    label: 'Microsoft 365 (Graph API)', category: 'mail', secretKeys: ['clientSecret', 'certificatePem', 'privateKeyPem'],
    validate: validateMicrosoftConfig, build: (r, f) => new MicrosoftGraphDestination(r, f),
  },
  'google-smtp': {
    label: 'Google Workspace (SMTP)', category: 'mail', secretKeys: ['password', 'serviceAccountJson'],
    validate: validateGoogleConfig, build: (r, f) => new GoogleSmtpDestination(r, f),
  },
  'teams-webhook': {
    label: 'Microsoft Teams channel', category: 'chat', secretKeys: ['webhookUrl'],
    validate: validateTeamsConfig, build: (r, f) => new TeamsWebhookDestination(r, f),
  },
  slack: {
    label: 'Slack channel', category: 'chat', secretKeys: ['webhookUrl', 'botToken'],
    validate: validateSlackConfig, build: (r, f) => new SlackDestination(r, f),
  },
};

export function validateDestination(kind: DestinationKind, config: Record<string, unknown>, secrets: Record<string, string | null>, existing: Record<string, string>): string[] {
  const k = DESTINATION_KINDS[kind];
  return k ? k.validate(config, secrets, existing) : ['Unknown destination type'];
}

/**
 * Builds destination instances and keeps them while their record is unchanged, so access tokens stay cached
 * between deliveries. Editing a destination bumps updatedAt and gets a fresh instance (fresh token).
 */
export class DestinationRegistry {
  readonly #store: Store;
  readonly #fetch: typeof fetch;
  readonly #cache = new Map<string, Destination>();

  constructor(store: Store, fetchImpl: typeof fetch = fetch) {
    this.#store = store;
    this.#fetch = fetchImpl;
  }

  build(record: DestinationRecord): Destination {
    return DESTINATION_KINDS[record.kind].build(record, this.#fetch);
  }

  get(id: string): Destination | undefined {
    const record = this.#store.getDestination(id);
    if (!record || !(record.kind in DESTINATION_KINDS)) { this.#cache.delete(id); return undefined; }
    const cached = this.#cache.get(id);
    if (cached && cached.record.updatedAt === record.updatedAt) return cached;
    const d = this.build(record);
    this.#cache.set(id, d);
    return d;
  }
}
