import { nats } from "../../../nats.js";
import { matchesTopicGlob } from "../../../events/topic-glob.js";
import type { StreamChannel, StreamChannelMatch, StreamEvent, StreamRequestContext } from "./types.js";

const SESSION_DEBUG_EVENT_PATTERNS = ["prompt", "response", "stream", "tool", "runtime", "claude", "delivery"] as const;
const DEFAULT_SESSION_DEBUG_TIMEOUT_MS = 60_000;

// Shared payload schema fragments. Each channel-payload schema is a plain
// JSON Schema object so the SDK codegen (`src/sdk/client-codegen/`) can
// translate it to TypeScript and Swift without parsing TS source.
const TOPIC_EVENT_SCHEMA = {
  type: "object",
  required: ["type", "topic", "data"],
  additionalProperties: false,
  properties: {
    type: { type: "string" },
    topic: { type: "string" },
    data: {},
    timestamp: { type: "string" },
    count: { type: "number" },
  },
} as const;

const TASK_EVENT_SCHEMA = {
  type: "object",
  required: ["type", "topic"],
  additionalProperties: {},
  properties: {
    type: { const: "task.event" },
    topic: { type: "string" },
  },
} as const;

const SESSION_EVENT_SCHEMA = {
  type: "object",
  required: ["type", "sessionName"],
  additionalProperties: false,
  properties: {
    type: { enum: ["session.event", "stream.end"] },
    sessionName: { type: "string" },
    topic: { type: "string" },
    data: {},
    reason: { type: "string" },
    timeoutMs: { type: "number" },
    timestamp: { type: "string" },
  },
} as const;

const CHAT_EVENT_SCHEMA = {
  type: "object",
  required: ["type", "chatId", "topic", "data", "timestamp"],
  additionalProperties: false,
  properties: {
    type: { const: "chat.event" },
    chatId: { type: "string" },
    topic: { type: "string" },
    data: {},
    timestamp: { type: "string" },
  },
} as const;

const INSTANCE_EVENT_SCHEMA = {
  type: "object",
  required: ["type", "instanceId", "topic", "data", "timestamp"],
  additionalProperties: false,
  properties: {
    type: { const: "instance.event" },
    instanceId: { type: "string" },
    topic: { type: "string" },
    data: {},
    timestamp: { type: "string" },
  },
} as const;

const EMPTY_OPTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

// Omni envelope + sub-payload schemas. These mirror the shapes published by
// omni-v2 on `message.received.*` / `reaction.received.*` / `presence.typing` /
// `chat.unread-updated`. Used by the `chats` channel's `eventPayloads` so the
// SDK codegen can synthesise typed `decodeMessage()` / `decodeReaction()` /
// `decodePresenceTyping()` / `decodeUnread()` helpers on `ChatStreamPayload`.

const OMNI_EVENT_METADATA_SCHEMA = {
  type: "object",
  additionalProperties: {},
  properties: {
    instanceId: { type: "string" },
    channelType: { type: "string" },
    personId: { type: "string" },
    source: { type: "string" },
    ingestMode: { type: "string" },
  },
} as const;

const OMNI_MESSAGE_CONTENT_SCHEMA = {
  type: "object",
  required: ["type"],
  additionalProperties: {},
  properties: {
    type: { type: "string" },
    text: { type: "string" },
    mediaUrl: { type: "string" },
    mimeType: { type: "string" },
    localPath: { type: "string" },
    isVoiceNote: { type: "boolean" },
  },
} as const;

const OMNI_MESSAGE_RECEIVED_PAYLOAD_SCHEMA = {
  type: "object",
  required: ["externalId", "chatId", "from", "content"],
  additionalProperties: {},
  properties: {
    externalId: { type: "string" },
    chatId: { type: "string" },
    from: { type: "string" },
    content: OMNI_MESSAGE_CONTENT_SCHEMA,
    replyToId: { type: "string" },
  },
} as const;

const OMNI_MESSAGE_RECEIVED_ENVELOPE_SCHEMA = {
  type: "object",
  required: ["id", "type", "payload", "timestamp"],
  additionalProperties: {},
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    payload: OMNI_MESSAGE_RECEIVED_PAYLOAD_SCHEMA,
    metadata: OMNI_EVENT_METADATA_SCHEMA,
    timestamp: { type: "number" },
  },
} as const;

const OMNI_REACTION_RECEIVED_PAYLOAD_SCHEMA = {
  type: "object",
  required: ["messageId", "chatId", "from", "emoji"],
  additionalProperties: {},
  properties: {
    messageId: { type: "string" },
    chatId: { type: "string" },
    from: { type: "string" },
    emoji: { type: "string" },
  },
} as const;

const OMNI_REACTION_RECEIVED_ENVELOPE_SCHEMA = {
  type: "object",
  required: ["id", "type", "payload", "timestamp"],
  additionalProperties: {},
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    payload: OMNI_REACTION_RECEIVED_PAYLOAD_SCHEMA,
    metadata: OMNI_EVENT_METADATA_SCHEMA,
    timestamp: { type: "number" },
  },
} as const;

// presence.typing and chat.unread-updated come straight from omni-v2 without
// going through a documented internal envelope. The shapes here are
// best-effort, surfacing the fields we can rely on across providers;
// channels that need more reach for the raw `data` (RaviJSON) directly.

