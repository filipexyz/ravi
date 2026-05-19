import { nats } from "../../../nats.js";
import { matchesTopicGlob } from "../../../events/topic-glob.js";
import type { StreamChannel, StreamChannelMatch, StreamEvent, StreamRequestContext } from "./types.js";

const SESSION_DEBUG_EVENT_PATTERNS = ["prompt", "response", "stream", "tool", "runtime", "claude", "delivery"] as const;
const DEFAULT_SESSION_DEBUG_TIMEOUT_MS = 60_000;

export const defaultStreamChannels: StreamChannel[] = [
  {
    name: "events",
    match: exact("events", { permission: "view", objectType: "system", objectId: "events" }),
    subscribe: subscribeEvents,
  },
  {
    name: "tasks",
    match: exact("tasks", { permission: "view", objectType: "system", objectId: "tasks" }),
    subscribe: subscribeTasks,
  },
  {
    name: "sessions",
    match(segments) {
      if (segments.length !== 2 || segments[0] !== "sessions" || !segments[1]) return null;
      const sessionName = segments[1];
      return {
        channelPath: `sessions/${sessionName}`,
        scope: { permission: "access", objectType: "session", objectId: sessionName },
      };
    },
    subscribe: subscribeSession,
  },
  {
    name: "chats",
    match(segments) {
      if (segments.length !== 2 || segments[0] !== "chats" || !segments[1]) return null;
      const chatId = segments[1];
      return {
        channelPath: `chats/${chatId}`,
        scope: { permission: "view", objectType: "chat", objectId: chatId },
      };
    },
    subscribe: subscribeChat,
  },
  {
    name: "instances",
    match(segments) {
      if (segments.length !== 2 || segments[0] !== "instances" || !segments[1]) return null;
      const instanceId = segments[1];
      return {
        channelPath: `instances/${instanceId}`,
        scope: { permission: "view", objectType: "instance", objectId: instanceId },
      };
    },
    subscribe: subscribeInstance,
  },
  {
    name: "audit",
    match: exact("audit", { permission: "view", objectType: "system", objectId: "audit" }),
    subscribe: subscribeAudit,
  },
];

function exact(
  segment: string,
  scope: StreamChannelMatch["scope"],
): (segments: string[], url: URL) => StreamChannelMatch | null {
  return (segments) => (segments.length === 1 && segments[0] === segment ? { channelPath: segment, scope } : null);
}

