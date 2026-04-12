const SNAPSHOT_POLL_INTERVAL_MS = 700;
const CHAT_LIST_RESOLVE_INTERVAL_MS = 1200;
const MESSAGE_CHIP_REFRESH_INTERVAL_MS = 1100;
const VIEW_STATE_REPUBLISH_MS = 2500;
const ROOT_ID = "ravi-wa-overlay-root";
const DRAWER_ID = "ravi-wa-overlay-drawer";
const SESSION_MAIN_HOST_ID = "ravi-wa-session-main-host";
const LAYOUT_CLASS = "ravi-wa-layout-active";
const LAYOUT_HOST_CLASS = "ravi-wa-layout-host";
const MAIN_PANE_CLASS = "ravi-wa-main-pane";
const MAIN_PANE_HIDDEN_CLASS = "ravi-wa-main-pane-hidden";
const LAYOUT_BRANCH_HIDDEN_CLASS = "ravi-wa-layout-branch-hidden";
const INLINE_PROBE_ID = "ravi-wa-inline-probe";
const CHAT_ROW_SELECTOR = "div[role='grid'] [role='row']";
const CHAT_ROW_BADGE_ATTR = "data-ravi-chat-chip";
const MESSAGE_CHIP_ATTR = "data-ravi-message-chip";
const CHAT_ARTIFACT_ATTR = "data-ravi-chat-artifact";
const CHAT_ARTIFACT_KEY_ATTR = "data-ravi-chat-artifact-key";
const CHAT_ARTIFACT_STACK_ATTR = "data-ravi-chat-artifact-stack";
const CHAT_ARTIFACT_ANCHOR_ATTR = "data-ravi-chat-artifact-anchor";
const expandedConversationToolGroups = new Set();
const MESSAGE_POPOVER_ID = "ravi-wa-message-popover";
const RECENT_STACK_ID = "ravi-wa-overlay-recent";
const PAGE_BRIDGE_SCRIPT_ID = "ravi-wa-page-bridge";
const PAGE_CHAT_REQUEST_EVENT = "ravi-wa-request-active-chat";
const PAGE_CHAT_RESPONSE_EVENT = "ravi-wa-active-chat";
const LOG_LIMIT = 12;
const CLIENT_ID_KEY = "ravi-wa-overlay-client-id";
const ACTIVE_WORKSPACE_KEY_STORAGE = "ravi-wa-overlay-workspace";
const WORKSPACE_SESSION_KEY_STORAGE = "ravi-wa-overlay-workspace-session";
const OMNI_INSTANCE_KEY_STORAGE = "ravi-wa-overlay-instance";
const V3_PLACEHOLDERS_KEY_STORAGE = "ravi-wa-overlay-v3-placeholders";
const OMNI_POLL_INTERVAL_MS = 2600;
const V3_PLACEHOLDER_POLL_INTERVAL_MS = 1800;
const TASKS_POLL_INTERVAL_MS = 1800;
const TASKS_EVENTS_LIMIT = 20;
const WORKSPACE_NAV_ID = "ravi-wa-workspace-launcher";
const V3_PLACEHOLDER_LAYER_ID = "ravi-wa-v3-placeholder-layer";
const TASK_SELECTED_ID_STORAGE = "ravi-wa-overlay-task";
const WORKSPACE_NAV_ITEMS = [
  { id: "ravi", label: "Ravi", glyph: "R" },
  { id: "omni", label: "Omni", glyph: "O" },
  { id: "tasks", label: "Tasks", glyph: "T" },
];
const TASK_KANBAN_COLUMNS = [
  { id: "open", label: "open", statuses: ["open"] },
  { id: "queued", label: "queued", statuses: ["dispatched"] },
  { id: "working", label: "working", statuses: ["in_progress"] },
  { id: "blocked", label: "blocked", statuses: ["blocked"] },
  { id: "done", label: "done", statuses: ["done"] },
  { id: "failed", label: "failed", statuses: ["failed"] },
];
const NATIVE_SIDEBAR_SEARCH_SELECTOR =
  "input[role='textbox'][aria-label*='Pesquisar ou começar'], input[placeholder*='Pesquisar ou começar'], input[role='textbox'][aria-label*='Search'], input[placeholder*='Search']";
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
let latestSessionWorkspace = null;
let latestTasksSnapshot = null;
let latestViewState = null;
let latestTimelineDebug = null;
let latestChatListItems = [];
let latestPageChat = null;
let latestOmniPanel = null;
let latestV3Placeholders = null;
let v3CommandNotice = null;
const messageMetaCache = new Map();
const taskSelectionCache = new Map();
const taskSelectionInFlight = new Set();
const PINNED_SESSION_KEY_STORAGE = "ravi-wa-overlay-pinned-session";
let lastPublishedAt = 0;
const detectionLogs = [];
let bridgeError = null;
let pollingStopped = false;
let domCommandInFlight = false;
let chatListRefreshInFlight = false;
let openMessageChip = null;
let openMessageId = null;
let openMessageData = null;
let sidebarFilter = "";
let omniFilter = "";
let omniSessionFilter = "";
let sidebarNotice = null;
let sidebarNoticeTimer = null;
let pinnedSessionKey = loadPinnedSessionKey();
let activeWorkspace = loadActiveWorkspace();
let selectedWorkspaceSessionKey = loadWorkspaceSessionKey();
let selectedTaskId = loadSelectedTaskId();
let preferredOmniInstance = loadPreferredOmniInstance();
let v3PlaceholdersEnabled = loadV3PlaceholdersEnabled();
let selectedOmniChatId = null;
let selectedOmniSessionKey = null;
let selectedOmniRouteAgentId = null;
let omniDraftSessionName = "";
let omniDraftNewAgentId = "";
let omniDraftNewAgentSessionName = "";
let currentLayoutHost = null;
let currentLayoutMain = null;
let currentLayoutSideBranch = null;
let currentLayoutMainBranch = null;
let currentSessionMainHost = null;
let sessionWorkspaceDraft = "";
let sessionWorkspaceSubmitting = false;
let sessionWorkspaceShouldScrollToEnd = false;
let lastSessionWorkspaceRenderKey = null;
let lastSessionWorkspaceRenderSessionKey = null;
const intervalIds = [];
const clientId = getOrCreateClientId();
let omniPanelInFlight = false;
let omniRouteActionInFlight = false;
let v3PlaceholderInFlight = false;
let tasksInFlight = false;
let v3PlaceholderRenderScheduled = false;
let v3CommandNoticeTimer = null;
let lastTaskSessionLookupSnapshot = null;
let lastTaskSessionLookup = new Map();
let lastTaskHierarchySnapshot = null;
let lastTaskHierarchyState = { roots: [], nodes: new Map(), parentByTaskId: new Map() };

boot();

function boot() {
  ensurePageBridge();
  document.addEventListener(PAGE_CHAT_RESPONSE_EVENT, handlePageChatEvent);
  ensureShell();
  syncLayoutChrome();
  syncWorkspaceLauncher();
  ensureMessagePopover();
  refreshAll();
  intervalIds.push(setInterval(refreshSnapshot, SNAPSHOT_POLL_INTERVAL_MS));
  intervalIds.push(setInterval(refreshSessionWorkspace, SNAPSHOT_POLL_INTERVAL_MS));
  intervalIds.push(setInterval(refreshViewState, 700));
  intervalIds.push(setInterval(refreshChatListOverlay, CHAT_LIST_RESOLVE_INTERVAL_MS));
  intervalIds.push(setInterval(refreshMessageChips, MESSAGE_CHIP_REFRESH_INTERVAL_MS));
  intervalIds.push(setInterval(refreshOmniPanel, OMNI_POLL_INTERVAL_MS));
  intervalIds.push(setInterval(refreshV3Placeholders, V3_PLACEHOLDER_POLL_INTERVAL_MS));
  intervalIds.push(setInterval(refreshTasks, TASKS_POLL_INTERVAL_MS));
  intervalIds.push(setInterval(pollDomCommands, 700));
  window.addEventListener("resize", syncMessagePopoverPosition);
  window.addEventListener("resize", scheduleV3PlaceholderRender);
  document.addEventListener("scroll", syncMessagePopoverPosition, true);
  document.addEventListener("scroll", scheduleV3PlaceholderRender, true);
}

function shouldDeferOmniRender() {
  if (activeWorkspace !== "omni") return false;
  if (omniRouteActionInFlight) return true;
  const root = document.getElementById(ROOT_ID);
  const active = document.activeElement;
  if (!root || !active || !root.contains(active)) return false;

  const tagName = active.tagName;
  if (tagName === "INPUT" || tagName === "SELECT" || tagName === "TEXTAREA") {
    return true;
  }

  return active.getAttribute?.("contenteditable") === "true";
}

function requestRender(snapshot = latestSnapshot, context = detectChatContext()) {
  if (shouldDeferOmniRender()) return;
  render(snapshot, context);
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
    requestRender(snapshot, context);
  } catch (error) {
    handleRuntimeError(error);
  }
}

async function refreshSessionWorkspace(force = false) {
  if (pollingStopped) return;
  if (!selectedWorkspaceSessionKey) return;
  if (!force && activeWorkspace !== "ravi") return;
  const requestedSessionKey = selectedWorkspaceSessionKey;

  try {
    const workspace = await chrome.runtime.sendMessage({
      type: "ravi:get-session-workspace",
      payload: {
        session: requestedSessionKey,
      },
    });
    if (requestedSessionKey !== selectedWorkspaceSessionKey) return;
    bridgeError = null;
    latestSessionWorkspace = workspace;
    requestRender();
  } catch (error) {
    handleRuntimeError(error);
  }
}

async function refreshOmniPanel(force = false) {
  if (pollingStopped || omniPanelInFlight) return;
  if (!force && activeWorkspace !== "omni") return;

  omniPanelInFlight = true;
  try {
    const context = detectChatContext();
    const panel = await chrome.runtime.sendMessage({
      type: "ravi:get-omni-panel",
      payload: {
        chatId: context.chatId,
        title: context.title,
        session: context.session,
        instance: preferredOmniInstance,
      },
    });
    if (panel?.ok) {
      latestOmniPanel = panel;
      bridgeError = null;
      if (activeWorkspace === "omni") {
        requestRender();
      }
    }
  } catch (error) {
    handleRuntimeError(error);
  } finally {
    omniPanelInFlight = false;
  }
}

async function refreshV3Placeholders(force = false) {
  if (pollingStopped || v3PlaceholderInFlight) return;
  if (!force && activeWorkspace !== "ravi") {
    latestV3Placeholders = null;
    scheduleV3PlaceholderRender();
    return;
  }

  v3PlaceholderInFlight = true;
  try {
    const next = await chrome.runtime.sendMessage({
      type: "ravi:get-v3-placeholders",
    });
    if (next?.ok) {
      latestV3Placeholders = next;
      bridgeError = null;
      scheduleV3PlaceholderRender();
    }
  } catch (error) {
    handleRuntimeError(error);
  } finally {
    v3PlaceholderInFlight = false;
  }
}

function resolveOverlayTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function buildOverlayTodayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function buildTasksRequestPayload(taskId = selectedTaskId) {
  const timeZone = resolveOverlayTimeZone();
  return {
    taskId,
    eventsLimit: TASKS_EVENTS_LIMIT,
    ...(timeZone ? { timeZone } : {}),
    todayKey: buildOverlayTodayKey(),
  };
}

async function refreshTasks(force = false) {
  if (pollingStopped || tasksInFlight) return;
  if (!force && activeWorkspace === "omni") return;

  tasksInFlight = true;
  try {
    const next = await chrome.runtime.sendMessage({
      type: "ravi:get-tasks",
      payload: buildTasksRequestPayload(selectedTaskId),
    });
    if (next?.ok) {
      latestTasksSnapshot = next;
      rememberTaskSelection(next?.selectedTask);
      bridgeError = null;
      const nextSelectedTaskId = next?.query?.taskId || next?.selectedTask?.task?.id || null;
      if (nextSelectedTaskId !== selectedTaskId) {
        selectedTaskId = nextSelectedTaskId;
        persistSelectedTaskId(selectedTaskId);
      }
      if (activeWorkspace !== "omni") {
        requestRender();
      }
    }
  } catch (error) {
    handleRuntimeError(error);
  } finally {
    tasksInFlight = false;
  }
}

async function sendV3Command(name, args = {}) {
  return chrome.runtime.sendMessage({
    type: "ravi:v3-command",
    payload: { name, args },
  });
}

function refreshAll() {
  refreshViewState();
  refreshSnapshot();
  refreshSessionWorkspace(true);
  refreshTasks(true);
  refreshChatListOverlay();
  refreshMessageChips();
  refreshOmniPanel();
  refreshV3Placeholders();
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
  requestRender();
}

function detectChatContext() {
  const selectedChat = latestViewState?.selectedChat || detectSelectedChatLabel();
  const detectedTitle = detectChatTitle() || latestPageChat?.title || selectedChat || detectSelectedChatLabel();
  const title = shouldPreferSelectedChatTitle(detectedTitle, selectedChat) ? selectedChat : detectedTitle;
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

function shouldPreferSelectedChatTitle(title, selectedChat) {
  if (!selectedChat) return false;
  const screen = latestViewState?.screen || "";
  if (!screen.startsWith("conversation")) return false;

  const normalizedTitle = String(title || "")
    .trim()
    .toLowerCase();
  const normalizedSelected = String(selectedChat || "")
    .trim()
    .toLowerCase();

  if (!normalizedTitle) return true;
  if (normalizedTitle === normalizedSelected) return false;
  if (normalizedTitle === "whatsapp" || normalizedTitle === "omni") return true;

  return activeWorkspace !== "ravi";
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
    chatRows: buildPublishedChatRows(),
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

      const selectedNode = row.querySelector("[aria-selected]");
      const selected = selectedNode?.getAttribute?.("aria-selected") === "true";
      const chatIdCandidate = resolveChatRowChatIdCandidate(row, { selected });
      return {
        id: buildChatRowId(title, chatIdCandidate, index),
        row,
        title,
        titleContainer,
        chatIdCandidate,
        selected,
      };
    })
    .filter(Boolean);
}

function resolveChatRowChatIdCandidate(row, { selected }) {
  if (selected && latestPageChat?.chatId) {
    return latestPageChat.chatId;
  }

  const fromMarkup = extractChatIdCandidates(row, { includeAncestors: false })[0] || null;
  if (fromMarkup) {
    return fromMarkup;
  }

  if (selected && latestViewState?.chatIdCandidate) {
    return latestViewState.chatIdCandidate;
  }

  return null;
}

function buildPublishedChatRows(limit = 20) {
  return detectVisibleChatRows()
    .slice(0, limit)
    .map((row) => {
      const unreadCount = extractChatRowUnreadCount(row.row);
      const timeLabel = extractChatRowTimeLabel(row.row);
      const preview = extractChatRowPreview(row.row, row.title, timeLabel);
      return {
        id: row.id,
        title: row.title,
        chatIdCandidate: row.chatIdCandidate || null,
        selected: row.selected === true,
        unreadCount,
        preview,
        timeLabel,
        text: extractChatRowText(row.row),
      };
    });
}

function extractChatRowUnreadCount(row) {
  if (!(row instanceof Element)) return null;
  const text = row.textContent?.replace(/\s+/g, " ").trim() || "";
  const match =
    text.match(/(\d+)\s*mensagens?\s+n[aã]o\s+lidas?/i) ||
    text.match(/(\d+)\s*unread/i) ||
    text.match(/(\d+)\s*new message/i);
  if (!match?.[1]) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function extractChatRowTimeLabel(row) {
  const texts = extractChatRowLeafTexts(row).map((entry) => entry.text);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index];
    if (looksLikeChatRowTimeLabel(text)) {
      return text;
    }
  }
  return null;
}

function extractChatRowPreview(row, title, timeLabel) {
  const preview = extractChatRowLeafTexts(row)
    .map((entry) => entry.text)
    .filter((text) => text && text !== title && text !== timeLabel)
    .filter((text) => !looksLikeUnreadLabel(text))
    .filter((text) => !looksLikeChatRowTimeLabel(text))
    .sort((a, b) => b.length - a.length)[0];
  return preview || null;
}

function extractChatRowText(row) {
  if (!(row instanceof Element)) return null;
  const clone = row.cloneNode(true);
  clone.querySelectorAll(`[${CHAT_ROW_BADGE_ATTR}]`).forEach((node) => node.remove());
  return clone.textContent?.trim()?.replace(/\s+/g, " ").slice(0, 240) || null;
}

