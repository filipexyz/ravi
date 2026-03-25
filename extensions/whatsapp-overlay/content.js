const SNAPSHOT_POLL_INTERVAL_MS = 700;
const CHAT_LIST_RESOLVE_INTERVAL_MS = 1200;
const MESSAGE_CHIP_REFRESH_INTERVAL_MS = 1100;
const VIEW_STATE_REPUBLISH_MS = 2500;
const ROOT_ID = "ravi-wa-overlay-root";
const DRAWER_ID = "ravi-wa-overlay-drawer";
const INLINE_PROBE_ID = "ravi-wa-inline-probe";
const CHAT_ROW_SELECTOR = "div[role='grid'] [role='row']";
const CHAT_ROW_BADGE_ATTR = "data-ravi-chat-chip";
const MESSAGE_CHIP_ATTR = "data-ravi-message-chip";
const MESSAGE_POPOVER_ID = "ravi-wa-message-popover";
const PAGE_BRIDGE_SCRIPT_ID = "ravi-wa-page-bridge";
const PAGE_CHAT_REQUEST_EVENT = "ravi-wa-request-active-chat";
const PAGE_CHAT_RESPONSE_EVENT = "ravi-wa-active-chat";
const LOG_LIMIT = 12;
const CLIENT_ID_KEY = "ravi-wa-overlay-client-id";
const SELECTOR_PROBE_DEFS = [
  ["app-root-main", "main"],
  ["app-root-role-application", "[role='application']"],
  ["chat-list-testid", "[data-testid='chat-list']"],
  ["chat-grid", "div[role='grid']"],
  ["selected-row", "[aria-selected='true']"],
  ["conversation-panel-body", "[data-testid='conversation-panel-body']"],
  ["message-list", "[aria-label='Message list']"],
  ["main-header-title", "main header [title]"],
  ["main-header-auto", "main header span[dir='auto']"],
  ["composer-footer", "footer [contenteditable='true']"],
  ["composer-textbox", "div[contenteditable='true'][role='textbox']"],
  ["drawer-aside", "main aside"],
  ["modal-dialog", "[role='dialog']"],
  ["message-container", "[data-testid='msg-container']"],
  ["message-data-id", "div[data-id]"],
];

let latestSnapshot = null;
let drawerOpen = false;
let latestViewState = null;
let latestTimelineDebug = null;
let latestChatListItems = [];
let latestPageChat = null;
const messageMetaCache = new Map();
let lastPublishedAt = 0;
const detectionLogs = [];
let bridgeError = null;
let pollingStopped = false;
let domCommandInFlight = false;
let chatListRefreshInFlight = false;
let openMessageChip = null;
let openMessageId = null;
let openMessageData = null;
const intervalIds = [];
const clientId = getOrCreateClientId();

boot();

function boot() {
  ensurePageBridge();
  document.addEventListener(PAGE_CHAT_RESPONSE_EVENT, handlePageChatEvent);
  ensureShell();
  ensureMessagePopover();
  refreshAll();
  intervalIds.push(setInterval(refreshSnapshot, SNAPSHOT_POLL_INTERVAL_MS));
  intervalIds.push(setInterval(refreshViewState, 700));
  intervalIds.push(setInterval(refreshChatListOverlay, CHAT_LIST_RESOLVE_INTERVAL_MS));
  intervalIds.push(setInterval(refreshMessageChips, MESSAGE_CHIP_REFRESH_INTERVAL_MS));
  intervalIds.push(setInterval(pollDomCommands, 700));
  window.addEventListener("resize", syncMessagePopoverPosition);
  document.addEventListener("scroll", syncMessagePopoverPosition, true);
}

async function refreshSnapshot() {
  if (pollingStopped) return;
  const context = detectChatContext();
  try {
    const snapshot = await chrome.runtime.sendMessage({
      type: "ravi:get-snapshot",
      payload: context,
    });
    bridgeError = null;
    latestSnapshot = snapshot;
    render();
  } catch (error) {
    handleRuntimeError(error);
  }
}

function refreshAll() {
  refreshViewState();
  refreshSnapshot();
  refreshChatListOverlay();
  refreshMessageChips();
}

function refreshViewState() {
  if (pollingStopped) return;
  requestPageChatInfo();
  const next = detectViewState();
  if (!hasViewChanged(latestViewState, next)) {
    if (Date.now() - lastPublishedAt >= VIEW_STATE_REPUBLISH_MS) {
      publishViewState(next).catch(handleRuntimeError);
    }
    renderTimelineProbe();
    return;
  }

  latestViewState = next;
  detectionLogs.unshift({
    at: new Date().toLocaleTimeString(),
    summary: `${next.screen} · ${next.title || next.selectedChat || "sem título"}`,
    detail: `header=${flag(next.hasConversationHeader)} composer=${flag(next.hasComposer)} chatlist=${flag(next.hasChatList)} drawer=${flag(next.hasDrawer)} modal=${flag(next.hasModal)}`,
  });
  detectionLogs.splice(LOG_LIMIT);
  console.log("[RaviOverlay] view-state", next);
  publishViewState(next).catch(handleRuntimeError);
  renderTimelineProbe();
  render();
}

function detectChatContext() {
  const title = detectChatTitle() || latestPageChat?.title || latestViewState?.selectedChat || detectSelectedChatLabel();
  const url = new URL(window.location.href);
  const phone = url.searchParams.get("phone");
  const chatIdCandidate = latestPageChat?.chatId || latestViewState?.chatIdCandidate || detectChatIdCandidate();
  const text = url.searchParams.get("text");
  const session = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("session");

  return {
    chatId: phone || chatIdCandidate || null,
    title,
    session: text ? null : session,
  };
}

function detectChatTitle() {
  if (latestPageChat?.title) {
    return latestPageChat.title;
  }

  const candidates = [
    document.querySelector("main header [title]"),
    document.querySelector("header [title]"),
    document.querySelector("main header span[dir='auto']"),
    document.querySelector("main header h1"),
  ];
  const ignoredTitles = new Set([
    "dados do perfil",
    "profile details",
    "contact info",
    "group info",
    "media, links and docs",
  ]);

  for (const node of candidates) {
    const text = (node?.getAttribute?.("title") || node?.textContent || "").trim();
    if (text && text.toLowerCase() !== "whatsapp" && !ignoredTitles.has(text.toLowerCase())) {
      return text;
    }
  }

  return null;
}

function detectViewState() {
  const title = detectChatTitle();
  const selectedChat = detectSelectedChatLabel();
  const chatIdCandidate = latestPageChat?.chatId || detectChatIdCandidate();
  const conversationHeader = detectConversationHeader();
  const composer = detectComposer();
  const modal = document.querySelector("[role='dialog']");
  const drawer = detectDrawer();
  const chatList = detectChatList();
  const main = document.querySelector("main");
  const timeline = detectTimelineContainer();
  const { nodes: messageAnchors } = detectMessageAnchors();
  const focus = document.activeElement;
  const focusText = (
    focus?.getAttribute?.("aria-label") ||
    focus?.getAttribute?.("title") ||
    focus?.textContent ||
    focus?.tagName ||
    ""
  )
    .trim()
    .slice(0, 60);

  let screen = "loading";
  if (modal) {
    screen = "modal";
  } else if (
    composer &&
    (conversationHeader || selectedChat || title || (timeline && messageAnchors.length > 1))
  ) {
    screen = "conversation";
  } else if (chatList) {
    screen = "chat-list";
  } else if (main) {
    screen = "workspace";
  }

  if (drawer && screen !== "modal") {
    screen = `${screen}+drawer`;
  }

  const components = buildComponentMatches({
    main,
    chatList,
    drawer,
    modal,
    composer,
    conversationHeader,
    timeline,
    messageAnchors,
    selectedChat,
    title,
    chatIdCandidate,
  });
  const selectorProbes = collectSelectorProbes();

  return {
    screen,
    title: title || null,
    selectedChat: selectedChat || null,
    chatIdCandidate: chatIdCandidate || null,
    url: window.location.href,
    focus: focusText || null,
    hasConversationHeader: Boolean(conversationHeader),
    hasComposer: Boolean(composer),
    hasChatList: Boolean(chatList),
    hasDrawer: Boolean(drawer),
    hasModal: Boolean(modal),
    components,
    selectorProbes,
  };
}