async function* subscribeEvents(ctx: StreamRequestContext): AsyncIterable<StreamEvent> {
  const subject = ctx.url.searchParams.get("subject")?.trim() || ">";
  const filter = ctx.url.searchParams.get("filter")?.trim();
  const only = ctx.url.searchParams.get("only")?.trim().toLowerCase();
  const noClaude = boolParam(ctx.url.searchParams.get("noClaude") ?? ctx.url.searchParams.get("no-claude"));
  const noHeartbeat = boolParam(ctx.url.searchParams.get("noHeartbeat") ?? ctx.url.searchParams.get("no-heartbeat"));

  let count = 0;
  for await (const item of subscribeAbortable(ctx.signal, subject)) {
    if (filter && !matchesTopicGlob(item.topic, filter)) continue;
    if (only && !matchesOnly(item.topic, only)) continue;
    if (noClaude && item.topic.includes(".claude")) {
      const type = typeof item.data.type === "string" ? item.data.type : undefined;
      if (type && type !== "result" && type !== "system") continue;
    }
    if (noHeartbeat && (item.topic.includes("heartbeat") || item.data._heartbeat === true)) continue;
    if (
      item.topic.includes("presence.typing") ||
      item.topic.includes("chat.unread-updated") ||
      item.topic.includes(".stream") ||
      item.topic.startsWith("message.") ||
      item.topic.startsWith("reaction.") ||
      item.topic.startsWith("instance.")
    ) {
      continue;
    }
    if (item.topic.includes(".claude") && item.data.type === "stream_event") continue;
    count++;
    yield {
      event: "message",
      data: {
        type: "event",
        count,
        topic: item.topic,
        data: item.data,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

async function* subscribeTasks(ctx: StreamRequestContext): AsyncIterable<StreamEvent> {
  const taskId = ctx.url.searchParams.get("taskId")?.trim();
  const pattern = taskId ? `ravi.task.${taskId}.event` : "ravi.task.*.event";
  for await (const item of subscribeAbortable(ctx.signal, pattern)) {
    yield {
      event: "task",
      data: {
        type: "task.event",
        topic: item.topic,
        ...item.data,
      },
    };
  }
}

async function* subscribeSession(ctx: StreamRequestContext, match: StreamChannelMatch): AsyncIterable<StreamEvent> {
  const sessionName = match.scope.objectId;
  const timeoutMs = parseTimeoutMs(ctx.url.searchParams.get("timeout"));
  const localAbort = new AbortController();
  const abort = () => localAbort.abort();
  ctx.signal.addEventListener("abort", abort, { once: true });
  if (ctx.signal.aborted) localAbort.abort();
  let endedByTimeout = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          endedByTimeout = true;
          localAbort.abort();
        }, timeoutMs)
      : undefined;

  const patterns = [
    ...SESSION_DEBUG_EVENT_PATTERNS.map((kind) => `ravi.session.${sessionName}.${kind}`),
    "ravi.approval.request",
    "ravi.approval.response",
  ];

  try {
    for await (const item of subscribeAbortable(localAbort.signal, ...patterns)) {
      if (
        (item.topic === "ravi.approval.request" || item.topic === "ravi.approval.response") &&
        item.data.sessionName !== sessionName
      ) {
        continue;
      }
      yield {
        event: "session",
        data: {
          type: "session.event",
          sessionName,
          topic: item.topic,
          data: item.data,
          timestamp: new Date().toISOString(),
        },
      };
    }
    if (endedByTimeout) {
      yield {
        event: "end",
        data: {
          type: "stream.end",
          reason: "timeout",
          sessionName,
          timeoutMs,
          timestamp: new Date().toISOString(),
        },
      };
    }
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal.removeEventListener("abort", abort);
  }
}

async function* subscribeAudit(ctx: StreamRequestContext): AsyncIterable<StreamEvent> {
  for await (const item of subscribeAbortable(ctx.signal, "ravi.audit.>")) {
    yield {
      event: "audit",
      data: {
        type: "audit.event",
        topic: item.topic,
        data: item.data,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

export const CHAT_TOPIC_PATTERNS = [
  "message.received.>",
  "reaction.received.>",
  "presence.typing",
  "chat.unread-updated",
] as const;

export const INSTANCE_TOPIC_PATTERNS = ["instance.>"] as const;

async function* subscribeChat(ctx: StreamRequestContext, match: StreamChannelMatch): AsyncIterable<StreamEvent> {
  const chatId = match.scope.objectId;
  const source = subscribeAbortable(ctx.signal, ...CHAT_TOPIC_PATTERNS);
  yield* projectChatEvents(chatId, source);
}

async function* subscribeInstance(ctx: StreamRequestContext, match: StreamChannelMatch): AsyncIterable<StreamEvent> {
  const instanceId = match.scope.objectId;
  const source = subscribeAbortable(ctx.signal, ...INSTANCE_TOPIC_PATTERNS);
  yield* projectInstanceEvents(instanceId, source);
}

export async function* projectChatEvents(
  chatId: string,
  source: AsyncIterable<{ topic: string; data: Record<string, unknown> }>,
): AsyncIterable<StreamEvent> {
  for await (const item of source) {
    if (extractChatId(item.data) !== chatId) continue;
    yield {
      event: classifyChatEvent(item.topic),
      data: {
        type: "chat.event",
        chatId,
        topic: item.topic,
        data: item.data,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

export async function* projectInstanceEvents(
  instanceId: string,
  source: AsyncIterable<{ topic: string; data: Record<string, unknown> }>,
): AsyncIterable<StreamEvent> {
  for await (const item of source) {
    if (extractInstanceId(item.topic, item.data) !== instanceId) continue;
    yield {
      event: "instance",
      data: {
        type: "instance.event",
        instanceId,
        topic: item.topic,
        data: item.data,
        timestamp: new Date().toISOString(),
      },
    };
  }
}

export function classifyChatEvent(topic: string): string {
  if (topic.startsWith("message.")) return "message";
  if (topic.startsWith("reaction.")) return "reaction";
  if (topic === "presence.typing") return "presence";
  if (topic === "chat.unread-updated") return "unread";
  return "message";
}

export function extractChatId(data: Record<string, unknown>): string | undefined {
  const fromPayload = readString(asObject(data.payload)?.chatId);
  if (fromPayload) return fromPayload;
  return readString(data.chatId);
}

export function extractInstanceId(topic: string, data: Record<string, unknown>): string | undefined {
  const payload = asObject(data.payload);
  const metadata = asObject(data.metadata);
  const fromPayload = readString(payload?.instanceId);
  if (fromPayload) return fromPayload;
  const fromMetadata = readString(metadata?.instanceId);
  if (fromMetadata) return fromMetadata;
  const fromData = readString(data.instanceId);
  if (fromData) return fromData;
  // Subject format: {eventType}.{action}.{channelType}.{instanceId}
  const parts = topic.split(".");
  if (parts.length >= 4) return parts.slice(3).join(".");
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function* subscribeAbortable(
  signal: AbortSignal,
  ...patterns: string[]
): AsyncGenerator<{ topic: string; data: Record<string, unknown> }> {
  const stream = nats.subscribe(...patterns);
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<IteratorResult<{ topic: string; data: Record<string, unknown> }>>((resolve) => {
    resolveAbort = () => resolve({ value: undefined, done: true });
  });
  const abort = () => resolveAbort?.();
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([stream.next(), aborted]);
      if (next.done) break;
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await stream.return(undefined).catch(() => undefined);
  }
}

function boolParam(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseTimeoutMs(value: string | null): number {
  if (!value?.trim()) return DEFAULT_SESSION_DEBUG_TIMEOUT_MS;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SESSION_DEBUG_TIMEOUT_MS;
  return Math.floor(parsed * 1000);
}

function matchesOnly(topic: string, only: string): boolean {
  if (only === "prompt") return topic.includes(".prompt");
  if (only === "response") return topic.includes(".response");
  if (only === "tool") return topic.includes(".tool");
  if (only === "claude") return topic.includes(".claude");
  if (only === "runtime") return topic.includes(".runtime");
  if (only === "cli") return topic.includes(".cli.");
  if (only === "audit") return topic.includes("audit");
  return true;
}