function extractChatRowLeafTexts(row) {
  if (!(row instanceof Element)) return [];
  const source = row.cloneNode(true);
  if (!(source instanceof Element)) return [];
  source.querySelectorAll(`[${CHAT_ROW_BADGE_ATTR}]`).forEach((node) => node.remove());
  const seen = new Set();
  return Array.from(source.querySelectorAll("span, div, p"))
    .map((element) => ({
      element,
      text: (element.textContent || "").trim().replace(/\s+/g, " "),
    }))
    .filter(({ text }) => text.length > 0)
    .filter(({ element, text }) => {
      return !Array.from(element.children).some((child) => {
        const childText = (child.textContent || "").trim().replace(/\s+/g, " ");
        return childText === text;
      });
    })
    .filter(({ text }) => {
      const key = text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function looksLikeUnreadLabel(text) {
  return /mensagens?\s+n[aã]o\s+lidas?|unread|new message/i.test(text || "");
}

function looksLikeChatRowTimeLabel(text) {
  if (!text) return false;
  const normalized = text.trim().toLowerCase().replace(/\./g, "");
  return (
    /^\d{1,2}:\d{2}$/.test(normalized) ||
    /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(normalized) ||
    /^(hoje|ontem|today|yesterday)$/.test(normalized) ||
    /^(seg|ter|qua|qui|sex|sab|dom|mon|tue|wed|thu|fri|sat|sun)$/.test(normalized)
  );
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

function extractChatIdCandidates(node, options = {}) {
  if (!(node instanceof Element)) return [];
  const includeAncestors = options.includeAncestors !== false;

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

  if (includeAncestors) {
    let parent = node.parentElement;
    let depth = 0;
    while (parent && depth < 2) {
      if (parent.outerHTML.length <= 20_000) {
        addSnippet(parent.outerHTML);
      }
      parent = parent.parentElement;
      depth += 1;
    }
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
          preview: extractChatRowPreview(row.row, row.title, extractChatRowTimeLabel(row.row)),
          timeLabel: extractChatRowTimeLabel(row.row),
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
    clearConversationArtifacts();
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
  refreshConversationArtifacts();
}

function refreshConversationArtifacts() {
  if (pollingStopped) return;

  const view = latestViewState || detectViewState();
  if (!view?.screen?.startsWith("conversation")) {
    clearConversationArtifacts();
    return;
  }

  const session = latestSnapshot?.session;
  const artifacts = normalizeConversationArtifacts(session?.live?.artifacts || []);
  if (artifacts.length === 0) {
    clearConversationArtifacts();
    return;
  }

  const messages = detectVisibleMessages();
  const grouped = groupConversationArtifactsByAnchor(artifacts, messages);

  clearConversationArtifacts();

  if (grouped.length === 0) {
    return;
  }

  for (const group of grouped) {
    const stack = createConversationArtifactStack(group.anchorKey);
    for (const item of buildConversationArtifactRenderItems(group.artifacts, group.anchorKey)) {
      if (item.type === "tool-summary") {
        const row = createConversationToolSummaryRow();
        updateConversationToolSummaryRow(row, item);
        stack.appendChild(row);
        continue;
      }

      const row = createConversationArtifactRow();
      updateConversationArtifactRow(row, item.artifact);
      stack.appendChild(row);
    }
    group.anchorNode.insertAdjacentElement("afterend", stack);
  }
}

function buildConversationArtifactRenderItems(artifacts, anchorKey) {
  const sorted = [...artifacts].sort((left, right) => {
    const leftTime = left.updatedAt || left.createdAt || 0;
    const rightTime = right.updatedAt || right.createdAt || 0;
    return leftTime - rightTime;
  });

  const toolArtifacts = sorted.filter((artifact) => artifact.kind === "tool");
  const items = sorted
    .filter((artifact) => artifact.kind !== "tool")
    .map((artifact) => ({
      type: "artifact",
      artifact,
      sortAt: artifact.updatedAt || artifact.createdAt || 0,
    }));

  if (toolArtifacts.length > 0) {
    const latestTimestamp = toolArtifacts.reduce(
      (latest, artifact) => Math.max(latest, artifact.updatedAt || artifact.createdAt || 0),
      0,
    );
    items.push({
      type: "tool-summary",
      key: `tool-summary:${anchorKey}`,
      artifacts: toolArtifacts,
      sortAt: toolArtifacts[0]?.createdAt || latestTimestamp,
      latestTimestamp,
    });
  }

  return items.sort((left, right) => left.sortAt - right.sortAt);
}

function normalizeConversationArtifacts(artifacts) {
  const seen = new Set();
  const next = [];

  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!artifact) continue;
    const anchor = normalizeArtifactAnchor(artifact.anchor);
    if (!anchor) continue;
    const key = artifact.dedupeKey || artifact.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push({ ...artifact, anchor });
  }

  return next;
}

function normalizeArtifactAnchor(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  if (anchor.placement === "after-last-message") {
    return { placement: "after-last-message" };
  }
  if (anchor.placement === "after-message-id") {
    const messageId = extractExternalMessageId(typeof anchor.messageId === "string" ? anchor.messageId : null);
    if (!messageId) return null;
    return { placement: "after-message-id", messageId };
  }
  return null;
}

function groupConversationArtifactsByAnchor(artifacts, messages) {
  const lastMessage = messages[messages.length - 1] || null;
  const messageNodesByExternalId = new Map();
  for (const message of messages) {
    if (message?.externalMessageId && message?.node instanceof HTMLElement) {
      messageNodesByExternalId.set(message.externalMessageId, message.node);
    }
  }

  const groups = new Map();
  for (const artifact of artifacts) {
    const anchor = artifact.anchor || null;
    let anchorNode = null;
    let anchorKey = null;

    if (anchor?.placement === "after-message-id") {
      anchorNode = messageNodesByExternalId.get(anchor.messageId) || null;
      anchorKey = anchorNode ? `message:${anchor.messageId}` : null;
    } else if (anchor?.placement === "after-last-message") {
      anchorNode = lastMessage?.node || null;
      anchorKey = anchorNode ? "after-last-message" : null;
    }

    if (!(anchorNode instanceof HTMLElement) || !anchorKey) continue;

    const current = groups.get(anchorKey);
    if (current) {
      current.artifacts.push(artifact);
    } else {
      groups.set(anchorKey, {
        anchorKey,
        anchorNode,
        artifacts: [artifact],
      });
    }
  }

  return [...groups.values()];
}

function createConversationArtifactStack(anchorKey) {
  const stack = document.createElement("div");
  stack.className = "ravi-wa-chat-artifact-stack";
  stack.setAttribute(CHAT_ARTIFACT_STACK_ATTR, "true");
  stack.setAttribute(CHAT_ARTIFACT_ANCHOR_ATTR, anchorKey);
  return stack;
}

function createConversationArtifactRow() {
  const root = document.createElement("article");
  root.setAttribute(CHAT_ARTIFACT_ATTR, "true");
  root.className = "ravi-wa-chat-artifact";

  const dot = document.createElement("span");
  dot.className = "ravi-wa-chat-artifact__dot";

  const body = document.createElement("div");
  body.className = "ravi-wa-chat-artifact__body";

  const label = document.createElement("strong");
  label.className = "ravi-wa-chat-artifact__label";

  const kind = document.createElement("span");
  kind.className = "ravi-wa-chat-artifact__kind";

  const detail = document.createElement("span");
  detail.className = "ravi-wa-chat-artifact__detail";

  const time = document.createElement("span");
  time.className = "ravi-wa-chat-artifact__time";

  body.append(label, kind, detail, time);
  root.append(dot, body);

  root.__raviArtifactRefs = { dot, label, kind, detail, time };
  return root;
}

function createConversationToolSummaryRow() {
  const root = document.createElement("article");
  root.setAttribute(CHAT_ARTIFACT_ATTR, "true");
  root.className = "ravi-wa-chat-artifact ravi-wa-chat-artifact--tool-group";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ravi-wa-chat-artifact__toggle";

  const dot = document.createElement("span");
  dot.className = "ravi-wa-chat-artifact__dot";

  const body = document.createElement("div");
  body.className = "ravi-wa-chat-artifact__body";

  const label = document.createElement("strong");
  label.className = "ravi-wa-chat-artifact__label";

  const detail = document.createElement("span");
  detail.className = "ravi-wa-chat-artifact__detail";

  const time = document.createElement("span");
  time.className = "ravi-wa-chat-artifact__time";

  const chevron = document.createElement("span");
  chevron.className = "ravi-wa-chat-artifact__chevron";
  chevron.textContent = "▾";

  const list = document.createElement("div");
  list.className = "ravi-wa-chat-artifact__list";
  list.hidden = true;

  body.append(label, detail);
  button.append(dot, body, time, chevron);
  root.append(button, list);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const key = root.getAttribute(CHAT_ARTIFACT_KEY_ATTR);
    if (!key) return;
    const nextExpanded = !root.classList.contains("is-expanded");
    if (nextExpanded) {
      expandedConversationToolGroups.add(key);
    } else {
      expandedConversationToolGroups.delete(key);
    }
    applyConversationToolSummaryExpanded(root, nextExpanded);
  });

  root.__raviToolSummaryRefs = { button, dot, label, detail, time, chevron, list };
  return root;
}

function updateConversationArtifactRow(root, artifact) {
  if (!root.__raviArtifactRefs) {
    root.__raviArtifactRefs = createConversationArtifactRow().__raviArtifactRefs;
  }
  const refs = root.__raviArtifactRefs;
  const key = artifact.dedupeKey || artifact.id;
  const kindClass = normalizeArtifactKindClass(artifact.kind || "artifact");

  root.className = `ravi-wa-chat-artifact ravi-wa-chat-artifact--${kindClass}`;
  root.setAttribute(CHAT_ARTIFACT_KEY_ATTR, key);
  root.title = `${artifact.label || artifact.kind || "artifact"} · ${artifact.detail || "sem detalhe"}`;

  if (refs?.label) refs.label.textContent = artifact.label || artifact.kind || "artifact";
  if (refs?.kind) {
    refs.kind.textContent = artifact.kind || "artifact";
    refs.kind.hidden = !artifact.kind || artifact.kind === artifact.label;
  }
  if (refs?.detail) {
    refs.detail.textContent = artifact.detail || "";
    refs.detail.hidden = !artifact.detail;
  }
  if (refs?.time) {
    refs.time.textContent = formatElapsedCompact(artifact.updatedAt ?? artifact.createdAt) || "agora";
  }
}

function updateConversationToolSummaryRow(root, item) {
  if (!root.__raviToolSummaryRefs) {
    root.__raviToolSummaryRefs = createConversationToolSummaryRow().__raviToolSummaryRefs;
  }

  const refs = root.__raviToolSummaryRefs;
  const artifacts = Array.isArray(item.artifacts) ? item.artifacts : [];
  const key = item.key;
  const active = artifacts.some(isConversationToolArtifactActive);
  const latestTimestamp = item.latestTimestamp || artifacts.reduce(
    (latest, artifact) => Math.max(latest, artifact.updatedAt || artifact.createdAt || 0),
    0,
  );

  root.className = "ravi-wa-chat-artifact ravi-wa-chat-artifact--tool-group";
  root.setAttribute(CHAT_ARTIFACT_KEY_ATTR, key);
  root.title = artifacts
    .map((artifact) => `${artifact.label || "tool"} · ${artifact.detail || "sem detalhe"}`)
    .join("\n");

  if (refs?.label) {
    refs.label.textContent = active ? "trabalhando..." : "tools";
  }
  if (refs?.detail) {
    refs.detail.textContent = `${artifacts.length} ${artifacts.length === 1 ? "tool" : "tools"}`;
  }
  if (refs?.time) {
    refs.time.textContent = formatElapsedCompact(latestTimestamp) || "agora";
  }
  if (refs?.list) {
    refs.list.replaceChildren(
      ...artifacts
        .slice()
        .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
        .map((artifact) => createConversationToolSummaryItem(artifact)),
    );
  }

  applyConversationToolSummaryExpanded(root, expandedConversationToolGroups.has(key));
}

function createConversationToolSummaryItem(artifact) {
  const row = document.createElement("div");
  row.className = "ravi-wa-chat-artifact__list-item";

  const label = document.createElement("span");
  label.className = "ravi-wa-chat-artifact__list-label";
  label.textContent = artifact.label || "tool";

  const detail = document.createElement("span");
  detail.className = "ravi-wa-chat-artifact__list-detail";
  detail.textContent = artifact.detail || "sem detalhe";

  row.append(label, detail);
  return row;
}

function applyConversationToolSummaryExpanded(root, expanded) {
  root.classList.toggle("is-expanded", expanded);
  if (root.__raviToolSummaryRefs?.button) {
    root.__raviToolSummaryRefs.button.setAttribute("aria-expanded", expanded ? "true" : "false");
  }
  if (root.__raviToolSummaryRefs?.list) {
    root.__raviToolSummaryRefs.list.hidden = !expanded;
  }
}

function isConversationToolArtifactActive(artifact) {
  const detail = String(artifact?.detail || "")
    .trim()
    .toLowerCase();
  if (!detail) return true;
  return !(detail.startsWith("ok") || detail.startsWith("erro"));
}

function normalizeArtifactKindClass(kind) {
  return String(kind || "artifact")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "artifact";
}

function clearConversationArtifacts() {
  document.querySelectorAll(`[${CHAT_ARTIFACT_ATTR}]`).forEach((node) => node.remove());
  document.querySelectorAll(`[${CHAT_ARTIFACT_STACK_ATTR}]`).forEach((node) => node.remove());
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
  const elapsed = formatSessionElapsedCompact(session);
  return elapsed ? `${name} · ${chipActivityLabel(session.live?.activity)} · ${elapsed}` : `${name} · ${chipActivityLabel(session.live?.activity)}`;
}

function formatSessionElapsedCompact(session) {
  const timestamp = getSessionElapsedTimestamp(session);
  return formatElapsedCompact(timestamp);
}

function getSessionElapsedTimestamp(session) {
  const live = session?.live || null;
  const activity = live?.activity || "idle";
  if (activity !== "idle" && activity !== "unknown") {
    return live?.busySince ?? live?.updatedAt ?? session?.updatedAt ?? null;
  }
  return live?.updatedAt ?? session?.updatedAt ?? null;
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
    <div id="${RECENT_STACK_ID}" class="ravi-hidden"></div>
    <aside id="${DRAWER_ID}">
      <div class="ravi-wa-drawer-header">
        <div class="ravi-wa-drawer-heading">
          <strong id="ravi-wa-overlay-panel-title">Ravi</strong>
          <span id="ravi-wa-overlay-panel-subtitle">cockpit</span>
        </div>
        <button
          id="ravi-wa-v3-toggle"
          class="ravi-wa-toggle${v3PlaceholdersEnabled ? " ravi-wa-toggle--active" : ""}"
          type="button"
          aria-pressed="${v3PlaceholdersEnabled ? "true" : "false"}"
          title="ativar/desativar placeholders do mapa v3"
        >
          mapa v3
        </button>
      </div>
      <div id="ravi-wa-overlay-body"></div>
    </aside>
  `;
  document.body.appendChild(root);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    if (openMessageChip) {
      closeMessagePopover();
    }
  });

  const toggle = document.getElementById("ravi-wa-v3-toggle");
  toggle?.addEventListener("click", () => {
    v3PlaceholdersEnabled = !v3PlaceholdersEnabled;
    persistV3PlaceholdersEnabled(v3PlaceholdersEnabled);
    render();
    scheduleV3PlaceholderRender();
  });
}

function syncLayoutChrome() {
  const root = document.getElementById(ROOT_ID);
  const drawer = document.getElementById(DRAWER_ID);
  const sidePane = document.getElementById("side");
  const mainPane = document.getElementById("main");
  const host = sidePane && mainPane ? findLayoutHost(sidePane, mainPane) : null;
  if (!root || !drawer || !sidePane || !mainPane || !host) return;
  const sideBranch = findDirectChildBranch(host, sidePane);
  const mainBranch = findDirectChildBranch(host, mainPane);

  if (currentLayoutHost && currentLayoutHost !== host) {
    currentLayoutHost.classList.remove(LAYOUT_HOST_CLASS);
  }
  if (currentLayoutMain && currentLayoutMain !== mainPane) {
    currentLayoutMain.classList.remove(MAIN_PANE_CLASS);
  }
  if (currentLayoutSideBranch && currentLayoutSideBranch !== sideBranch) {
    currentLayoutSideBranch.classList.remove(LAYOUT_BRANCH_HIDDEN_CLASS);
  }
  if (currentLayoutMainBranch && currentLayoutMainBranch !== mainBranch) {
    currentLayoutMainBranch.classList.remove(LAYOUT_BRANCH_HIDDEN_CLASS);
  }

  if (root.parentElement !== host) {
    host.appendChild(root);
  }
  if (root !== host.lastElementChild) {
    host.appendChild(root);
  }

  root.classList.add(LAYOUT_CLASS);
  host.classList.add(LAYOUT_HOST_CLASS);
  mainPane.classList.add(MAIN_PANE_CLASS);
  root.setAttribute("data-workspace", activeWorkspace);
  host.setAttribute("data-ravi-workspace", activeWorkspace);
  const fullWorkspace = activeWorkspace === "omni" || activeWorkspace === "tasks";
  mainPane.classList.toggle(MAIN_PANE_HIDDEN_CLASS, fullWorkspace);
  sideBranch?.classList.toggle(LAYOUT_BRANCH_HIDDEN_CLASS, fullWorkspace);
  mainBranch?.classList.toggle(LAYOUT_BRANCH_HIDDEN_CLASS, fullWorkspace);
  drawer.classList.remove("ravi-hidden");

  currentLayoutHost = host;
  currentLayoutMain = mainPane;
  currentLayoutSideBranch = sideBranch;
  currentLayoutMainBranch = mainBranch;
  syncWorkspaceLauncher();
}

function findLayoutHost(sidePane, mainPane) {
  const mainAncestors = new Set();
  let current = mainPane.parentElement;
  while (current) {
    mainAncestors.add(current);
    current = current.parentElement;
  }

  current = sidePane.parentElement;
  while (current) {
    if (mainAncestors.has(current) && isValidLayoutHost(current, sidePane, mainPane)) {
      return current;
    }
    current = current.parentElement;
  }

  return mainPane.parentElement;
}

function syncWorkspaceLauncher() {
  const host = document.querySelector("header[data-tab='2']");
  if (!(host instanceof HTMLElement)) return;
  host.querySelector("#ravi-wa-omni-launcher")?.remove();

  let launcher = host.querySelector(`#${WORKSPACE_NAV_ID}`);
  if (!(launcher instanceof HTMLElement)) {
    launcher = document.createElement("div");
    launcher.id = WORKSPACE_NAV_ID;
    launcher.setAttribute("data-navbar-item", "true");
    launcher.innerHTML = `
      <div class="ravi-wa-navbar-group">
        ${WORKSPACE_NAV_ITEMS.map(
          (item) => `
            <button
              type="button"
              class="ravi-wa-navbar-button"
              data-ravi-workspace-nav="${escapeAttribute(item.id)}"
              aria-label="${escapeAttribute(item.label)}"
              title="${escapeAttribute(item.label)}"
            >
              <span class="ravi-wa-navbar-button__glyph" aria-hidden="true">${escapeHtml(item.glyph)}</span>
              <span class="ravi-wa-navbar-button__label">${escapeHtml(item.label)}</span>
            </button>
          `,
        ).join("")}
      </div>
    `;
    launcher.querySelectorAll("[data-ravi-workspace-nav]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const workspace = button.getAttribute("data-ravi-workspace-nav");
        setActiveWorkspace(workspace);
      });
    });
  }

  const anchor = Array.from(host.children).find((node) => {
    if (node === launcher) return false;
    if (!(node instanceof HTMLElement)) return false;
    const label =
      node.getAttribute("aria-label") ||
      node.querySelector("[aria-label]")?.getAttribute("aria-label") ||
      "";
    return /config|setting|perfil|profile/i.test(label);
  });

  if (anchor && launcher.nextElementSibling !== anchor) {
    host.insertBefore(launcher, anchor);
  } else if (!anchor && launcher.parentElement !== host) {
    host.appendChild(launcher);
  } else if (!anchor && launcher !== host.lastElementChild) {
    host.appendChild(launcher);
  }

  launcher.querySelectorAll("[data-ravi-workspace-nav]").forEach((button) => {
    const workspace = button.getAttribute("data-ravi-workspace-nav");
    const isActive = workspace === activeWorkspace;
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
    button.classList.toggle("ravi-wa-navbar-button--active", isActive);
  });
}

function isValidLayoutHost(host, sidePane, mainPane) {
  if (!(host instanceof HTMLElement)) return false;

  const sideBranch = findDirectChildBranch(host, sidePane);
  const mainBranch = findDirectChildBranch(host, mainPane);
  if (!sideBranch || !mainBranch || sideBranch === mainBranch) return false;

  const style = window.getComputedStyle(host);
  if (style.display === "grid" || style.display === "inline-grid") return true;
  if (style.display !== "flex" && style.display !== "inline-flex") return false;
  return !style.flexDirection.startsWith("column");
}

