import { getClient, callBinary, NoActiveServerError, InvalidContextKeyError } from "./lib/client.js";
import { getViewState, setViewState } from "./lib/storage.js";
import { buildOverlayV3PlaceholderSnapshot } from "./lib/dom-model.js";
import {
  buildCrmSnapshot,
  buildSnapshot,
  buildTasksSnapshot,
  buildOmniPanelSnapshot,
  executeOmniRoute,
  resolveChatList as resolveChatListComposition,
} from "./lib/compositions.js";

const HANDLERS = {
  "ravi:get-snapshot": fetchSnapshot,
  "ravi:get-session-workspace": fetchSessionWorkspace,
  "ravi:get-session-trace-summary": fetchSessionTraceSummary,
  "ravi:get-tasks": fetchTasks,
  "ravi:get-crm": fetchCrm,
  "ravi:get-insights": fetchInsights,
  "ravi:get-artifacts": fetchArtifacts,
  "ravi:get-artifact-notifications": fetchArtifactNotifications,
  "ravi:get-artifact-blob": fetchArtifactBlob,
  "ravi:tts-voices": fetchTtsVoices,
  "ravi:tts-preview-url": fetchTtsPreviewUrl,
  "ravi:tts-poll": fetchTtsPending,
  "ravi:tts-say": postTtsSay,
  "ravi:set-agent-tts": postAgentTtsSettings,
  "ravi:dispatch-task": postTaskDispatch,
  "ravi:session-prompt": postSessionPrompt,
  "ravi:publish-view-state": publishViewState,
  "ravi:get-v3-placeholders": fetchV3Placeholders,
  "ravi:v3-command": postV3Command,
  "ravi:chat-list-resolve": resolveChatList,
  "ravi:get-message-meta": fetchMessageMeta,
  "ravi:get-omni-panel": fetchOmniPanel,
  "ravi:omni-route": postOmniRoute,
  "ravi:session-action": postAction,
  "ravi:dom-next-command": noopDomNext,
  "ravi:dom-command-result": noopDomResult,
};

const GUARDED_HANDLER_POLICIES = {
  "ravi:get-snapshot": { ttlMs: 1500, staleMs: 8000, slowMs: 3500, backoffMs: 2000, maxBackoffMs: 15000 },
  "ravi:get-session-workspace": { ttlMs: 2500, staleMs: 10000, slowMs: 4000, backoffMs: 2500, maxBackoffMs: 20000 },
  "ravi:get-session-trace-summary": { ttlMs: 4000, staleMs: 15000, slowMs: 4000, backoffMs: 2500, maxBackoffMs: 20000 },
  "ravi:get-tasks": { ttlMs: 4000, staleMs: 15000, slowMs: 4500, backoffMs: 3000, maxBackoffMs: 25000 },
  "ravi:get-crm": { ttlMs: 12000, staleMs: 30000, slowMs: 5000, backoffMs: 5000, maxBackoffMs: 30000 },
  "ravi:get-insights": { ttlMs: 10000, staleMs: 30000, slowMs: 5000, backoffMs: 5000, maxBackoffMs: 30000 },
  "ravi:get-artifacts": { ttlMs: 10000, staleMs: 30000, slowMs: 5000, backoffMs: 5000, maxBackoffMs: 30000 },
  "ravi:get-artifact-notifications": { ttlMs: 3500, staleMs: 12000, slowMs: 5000, backoffMs: 4000, maxBackoffMs: 25000 },
  "ravi:get-omni-panel": { ttlMs: 5000, staleMs: 15000, slowMs: 4500, backoffMs: 3000, maxBackoffMs: 25000 },
  "ravi:chat-list-resolve": { ttlMs: 5000, staleMs: 15000, slowMs: 4500, backoffMs: 3000, maxBackoffMs: 25000 },
};
const MAX_GUARDED_IN_FLIGHT = 4;
const guardedRequestState = new Map();
let guardedInFlightCount = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return undefined;
  Promise.resolve()
    .then(() => runGuardedHandler(message.type, handler, message.payload ?? {}))
    .then(sendResponse)
    .catch((error) => sendResponse(toErrorResponse(error)));
  return true;
});

