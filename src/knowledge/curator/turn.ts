// One curator turn (contract §13.3), following src/library/request-turn.ts:
// a fresh session per subject (`agent:<curatorAgent>:knowledge-curator:<runId>`)
// whose prompt comes from an external surface (`knowledge-curator`) with
// `actorType: "unknown"` and no contact, so it resolves to no capabilities.
// The gateway delivers nothing for this channel and the local indexer never
// reads its rows. Afterwards the session is retired and its chat.db rows are
// deleted, so the quoted messages and the JSON reply are not kept.

import { getRecentHistory } from "../../db.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import { nats } from "../../nats.js";
import { getAgent } from "../../router/config.js";
import {
  ensureUniqueName,
  expandHome,
  expireEphemeralSession,
  getOrCreateSession,
  resolveSession,
  updateSessionName,
} from "../../router/index.js";
import { deleteChatDbSessionMessages } from "../store/chat-db.js";
import { KNOWLEDGE_CURATOR_CHANNEL } from "../types.js";

export const CURATOR_TURN_TIMEOUT_MS = 5 * 60_000;
const SILENT_TOKEN = "@@SILENT@@";
const TERMINAL_TYPES = new Set(["turn.complete", "turn.failed", "turn.interrupted"]);
const RESPONSE_GRACE_MS = 500;

export type CuratorTurnOutcome =
  | { ok: true; reply: string; sessionKey: string; sessionName: string }
  | { ok: false; failure: string; sessionKey: string; sessionName: string | null };

type RuntimeEventStream = AsyncGenerator<{ topic: string; data: Record<string, unknown> }>;

export function curatorSessionKey(curatorAgentId: string, runId: string): string {
  return `agent:${curatorAgentId}:${KNOWLEDGE_CURATOR_CHANNEL}:${runId}`;
}

/** The prompt payload: an untrusted external surface, never the operator. */
export function buildCuratorPromptPayload(prompt: string, runId: string, now = Date.now()): Record<string, unknown> {
  const chatId = `curator:${runId}`;
  return {
    prompt,
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "default",
    source: {
      channel: KNOWLEDGE_CURATOR_CHANNEL,
      accountId: KNOWLEDGE_CURATOR_CHANNEL,
      chatId,
      sourceMessageId: runId,
      suppressPresence: true,
      actorType: "unknown",
    },
    context: {
      channelId: KNOWLEDGE_CURATOR_CHANNEL,
      channelName: "Knowledge curator",
      accountId: KNOWLEDGE_CURATOR_CHANNEL,
      chatId,
      messageId: runId,
      senderId: `knowledge-curator:${runId}`,
      senderName: "Knowledge curator",
      isGroup: false,
      timestamp: now,
      actorType: "unknown",
    },
  };
}

export interface CuratorTurnDeps {
  ensureSession?: (curatorAgentId: string, runId: string) => string | null;
  publishPrompt?: (sessionName: string, payload: Record<string, unknown>) => Promise<void>;
  subscribe?: (...topics: string[]) => RuntimeEventStream;
  readHistory?: (sessionName: string) => Array<{ role: string; content: string }>;
  timeoutMs?: number;
  graceMs?: number;
}

/** Creates the run's own session on the curator agent. Null when the agent is unknown. */
export function ensureCuratorSession(curatorAgentId: string, runId: string): string | null {
  const agent = getAgent(curatorAgentId);
  if (!agent) return null;
  const sessionKey = curatorSessionKey(curatorAgentId, runId);
  const existing = resolveSession(sessionKey);
  if (existing?.name) return existing.name;
  const base = `${curatorAgentId}-curator-${runId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase()}`.slice(0, 64);
  const name = ensureUniqueName(base);
  const session = getOrCreateSession(sessionKey, curatorAgentId, expandHome(agent.cwd), { name });
  if (!session.name) updateSessionName(session.sessionKey, name);
  return session.name ?? name;
}

