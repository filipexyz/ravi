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
  "ravi:get-tasks": fetchTasks,
  "ravi:get-crm": fetchCrm,
  "ravi:get-insights": fetchInsights,
  "ravi:get-artifacts": fetchArtifacts,
  "ravi:get-artifact-blob": fetchArtifactBlob,
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
  "ravi:get-tasks": { ttlMs: 4000, staleMs: 15000, slowMs: 4500, backoffMs: 3000, maxBackoffMs: 25000 },
  "ravi:get-crm": { ttlMs: 12000, staleMs: 30000, slowMs: 5000, backoffMs: 5000, maxBackoffMs: 30000 },
  "ravi:get-insights": { ttlMs: 10000, staleMs: 30000, slowMs: 5000, backoffMs: 5000, maxBackoffMs: 30000 },
  "ravi:get-artifacts": { ttlMs: 10000, staleMs: 30000, slowMs: 5000, backoffMs: 5000, maxBackoffMs: 30000 },
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
  const code = typeof error?.body?.code === "string" ? error.body.code : null;
  const command = typeof error?.command === "string" ? error.command : null;
  const message = typeof error?.message === "string" ? error.message : String(error);
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
  if (clean(payload.taskId)) options.taskId = clean(payload.taskId);
  if (clean(payload.sessionId)) options.sessionId = clean(payload.sessionId);
  if (clean(payload.agentId)) options.agentId = clean(payload.agentId);
  return await client.artifacts.list(options);
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