async function runGuardedHandler(type, handler, payload) {
  const policy = GUARDED_HANDLER_POLICIES[type];
  if (!policy) return await handler(payload);

  const key = `${type}:${stableStringify(payload)}`;
  const now = Date.now();
  const state = guardedRequestState.get(key) ?? {
    cached: null,
    inFlight: null,
    failures: 0,
    backoffUntil: 0,
  };
  guardedRequestState.set(key, state);

  if (state.inFlight) return await state.inFlight;
  if (state.cached && state.cached.expiresAt > now) return state.cached.value;
  if (state.backoffUntil > now) {
    if (state.cached && state.cached.staleUntil > now) return state.cached.value;
    return {
      ok: false,
      code: "overlay_backoff",
      error: `Overlay polling paused for ${Math.ceil((state.backoffUntil - now) / 1000)}s after slow/failing gateway calls.`,
    };
  }
  if (guardedInFlightCount >= MAX_GUARDED_IN_FLIGHT) {
    if (state.cached && state.cached.staleUntil > now) return state.cached.value;
    return {
      ok: false,
      code: "overlay_rate_limited",
      error: "Overlay request concurrency limit reached.",
    };
  }

  const startedAt = Date.now();
  guardedInFlightCount += 1;
  state.inFlight = Promise.resolve()
    .then(() => handler(payload))
    .then((result) => {
      const finishedAt = Date.now();
      const latencyMs = finishedAt - startedAt;
      const failed = result?.ok === false;
      if (failed) {
        markGuardedBackoff(state, policy, finishedAt);
      } else {
        state.failures = 0;
        state.backoffUntil =
          latencyMs > policy.slowMs
            ? finishedAt + Math.min(policy.backoffMs, policy.maxBackoffMs)
            : 0;
      }
      if (!failed) {
        state.cached = {
          value: result,
          expiresAt: finishedAt + policy.ttlMs,
          staleUntil: finishedAt + policy.staleMs,
        };
      }
      return result;
    })
    .catch((error) => {
      markGuardedBackoff(state, policy, Date.now());
      throw error;
    })
    .finally(() => {
      guardedInFlightCount = Math.max(0, guardedInFlightCount - 1);
      state.inFlight = null;
      pruneGuardedRequestState();
    });

  return await state.inFlight;
}

function markGuardedBackoff(state, policy, now) {
  state.failures += 1;
  const duration = Math.min(
    policy.maxBackoffMs,
    policy.backoffMs * 2 ** Math.min(state.failures - 1, 4),
  );
  state.backoffUntil = now + duration;
}

function pruneGuardedRequestState() {
  if (guardedRequestState.size <= 80) return;
  const now = Date.now();
  for (const [key, state] of guardedRequestState.entries()) {
    if (state.inFlight) continue;
    if (state.cached && state.cached.staleUntil > now) continue;
    guardedRequestState.delete(key);
    if (guardedRequestState.size <= 60) break;
  }
}

function stableStringify(value) {
  if (value === undefined) return '"__undefined__"';
  if (typeof value === "number" && !Number.isFinite(value)) return '"__nonfinite_number__"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function toErrorResponse(error) {
  if (error instanceof NoActiveServerError) {
    return { ok: false, error: error.message, code: "no_active_server" };
  }
  if (error instanceof InvalidContextKeyError) {
    return { ok: false, status: 0, code: "invalid_context_key", error: error.message };
  }
  const status = typeof error?.status === "number" ? error.status : 0;
  const gatewayCode = typeof error?.body?.code === "string" ? error.body.code : null;
  const gatewayError = typeof error?.body?.error === "string" ? error.body.error : null;
  const authReason = typeof error?.body?.reason === "string" ? error.body.reason : null;
  const command = typeof error?.command === "string" ? error.command : null;
  const message = typeof error?.message === "string" ? error.message : String(error);
  const authCode =
    status === 401 ? (authReason ? `context_key_${authReason}` : "invalid_context_key") : null;
  const code =
    authCode || gatewayCode || (gatewayError === "Unauthorized" ? "invalid_context_key" : null);
  return {
    ok: false,
    status,
    command,
    code: code || (status ? `http_${status}` : "transport_error"),
    error:
      status === 401 || status === 403
        ? `${message}. Open the extension options page and update the active server context key.`
        : message,
  };
}

async function fetchSessionWorkspace(payload = {}) {
  const session = clean(payload.session);
  if (!session) return { ok: false, error: "Missing session" };
  const { client } = await getClient();
  const options = { workspace: true };
  if (typeof payload.count === "number") options.count = payload.count;
  const [workspace, trace] = await Promise.all([
    client.sessions.read(session, options),
    client.sessions
      .trace(session, { showSystemPrompt: true, limit: "1" })
      .catch((error) => ({ error })),
  ]);

  return {
    ...workspace,
    systemPrompt: extractSessionSystemPrompt(trace),
    systemPromptError: trace?.error ? stringifyError(trace.error) : null,
  };
}

