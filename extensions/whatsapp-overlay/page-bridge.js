(() => {
  const REQUEST_EVENT = "ravi-wa-request-active-chat";
  const RESPONSE_EVENT = "ravi-wa-active-chat";

  if (window.__raviWaPageBridgeInjected) {
    return;
  }
  window.__raviWaPageBridgeInjected = true;

  document.addEventListener(REQUEST_EVENT, () => {
    document.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: readActiveChat(),
      }),
    );
  });

  function readActiveChat() {
    const fromWpp = readFromWpp();
    if (fromWpp.chatId || fromWpp.title) {
      return fromWpp;
    }

    const fromStore = readFromStore();
    if (fromStore.chatId || fromStore.title) {
      return fromStore;
    }

    return {
      chatId: null,
      title: null,
      source: "none",
    };
  }

  function readFromWpp() {
    try {
      const WPP = window.WPP;
      const chat =
        WPP?.chat?.getActive?.() ??
        WPP?.whatsapp?.ChatStore?.getActive?.() ??
        WPP?.whatsapp?.Chat?.getActive?.() ??
        null;
      return toChatSnapshot(chat, "wpp");
    } catch {
      return { chatId: null, title: null, source: "wpp:error" };
    }
  }

  function readFromStore() {
    try {
      const store = window.Store ?? {};
      const chatStore = store.Chat ?? store.ChatStore ?? null;
      const active =
        chatStore?.getActive?.() ??
        chatStore?.active ??
        findActive(chatStore?.models) ??
        findActive(chatStore?._models) ??
        findActive(chatStore?.getModelsArray?.()) ??
        (typeof chatStore?.filter === "function" ? chatStore.filter((item) => item?.active)[0] : null) ??
        null;
      return toChatSnapshot(active, "store");
    } catch {
      return { chatId: null, title: null, source: "store:error" };
    }
  }

  function findActive(list) {
    if (!Array.isArray(list)) return null;
    return list.find((item) => item?.active) ?? null;
  }

  function toChatSnapshot(chat, source) {
    return {
      chatId: extractChatId(chat),
      title: extractTitle(chat),
      source,
    };
  }

  function extractChatId(chat) {
    if (!chat) return null;

    const direct = [
      chat?.id?._serialized,
      chat?.id?.toString?.(),
      chat?.wid?._serialized,
      chat?.wid?.toString?.(),
      chat?.chatId,
      chat?.__x_id?._serialized,
      chat?.__x_id?.toString?.(),
    ].find((value) => typeof value === "string" && value.trim());

    if (direct) return direct;

    const user = chat?.id?.user ?? chat?.wid?.user ?? chat?.__x_id?.user;
    const server = chat?.id?.server ?? chat?.wid?.server ?? chat?.__x_id?.server;
    if (user && server) {
      return `${user}@${server}`;
    }

    return null;
  }

  function extractTitle(chat) {
    if (!chat) return null;
    const candidates = [
      chat?.formattedTitle,
      chat?.name,
      chat?.groupMetadata?.subject,
      chat?.contact?.formattedName,
      chat?.contact?.pushname,
      chat?.contact?.name,
      chat?.__x_formattedTitle,
      chat?.__x_name,
    ];

    return candidates.find((value) => typeof value === "string" && value.trim()) ?? null;
  }
})();
