/**
 * Canonical creation lifecycle events for agents and sessions.
 *
 * Topics live under `ravi.agents.*` and `ravi.sessions.*` (plural) on purpose:
 * the trigger runner skips `ravi.session.*` subscriptions to prevent loops, so
 * subjects under that prefix could never be used by user triggers.
 *
 * Emission is best-effort and fire-and-forget: it happens after the row is
 * persisted and never fails or blocks the write that produced it.
 */

import { logger } from "../utils/logger.js";

const log = logger.child("lifecycle-events");

export const AGENT_CREATED_TOPIC = "ravi.agents.created";
export const SESSION_CREATED_TOPIC = "ravi.sessions.created";

export interface AgentCreatedEvent {
  version: 1;
  eventType: "agent.created";
  agentId: string;
  name: string | null;
  provider: string | null;
  mode: string | null;
  createdAt: number;
  occurredAt: string;
}

export interface SessionCreatedEvent {
  version: 1;
  eventType: "session.created";
  sessionKey: string;
  sessionName: string | null;
  agentId: string;
  channel: string | null;
  accountId: string | null;
  chatType: string | null;
  createdAt: number;
  occurredAt: string;
  /** Set when the session belongs to a trigger, so the trigger runner skips it (anti-loop). */
  _trigger?: true;
}

export type LifecycleEventPublisher = (topic: string, data: Record<string, unknown>) => Promise<void>;

async function defaultPublisher(topic: string, data: Record<string, unknown>): Promise<void> {
  // Never publish from the test runner by default: a developer's live daemon
  // could otherwise receive fake creation events and fire real triggers.
  if (process.env.NODE_ENV === "test") return;
  const mod = (await import("../nats.js")) as {
    publish?: LifecycleEventPublisher;
    nats?: { emit?: LifecycleEventPublisher };
  };
  const publish = mod.publish ?? mod.nats?.emit;
  if (publish) await publish(topic, data);
}

let publisher: LifecycleEventPublisher = defaultPublisher;

/** Test hook: replace the publisher. Pass null to restore the default. */
export function setLifecycleEventPublisher(next: LifecycleEventPublisher | null): void {
  publisher = next ?? defaultPublisher;
}

function emitBestEffort(topic: string, data: Record<string, unknown>): void {
  try {
    publisher(topic, data).catch((error) => {
      log.debug("Failed to emit lifecycle event", { topic, error: String(error) });
    });
  } catch (error) {
    log.debug("Failed to emit lifecycle event", { topic, error: String(error) });
  }
}

export function buildAgentCreatedEvent(input: {
  id: string;
  name?: string | null;
  provider?: string | null;
  mode?: string | null;
  createdAt: number;
}): AgentCreatedEvent {
  return {
    version: 1,
    eventType: "agent.created",
    agentId: input.id,
    name: input.name ?? null,
    provider: input.provider ?? null,
    mode: input.mode ?? null,
    createdAt: input.createdAt,
    occurredAt: new Date().toISOString(),
  };
}

export function buildSessionCreatedEvent(input: {
  sessionKey: string;
  name?: string | null;
  agentId: string;
  channel?: string | null;
  accountId?: string | null;
  chatType?: string | null;
  createdAt: number;
}): SessionCreatedEvent {
  return {
    version: 1,
    eventType: "session.created",
    sessionKey: input.sessionKey,
    sessionName: input.name ?? null,
    agentId: input.agentId,
    channel: input.channel ?? null,
    accountId: input.accountId ?? null,
    chatType: input.chatType ?? null,
    createdAt: input.createdAt,
    occurredAt: new Date().toISOString(),
    ...(input.sessionKey.includes(":trigger:") ? { _trigger: true as const } : {}),
  };
}

export function emitAgentCreated(event: AgentCreatedEvent): void {
  emitBestEffort(AGENT_CREATED_TOPIC, event as unknown as Record<string, unknown>);
}

export function emitSessionCreated(event: SessionCreatedEvent): void {
  emitBestEffort(SESSION_CREATED_TOPIC, event as unknown as Record<string, unknown>);
}