async function fetchSessionTraceSummary(payload = {}) {
  const session = clean(payload.session) ?? clean(payload.nameOrKey);
  if (!session) return { ok: false, error: "Missing session" };

  const limit = normalizeTraceSummaryLimit(payload.limit, 16);
  const queryLimit = Math.min(120, Math.max(limit, limit * 6));
  const since = clean(payload.since) || "30m";
  const { client } = await getClient();
  const result = await client.sessions.trace(session, {
    since,
    limit: String(queryLimit),
  });
  const trace = result?.trace ?? result ?? {};
  const rawEvents = Array.isArray(trace.events) ? trace.events : [];
  const visibleEvents = rawEvents.filter(isVisibleSessionTraceEvent);
  const events = visibleEvents
    .slice(-limit)
    .map(sanitizeSessionTraceEvent)
    .filter(Boolean)
    .reverse();

  return {
    ok: true,
    session,
    sessionKey: trace.sessionKey ?? null,
    sessionName: trace.sessionName ?? null,
    counts: {
      events: rawEvents.length,
      visible: visibleEvents.length,
      returned: events.length,
    },
    filters: trace.filters ?? null,
    events,
    generatedAt: Date.now(),
  };
}

function isVisibleSessionTraceEvent(event) {
  if (!event || typeof event !== "object") return false;
  const eventType = String(event.eventType || event.kind || event.type || "").toLowerCase();
  const eventGroup = String(event.eventGroup || "").toLowerCase();
  if (!eventType) return false;
  if (eventGroup === "presence") return false;
  if (eventType === "presence.typing") return false;
  return true;
}