function findDirectChildBranch(host, node) {
  let current = node;
  while (current?.parentElement && current.parentElement !== host) {
    current = current.parentElement;
  }
  return current?.parentElement === host ? current : null;
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
  const body = document.getElementById("ravi-wa-overlay-body");
  const panelTitle = document.getElementById("ravi-wa-overlay-panel-title");
  const panelSubtitle = document.getElementById("ravi-wa-overlay-panel-subtitle");
  const recentStack = document.getElementById(RECENT_STACK_ID);
  const v3Toggle = document.getElementById("ravi-wa-v3-toggle");
  scheduleV3PlaceholderRender();
  if (!body || !panelTitle || !panelSubtitle || !recentStack) return;
  if (v3Toggle) {
    v3Toggle.setAttribute("aria-pressed", v3PlaceholdersEnabled ? "true" : "false");
    v3Toggle.classList.toggle("ravi-wa-toggle--active", v3PlaceholdersEnabled);
  }

  const session = snapshot?.session;
  const view = latestViewState;
  const title = context?.title || view?.title || "chat desconhecido";
  renderRecentStack(recentStack);
  syncLayoutChrome();
  syncWorkspaceLauncher();

  if (activeWorkspace === "omni") {
    hideSessionWorkspaceMain();
    panelTitle.textContent = "Omni";
    panelSubtitle.textContent =
      latestOmniPanel?.preferredInstance?.profileName ||
      latestOmniPanel?.preferredInstance?.name ||
      title ||
      "whatsapp";
    renderOmniWorkspace(body, context);
    return;
  }

  if (activeWorkspace === "tasks") {
    hideSessionWorkspaceMain();
    panelTitle.textContent = "Tasks";
    panelSubtitle.textContent = buildTasksWorkspaceSubtitle(latestTasksSnapshot);
    renderTasksWorkspace(body);
    return;
  }

  panelTitle.textContent = "Ravi";
  panelSubtitle.textContent = title;

  const recentSessions = filterCockpitSessions(snapshot?.recentSessions || snapshot?.recentChats || []);
  const activeSessions = filterCockpitSessions(snapshot?.activeSessions || snapshot?.hotSessions || []);
  const navTargets = dedupeSessionsByKey([session, ...activeSessions, ...recentSessions].filter(Boolean));
  const followedSession = session || null;
  const pinnedSession = pinnedSessionKey ? navTargets.find((item) => item.sessionKey === pinnedSessionKey) || null : null;
  if (pinnedSessionKey && !pinnedSession) {
    pinnedSessionKey = null;
    persistPinnedSessionKey(null);
  }
  const focusedSession = pinnedSession || followedSession || navTargets[0] || null;
  const focusedTaskMatch = focusedSession ? resolveTaskSessionMatch(focusedSession) : null;
  if (focusedTaskMatch) {
    primeTaskSessionDetails([focusedTaskMatch]);
  }
  const focusedTask = focusedTaskMatch?.task || null;
  const isPinned = Boolean(pinnedSession && focusedSession?.sessionKey === pinnedSession.sessionKey);
  const focusedLive = focusedSession?.live;
  const focusedActivity = focusedLive?.activity || "idle";
  const focusedActivityLabel = chipActivityLabel(focusedActivity);
  const focusedActivityClass = chipActivityClass(focusedActivity);
  const listedRecentSessions = focusedSession
    ? recentSessions.filter((item) => item.sessionKey !== focusedSession.sessionKey)
    : recentSessions;

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

  const heroSummary = focusedTaskMatch
    ? escapeHtml(shorten(focusedTaskMatch.note.text, 160))
    : focusedSession
      ? escapeHtml(focusedLive?.summary || "sem evento vivo")
      : escapeHtml((snapshot?.warnings || ["Nenhuma sessão do Ravi em foco agora."]).join(" "));
  const heroStateClass = focusedTask ? taskStatusClass(focusedTask.status) : focusedSession ? focusedActivityClass : "idle";
  const heroStateLabel = focusedTask ? taskStatusLabel(focusedTask.status) : focusedSession ? focusedActivityLabel : "unbound";
  const heroTitle = focusedTask ? focusedTask.title || focusedSession?.sessionName || "task" : focusedSession ? focusedSession.sessionName : "nenhuma sessão";
  const heroLinkedChat = focusedSession ? getLinkedChatLabel(focusedSession) : null;
  const heroElapsed = focusedTask ? formatTaskElapsed(focusedTask) : focusedSession ? formatSessionElapsedCompact(focusedSession) || "agora" : "-";
  const heroElapsedLabel = focusedTask ? "duration" : "updated";
  const heroModeLabel = isPinned ? "pinada" : followedSession ? "seguindo chat" : "sem vínculo";
  const canFollowCurrent = Boolean(isPinned && followedSession);
  const canPinFocused = Boolean(focusedSession && !isPinned);
  const liveEventsCard = focusedSession ? renderLiveEventsCard(focusedSession) : "";
  body.innerHTML = `
    ${errorCard}
    <section class="ravi-wa-card ravi-wa-hero-card">
      <div class="ravi-wa-hero-top">
        <div>
          <h3>${escapeHtml(heroTitle)}</h3>
          <p>${heroSummary}</p>
        </div>
        <span class="ravi-wa-state-pill ravi-wa-state-pill--${heroStateClass}">${escapeHtml(heroStateLabel)}</span>
      </div>
      <div class="ravi-wa-chip-row">
        <span class="ravi-wa-meta-chip">modo ${escapeHtml(heroModeLabel)}</span>
        ${
          focusedSession
            ? `<span class="ravi-wa-meta-chip">agent ${escapeHtml(focusedSession.agentId)}</span>
               <span class="ravi-wa-meta-chip">${escapeHtml(heroElapsedLabel)} ${escapeHtml(heroElapsed)}</span>
               ${
                 focusedTask
                   ? `<span class="ravi-wa-meta-chip">task ${escapeHtml(formatTaskShortId(focusedTask.id))}</span>
                      <span class="ravi-wa-meta-chip">progress ${escapeHtml(String(clampTaskProgressValue(focusedTask.progress ?? 0)))}%</span>
                      <span class="ravi-wa-meta-chip">session ${escapeHtml(focusedSession.sessionName)}</span>`
                   : ""
               }
               ${heroLinkedChat ? `<span class="ravi-wa-meta-chip">chat ${escapeHtml(shorten(heroLinkedChat, 22))}</span>` : ""}
               ${focusedSession.channel ? `<span class="ravi-wa-meta-chip">channel ${escapeHtml(focusedSession.channel)}</span>` : ""}
               ${focusedSession.accountId ? `<span class="ravi-wa-meta-chip">instance ${escapeHtml(shorten(focusedSession.accountId, 18))}</span>` : ""}`
            : ""
        }
      </div>
    </section>
    <section class="ravi-wa-card">
      <label class="ravi-wa-sidebar-search">
        <span>buscar sessões, agents ou chats vinculados</span>
        <input id="ravi-wa-sidebar-search" type="text" placeholder="dev, main, 5511..." value="${escapeAttribute(sidebarFilter)}" />
      </label>
    </section>
    <section class="ravi-wa-card">
      <div class="ravi-wa-section-head">
        <h3>sessões ativas</h3>
        <span>${activeSessions.length}</span>
      </div>
      ${renderCockpitRows(activeSessions, focusedSession, "Nenhuma sessão ativa agora.")}
    </section>
    <section class="ravi-wa-card">
      <div class="ravi-wa-section-head">
        <h3>sessões recentes</h3>
        <span>${listedRecentSessions.length}</span>
      </div>
      ${renderCockpitRows(listedRecentSessions, focusedSession, "Nenhuma sessão recente do Ravi.")}
    </section>
    ${liveEventsCard}
    ${
      sidebarNotice
        ? `
      <section class="ravi-wa-card ravi-wa-notice ravi-wa-notice--${escapeAttribute(sidebarNotice.kind || "info")}">
        <p>${escapeHtml(sidebarNotice.message || "")}</p>
      </section>
    `
        : ""
    }
    ${
      focusedSession
        ? `
      <section class="ravi-wa-card">
        <dl class="ravi-wa-grid">
          <div><dt>Sessão</dt><dd>${escapeHtml(focusedSession.sessionName)}</dd></div>
          <div><dt>Agent</dt><dd>${escapeHtml(focusedSession.agentId)}</dd></div>
          <div><dt>Live</dt><dd>${escapeHtml(focusedActivityLabel)}</dd></div>
          <div><dt>Atualizado</dt><dd>${escapeHtml(formatTimestamp(focusedLive?.updatedAt))}</dd></div>
          <div><dt>Thinking</dt><dd>${escapeHtml(focusedSession.thinkingLevel || "-")}</dd></div>
          <div><dt>Modelo</dt><dd>${escapeHtml(focusedSession.modelOverride || focusedSession.runtimeProvider || "-")}</dd></div>
          <div><dt>Queue</dt><dd>${escapeHtml(focusedSession.queueMode || "-")}</dd></div>
          <div><dt>Heartbeat</dt><dd>${escapeHtml(focusedSession.lastHeartbeatText || "-")}</dd></div>
          <div><dt>Canal</dt><dd>${escapeHtml(focusedSession.channel || "-")}</dd></div>
          <div><dt>Instância</dt><dd>${escapeHtml(focusedSession.accountId || "-")}</dd></div>
        </dl>
      </section>
      <section class="ravi-wa-card">
        <div class="ravi-wa-actions">
          ${focusedSession.chatId ? `<button data-ravi-open-chat="${escapeAttribute(focusedSession.sessionKey)}">Abrir chat</button>` : ""}
          ${canFollowCurrent ? `<button data-ravi-follow-current="true">Seguir chat</button>` : ""}
          ${canPinFocused ? `<button data-ravi-pin-session="${escapeAttribute(focusedSession.sessionKey)}">Pinar sessão</button>` : ""}
          <button data-action="abort">Abortar</button>
          <button data-action="reset">Resetar</button>
          <button data-action="set-thinking" data-value="normal">Thinking normal</button>
          <button data-action="set-thinking" data-value="verbose">Thinking verbose</button>
        </div>
      </section>
    `
        : ""
    }
    ${debugCard}
    ${logsCard}
  `;

  const searchInput = body.querySelector("#ravi-wa-sidebar-search");
  searchInput?.addEventListener("input", (event) => {
    const nextValue = event.target.value || "";
    sidebarFilter = nextValue;
    render(snapshot, context);
    requestAnimationFrame(() => {
      const nextInput = document.getElementById("ravi-wa-sidebar-search");
      if (!(nextInput instanceof HTMLInputElement)) return;
      nextInput.focus();
      nextInput.setSelectionRange(nextValue.length, nextValue.length);
    });
  });

  body.querySelectorAll("[data-ravi-open-chat]").forEach((button) => {
    button.addEventListener("click", async () => {
      const sessionKey = button.getAttribute("data-ravi-open-chat");
      const target = navTargets.find((item) => item.sessionKey === sessionKey);
      if (!target) return;
      await openCockpitChat(target);
    });
  });

  body.querySelectorAll("[data-ravi-pin-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionKey = button.getAttribute("data-ravi-pin-session");
      if (!sessionKey) return;
      pinnedSessionKey = sessionKey;
      persistPinnedSessionKey(sessionKey);
      render(snapshot, context);
    });
  });

  body.querySelectorAll("[data-ravi-follow-current]").forEach((button) => {
    button.addEventListener("click", () => {
      pinnedSessionKey = null;
      persistPinnedSessionKey(null);
      render(snapshot, context);
    });
  });

  body.querySelectorAll("[data-ravi-focus-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionKey = button.getAttribute("data-ravi-focus-session");
      const taskId = button.getAttribute("data-ravi-focus-task");
      if (!sessionKey) return;
      const target = navTargets.find((item) => item.sessionKey === sessionKey) || null;
      if (!target) return;
      if (taskId) {
        selectedTaskId = taskId;
        persistSelectedTaskId(taskId);
        void ensureTaskSelection(taskId);
      }
      openSessionWorkspace(target);
    });
  });

  body.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.getAttribute("data-action");
      const value = button.getAttribute("data-value");
      try {
        const next = await chrome.runtime.sendMessage({
          type: "ravi:session-action",
          payload: {
            session: focusedSession.sessionKey,
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

  syncSessionWorkspaceMain(snapshot);
}

function renderOmniWorkspace(body, context) {
  const panel = latestOmniPanel;
  const actor = getOmniPanelActor(panel);
  const preferredInstance = panel?.preferredInstance || null;
  const instances = filterOmniInstances(panel?.instances || []);
  const agents = filterOmniAgents(panel?.agents || []);
  const chats = filterOmniChats(panel?.chats || []);
  const groups = filterOmniGroups(panel?.groups || []);
  const sessions = filterOmniSessions(panel?.sessions || []);
  const fallbackChatId = selectedOmniChatId || panel?.currentChat?.id || chats[0]?.id || null;
  const selectedChat = chats.find((chat) => chat.id === fallbackChatId) || panel?.currentChat || chats[0] || null;
  selectedOmniChatId = selectedChat?.id || null;
  const fallbackSessionKey =
    selectedOmniSessionKey ||
    selectedChat?.linkedSession?.sessionKey ||
    panel?.currentChat?.linkedSession?.sessionKey ||
    sessions[0]?.sessionKey ||
    null;
  const selectedSession = sessions.find((session) => session.sessionKey === fallbackSessionKey) || null;
  selectedOmniSessionKey = selectedSession?.sessionKey || null;
  const defaultRouteAgentId =
    selectedOmniRouteAgentId ||
    selectedSession?.agentId ||
    selectedChat?.linkedSession?.agentId ||
    agents[0]?.id ||
    null;
  if (defaultRouteAgentId && agents.some((agent) => agent.id === defaultRouteAgentId)) {
    selectedOmniRouteAgentId = defaultRouteAgentId;
  } else if (!agents.some((agent) => agent.id === selectedOmniRouteAgentId)) {
    selectedOmniRouteAgentId = agents[0]?.id || null;
  }
  const selectedRouteAgentId = selectedOmniRouteAgentId || null;
  const createSessionPlaceholder = buildOmniDraftSessionName(selectedChat, selectedRouteAgentId);
  const createNewAgentSessionPlaceholder = buildOmniDraftSessionName(
    selectedChat,
    omniDraftNewAgentId || selectedRouteAgentId || "novo",
  );
  const actorLabel = actor ? `${actor.sessionName} · ${actor.agentId}` : "sem ator atual";

  const heroTitle = preferredInstance?.profileName || preferredInstance?.name || "omni";
  const heroSummary = selectedChat
    ? `${selectedChat.name || selectedChat.externalId || "chat"} · ${formatOmniChatType(selectedChat.chatType)}`
    : preferredInstance
      ? `instância ${preferredInstance.name} pronta para operar`
      : "sem instância whatsapp do omni";
  const heroStatus = preferredInstance ? formatOmniInstanceStatus(preferredInstance) : "offline";
  const heroStateClass = preferredInstance?.isConnected ? "streaming" : preferredInstance?.isActive ? "thinking" : "idle";

  body.innerHTML = `
    <div class="ravi-wa-omni-page">
      <section class="ravi-wa-omni-hero">
        <div class="ravi-wa-hero-top">
          <div>
            <h3>${escapeHtml(heroTitle)}</h3>
            <p>${escapeHtml(heroSummary)}</p>
          </div>
          <span class="ravi-wa-state-pill ravi-wa-state-pill--${heroStateClass}">${escapeHtml(heroStatus)}</span>
        </div>
        <div class="ravi-wa-chip-row">
          ${
            preferredInstance
              ? `
            <span class="ravi-wa-meta-chip">instância ${escapeHtml(preferredInstance.name)}</span>
            <span class="ravi-wa-meta-chip">phone ${escapeHtml(preferredInstance.phone || shorten(preferredInstance.ownerIdentifier || "-", 18))}</span>
            <span class="ravi-wa-meta-chip">channel ${escapeHtml(preferredInstance.channel)}</span>
            <span class="ravi-wa-meta-chip">ator ${escapeHtml(actorLabel)}</span>
            ${selectedChat ? `<span class="ravi-wa-meta-chip">chat ${escapeHtml(shorten(selectedChat.name || selectedChat.externalId || "-", 24))}</span>` : ""}
          `
              : `<span class="ravi-wa-meta-chip">sem instância preferida</span><span class="ravi-wa-meta-chip">ator ${escapeHtml(actorLabel)}</span>`
          }
        </div>
      </section>

      <section class="ravi-wa-omni-toolbar">
        <label class="ravi-wa-sidebar-search">
          <span>buscar canal</span>
          <input id="ravi-wa-omni-search" type="text" placeholder="luis, ravi, 120363..." value="${escapeAttribute(omniFilter)}" />
        </label>
        <label class="ravi-wa-sidebar-search">
          <span>buscar sessão ravi</span>
          <input id="ravi-wa-omni-session-search" type="text" placeholder="dev, main, agent..." value="${escapeAttribute(omniSessionFilter)}" />
        </label>
      </section>

      <section class="ravi-wa-omni-grid">
        <section class="ravi-wa-omni-column ravi-wa-omni-column--left">
          <div class="ravi-wa-card ravi-wa-card--flush">
            <div class="ravi-wa-section-head">
              <h3>instâncias whatsapp</h3>
              <span>${instances.length}</span>
            </div>
            ${renderOmniInstanceRows(instances, preferredInstance)}
          </div>
          <div class="ravi-wa-card ravi-wa-card--flush">
            <div class="ravi-wa-section-head">
              <h3>grupos</h3>
              <span>${groups.length}</span>
            </div>
            ${renderOmniGroupRows(groups)}
          </div>
        </section>

        <section class="ravi-wa-omni-column ravi-wa-omni-column--center">
          <div class="ravi-wa-card ravi-wa-card--flush">
            <div class="ravi-wa-section-head">
              <h3>chats da instância</h3>
              <span>${chats.length}</span>
            </div>
            ${renderOmniChatRows(chats, selectedChat, "Nenhum chat recente nessa instância.")}
          </div>
        </section>

        <section class="ravi-wa-omni-column ravi-wa-omni-column--right">
          ${renderOmniRoutingPanel(selectedChat, selectedSession, agents, selectedRouteAgentId, {
            createSessionPlaceholder,
            createNewAgentSessionPlaceholder,
          })}
          ${
            panel?.warnings?.length
              ? `
            <section class="ravi-wa-card ravi-wa-notice ravi-wa-notice--info">
              <p>${escapeHtml(panel.warnings.join(" · "))}</p>
            </section>
          `
              : ""
          }
        </section>
      </section>
    </div>
  `;

  const searchInput = body.querySelector("#ravi-wa-omni-search");
  searchInput?.addEventListener("input", (event) => {
    const nextValue = event.target.value || "";
    omniFilter = nextValue;
    render();
    requestAnimationFrame(() => {
      const nextInput = document.getElementById("ravi-wa-omni-search");
      if (!(nextInput instanceof HTMLInputElement)) return;
      nextInput.focus();
      nextInput.setSelectionRange(nextValue.length, nextValue.length);
    });
  });

  const sessionSearchInput = body.querySelector("#ravi-wa-omni-session-search");
  sessionSearchInput?.addEventListener("input", (event) => {
    const nextValue = event.target.value || "";
    omniSessionFilter = nextValue;
    render();
    requestAnimationFrame(() => {
      const nextInput = document.getElementById("ravi-wa-omni-session-search");
      if (!(nextInput instanceof HTMLInputElement)) return;
      nextInput.focus();
      nextInput.setSelectionRange(nextValue.length, nextValue.length);
    });
  });

  body.querySelectorAll("[data-ravi-omni-instance]").forEach((button) => {
    button.addEventListener("click", async () => {
      const instanceId = button.getAttribute("data-ravi-omni-instance");
      if (!instanceId) return;
      preferredOmniInstance = instanceId;
      persistPreferredOmniInstance(instanceId);
      await refreshOmniPanel(true);
      render();
    });
  });

  body.querySelectorAll("[data-ravi-omni-select-chat]").forEach((button) => {
    button.addEventListener("click", () => {
      const chatId = button.getAttribute("data-ravi-omni-select-chat");
      if (!chatId) return;
      selectedOmniChatId = chatId;
      const chat = chats.find((item) => item.id === chatId) || null;
      selectedOmniSessionKey = chat?.linkedSession?.sessionKey || selectedOmniSessionKey;
      selectedOmniRouteAgentId = chat?.linkedSession?.agentId || selectedOmniRouteAgentId;
      render();
    });
  });

  body.querySelectorAll("[data-ravi-omni-open-chat]").forEach((button) => {
    button.addEventListener("click", async () => {
      const chatId = button.getAttribute("data-ravi-omni-open-chat");
      const target = chats.find((item) => item?.id === chatId) || (selectedChat?.id === chatId ? selectedChat : null);
      if (!target) return;
      await openOmniChatTarget(target);
    });
  });

  body.querySelectorAll("[data-ravi-omni-open-group]").forEach((button) => {
    button.addEventListener("click", async () => {
      const externalId = button.getAttribute("data-ravi-omni-open-group");
      const target = (panel?.groups || []).find((item) => item?.externalId === externalId);
      if (!target) return;
      await openGenericChatTarget({
        chatId: target.externalId,
        title: target.name,
        label: target.name || target.externalId || "grupo",
      });
    });
  });

  body.querySelectorAll("[data-ravi-omni-select-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionKey = button.getAttribute("data-ravi-omni-select-session");
      if (!sessionKey) return;
      selectedOmniSessionKey = sessionKey;
      const session = sessions.find((item) => item.sessionKey === sessionKey) || null;
      if (session?.agentId) {
        selectedOmniRouteAgentId = session.agentId;
      }
      render();
    });
  });

  body.querySelectorAll("[data-ravi-omni-bind-chat]").forEach((button) => {
    button.addEventListener("click", async () => {
      const formState = getOmniRoutingFormState(body, panel, chats, sessions, agents);
      if (!formState.selectedChat || !formState.selectedSession) return;
      await runOmniRouteAction(async () => {
        try {
          const response = await chrome.runtime.sendMessage({
            type: "ravi:v3-command",
            payload: {
              name: "chat.bindSession",
              args: {
                actorSession: getCurrentOmniActorSession(),
                session: formState.selectedSession.sessionName,
                title: formState.selectedChat.name,
                chatId: formState.selectedChat.externalId || formState.selectedChat.canonicalId,
                instance: formState.selectedChat.instanceName,
                chatType: formState.selectedChat.chatType,
                chatName: formState.selectedChat.name,
              },
            },
          });
          const result = response?.ack?.body?.result || null;
          if (response?.ok === false || !result) {
            setSidebarNotice("error", formatOmniRouteError(response, "falha ao vincular chat"));
            return;
          }
          if (result?.ok === false) {
            setSidebarNotice("error", formatOmniRouteError(result, "falha ao vincular chat"));
            return;
          }
          selectedOmniSessionKey = result.snapshot?.session?.sessionKey || formState.selectedSession.sessionKey;
          selectedOmniRouteAgentId = result.snapshot?.session?.agentId || formState.selectedRouteAgentId;
          setSidebarNotice(
            "success",
            buildOmniRouteNotice("bind-existing", result, formState.selectedChat, formState.selectedSession),
          );
          await refreshSnapshot();
          await refreshOmniPanel(true);
          render();
        } catch (error) {
          handleRuntimeError(error);
        }
      });
    });
  });

  const agentSelect = body.querySelector("#ravi-wa-omni-target-agent");
  agentSelect?.addEventListener("change", (event) => {
    selectedOmniRouteAgentId = event.target.value || null;
  });

  const newSessionInput = body.querySelector("#ravi-wa-omni-new-session-name");
  newSessionInput?.addEventListener("input", (event) => {
    omniDraftSessionName = event.target.value || "";
  });

  body.querySelectorAll("[data-ravi-omni-create-session]").forEach((button) => {
    button.addEventListener("click", async () => {
      const formState = getOmniRoutingFormState(body, panel, chats, sessions, agents);
      if (!formState.selectedChat || !formState.selectedRouteAgentId) return;
      await runOmniRouteAction(async () => {
        try {
          const result = await chrome.runtime.sendMessage({
            type: "ravi:omni-route",
            payload: {
              action: "create-session",
              actorSession: getCurrentOmniActorSession(),
              agentId: formState.selectedRouteAgentId,
              sessionName: formState.draftSessionName || undefined,
              title: formState.selectedChat.name,
              chatId: formState.selectedChat.externalId || formState.selectedChat.canonicalId,
              instance: formState.selectedChat.instanceName,
              chatType: formState.selectedChat.chatType,
              chatName: formState.selectedChat.name,
            },
          });
          if (result?.ok === false) {
            setSidebarNotice("error", formatOmniRouteError(result, "falha ao criar sessão"));
            return;
          }
          selectedOmniSessionKey = result?.snapshot?.session?.sessionKey || selectedOmniSessionKey;
          selectedOmniRouteAgentId = result?.snapshot?.session?.agentId || formState.selectedRouteAgentId;
          omniDraftSessionName = "";
          setSidebarNotice(
            "success",
            buildOmniRouteNotice("create-session", result, formState.selectedChat, result?.snapshot?.session),
          );
          await refreshSnapshot();
          await refreshOmniPanel(true);
          render();
        } catch (error) {
          handleRuntimeError(error);
        }
      });
    });
  });

  body.querySelectorAll("[data-ravi-omni-migrate-session]").forEach((button) => {
    button.addEventListener("click", async () => {
      const formState = getOmniRoutingFormState(body, panel, chats, sessions, agents);
      if (!formState.selectedChat || !formState.selectedRouteAgentId || !formState.currentLinkedSession) return;
      await runOmniRouteAction(async () => {
        try {
          const result = await chrome.runtime.sendMessage({
            type: "ravi:omni-route",
            payload: {
              action: "migrate-session",
              actorSession: getCurrentOmniActorSession(),
              session: formState.currentLinkedSession.sessionName,
              agentId: formState.selectedRouteAgentId,
              sessionName: formState.draftSessionName || undefined,
              title: formState.selectedChat.name,
              chatId: formState.selectedChat.externalId || formState.selectedChat.canonicalId,
              instance: formState.selectedChat.instanceName,
              chatType: formState.selectedChat.chatType,
              chatName: formState.selectedChat.name,
            },
          });
          if (result?.ok === false) {
            setSidebarNotice("error", formatOmniRouteError(result, "falha ao migrar sessão"));
            return;
          }
          selectedOmniSessionKey = result?.snapshot?.session?.sessionKey || selectedOmniSessionKey;
          selectedOmniRouteAgentId = result?.snapshot?.session?.agentId || formState.selectedRouteAgentId;
          omniDraftSessionName = "";
          setSidebarNotice(
            "success",
            buildOmniRouteNotice("migrate-session", result, formState.selectedChat, result?.snapshot?.session),
          );
          await refreshSnapshot();
          await refreshOmniPanel(true);
          render();
        } catch (error) {
          handleRuntimeError(error);
        }
      });
    });
  });

  const newAgentInput = body.querySelector("#ravi-wa-omni-new-agent-id");
  newAgentInput?.addEventListener("input", (event) => {
    omniDraftNewAgentId = event.target.value || "";
  });

  const newAgentSessionInput = body.querySelector("#ravi-wa-omni-new-agent-session-name");
  newAgentSessionInput?.addEventListener("input", (event) => {
    omniDraftNewAgentSessionName = event.target.value || "";
  });

  body.querySelectorAll("[data-ravi-omni-create-agent-session]").forEach((button) => {
    button.addEventListener("click", async () => {
      const formState = getOmniRoutingFormState(body, panel, chats, sessions, agents);
      if (!formState.selectedChat) return;
      const nextAgentId = formState.draftNewAgentId;
      if (!nextAgentId) {
        setSidebarNotice("error", "preenche o id do novo agent");
        return;
      }
      await runOmniRouteAction(async () => {
        try {
          const result = await chrome.runtime.sendMessage({
            type: "ravi:omni-route",
            payload: {
              action: "create-session",
              actorSession: getCurrentOmniActorSession(),
              createAgent: true,
              agentId: nextAgentId,
              sessionName: formState.draftNewAgentSessionName || undefined,
              title: formState.selectedChat.name,
              chatId: formState.selectedChat.externalId || formState.selectedChat.canonicalId,
              instance: formState.selectedChat.instanceName,
              chatType: formState.selectedChat.chatType,
              chatName: formState.selectedChat.name,
            },
          });
          if (result?.ok === false) {
            setSidebarNotice("error", formatOmniRouteError(result, "falha ao criar agent e sessão"));
            return;
          }
          selectedOmniSessionKey = result?.snapshot?.session?.sessionKey || selectedOmniSessionKey;
          selectedOmniRouteAgentId = result?.snapshot?.session?.agentId || nextAgentId;
          omniDraftNewAgentId = "";
          omniDraftNewAgentSessionName = "";
          setSidebarNotice(
            "success",
            buildOmniRouteNotice("create-agent-session", result, formState.selectedChat, result?.snapshot?.session),
          );
          await refreshSnapshot();
          await refreshOmniPanel(true);
          render();
        } catch (error) {
          handleRuntimeError(error);
        }
      });
    });
  });
}

function getOmniRoutingFormState(body, panel, chats, sessions, agents) {
  const fallbackChatId = selectedOmniChatId || panel?.currentChat?.id || chats[0]?.id || null;
  const selectedChat = chats.find((chat) => chat.id === fallbackChatId) || panel?.currentChat || chats[0] || null;
  const currentLinkedSession = selectedChat?.linkedSession || panel?.currentChat?.linkedSession || null;
  const fallbackSessionKey =
    selectedOmniSessionKey ||
    currentLinkedSession?.sessionKey ||
    sessions[0]?.sessionKey ||
    null;
  const selectedSession = sessions.find((session) => session.sessionKey === fallbackSessionKey) || null;
  const agentSelect = body.querySelector("#ravi-wa-omni-target-agent");
  const nextRouteAgentId =
    (agentSelect instanceof HTMLSelectElement ? agentSelect.value : null) ||
    selectedOmniRouteAgentId ||
    selectedSession?.agentId ||
    selectedChat?.linkedSession?.agentId ||
    agents[0]?.id ||
    null;
  const newSessionInput = body.querySelector("#ravi-wa-omni-new-session-name");
  const newAgentInput = body.querySelector("#ravi-wa-omni-new-agent-id");
  const newAgentSessionInput = body.querySelector("#ravi-wa-omni-new-agent-session-name");
  const draftSessionName =
    (newSessionInput instanceof HTMLInputElement ? newSessionInput.value : omniDraftSessionName).trim() || null;
  const draftNewAgentId =
    (newAgentInput instanceof HTMLInputElement ? newAgentInput.value : omniDraftNewAgentId).trim() || null;
  const draftNewAgentSessionName =
    (newAgentSessionInput instanceof HTMLInputElement
      ? newAgentSessionInput.value
      : omniDraftNewAgentSessionName
    ).trim() || null;

  selectedOmniChatId = selectedChat?.id || null;
  selectedOmniSessionKey = selectedSession?.sessionKey || selectedOmniSessionKey;
  selectedOmniRouteAgentId = nextRouteAgentId;
  omniDraftSessionName = draftSessionName || "";
  omniDraftNewAgentId = draftNewAgentId || "";
  omniDraftNewAgentSessionName = draftNewAgentSessionName || "";

  return {
    selectedChat,
    currentLinkedSession,
    selectedSession,
    selectedRouteAgentId: nextRouteAgentId,
    draftSessionName,
    draftNewAgentId,
    draftNewAgentSessionName,
  };
}

async function runOmniRouteAction(fn) {
  if (omniRouteActionInFlight) return;
  omniRouteActionInFlight = true;
  try {
    await fn();
  } finally {
    omniRouteActionInFlight = false;
  }
}

