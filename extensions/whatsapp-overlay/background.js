import { getClient, callBinary, NoActiveServerError } from "./lib/client.js";
import { getViewState, setViewState, upsertBinding, findBinding } from "./lib/storage.js";
import { buildOverlayV3PlaceholderSnapshot } from "./lib/dom-model.js";
import {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return undefined;
  Promise.resolve()
    .then(() => handler(message.payload ?? {}))
    .then(sendResponse)
    .catch((error) => sendResponse(toErrorResponse(error)));
  return true;
});

function toErrorResponse(error) {
  if (error instanceof NoActiveServerError) {
    return { ok: false, error: error.message, code: "no_active_server" };
  }
  const status = typeof error?.status === "number" ? error.status : 0;
  const code = typeof error?.body?.code === "string" ? error.body.code : null;
  return {
    ok: false,
    status,
    code: code || (status ? `http_${status}` : "transport_error"),
    error: typeof error?.message === "string" ? error.message : String(error),
  };
}

async function fetchSessionWorkspace(payload = {}) {
  const session = clean(payload.session);
  if (!session) return { ok: false, error: "Missing session" };
  const { client } = await getClient();
  const options = { workspace: true };
  if (typeof payload.count === "number") options.count = payload.count;
  return await client.sessions.read(session, options);
}

async function fetchInsights(payload = {}) {
  const { client } = await getClient();
  const options = { rich: true };
  if (typeof payload.limit === "number") options.limit = payload.limit;
  return await client.insights.list(options);
}

async function fetchArtifacts(payload = {}) {
  const { client } = await getClient();
  const options = { rich: true };
  if (typeof payload.limit === "number") options.limit = payload.limit;
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
      const binding = await upsertBinding({
        title: args.title,
        chatId: args.chatId,
        session: args.session,
        instance: args.instance,
        chatType: args.chatType,
        chatName: args.chatName,
      });
      const commandId = `v3c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        ok: true,
        ack: { body: { commandId, ok: true, result: { binding } } },
      };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), code: "bind_failed" };
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
