const VIEW_STATE_KEY = "ravi_overlay_view_state";
const BINDINGS_KEY = "ravi_overlay_bindings";

export async function getViewState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(VIEW_STATE_KEY, (items) => {
      resolve(items?.[VIEW_STATE_KEY] ?? null);
    });
  });
}

export async function setViewState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [VIEW_STATE_KEY]: state }, resolve);
  });
}

export async function getBindings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(BINDINGS_KEY, (items) => {
      resolve(Array.isArray(items?.[BINDINGS_KEY]) ? items[BINDINGS_KEY] : []);
    });
  });
}

export async function setBindings(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [BINDINGS_KEY]: list }, resolve);
  });
}

export async function upsertBinding({ title, chatId, session, instance, chatType, chatName }) {
  const list = await getBindings();
  const cleanTitle = clean(title);
  const cleanChatId = clean(chatId);
  const cleanSession = clean(session);
  const cleanInstance = clean(instance);
  if (!cleanSession) throw new Error("session is required for binding");
  if (!cleanTitle && !cleanChatId) throw new Error("title or chatId is required for binding");

  const idx = list.findIndex((b) => {
    if (cleanChatId && b.chatId === cleanChatId) return true;
    if (cleanTitle && b.title === cleanTitle) return true;
    return false;
  });
  const entry = {
    title: cleanTitle,
    chatId: cleanChatId,
    session: cleanSession,
    instance: cleanInstance,
    chatType: clean(chatType),
    chatName: clean(chatName),
    updatedAt: Date.now(),
  };
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...entry };
  } else {
    list.push(entry);
  }
  await setBindings(list);
  return list[idx >= 0 ? idx : list.length - 1];
}

export async function findBinding({ chatId, title }) {
  const list = await getBindings();
  const cleanChatId = clean(chatId);
  const cleanTitle = clean(title);
  if (cleanChatId) {
    const byChat = list.find((b) => b.chatId === cleanChatId);
    if (byChat) return byChat;
  }
  if (cleanTitle) {
    const byTitle = list.find((b) => b.title === cleanTitle);
    if (byTitle) return byTitle;
  }
  return null;
}

function clean(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