function renderOmniInstanceRows(items, preferredInstance) {
  if (!items.length) {
    return `<p class="ravi-wa-empty">Nenhuma instância WhatsApp do Omni disponível.</p>`;
  }

  return `
    <div class="ravi-wa-nav-list">
      ${items
        .map((instance) => {
          const selected = preferredInstance?.id === instance.id ? "true" : "false";
          const subline = [instance.profileName, instance.phone, shorten(instance.ownerIdentifier || "", 18)].filter(Boolean).join(" · ");
          const stateClass = instance.isConnected ? "streaming" : instance.isActive ? "thinking" : "idle";
          const opaque = isOmniOpaque(instance);
          const title = buildOmniItemPermissionTitle(instance, instance.name);
          return `
            <button
              type="button"
              class="ravi-wa-nav-row${selected === "true" ? " ravi-wa-nav-row--selected" : ""}${opaque ? " ravi-wa-nav-row--opaque" : ""}"
              data-ravi-omni-instance="${escapeAttribute(instance.id)}"
              aria-pressed="${selected}"
              title="${escapeAttribute(title)}"
            >
              <span class="ravi-wa-nav-row__avatar">OM</span>
              <span class="ravi-wa-nav-row__body">
                <span class="ravi-wa-nav-row__titleline">
                  <strong>${escapeHtml(instance.name)}</strong>
                  <span class="ravi-wa-nav-row__agent">${escapeHtml(instance.channel.replace("whatsapp-", ""))}</span>
                </span>
                <span class="ravi-wa-nav-row__subline">${escapeHtml(opaque ? "sem permissão para detalhes da instância" : subline || "sem profile sincronizado")}</span>
              </span>
              <span class="ravi-wa-nav-row__aside">
                <span class="ravi-wa-nav-row__elapsed">${escapeHtml(formatElapsedFromIso(instance.lastSeenAt || instance.updatedAt) || "-")}</span>
                <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${opaque ? "locked" : stateClass}">${escapeHtml(opaque ? "opaque" : formatOmniInstanceStatus(instance))}</span>
              </span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderOmniChatRows(items, currentChat, emptyText) {
  if (!items.length) {
    return `<p class="ravi-wa-empty">${escapeHtml(emptyText)}</p>`;
  }

  return `
    <div class="ravi-wa-nav-list">
      ${items
        .map((chat) => {
          const selected = currentChat?.id === chat.id ? "true" : "false";
          const opaque = isOmniOpaque(chat);
          const subline = opaque ? "sem permissão para detalhes do chat" : chat.lastMessagePreview || chat.externalId || "sem preview";
          const linkedSession = chat.linkedSession;
          const linkedState = opaque ? "locked" : linkedSession ? chipActivityClass(linkedSession.live?.activity) : "idle";
          const linkedLabel = opaque
            ? describeOmniMissingRelations(chat?.auth?.view?.missing) || "sem permissão"
            : linkedSession
            ? `${linkedSession.sessionName} · ${chipActivityLabel(linkedSession.live?.activity)}`
            : "sem sessão";
          const title = buildOmniItemPermissionTitle(chat, chat.name || chat.externalId || chat.id);
          return `
            <button
              type="button"
              class="ravi-wa-nav-row${selected === "true" ? " ravi-wa-nav-row--selected" : ""}${opaque ? " ravi-wa-nav-row--opaque" : ""}"
              data-ravi-omni-select-chat="${escapeAttribute(chat.id)}"
              aria-pressed="${selected}"
              title="${escapeAttribute(title)}"
            >
              <span class="ravi-wa-nav-row__avatar">WA</span>
              <span class="ravi-wa-nav-row__body">
                <span class="ravi-wa-nav-row__titleline">
                  <strong>${escapeHtml(chat.name || chat.externalId || "chat")}</strong>
                  <span class="ravi-wa-nav-row__agent">${escapeHtml(formatOmniChatType(chat.chatType))}</span>
                </span>
                <span class="ravi-wa-nav-row__subline">${escapeHtml(shorten(subline, 52))}</span>
                <span class="ravi-wa-nav-row__subline ravi-wa-nav-row__subline--session">${escapeHtml(linkedLabel)}</span>
              </span>
              <span class="ravi-wa-nav-row__aside">
                <span class="ravi-wa-nav-row__elapsed">${escapeHtml(formatElapsedFromIso(chat.lastMessageAt || chat.updatedAt) || "-")}</span>
                <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${linkedState}">${escapeHtml(opaque ? "opaque" : formatUnreadLabel(chat.unreadCount))}</span>
              </span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderOmniRoutingPanel(selectedChat, selectedSession, agents, selectedRouteAgentId, drafts) {
  if (!selectedChat) {
    return `
      <section class="ravi-wa-card ravi-wa-card--flush">
        <div class="ravi-wa-section-head">
          <h3>roteamento ravi</h3>
          <span>sem chat</span>
        </div>
        <p class="ravi-wa-empty">seleciona um chat do omni pra ver e configurar a sessão vinculada.</p>
      </section>
    `;
  }

  const currentLinkedSession = selectedChat.linkedSession || null;
  const routeFormState = {
    selectedChat,
    selectedSession,
    currentLinkedSession,
    selectedRouteAgentId,
    draftNewAgentId: omniDraftNewAgentId.trim() || null,
  };
  const bindAction = getOmniActionState("bind-existing", routeFormState);
  const createAction = getOmniActionState("create-session", routeFormState);
  const migrateAction = getOmniActionState("migrate-session", routeFormState);
  const createAgentAction = getOmniActionState("create-agent-session", routeFormState);
  const bindLabel = buildOmniBindButtonLabel(currentLinkedSession, selectedSession);
  const bindDisabled =
    !bindAction.allowed || !selectedSession || (currentLinkedSession && currentLinkedSession.sessionKey === selectedSession.sessionKey);
  const selectedRouteAgent = agents.find((agent) => agent.id === selectedRouteAgentId) || null;
  const migrateDisabled = !migrateAction.allowed;
  const migrateLabel = currentLinkedSession
    ? `Migrar para ${selectedRouteAgent?.id || "agent"}`
    : "Migrar sessão";
  const selectedChatOpaque = isOmniOpaque(selectedChat);
  const currentSessionOpaque = isOmniOpaque(currentLinkedSession);
  const routeSummaryText = selectedChatOpaque
    ? describeOmniMissingRelations(selectedChat?.auth?.view?.missing) || "sem permissão para detalhes do chat"
    : selectedChat.lastMessagePreview || selectedChat.externalId || "sem preview";

  return `
    <section class="ravi-wa-card ravi-wa-card--flush">
      <div class="ravi-wa-section-head">
        <h3>roteamento ravi</h3>
        <span>${escapeHtml(formatOmniChatType(selectedChat.chatType))}</span>
      </div>
      <div class="ravi-wa-route-summary">
        <strong>${escapeHtml(selectedChat.name || selectedChat.externalId || "chat")}</strong>
        <p>${escapeHtml(routeSummaryText)}</p>
        <div class="ravi-wa-chip-row">
          <span class="ravi-wa-meta-chip">chatId ${escapeHtml(shorten(selectedChat.externalId || selectedChat.canonicalId || "-", 28))}</span>
          <span class="ravi-wa-meta-chip">unread ${escapeHtml(selectedChatOpaque ? "-" : String(selectedChat.unreadCount ?? 0))}</span>
          <span class="ravi-wa-meta-chip">participants ${escapeHtml(selectedChatOpaque ? "-" : String(selectedChat.participantCount ?? "-"))}</span>
        </div>
        ${
          selectedChatOpaque
            ? `<p class="ravi-wa-route-auth-hint">relação faltando: ${escapeHtml(describeOmniMissingRelations(selectedChat?.auth?.view?.missing) || "read route")}</p>`
            : ""
        }
      </div>

      <div class="ravi-wa-route-binding">
        <div class="ravi-wa-route-binding__current">
          <span class="ravi-wa-route-binding__label">sessão atual do chat</span>
          ${
            currentLinkedSession
              ? `
            <button
              type="button"
              class="ravi-wa-nav-row ravi-wa-nav-row--selected${currentSessionOpaque ? " ravi-wa-nav-row--opaque" : ""}"
              data-ravi-omni-select-session="${escapeAttribute(currentLinkedSession.sessionKey)}"
              title="${escapeAttribute(buildOmniItemPermissionTitle(currentLinkedSession, currentLinkedSession.sessionName))}"
            >
              <span class="ravi-wa-nav-row__avatar">${escapeHtml(shorten(currentLinkedSession.agentId.slice(0, 2).toUpperCase(), 2))}</span>
              <span class="ravi-wa-nav-row__body">
                <span class="ravi-wa-nav-row__titleline">
                  <strong>${escapeHtml(currentLinkedSession.sessionName)}</strong>
                  <span class="ravi-wa-nav-row__agent">${escapeHtml(currentLinkedSession.agentId)}</span>
                </span>
                <span class="ravi-wa-nav-row__subline">${escapeHtml(currentSessionOpaque ? describeOmniMissingRelations(currentLinkedSession?.auth?.view?.missing) || "sem permissão para detalhes da sessão" : currentLinkedSession.chatId || currentLinkedSession.displayName || "sem chat vinculado")}</span>
              </span>
              <span class="ravi-wa-nav-row__aside">
                <span class="ravi-wa-nav-row__elapsed">${escapeHtml(formatSessionElapsedCompact(currentLinkedSession) || "-")}</span>
                <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${currentSessionOpaque ? "locked" : chipActivityClass(currentLinkedSession.live?.activity)}">${escapeHtml(currentSessionOpaque ? "opaque" : chipActivityLabel(currentLinkedSession.live?.activity))}</span>
              </span>
            </button>
          `
              : `<p class="ravi-wa-empty">${escapeHtml(selectedChatOpaque ? "sessão vinculada opaca pelo rebac." : "nenhuma sessão casada ainda.")}</p>`
          }
        </div>
        <div class="ravi-wa-actions">
          <button data-ravi-omni-open-chat="${escapeAttribute(selectedChat.id)}">Abrir chat</button>
          ${
            selectedSession
              ? `<button data-ravi-omni-bind-chat="${escapeAttribute(selectedChat.id)}" title="${escapeAttribute(buildOmniActionTitle(bindLabel, bindAction))}"${bindDisabled ? " disabled" : ""}>${escapeHtml(bindLabel)}</button>`
              : `<button disabled>Escolhe uma sessão</button>`
          }
        </div>
      </div>

      <section class="ravi-wa-route-builder">
        <div class="ravi-wa-section-head ravi-wa-section-head--spaced">
          <h3>criar nova sessão</h3>
          <span>${escapeHtml(selectedRouteAgent?.id || "agent")}</span>
        </div>
        <div class="ravi-wa-route-form">
          <label class="ravi-wa-field">
            <span>agent destino</span>
            <select id="ravi-wa-omni-target-agent">
              ${renderOmniAgentOptions(agents, selectedRouteAgentId)}
            </select>
          </label>
          <label class="ravi-wa-field">
            <span>nome da sessão</span>
            <input
              id="ravi-wa-omni-new-session-name"
              type="text"
              placeholder="${escapeAttribute(drafts.createSessionPlaceholder || "deixa vazio pra gerar")}"
              value="${escapeAttribute(omniDraftSessionName)}"
            />
          </label>
        </div>
        <div class="ravi-wa-actions${currentLinkedSession ? "" : " ravi-wa-actions--single"}">
          ${
            currentLinkedSession
              ? `<button data-ravi-omni-migrate-session="${escapeAttribute(selectedChat.id)}" title="${escapeAttribute(buildOmniActionTitle(migrateLabel, migrateAction))}"${migrateDisabled ? " disabled" : ""}>${escapeHtml(migrateLabel)}</button>`
              : ""
          }
          <button data-ravi-omni-create-session="${escapeAttribute(selectedChat.id)}" title="${escapeAttribute(buildOmniActionTitle("Criar sessão + vincular", createAction))}"${createAction.allowed ? "" : " disabled"}>Criar sessão + vincular</button>
        </div>
      </section>

      <section class="ravi-wa-route-builder">
        <div class="ravi-wa-section-head ravi-wa-section-head--spaced">
          <h3>novo agent + sessão</h3>
          <span>bootstrap</span>
        </div>
        <div class="ravi-wa-route-form">
          <label class="ravi-wa-field">
            <span>id do novo agent</span>
            <input
              id="ravi-wa-omni-new-agent-id"
              type="text"
              placeholder="sales, ops, achados-ia"
              value="${escapeAttribute(omniDraftNewAgentId)}"
            />
          </label>
          <label class="ravi-wa-field">
            <span>nome da sessão</span>
            <input
              id="ravi-wa-omni-new-agent-session-name"
              type="text"
              placeholder="${escapeAttribute(drafts.createNewAgentSessionPlaceholder || "deixa vazio pra gerar")}"
              value="${escapeAttribute(omniDraftNewAgentSessionName)}"
            />
          </label>
        </div>
        <div class="ravi-wa-actions ravi-wa-actions--single">
          <button data-ravi-omni-create-agent-session="${escapeAttribute(selectedChat.id)}" title="${escapeAttribute(buildOmniActionTitle("Criar agent + sessão + vincular", createAgentAction))}"${createAgentAction.allowed ? "" : " disabled"}>Criar agent + sessão + vincular</button>
        </div>
      </section>

      <div class="ravi-wa-section-head ravi-wa-section-head--spaced">
        <h3>sessões ravi</h3>
        <span>${filterOmniSessions(latestOmniPanel?.sessions || []).length}</span>
      </div>
      ${renderOmniSessionRows(filterOmniSessions(latestOmniPanel?.sessions || []), selectedSession, "Nenhuma sessão Ravi disponível.")}
    </section>
  `;
}

function renderOmniSessionRows(items, selectedSession, emptyText) {
  if (!items.length) {
    return `<p class="ravi-wa-empty">${escapeHtml(emptyText)}</p>`;
  }

  return `
    <div class="ravi-wa-nav-list ravi-wa-nav-list--tall">
      ${items
        .map((session) => {
          const selected = selectedSession?.sessionKey === session.sessionKey ? "true" : "false";
          const opaque = isOmniOpaque(session);
          const activityClass = opaque ? "locked" : chipActivityClass(session.live?.activity);
          const linkedChat = opaque
            ? describeOmniMissingRelations(session?.auth?.view?.missing) || "sem permissão para detalhes da sessão"
            : getLinkedChatLabel(session);
          const title = buildOmniItemPermissionTitle(session, session.sessionName);
          return `
            <button
              type="button"
              class="ravi-wa-nav-row${selected === "true" ? " ravi-wa-nav-row--selected" : ""}${opaque ? " ravi-wa-nav-row--opaque" : ""}"
              data-ravi-omni-select-session="${escapeAttribute(session.sessionKey)}"
              aria-pressed="${selected}"
              title="${escapeAttribute(title)}"
            >
              <span class="ravi-wa-nav-row__avatar">${escapeHtml(shorten((session.agentId || "rv").slice(0, 2).toUpperCase(), 2))}</span>
              <span class="ravi-wa-nav-row__body">
                <span class="ravi-wa-nav-row__titleline">
                  <strong>${escapeHtml(session.sessionName)}</strong>
                  <span class="ravi-wa-nav-row__agent">${escapeHtml(session.agentId)}</span>
                </span>
                <span class="ravi-wa-nav-row__subline">${escapeHtml(shorten(linkedChat || session.chatId || "sem chat vinculado", 46))}</span>
              </span>
              <span class="ravi-wa-nav-row__aside">
                <span class="ravi-wa-nav-row__elapsed">${escapeHtml(formatSessionElapsedCompact(session) || "-")}</span>
                <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${activityClass}">${escapeHtml(opaque ? "opaque" : chipActivityLabel(session.live?.activity))}</span>
              </span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderOmniGroupRows(items) {
  if (!items.length) {
    return `<p class="ravi-wa-empty">Nenhum grupo listado nessa instância.</p>`;
  }

  return `
    <div class="ravi-wa-nav-list">
      ${items
        .map((group) => {
          const opaque = isOmniOpaque(group);
          const title = buildOmniItemPermissionTitle(group, group.name || group.externalId || "grupo");
          return `
          <button
            type="button"
            class="ravi-wa-nav-row${opaque ? " ravi-wa-nav-row--opaque" : ""}"
            data-ravi-omni-open-group="${escapeAttribute(group.externalId || "")}"
            title="${escapeAttribute(title)}"
          >
            <span class="ravi-wa-nav-row__avatar">GR</span>
            <span class="ravi-wa-nav-row__body">
              <span class="ravi-wa-nav-row__titleline">
                <strong>${escapeHtml(group.name || group.externalId || "grupo")}</strong>
                <span class="ravi-wa-nav-row__agent">${escapeHtml(group.isCommunity ? "community" : "group")}</span>
              </span>
              <span class="ravi-wa-nav-row__subline">${escapeHtml(opaque ? describeOmniMissingRelations(group?.auth?.view?.missing) || "sem permissão para detalhes do grupo" : group.description || group.externalId || "sem descrição")}</span>
            </span>
            <span class="ravi-wa-nav-row__aside">
              <span class="ravi-wa-nav-row__elapsed">${escapeHtml(opaque ? "-" : group.memberCount != null ? `${group.memberCount} membros` : "-")}</span>
              <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${opaque ? "locked" : "idle"}">${escapeHtml(opaque ? "opaque" : group.isReadOnly ? "read only" : "aberto")}</span>
            </span>
          </button>
        `;
        })
        .join("")}
    </div>
  `;
}

function renderRecentStack(container) {
  container.innerHTML = "";
  container.classList.add("ravi-hidden");
}

function renderLiveEventsCard(session) {
  const events = Array.isArray(session?.live?.events) ? session.live.events.slice(0, 8) : [];
  if (!events.length) {
    return `
      <section class="ravi-wa-card">
        <div class="ravi-wa-section-head">
          <h3>tempo real</h3>
          <span>0</span>
        </div>
        <p class="ravi-wa-empty">sem eventos vivos dessa sessão ainda.</p>
      </section>
    `;
  }

  return `
    <section class="ravi-wa-card">
      <div class="ravi-wa-section-head">
        <h3>tempo real</h3>
        <span>${escapeHtml(chipActivityLabel(session?.live?.activity || "idle"))}</span>
      </div>
      <div class="ravi-wa-live-log">
        ${events
          .map((event) => {
            const kind = chipActivityClass(eventKindToActivity(event.kind));
            return `
              <div class="ravi-wa-live-line ravi-wa-live-line--${kind}">
                <div class="ravi-wa-live-line__meta">
                  <span>${escapeHtml(formatElapsedCompact(event.timestamp) || "agora")}</span>
                  <strong>${escapeHtml(event.label || event.kind)}</strong>
                </div>
                <div class="ravi-wa-live-line__text">${escapeHtml(event.detail || event.kind)}</div>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function getSelectedWorkspaceSession(snapshot = latestSnapshot) {
  if (!selectedWorkspaceSessionKey) return null;

  if (latestSessionWorkspace?.session?.sessionKey === selectedWorkspaceSessionKey) {
    return latestSessionWorkspace.session;
  }

  return (
    dedupeSessionsByKey(
      [snapshot?.session, ...(snapshot?.activeSessions || snapshot?.hotSessions || []), ...(snapshot?.recentSessions || snapshot?.recentChats || [])].filter(
        Boolean,
      ),
    ).find((item) => item.sessionKey === selectedWorkspaceSessionKey) || null
  );
}

function ensureSessionWorkspaceMainHost() {
  const mainPane = document.getElementById("main");
  if (!(mainPane instanceof HTMLElement)) return null;

  if (currentSessionMainHost && currentSessionMainHost.parentElement !== mainPane) {
    currentSessionMainHost.remove();
    currentSessionMainHost = null;
  }

  let host = mainPane.querySelector(`#${SESSION_MAIN_HOST_ID}`);
  if (!(host instanceof HTMLElement)) {
    host = document.createElement("section");
    host.id = SESSION_MAIN_HOST_ID;
    host.className = "ravi-hidden";
    mainPane.appendChild(host);
  }

  currentSessionMainHost = host;
  return host;
}

function hideSessionWorkspaceMain() {
  const host = currentSessionMainHost || document.getElementById(SESSION_MAIN_HOST_ID);
  if (!(host instanceof HTMLElement)) return;
  host.classList.add("ravi-hidden");
  host.innerHTML = "";
  lastSessionWorkspaceRenderKey = null;
  lastSessionWorkspaceRenderSessionKey = null;
}

function shouldDeferSessionWorkspaceMainRender(host) {
  if (!(host instanceof HTMLElement)) return false;
  const active = document.activeElement;
  if (!active || !host.contains(active)) return false;
  if (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.tagName === "SELECT") {
    return true;
  }
  return active.getAttribute?.("contenteditable") === "true";
}

function normalizeSessionWorkspaceText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeSessionWorkspaceArtifacts(artifacts) {
  const seen = new Set();
  const next = [];

  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    if (!artifact) continue;
    const key = artifact.dedupeKey || artifact.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(artifact);
  }

  return next;
}

function shouldRenderSessionWorkspaceEvent(event, liveActivity, lastAssistantText) {
  const kind = String(event?.kind || "").trim().toLowerCase();
  if (!kind) return false;
  if (kind === "prompt" || kind === "response" || kind === "tool") return false;

  const detail = normalizeSessionWorkspaceText(event?.detail);
  if (kind === "stream") {
    if (liveActivity !== "streaming") return false;
    if (
      detail &&
      lastAssistantText &&
      (detail === lastAssistantText || detail.endsWith(lastAssistantText) || lastAssistantText.endsWith(detail))
    ) {
      return false;
    }
  }

  if (kind === "runtime") {
    if (!detail || detail === "idle" || detail === "turn.interrupted") return false;
  }

  return true;
}

function buildSessionWorkspaceLiveItems(session, messages) {
  const liveActivity = session?.live?.activity || "idle";
  const lastAssistant = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === "assistant" && normalizeSessionWorkspaceText(message.content));
  const lastAssistantText = normalizeSessionWorkspaceText(lastAssistant?.content);

  const events = (Array.isArray(session?.live?.events) ? session.live.events : [])
    .filter((event) => shouldRenderSessionWorkspaceEvent(event, liveActivity, lastAssistantText))
    .slice(0, 8)
    .map((event, index) => ({
      id: `event:${event.kind || "runtime"}:${event.timestamp || 0}:${index}`,
      type: "event",
      kind: event.kind || "runtime",
      label: event.label || event.kind || "evento",
      detail: event.detail || event.kind || "evento",
      timestamp: event.timestamp || 0,
    }));

  const artifacts = normalizeSessionWorkspaceArtifacts(session?.live?.artifacts || [])
    .sort((left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0))
    .slice(0, 8)
    .map((artifact) => ({
      id: `artifact:${artifact.dedupeKey || artifact.id}`,
      type: "artifact",
      kind: artifact.kind || "artifact",
      label: artifact.label || artifact.kind || "artifact",
      detail: artifact.detail || artifact.kind || "artifact",
      timestamp: artifact.updatedAt || artifact.createdAt || 0,
    }));

  return [...events, ...artifacts]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-12);
}

function sessionWorkspaceLiveItemTone(item) {
  if (item?.type === "artifact") {
    if (item.kind === "tool") return "tool";
    if (item.kind === "interruption") return "interruption";
    return "runtime";
  }

  if (item?.kind === "stream") return "streaming";
  if (item?.kind === "approval") return "approval";
  if (item?.kind === "runtime") return "runtime";
  return chipActivityClass(eventKindToActivity(item?.kind));
}

function buildSessionWorkspaceLiveMarkup(session, messages) {
  const items = buildSessionWorkspaceLiveItems(session, messages);
  if (!items.length) return "";

  return `
    <section class="ravi-wa-card ravi-wa-session-main__live">
      <div class="ravi-wa-section-head">
        <h3>tempo real</h3>
        <span>${escapeHtml(String(items.length))}</span>
      </div>
      <div class="ravi-wa-live-log">
        ${items
          .map((item) => {
            const tone = sessionWorkspaceLiveItemTone(item);
            return `
              <div class="ravi-wa-live-line ravi-wa-live-line--${escapeAttribute(tone)}">
                <div class="ravi-wa-live-line__meta">
                  <span>${escapeHtml(formatElapsedCompact(item.timestamp) || "agora")}</span>
                  <strong>${escapeHtml(item.label || item.kind || item.type)}</strong>
                </div>
                <div class="ravi-wa-live-line__text">${escapeHtml(item.detail || item.kind || item.type || "")}</div>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function buildSessionWorkspaceMainMarkup(session, workspace) {
  const messages = Array.isArray(workspace?.messages) ? workspace.messages : [];
  const liveMarkup = buildSessionWorkspaceLiveMarkup(session, messages);
  const activity = session?.live?.activity || "idle";
  const stateClass = chipActivityClass(activity);
  const stateLabel = chipActivityLabel(activity);
  const summary = session?.live?.summary || "sem evento vivo";
  const linkedChat = session ? getLinkedChatLabel(session) : null;
  const elapsed = session ? formatSessionElapsedCompact(session) || "agora" : "-";
  const historySource = workspace?.historySource || "recent-history";

  return `
    <div class="ravi-wa-session-main">
      <header class="ravi-wa-session-main__header">
        <div class="ravi-wa-session-main__titleblock">
          <div>
            <strong>${escapeHtml(session?.sessionName || "sessão desconhecida")}</strong>
            <span>${escapeHtml(summary)}</span>
          </div>
          <span class="ravi-wa-state-pill ravi-wa-state-pill--${stateClass}">${escapeHtml(stateLabel)}</span>
        </div>
        <div class="ravi-wa-chip-row">
          <span class="ravi-wa-meta-chip">agent ${escapeHtml(session?.agentId || "-")}</span>
          <span class="ravi-wa-meta-chip">tempo ${escapeHtml(elapsed)}</span>
          <span class="ravi-wa-meta-chip">histórico ${escapeHtml(historySource)}</span>
          ${linkedChat ? `<span class="ravi-wa-meta-chip">chat ${escapeHtml(shorten(linkedChat, 32))}</span>` : ""}
        </div>
        <div class="ravi-wa-actions">
          <button type="button" data-ravi-session-workspace-close="true">Voltar</button>
          ${session?.chatId ? `<button type="button" data-ravi-open-chat="${escapeAttribute(session.sessionKey)}">Abrir chat</button>` : ""}
        </div>
      </header>
      <div class="ravi-wa-session-main__thread" data-ravi-session-thread="true">
        ${
          messages.length
            ? messages
                .map((message) => {
                  const role = message.role || "unknown";
                  const bubbleRole = role === "user" ? "user" : role === "assistant" ? "assistant" : "system";
                  return `
                    <article class="ravi-wa-session-bubble ravi-wa-session-bubble--${escapeAttribute(bubbleRole)}">
                      <div class="ravi-wa-session-bubble__meta">
                        <strong>${escapeHtml(role)}</strong>
                        <span>${escapeHtml(formatTimestamp(message.createdAt) || "-")}</span>
                      </div>
                      <pre class="ravi-wa-session-bubble__body">${escapeHtml(message.content || "")}</pre>
                    </article>
                  `;
                })
                .join("")
            : !liveMarkup
              ? `<div class="ravi-wa-session-main__empty">sem mensagens recentes dessa sessão ainda.</div>`
              : ""
        }
        ${liveMarkup}
      </div>
      <form class="ravi-wa-session-main__composer" data-ravi-session-compose="true">
        <textarea
          data-ravi-session-compose-input="true"
          placeholder="mandar mensagem pra sessão..."
          ${sessionWorkspaceSubmitting ? "disabled" : ""}
        >${escapeHtml(sessionWorkspaceDraft)}</textarea>
        <div class="ravi-wa-session-main__composer-actions">
          <span>${escapeHtml(sessionWorkspaceSubmitting ? "enviando..." : "enter envia · shift+enter quebra")}</span>
          <button type="submit" ${sessionWorkspaceSubmitting ? "disabled" : ""}>Enviar</button>
        </div>
      </form>
    </div>
  `;
}

function computeSessionWorkspaceRenderKey(session, workspace) {
  const messages = Array.isArray(workspace?.messages) ? workspace.messages : [];
  const liveItems = buildSessionWorkspaceLiveItems(session, messages);
  return JSON.stringify({
    sessionKey: session?.sessionKey || null,
    sessionName: session?.sessionName || null,
    agentId: session?.agentId || null,
    activity: session?.live?.activity || null,
    summary: session?.live?.summary || null,
    busySince: session?.live?.busySince || null,
    historySource: workspace?.historySource || null,
    messageCount: messages.length,
    messages: messages.map((message) => [message.id || null, message.role || null, message.createdAt || null, message.content || ""]),
    liveItems: liveItems.map((item) => [item.id || null, item.type || null, item.kind || null, item.timestamp || null, item.label || null, item.detail || null]),
    submitting: sessionWorkspaceSubmitting,
  });
}

function isNearScrollBottom(element, threshold = 56) {
  if (!(element instanceof HTMLElement)) return false;
  return element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
}

function syncSessionWorkspaceMain(snapshot = latestSnapshot, options = {}) {
  const host = ensureSessionWorkspaceMainHost();
  if (!(host instanceof HTMLElement)) return;

  if (activeWorkspace !== "ravi" || !selectedWorkspaceSessionKey) {
    hideSessionWorkspaceMain();
    return;
  }

  if (!options.force && shouldDeferSessionWorkspaceMainRender(host)) {
    return;
  }

  const session = getSelectedWorkspaceSession(snapshot);
  const workspace =
    latestSessionWorkspace?.session?.sessionKey === selectedWorkspaceSessionKey ? latestSessionWorkspace : null;
  const previousThread = host.querySelector("[data-ravi-session-thread]");
  const previousScrollTop = previousThread instanceof HTMLElement ? previousThread.scrollTop : 0;
  const previousWasNearBottom = previousThread instanceof HTMLElement ? isNearScrollBottom(previousThread) : false;
  const renderKey = computeSessionWorkspaceRenderKey(session, workspace);
  const sessionKey = session?.sessionKey || selectedWorkspaceSessionKey || null;

  if (!options.force && renderKey === lastSessionWorkspaceRenderKey && sessionKey === lastSessionWorkspaceRenderSessionKey) {
    return;
  }

  host.classList.remove("ravi-hidden");
  host.innerHTML = buildSessionWorkspaceMainMarkup(session, workspace);
  lastSessionWorkspaceRenderKey = renderKey;
  lastSessionWorkspaceRenderSessionKey = sessionKey;

  host.querySelectorAll("[data-ravi-session-workspace-close]").forEach((button) => {
    button.addEventListener("click", () => {
      clearSessionWorkspace();
    });
  });

  host.querySelectorAll("[data-ravi-open-chat]").forEach((button) => {
    button.addEventListener("click", async () => {
      const sessionKey = button.getAttribute("data-ravi-open-chat");
      if (!sessionKey) return;
      const target = session || workspace?.session || null;
      if (!target || target.sessionKey !== sessionKey) return;
      const opened = await openCockpitChat(target);
      if (opened) {
        clearSessionWorkspace();
      }
    });
  });

  const textarea = host.querySelector("[data-ravi-session-compose-input]");
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.addEventListener("input", () => {
      sessionWorkspaceDraft = textarea.value;
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        host.querySelector("[data-ravi-session-compose]")?.dispatchEvent(
          new Event("submit", { cancelable: true, bubbles: true }),
        );
      }
    });
  }

  host.querySelectorAll("[data-ravi-session-compose]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await submitSessionWorkspacePrompt();
    });
  });

  const thread = host.querySelector("[data-ravi-session-thread]");
  if (thread instanceof HTMLElement) {
    const shouldStickToBottom = Boolean(options.scrollToEnd || sessionWorkspaceShouldScrollToEnd || previousWasNearBottom);
    requestAnimationFrame(() => {
      if (shouldStickToBottom) {
        thread.scrollTop = thread.scrollHeight;
      } else {
        const maxScrollTop = Math.max(0, thread.scrollHeight - thread.clientHeight);
        thread.scrollTop = Math.min(previousScrollTop, maxScrollTop);
      }
    });
  }
  sessionWorkspaceShouldScrollToEnd = false;
}