function buildComponentMatches(input) {
  const matches = [];
  const selectedRow = document.querySelector("[aria-selected='true']");

  if (input.main) {
    matches.push(
      createComponentMatch("app-root", "app-shell", "main", 100, ["visible", "workspace-root"], {
        tag: input.main.tagName.toLowerCase(),
      }),
    );
  }

  if (input.chatList) {
    matches.push(
      createComponentMatch(
        "chat-list",
        "chat-list-pane",
        detectWinningSelector(input.chatList, [
          "[data-testid='chat-list']",
          "div[role='grid']",
          "[aria-label*='Chat']",
        ]),
        90,
        ["scrollable", "left-pane"],
      ),
    );
  }

  if (selectedRow) {
    matches.push(
      createComponentMatch(
        "selected-chat-row",
        "chat-list-pane",
        "[aria-selected='true']",
        100,
        ["selected", "visible"],
        {
          selectedChatLabel: input.selectedChat || null,
          chatIdCandidate: input.chatIdCandidate || null,
        },
      ),
    );
  }

  if (input.timeline?.node) {
    matches.push(
      createComponentMatch(
        "conversation-root",
        "conversation-pane",
        input.timeline.selector || "main",
        input.composer ? 92 : 72,
        input.composer ? ["center-pane", "timeline", "composer"] : ["center-pane", "timeline"],
      ),
    );

    matches.push(
      createComponentMatch(
        "timeline",
        "conversation-pane",
        input.timeline.selector,
        95,
        ["scrollable", "center-pane"],
        {
          anchorCount: input.messageAnchors.length,
        },
      ),
    );
  }

  if (input.conversationHeader) {
    matches.push(
      createComponentMatch(
        "conversation-header",
        "conversation-pane",
        detectWinningSelector(input.conversationHeader, [
          "main header [title]",
          "main header span[dir='auto']",
          "main header h1",
        ]),
        88,
        ["visible", "top-of-conversation"],
        {
          chatTitle: input.title || null,
        },
      ),
    );
  }

  if (input.messageAnchors.length > 0) {
    matches.push(
      createComponentMatch(
        "message-anchor",
        "conversation-pane",
        detectWinningSelector(input.messageAnchors[0], [
          "main [data-testid='msg-container']",
          "main div[data-id]",
          "main [data-testid^='msg-']",
        ]),
        input.messageAnchors.length > 1 ? 90 : 60,
        ["visible", "repeated-vertically"],
        {
          count: input.messageAnchors.length,
        },
      ),
    );
  }

  if (input.composer) {
    matches.push(
      createComponentMatch(
        "composer",
        "conversation-pane",
        detectWinningSelector(input.composer, [
          "footer [contenteditable='true']",
          "div[contenteditable='true'][role='textbox']",
          "footer div[contenteditable='true']",
        ]),
        96,
        ["contenteditable", "bottom-of-conversation"],
      ),
    );
  }

  if (input.drawer) {
    matches.push(
      createComponentMatch(
        "drawer",
        "right-drawer",
        detectWinningSelector(input.drawer, [
          "main aside",
          "[data-animate-drawer='true']",
          "div[role='button'][aria-label='Close']",
        ]),
        86,
        ["visible", "right-pane"],
      ),
    );
  }

  if (input.modal) {
    matches.push(
      createComponentMatch("modal", "modal-layer", "[role='dialog']", 100, ["visible", "overlay", "blocking"]),
    );
  }

  return matches;
}

function createComponentMatch(id, surface, selector, score, signals, extracted = null) {
  return {
    id,
    surface,
    selector: selector || null,
    score,
    confidence: score >= 90 ? "high" : score >= 70 ? "medium" : "low",
    signals,
    extracted,
    count:
      extracted && typeof extracted.count === "number"
        ? extracted.count
        : extracted && typeof extracted.anchorCount === "number"
          ? extracted.anchorCount
          : undefined,
  };
}

function detectWinningSelector(node, selectors) {
  if (!(node instanceof Element)) return null;

  for (const selector of selectors) {
    try {
      if (node.matches(selector)) return selector;
      if (node.closest(selector)) return selector;
    } catch {}
  }

  return selectors[0] || null;
}

function collectSelectorProbes() {
  return SELECTOR_PROBE_DEFS.map(([name, selector]) => {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      nodes = [];
    }

    const visible = nodes.filter(isVisibleElement);
    const sampleNode = visible[0] || nodes[0] || null;
    const sampleText =
      sampleNode && typeof sampleNode.textContent === "string" ? sampleNode.textContent.trim().replace(/\s+/g, " ").slice(0, 80) : null;

    return {
      name,
      selector,
      count: nodes.length,
      visibleCount: visible.length,
      sampleText: sampleText || null,
      samplePath: sampleNode ? buildNodePath(sampleNode) : [],
    };
  });
}

function buildNodePath(node) {
  const parts = [];
  let current = node instanceof Element ? node : null;
  let depth = 0;

  while (current && depth < 6) {
    parts.push(describeNode(current));
    current = current.parentElement;
    depth += 1;
  }

  return parts;
}

function describeNode(node) {
  const attrs = [
    node.id ? `#${node.id}` : null,
    node.getAttribute("role") ? `[role=${node.getAttribute("role")}]` : null,
    node.getAttribute("data-testid") ? `[data-testid=${node.getAttribute("data-testid")}]` : null,
    node.getAttribute("aria-label") ? `[aria-label=${truncateAttr(node.getAttribute("aria-label"))}]` : null,
    node.getAttribute("contenteditable") ? `[contenteditable=${node.getAttribute("contenteditable")}]` : null,
    node.getAttribute("title") ? `[title=${truncateAttr(node.getAttribute("title"))}]` : null,
  ].filter(Boolean);

  return `${node.tagName.toLowerCase()}${attrs.length ? attrs.join("") : ""}`;
}

function truncateAttr(value) {
  if (!value) return value;
  return value.length > 32 ? `${value.slice(0, 29)}...` : value;
}

function detectConversationHeader() {
  return (
    document.querySelector("main header [title]") ||
    document.querySelector("main header span[dir='auto']") ||
    document.querySelector("main header h1")
  );
}

function detectComposer() {
  return (
    document.querySelector("footer [contenteditable='true']") ||
    document.querySelector("div[contenteditable='true'][role='textbox']") ||
    document.querySelector("footer div[contenteditable='true']")
  );
}

function detectChatList() {
  return (
    document.querySelector("[aria-label*='Chat']") ||
    document.querySelector("[data-testid='chat-list']") ||
    document.querySelector("div[role='grid']")
  );
}

