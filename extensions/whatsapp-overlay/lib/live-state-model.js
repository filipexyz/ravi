export const BUSY_LIVE_TTL_MS = 2 * 60 * 1000;
export const MAX_LIVE_EVENTS = 8;

const TERMINAL_RUNTIME_TYPES = new Set(["turn.complete", "turn.interrupted", "silent"]);

export function defaultLiveState(session = {}) {
  if (session?.abortedLastRun) {
    return {
      activity: "blocked",
      summary: "last run aborted",
      updatedAt: numericTimestamp(session.updatedAt) || Date.now(),
      events: [],
    };
  }

  return {
    activity: "idle",
    updatedAt: numericTimestamp(session?.updatedAt) || undefined,
    events: [],
  };
}

export function isBusyLiveActivity(activity) {
  return Boolean(activity && activity !== "idle" && activity !== "unknown");
}

export function normalizeLiveState(live, session = {}, now = Date.now()) {
  const base = live ? { ...live } : defaultLiveState(session);
  const updatedAt = numericTimestamp(base.updatedAt) || numericTimestamp(session?.updatedAt) || undefined;
  const expired = isBusyLiveActivity(base.activity) && updatedAt && now - updatedAt > BUSY_LIVE_TTL_MS;

  return {
    ...base,
    activity: expired ? "idle" : base.activity || "idle",
    approvalPending: expired ? false : base.approvalPending,
    updatedAt,
    busySince: expired ? undefined : base.busySince,
    events: normalizeEvents(base.events),
  };
}

export function applyGatewayTopicEvent(current, topicEvent, now = Date.now()) {
  if (!topicEvent || typeof topicEvent !== "object") return null;
  const topic = typeof topicEvent.topic === "string" ? topicEvent.topic : "";
  const data = isPlainObject(topicEvent.data) ? topicEvent.data : {};
  const timestamp = eventTimestamp(topicEvent, data, now);

  const approval = applyApprovalEvent(current, topic, data, timestamp);
  if (approval) return approval;

  const parsed = parseLiveTopic(topic);
  if (!parsed) return null;

  const previous = normalizeLiveState(current, {}, timestamp);
  const event = toSessionEvent(parsed.kind, data, timestamp);
  const activity = nextActivity(previous.activity, parsed.kind, data);
  const busy = isBusyLiveActivity(activity);
  const summary = nextSummary(parsed.kind, data, activity);
  const busySince = busy ? previous.busySince ?? timestamp : undefined;

  return {
    sessionName: parsed.sessionName,
    live: {
      ...previous,
      activity,
      approvalPending: activity === "awaiting_approval" ? true : previous.approvalPending && activity !== "idle",
      summary,
      updatedAt: timestamp,
      busySince,
      events: prependEvent(previous.events, event),
    },
  };
}