function normalizeTraceSummaryLimit(value, fallback) {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(typeof value === "string" ? value : "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(40, Math.max(1, Math.floor(parsed)));
}

function normalizeTraceSummaryTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function sanitizeSessionTraceEvent(event) {
  if (!event || typeof event !== "object") return null;
  const eventType = clean(event.eventType) || clean(event.kind) || clean(event.type) || "event";
  return {
    id: event.id ?? null,
    eventType,
    eventGroup: clean(event.eventGroup) || null,
    status: clean(event.status) || null,
    timestamp: normalizeTraceSummaryTimestamp(event.timestamp),
    createdAt: normalizeTraceSummaryTimestamp(event.createdAt),
    preview: clean(event.preview) || null,
    error: clean(event.error) || null,
    durationMs: Number.isFinite(event.durationMs) ? event.durationMs : null,
    turnId: clean(event.turnId) || null,
    runId: clean(event.runId) || null,
    messageId: clean(event.messageId) || null,
    agentId: clean(event.agentId) || null,
    provider: clean(event.provider) || null,
    model: clean(event.model) || null,
    sourceChannel: clean(event.sourceChannel) || null,
    sourceChatId: clean(event.sourceChatId) || null,
  };
}

function extractSessionSystemPrompt(result) {
  const trace = result?.trace ?? result;
  const snapshot = trace?.systemPrompt ?? null;
  if (!snapshot?.sha256) return null;

  const blob = trace?.blobsBySha256?.[snapshot.sha256] ?? null;
  const content = typeof blob?.contentText === "string" ? blob.contentText : "";

  return {
    sha256: snapshot.sha256,
    turnId: snapshot.turnId ?? null,
    runId: snapshot.runId ?? null,
    agentId: snapshot.agentId ?? null,
    provider: snapshot.provider ?? null,
    model: snapshot.model ?? null,
    cwd: snapshot.cwd ?? null,
    recordedAt: snapshot.recordedAt ?? null,
    source: snapshot.source ?? null,
    content,
    bytes: blob?.sizeBytes ?? content.length,
  };
}

function stringifyError(error) {
  if (!error) return null;
  if (typeof error?.message === "string") return error.message;
  return String(error);
}

async function fetchInsights(payload = {}) {
  const { client } = await getClient();
  const options = { rich: true };
  const limit = cleanOptionString(payload.limit);
  if (limit) options.limit = limit;
  return await client.insights.list(options);
}

async function fetchArtifacts(payload = {}) {
  const { client } = await getClient();
  const options = { rich: true };
  const limit = cleanOptionString(payload.limit);
  if (limit) options.limit = limit;
  if (clean(payload.lifecycle)) options.lifecycle = clean(payload.lifecycle);
  if (clean(payload.kind)) options.kind = clean(payload.kind);
  if (clean(payload.tag)) options.tag = clean(payload.tag);
  if (clean(payload.taskId) || clean(payload.task)) options.task = clean(payload.taskId) || clean(payload.task);
  if (clean(payload.sessionId) || clean(payload.session)) {
    options.session = clean(payload.sessionId) || clean(payload.session);
  }
  if (clean(payload.agentId) || clean(payload.agent)) options.agent = clean(payload.agentId) || clean(payload.agent);
  return await client.artifacts.list(options);
}

async function fetchArtifactNotifications(payload = {}) {
  const { client } = await getClient();
  const limit = normalizeNotificationLimit(payload.limit, 24);
  const since = normalizeEpochMs(payload.since);
  const result = await client.artifacts.list({ rich: true, limit: String(limit), orderBy: "updatedAt" });
  const sourceItems = Array.isArray(result?.items) ? result.items : [];
  const items = sourceItems
    .filter((item) => !since || normalizeEpochMs(item?.updatedAt || item?.createdAt) >= since)
    .map(sanitizeArtifactNotificationItem)
    .filter(Boolean);

  return {
    ok: true,
    generatedAt: Date.now(),
    counts: {
      scanned: sourceItems.length,
      returned: items.length,
    },
    items,
  };
}

function normalizeNotificationLimit(value, fallback) {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(typeof value === "string" ? value : "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(60, Math.max(1, Math.floor(parsed)));
}

function normalizeEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return null;
}

function sanitizeArtifactNotificationItem(item) {
  if (!item || typeof item !== "object") return null;
  const id = clean(item.id);
  if (!id) return null;
  return {
    id,
    kind: clean(item.kind) || "artifact",
    label: clean(item.label) || clean(item.title) || id,
    status: clean(item.status) || null,
    lifecycle: clean(item.lifecycle) || null,
    summary: clean(item.summary) || null,
    path: clean(item.path) || null,
    blobPath: clean(item.blobPath) || null,
    uri: clean(item.uri) || null,
    mimeType: clean(item.mimeType) || null,
    sizeBytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : null,
    provider: clean(item.provider) || null,
    model: clean(item.model) || null,
    taskId: clean(item.taskId) || null,
    sessionName: clean(item.sessionName) || null,
    sessionKey: clean(item.sessionKey) || null,
    agentId: clean(item.agentId) || null,
    createdAt: normalizeEpochMs(item.createdAt) || null,
    updatedAt: normalizeEpochMs(item.updatedAt) || normalizeEpochMs(item.createdAt) || null,
    task: sanitizeArtifactLinkedRef(item.task),
    session: sanitizeArtifactLinkedRef(item.session),
    agent: sanitizeArtifactLinkedRef(item.agent),
    links: Array.isArray(item.links) ? item.links.slice(0, 8).map(sanitizeArtifactLink).filter(Boolean) : [],
    ui: sanitizeArtifactUiSpec(item.ui),
    componentPreview: sanitizeArtifactComponentPreview(item.componentPreview || item.uiComponent || item.component),
  };
}

function sanitizeArtifactLinkedRef(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") out[key] = nested;
    else if (typeof nested === "number" && Number.isFinite(nested)) out[key] = nested;
    else if (typeof nested === "boolean") out[key] = nested;
    else if (nested === null) out[key] = null;
  }
  return out;
}

function sanitizeArtifactLink(link) {
  if (!link || typeof link !== "object") return null;
  return {
    targetType: clean(link.targetType) || null,
    targetId: clean(link.targetId) || null,
    label: clean(link.label) || null,
    value: clean(link.value) || null,
    action: clean(link.action) || null,
    href: clean(link.href) || null,
    copyText: clean(link.copyText) || null,
    task: sanitizeArtifactLinkedRef(link.task),
    session: sanitizeArtifactLinkedRef(link.session),
    agent: sanitizeArtifactLinkedRef(link.agent),
  };
}

function sanitizeArtifactUiSpec(spec) {
  if (!spec || typeof spec !== "object") return null;
  if (spec.schema !== "ravi.ui/v1" || spec.component !== "artifact.notification") return null;
  return {
    schema: "ravi.ui/v1",
    kind: "ui.spec",
    component: "artifact.notification",
    key: clean(spec.key) || null,
    props: sanitizeArtifactLinkedRef(spec.props),
    actions: Array.isArray(spec.actions)
      ? spec.actions
          .slice(0, 6)
          .map((action) => ({
            id: clean(action?.id) || null,
            label: clean(action?.label) || null,
            command: clean(action?.command) || null,
            payload: sanitizeArtifactLinkedRef(action?.payload),
          }))
      : [],
  };
}