/** Runs the turn and waits for its answer, at most 5 minutes. */
export async function runCuratorTurn(
  input: { curatorAgentId: string; runId: string; prompt: string },
  deps: CuratorTurnDeps = {},
): Promise<CuratorTurnOutcome> {
  const sessionKey = curatorSessionKey(input.curatorAgentId, input.runId);
  const sessionName = (deps.ensureSession ?? ensureCuratorSession)(input.curatorAgentId, input.runId);
  if (!sessionName) return { ok: false, failure: "curator agent not found", sessionKey, sessionName: null };
  const timeoutMs = deps.timeoutMs ?? CURATOR_TURN_TIMEOUT_MS;
  const subscribe = deps.subscribe ?? ((...topics: string[]) => nats.subscribe(...topics) as RuntimeEventStream);
  const stream = subscribe(`ravi.session.${sessionName}.response`, `ravi.session.${sessionName}.runtime`);
  const parts: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let collecting = true;

  const terminal = new Promise<{ type: string } | null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    (async () => {
      let ended = false;
      try {
        for await (const event of stream) {
          if (!collecting) return;
          if (event.topic.endsWith(".response")) {
            const text = typeof event.data.response === "string" ? event.data.response : "";
            if (text.trim() && text.trim() !== SILENT_TOKEN) parts.push(text);
            continue;
          }
          if (ended) continue;
          const type = event.data.type;
          if (typeof type !== "string" || !TERMINAL_TYPES.has(type)) continue;
          ended = true;
          resolve({ type });
        }
      } catch {
        // The subscription closed.
      }
    })();
  });

  try {
    await (deps.publishPrompt ?? publishSessionPrompt)(
      sessionName,
      buildCuratorPromptPayload(input.prompt, input.runId),
    );
  } catch {
    if (timer) clearTimeout(timer);
    closeStream(stream);
    return { ok: false, failure: "could not start the turn", sessionKey, sessionName };
  }

  const end = await terminal;
  if (end?.type === "turn.complete") {
    await new Promise((resolve) => setTimeout(resolve, deps.graceMs ?? RESPONSE_GRACE_MS));
  }
  collecting = false;
  if (timer) clearTimeout(timer);
  closeStream(stream);

  if (!end) return { ok: false, failure: "timeout", sessionKey, sessionName };
  if (end.type !== "turn.complete") return { ok: false, failure: end.type, sessionKey, sessionName };
  let reply = parts.join("\n\n").trim();
  if (!reply) {
    try {
      const history = (deps.readHistory ?? ((name: string) => getRecentHistory(name, 5)))(sessionName);
      for (let index = history.length - 1; index >= 0; index--) {
        const row = history[index];
        if (row?.role === "assistant" && row.content.trim()) {
          reply = row.content.trim();
          break;
        }
      }
    } catch {
      reply = "";
    }
  }
  if (!reply) return { ok: false, failure: "empty answer", sessionKey, sessionName };
  return { ok: true, reply, sessionKey, sessionName };
}

/**
 * Retires the run's session (the ephemeral runner stops and deletes it) and
 * deletes its chat.db rows, by key and by name. Never throws.
 */
export function retireCuratorSession(input: { sessionKey: string; sessionName: string | null }): number {
  let deleted = 0;
  try {
    if (input.sessionKey.includes(`:${KNOWLEDGE_CURATOR_CHANNEL}:`)) expireEphemeralSession(input.sessionKey);
  } catch {
    // Already gone.
  }
  for (const id of new Set([input.sessionKey, input.sessionName].filter((value): value is string => Boolean(value)))) {
    try {
      deleted += deleteChatDbSessionMessages(id);
    } catch {
      // chat.db unavailable: the indexer still skips this channel.
    }
  }
  return deleted;
}

function closeStream(stream: RuntimeEventStream): void {
  void stream.return(undefined).catch(() => {});
}