export function parseLiveTopic(topic) {
  if (typeof topic !== "string" || !topic.startsWith("ravi.session.")) return null;
  const rest = topic.slice("ravi.session.".length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  const sessionName = rest.slice(0, dot);
  const kind = rest.slice(dot + 1);
  if (!sessionName || !kind) return null;
  return { sessionName, kind };
}

function applyApprovalEvent(current, topic, data, timestamp) {
  if (topic !== "ravi.approval.request" && topic !== "ravi.approval.response") return null;
  const sessionName = clean(data.sessionName);
  if (!sessionName) return null;

  const previous = normalizeLiveState(current, {}, timestamp);
  const request = topic === "ravi.approval.request";
  const event = {
    kind: "approval",
    label: request ? "approval requested" : "approval resolved",
    detail: request ? approvalDetail(data) : clean(data.decision) || clean(data.status) || "resolved",
    timestamp,
    metadata: data,
  };

  return {
    sessionName,
    live: {
      ...previous,
      activity: request ? "awaiting_approval" : "thinking",
      approvalPending: request,
      summary: event.detail,
      updatedAt: timestamp,
      busySince: previous.busySince ?? timestamp,
      events: prependEvent(previous.events, event),
    },
  };
}

function nextActivity(previousActivity, kind, data) {
  if (kind === "stream" || kind === "response") return "streaming";
  if (kind === "prompt") return "thinking";
  if (kind === "tool") {
    if (data.event === "end" && data.isError) return "blocked";
    return "thinking";
  }
  if (kind !== "runtime") return previousActivity || "idle";

  const type = clean(data.type);
  if (type && TERMINAL_RUNTIME_TYPES.has(type)) return "idle";
  if (type === "turn.failed") return "blocked";
  if (type === "status" && clean(data.status) === "compacting") return "compacting";
  if (type === "status" && previousActivity === "compacting") return "thinking";
  if (type === "prompt.received") return "thinking";
  if (type?.startsWith("turn.") || type?.startsWith("tool.") || type?.startsWith("assistant.")) {
    return "thinking";
  }
  return previousActivity || "idle";
}

function nextSummary(kind, data, activity) {
  if (kind === "response") return truncate(clean(data.response) || "response");
  if (kind === "stream") return truncate(clean(data.chunk) || "streaming");
  if (kind === "prompt") return truncate(clean(data.prompt) || "prompt received");
  if (kind === "tool") {
    const toolName = clean(data.toolName) || "tool";
    if (data.event === "start") return `${toolName} running`;
    if (data.isError) return `${toolName} failed`;
    return `${toolName} completed`;
  }
  if (kind === "runtime") {
    const type = clean(data.type);
    if (type === "status") return clean(data.status) || activity;
    if (type === "turn.failed") return truncate(clean(data.error) || "turn failed");
    if (type === "prompt.received") return truncate(clean(data.prompt) || "prompt received");
    return type || activity || "idle";
  }
  return activity || "idle";
}

function toSessionEvent(kind, data, timestamp) {
  const normalizedKind = toEventKind(kind, data);
  return {
    kind: normalizedKind,
    label: eventLabel(normalizedKind, data),
    detail: eventDetail(normalizedKind, data),
    timestamp,
    metadata: data,
  };
}

function toEventKind(kind, data) {
  if (kind === "runtime" && data.type === "prompt.received") return "prompt";
  if (kind === "stream" || kind === "response" || kind === "tool" || kind === "prompt") return kind;
  return "runtime";
}

function eventLabel(kind, data) {
  if (kind === "tool") return clean(data.toolName) || "tool";
  if (kind === "prompt") return "prompt";
  if (kind === "response") return "response";
  if (kind === "stream") return "stream";
  return clean(data.type) || clean(data.status) || "runtime";
}

function eventDetail(kind, data) {
  if (kind === "prompt") return truncate(clean(data.prompt) || "prompt received");
  if (kind === "response") return truncate(clean(data.response) || "response");
  if (kind === "stream") return truncate(clean(data.chunk) || "streaming");
  if (kind === "tool") {
    const action = clean(data.event) || "event";
    const suffix = data.isError ? " error" : "";
    return `${action}${suffix}`;
  }
  if (data.type === "status") return clean(data.status) || "status";
  if (data.type === "turn.failed") return truncate(clean(data.error) || "turn failed");
  return clean(data.type) || clean(data.status) || "runtime";
}

function approvalDetail(data) {
  return clean(data.toolName) || clean(data.summary) || clean(data.reason) || "approval pending";
}

function prependEvent(events, event) {
  return [event, ...normalizeEvents(events)].slice(0, MAX_LIVE_EVENTS);
}

function normalizeEvents(events) {
  return Array.isArray(events)
    ? events
        .filter((event) => event && typeof event === "object")
        .map((event) => ({
          kind: event.kind || "runtime",
          label: clean(event.label) || clean(event.kind) || "event",
          detail: clean(event.detail) || undefined,
          timestamp: numericTimestamp(event.timestamp) || Date.now(),
          metadata: isPlainObject(event.metadata) ? event.metadata : undefined,
        }))
        .slice(0, MAX_LIVE_EVENTS)
    : [];
}

function eventTimestamp(topicEvent, data, fallback) {
  return (
    numericTimestamp(topicEvent.timestamp) ||
    numericTimestamp(data.timestamp) ||
    numericTimestamp(data.createdAt) ||
    fallback
  );
}

function numericTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncate(value, max = 180) {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