const CHAT_PRESENCE_TYPING_SCHEMA = {
  type: "object",
  additionalProperties: {},
  properties: {
    chatId: { type: "string" },
    from: { type: "string" },
    isTyping: { type: "boolean" },
    timestamp: { type: "number" },
  },
} as const;

const CHAT_UNREAD_UPDATED_SCHEMA = {
  type: "object",
  additionalProperties: {},
  properties: {
    chatId: { type: "string" },
    unreadCount: { type: "integer" },
    lastReadMessageId: { type: "string" },
    timestamp: { type: "number" },
  },
} as const;

export const defaultStreamChannels: StreamChannel[] = [
  {
    name: "events",
    meta: {
      methodName: "events",
      pathPattern: "events",
      description:
        "Subscribe to the full NATS event bus. Mirrors `ravi events stream` and " +
        "suppresses the same noisy topics (message.*, reaction.*, instance.*, " +
        "presence.typing, chat.unread-updated, .stream, claude stream chunks).",
      optionsTypeName: "EventsStreamOptions",
      payloadTypeName: "GatewayTopicEvent",
      optionsSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string" },
          filter: { type: "string" },
          only: { type: "string" },
          noClaude: { type: "boolean" },
          noHeartbeat: { type: "boolean" },
        },
      },
      payloadSchema: TOPIC_EVENT_SCHEMA,
    },
    match: exact("events", { permission: "view", objectType: "system", objectId: "events" }),
    subscribe: subscribeEvents,
  },
  {
    name: "tasks",
    meta: {
      methodName: "tasks",
      pathPattern: "tasks",
      description: "Subscribe to task lifecycle events (`ravi.task.<id>.event`).",
      optionsTypeName: "TasksStreamOptions",
      payloadTypeName: "TaskStreamPayload",
      optionsSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
        },
      },
      payloadSchema: TASK_EVENT_SCHEMA,
    },
    match: exact("tasks", { permission: "view", objectType: "system", objectId: "tasks" }),
    subscribe: subscribeTasks,
  },
  {
    name: "sessions",
    meta: {
      methodName: "session",
      pathPattern: "sessions/{name}",
      description:
        "Subscribe to runtime debug events for a single session: prompts, responses, " +
        "streamed chunks, tool calls, provider runtime events, claude SDK events, " +
        "delivery telemetry, and approval request/response.",
      optionsTypeName: "SessionStreamOptions",
      payloadTypeName: "SessionStreamPayload",
      optionsSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          timeout: {
            type: "number",
            description: "Seconds before the stream emits `event: end` and closes. `0` means no natural timeout.",
          },
        },
      },
      payloadSchema: SESSION_EVENT_SCHEMA,
    },
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
    meta: {
      methodName: "chat",
      pathPattern: "chats/{chatId}",
      description:
        "Subscribe to the live event stream for a single chat: new messages, " +
        "reactions, presence/typing, and unread updates. The server filters by " +
        "`chatId` against the upstream omni payload — events for other chats are " +
        "discarded before reaching the client.",
      optionsTypeName: "ChatStreamOptions",
      payloadTypeName: "ChatStreamPayload",
      optionsSchema: EMPTY_OPTIONS_SCHEMA,
      payloadSchema: CHAT_EVENT_SCHEMA,
      eventNames: ["message", "reaction", "presence", "unread"],
      eventPayloads: {
        message: {
          typeName: "OmniMessageReceivedEnvelope",
          schema: OMNI_MESSAGE_RECEIVED_ENVELOPE_SCHEMA,
          helperName: "decodeMessage",
        },
        reaction: {
          typeName: "OmniReactionReceivedEnvelope",
          schema: OMNI_REACTION_RECEIVED_ENVELOPE_SCHEMA,
          helperName: "decodeReaction",
        },
        presence: {
          typeName: "PresenceTypingPayload",
          schema: CHAT_PRESENCE_TYPING_SCHEMA,
          helperName: "decodePresenceTyping",
        },
        unread: {
          typeName: "ChatUnreadUpdatedPayload",
          schema: CHAT_UNREAD_UPDATED_SCHEMA,
          helperName: "decodeUnread",
        },
      },
    },
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
    meta: {
      methodName: "instance",
      pathPattern: "instances/{instanceId}",
      description:
        "Subscribe to lifecycle events for a single omni instance: QR code, " +
        "connected, disconnected. Filtered server-side.",
      optionsTypeName: "InstanceStreamOptions",
      payloadTypeName: "InstanceStreamPayload",
      optionsSchema: EMPTY_OPTIONS_SCHEMA,
      payloadSchema: INSTANCE_EVENT_SCHEMA,
      eventNames: ["instance"],
    },
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
    meta: {
      methodName: "audit",
      pathPattern: "audit",
      description: "Subscribe to the global audit event stream (`ravi.audit.>`).",
      optionsTypeName: "AuditStreamOptions",
      payloadTypeName: "GatewayTopicEvent",
      optionsSchema: EMPTY_OPTIONS_SCHEMA,
      payloadSchema: TOPIC_EVENT_SCHEMA,
    },
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