function sanitizeArtifactComponentPreview(component) {
  if (!component || typeof component !== "object") return null;
  return {
    id: clean(component.id) || null,
    version: clean(component.version) || null,
    description: clean(component.description) || null,
    propsSchema: sanitizeArtifactJsonValue(component.propsSchema),
    slots: sanitizeStringList(component.slots, 12),
    actions: sanitizeStringList(component.actions, 12),
    events: sanitizeStringList(component.events, 12),
    surfaces: sanitizeStringList(component.surfaces, 12),
    renderers: Array.isArray(component.renderers)
      ? component.renderers
          .slice(0, 8)
          .map((renderer) => ({
            surface: clean(renderer?.surface) || null,
            renderer: clean(renderer?.renderer) || null,
            package: clean(renderer?.package) || null,
            artifactId: clean(renderer?.artifactId) || null,
            source: sanitizeArtifactComponentRendererSource(renderer?.source),
          }))
          .filter((renderer) => renderer.surface)
      : [],
    fixtures: Array.isArray(component.fixtures)
      ? component.fixtures
          .slice(0, 6)
          .map((fixture) => ({
            id: clean(fixture?.id) || null,
            label: clean(fixture?.label) || clean(fixture?.id) || null,
            props: sanitizeArtifactJsonValue(fixture?.props),
          }))
          .filter((fixture) => fixture.id)
      : [],
  };
}

function sanitizeArtifactComponentRendererSource(source) {
  if (!source || typeof source !== "object") return null;
  const js = cleanInlineSource(source.js, 30000);
  const css = cleanInlineSource(source.css, 20000);
  if (!js && !css) return null;
  return { js, css };
}

function cleanInlineSource(value, maxLength) {
  const text = clean(value);
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeStringList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .map((item) => clean(item))
    .filter(Boolean);
}

function sanitizeArtifactJsonValue(value, depth = 0) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.length > 30000 ? `${value.slice(0, 30000)}…` : value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => sanitizeArtifactJsonValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, nested] of Object.entries(value).slice(0, 32)) {
      out[key] = sanitizeArtifactJsonValue(nested, depth + 1);
    }
    return out;
  }
  return null;
}