function detectDrawer() {
  return (
    document.querySelector("main aside") ||
    document.querySelector("[data-animate-drawer='true']") ||
    document.querySelector("div[role='button'][aria-label='Close']")
  );
}

function detectVisibleChatRows() {
  return Array.from(document.querySelectorAll(CHAT_ROW_SELECTOR))
    .filter(isVisibleElement)
    .map((row, index) => {
      const titleNode = extractChatRowTitleNode(row);
      const title = (titleNode?.getAttribute?.("title") || titleNode?.textContent || "").trim();
      const titleContainer = titleNode?.parentElement || null;
      if (!title || !titleContainer) return null;

      const chatIdCandidate = extractChatIdCandidates(row)[0] || null;
      const selectedNode = row.querySelector("[aria-selected]");
      return {
        id: buildChatRowId(title, chatIdCandidate, index),
        row,
        title,
        titleContainer,
        chatIdCandidate,
        selected: selectedNode?.getAttribute?.("aria-selected") === "true",
      };
    })
    .filter(Boolean);
}

function extractChatRowTitleNode(row) {
  const candidates = Array.from(row.querySelectorAll("span[title][dir='auto']")).filter(isVisibleElement);
  return candidates[0] || null;
}

function buildChatRowId(title, chatIdCandidate, index) {
  const base = (chatIdCandidate || title || `row-${index}`).toLowerCase().replace(/\s+/g, "-").slice(0, 48);
  return `row-${index}-${base}`;
}

function detectSelectedChatLabel() {
  const candidates = [
    document.querySelector("[aria-selected='true'] [title]"),
    document.querySelector("[aria-selected='true'] span[dir='auto']"),
    document.querySelector("nav [aria-selected='true'] [title]"),
  ];

  for (const node of candidates) {
    const text = (node?.getAttribute?.("title") || node?.textContent || "").trim();
    if (text) return text;
  }

  return null;
}

function detectChatIdCandidate() {
  if (latestPageChat?.chatId) {
    return latestPageChat.chatId;
  }

  const nodes = [
    document.querySelector("main header"),
    document.querySelector("[aria-selected='true']"),
    document.querySelector("main [data-testid='conversation-panel-body']"),
    document.querySelector("main"),
  ];

  for (const node of nodes) {
    const candidates = extractChatIdCandidates(node);
    if (candidates.length > 0) {
      return candidates[0];
    }
  }

  return null;
}

function extractChatIdCandidates(node) {
  if (!(node instanceof Element)) return [];

  const snippets = [];
  const addSnippet = (value) => {
    if (typeof value === "string" && value.trim()) {
      snippets.push(value);
    }
  };

  if (node !== document.querySelector("main") && node.outerHTML.length <= 20_000) {
    addSnippet(node.outerHTML);
  }
  for (const attr of node.attributes) {
    addSnippet(attr.value);
  }

  let parent = node.parentElement;
  let depth = 0;
  while (parent && depth < 2) {
    if (parent.outerHTML.length <= 20_000) {
      addSnippet(parent.outerHTML);
    }
    parent = parent.parentElement;
    depth += 1;
  }

  const matches = new Set();
  const patterns = [
    /\b\d{10,}@g\.us\b/g,
    /\b\d{8,}@s\.whatsapp\.net\b/g,
    /\bgroup:\d+\b/g,
    /\b120363\d{6,}\b/g,
  ];

  for (const snippet of snippets) {
    for (const pattern of patterns) {
      for (const match of snippet.matchAll(pattern)) {
        if (match[0]) {
          matches.add(match[0]);
        }
      }
    }
  }

  return [...matches].sort(compareChatIdCandidatePriority);
}

function compareChatIdCandidatePriority(a, b) {
  return scoreChatIdCandidate(b) - scoreChatIdCandidate(a);
}

function scoreChatIdCandidate(value) {
  if (value.includes("@g.us")) return 5;
  if (value.startsWith("group:")) return 4;
  if (/^120363\d+$/.test(value)) return 3;
  if (value.includes("@s.whatsapp.net")) return 2;
  return 1;
}

function detectTimelineContainer() {
  const candidates = [
    ["conversation-panel-body", document.querySelector("main [data-testid='conversation-panel-body']")],
    ["message-list", document.querySelector("main [aria-label='Message list']")],
    ["application", document.querySelector("main [role='application']")],
    ["main", document.querySelector("main")],
  ];

  for (const [selector, node] of candidates) {
    if (node) return { selector, node };
  }

  return { selector: null, node: null };
}

function detectTimelineInsertionPoint() {
  const candidates = [
    ["conversation-panel-body>div", document.querySelector("main [data-testid='conversation-panel-body'] > div")],
    ["conversation-panel-body", document.querySelector("main [data-testid='conversation-panel-body']")],
    ["message-list", document.querySelector("main [aria-label='Message list']")],
    ["main", document.querySelector("main")],
  ];

  for (const [selector, node] of candidates) {
    if (node) return { selector, node };
  }

  return { selector: null, node: null };
}

function detectMessageAnchors() {
  const selectors = [
    "main [data-testid='msg-container']",
    "[data-testid='msg-container']",
    "main div[data-id]",
    "div[data-id]",
    "main [data-testid^='msg-']",
    "[data-testid^='msg-']",
  ];

  for (const selector of selectors) {
    const nodes = Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
    if (nodes.length > 1) {
      return { selector, nodes };
    }
  }

  return { selector: null, nodes: [] };
}

function renderTimelineProbe() {
  const existing = document.getElementById(INLINE_PROBE_ID);
  const { selector, nodes } = detectMessageAnchors();
  existing?.remove();
  latestTimelineDebug = {
    timeline: null,
    insertionPoint: null,
    anchorSelector: selector,
    anchorCount: nodes.length,
    mode: "cli-preview-only",
  };
  render();
}

async function refreshChatListOverlay() {
  if (pollingStopped || chatListRefreshInFlight) return;

  const rows = detectVisibleChatRows();
  if (rows.length === 0) {
    latestChatListItems = [];
    clearChatListBadges();
    return;
  }

  chatListRefreshInFlight = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "ravi:chat-list-resolve",
      payload: {
        entries: rows.map((row) => ({
          id: row.id,
          chatId: row.chatIdCandidate,
          title: row.title,
        })),
      },
    });

    latestChatListItems = Array.isArray(response?.items) ? response.items : [];
    renderChatListBadges(rows, latestChatListItems);
  } catch (error) {
    handleRuntimeError(error);
  } finally {
    chatListRefreshInFlight = false;
  }
}

function renderChatListBadges(rows, items) {
  const visibleIds = new Set(rows.map((row) => row.id));
  const byId = new Map(items.map((item) => [item.id, item]));

  document.querySelectorAll(`[${CHAT_ROW_BADGE_ATTR}]`).forEach((node) => {
    const rowId = node.getAttribute("data-ravi-chat-row-id");
    if (!rowId || !visibleIds.has(rowId)) {
      node.remove();
    }
  });

  for (const row of rows) {
    const item = byId.get(row.id);
    const existing = row.titleContainer.querySelector(`[${CHAT_ROW_BADGE_ATTR}]`);
    if (!item?.resolved || !item.session) {
      existing?.remove();
      continue;
    }

    const chip = existing || createChatListBadge();
    chip.setAttribute("data-ravi-chat-row-id", row.id);
    chip.className = `ravi-wa-chat-chip ravi-wa-chat-chip--${chipActivityClass(item.session.live?.activity)}`;
    chip.textContent = formatChatListBadge(item.session);
    chip.title = `${item.session.sessionName} · ${item.session.live?.summary || item.session.live?.activity || "idle"}`;
    row.titleContainer.appendChild(chip);
  }
}

