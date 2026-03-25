const BRIDGE_BASE = "http://127.0.0.1:4210";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ravi:get-snapshot") {
    fetchSnapshot(message.payload)
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

async function postAction(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/session/action`, {
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

async function fetchMessageMeta(payload = {}) {
  const response = await fetch(`${BRIDGE_BASE}/api/whatsapp-overlay/message-meta`, {
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
