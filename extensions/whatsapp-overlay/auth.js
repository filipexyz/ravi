const STORAGE_KEY = "ravi_auth";

const DEFAULT_STATE = Object.freeze({ servers: [], activeId: null });

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidEntry(entry) {
  if (!isPlainObject(entry)) return false;
  if (typeof entry.id !== "string" || !entry.id) return false;
  if (typeof entry.name !== "string" || !entry.name) return false;
  if (typeof entry.baseUrl !== "string" || !entry.baseUrl) return false;
  if (typeof entry.contextKey !== "string" || !entry.contextKey) return false;
  if (typeof entry.addedAt !== "number" || !Number.isFinite(entry.addedAt)) return false;
  return true;
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function generateId() {
  if (globalThis.crypto?.randomUUID) {
    return `srv_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }
  return `srv_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export async function getAuthState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result?.[STORAGE_KEY];
  if (!isPlainObject(stored)) return { ...DEFAULT_STATE };
  const servers = Array.isArray(stored.servers) ? stored.servers.filter(isValidEntry) : [];
  const activeId =
    typeof stored.activeId === "string" && servers.some((s) => s.id === stored.activeId)
      ? stored.activeId
      : null;
  return { servers, activeId };
}

export async function setAuthState(state) {
  if (!isPlainObject(state)) {
    throw new TypeError("setAuthState requires an object");
  }
  const servers = Array.isArray(state.servers) ? state.servers.filter(isValidEntry) : [];
  const activeId =
    typeof state.activeId === "string" && servers.some((s) => s.id === state.activeId)
      ? state.activeId
      : null;
  await chrome.storage.local.set({ [STORAGE_KEY]: { servers, activeId } });
  return { servers, activeId };
}

export async function getActiveServer() {
  const { servers, activeId } = await getAuthState();
  if (!activeId) return null;
  return servers.find((s) => s.id === activeId) ?? null;
}

export async function addServer({ name, baseUrl, contextKey }) {
  if (typeof name !== "string" || !name.trim()) throw new Error("name required");
  if (typeof contextKey !== "string" || !contextKey.trim()) throw new Error("contextKey required");
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) throw new Error("baseUrl required");
  const state = await getAuthState();
  const entry = {
    id: generateId(),
    name: name.trim(),
    baseUrl: normalizedBaseUrl,
    contextKey: contextKey.trim(),
    addedAt: Date.now(),
  };
  const servers = [...state.servers, entry];
  const activeId = state.activeId ?? entry.id;
  await setAuthState({ servers, activeId });
  return entry;
}

export async function updateServer(id, partial) {
  if (typeof id !== "string" || !id) throw new Error("id required");
  if (!isPlainObject(partial)) throw new TypeError("partial must be an object");
  const state = await getAuthState();
  const index = state.servers.findIndex((s) => s.id === id);
  if (index === -1) throw new Error(`server ${id} not found`);
  const current = state.servers[index];
  const next = {
    ...current,
    ...(typeof partial.name === "string" && partial.name.trim() ? { name: partial.name.trim() } : {}),
    ...(typeof partial.baseUrl === "string" && normalizeBaseUrl(partial.baseUrl)
      ? { baseUrl: normalizeBaseUrl(partial.baseUrl) }
      : {}),
    ...(typeof partial.contextKey === "string" && partial.contextKey.trim()
      ? { contextKey: partial.contextKey.trim() }
      : {}),
  };
  const servers = [...state.servers];
  servers[index] = next;
  await setAuthState({ servers, activeId: state.activeId });
  return next;
}

export async function removeServer(id) {
  const state = await getAuthState();
  const servers = state.servers.filter((s) => s.id !== id);
  if (servers.length === state.servers.length) return state;
  const activeId = state.activeId === id ? (servers[0]?.id ?? null) : state.activeId;
  return setAuthState({ servers, activeId });
}

export async function setActive(id) {
  const state = await getAuthState();
  if (!state.servers.some((s) => s.id === id)) {
    throw new Error(`server ${id} not found`);
  }
  return setAuthState({ servers: state.servers, activeId: id });
}

export async function testConnection(entry) {
  const target = isValidEntry(entry) ? entry : await getActiveServer();
  if (!target) {
    return { ok: false, status: 0, code: "no_active_server", error: "No active server configured" };
  }
  const url = `${target.baseUrl}/api/v1/context/whoami`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.contextKey}`,
      },
      body: "{}",
    });
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
    let body = null;
    try {
      body = await response.json();
    } catch {}
    return { ok: true, status: response.status, contextId: body?.contextId ?? null, kind: body?.kind ?? null };
  } catch (error) {
    return { ok: false, status: 0, code: "network", error: String(error) };
  }
}

export function subscribe(callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  const handler = (changes, areaName) => {
    if (areaName !== "local") return;
    if (!Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) return;
    const next = changes[STORAGE_KEY]?.newValue ?? DEFAULT_STATE;
    callback(next);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export function maskKey(key) {
  if (typeof key !== "string" || key.length <= 8) return "•".repeat(8);
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