function createChatListBadge() {
  const chip = document.createElement("span");
  chip.setAttribute(CHAT_ROW_BADGE_ATTR, "true");
  return chip;
}

function clearChatListBadges() {
  document.querySelectorAll(`[${CHAT_ROW_BADGE_ATTR}]`).forEach((node) => node.remove());
}

function refreshMessageChips() {
  if (pollingStopped) return;

  const view = latestViewState || detectViewState();
  if (!view?.screen?.startsWith("conversation")) {
    clearMessageChips();
    return;
  }

  const messages = detectVisibleMessages();
  const visibleIds = new Set(messages.map((message) => message.id));

  if (openMessageId && !visibleIds.has(openMessageId)) {
    closeMessagePopover();
  }

  document.querySelectorAll(`[${MESSAGE_CHIP_ATTR}]`).forEach((node) => {
    const messageId = node.getAttribute("data-ravi-message-id");
    if (!messageId || !visibleIds.has(messageId)) {
      if (node === openMessageChip && messageId !== openMessageId) {
        closeMessagePopover();
      }
      node.remove();
    }
  });

  for (const message of messages) {
    if (!message.chipHost) continue;

    const duplicates = Array.from(document.querySelectorAll(`[${MESSAGE_CHIP_ATTR}][data-ravi-message-id="${message.id}"]`));
    const existing =
      duplicates.find((node) => node.parentElement === message.chipHost) || message.chipHost.querySelector(`[${MESSAGE_CHIP_ATTR}]`);

    duplicates.forEach((node) => {
      if (node !== existing) {
        node.remove();
      }
    });

    const chip = existing || createMessageChip();
    chip.setAttribute("data-ravi-message-id", message.id);
    updateMessageChip(chip, message);
    if (openMessageId === message.id) {
      openMessageChip = chip;
    }
    if (
      message.insertAfterNode instanceof Element &&
      message.insertAfterNode.parentElement === message.chipHost
    ) {
      message.insertAfterNode.insertAdjacentElement("afterend", chip);
    } else {
      message.chipHost.appendChild(chip);
    }
  }

  syncMessagePopoverPosition();
}

function detectVisibleMessages() {
  const { nodes } = detectMessageAnchors();
  return nodes
    .map((node, index) => describeVisibleMessage(node, index))
    .filter(Boolean);
}

function describeVisibleMessage(node, index) {
  if (!(node instanceof HTMLElement)) return null;

  const messageId = node.getAttribute("data-id") || `message-${index}`;
  const copyable = findPrimaryMessageCopyable(node);
  const mediaType = detectMessageMediaType(node);
  if (!copyable && !mediaType) return null;

  const meta = copyable ? parseMessagePrePlainText(copyable.getAttribute("data-pre-plain-text") || "") : null;
  const direction = detectMessageDirection(node, messageId);
  const timestampShort = shortenMessageTimestamp(meta?.timestampLabel) || detectMessageTimestamp(node);
  const authorAnchor = copyable ? findMessageAuthorAnchor(node, copyable) : findMediaAuthorAnchor(node, direction);
  const timeAnchor = findMessageTimeAnchor(node, timestampShort);
  const author = authorAnchor?.author || meta?.author || (direction === "out" ? "você" : null);

  const chipHost = timeAnchor?.chipHost || authorAnchor?.chipHost || null;
  const chipVariant = timeAnchor?.chipHost ? "timestamp" : "author";

  if (!chipHost) {
    return null;
  }

  return {
    id: messageId,
    node,
    direction,
    author,
    timestampLabel: meta?.timestampLabel || timestampShort,
    timestampShort,
    messageKey: extractMessageKey(messageId),
    externalMessageId: extractExternalMessageId(messageId),
    mediaType,
    chipHost,
    insertAfterNode: timeAnchor?.insertAfterNode || null,
    chipVariant,
  };
}

function findPrimaryMessageCopyable(node) {
  const candidates = Array.from(node.querySelectorAll("[data-pre-plain-text]"));
  return (
    candidates.find((candidate) => candidate.getAttribute("data-pre-plain-text")?.startsWith("[")) || null
  );
}

function parseMessagePrePlainText(value) {
  const source = (value || "").trim();
  const match = source.match(/^\[(.+?)\]\s(.+?):\s*$/);
  if (!match) {
    return {
      timestampLabel: source || null,
      author: null,
    };
  }

  return {
    timestampLabel: match[1] || null,
    author: match[2] || null,
  };
}

function shortenMessageTimestamp(value) {
  if (!value) return "";
  const [time] = value.split(",");
  return (time || value).trim();
}

function detectMessageTimestamp(node) {
  const candidates = Array.from(node.querySelectorAll("span, div")).filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (!isVisibleElement(element)) return false;
    const text = (element.textContent || "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(text)) return false;
    return !Array.from(element.children).some((child) => /^\d{1,2}:\d{2}$/.test((child.textContent || "").trim()));
  });

  const leaf = candidates[candidates.length - 1] || null;
  return leaf ? (leaf.textContent || "").trim() : "";
}

function detectMessageDirection(node, messageId) {
  if (node.querySelector(".message-out")) return "out";
  if (node.querySelector(".message-in")) return "in";
  if (messageId.startsWith("true_")) return "out";
  if (messageId.startsWith("false_")) return "in";
  return "unknown";
}

function detectMessageMediaType(node) {
  if (node.querySelector("[data-icon='ptt-status'], [aria-label*='voz'], [aria-label*='voice']")) {
    return "audio";
  }
  if (node.querySelector("video")) return "video";
  if (node.querySelector("img")) return "image";
  return null;
}

function findMessageAuthorAnchor(node, copyable) {
  const contentRow = copyable.parentElement;
  if (!(contentRow instanceof Element)) return null;

  const siblings = Array.from(contentRow.children);
  const authorBlock = siblings.find((child) => {
    if (child === copyable) return false;
    const label = child.querySelector("span[dir='auto']");
    return Boolean(label && (label.textContent || "").trim());
  });

  const authorLabel = authorBlock?.querySelector("span[dir='auto']");
  if (authorBlock && authorLabel) {
    return {
      chipHost: authorBlock,
      author: authorLabel.textContent.trim(),
    };
  }

  const outboundLabel = node.querySelector("[aria-label='Você:']");
  if (outboundLabel?.parentElement instanceof Element) {
    return {
      chipHost: outboundLabel.parentElement,
      author: "você",
    };
  }

  return null;
}

function findMediaAuthorAnchor(node, direction) {
  const explicitAuthor = node.querySelector("span[dir='auto']");
  if (explicitAuthor?.parentElement instanceof Element && (explicitAuthor.textContent || "").trim()) {
    return {
      chipHost: explicitAuthor.parentElement,
      author: explicitAuthor.textContent.trim(),
    };
  }

  const footerButton = node.querySelector("div[role='button']");
  if (footerButton instanceof Element && direction === "out") {
    return {
      chipHost: footerButton,
      author: "você",
    };
  }

  return null;
}

