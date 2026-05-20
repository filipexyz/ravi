/**
 * Local mirror of the Console agent-inbox.
 *
 * Console owns the API and authorization. Local Ravi owns the durable mirror,
 * NATS publish, and triggers integration. See
 * `.ravi/specs/console/agent-inbox/local-polling/SPEC.md` in the Console repo
 * for the contract this module implements.
 */

export const INBOX_NATS_SUBJECT = "ravi.console.inbox.item" as const;

export type InboxSubscriptionStatus = "active" | "paused" | "errored";

export interface InboxSubscriptionRow {
  id: string;
  consoleUrl: string;
  organizationId: string;
  subscriptionId: string | null;
  installationId: string;
  status: InboxSubscriptionStatus;
  enabled: boolean;
  lastGeneration: number | null;
  lastSequence: number | null;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface InboxItemRow {
  id: number;
  consoleUrl: string;
  organizationId: string;
  subscriptionId: string;
  itemId: string;
  sequence: number;
  eventType: string;
  category: string;
  severity: string;
  dedupeKey: string;
  natsSubject: string;
  natsPayloadJson: string;
  deliveredAt: number | null;
  ackedAt: number | null;
  replayCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Wire shape returned by `GET /api/cli/inbox/pulse`. */
export interface ConsolePulseResponse {
  version: 1;
  changed: boolean;
  subscribed: boolean;
  subscription: ConsoleSubscriptionPayload | null;
  watermark: ConsoleWatermarkPayload;
}

export interface ConsoleWatermarkPayload {
  organizationId: string;
  generation: number;
  latestSequence: number;
  latestItemAt: string | null;
  cacheKey: string;
  updatedAt: string;
}

export interface ConsoleSubscriptionPayload {
  id: string;
  deliveryMode: string;
  lastDeliveredSequence: number;
  lastPollAt: string | null;
  localInstallationId: string;
  name: string | null;
  status: string;
}

/** Wire shape returned by `POST /api/cli/inbox/poll`. */
export interface ConsolePollResponse {
  version: 1;
  hasMore: boolean;
  items: ConsoleInboxItem[];
  leaseId: string;
  leaseSeconds: number;
  pollId: string;
  serverTime: string;
  subscription: ConsoleSubscriptionPayload;
}

export interface ConsoleInboxItem {
  id: string;
  itemId: string;
  sequence: number;
  dedupeKey: string;
  eventType: string;
  category: string;
  severity: string;
  sensitivity: string;
  title: string | null;
  summary: string | null;
  source: { type: string; id: string };
  actor: { type: string | null; id: string | null };
  target: { type: string | null; id: string | null };
  organization: { id: string };
  project: { id: string } | null;
  payload: Record<string, unknown> | null;
  links: Record<string, unknown> | null;
  occurredAt: string;
  createdAt: string;
  lease: {
    expiresAt: string;
    id: string;
    seconds: number;
  } | null;
}

/** Canonical NATS payload published per `console/agent-inbox/event-contract`. */
export interface InboxNatsPayload {
  version: 1;
  eventId: string;
  sequence: number;
  dedupeKey: string;
  eventType: string;
  category: string;
  severity: string;
  sensitivity: string;
  title: string | null;
  summary: string | null;
  organization: { id: string };
  project: { id: string } | null;
  source: { type: string; id: string };
  actor: { type: string | null; id: string | null };
  target: { type: string | null; id: string | null };
  payload: Record<string, unknown> | null;
  links: Record<string, unknown> | null;
  delivery: {
    subscriptionId: string;
    installationId: string;
    pollId: string;
    leaseId: string | null;
    localDeliveredAt: string;
    replayed?: boolean;
    replayCount?: number;
    replayedAt?: string;
  };
  occurredAt: string;
  createdAt: string;
}
