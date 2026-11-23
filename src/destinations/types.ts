import type { DestinationRecord } from '../db.ts';

export interface Envelope {
  /** Mailbox to send as (MAIL FROM, or the fixed sender after policy). */
  from: string;
  to: string[];
}

export type DeliveryResult =
  | { kind: 'ok'; code: string; detail: string; upstreamId?: string }
  /** Temporary failure: try again. `retryAfterMs` overrides the backoff when the upstream told us when. */
  | { kind: 'retry'; code: string; detail: string; retryAfterMs?: number }
  | { kind: 'permanent'; code: string; detail: string };

export interface TestResult {
  ok: boolean;
  detail: string;
}

/** A place a message can be delivered to. New kinds (Teams, Slack, webhook) implement the same contract. */
export interface Destination {
  readonly record: DestinationRecord;
  /** Largest raw message this destination accepts, in bytes. */
  readonly maxMessageBytes: number;
  deliver(envelope: Envelope, mime: Buffer): Promise<DeliveryResult>;
  test(opts: { address?: string }): Promise<TestResult>;
}

export function errorDetail(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${e.message}: ${cause.message}` : e.message;
  }
  return String(e);
}