function findMessageTimeAnchor(node, timestampShort) {
  if (!timestampShort || timestampShort === "-") return null;

  const candidates = Array.from(node.querySelectorAll("span, div")).filter((element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (!isVisibleElement(element)) return false;
    const text = (element.textContent || "").trim();
    if (text !== timestampShort) return false;
    return !Array.from(element.children).some((child) => (child.textContent || "").trim() === timestampShort);
  });

  const timeLeaf = candidates[candidates.length - 1] || null;
  let chipHost = timeLeaf?.parentElement || null;
  if (!(chipHost instanceof Element)) return null;

  const interactiveAncestor = timeLeaf?.closest("button, [role='button']");
  const insertAfterNode =
    interactiveAncestor instanceof Element && interactiveAncestor.parentElement instanceof Element
      ? interactiveAncestor
      : null;
  if (insertAfterNode?.parentElement instanceof Element) {
    chipHost = insertAfterNode.parentElement;
  }

  return {
    chipHost,
    timeLeaf,
    insertAfterNode,
  };
}

function extractMessageKey(messageId) {
  const externalId = extractExternalMessageId(messageId);
  const raw = externalId || messageId || "-";
  return shorten(raw, 12);
}

function extractExternalMessageId(messageId) {
  const parts = String(messageId || "")
    .split("_")
    .filter(Boolean);
  if (parts.length >= 3 && (parts[0] === "true" || parts[0] === "false")) {
    return parts[2] || null;
  }
  return messageId || null;
}

function createMessageChip() {
  const root = document.createElement("span");
  root.setAttribute(MESSAGE_CHIP_ATTR, "true");
  root.className = "ravi-wa-message-chip ravi-wa-message-chip--author";
  root.innerHTML = `
    <button class="ravi-wa-message-chip__button" type="button">
      <span class="ravi-wa-message-chip__dot ravi-wa-message-chip__dot--idle" data-role="dot"></span>
      <span class="ravi-wa-message-chip__time" data-role="time-inline"></span>
      <span class="ravi-wa-message-chip__separator" data-role="separator">•</span>
      <span class="ravi-wa-message-chip__label">ravi</span>
    </button>
  `;

  const button = root.querySelector(".ravi-wa-message-chip__button");
  ["pointerdown", "mousedown", "mouseup"].forEach((eventName) => {
    button?.addEventListener(eventName, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  });
  button?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = root.__raviMessageState || null;
    if (openMessageId === root.getAttribute("data-ravi-message-id")) {
      closeMessagePopover();
      return;
    }
    openMessagePopover(root, state);
  });

  return root;
}

function updateMessageChip(root, message) {
  const session = latestSnapshot?.session;
  const live = session?.live;
  const activity = chipActivityClass(live?.activity);
  const label = root.querySelector(".ravi-wa-message-chip__label");
  const dot = root.querySelector("[data-role='dot']");
  const inlineTime = root.querySelector("[data-role='time-inline']");
  const separator = root.querySelector("[data-role='separator']");
  const variant = message.chipVariant || "author";
  const open = openMessageId === message.id;
  const cacheKey =
    session?.sessionName && message.externalMessageId ? `${session.sessionName}:${message.externalMessageId}` : null;
  const cachedMeta = cacheKey && messageMetaCache.has(cacheKey) ? (messageMetaCache.get(cacheKey) ?? null) : undefined;
  const preservedMeta =
    open && openMessageData?.externalMessageId === message.externalMessageId
      ? (openMessageData.messageMeta ?? cachedMeta)
      : cachedMeta;
  const preservedLoading =
    open && openMessageData?.externalMessageId === message.externalMessageId ? Boolean(openMessageData.metaLoading) : false;
  const preservedCopyState =
    open && openMessageData?.externalMessageId === message.externalMessageId ? openMessageData.copyState ?? null : null;

  root.className = `ravi-wa-message-chip ravi-wa-message-chip--${variant} ravi-wa-message-chip--${activity}${open ? " ravi-wa-message-chip--open" : ""}`;
  root.title = `${message.author || "mensagem"} · ${message.timestampShort || "-"} · ${session?.sessionName || "sem sessão"}`;
  root.__raviMessageState = {
    ...message,
    sessionName: session?.sessionName || "ravi",
    agentId: session?.agentId || "-",
    activity,
    activityLabel: chipActivityLabel(live?.activity),
    messageMeta: preservedMeta,
    metaLoading: preservedLoading,
    copyState: preservedCopyState,
  };

  if (label) label.textContent = "ravi";
  if (dot) {
    dot.className = `ravi-wa-message-chip__dot ravi-wa-message-chip__dot--${activity}`;
  }
  if (inlineTime) {
    inlineTime.textContent = "";
    inlineTime.hidden = true;
  }
  if (separator) {
    separator.hidden = true;
  }

  if (open) {
    openMessageData = root.__raviMessageState;
    renderMessagePopover(openMessageData);
  }
}

function openMessagePopover(chip, message) {
  if (!chip || !message) return;
  openMessageChip = chip;
  openMessageId = chip.getAttribute("data-ravi-message-id") || message.id || null;
  openMessageData = message;
  chip.classList.add("ravi-wa-message-chip--open");
  renderMessagePopover(message);
  void hydrateMessagePopoverMeta(message);
}

function closeMessagePopover() {
  const popover = document.getElementById(MESSAGE_POPOVER_ID);
  if (openMessageChip) {
    openMessageChip.classList.remove("ravi-wa-message-chip--open");
  }
  openMessageChip = null;
  openMessageId = null;
  openMessageData = null;
  if (popover) {
    popover.className = "ravi-hidden";
    popover.innerHTML = "";
    popover.removeAttribute("data-placement");
    popover.style.top = "";
    popover.style.left = "";
    popover.style.visibility = "";
  }
}