async function fetchArtifactBlob(payload = {}) {
  const artifactId = clean(payload?.artifactId);
  if (!artifactId) return { ok: false, status: 400, code: "missing_id", error: "Missing artifactId" };

  let result;
  try {
    result = await callBinary({
      groupSegments: ["artifacts"],
      command: "blob",
      body: { id: artifactId },
    });
  } catch (error) {
    return toErrorResponse(error);
  }

  const contentType = result?.contentType || "application/octet-stream";
  const buffer = result?.body instanceof ArrayBuffer ? result.body : null;
  if (!buffer) {
    return { ok: false, status: 0, code: "decode_failed", error: "Empty binary response" };
  }
  return {
    ok: true,
    artifactId,
    contentType,
    sizeBytes: buffer.byteLength,
    dataUri: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`,
  };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

async function fetchTtsPending(payload = {}) {
  const { client } = await getClient();
  const body = {};
  if (clean(payload.id)) body.id = clean(payload.id);
  if (clean(payload.requestId)) body.requestId = clean(payload.requestId);
  if (typeof payload.since === "number" && Number.isFinite(payload.since)) body.since = String(Math.floor(payload.since));
  if (clean(payload.sessionName) || clean(payload.session)) body.session = clean(payload.sessionName) ?? clean(payload.session);
  if (clean(payload.sessionKey)) body.sessionKey = clean(payload.sessionKey);
  if (clean(payload.chatId)) body.chat = clean(payload.chatId);
  if (clean(payload.agentId)) body.agent = clean(payload.agentId);
  if (clean(payload.clientId)) body.clientId = clean(payload.clientId);
  if (typeof payload.limit === "number" && Number.isFinite(payload.limit)) body.limit = String(Math.floor(payload.limit));
  if (payload.includeFailed === true) body.includeFailed = true;

  const pending = await client.transport.call({
    groupSegments: ["audio"],
    command: "pending",
    body,
  });
  const items = Array.isArray(pending?.items) ? pending.items : [];
  if (payload.withAudio === false) return { ...pending, items };

  const hydrated = [];
  for (const item of items) {
    if (!clean(item?.id) || item?.status !== "ready") {
      hydrated.push(item);
      continue;
    }
    try {
      const result = await callBinary({
        groupSegments: ["audio"],
        command: "blob",
        body: { id: item.id },
      });
      const contentType = result?.contentType || item.audio?.mimeType || "audio/mpeg";
      const buffer = result?.body instanceof ArrayBuffer ? result.body : null;
      hydrated.push({
        ...item,
        dataUri: buffer ? `data:${contentType};base64,${arrayBufferToBase64(buffer)}` : null,
        contentType,
        sizeBytes: buffer?.byteLength ?? item.audio?.sizeBytes ?? null,
      });
    } catch (error) {
      hydrated.push({ ...item, dataUri: null, blobError: error?.message || String(error) });
    }
  }
  return { ...pending, items: hydrated };
}

async function fetchTtsVoices(payload = {}) {
  const { client } = await getClient();
  const body = {};
  if (clean(payload.search)) body.search = clean(payload.search);
  if (clean(payload.category)) body.category = clean(payload.category);
  if (clean(payload.voiceType)) body.voiceType = clean(payload.voiceType);
  if (typeof payload.limit === "number" && Number.isFinite(payload.limit)) body.limit = String(Math.floor(payload.limit));
  return await client.transport.call({
    groupSegments: ["audio"],
    command: "voices",
    body,
  });
}

async function fetchTtsPreviewUrl(payload = {}) {
  const url = clean(payload.url);
  if (!url) return { ok: false, status: 400, code: "missing_url", error: "Missing preview URL" };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 400, code: "invalid_url", error: "Invalid preview URL" };
  }

  if (!isAllowedTtsPreviewUrl(parsed)) {
    return { ok: false, status: 400, code: "unsupported_preview_url", error: "Unsupported preview URL" };
  }

  const response = await fetch(parsed.toString(), {
    cache: "force-cache",
    credentials: "omit",
    redirect: "follow",
  });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: "preview_fetch_failed",
      error: `Preview fetch failed with HTTP ${response.status}`,
    };
  }

  const contentType = response.headers.get("content-type") || "audio/mpeg";
  if (!contentType.toLowerCase().startsWith("audio/")) {
    return { ok: false, status: 415, code: "unsupported_preview_type", error: "Preview is not audio" };
  }

  const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength) && contentLength > 8 * 1024 * 1024) {
    return { ok: false, status: 413, code: "preview_too_large", error: "Preview audio is too large" };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 8 * 1024 * 1024) {
    return { ok: false, status: 413, code: "preview_too_large", error: "Preview audio is too large" };
  }

  return {
    ok: true,
    contentType,
    sizeBytes: buffer.byteLength,
    dataUri: `data:${contentType};base64,${arrayBufferToBase64(buffer)}`,
  };
}

function isAllowedTtsPreviewUrl(url) {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "storage.googleapis.com" || host === "api.elevenlabs.io" || host.endsWith(".elevenlabs.io");
}

async function postTtsSay(payload = {}) {
  const text = clean(payload.text);
  if (!text) return { ok: false, status: 400, code: "missing_text", error: "Missing text" };
  const { client } = await getClient();
  const body = { text };
  if (clean(payload.id)) body.id = clean(payload.id);
  if (clean(payload.agentId)) body.agent = clean(payload.agentId);
  if (clean(payload.sessionName)) body.session = clean(payload.sessionName);
  if (clean(payload.sessionKey)) body.sessionKey = clean(payload.sessionKey);
  if (clean(payload.channel)) body.channel = clean(payload.channel);
  if (clean(payload.accountId)) body.account = clean(payload.accountId);
  if (clean(payload.chatId)) body.chat = clean(payload.chatId);
  if (clean(payload.voiceId)) body.voice = clean(payload.voiceId);
  if (clean(payload.modelId)) body.model = clean(payload.modelId);
  if (clean(payload.lang)) body.lang = clean(payload.lang);
  if (clean(payload.outputFormat)) body.format = clean(payload.outputFormat);
  if (typeof payload.speed === "number" && Number.isFinite(payload.speed)) body.speed = String(payload.speed);
  if (clean(payload.clientId)) body.clientId = clean(payload.clientId);
  if (payload.voiceSettings && typeof payload.voiceSettings === "object") body.voiceSettings = JSON.stringify(payload.voiceSettings);
  if (payload.elevenlabs && typeof payload.elevenlabs === "object") body.elevenlabs = JSON.stringify(payload.elevenlabs);
  return await client.transport.call({
    groupSegments: ["audio"],
    command: "tts",
    body,
  });
}

async function postAgentTtsSettings(payload = {}) {
  const agentId = clean(payload.agentId);
  if (!agentId) return { ok: false, status: 400, code: "missing_agent", error: "Missing agentId" };
  const settings = payload.settings && typeof payload.settings === "object" ? payload.settings : {};
  const { client } = await getClient();
  const agentsResult = await client.agents.list({}).catch((error) => {
    if (error?.status === 401 || error?.status === 403) throw error;
    return { agents: [] };
  });
  const agents = Array.isArray(agentsResult?.agents) ? agentsResult.agents : [];
  const agent = agents.find((item) => clean(item?.id ?? item?.agentId ?? item?.name) === agentId) ?? null;
  const currentDefaults =
    agent?.defaults && typeof agent.defaults === "object" && !Array.isArray(agent.defaults) ? agent.defaults : {};
  const nextDefaults = { ...currentDefaults, tts_provider: "elevenlabs" };

  setDefaultValue(nextDefaults, "tts_auto", typeof settings.enabled === "boolean" ? (settings.enabled ? "on" : "off") : undefined);
  setDefaultValue(nextDefaults, "tts_voice", clean(settings.voiceId));
  setDefaultValue(nextDefaults, "tts_voice_name", clean(settings.voiceName));
  setDefaultValue(nextDefaults, "tts_voice_description", clean(settings.voiceDescription));
  setDefaultValue(nextDefaults, "tts_voice_category", clean(settings.voiceCategory));
  setDefaultValue(nextDefaults, "tts_voice_preview_url", clean(settings.voicePreviewUrl));
  setDefaultValue(nextDefaults, "tts_model", clean(settings.modelId));
  setDefaultValue(nextDefaults, "tts_lang", clean(settings.lang));
  setDefaultValue(nextDefaults, "tts_format", clean(settings.outputFormat));
  setDefaultValue(nextDefaults, "tts_speed", readFiniteNumber(settings.speed));
  setDefaultValue(nextDefaults, "tts_voice_settings", cleanObject(settings.voiceSettings));
  setDefaultValue(nextDefaults, "tts_elevenlabs", cleanObject(settings.elevenlabs));

  const result = await client.agents.set(agentId, "defaults", JSON.stringify(nextDefaults));
  return { ok: true, agentId, defaults: nextDefaults, result };
}

function setDefaultValue(target, key, value) {
  if (value === undefined || value === null || value === "") {
    delete target[key];
    return;
  }
  target[key] = value;
}

function readFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function cleanObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined || inner === null || inner === "") continue;
    out[key] = inner;
  }
  return Object.keys(out).length ? out : undefined;
}

async function fetchMessageMeta(payload = {}) {
  const session = clean(payload.session);
  const messageId = clean(payload.messageId);
  if (!session || !messageId) {
    return { ok: false, error: "Missing session or messageId" };
  }
  const { client } = await getClient();
  return await client.sessions.read(session, { messageId });
}

async function postTaskDispatch(payload = {}) {
  const taskId = clean(payload.taskId);
  if (!taskId) return { ok: false, error: "Missing taskId" };
  const { client } = await getClient();
  const options = {};
  if (clean(payload.agentId)) options.agentId = clean(payload.agentId);
  if (clean(payload.sessionName)) options.sessionName = clean(payload.sessionName);
  if (clean(payload.actorSession)) options.actorSession = clean(payload.actorSession);
  if (clean(payload.reportToSessionName)) options.reportToSessionName = clean(payload.reportToSessionName);
  return await client.tasks.dispatch(taskId, options);
}

async function postSessionPrompt(payload = {}) {
  const session = clean(payload.session) ?? clean(payload.nameOrKey);
  const prompt = typeof payload.prompt === "string" ? payload.prompt : null;
  if (!session || !prompt) return { ok: false, error: "Missing session or prompt" };
  const { client } = await getClient();
  const options = {};
  if (clean(payload.actorSession)) options.actorSession = clean(payload.actorSession);
  if (typeof payload.wait === "boolean") options.wait = payload.wait;
  return await client.sessions.send(session, prompt, options);
}

async function postAction(payload = {}) {
  const session = clean(payload.session);
  const action = clean(payload.action);
  if (!session) return { ok: false, error: "Missing session" };
  if (!action) return { ok: false, error: "Missing action" };
  const { client } = await getClient();
  switch (action) {
    case "abort": {
      return await client.sessions.runtime.interrupt(session);
    }
    case "reset": {
      return await client.sessions.reset(session);
    }
    case "set-thinking": {
      const value = clean(payload.value);
      if (value !== "off" && value !== "normal" && value !== "verbose") {
        return { ok: false, error: "Invalid thinking level" };
      }
      return await client.sessions.setThinking(session, value);
    }
    case "rename": {
      const value = clean(payload.value);
      if (!value) return { ok: false, error: "Missing display name" };
      return await client.sessions.setDisplay(session, value);
    }
    default:
      return { ok: false, error: `Unsupported action: ${action}` };
  }
}

async function fetchTasks(payload = {}) {
  const { client } = await getClient();
  return await buildTasksSnapshot(client, payload);
}

async function fetchCrm(payload = {}) {
  const { client } = await getClient();
  return await buildCrmSnapshot(client, payload);
}

async function publishViewState(payload = {}) {
  await setViewState(payload);
  return { ok: true };
}

async function fetchV3Placeholders() {
  const publishedState = await getViewState();
  return buildOverlayV3PlaceholderSnapshot({ publishedState });
}

async function postV3Command(payload = {}) {
  const name = clean(payload?.name);
  if (!name) return { ok: false, error: "Missing name", code: "invalid_command" };
  if (name === "chat.bindSession") {
    const args = payload.args ?? {};
    try {
      const { client } = await getClient();
      const result = await executeOmniRoute(client, {
        action: "bind-existing",
        title: args.title,
        chatId: args.chatId,
        session: args.session,
        agentId: args.agentId,
        instance: args.instance,
        chatType: args.chatType,
        chatName: args.chatName,
        channel: args.channel,
      });
      if (result?.ok === false) return result;
      const commandId = `v3c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        ok: true,
        ack: { body: { commandId, ok: true, result } },
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), code: "bind_failed" };
    }
  }
  if (name === "chat.createSession") {
    const args = payload.args ?? {};
    const agentId = clean(args.agentId);
    const chatId = clean(args.chatId);
    const title = clean(args.title);
    const session = clean(args.session);
    if (!agentId || (!chatId && !title)) {
      return { ok: false, error: "agentId and chatId/title required", code: "invalid_args" };
    }
    try {
      const { client } = await getClient();
      const result = await executeOmniRoute(client, {
        action: "create-session",
        title,
        chatId,
        session,
        agentId,
        instance: args.instance,
        chatType: args.chatType,
        chatName: args.chatName,
        channel: args.channel,
      });
      if (result?.ok === false) return result;
      const commandId = `v3c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        ok: true,
        ack: {
          body: {
            commandId,
            ok: true,
            result,
          },
        },
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), code: "create_session_failed" };
    }
  }
  if (name === "chat.unbindSession") {
    const args = payload.args ?? {};
    const chatId = clean(args.chatId);
    const title = clean(args.title);
    if (!chatId && !title) {
      return { ok: false, error: "chatId or title required", code: "invalid_args" };
    }
    try {
      const { client } = await getClient();
      const result = await executeOmniRoute(client, {
        action: "unbind",
        chatId,
        title,
        instance: args.instance,
        channel: args.channel,
      });
      if (result?.ok === false) return result;
      const commandId = `v3c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        ok: true,
        ack: {
          body: {
            commandId,
            ok: true,
            result,
          },
        },
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), code: "unbind_session_failed" };
    }
  }
  return { ok: false, error: `Unsupported v3 command: ${name}`, code: "unsupported_command" };
}

async function fetchSnapshot(payload = {}) {
  const { client } = await getClient();
  return await buildSnapshot(client, payload);
}

async function fetchOmniPanel(payload = {}) {
  const { client } = await getClient();
  return await buildOmniPanelSnapshot(client, payload);
}

async function postOmniRoute(payload = {}) {
  const { client } = await getClient();
  return await executeOmniRoute(client, payload);
}

async function resolveChatList(payload = {}) {
  const { client } = await getClient();
  return await resolveChatListComposition(client, payload);
}

function noopDomNext() {
  return { ok: true, command: null };
}

function noopDomResult() {
  return { ok: true };
}

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanOptionString(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return clean(value);
}