function clearSessionWorkspace() {
  selectedWorkspaceSessionKey = null;
  persistWorkspaceSessionKey(null);
  latestSessionWorkspace = null;
  sessionWorkspaceDraft = "";
  sessionWorkspaceSubmitting = false;
  sessionWorkspaceShouldScrollToEnd = false;
  hideSessionWorkspaceMain();
  render();
}

async function submitSessionWorkspacePrompt() {
  const session = getSelectedWorkspaceSession();
  const prompt = sessionWorkspaceDraft.trim();
  if (!session?.sessionKey || !prompt || sessionWorkspaceSubmitting) return;

  sessionWorkspaceSubmitting = true;
  sessionWorkspaceShouldScrollToEnd = true;
  syncSessionWorkspaceMain(latestSnapshot, { force: true });

  try {
    const result = await chrome.runtime.sendMessage({
      type: "ravi:session-prompt",
      payload: {
        session: session.sessionKey,
        prompt,
      },
    });

    if (!result?.ok) {
      setSidebarNotice("error", result?.error || "não consegui enviar o prompt");
      return;
    }

    sessionWorkspaceDraft = "";
    bridgeError = null;
    setSidebarNotice("success", `enviei pra ${session.sessionName}`);
    await refreshSessionWorkspace(true);
    await refreshSnapshot();
  } catch (error) {
    handleRuntimeError(error);
  } finally {
    sessionWorkspaceSubmitting = false;
    syncSessionWorkspaceMain(latestSnapshot, { force: true });
  }
}

function openSessionWorkspace(session) {
  if (!session?.sessionKey) return;
  selectedWorkspaceSessionKey = session.sessionKey;
  persistWorkspaceSessionKey(selectedWorkspaceSessionKey);
  latestSessionWorkspace = null;
  sessionWorkspaceDraft = "";
  pinnedSessionKey = session.sessionKey;
  persistPinnedSessionKey(session.sessionKey);
  sessionWorkspaceShouldScrollToEnd = true;
  setActiveWorkspace("ravi");
  refreshSessionWorkspace(true);
}

function rememberTaskSelection(selection) {
  const taskId = typeof selection?.task?.id === "string" ? selection.task.id : null;
  if (!taskId) return;
  taskSelectionCache.set(taskId, selection);
}

function normalizeTaskSessionName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isLiveTaskStatus(status) {
  return status !== "done" && status !== "failed";
}

function shouldReplaceTaskSessionMatch(currentTask, nextTask) {
  const currentIsLive = isLiveTaskStatus(currentTask?.status);
  const nextIsLive = isLiveTaskStatus(nextTask?.status);
  if (currentIsLive !== nextIsLive) {
    return nextIsLive;
  }
  return (Number(nextTask?.updatedAt) || 0) > (Number(currentTask?.updatedAt) || 0);
}

function getTaskSessionLookup(snapshot = latestTasksSnapshot) {
  if (!snapshot) {
    lastTaskSessionLookupSnapshot = snapshot;
    lastTaskSessionLookup = new Map();
    return lastTaskSessionLookup;
  }

  if (snapshot === lastTaskSessionLookupSnapshot) {
    return lastTaskSessionLookup;
  }

  const lookup = new Map();
  const tasks = Array.isArray(snapshot?.items) ? snapshot.items : [];
  tasks.forEach((task) => {
    const sessionNames = [...new Set([normalizeTaskSessionName(task?.workSessionName), normalizeTaskSessionName(task?.assigneeSessionName)].filter(Boolean))];
    sessionNames.forEach((sessionName) => {
      const existing = lookup.get(sessionName);
      if (!existing || shouldReplaceTaskSessionMatch(existing, task)) {
        lookup.set(sessionName, task);
      }
    });
  });

  lastTaskSessionLookupSnapshot = snapshot;
  lastTaskSessionLookup = lookup;
  return lookup;
}

function getCachedTaskSelection(taskId) {
  if (!taskId) return null;
  const selectedTask = latestTasksSnapshot?.selectedTask;
  if (selectedTask?.task?.id === taskId) {
    return selectedTask;
  }
  return taskSelectionCache.get(taskId) || null;
}

function getTaskLifecycleEvents(selection) {
  return Array.isArray(selection?.events) ? selection.events.filter((event) => event?.type !== "task.comment") : [];
}

function describeTaskSessionNote(task, session, selection) {
  const progressInfo = describeTaskProgressText(task, getTaskLifecycleEvents(selection));
  if (!progressInfo.fallback) {
    return progressInfo;
  }

  const taskSignal = normalizeTaskMessage(task?.blockerReason || task?.summary);
  if (taskSignal) {
    return { text: taskSignal, fallback: false };
  }

  const liveSummary = normalizeTaskMessage(session?.live?.summary);
  if (liveSummary) {
    return { text: liveSummary, fallback: false };
  }

  return progressInfo;
}

function resolveTaskSessionMatch(session) {
  const sessionName = normalizeTaskSessionName(session?.sessionName);
  if (!sessionName) return null;

  const task = getTaskSessionLookup().get(sessionName) || null;
  if (!task) return null;

  const selection = getCachedTaskSelection(task.id);
  return {
    task,
    selection,
    note: describeTaskSessionNote(task, session, selection),
  };
}

async function ensureTaskSelection(taskId) {
  if (!taskId || taskSelectionInFlight.has(taskId) || getCachedTaskSelection(taskId)) return;

  taskSelectionInFlight.add(taskId);
  try {
    const next = await chrome.runtime.sendMessage({
      type: "ravi:get-tasks",
      payload: buildTasksRequestPayload(taskId),
    });
    if (next?.ok && next?.selectedTask?.task?.id === taskId) {
      rememberTaskSelection(next.selectedTask);
      if (activeWorkspace !== "omni") {
        requestRender();
      }
    }
  } catch (error) {
    console.warn("[ravi-wa-overlay] failed to hydrate task selection", taskId, error);
  } finally {
    taskSelectionInFlight.delete(taskId);
  }
}

function primeTaskSessionDetails(matches) {
  const queue = [];
  const seen = new Set();
  (Array.isArray(matches) ? matches : []).forEach((match) => {
    const taskId = match?.task?.id;
    if (!taskId || seen.has(taskId) || getCachedTaskSelection(taskId) || taskSelectionInFlight.has(taskId)) return;
    seen.add(taskId);
    queue.push(taskId);
  });

  queue.slice(0, 4).forEach((taskId) => {
    void ensureTaskSelection(taskId);
  });
}

function renderGenericCockpitRow(session, currentSession) {
  const activityClass = chipActivityClass(session.live?.activity);
  const activityLabel = chipActivityLabel(session.live?.activity);
  const linkedChat = getLinkedChatLabel(session);
  const elapsed = formatSessionElapsedCompact(session) || "now";
  const subline = linkedChat
    ? shorten(linkedChat, 34)
    : session.channel
      ? `canal ${session.channel}`
      : "sem chat vinculado";
  const selected = currentSession?.sessionKey === session.sessionKey ? "true" : "false";
  const avatarLabel = shorten((session.agentId || "rv").slice(0, 2).toUpperCase(), 2);
  return `
    <button
      type="button"
      class="ravi-wa-nav-row ravi-wa-nav-row--${activityClass}${selected === "true" ? " ravi-wa-nav-row--selected" : ""}"
      data-ravi-focus-session="${escapeAttribute(session.sessionKey)}"
      aria-pressed="${selected}"
      title="${escapeAttribute(`${session.sessionName} · ${linkedChat || session.chatId || "-"}`)}"
    >
      <span class="ravi-wa-nav-row__avatar">${escapeHtml(avatarLabel)}</span>
      <span class="ravi-wa-nav-row__body">
        <span class="ravi-wa-nav-row__titleline">
          <strong>${escapeHtml(session.sessionName)}</strong>
          <span class="ravi-wa-nav-row__agent">${escapeHtml(session.agentId)}</span>
        </span>
        <span class="ravi-wa-nav-row__subline">${escapeHtml(subline)}</span>
      </span>
      <span class="ravi-wa-nav-row__aside">
        <span class="ravi-wa-nav-row__elapsed">${escapeHtml(elapsed)}</span>
        <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${activityClass}">${escapeHtml(activityLabel)}</span>
      </span>
    </button>
  `;
}