function renderMessagePopover(message) {
  const popover = ensureMessagePopover();
  if (!message) {
    closeMessagePopover();
    return;
  }

  const transcript = message.messageMeta?.transcription || "";
  const mediaLabel = message.mediaType || "texto";
  const directionLabel = message.direction === "out" ? "out" : message.direction === "in" ? "in" : "-";
  popover.className = `ravi-wa-message-popover ravi-wa-message-popover--${message.activity || "idle"}`;
  popover.innerHTML = `
    <div class="ravi-wa-message-popover__head">
      <strong>${escapeHtml(message.sessionName || "ravi")}</strong>
      <span>${escapeHtml(`${message.agentId || "-"} · ${message.activityLabel || "idle"}`)}</span>
    </div>
    ${
      message.metaLoading
        ? `<section class="ravi-wa-message-popover__transcript">
            <div class="ravi-wa-message-popover__transcript-head">
              <span>transcript</span>
            </div>
            <p>carregando...</p>
          </section>`
        : transcript
          ? `<section class="ravi-wa-message-popover__transcript">
              <div class="ravi-wa-message-popover__transcript-head">
                <span>transcript</span>
                <button type="button" class="ravi-wa-message-popover__copy" data-action="copy-transcript">
                  ${escapeHtml(message.copyState === "copied" ? "copiado" : "copiar")}
                </button>
              </div>
              <p>${escapeHtml(transcript)}</p>
            </section>`
          : ""
    }
    <dl class="ravi-wa-message-popover__meta ravi-wa-message-popover__meta--compact">
      <div><dt>autor</dt><dd>${escapeHtml(message.author || "-")}</dd></div>
      <div><dt>tipo</dt><dd>${escapeHtml(mediaLabel)}</dd></div>
      <div><dt>hora</dt><dd>${escapeHtml(message.timestampShort || "-")}</dd></div>
      <div><dt>fluxo</dt><dd>${escapeHtml(directionLabel)}</dd></div>
      <div class="ravi-wa-message-popover__meta-full"><dt>id</dt><dd class="ravi-wa-message-popover__meta-mono">${escapeHtml(message.messageKey || "-")}</dd></div>
    </dl>
  `;

  const copyButton = popover.querySelector("[data-action='copy-transcript']");
  copyButton?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!transcript || !openMessageData) return;

    const copied = await copyTextToClipboard(transcript);
    if (!copied) return;

    openMessageData = { ...openMessageData, copyState: "copied" };
    renderMessagePopover(openMessageData);
    setTimeout(() => {
      if (!openMessageData) return;
      if (openMessageData.externalMessageId !== message.externalMessageId) return;
      openMessageData = { ...openMessageData, copyState: null };
      renderMessagePopover(openMessageData);
    }, 1400);
  });

  syncMessagePopoverPosition();
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function hydrateMessagePopoverMeta(message) {
  const session = latestSnapshot?.session;
  const sessionName = session?.sessionName || null;
  const messageId = message?.externalMessageId || null;
  if (!messageId || !sessionName) {
    return;
  }

  const cacheKey = `${sessionName}:${messageId}`;
  if (messageMetaCache.has(cacheKey)) {
    const cached = messageMetaCache.get(cacheKey) ?? null;
    if (openMessageData && openMessageData.externalMessageId === messageId) {
      openMessageData = { ...openMessageData, metaLoading: false, messageMeta: cached };
      renderMessagePopover(openMessageData);
    }
    return;
  }

  if (openMessageData && openMessageData.externalMessageId === messageId) {
    openMessageData = { ...openMessageData, metaLoading: true };
    renderMessagePopover(openMessageData);
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ravi:get-message-meta",
      payload: {
        session: sessionName,
        chatId: session?.chatId || latestViewState?.chatIdCandidate || null,
        messageId,
      },
    });

    const meta = response?.ok ? response.meta || null : null;
    messageMetaCache.set(cacheKey, meta);

    if (openMessageData && openMessageData.externalMessageId === messageId) {
      openMessageData = { ...openMessageData, metaLoading: false, messageMeta: meta };
      renderMessagePopover(openMessageData);
    }
  } catch {
    if (openMessageData && openMessageData.externalMessageId === messageId) {
      openMessageData = { ...openMessageData, metaLoading: false };
      renderMessagePopover(openMessageData);
    }
  }
}

function syncMessagePopoverPosition() {
  if (!openMessageId || !openMessageData) return;

  const popover = ensureMessagePopover();
  if (!openMessageChip || !document.contains(openMessageChip)) {
    return;
  }

  popover.className = `ravi-wa-message-popover ravi-wa-message-popover--${openMessageData.activity || "idle"}`;
  popover.style.visibility = "hidden";
  popover.style.top = "0px";
  popover.style.left = "0px";

  const rect = openMessageChip.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const width = popover.offsetWidth || 220;
  const height = popover.offsetHeight || 160;
  const canPlaceAbove = rect.top - gap - height >= margin;
  const canPlaceBelow = rect.bottom + gap + height <= window.innerHeight - margin;
  const placeAbove = !canPlaceBelow && canPlaceAbove;

  let top = placeAbove ? rect.top - height - gap : rect.bottom + gap;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

  let left = rect.left;
  if (left + width > window.innerWidth - margin) {
    left = window.innerWidth - width - margin;
  }
  left = Math.max(margin, left);

  popover.dataset.placement = placeAbove ? "top" : "bottom";
  popover.style.top = `${Math.round(top)}px`;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.visibility = "visible";
}

function clearMessageChips() {
  closeMessagePopover();
  document.querySelectorAll(`[${MESSAGE_CHIP_ATTR}]`).forEach((node) => node.remove());
}

function formatChatListBadge(session) {
  const name = shorten(session.sessionName || session.agentId || "session", 16);
  const elapsed = formatElapsedCompact(session.live?.updatedAt ?? session.updatedAt);
  return elapsed ? `${name} · ${chipActivityLabel(session.live?.activity)} · ${elapsed}` : `${name} · ${chipActivityLabel(session.live?.activity)}`;
}

function chipActivityLabel(activity) {
  switch (activity) {
    case "streaming":
      return "live";
    case "thinking":
      return "thinking";
    case "awaiting_approval":
      return "approval";
    case "compacting":
      return "compact";
    case "blocked":
      return "blocked";
    default:
      return "idle";
  }
}

function chipActivityClass(activity) {
  switch (activity) {
    case "streaming":
      return "streaming";
    case "thinking":
      return "thinking";
    case "awaiting_approval":
      return "approval";
    case "compacting":
      return "compacting";
    case "blocked":
      return "blocked";
    default:
      return "idle";
  }
}

