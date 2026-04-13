const BRIDGE_BASE = "http://127.0.0.1:4210";

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

  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/snapshot?${params.toString()}`);
  return response.json();
}

async function fetchSessionWorkspace(payload = {}) {
  const params = new URLSearchParams();
  if (payload.session) params.set("session", payload.session);

  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/session/workspace?${params.toString()}`);
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

  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/tasks?${params.toString()}`);
  return response.json();
}

async function postTaskDispatch(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/tasks/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function postAction(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/session/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function postSessionPrompt(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/session/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function publishViewState(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/current`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function resolveChatList(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/chat-list/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function fetchV3Placeholders() {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/v3/placeholders`);
  return response.json();
}

async function postV3Command(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/v3/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function fetchMessageMeta(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/message-meta`, {
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

  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/omni/panel?${params.toString()}`);
  return response.json();
}

async function postBind(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/bind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function postOmniRoute(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/omni/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function fetchNextDomCommand(payload = {}) {
  const params = new URLSearchParams();
  if (payload.clientId) params.set("clientId", payload.clientId);

  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/dom/command/next?${params.toString()}`);
  return response.json();
}

async function postDomCommandResult(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/dom/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return response.json();
}