function renderTaskAwareCockpitRow(session, currentSession, match, options = {}) {
  const task = match.task;
  const statusClass = taskStatusClass(task.status);
  const statusLabel = taskStatusLabel(task.status);
  const selected = currentSession?.sessionKey === session.sessionKey ? "true" : "false";
  const linkedChat = getLinkedChatLabel(session);
  const progress = clampTaskProgressValue(task?.progress ?? 0);
  const shortTaskId = formatTaskShortId(task.id);
  const grouped = Boolean(options.grouped);
  const titleMode = options.titleMode === "session" ? "session" : "task";
  const avatarLabel =
    titleMode === "session"
      ? shorten((session.agentId || "rv").slice(0, 2).toUpperCase(), 2)
      : shortTaskId.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "TASK";
  const note = shorten(match.note.text, grouped ? 96 : 108);
  const debugMeta = grouped
    ? buildGroupedTaskAwareSessionMeta(session, linkedChat, titleMode)
    : [
        `session ${session.sessionName}`,
        session.agentId ? `agent ${session.agentId}` : null,
        linkedChat ? `chat ${shorten(linkedChat, 24)}` : session.channel ? `canal ${session.channel}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const taskMeta = grouped
    ? buildGroupedTaskAwareEyebrow(session, task, shortTaskId, titleMode)
    : [`task ${shortTaskId}`, task.priority ? `priority ${task.priority}` : null].filter(Boolean).join(" · ");
  const titleText = grouped
    ? buildGroupedTaskAwareTitle(session, task, options.parentTask, titleMode)
    : task.title || task.id;

  return `
    <button
      type="button"
      class="ravi-wa-nav-row ravi-wa-nav-row--task ravi-wa-nav-row--${statusClass}${grouped ? " ravi-wa-nav-row--task-compact" : ""}${selected === "true" ? " ravi-wa-nav-row--selected" : ""}"
      data-ravi-focus-session="${escapeAttribute(session.sessionKey)}"
      data-ravi-focus-task="${escapeAttribute(task.id)}"
      aria-pressed="${selected}"
      title="${escapeAttribute(`${task.title || task.id} · ${task.id} · ${session.sessionName}`)}"
    >
      <span class="ravi-wa-nav-row__avatar">${escapeHtml(avatarLabel)}</span>
      <span class="ravi-wa-nav-row__body">
        <span class="ravi-wa-nav-row__eyebrow">${escapeHtml(taskMeta)}</span>
        <span class="ravi-wa-nav-row__titleline">
          <strong>${escapeHtml(titleText)}</strong>
        </span>
        <span class="ravi-wa-nav-row__subline${match.note.fallback ? " ravi-wa-nav-row__subline--fallback" : ""}">${escapeHtml(note)}</span>
        <span class="ravi-wa-nav-row__progress">
          <span class="ravi-wa-nav-row__progress-label">${escapeHtml(String(progress))}%</span>
          <span class="ravi-wa-nav-row__progress-bar" aria-hidden="true"><span style="width: ${progress}%"></span></span>
        </span>
        <span class="ravi-wa-nav-row__subline ravi-wa-nav-row__subline--session">${escapeHtml(debugMeta)}</span>
      </span>
      <span class="ravi-wa-nav-row__aside">
        <span class="ravi-wa-nav-row__elapsed">${escapeHtml(formatTaskElapsed(task))}</span>
        <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${statusClass}">${escapeHtml(statusLabel)}</span>
      </span>
    </button>
  `;
}

function renderCockpitRows(items, currentSession, emptyText) {
  if (!items.length) {
    return `<p class="ravi-wa-empty">${escapeHtml(emptyText)}</p>`;
  }

  const rows = items.map((session) => ({
    session,
    taskMatch: resolveTaskSessionMatch(session),
  }));
  primeTaskSessionDetails(
    rows
      .map((row) => row.taskMatch)
      .filter(Boolean),
  );
  const entries = buildCockpitNavigationEntries(rows);

  return `
    <div class="ravi-wa-nav-list">
      ${entries
        .map((entry) => {
          if (entry.kind === "task-group") {
            return renderCockpitTaskGroup(entry.node, currentSession);
          }
          if (entry.taskMatch) {
            return renderTaskAwareCockpitRow(entry.session, currentSession, entry.taskMatch);
          }
          return renderGenericCockpitRow(entry.session, currentSession);
        })
        .join("")}
    </div>
  `;
}

function buildCockpitNavigationEntries(rows) {
  const hierarchyState = getTaskHierarchyState();
  const groupedRows = new Map();
  const entries = [];

  rows.forEach(({ session, taskMatch }, order) => {
    const taskId = taskMatch?.task?.id || null;
    const taskNode = taskId ? hierarchyState.nodes.get(taskId) : null;
    if (!taskId || !taskNode) {
      entries.push({
        kind: "session",
        order,
        session,
        taskMatch,
      });
      return;
    }

    const rootTaskId = getTaskRootTaskId(taskId, hierarchyState);
    const rootNode = hierarchyState.nodes.get(rootTaskId) || taskNode;
    const currentGroup = groupedRows.get(rootTaskId) || {
      rootNode,
      rowsByTaskId: new Map(),
    };
    const taskRows = currentGroup.rowsByTaskId.get(taskId) || [];
    taskRows.push({ session, taskMatch, order });
    currentGroup.rowsByTaskId.set(taskId, taskRows);
    groupedRows.set(rootTaskId, currentGroup);
  });

  const groupedEntries = [...groupedRows.values()].flatMap((group) => {
    const visibleNode = buildVisibleCockpitTaskNode(group.rootNode, group.rowsByTaskId);
    if (!visibleNode) return [];
    if (!shouldRenderCockpitTaskGroup(visibleNode)) {
      return visibleNode.rows.map((row) => ({
        kind: "session",
        order: row.order,
        session: row.session,
        taskMatch: row.taskMatch,
      }));
    }
    return [{ kind: "task-group", order: visibleNode.order, node: visibleNode }];
  });

  return [...entries, ...groupedEntries].sort((left, right) => left.order - right.order);
}

function renderCockpitTaskGroup(node, currentSession, parentTask = null, depth = 0) {
  if (!node?.task) return "";

  const ownRowsHtml = (Array.isArray(node.rows) ? node.rows : [])
    .map((row) =>
      renderTaskAwareCockpitRow(row.session, currentSession, row.taskMatch, {
        grouped: true,
        titleMode: depth === 0 ? "session" : "task",
        parentTask: depth === 0 ? node.task : parentTask,
      }),
    )
    .join("");
  const childHtml = (Array.isArray(node.children) ? node.children : [])
    .map((child) => renderCockpitTaskGroup(child, currentSession, node.task, depth + 1))
    .join("");

  if (depth === 0) {
    return `
      <div class="ravi-wa-nav-group">
        ${renderCockpitTaskGroupHeader(node)}
        <div class="ravi-wa-nav-group__children">
          ${ownRowsHtml}
          ${childHtml}
        </div>
      </div>
    `;
  }

  return `
    <div class="ravi-wa-nav-group__branch">
      ${ownRowsHtml ? "" : renderCockpitTaskGroupBranchHeader(node, parentTask)}
      ${ownRowsHtml}
      ${
        childHtml
          ? `<div class="ravi-wa-nav-group__children ravi-wa-nav-group__children--nested">${childHtml}</div>`
          : ""
      }
    </div>
  `;
}

function renderCockpitTaskGroupHeader(node) {
  const task = node.task;
  const statusClass = taskStatusClass(task.status);
  const statusLabel = taskStatusLabel(task.status);
  const progress = clampTaskProgressValue(task?.progress ?? 0);
  const shortTaskId = formatTaskShortId(task.id);
  const avatarLabel = shortTaskId.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "TASK";
  const sessionCount = countVisibleCockpitTaskRows(node);
  const subtaskCount = countVisibleCockpitTaskDescendants(node);
  const summary = shorten(summarizeTaskCardCopy(task) || describeTaskRuntimeStatus(task), 132);
  const eyebrow = [
    `task ${shortTaskId}`,
    `${sessionCount} ${sessionCount === 1 ? "sessao" : "sessoes"}`,
    subtaskCount ? `${subtaskCount} ${subtaskCount === 1 ? "subtask" : "subtasks"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `
    <div class="ravi-wa-nav-row ravi-wa-nav-row--task ravi-wa-nav-group__head ravi-wa-nav-group__head--${statusClass}">
      <span class="ravi-wa-nav-row__avatar">${escapeHtml(avatarLabel)}</span>
      <span class="ravi-wa-nav-row__body">
        <span class="ravi-wa-nav-row__eyebrow">${escapeHtml(eyebrow)}</span>
        <span class="ravi-wa-nav-row__titleline">
          <strong>${escapeHtml(task.title || task.id)}</strong>
        </span>
        <span class="ravi-wa-nav-row__subline">${escapeHtml(summary)}</span>
        <span class="ravi-wa-nav-row__progress">
          <span class="ravi-wa-nav-row__progress-label">${escapeHtml(String(progress))}%</span>
          <span class="ravi-wa-nav-row__progress-bar" aria-hidden="true"><span style="width: ${progress}%"></span></span>
        </span>
      </span>
      <span class="ravi-wa-nav-row__aside">
        <span class="ravi-wa-nav-row__elapsed">${escapeHtml(formatTaskElapsed(task))}</span>
        <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${statusClass}">${escapeHtml(statusLabel)}</span>
      </span>
    </div>
  `;
}

function renderCockpitTaskGroupBranchHeader(node, parentTask) {
  const task = node.task;
  const statusClass = taskStatusClass(task.status);
  const shortTaskId = formatTaskShortId(task.id);
  const visibleSessions = countVisibleCockpitTaskRows(node);
  const title = buildGroupedTaskAwareTitle(null, task, parentTask, "task");
  const summary = shorten(summarizeTaskCardCopy(task) || describeTaskRuntimeStatus(task), 108);
  const eyebrow = [`subtask ${shortTaskId}`, `${visibleSessions} ${visibleSessions === 1 ? "sessao" : "sessoes"}`]
    .filter(Boolean)
    .join(" · ");

  return `
    <div class="ravi-wa-nav-group__label ravi-wa-nav-group__label--${statusClass}">
      <span class="ravi-wa-nav-group__label-eyebrow">${escapeHtml(eyebrow)}</span>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(summary)}</span>
    </div>
  `;
}

function buildGroupedTaskAwareTitle(session, task, parentTask, titleMode) {
  if (titleMode === "session") {
    return session?.sessionName || task?.title || task?.id || "task";
  }
  const taskTitle = task?.title || task?.id || session?.sessionName || "task";
  return stripTaskTitlePrefix(taskTitle, parentTask?.title || null) || taskTitle;
}

function buildGroupedTaskAwareEyebrow(session, task, shortTaskId, titleMode) {
  const priority = task?.priority && task.priority !== "normal" ? `priority ${task.priority}` : null;
  if (titleMode === "session") {
    return [`task ${shortTaskId}`, priority].filter(Boolean).join(" · ");
  }
  return [`subtask ${shortTaskId}`, priority].filter(Boolean).join(" · ");
}

function buildGroupedTaskAwareSessionMeta(session, linkedChat, titleMode) {
  const location = linkedChat ? `chat ${shorten(linkedChat, 24)}` : session.channel ? `canal ${session.channel}` : "sem chat vinculado";
  if (titleMode === "session") {
    return [session.agentId ? `agent ${session.agentId}` : null, location].filter(Boolean).join(" · ");
  }
  return [`session ${session.sessionName}`, session.agentId ? `agent ${session.agentId}` : null, location]
    .filter(Boolean)
    .join(" · ");
}

function stripTaskTitlePrefix(taskTitle, parentTaskTitle) {
  const child = typeof taskTitle === "string" ? taskTitle.trim() : "";
  const parent = typeof parentTaskTitle === "string" ? parentTaskTitle.trim() : "";
  if (!child || !parent) return child;

  const prefixPattern = new RegExp(`^${escapeRegexToken(parent)}(?:\\s*[:/|\\-–—>]+\\s*)?`, "i");
  const stripped = child.replace(prefixPattern, "").trim();
  return stripped || child;
}

function escapeRegexToken(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countVisibleCockpitTaskRows(node) {
  if (!node) return 0;
  return (Array.isArray(node.rows) ? node.rows.length : 0) + (Array.isArray(node.children) ? node.children.reduce((total, child) => total + countVisibleCockpitTaskRows(child), 0) : 0);
}

function countVisibleCockpitTaskDescendants(node) {
  return Array.isArray(node?.children)
    ? node.children.reduce((total, child) => total + 1 + countVisibleCockpitTaskDescendants(child), 0)
    : 0;
}

function shouldRenderCockpitTaskGroup(node) {
  return (Array.isArray(node?.children) ? node.children.length : 0) > 0 || (Array.isArray(node?.rows) ? node.rows.length : 0) > 1;
}

function buildVisibleCockpitTaskNode(node, rowsByTaskId) {
  if (!node?.task?.id) return null;

  const ownRows = (rowsByTaskId.get(node.task.id) || []).slice().sort((left, right) => left.order - right.order);
  const children = (Array.isArray(node.children) ? node.children : [])
    .map((child) => buildVisibleCockpitTaskNode(child, rowsByTaskId))
    .filter(Boolean)
    .sort((left, right) => left.order - right.order);

  if (!ownRows.length && !children.length) {
    return null;
  }

  return {
    task: node.task,
    rows: ownRows,
    children,
    order: Math.min(ownRows[0]?.order ?? Number.POSITIVE_INFINITY, children[0]?.order ?? Number.POSITIVE_INFINITY),
  };
}

function getTaskRootTaskId(taskId, hierarchyState) {
  let currentTaskId = taskId;
  let parentTaskId = hierarchyState.parentByTaskId.get(currentTaskId) || null;

  while (parentTaskId) {
    currentTaskId = parentTaskId;
    parentTaskId = hierarchyState.parentByTaskId.get(currentTaskId) || null;
  }

  return currentTaskId;
}

function taskStatusClass(status) {
  switch (status) {
    case "dispatched":
      return "thinking";
    case "in_progress":
      return "streaming";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

function taskStatusLabel(status) {
  switch (status) {
    case "in_progress":
      return "working";
    case "dispatched":
      return "queued";
    default:
      return status || "open";
  }
}

function formatTaskElapsed(task) {
  const duration = formatTaskDurationValue(task);
  if (duration) return duration;

  switch (task?.status) {
    case "dispatched":
      return "na fila";
    case "open":
      return "nao iniciada";
    default:
      return "sem duracao";
  }
}

function formatTaskWorktree(worktree) {
  if (!worktree) return null;
  if (worktree.mode === "inherit") return "inherit";
  if (!worktree.path) return "path";
  return worktree.branch ? `${worktree.path} (${worktree.branch})` : worktree.path;
}

function getTaskWorktreeLabel(task) {
  return formatTaskWorktree(task?.worktree || null);
}

function formatTaskShortId(taskId) {
  if (typeof taskId !== "string" || !taskId.trim()) return "-";
  const normalized = taskId.trim().replace(/^task-/, "");
  return normalized.length > 10 ? normalized.slice(0, 10) : normalized;
}

function toPositiveTaskTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function getTaskDurationStartTimestamp(task) {
  const sharedStart = globalThis.RaviWaOverlayTaskDuration?.getTaskDurationStartTimestamp?.(task);
  if (typeof sharedStart === "number" && Number.isFinite(sharedStart) && sharedStart > 0) {
    return sharedStart;
  }

  return (
    toPositiveTaskTimestamp(task?.dispatchedAt) ??
    toPositiveTaskTimestamp(task?.createdAt) ??
    toPositiveTaskTimestamp(task?.startedAt)
  );
}

function getTaskDurationEndTimestamp(task) {
  const sharedEnd = globalThis.RaviWaOverlayTaskDuration?.getTaskDurationEndTimestamp?.(task);
  if (typeof sharedEnd === "number" && Number.isFinite(sharedEnd) && sharedEnd > 0) {
    return sharedEnd;
  }

  const status = task?.status || null;
  if (status === "dispatched" || status === "in_progress") {
    return Date.now();
  }

  if (status === "done" || status === "failed") {
    return toPositiveTaskTimestamp(task?.completedAt) ?? toPositiveTaskTimestamp(task?.updatedAt);
  }

  if (status === "blocked") {
    return toPositiveTaskTimestamp(task?.updatedAt);
  }

  return null;
}

function getTaskDurationMs(task) {
  const sharedDuration = globalThis.RaviWaOverlayTaskDuration?.getTaskDurationMs?.(task);
  if (typeof sharedDuration === "number" && Number.isFinite(sharedDuration) && sharedDuration >= 0) {
    return sharedDuration;
  }

  const startedAt = getTaskDurationStartTimestamp(task);
  if (startedAt === null) return null;

  const endedAt = getTaskDurationEndTimestamp(task);
  if (endedAt === null || endedAt < startedAt) {
    return null;
  }

  return Math.max(0, endedAt - startedAt);
}

function formatTaskDurationValue(task) {
  const durationMs = getTaskDurationMs(task);
  if (typeof durationMs !== "number") return null;
  return formatDurationCompactMs(durationMs);
}

function formatTaskDurationLabel(task) {
  const duration = formatTaskDurationValue(task);
  if (duration) return `duration ${duration}`;

  switch (task?.status) {
    case "dispatched":
      return "aguarda start";
    case "open":
      return "nao iniciada";
    default:
      return "sem duracao";
  }
}

function clampTaskProgressValue(value) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function formatTaskProgressLabel(value) {
  return `${clampTaskProgressValue(value)}%`;
}

function normalizeTaskMessage(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function findLatestTaskProgressEvent(events) {
  const list = Array.isArray(events) ? events : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (event?.type === "task.progress") {
      return event;
    }
  }
  return null;
}

function describeTaskProgressState(task) {
  const progress = clampTaskProgressValue(task?.progress ?? 0);
  const progressLabel = `${progress}%`;

  switch (task?.status) {
    case "open":
      return progress > 0 ? `progresso inicial marcado em ${progressLabel}.` : "sem progresso reportado ainda.";
    case "dispatched":
      return progress > 0 ? `na fila com ${progressLabel} ja sincronizados.` : "na fila, aguardando o primeiro report.";
    case "in_progress":
      return progress > 0 ? `progresso sincronizado em ${progressLabel}.` : "trabalho iniciado, aguardando o primeiro report.";
    case "blocked":
      return progress > 0 ? `task bloqueada em ${progressLabel}.` : "task bloqueada antes do primeiro report.";
    case "done":
      return `task concluida com ${progressLabel}.`;
    case "failed":
      return progress > 0 ? `task falhou em ${progressLabel}.` : "task falhou antes do progresso andar.";
    default:
      return `progresso atual ${progressLabel}.`;
  }
}

function describeTaskProgressText(task, events) {
  const latestProgressEvent = findLatestTaskProgressEvent(events);
  const message = normalizeTaskMessage(latestProgressEvent?.message);
  if (message) {
    return { text: message, fallback: false };
  }

  if (latestProgressEvent) {
    const progressLabel =
      typeof latestProgressEvent.progress === "number"
        ? formatTaskProgressLabel(latestProgressEvent.progress)
        : formatTaskProgressLabel(task?.progress ?? 0);
    return {
      text: `progresso atualizado para ${progressLabel} sem nota textual.`,
      fallback: true,
    };
  }

  return {
    text: describeTaskProgressState(task),
    fallback: true,
  };
}

function describeTaskEventBody(event) {
  const message = normalizeTaskMessage(event?.message);
  if (message) {
    return { text: message, fallback: false };
  }

  const progressLabel = typeof event?.progress === "number" ? formatTaskProgressLabel(event.progress) : null;
  switch (event?.type) {
    case "task.created":
      return {
        text: progressLabel ? `task criada com progresso inicial em ${progressLabel}.` : "task criada no runtime.",
        fallback: true,
      };
    case "task.dispatched":
      return {
        text: "task despachada para o worker responsavel.",
        fallback: true,
      };
    case "task.progress":
      return {
        text: progressLabel
          ? `progresso atualizado para ${progressLabel} sem nota textual.`
          : "progresso atualizado no runtime sem nota textual.",
        fallback: true,
      };
    case "task.checkpoint.missed":
      return {
        text: progressLabel
          ? `checkpoint vencido com progresso em ${progressLabel}.`
          : "checkpoint vencido para esta task.",
        fallback: true,
      };
    case "task.blocked":
      return {
        text: progressLabel ? `task marcada como bloqueada em ${progressLabel}.` : "task marcada como bloqueada no runtime.",
        fallback: true,
      };
    case "task.done":
      return {
        text: progressLabel ? `task marcada como concluida em ${progressLabel}.` : "task marcada como concluida no runtime.",
        fallback: true,
      };
    case "task.failed":
      return {
        text: progressLabel ? `task marcada como falha em ${progressLabel}.` : "task marcada como falha no runtime.",
        fallback: true,
      };
    case "task.child.blocked":
      return {
        text: "child task marcada como bloqueada.",
        fallback: true,
      };
    case "task.child.done":
      return {
        text: "child task marcada como concluida.",
        fallback: true,
      };
    case "task.child.failed":
      return {
        text: "child task marcada como falha.",
        fallback: true,
      };
    default:
      return {
        text: "evento registrado no runtime.",
        fallback: true,
      };
  }
}

function taskPriorityClass(priority) {
  switch (priority) {
    case "urgent":
      return "urgent";
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "normal";
  }
}

function buildTasksWorkspaceSubtitle(snapshot) {
  const stats = snapshot?.stats || null;
  if (!stats) return "kanban do runtime";
  return `open ${stats.open ?? 0} · queued ${stats.dispatched ?? 0} · working ${stats.inProgress ?? 0} · blocked ${stats.blocked ?? 0} · done ${stats.done ?? 0} · failed ${stats.failed ?? 0}`;
}

function parseLocalDateKey(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
    return null;
  }

  return new Date(year, monthIndex, day);
}

function formatTaskActivityDate(value, options) {
  const date = parseLocalDateKey(value);
  if (!date) return value || "-";
  return date.toLocaleDateString(undefined, options);
}

function formatTaskActivityShortDate(value) {
  return formatTaskActivityDate(value, { day: "numeric", month: "short" });
}

function formatTaskActivityLongDate(value) {
  return formatTaskActivityDate(value, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function formatTaskActivityPeriodLabel(activity) {
  if (!activity?.startDate || !activity?.endDate) {
    return "ultimo recorte do runtime";
  }

  return `${formatTaskActivityShortDate(activity.startDate)} - ${formatTaskActivityShortDate(activity.endDate)}`;
}

function formatTaskActivityStreak(value) {
  const days = Math.max(0, Number(value) || 0);
  return `${days} ${days === 1 ? "dia" : "dias"}`;
}

function resolveTaskActivityIntensity(doneCount, maxDoneCount) {
  const count = Number(doneCount) || 0;
  const max = Number(maxDoneCount) || 0;
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((count / max) * 4)));
}

function formatTaskActivityTooltip(bucket) {
  const doneCount = Math.max(0, Number(bucket?.doneCount) || 0);
  const failedCount = Math.max(0, Number(bucket?.failedCount) || 0);
  const parts = [
    formatTaskActivityLongDate(bucket?.date || ""),
    `${doneCount} ${doneCount === 1 ? "task concluida" : "tasks concluidas"}`,
  ];

  if (failedCount > 0) {
    parts.push(`${failedCount} ${failedCount === 1 ? "falha terminal" : "falhas terminais"}`);
  }

  return parts.join(" · ");
}

function renderTasksDailyActivityCard(activity) {
  const buckets = Array.isArray(activity?.buckets) ? activity.buckets : [];
  const totalDoneCount = Math.max(0, Number(activity?.totalDoneCount) || 0);
  const maxDoneCount = Math.max(0, Number(activity?.maxDoneCount) || 0);
  const bestDay = activity?.bestDay || null;
  const legendLevels = [0, 1, 2, 3, 4];
  const timeZoneLabel = activity?.timeZone ? ` · ${activity.timeZone}` : "";
  const daysLabel = Math.max(0, Number(activity?.days) || buckets.length || 84);

  return `
    <section class="ravi-wa-card ravi-wa-tasks-activity">
      <div class="ravi-wa-tasks-activity__head">
        <div class="ravi-wa-tasks-activity__copy">
          <span class="ravi-wa-tasks-activity__eyebrow">daily activity</span>
          <div>
            <h3>Done heatmap</h3>
            <p>${escapeHtml(`ultimos ${daysLabel} dias por completedAt local${timeZoneLabel}.`)}</p>
          </div>
        </div>
        <div class="ravi-wa-tasks-activity__summary">
          <article class="ravi-wa-tasks-activity__stat">
            <span>total no periodo</span>
            <strong>${escapeHtml(String(totalDoneCount))}</strong>
            <small>${escapeHtml(formatTaskActivityPeriodLabel(activity))}</small>
          </article>
          <article class="ravi-wa-tasks-activity__stat">
            <span>melhor dia</span>
            <strong>${escapeHtml(bestDay ? String(bestDay.doneCount) : "-")}</strong>
            <small>${escapeHtml(bestDay ? formatTaskActivityShortDate(bestDay.date) : "sem concluidas")}</small>
          </article>
          <article class="ravi-wa-tasks-activity__stat">
            <span>streak atual</span>
            <strong>${escapeHtml(formatTaskActivityStreak(activity?.currentStreak))}</strong>
            <small>${escapeHtml(`${activity?.activeDays ?? 0} dias ativos`)}</small>
          </article>
        </div>
      </div>
      <div class="ravi-wa-tasks-activity__grid-wrap">
        <div class="ravi-wa-tasks-activity__grid" aria-label="${escapeAttribute(`Heatmap de tasks concluidas nos ultimos ${daysLabel} dias`)}}">
          ${buckets
            .map((bucket) => {
              const intensity = resolveTaskActivityIntensity(bucket?.doneCount, maxDoneCount);
              return `
                <span
                  class="ravi-wa-tasks-activity__cell ravi-wa-tasks-activity__cell--lv${intensity}"
                  title="${escapeAttribute(formatTaskActivityTooltip(bucket))}"
                  data-date="${escapeAttribute(bucket?.date || "")}"
                  data-count="${escapeAttribute(String(bucket?.doneCount ?? 0))}"
                ></span>
              `;
            })
            .join("")}
        </div>
      </div>
      <div class="ravi-wa-tasks-activity__legend">
        ${
          totalDoneCount > 0
            ? `
          <span>menos</span>
          <div class="ravi-wa-tasks-activity__legend-scale">
            ${legendLevels
              .map(
                (level) => `
              <span class="ravi-wa-tasks-activity__cell ravi-wa-tasks-activity__cell--lv${level}" aria-hidden="true"></span>
            `,
              )
              .join("")}
          </div>
          <span>mais</span>
        `
            : `
          <div class="ravi-wa-tasks-activity__empty">
            <strong>Sem concluicoes recentes</strong>
            <p>O runtime ainda nao registrou tasks concluídas nesse recorte.</p>
          </div>
        `
        }
      </div>
    </section>
  `;
}

function summarizeTaskCardCopy(task) {
  const value = task?.summary || task?.blockerReason || task?.instructions || "";
  return shorten(String(value).replace(/\s+/g, " ").trim(), 96);
}

function buildTaskAssigneeLabel(task, activeAssignment = null) {
  const agentId = activeAssignment?.agentId || task?.assigneeAgentId || null;
  const sessionName = activeAssignment?.sessionName || task?.assigneeSessionName || null;
  return agentId || sessionName || null;
}

function describeTaskStatus(status, signal = null, assigneeLabel = null) {
  switch (status) {
    case "open":
      return "ready in runtime, awaiting dispatch";
    case "dispatched":
      return assigneeLabel ? `queued for ${assigneeLabel}` : "dispatch recorded, waiting for work to start";
    case "in_progress":
      return assigneeLabel ? `running with ${assigneeLabel}` : "work started in runtime";
    case "blocked":
      return signal || "blocked until a new report or unblock";
    case "done":
      return signal || "completed in runtime";
    case "failed":
      return signal || "ended with failure in runtime";
    default:
      return "status unavailable";
  }
}

function describeTaskRuntimeStatus(task, activeAssignment = null) {
  return describeTaskStatus(task?.status, task?.blockerReason || task?.summary || null, buildTaskAssigneeLabel(task, activeAssignment));
}

function describeTaskDocumentStatus(frontmatter) {
  if (!frontmatter) {
    return "TASK.md is not available in the overlay snapshot";
  }

  if (frontmatter.status) {
    return describeTaskStatus(frontmatter.status, frontmatter.blockerReason || frontmatter.summary || null, null);
  }

  return frontmatter.blockerReason || frontmatter.summary || "TASK.md found without status fields in frontmatter";
}

function renderTaskStatusPanel({ eyebrow, status, title, detail, meta }) {
  const hasStatus = typeof status === "string" && status;
  const statusClass = hasStatus ? taskStatusClass(status) : "idle";
  const statusLabel = hasStatus ? taskStatusLabel(status) : "n/a";

  return `
    <article class="ravi-wa-task-status-panel ravi-wa-task-status-panel--${statusClass}">
      <div class="ravi-wa-task-status-panel__head">
        <span class="ravi-wa-task-status-panel__eyebrow">${escapeHtml(eyebrow)}</span>
        <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${statusClass}">${escapeHtml(statusLabel)}</span>
      </div>
      <strong class="ravi-wa-task-status-panel__title">${escapeHtml(title)}</strong>
      ${detail ? `<p class="ravi-wa-task-status-panel__detail">${escapeHtml(detail)}</p>` : ""}
      ${meta ? `<span class="ravi-wa-task-status-panel__meta">${escapeHtml(meta)}</span>` : ""}
    </article>
  `;
}

function renderTaskStatusSyncBanner(task, frontmatter, progress) {
  if (!frontmatter) {
    return `
      <div class="ravi-wa-task-status-sync ravi-wa-task-status-sync--idle">
        <strong>status sync</strong>
        <p>runtime visible no overlay, mas o frontmatter do TASK.md ainda nao apareceu nesse snapshot.</p>
      </div>
    `;
  }

  const hasComparableFrontmatter = Boolean(frontmatter.status) || typeof frontmatter.progress === "number";
  if (!hasComparableFrontmatter) {
    return `
      <div class="ravi-wa-task-status-sync ravi-wa-task-status-sync--idle">
        <strong>status sync</strong>
        <p>TASK.md presente, mas sem campos de status ou progresso no frontmatter para comparar com o runtime.</p>
      </div>
    `;
  }

  const issues = [];
  if (frontmatter.status && frontmatter.status !== task.status) {
    issues.push(`runtime ${taskStatusLabel(task.status)} (${task.status}) vs TASK.md ${taskStatusLabel(frontmatter.status)} (${frontmatter.status})`);
  }
  if (typeof frontmatter.progress === "number" && frontmatter.progress !== progress) {
    issues.push(`runtime ${progress}% vs TASK.md ${frontmatter.progress}%`);
  }

  if (!issues.length) {
    return `
      <div class="ravi-wa-task-status-sync ravi-wa-task-status-sync--done">
        <strong>status sync</strong>
        <p>runtime e frontmatter do TASK.md estao alinhados no snapshot atual.</p>
      </div>
    `;
  }

  return `
    <div class="ravi-wa-task-status-sync ravi-wa-task-status-sync--blocked">
      <strong>status sync</strong>
      <p>${escapeHtml(issues.join(" · "))}</p>
    </div>
  `;
}

function formatTaskActorLabel(actor, agentId, sessionName) {
  const actorValue = typeof actor === "string" ? actor.trim() : "";
  const agentValue = typeof agentId === "string" ? agentId.trim() : "";
  const sessionValue = typeof sessionName === "string" ? sessionName.trim() : "";
  const ordered = actorValue && actorValue === sessionValue ? [agentValue, actorValue, sessionValue] : [actorValue, agentValue, sessionValue];
  const values = [];
  for (const value of ordered) {
    if (!value || values.includes(value)) continue;
    values.push(value);
  }
  return values.join(" · ") || "-";
}

function renderTaskFactGrid(items) {
  const rows = Array.isArray(items)
    ? items.filter((item) => item && item.value !== null && item.value !== undefined && String(item.value).trim())
    : [];

  if (!rows.length) {
    return `<p class="ravi-wa-empty">sem dados extras nesse bloco.</p>`;
  }

  return `
    <dl class="ravi-wa-task-facts">
      ${rows
        .map(
          (item) => `
            <div class="ravi-wa-task-facts__item">
              <dt>${escapeHtml(item.label)}</dt>
              <dd class="ravi-wa-task-facts__value${item.monospace ? " ravi-wa-task-facts__value--mono" : ""}">${escapeHtml(
                String(item.value),
              )}</dd>
            </div>
          `,
        )
        .join("")}
    </dl>
  `;
}

function renderTaskRelationCard(task) {
  if (!task) {
    return `<p class="ravi-wa-empty">nenhuma task relacionada nesse bloco.</p>`;
  }

  const statusClass = taskStatusClass(task.status);
  const summary = summarizeTaskCardCopy(task);
  const progress = Math.max(0, Math.min(100, Number(task?.progress ?? 0) || 0));

  return `
    <button
      type="button"
      class="ravi-wa-task-link"
      data-ravi-focus-task="${escapeAttribute(task.id)}"
      title="${escapeAttribute(`${task.title} · ${task.id}`)}"
    >
      <span class="ravi-wa-task-link__eyebrow">
        <span class="ravi-wa-task-card__id">${escapeHtml(formatTaskShortId(task.id))}</span>
        <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${statusClass}">${escapeHtml(taskStatusLabel(task.status))}</span>
      </span>
      <strong class="ravi-wa-task-link__title">${escapeHtml(task.title || task.id)}</strong>
      ${summary ? `<p class="ravi-wa-task-link__summary">${escapeHtml(summary)}</p>` : ""}
      <span class="ravi-wa-task-link__meta">
        <span>${escapeHtml(task.assigneeAgentId || "-")}</span>
        <span>${escapeHtml(String(progress))}%</span>
        <span>${escapeHtml(formatTaskDurationLabel(task))}</span>
      </span>
    </button>
  `;
}

function renderTaskAssignments(assignments, activeAssignment) {
  const list = Array.isArray(assignments)
    ? [...assignments].sort((left, right) => {
        const leftTime = left?.acceptedAt || left?.completedAt || left?.assignedAt || 0;
        const rightTime = right?.acceptedAt || right?.completedAt || right?.assignedAt || 0;
        return rightTime - leftTime;
      })
    : [];

  if (!list.length) {
    return `<p class="ravi-wa-empty">sem assignments registrados para essa task.</p>`;
  }

  return `
    <div class="ravi-wa-task-assignment-list">
      ${list
        .map((assignment) => {
          const worktreeLabel = formatTaskWorktree(assignment?.worktree || null);
          const isActive = activeAssignment?.id && activeAssignment.id === assignment.id;
          return `
            <article class="ravi-wa-task-assignment${isActive ? " ravi-wa-task-assignment--active" : ""}">
              <div class="ravi-wa-task-assignment__head">
                <div>
                  <strong>${escapeHtml(assignment.agentId || "-")}</strong>
                  <span>${escapeHtml(assignment.sessionName || "-")}</span>
                </div>
                <span class="ravi-wa-meta-chip">${escapeHtml(assignment.status || "assigned")}</span>
              </div>
              <dl class="ravi-wa-task-assignment__facts">
                <div><dt>assigned</dt><dd>${escapeHtml(formatTimestamp(assignment.assignedAt) || "-")}</dd></div>
                <div><dt>accepted</dt><dd>${escapeHtml(formatTimestamp(assignment.acceptedAt) || "-")}</dd></div>
                <div><dt>completed</dt><dd>${escapeHtml(formatTimestamp(assignment.completedAt) || "-")}</dd></div>
                <div><dt>by</dt><dd>${escapeHtml(assignment.assignedBy || "-")}</dd></div>
                ${worktreeLabel ? `<div><dt>worktree</dt><dd>${escapeHtml(worktreeLabel)}</dd></div>` : ""}
              </dl>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderTaskComments(comments) {
  const list = Array.isArray(comments) ? comments.slice(-8).reverse() : [];
  if (!list.length) {
    return `<p class="ravi-wa-empty">sem comentarios nessa task ainda.</p>`;
  }

  return `
    <div class="ravi-wa-task-activity-list">
      ${list
        .map((comment) => {
          const authorLabel = formatTaskActorLabel(comment.author, comment.authorAgentId, comment.authorSessionName);
          return `
            <article class="ravi-wa-task-activity">
              <div class="ravi-wa-task-activity__meta">
                <strong>${escapeHtml(authorLabel)}</strong>
                <span>${escapeHtml(formatTimestamp(comment.createdAt) || "-")}</span>
              </div>
              <div class="ravi-wa-task-activity__body">${escapeHtml(comment.body || "")}</div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderTasksWorkspace(body) {
  const snapshot = latestTasksSnapshot;
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  const taskRoots = buildTaskHierarchy(items);
  const stats = snapshot?.stats || null;
  const dailyActivity = snapshot?.dailyActivity || null;
  const selectedTask = snapshot?.selectedTask || null;
  const selectedTaskKey = selectedTask?.task?.id || snapshot?.query?.taskId || selectedTaskId || null;

  body.innerHTML = `
    <div class="ravi-wa-tasks-page">
      <section class="ravi-wa-tasks-hero">
        <div class="ravi-wa-tasks-hero__copy">
          <span class="ravi-wa-tasks-hero__eyebrow">runtime real</span>
          <h2>Tasks</h2>
          <p>kanban por status em cima do snapshot do runtime atual, sem backend paralelo.</p>
        </div>
        <div class="ravi-wa-chip-row">
          <span class="ravi-wa-meta-chip">total ${escapeHtml(String(stats?.total ?? items.length))}</span>
          <span class="ravi-wa-meta-chip">open ${escapeHtml(String(stats?.open ?? 0))}</span>
          <span class="ravi-wa-meta-chip">queued ${escapeHtml(String(stats?.dispatched ?? 0))}</span>
          <span class="ravi-wa-meta-chip">working ${escapeHtml(String(stats?.inProgress ?? 0))}</span>
          <span class="ravi-wa-meta-chip">blocked ${escapeHtml(String(stats?.blocked ?? 0))}</span>
          <span class="ravi-wa-meta-chip">done ${escapeHtml(String(stats?.done ?? 0))}</span>
          <span class="ravi-wa-meta-chip">failed ${escapeHtml(String(stats?.failed ?? 0))}</span>
        </div>
      </section>
      ${
        sidebarNotice
          ? `
        <section class="ravi-wa-card ravi-wa-notice ravi-wa-notice--${escapeAttribute(sidebarNotice.kind || "info")}">
          <p>${escapeHtml(sidebarNotice.message || "")}</p>
        </section>
      `
          : ""
      }
      ${renderTasksDailyActivityCard(dailyActivity)}
      <div class="ravi-wa-tasks-layout">
        <div class="ravi-wa-task-board-wrap">
          <div class="ravi-wa-task-board">
            ${TASK_KANBAN_COLUMNS.map((column) =>
              renderTaskKanbanColumn(
                column,
                taskRoots.filter((node) => column.statuses.includes(node.task.status)),
                selectedTaskKey,
              ),
            ).join("")}
          </div>
        </div>
        <aside class="ravi-wa-task-detail-pane">
          ${renderTaskDetailCard(selectedTask)}
        </aside>
      </div>
    </div>
  `;

  body.querySelectorAll("[data-ravi-focus-task]").forEach((button) => {
    button.addEventListener("click", async () => {
      const taskId = button.getAttribute("data-ravi-focus-task");
      if (!taskId) return;
      selectedTaskId = taskId;
      persistSelectedTaskId(taskId);
      await refreshTasks(true);
    });
  });
}

function getTaskHierarchyState(snapshot = latestTasksSnapshot) {
  if (!snapshot) {
    lastTaskHierarchySnapshot = snapshot;
    lastTaskHierarchyState = { roots: [], nodes: new Map(), parentByTaskId: new Map() };
    return lastTaskHierarchyState;
  }

  if (snapshot === lastTaskHierarchySnapshot) {
    return lastTaskHierarchyState;
  }

  lastTaskHierarchySnapshot = snapshot;
  lastTaskHierarchyState = createTaskHierarchyState(snapshot?.items);
  return lastTaskHierarchyState;
}

function createTaskHierarchyState(items) {
  const list = Array.isArray(items) ? [...items].sort(compareTaskCreatedAtAsc) : [];
  const nodes = new Map(list.map((task) => [task.id, { task, children: [] }]));
  const roots = [];
  const parentByTaskId = new Map();

  list.forEach((task) => {
    const node = nodes.get(task.id);
    if (!node) return;

    const parentNode = task?.parentTaskId ? nodes.get(task.parentTaskId) : null;
    if (parentNode) {
      parentByTaskId.set(task.id, parentNode.task.id);
      parentNode.children.push(node);
      return;
    }

    roots.push(node);
  });

  return { roots, nodes, parentByTaskId };
}

function buildTaskHierarchy(items) {
  return createTaskHierarchyState(items).roots;
}

function getTaskLineage(taskId, hierarchyState = getTaskHierarchyState()) {
  const lineage = [];
  let currentTaskId = taskId;

  while (currentTaskId) {
    const node = hierarchyState.nodes.get(currentTaskId);
    if (node?.task) {
      lineage.unshift(node.task);
    }
    currentTaskId = hierarchyState.parentByTaskId.get(currentTaskId) || null;
  }

  return lineage;
}

function countTaskTreeNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).reduce(
    (total, node) => total + 1 + countTaskTreeNodes(Array.isArray(node?.children) ? node.children : []),
    0,
  );
}

function compareTaskCreatedAtAsc(left, right) {
  return (
    (Number(left?.createdAt) || 0) - (Number(right?.createdAt) || 0) ||
    (Number(left?.updatedAt) || 0) - (Number(right?.updatedAt) || 0) ||
    String(left?.id || "").localeCompare(String(right?.id || ""))
  );
}

function renderTaskKanbanColumn(column, nodes, currentTaskId) {
  const list = Array.isArray(nodes) ? nodes : [];
  const visibleCount = countTaskTreeNodes(list);
  return `
    <section class="ravi-wa-task-column">
      <div class="ravi-wa-task-column__head">
        <div class="ravi-wa-task-column__copy">
          <strong>${escapeHtml(column.label)}</strong>
          <span>${escapeHtml(String(visibleCount))} item${visibleCount === 1 ? "" : "s"} em ${escapeHtml(String(list.length))} grupo${list.length === 1 ? "" : "s"}</span>
        </div>
        <div class="ravi-wa-task-column__legend">
          ${column.statuses
            .map(
              (status) => `
                <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${taskStatusClass(status)}">${escapeHtml(taskStatusLabel(status))}</span>
              `,
            )
            .join("")}
        </div>
      </div>
      <div class="ravi-wa-task-column__list">
        ${
          list.length
            ? list.map((node) => renderTaskCard(node, currentTaskId)).join("")
            : `<p class="ravi-wa-task-column__empty">nenhuma task nesse status agora.</p>`
        }
      </div>
    </section>
  `;
}

function renderTaskCard(node, currentTaskId) {
  const task = node?.task || null;
  const childNodes = Array.isArray(node?.children) ? node.children : [];
  if (!task) return "";
  const statusClass = taskStatusClass(task.status);
  const statusLabel = taskStatusLabel(task.status);
  const priorityClass = taskPriorityClass(task.priority);
  const selected = currentTaskId && currentTaskId === task.id ? "true" : "false";
  const summary = summarizeTaskCardCopy(task);
  const progress = clampTaskProgressValue(task?.progress ?? 0);
  const progressInfo = describeTaskProgressText(task);
  const statusCopy = shorten(describeTaskRuntimeStatus(task), 86);
  const showSummary = summary && summary.toLowerCase() !== statusCopy.toLowerCase();
  const footerMeta = `${task.assigneeSessionName || "-"} | ${task.assigneeAgentId || "-"}`;

  return `
    <article class="ravi-wa-task-card ravi-wa-task-card--${statusClass}${selected === "true" ? " ravi-wa-task-card--selected" : ""}">
      <button
        type="button"
        class="ravi-wa-task-card__main"
        data-ravi-focus-task="${escapeAttribute(task.id)}"
        aria-pressed="${selected}"
        title="${escapeAttribute(`${task.title} · ${task.id}`)}"
      >
        <span class="ravi-wa-task-card__eyebrow">
          <span class="ravi-wa-task-card__id">${escapeHtml(formatTaskShortId(task.id))}</span>
          <span class="ravi-wa-task-card__eyebrow-aside">
            <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${statusClass}">${escapeHtml(statusLabel)}</span>
            <span class="ravi-wa-task-card__priority ravi-wa-task-card__priority--${priorityClass}">${escapeHtml(task.priority || "normal")}</span>
          </span>
        </span>
        <strong class="ravi-wa-task-card__title">${escapeHtml(task.title || task.id)}</strong>
        <div class="ravi-wa-task-card__status">
          <span class="ravi-wa-task-card__status-label">runtime status</span>
          <p>${escapeHtml(statusCopy)}</p>
        </div>
        ${showSummary ? `<p class="ravi-wa-task-card__summary">${escapeHtml(summary)}</p>` : ""}
        <div class="ravi-wa-task-card__progress">
          <div class="ravi-wa-task-card__progress-copy">
            <span class="ravi-wa-task-card__progress-label">progress ${escapeHtml(String(progress))}%</span>
            <p>${escapeHtml(shorten(progressInfo.text, 84))}</p>
          </div>
          <span class="ravi-wa-task-card__progress-time">${escapeHtml(formatTaskDurationLabel(task))}</span>
        </div>
        <div class="ravi-wa-task-card__bar" aria-hidden="true">
          <span style="width: ${progress}%"></span>
        </div>
        <div class="ravi-wa-task-card__meta">
          <span>${escapeHtml(footerMeta)}</span>
        </div>
      </button>
      ${
        childNodes.length
          ? `<div class="ravi-wa-task-card__children">${childNodes
              .map((childNode) => renderTaskChildCard(childNode, currentTaskId))
              .join("")}</div>`
          : ""
      }
    </article>
  `;
}

function renderTaskChildCard(node, currentTaskId, depth = 1) {
  const task = node?.task || null;
  if (!task) return "";

  const childNodes = Array.isArray(node?.children) ? node.children : [];
  const selected = currentTaskId && currentTaskId === task.id ? "true" : "false";
  const statusClass = taskStatusClass(task.status);
  const progress = clampTaskProgressValue(task?.progress ?? 0);
  const summary = summarizeTaskCardCopy(task) || describeTaskRuntimeStatus(task);

  return `
    <div class="ravi-wa-task-child-wrap${depth > 1 ? " ravi-wa-task-child-wrap--nested" : ""}">
      <button
        type="button"
        class="ravi-wa-task-child ravi-wa-task-child--${statusClass}${selected === "true" ? " ravi-wa-task-child--selected" : ""}"
        data-ravi-focus-task="${escapeAttribute(task.id)}"
        aria-pressed="${selected}"
        title="${escapeAttribute(`${task.title} · ${task.id}`)}"
      >
        <span class="ravi-wa-task-child__titleline">
          <strong>${escapeHtml(task.title || task.id)}</strong>
          <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${statusClass}">${escapeHtml(taskStatusLabel(task.status))}</span>
        </span>
        <span class="ravi-wa-task-child__summary">${escapeHtml(shorten(summary, 96))}</span>
        <span class="ravi-wa-task-child__progress">
          <span class="ravi-wa-task-child__progress-label">${escapeHtml(String(progress))}%</span>
          <span class="ravi-wa-task-child__progress-bar" aria-hidden="true"><span style="width: ${progress}%"></span></span>
        </span>
      </button>
      ${
        childNodes.length
          ? `<div class="ravi-wa-task-child__children">${childNodes
              .map((childNode) => renderTaskChildCard(childNode, currentTaskId, depth + 1))
              .join("")}</div>`
          : ""
      }
    </div>
  `;
}

function renderTaskEvents(events) {
  const list = Array.isArray(events)
    ? events
        .filter((event) => event?.type !== "task.comment")
        .slice(-12)
        .reverse()
    : [];
  if (!list.length) {
    return `<p class="ravi-wa-empty">sem eventos de lifecycle dessa task ainda.</p>`;
  }

  return `
    <div class="ravi-wa-task-activity-list">
      ${list
        .map((event) => {
          const kind = taskStatusClass(
            event.type === "task.blocked"
              ? "blocked"
              : event.type === "task.done"
                ? "done"
                : event.type === "task.failed"
                  ? "failed"
                  : event.type === "task.progress"
                    ? "in_progress"
                    : "dispatched",
          );
          const label = typeof event.type === "string" ? event.type.replace("task.", "") : "event";
          const detail = describeTaskEventBody(event);
          const actorLabel = formatTaskActorLabel(event.actor, event.agentId, event.sessionName);
          const progress = typeof event.progress === "number" ? formatTaskProgressLabel(event.progress) : null;
          return `
            <article class="ravi-wa-task-activity ravi-wa-task-activity--${kind}">
              <div class="ravi-wa-task-activity__meta">
                <span class="ravi-wa-nav-row__state ravi-wa-nav-row__state--${kind}">${escapeHtml(label)}</span>
                <strong>${escapeHtml(actorLabel)}</strong>
                <span>${escapeHtml(formatTimestamp(event.createdAt) || "-")}</span>
                ${progress ? `<span>${escapeHtml(progress)}</span>` : ""}
              </div>
              <div class="ravi-wa-task-activity__body${detail.fallback ? " ravi-wa-task-activity__body--fallback" : ""}">${escapeHtml(detail.text)}</div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderTaskDetailCard(selectedTask) {
  const task = selectedTask?.task || null;
  if (!task) {
    return `
      <section class="ravi-wa-card ravi-wa-task-detail-pane__empty">
        <p>seleciona uma task para ver detalhes e timeline sem sair do workspace.</p>
      </section>
    `;
  }

  const activeAssignment = selectedTask?.activeAssignment || null;
  const assignments = Array.isArray(selectedTask?.assignments) ? selectedTask.assignments : [];
  const parentTask = selectedTask?.parentTask || null;
  const childTasks = Array.isArray(selectedTask?.childTasks) ? selectedTask.childTasks : [];
  const comments = Array.isArray(selectedTask?.comments) ? selectedTask.comments : [];
  const lifecycleEvents = Array.isArray(selectedTask?.events)
    ? selectedTask.events.filter((event) => event?.type !== "task.comment")
    : [];
  const taskDocument = selectedTask?.taskDocument || null;
  const frontmatter = taskDocument?.frontmatter || null;
  const worktreeLabel = getTaskWorktreeLabel(task);
  const statusClass = taskStatusClass(task.status);
  const progress = clampTaskProgressValue(task?.progress ?? 0);
  const progressInfo = describeTaskProgressText(task, lifecycleEvents);
  const frontmatterStatus = frontmatter?.status || null;
  const frontmatterProgress = typeof frontmatter?.progress === "number" ? frontmatter.progress : null;
  const docPath = taskDocument?.path || (task.taskDir ? `${task.taskDir}/TASK.md` : null);
  const taskDir = taskDocument?.taskDir || task.taskDir || null;
  const frontmatterChips = [
    frontmatter?.priority ? `fm priority ${frontmatter.priority}` : null,
    frontmatter?.summary ? `fm summary ${shorten(frontmatter.summary, 48)}` : null,
    frontmatter?.blockerReason ? `fm blocker ${shorten(frontmatter.blockerReason, 48)}` : null,
  ].filter(Boolean);
  const heroSummary = task.summary || task.blockerReason || summarizeTaskCardCopy(task) || "sem resumo ainda";
  const taskSignal = task.blockerReason || task.summary || null;
  const taskSignalLabel = task.blockerReason ? "blocker" : "summary";
  const taskSignalClass = task.blockerReason ? "blocked" : "summary";
  const runtimeStatusTitle = describeTaskRuntimeStatus(task, activeAssignment);
  const documentStatusTitle = describeTaskDocumentStatus(frontmatter);
  const runtimeFacts = [
    {
      label: "created by",
      value: formatTaskActorLabel(task.createdBy, task.createdByAgentId, task.createdBySessionName),
    },
    {
      label: "active assignment",
      value: activeAssignment
        ? `${activeAssignment.status} · ${formatTaskActorLabel(null, activeAssignment.agentId, activeAssignment.sessionName)}`
        : "none",
    },
    { label: "duration", value: formatTaskElapsed(task) },
    { label: "updated at", value: formatTimestamp(task.updatedAt) || "-" },
    { label: "created at", value: formatTimestamp(task.createdAt) || "-" },
    { label: "dispatched at", value: formatTimestamp(task.dispatchedAt) || "-" },
    { label: "started at", value: formatTimestamp(task.startedAt) || "-" },
    { label: "completed at", value: formatTimestamp(task.completedAt) || "-" },
    { label: "worktree", value: worktreeLabel || "-" },
  ];

  return `
    <section class="ravi-wa-card ravi-wa-task-detail-hero-card">
      <div class="ravi-wa-task-detail-hero__eyebrow">
        <span class="ravi-wa-task-detail-hero__label">task detail</span>
        <span class="ravi-wa-task-card__id">${escapeHtml(formatTaskShortId(task.id))}</span>
      </div>
      <div class="ravi-wa-task-detail-hero__top">
        <div class="ravi-wa-task-detail-hero__copy">
          <h3>${escapeHtml(task.title || task.id)}</h3>
          <p>${escapeHtml(heroSummary)}</p>
        </div>
        <div class="ravi-wa-task-detail-hero__status">
          <span class="ravi-wa-state-pill ravi-wa-state-pill--${statusClass}">${escapeHtml(taskStatusLabel(task.status))}</span>
          <span class="ravi-wa-task-detail-hero__progress">${escapeHtml(String(progress))}%</span>
        </div>
      </div>
      <div class="ravi-wa-chip-row">
        <span class="ravi-wa-meta-chip">id ${escapeHtml(task.id)}</span>
        <span class="ravi-wa-meta-chip">priority ${escapeHtml(task.priority || "normal")}</span>
        <span class="ravi-wa-meta-chip">progress ${escapeHtml(String(progress))}%</span>
        <span class="ravi-wa-meta-chip">agent ${escapeHtml(task.assigneeAgentId || activeAssignment?.agentId || "-")}</span>
        <span class="ravi-wa-meta-chip">session ${escapeHtml(activeAssignment?.sessionName || task.assigneeSessionName || "-")}</span>
        <span class="ravi-wa-meta-chip">comments ${escapeHtml(String(comments.length))}</span>
        <span class="ravi-wa-meta-chip">events ${escapeHtml(String(lifecycleEvents.length))}</span>
      </div>
      <div class="ravi-wa-task-detail-progress">
        <div class="ravi-wa-task-detail-progress__head">
          <span>progress ${escapeHtml(String(progress))}%</span>
          <span>${escapeHtml(formatTaskDurationLabel(task))}</span>
        </div>
        <div class="ravi-wa-task-detail-progress__bar" aria-hidden="true">
          <span style="width: ${progress}%"></span>
        </div>
        <p class="ravi-wa-task-detail-progress__copy${progressInfo.fallback ? " ravi-wa-task-detail-progress__copy--fallback" : ""}">
          ${escapeHtml(shorten(progressInfo.text, 160))}
        </p>
      </div>
    </section>

    <section class="ravi-wa-card ravi-wa-task-detail-section">
      <div class="ravi-wa-section-head">
        <h3>status</h3>
        <span>${escapeHtml(frontmatter ? "runtime x TASK.md" : "runtime only")}</span>
      </div>
      <div class="ravi-wa-task-status-grid">
        ${renderTaskStatusPanel({
          eyebrow: "runtime status",
          status: task.status,
          title: runtimeStatusTitle,
          detail: `raw ${task.status} · progress ${progress}%`,
          meta: formatTaskDurationLabel(task),
        })}
        ${renderTaskStatusPanel({
          eyebrow: "TASK.md status",
          status: frontmatterStatus,
          title: documentStatusTitle,
          detail: frontmatter
            ? frontmatterStatus
              ? `frontmatter ${frontmatterStatus}${frontmatterProgress !== null ? ` · ${frontmatterProgress}%` : ""}`
              : frontmatterProgress !== null
                ? `TASK.md progress ${frontmatterProgress}% sem campo de status`
                : "TASK.md presente, mas sem campo de status no frontmatter"
            : "TASK.md ainda nao chegou nesse snapshot",
          meta: taskDocument ? "bridge document snapshot" : "runtime snapshot only",
        })}
      </div>
      ${renderTaskStatusSyncBanner(task, frontmatter, progress)}
    </section>

    ${
      taskSignal
        ? `
      <section class="ravi-wa-card ravi-wa-task-callout ravi-wa-task-callout--${taskSignalClass}">
        <span class="ravi-wa-task-callout__label">${escapeHtml(taskSignalLabel)}</span>
        <p>${escapeHtml(taskSignal)}</p>
      </section>
    `
        : ""
    }

    <section class="ravi-wa-card ravi-wa-task-detail-section">
      <div class="ravi-wa-section-head">
        <h3>runtime</h3>
        <span>${escapeHtml(activeAssignment?.status || "no active assignment")}</span>
      </div>
      ${renderTaskFactGrid(runtimeFacts)}
    </section>

    <section class="ravi-wa-card ravi-wa-task-detail-section">
      <div class="ravi-wa-section-head">
        <h3>task document</h3>
        <span>${escapeHtml(taskDocument ? "TASK.md synced" : "runtime path only")}</span>
      </div>
      ${
        docPath
          ? `<div class="ravi-wa-task-path">${escapeHtml(docPath)}</div>`
          : `<p class="ravi-wa-empty">TASK.md ainda nao foi materializado no runtime.</p>`
      }
      ${
        frontmatterChips.length || taskDir
          ? `
        <div class="ravi-wa-chip-row ravi-wa-chip-row--compact">
          ${taskDir ? `<span class="ravi-wa-meta-chip">task dir ${escapeHtml(shorten(taskDir, 52))}</span>` : ""}
          ${frontmatterChips.map((chip) => `<span class="ravi-wa-meta-chip">${escapeHtml(chip)}</span>`).join("")}
        </div>
      `
          : ""
      }
      ${renderTaskFactGrid([{ label: "task dir", value: taskDir || "-", monospace: true }])}
    </section>

    <section class="ravi-wa-card ravi-wa-task-detail-section">
      <div class="ravi-wa-section-head">
        <h3>relationships</h3>
        <span>${escapeHtml(`${parentTask || task.parentTaskId ? 1 : 0} up · ${childTasks.length} down`)}</span>
      </div>
      <div class="ravi-wa-task-relations">
        <div class="ravi-wa-task-relations__group">
          <span class="ravi-wa-task-relations__label">parent</span>
          ${
            parentTask
              ? renderTaskRelationCard(parentTask)
              : task.parentTaskId
                ? `<p class="ravi-wa-task-relations__empty">parent ${escapeHtml(formatTaskShortId(task.parentTaskId))} fora do snapshot atual.</p>`
                : `<p class="ravi-wa-empty">sem parent task.</p>`
          }
        </div>
        <div class="ravi-wa-task-relations__group">
          <span class="ravi-wa-task-relations__label">children</span>
          ${
            childTasks.length
              ? `<div class="ravi-wa-task-relations__list">${childTasks.map((childTask) => renderTaskRelationCard(childTask)).join("")}</div>`
              : `<p class="ravi-wa-empty">sem child tasks vinculadas.</p>`
          }
        </div>
      </div>
    </section>

    <section class="ravi-wa-card ravi-wa-task-detail-section">
      <div class="ravi-wa-section-head">
        <h3>assignments</h3>
        <span>${escapeHtml(String(assignments.length))}</span>
      </div>
      ${renderTaskAssignments(assignments, activeAssignment)}
    </section>

    <section class="ravi-wa-card ravi-wa-task-detail-section">
      <div class="ravi-wa-section-head">
        <h3>instructions</h3>
        <span>${escapeHtml(task.instructions ? "runtime body" : "empty")}</span>
      </div>
      <div class="ravi-wa-task-copy ravi-wa-task-copy--flush">
        <pre>${escapeHtml(task.instructions || "sem instructions no runtime.")}</pre>
      </div>
    </section>

    <section class="ravi-wa-card ravi-wa-task-detail-section">
      <div class="ravi-wa-section-head">
        <h3>comments</h3>
        <span>${escapeHtml(String(comments.length))}</span>
      </div>
      ${renderTaskComments(comments)}
    </section>

    <section class="ravi-wa-card ravi-wa-task-detail-section">
      <div class="ravi-wa-section-head">
        <h3>lifecycle</h3>
        <span>${escapeHtml(String(lifecycleEvents.length))}</span>
      </div>
      ${renderTaskEvents(selectedTask?.events)}
    </section>
  `;
}

function eventKindToActivity(kind) {
  switch (kind) {
    case "stream":
      return "streaming";
    case "approval":
      return "awaiting_approval";
    case "tool":
    case "prompt":
    case "runtime":
      return "thinking";
    case "response":
      return "streaming";
    default:
      return "idle";
  }
}

function filterCockpitSessions(items) {
  const list = Array.isArray(items) ? items : [];
  const needle = normalizeLookupToken(sidebarFilter);
  if (!needle) return list;
  const taskHierarchyState = getTaskHierarchyState();
  return list.filter((session) => {
    const taskMatch = resolveTaskSessionMatch(session);
    const lineage = taskMatch?.task?.id ? getTaskLineage(taskMatch.task.id, taskHierarchyState) : [];
    return [
      session.displayName,
      session.subject,
      session.chatId,
      session.sessionName,
      session.agentId,
      session.channel,
      taskMatch?.task?.id,
      taskMatch?.task?.title,
      taskMatch?.task?.assigneeAgentId,
      taskMatch?.task?.assigneeSessionName,
      taskMatch?.task?.workSessionName,
      taskMatch?.note?.text,
      ...lineage.map((task) => task?.title),
      ...lineage.map((task) => task?.id),
    ]
      .map(normalizeLookupToken)
      .some((value) => value && value.includes(needle));
  });
}

function filterOmniInstances(items) {
  const list = Array.isArray(items) ? items : [];
  const needle = normalizeLookupToken(omniFilter);
  if (!needle) return list;
  return list.filter((instance) =>
    [instance.name, instance.profileName, instance.phone, instance.ownerIdentifier, instance.channel]
      .map(normalizeLookupToken)
      .some((value) => value && value.includes(needle)),
  );
}

function filterOmniAgents(items) {
  return Array.isArray(items) ? items : [];
}

function filterOmniChats(items) {
  const list = Array.isArray(items) ? items : [];
  const needle = normalizeLookupToken(omniFilter);
  const filtered = !needle
    ? list
    : list.filter((chat) =>
        [chat.name, chat.externalId, chat.lastMessagePreview, chat.chatType]
          .map(normalizeLookupToken)
          .some((value) => value && value.includes(needle)),
      );
  return filtered.slice(0, 40);
}

function filterOmniGroups(items) {
  const list = Array.isArray(items) ? items : [];
  const needle = normalizeLookupToken(omniFilter);
  const filtered = !needle
    ? list
    : list.filter((group) =>
        [group.name, group.externalId, group.description]
          .map(normalizeLookupToken)
          .some((value) => value && value.includes(needle)),
      );
  return filtered.slice(0, 18);
}

function filterOmniSessions(items) {
  const list = Array.isArray(items) ? items : [];
  const needle = normalizeLookupToken(omniSessionFilter);
  if (!needle) return list.slice(0, 40);
  return list
    .filter((session) =>
      [session.sessionName, session.agentId, session.chatId, session.displayName, session.subject]
        .map(normalizeLookupToken)
        .some((value) => value && value.includes(needle)),
    )
    .slice(0, 40);
}

function formatOmniInstanceStatus(instance) {
  if (instance?.isConnected) return "connected";
  if (instance?.isActive) return "active";
  return "offline";
}

function formatOmniChatType(value) {
  if (!value) return "chat";
  return value === "dm" ? "dm" : value === "group" ? "group" : value;
}

function formatUnreadLabel(value) {
  const count = Number(value || 0);
  return count > 0 ? `${count} unread` : "read";
}

function getCurrentOmniActorSession() {
  return (
    latestOmniPanel?.actor?.sessionName ||
    latestOmniPanel?.actor?.sessionKey ||
    latestSnapshot?.session?.sessionName ||
    latestSnapshot?.session?.sessionKey ||
    null
  );
}

function allowOmniDecision(relation) {
  return {
    allowed: true,
    matched: relation ? [relation] : [],
    missing: [],
    reason: null,
  };
}

function denyOmniDecision(...relations) {
  const missing = relations.filter(Boolean);
  return {
    allowed: false,
    matched: [],
    missing,
    reason: missing.length ? `missing ${missing.join(" + ")}` : "missing permission",
  };
}

function omniCapabilityAllows(capabilities, permission, objectType, objectId) {
  const list = Array.isArray(capabilities) ? capabilities : [];
  if (list.some((cap) => cap?.permission === "admin" && cap?.objectType === "system" && cap?.objectId === "*")) {
    return true;
  }
  if (list.some((cap) => cap?.permission === permission && cap?.objectType === objectType && cap?.objectId === objectId)) {
    return true;
  }
  if (
    objectId !== "*" &&
    list.some((cap) => cap?.permission === permission && cap?.objectType === objectType && cap?.objectId === "*")
  ) {
    return true;
  }
  if (objectId !== "*") {
    return list.some((cap) => {
      if (cap?.permission !== permission || cap?.objectType !== objectType || typeof cap?.objectId !== "string") {
        return false;
      }
      if (!cap.objectId.includes("*")) return false;
      return omniPatternMatches(cap.objectId, objectId);
    });
  }
  return false;
}

function omniPatternMatches(pattern, value) {
  if (pattern === value) return true;
  if (!pattern.endsWith("*")) return false;
  return value.startsWith(pattern.slice(0, -1));
}

function getOmniPanelActor(panel = latestOmniPanel) {
  return panel?.actor || null;
}

function checkOmniAction(permission, objectType, objectId) {
  const actor = getOmniPanelActor();
  const relation = `${permission} ${objectType}:${objectId}`;
  if (!actor?.agentId) return denyOmniDecision(relation);
  return omniCapabilityAllows(actor.capabilities, permission, objectType, objectId)
    ? allowOmniDecision(relation)
    : denyOmniDecision(relation);
}

function checkOmniSessionAccess(session) {
  const actor = getOmniPanelActor();
  const target = session?.sessionName || session?.sessionKey || null;
  const relation = target ? `access session:${target}` : null;
  if (!target) return denyOmniDecision();
  if (!actor?.agentId) return denyOmniDecision(relation);
  if (actor.sessionName === target || actor.sessionKey === target) return allowOmniDecision(relation);
  return omniCapabilityAllows(actor.capabilities, "access", "session", target)
    ? allowOmniDecision(relation)
    : denyOmniDecision(relation);
}

function checkOmniSessionModify(session) {
  const actor = getOmniPanelActor();
  const target = session?.sessionName || session?.sessionKey || null;
  const relation = target ? `modify session:${target}` : null;
  if (!target) return denyOmniDecision();
  if (!actor?.agentId) return denyOmniDecision(relation);
  if (actor.sessionName === target || actor.sessionKey === target) return allowOmniDecision(relation);
  return omniCapabilityAllows(actor.capabilities, "modify", "session", target)
    ? allowOmniDecision(relation)
    : denyOmniDecision(relation);
}

function checkOmniAgentView(agentId) {
  const actor = getOmniPanelActor();
  const relation = `view agent:${agentId}`;
  if (!agentId) return denyOmniDecision();
  if (!actor?.agentId) return denyOmniDecision(relation);
  if (actor.agentId === agentId) return allowOmniDecision(relation);
  return omniCapabilityAllows(actor.capabilities, "view", "agent", agentId)
    ? allowOmniDecision(relation)
    : denyOmniDecision(relation);
}

function checkOmniGroupExecute(groupName) {
  return checkOmniAction("execute", "group", groupName);
}

function checkOmniRouteModify(routeObjectId) {
  if (!routeObjectId) return denyOmniDecision();
  return checkOmniAction("modify", "route", routeObjectId);
}

function collectOmniMissingRelations(decisions) {
  return Array.from(
    new Set(
      (Array.isArray(decisions) ? decisions : [])
        .filter((decision) => decision && decision.allowed === false)
        .flatMap((decision) => decision.missing || []),
    ),
  );
}

function describeOmniMissingRelations(missing) {
  const list = Array.isArray(missing) ? missing.filter(Boolean) : [];
  if (!list.length) return null;
  return list.join(" + ");
}

function getOmniAuth(item) {
  return item?.auth || null;
}

function isOmniOpaque(item) {
  return getOmniAuth(item)?.visibility === "opaque";
}

function buildOmniItemPermissionTitle(item, fallback) {
  const auth = getOmniAuth(item);
  const missing = describeOmniMissingRelations(auth?.view?.missing);
  if (!missing) return fallback || "";
  return `${fallback || "restricted"} · ${missing}`;
}

function getOmniActionState(kind, formState) {
  const selectedChat = formState?.selectedChat || null;
  const selectedSession = formState?.selectedSession || null;
  const currentLinkedSession = formState?.currentLinkedSession || null;
  const selectedRouteAgentId = formState?.selectedRouteAgentId || null;

  const decisions = [];

  if (kind === "bind-existing") {
    if (!selectedSession) {
      return { allowed: false, missing: ["choose session"], reason: "choose session" };
    }
    if (currentLinkedSession && currentLinkedSession.sessionKey === selectedSession.sessionKey) {
      return { allowed: false, missing: ["already linked"], reason: "already linked" };
    }
    decisions.push(checkOmniSessionAccess(selectedSession));
    decisions.push(checkOmniRouteModify(selectedChat?.routeObjectId || null));
  }

  if (kind === "create-session") {
    if (!selectedRouteAgentId) {
      return { allowed: false, missing: ["choose agent"], reason: "choose agent" };
    }
    decisions.push(checkOmniGroupExecute("sessions"));
    decisions.push(checkOmniRouteModify(selectedChat?.routeObjectId || null));
    decisions.push(checkOmniAgentView(selectedRouteAgentId));
  }

  if (kind === "migrate-session") {
    if (!currentLinkedSession) {
      return { allowed: false, missing: ["no linked session"], reason: "no linked session" };
    }
    if (!selectedRouteAgentId) {
      return { allowed: false, missing: ["choose agent"], reason: "choose agent" };
    }
    if (currentLinkedSession.agentId === selectedRouteAgentId) {
      return { allowed: false, missing: ["same agent"], reason: "same agent" };
    }
    decisions.push(checkOmniGroupExecute("sessions"));
    decisions.push(checkOmniRouteModify(selectedChat?.routeObjectId || null));
    decisions.push(checkOmniAgentView(selectedRouteAgentId));
    decisions.push(checkOmniSessionModify(currentLinkedSession));
  }

  if (kind === "create-agent-session") {
    if (!formState?.draftNewAgentId) {
      return { allowed: false, missing: ["new agent id"], reason: "new agent id" };
    }
    decisions.push(checkOmniGroupExecute("agents"));
    decisions.push(checkOmniGroupExecute("sessions"));
    decisions.push(checkOmniRouteModify(selectedChat?.routeObjectId || null));
  }

  const missing = collectOmniMissingRelations(decisions);
  return {
    allowed: missing.length === 0,
    missing,
    reason: describeOmniMissingRelations(missing),
  };
}

function buildOmniActionTitle(label, state) {
  if (!state || state.allowed) return label;
  const reason = state.reason || describeOmniMissingRelations(state.missing);
  return reason ? `${label} · ${reason}` : label;
}

function formatOmniRouteError(result, fallback) {
  const missing = describeOmniMissingRelations(result?.missingRelations);
  if (missing) return `${fallback} · ${missing}`;
  return result?.error || fallback;
}

function renderOmniAgentOptions(items, selectedAgentId) {
  if (!items.length) {
    return `<option value="">Nenhum agent</option>`;
  }

  return items
    .map((agent) => {
      const selected = agent.id === selectedAgentId ? " selected" : "";
      const disabled = isOmniOpaque(agent) ? " disabled" : "";
      const label = agent.name ? `${agent.id} · ${agent.name}` : agent.id;
      const title = buildOmniItemPermissionTitle(agent, label);
      return `<option value="${escapeAttribute(agent.id)}"${selected}${disabled} title="${escapeAttribute(title)}">${escapeHtml(isOmniOpaque(agent) ? `🔒 ${label}` : label)}</option>`;
    })
    .join("");
}

function buildOmniBindButtonLabel(currentLinkedSession, selectedSession) {
  if (!selectedSession) return "Escolhe uma sessão";
  if (!currentLinkedSession) return `Vincular a ${selectedSession.sessionName}`;
  if (currentLinkedSession.sessionKey === selectedSession.sessionKey) {
    return `Já vinculada em ${selectedSession.sessionName}`;
  }
  return `Migrar ${currentLinkedSession.sessionName} -> ${selectedSession.sessionName}`;
}

function buildOmniDraftSessionName(selectedChat, agentId) {
  const agentStem = slugifyOmniToken(agentId || "sessao");
  const chatStem = slugifyOmniToken(selectedChat?.name || selectedChat?.externalId || "chat");
  if (!chatStem) return agentStem;
  return `${agentStem}-${chatStem}`.slice(0, 48);
}

function buildOmniRouteNotice(kind, result, selectedChat, session) {
  const chatLabel = selectedChat?.name || selectedChat?.externalId || "chat";
  const sessionName = session?.sessionName || result?.snapshot?.session?.sessionName || result?.route?.session || "sessão";

  if (kind === "bind-existing") {
    return `migrei ${chatLabel} -> ${sessionName}`;
  }
  if (kind === "migrate-session") {
    return `mudei ${chatLabel} para ${sessionName}`;
  }
  if (result?.createdAgent) {
    return `criei agent + sessão e vinculei ${chatLabel} -> ${sessionName}`;
  }
  if (result?.createdSession) {
    return `criei sessão e vinculei ${chatLabel} -> ${sessionName}`;
  }
  return `roteei ${chatLabel} -> ${sessionName}`;
}

function slugifyOmniToken(value) {
  return normalizeLookupToken(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function formatElapsedFromIso(value) {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  return formatElapsedCompact(timestamp);
}

function getCockpitChatTitle(session) {
  return session.displayName || session.subject || session.chatId || session.sessionName;
}

function getLinkedChatLabel(session) {
  return session.displayName || session.subject || session.chatId || null;
}

function dedupeSessionsByKey(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item?.sessionKey || seen.has(item.sessionKey)) continue;
    seen.add(item.sessionKey);
    result.push(item);
  }
  return result;
}

async function openCockpitChat(session) {
  if (!session?.chatId && !session?.displayName && !session?.subject) {
    setSidebarNotice("error", `a sessão ${session?.sessionName || "?"} não tem chat vinculado`);
    return false;
  }
  return openGenericChatTarget({
    chatId: session.chatId,
    title: getCockpitChatTitle(session),
    label: getCockpitChatTitle(session),
    queries: [session.displayName, session.subject, session.chatId, session.sessionName].filter(Boolean),
  });
}

async function openOmniChatTarget(chat) {
  return openGenericChatTarget({
    chatId: chat.externalId || chat.canonicalId,
    title: chat.name,
    label: chat.name || chat.externalId || chat.id,
    queries: [chat.name, chat.externalId, chat.canonicalId].filter(Boolean),
  });
}

async function openGenericChatTarget(target) {
  if (!target?.chatId && !target?.title) {
    setSidebarNotice("error", "esse item do omni não tem chat vinculado");
    return false;
  }

  const label = target.label || target.title || target.chatId || "chat";
  setSidebarNotice("info", `abrindo ${label}...`, 0);

  if (isTargetOpenNow(target)) {
    setSidebarNotice("success", `${label} já estava aberto`);
    return true;
  }

  const visibleOpen = await tryOpenChatTargetFromVisibleRows(target);
  if (visibleOpen.ok) {
    setSidebarNotice("success", `abriu ${label}`);
    return true;
  }

  const searchInput = detectNativeSidebarSearchInput();
  if (!(searchInput instanceof HTMLInputElement)) {
    setSidebarNotice("error", "não achei a busca nativa do whatsapp");
    return false;
  }

  const originalValue = searchInput.value || "";
  const queries = [...new Set((target.queries || [target.title, target.chatId]).filter(Boolean))];
  let lastFailure = visibleOpen.reason || null;

  for (const query of queries) {
    focusNativeSidebarSearchInput(searchInput);
    setNativeSidebarSearchValue(searchInput, query);
    await sleep(180);

    const waitedRow = await waitForMatchingChatRowByTarget(target, 1800);
    if (waitedRow) {
      const searchOpen = await tryOpenChatTargetFromVisibleRows(target);
      if (searchOpen.ok) {
        await sleep(140);
        clearNativeSidebarSearch(searchInput, originalValue);
        setSidebarNotice("success", `abriu ${label}`);
        return true;
      }
      lastFailure = searchOpen.reason || lastFailure;
    }
  }

  clearNativeSidebarSearch(searchInput, originalValue);
  setSidebarNotice("error", lastFailure || `não achei ${label}`);
  return false;
}

async function tryOpenChatTargetFromVisibleRows(target) {
  const row = findMatchingChatRowByTarget(target);
  if (!row) {
    return { ok: false, reason: null };
  }

  if (!clickChatRow(row)) {
    return {
      ok: false,
      reason: `achei ${target.label || target.title || target.chatId || "o chat"}, mas não consegui clicar na row`,
    };
  }

  const confirmed = await waitForTargetOpen(target, 1800);
  if (!confirmed) {
    return {
      ok: false,
      reason: `achei ${target.label || target.title || target.chatId || "o chat"}, mas o WhatsApp não confirmou a abertura`,
    };
  }

  return { ok: true, reason: null };
}

function findMatchingChatRowByTarget(target) {
  const rows = detectVisibleChatRows();
  const chatIdVariants = buildChatIdVariants(target?.chatId);
  const normalizedTitle = normalizeLookupToken(target?.title);
  return (
    rows.find((candidate) => {
      const rowChatId = normalizeLookupToken(candidate.chatIdCandidate);
      const rowTitle = normalizeLookupToken(candidate.title);
      if (rowChatId && chatIdVariants.includes(rowChatId)) return true;
      if (normalizedTitle && rowTitle && rowTitle === normalizedTitle) return true;
      return false;
    }) || null
  );
}

function clickChatRow(row) {
  if (!row?.row) return false;
  row.row.scrollIntoView({ block: "center", behavior: "smooth" });
  const clickable = row.row.querySelector("[aria-selected]") || row.row.firstElementChild || row.row;
  if (clickable instanceof HTMLElement) {
    clickable.click();
    return true;
  }
  return false;
}

function isTargetOpenNow(target) {
  const currentChatId = normalizeLookupToken(
    latestPageChat?.chatId || latestViewState?.chatIdCandidate || detectChatIdCandidate(),
  );
  const currentTitle = normalizeLookupToken(
    latestPageChat?.title || detectChatTitle() || latestViewState?.selectedChat || detectSelectedChatLabel(),
  );
  const chatIdVariants = buildChatIdVariants(target?.chatId);
  const normalizedTitle = normalizeLookupToken(target?.title);

  if (currentChatId && chatIdVariants.includes(currentChatId)) {
    return true;
  }

  if (normalizedTitle && currentTitle && normalizedTitle === currentTitle) {
    return true;
  }

  return false;
}

async function waitForTargetOpen(target, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    requestPageChatInfo();
    if (isTargetOpenNow(target)) {
      await sleep(140);
      return true;
    }
    await sleep(120);
  }
  return false;
}

function clickMatchingChatRow(session) {
  return clickMatchingChatRowByTarget({
    chatId: session?.chatId,
    title: getCockpitChatTitle(session),
  });
}

function clickMatchingChatRowByTarget(target) {
  const row = findMatchingChatRowByTarget(target);
  if (!row) return false;
  return clickChatRow(row);
}

async function waitForMatchingChatRow(session, timeoutMs) {
  return waitForMatchingChatRowByTarget(
    {
      chatId: session?.chatId,
      title: getCockpitChatTitle(session),
    },
    timeoutMs,
  );
}

async function waitForMatchingChatRowByTarget(target, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = findMatchingChatRowByTarget(target);
    if (row) {
      return row;
    }
    await sleep(120);
  }
  return null;
}

function detectNativeSidebarSearchInput() {
  return document.querySelector(NATIVE_SIDEBAR_SEARCH_SELECTOR);
}

function focusNativeSidebarSearchInput(input) {
  input.focus();
  input.click();
  input.select?.();
}

function setNativeSidebarSearchValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function clearNativeSidebarSearch(input, originalValue = "") {
  focusNativeSidebarSearchInput(input);
  setNativeSidebarSearchValue(input, originalValue);
}

function setSidebarNotice(kind, message, ttlMs = 2400) {
  sidebarNotice = { kind, message };
  if (sidebarNoticeTimer) clearTimeout(sidebarNoticeTimer);
  if (ttlMs > 0) {
    sidebarNoticeTimer = setTimeout(() => {
      sidebarNotice = null;
      sidebarNoticeTimer = null;
      render();
    }, ttlMs);
  } else {
    sidebarNoticeTimer = null;
  }
  render();
}

function loadPinnedSessionKey() {
  try {
    return window.localStorage.getItem(PINNED_SESSION_KEY_STORAGE);
  } catch {
    return null;
  }
}

function loadActiveWorkspace() {
  try {
    const stored = window.localStorage.getItem(ACTIVE_WORKSPACE_KEY_STORAGE);
    return stored === "omni" || stored === "tasks" ? stored : "ravi";
  } catch {
    return "ravi";
  }
}

function loadWorkspaceSessionKey() {
  try {
    return window.localStorage.getItem(WORKSPACE_SESSION_KEY_STORAGE);
  } catch {
    return null;
  }
}

function loadSelectedTaskId() {
  try {
    return window.localStorage.getItem(TASK_SELECTED_ID_STORAGE);
  } catch {
    return null;
  }
}

function persistActiveWorkspace(value) {
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY_STORAGE, value);
  } catch {
    // ignore localStorage failures inside WhatsApp Web
  }
}

function persistWorkspaceSessionKey(value) {
  try {
    if (value) {
      window.localStorage.setItem(WORKSPACE_SESSION_KEY_STORAGE, value);
    } else {
      window.localStorage.removeItem(WORKSPACE_SESSION_KEY_STORAGE);
    }
  } catch {
    // ignore localStorage failures inside WhatsApp Web
  }
}

function persistSelectedTaskId(value) {
  try {
    if (value) {
      window.localStorage.setItem(TASK_SELECTED_ID_STORAGE, value);
    } else {
      window.localStorage.removeItem(TASK_SELECTED_ID_STORAGE);
    }
  } catch {
    // ignore localStorage failures inside WhatsApp Web
  }
}

function loadPreferredOmniInstance() {
  try {
    return window.localStorage.getItem(OMNI_INSTANCE_KEY_STORAGE);
  } catch {
    return null;
  }
}

function loadV3PlaceholdersEnabled() {
  try {
    return window.localStorage.getItem(V3_PLACEHOLDERS_KEY_STORAGE) === "true";
  } catch {
    return false;
  }
}

function persistPreferredOmniInstance(value) {
  try {
    if (value) {
      window.localStorage.setItem(OMNI_INSTANCE_KEY_STORAGE, value);
    } else {
      window.localStorage.removeItem(OMNI_INSTANCE_KEY_STORAGE);
    }
  } catch {
    // ignore localStorage failures inside WhatsApp Web
  }
}

function persistV3PlaceholdersEnabled(value) {
  try {
    if (value) {
      window.localStorage.setItem(V3_PLACEHOLDERS_KEY_STORAGE, "true");
    } else {
      window.localStorage.removeItem(V3_PLACEHOLDERS_KEY_STORAGE);
    }
  } catch {
    // ignore localStorage failures inside WhatsApp Web
  }
}

function setActiveWorkspace(nextWorkspace) {
  activeWorkspace = nextWorkspace === "omni" || nextWorkspace === "tasks" ? nextWorkspace : "ravi";
  persistActiveWorkspace(activeWorkspace);
  syncWorkspaceLauncher();
  render();
  if (activeWorkspace === "omni") {
    refreshOmniPanel(true);
  } else if (activeWorkspace === "tasks") {
    refreshTasks(true);
  } else if (selectedWorkspaceSessionKey) {
    refreshSessionWorkspace(true);
  }
}

function persistPinnedSessionKey(value) {
  try {
    if (value) {
      window.localStorage.setItem(PINNED_SESSION_KEY_STORAGE, value);
    } else {
      window.localStorage.removeItem(PINNED_SESSION_KEY_STORAGE);
    }
  } catch {
    // ignore localStorage failures inside WhatsApp Web
  }
}

function normalizeLookupToken(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function buildChatIdVariants(value) {
  const normalized = normalizeLookupToken(value);
  if (!normalized) return [];

  const variants = new Set([normalized]);
  const groupMatch = normalized.match(/^group:(.+)$/);
  if (groupMatch) variants.add(`${groupMatch[1]}@g.us`);

  const groupJidMatch = normalized.match(/^(.+)@g\.us$/);
  if (groupJidMatch) variants.add(`group:${groupJidMatch[1]}`);

  const dmJidMatch = normalized.match(/^(\d+)@s\.whatsapp\.net$/);
  if (dmJidMatch) variants.add(dmJidMatch[1]);

  if (/^\d+$/.test(normalized)) {
    variants.add(`group:${normalized}`);
    variants.add(`${normalized}@g.us`);
    variants.add(`${normalized}@s.whatsapp.net`);
  }

  return [...variants];
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function formatDurationCompactMs(durationMs) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;

  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainderSeconds = seconds % 60;
    return remainderSeconds ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) {
    return remainderMinutes ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainderHours = hours % 24;
  return remainderHours ? `${days}d ${remainderHours}h` : `${days}d`;
}

function scheduleV3PlaceholderRender() {
  if (v3PlaceholderRenderScheduled) return;
  v3PlaceholderRenderScheduled = true;
  requestAnimationFrame(() => {
    v3PlaceholderRenderScheduled = false;
    syncV3PlaceholderLayer();
  });
}

function ensureV3PlaceholderLayer() {
  let layer = document.getElementById(V3_PLACEHOLDER_LAYER_ID);
  if (layer) return layer;

  layer = document.createElement("div");
  layer.id = V3_PLACEHOLDER_LAYER_ID;
  layer.addEventListener("click", handleV3PlaceholderLayerClick);
  document.body.appendChild(layer);
  return layer;
}

async function handleV3PlaceholderLayerClick(event) {
  const target = event.target instanceof HTMLElement ? event.target.closest("[data-ravi-v3-component-id]") : null;
  if (!(target instanceof HTMLElement)) return;

  const componentId = target.getAttribute("data-ravi-v3-component-id");
  if (!componentId) return;

  event.preventDefault();
  event.stopPropagation();

  try {
    const response = await sendV3Command("placeholder.outline", {
      componentId,
      durationMs: 2200,
    });
    if (response?.ok) {
      setV3CommandNotice("ok", `outlined ${componentId}`);
      return;
    }
    setV3CommandNotice("error", response?.error || "v3 command failed");
  } catch (error) {
    setV3CommandNotice("error", error instanceof Error ? error.message : String(error));
  }
}

function setV3CommandNotice(kind, message) {
  v3CommandNotice = {
    kind,
    message: String(message || ""),
  };
  if (v3CommandNoticeTimer) {
    clearTimeout(v3CommandNoticeTimer);
  }
  v3CommandNoticeTimer = setTimeout(() => {
    v3CommandNotice = null;
    scheduleV3PlaceholderRender();
  }, kind === "error" ? 3500 : 1800);
  scheduleV3PlaceholderRender();
}

function syncV3PlaceholderLayer() {
  const layer = ensureV3PlaceholderLayer();
  if (
    !v3PlaceholdersEnabled ||
    !latestV3Placeholders?.ok ||
    !latestV3Placeholders?.enabled ||
    activeWorkspace !== "ravi" ||
    latestViewState?.hasModal
  ) {
    layer.innerHTML = "";
    layer.className = "ravi-hidden";
    return;
  }

  const groups = new Map();
  for (const placeholder of latestV3Placeholders.placeholders || []) {
    const selector = placeholder.selector || resolvePlaceholderSelector(placeholder.componentId);
    const node = selector ? findVisibleElementBySelector(selector) : null;
    if (!(node instanceof HTMLElement)) continue;
    const current = groups.get(node) || [];
    current.push(placeholder);
    groups.set(node, current);
  }

  if (groups.size === 0) {
    layer.innerHTML = "";
    layer.className = "ravi-hidden";
    return;
  }

  layer.className = "ravi-wa-v3-placeholder-layer";
  const badges = [];
  for (const [node, placeholders] of groups.entries()) {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const top = Math.max(10, rect.top + 8);
    const left = Math.max(10, rect.left + 12);

    badges.push(`
      <div class="ravi-wa-v3-placeholder" style="top:${Math.round(top)}px;left:${Math.round(left)}px;">
        ${placeholders
          .map(
            (placeholder) => `
              <div class="ravi-wa-v3-placeholder__item" data-ravi-v3-component-id="${escapeHtml(placeholder.componentId)}">
                <strong>${escapeHtml(placeholder.label)}</strong>
                <span>${escapeHtml(buildPlaceholderDetail(placeholder))}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    `);
  }

  const relayStatus = latestV3Placeholders.relay?.status || "stopped";
  const relayCursor = latestV3Placeholders.relay?.lastCursor || "-";
  const mapped = latestV3Placeholders.placeholders?.length || 0;
  const missing = latestV3Placeholders.missing?.length || 0;

  layer.innerHTML = `
    <div class="ravi-wa-v3-placeholder__banner">
      <strong>ravi v3</strong>
      <span>${escapeHtml(`${relayStatus} · ${mapped} mapped · ${missing} missing · ${relayCursor}`)}</span>
      ${
        v3CommandNotice?.message
          ? `<span class="ravi-wa-v3-placeholder__notice ravi-wa-v3-placeholder__notice--${escapeHtml(v3CommandNotice.kind)}">${escapeHtml(v3CommandNotice.message)}</span>`
          : ""
      }
    </div>
    ${badges.join("")}
  `;
}

function resolvePlaceholderSelector(componentId) {
  const component = (latestViewState?.components || []).find((entry) => entry.id === componentId);
  return component?.selector || null;
}

function findVisibleElementBySelector(selector) {
  if (!selector) return null;
  try {
    const nodes = Array.from(document.querySelectorAll(selector));
    return nodes.find(isVisibleElement) || nodes[0] || null;
  } catch {
    return null;
  }
}

function buildPlaceholderDetail(placeholder) {
  const count = typeof placeholder.count === "number" && placeholder.count > 1 ? ` · ${placeholder.count}` : "";
  return `${placeholder.confidence}${count}`;
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
