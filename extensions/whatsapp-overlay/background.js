const BRIDGE_BASE = "http://127.0.0.1:4210";
const BRIDGE_TIMEOUT_MS = 2500;
const ARTIFACT_BLOB_TIMEOUT_MS = 8000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ravi:get-snapshot") {
    fetchSnapshot(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:get-session-workspace") {
    fetchSessionWorkspace(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:get-tasks") {
    fetchTasks(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:get-insights") {
    fetchInsights(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:get-artifacts") {
    fetchArtifacts(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:get-artifact-blob") {
    fetchArtifactBlob(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:dispatch-task") {
    postTaskDispatch(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:session-prompt") {
    postSessionPrompt(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:publish-view-state") {
    publishViewState(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:get-v3-placeholders") {
    fetchV3Placeholders()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:v3-command") {
    postV3Command(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:chat-list-resolve") {
    resolveChatList(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:get-message-meta") {
    fetchMessageMeta(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:get-omni-panel") {
    fetchOmniPanel(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:bind-chat") {
    postBind(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:omni-route") {
    postOmniRoute(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:session-action") {
    postAction(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:dom-next-command") {
    fetchNextDomCommand(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ravi:dom-command-result") {
    postDomCommandResult(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return undefined;
});

async function fetchSnapshot(payload = {}) {
  const params = new URLSearchParams();
  if (payload.chatId) params.set("chatId", payload.chatId);
  if (payload.title) params.set("title", payload.title);
  if (payload.session) params.set("session", payload.session);

  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/snapshot?${params.toString()}`);
  return response.json();
}

async function fetchSessionWorkspace(payload = {}) {
  const params = new URLSearchParams();
  if (payload.session) params.set("session", payload.session);

  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/session/workspace?${params.toString()}`);
  return response.json();
}

async function fetchTasks(payload = {}) {
  const params = new URLSearchParams();
  if (payload.taskId) params.set("taskId", payload.taskId);
  if (payload.status) params.set("status", payload.status);
  if (payload.agentId) params.set("agentId", payload.agentId);
  if (payload.sessionName) params.set("sessionName", payload.sessionName);
  if (payload.actorSession) params.set("actorSession", payload.actorSession);
  if (payload.eventsLimit) params.set("eventsLimit", String(payload.eventsLimit));
  if (payload.timeZone) params.set("timeZone", payload.timeZone);
  if (payload.todayKey) params.set("todayKey", payload.todayKey);

  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/tasks?${params.toString()}`);
  return response.json();
}

async function fetchInsights(payload = {}) {
  const params = new URLSearchParams();
  if (payload.limit) params.set("limit", String(payload.limit));

  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/insights?${params.toString()}`);
  return response.json();
}

async function fetchArtifacts(payload = {}) {
  const params = new URLSearchParams();
  if (payload.limit) params.set("limit", String(payload.limit));
  if (payload.lifecycle) params.set("lifecycle", String(payload.lifecycle));
  if (payload.kind) params.set("kind", String(payload.kind));
  if (payload.taskId) params.set("taskId", String(payload.taskId));
  if (payload.sessionId) params.set("sessionId", String(payload.sessionId));
  if (payload.agentId) params.set("agentId", String(payload.agentId));

  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/artifacts?${params.toString()}`);
  return response.json();
}

async function fetchArtifactBlob(payload = {}) {
  const artifactId = typeof payload?.artifactId === "string" ? payload.artifactId.trim() : "";
  if (!artifactId) return { ok: false, status: 400, code: "missing_id", error: "Missing artifactId" };

  const params = new URLSearchParams();
  params.set("id", artifactId);

  let response;
  try {
    response = await bridgeFetch(
      `${BRIDGE_BASE}/api/whatsapp-overlay/artifact-blob?${params.toString()}`,
      { timeoutMs: ARTIFACT_BLOB_TIMEOUT_MS },
    );
  } catch (error) {
    return { ok: false, status: 0, code: "network", error: String(error) };
  }

  if (!response.ok) {
    let parsed = null;
    try {
      parsed = await response.clone().json();
    } catch {}
    return {
      ok: false,
      status: response.status,
      code: parsed?.code || `http_${response.status}`,
      error: parsed?.error || response.statusText || `HTTP ${response.status}`,
    };
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  let buffer;
  try {
    buffer = await response.arrayBuffer();
  } catch (error) {
    return { ok: false, status: response.status, code: "decode_failed", error: String(error) };
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

async function postTaskDispatch(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/tasks/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function postAction(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/session/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function postSessionPrompt(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/session/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function publishViewState(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/current`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function resolveChatList(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/chat-list/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function fetchV3Placeholders() {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/v3/placeholders`);
  return response.json();
}

async function postV3Command(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/v3/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function fetchMessageMeta(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/message-meta`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function fetchOmniPanel(payload = {}) {
  const params = new URLSearchParams();
  if (payload.chatId) params.set("chatId", payload.chatId);
  if (payload.title) params.set("title", payload.title);
  if (payload.session) params.set("session", payload.session);
  if (payload.instance) params.set("instance", payload.instance);

  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/omni/panel?${params.toString()}`);
  return response.json();
}

async function postBind(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function postOmniRoute(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/omni/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function fetchNextDomCommand(payload = {}) {
  const params = new URLSearchParams();
  if (payload.clientId) params.set("clientId", payload.clientId);

  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/dom/command/next?${params.toString()}`);
  return response.json();
}

async function postDomCommandResult(payload = {}) {
  const response = await bridgeFetch(`${BRIDGE_BASE}/api/whatsapp-overlay/dom/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function bridgeFetch(url, options = {}) {
  const { timeoutMs, ...fetchOptions } = options;
  const effectiveTimeoutMs = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : BRIDGE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: fetchOptions.signal || controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