function ensurePageBridge() {
  if (document.getElementById(PAGE_BRIDGE_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = PAGE_BRIDGE_SCRIPT_ID;
  script.src = chrome.runtime.getURL("page-bridge.js");
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
}

function requestPageChatInfo() {
  document.dispatchEvent(new CustomEvent(PAGE_CHAT_REQUEST_EVENT));
}

function handlePageChatEvent(event) {
  latestPageChat = event?.detail ?? null;
}

function ensureShell() {
  if (document.getElementById(ROOT_ID)) return;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML = `
    <button id="ravi-wa-overlay-pill" type="button" aria-expanded="false">
      <span id="ravi-wa-overlay-pill-dot" class="ravi-wa-pill-dot ravi-wa-pill-dot--idle"></span>
      <span class="ravi-wa-pill-copy">
        <strong id="ravi-wa-overlay-pill-title">ravi</strong>
        <span id="ravi-wa-overlay-pill-subtitle">sem sessão</span>
      </span>
      <span id="ravi-wa-overlay-pill-state" class="ravi-wa-pill-state ravi-wa-pill-state--idle">idle</span>
    </button>
    <aside id="${DRAWER_ID}" class="ravi-hidden">
      <div class="ravi-wa-drawer-header">
        <div class="ravi-wa-drawer-heading">
          <strong>Ravi</strong>
          <span id="ravi-wa-overlay-panel-subtitle">cockpit</span>
        </div>
        <button id="ravi-wa-overlay-close" type="button">×</button>
      </div>
      <div id="ravi-wa-overlay-body"></div>
    </aside>
  `;
  document.body.appendChild(root);

  root.querySelector("#ravi-wa-overlay-pill")?.addEventListener("click", () => {
    drawerOpen = !drawerOpen;
    syncDrawerVisibility();
  });
  root.querySelector("#ravi-wa-overlay-close")?.addEventListener("click", () => {
    drawerOpen = false;
    syncDrawerVisibility();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (openMessageChip) {
      closeMessagePopover();
      return;
    }

    if (!drawerOpen) return;
    drawerOpen = false;
    syncDrawerVisibility();
  });
}

function syncDrawerVisibility() {
  const drawer = document.getElementById(DRAWER_ID);
  const pill = document.getElementById("ravi-wa-overlay-pill");
  if (!drawer) return;
  drawer.classList.toggle("ravi-hidden", !drawerOpen);
  pill?.setAttribute("aria-expanded", drawerOpen ? "true" : "false");
}

function ensureMessagePopover() {
  let popover = document.getElementById(MESSAGE_POPOVER_ID);
  if (popover) return popover;

  popover = document.createElement("div");
  popover.id = MESSAGE_POPOVER_ID;
  popover.className = "ravi-hidden";
  document.body.appendChild(popover);
  return popover;
}

function render(snapshot = latestSnapshot, context = detectChatContext()) {
  const pill = document.getElementById("ravi-wa-overlay-pill");
  const body = document.getElementById("ravi-wa-overlay-body");
  const panelSubtitle = document.getElementById("ravi-wa-overlay-panel-subtitle");
  const pillTitle = document.getElementById("ravi-wa-overlay-pill-title");
  const pillSubtitle = document.getElementById("ravi-wa-overlay-pill-subtitle");
  const pillState = document.getElementById("ravi-wa-overlay-pill-state");
  const pillDot = document.getElementById("ravi-wa-overlay-pill-dot");
  if (!pill || !body || !panelSubtitle || !pillTitle || !pillSubtitle || !pillState || !pillDot) return;

  const session = snapshot?.session;
  const live = session?.live;
  const view = latestViewState;
  const title = context?.title || view?.title || "chat desconhecido";
  const activity = session?.live?.activity || "idle";
  const activityLabel = chipActivityLabel(activity);
  const activityClass = chipActivityClass(activity);

  pillTitle.textContent = "ravi";
  pillSubtitle.textContent = session ? `${session.sessionName} · ${session.agentId}` : view?.screen || "sem sessão";
  panelSubtitle.textContent = title;
  pillState.textContent = activityLabel;
  pillState.className = `ravi-wa-pill-state ravi-wa-pill-state--${activityClass}`;
  pillDot.className = `ravi-wa-pill-dot ravi-wa-pill-dot--${activityClass}`;

  const debugCard = `
    <details class="ravi-wa-disclosure">
      <summary>Detecção da página</summary>
      <dl class="ravi-wa-grid">
        <div><dt>Tela</dt><dd>${escapeHtml(view?.screen || "-")}</dd></div>
        <div><dt>Título</dt><dd>${escapeHtml(view?.title || "-")}</dd></div>
        <div><dt>Selecionado</dt><dd>${escapeHtml(view?.selectedChat || "-")}</dd></div>
        <div><dt>ChatId cand</dt><dd>${escapeHtml(view?.chatIdCandidate || "-")}</dd></div>
        <div><dt>Foco</dt><dd>${escapeHtml(view?.focus || "-")}</dd></div>
        <div><dt>Header</dt><dd>${flag(view?.hasConversationHeader)}</dd></div>
        <div><dt>Composer</dt><dd>${flag(view?.hasComposer)}</dd></div>
        <div><dt>Chat list</dt><dd>${flag(view?.hasChatList)}</dd></div>
        <div><dt>Drawer</dt><dd>${flag(view?.hasDrawer)}</dd></div>
        <div><dt>Modal</dt><dd>${flag(view?.hasModal)}</dd></div>
        <div><dt>Timeline</dt><dd>${escapeHtml(latestTimelineDebug?.timeline || "-")}</dd></div>
        <div><dt>Âncora</dt><dd>${escapeHtml(latestTimelineDebug?.anchorSelector || "-")}</dd></div>
        <div><dt>Count</dt><dd>${escapeHtml(String(latestTimelineDebug?.anchorCount ?? "-"))}</dd></div>
        <div><dt>Modo</dt><dd>${escapeHtml(latestTimelineDebug?.mode || "-")}</dd></div>
      </dl>
    </details>
  `;

  const logsCard = `
    <details class="ravi-wa-disclosure">
      <summary>Logs recentes</summary>
      <ul class="ravi-wa-log-list">
        ${detectionLogs
          .map(
            (entry) => `
              <li>
                <strong>${escapeHtml(entry.at)}</strong>
                <span>${escapeHtml(entry.summary)}</span>
                <small>${escapeHtml(entry.detail)}</small>
              </li>
            `,
          )
          .join("")}
      </ul>
    </details>
  `;

  const errorCard = bridgeError
    ? `
      <section class="ravi-wa-card ravi-wa-error-card">
        <h3>Bridge/Extensão</h3>
        <p>${escapeHtml(bridgeError.message)}</p>
      </section>
    `
    : "";

  if (!snapshot?.resolved || !session) {
    body.innerHTML = `
      ${errorCard}
      <section class="ravi-wa-card ravi-wa-hero-card">
        <div class="ravi-wa-hero-top">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p>Esse chat ainda não foi casado com nenhuma sessão do Ravi.</p>
          </div>
          <span class="ravi-wa-state-pill ravi-wa-state-pill--idle">unbound</span>
        </div>
        <div class="ravi-wa-chip-row">
          <span class="ravi-wa-meta-chip">screen ${escapeHtml(view?.screen || "-")}</span>
          <span class="ravi-wa-meta-chip">chat ${escapeHtml(shorten(title, 22))}</span>
        </div>
      </section>
      <section class="ravi-wa-card">
        <p>${(snapshot?.warnings || ["O bridge ainda não casou esse chat com nenhuma sessão do Ravi."]).join(" ")}</p>
      </section>
      ${debugCard}
      ${logsCard}
    `;
    return;
  }

  body.innerHTML = `
    ${errorCard}
    <section class="ravi-wa-card ravi-wa-hero-card">
      <div class="ravi-wa-hero-top">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(live?.summary || "sem evento vivo")}</p>
        </div>
        <span class="ravi-wa-state-pill ravi-wa-state-pill--${activityClass}">${escapeHtml(activityLabel)}</span>
      </div>
      <div class="ravi-wa-chip-row">
        <span class="ravi-wa-meta-chip">session ${escapeHtml(shorten(session.sessionName, 18))}</span>
        <span class="ravi-wa-meta-chip">agent ${escapeHtml(session.agentId)}</span>
        <span class="ravi-wa-meta-chip">${escapeHtml(session.modelOverride || session.runtimeProvider || "model -")}</span>
      </div>
    </section>
    <section class="ravi-wa-card">
      <dl class="ravi-wa-grid">
        <div><dt>Sessão</dt><dd>${escapeHtml(session.sessionName)}</dd></div>
        <div><dt>Agent</dt><dd>${escapeHtml(session.agentId)}</dd></div>
        <div><dt>Live</dt><dd>${escapeHtml(activityLabel)}</dd></div>
        <div><dt>Atualizado</dt><dd>${escapeHtml(formatTimestamp(live?.updatedAt))}</dd></div>
        <div><dt>Thinking</dt><dd>${escapeHtml(session.thinkingLevel || "-")}</dd></div>
        <div><dt>Modelo</dt><dd>${escapeHtml(session.modelOverride || session.runtimeProvider || "-")}</dd></div>
        <div><dt>Queue</dt><dd>${escapeHtml(session.queueMode || "-")}</dd></div>
        <div><dt>Heartbeat</dt><dd>${escapeHtml(session.lastHeartbeatText || "-")}</dd></div>
        <div><dt>Canal</dt><dd>${escapeHtml(session.channel || "-")}</dd></div>
        <div><dt>Instância</dt><dd>${escapeHtml(session.accountId || "-")}</dd></div>
      </dl>
    </section>
    <section class="ravi-wa-card">
      <div class="ravi-wa-actions">
        <button data-action="abort">Abortar</button>
        <button data-action="reset">Resetar</button>
        <button data-action="set-thinking" data-value="normal">Thinking normal</button>
        <button data-action="set-thinking" data-value="verbose">Thinking verbose</button>
      </div>
    </section>
    ${debugCard}
    ${logsCard}
  `;

  body.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.getAttribute("data-action");
      const value = button.getAttribute("data-value");
      try {
        const next = await chrome.runtime.sendMessage({
          type: "ravi:session-action",
          payload: {
            session: session.sessionKey,
            action,
            value,
          },
        });
        bridgeError = null;
        latestSnapshot = next;
        render(next, context);
      } catch (error) {
        handleRuntimeError(error);
      }
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function shorten(value, max) {
  if (!value || value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function flag(value) {
  return value ? "yes" : "no";
}

function formatTimestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return new Date(value).toLocaleTimeString();
}

function formatElapsedCompact(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";

  const deltaMs = Math.max(0, Date.now() - value);
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function hasViewChanged(prev, next) {
  if (!prev) return true;
  return JSON.stringify(prev) !== JSON.stringify(next);
}

function handleRuntimeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  bridgeError = {
    message: message.includes("Extension context invalidated")
      ? "A extensao foi recarregada. Atualiza a aba do WhatsApp para reinjetar o overlay."
      : message,
  };

  if (message.includes("Extension context invalidated")) {
    pollingStopped = true;
    for (const id of intervalIds) clearInterval(id);
  }

  console.warn("[RaviOverlay] runtime-error", error);
  render();
}

function isVisibleElement(node) {
  return node instanceof HTMLElement && node.offsetParent !== null;
}

async function publishViewState(view) {
  const context = detectChatContext();
  const response = await chrome.runtime.sendMessage({
    type: "ravi:publish-view-state",
    payload: {
      clientId,
      app: "whatsapp-web",
      context,
      view,
      postedAt: Date.now(),
    },
  });

  lastPublishedAt = Date.now();
  if (response?.snapshot) {
    latestSnapshot = response.snapshot;
    bridgeError = null;
  }
}

async function pollDomCommands() {
  if (pollingStopped || domCommandInFlight) return;
  domCommandInFlight = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ravi:dom-next-command",
      payload: { clientId },
    });

    const command = response?.command;
    if (!command?.id || !command?.request?.name) {
      return;
    }

    const result = executeDomCommand(command);
    await chrome.runtime.sendMessage({
      type: "ravi:dom-command-result",
      payload: { result },
    });

    if (["click", "inject", "remove", "outline", "clear", "text", "attr"].includes(command.request.name)) {
      refreshAll();
    }
  } catch (error) {
    handleRuntimeError(error);
  } finally {
    domCommandInFlight = false;
  }
}

function executeDomCommand(command) {
  const request = command.request || {};
  const selector = request.selector || "";
  const nodes = selector ? selectDomNodes(selector, request) : [];
  const first = nodes[request.index || 0] || nodes[0] || null;

  try {
    switch (request.name) {
      case "query":
        return finishDomCommand(command.id, request.name, {
          targetCount: nodes.length,
          nodes: nodes.slice(0, request.limit || 5).map((node) => serializeDomNode(node)),
        });
      case "html":
        return finishDomCommand(command.id, request.name, {
          targetCount: nodes.length,
          output: first ? first.outerHTML : null,
          nodes: first ? [serializeDomNode(first, { includeHtml: true })] : [],
        });
      case "text":
        if (typeof request.text === "string" && first) {
          first.textContent = request.text;
        }
        return finishDomCommand(command.id, request.name, {
          targetCount: nodes.length,
          output: first?.textContent ?? null,
          nodes: first ? [serializeDomNode(first)] : [],
        });
      case "attr":
        if (!request.attrName) {
          throw new Error("Missing attrName");
        }
        if (request.attrValue === null) {
          first?.removeAttribute?.(request.attrName);
        } else if (typeof request.attrValue === "string" && first) {
          first.setAttribute(request.attrName, request.attrValue);
        }
        return finishDomCommand(command.id, request.name, {
          targetCount: nodes.length,
          output: first?.getAttribute?.(request.attrName) ?? null,
          nodes: first ? [serializeDomNode(first)] : [],
        });
      case "click":
        first?.click?.();
        return finishDomCommand(command.id, request.name, {
          targetCount: nodes.length,
          output: first ? "clicked" : "not-found",
          nodes: first ? [serializeDomNode(first)] : [],
        });
      case "inject": {
        if (!first) throw new Error("Target selector not found");
        const position = request.position || "afterend";
        const wrapper = document.createElement("div");
        wrapper.setAttribute("data-ravi-dom-injected", "true");
        wrapper.setAttribute("data-ravi-dom-command", command.id);
        wrapper.innerHTML = request.html || "<div>empty inject</div>";
        first.insertAdjacentElement(position, wrapper);
        return finishDomCommand(command.id, request.name, {
          targetCount: nodes.length,
          output: "injected",
          nodes: [serializeDomNode(wrapper, { includeHtml: true })],
        });
      }
      case "remove": {
        let removed = 0;
        for (const node of nodes) {
          node.remove();
          removed += 1;
        }
        return finishDomCommand(command.id, request.name, {
          targetCount: removed,
          output: `removed:${removed}`,
        });
      }
      case "outline": {
        const color = request.attrValue || "#ff4d4f";
        for (const node of nodes) {
          if (node instanceof HTMLElement) {
            node.dataset.raviDomOutline = "true";
            node.style.outline = `2px solid ${color}`;
            node.style.outlineOffset = "2px";
          }
        }
        return finishDomCommand(command.id, request.name, {
          targetCount: nodes.length,
          output: `outlined:${nodes.length}`,
          nodes: nodes.slice(0, request.limit || 5).map((node) => serializeDomNode(node)),
        });
      }
      case "clear": {
        const injected = Array.from(document.querySelectorAll("[data-ravi-dom-injected='true']"));
        const outlined = Array.from(document.querySelectorAll("[data-ravi-dom-outline='true']"));
        for (const node of injected) node.remove();
        for (const node of outlined) {
          if (node instanceof HTMLElement) {
            node.style.outline = "";
            node.style.outlineOffset = "";
            delete node.dataset.raviDomOutline;
          }
        }
        return finishDomCommand(command.id, request.name, {
          targetCount: injected.length + outlined.length,
          output: { injected: injected.length, outlined: outlined.length },
        });
      }
      default:
        throw new Error(`Unsupported DOM command: ${request.name}`);
    }
  } catch (error) {
    return {
      id: command.id,
      ok: false,
      name: request.name,
      finishedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function finishDomCommand(id, name, payload = {}) {
  return {
    id,
    ok: true,
    name,
    finishedAt: Date.now(),
    ...payload,
  };
}

function selectDomNodes(selector, request = {}) {
  if (!selector) return [];

  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(selector));
  } catch {
    return [];
  }

  if (request.visible) {
    nodes = nodes.filter(isVisibleElement);
  }

  const limit = request.limit ? Math.max(1, Number(request.limit)) : null;
  return limit ? nodes.slice(0, limit) : nodes;
}

function serializeDomNode(node, options = {}) {
  const attrs = {};
  if (node instanceof Element) {
    for (const attr of node.attributes) {
      attrs[attr.name] = attr.value;
    }
  }

  return {
    tag: node.tagName.toLowerCase(),
    text: typeof node.textContent === "string" ? node.textContent.trim().replace(/\s+/g, " ").slice(0, 200) : null,
    html: options.includeHtml && node instanceof Element ? node.outerHTML.slice(0, 2000) : null,
    path: buildNodePath(node),
    attrs,
  };
}

function getOrCreateClientId() {
  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const next = `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(CLIENT_ID_KEY, next);
    return next;
  } catch {
    return `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
