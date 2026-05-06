export const WHATSAPP_OVERLAY_DOM_COMPONENTS = [
  { id: "app-root", surface: "app-shell", purpose: "Root workspace that contains chat list, conversation pane, and overlays." },
  { id: "chat-list", surface: "chat-list-pane", purpose: "Left navigation column with chats and search results." },
  { id: "selected-chat-row", surface: "chat-list-pane", purpose: "Current selected chat row in the left pane." },
  { id: "conversation-root", surface: "conversation-pane", purpose: "Center pane that contains header, timeline, and composer." },
  { id: "conversation-header", surface: "conversation-pane", purpose: "Header area with current chat title and actions." },
  { id: "timeline", surface: "conversation-pane", purpose: "Scrollable message area used for observation and inline insertion." },
  { id: "message-anchor", surface: "conversation-pane", purpose: "Stable per-message or per-message-group anchor used to position Ravi cards." },
  { id: "composer", surface: "conversation-pane", purpose: "Message composer at the bottom of the active conversation." },
  { id: "drawer", surface: "right-drawer", purpose: "Right-side info/config drawer for the active chat or contact." },
  { id: "modal", surface: "modal-layer", purpose: "Top-level blocking modal that changes interaction mode." },
];

const specById = new Map(WHATSAPP_OVERLAY_DOM_COMPONENTS.map((entry) => [entry.id, entry]));

function labelForComponentId(componentId) {
  return componentId.replaceAll("-", " ");
}

export function buildOverlayV3PlaceholderSnapshot({ publishedState }) {
  const components = publishedState?.view?.components ?? [];
  const seen = new Set();

  const placeholders = components
    .map((component) => {
      const spec = specById.get(component.id);
      if (!spec || seen.has(component.id)) return null;
      seen.add(component.id);
      return {
        componentId: component.id,
        label: labelForComponentId(component.id),
        surface: component.surface,
        purpose: spec.purpose,
        selector: component.selector ?? null,
        confidence: component.confidence,
        score: component.score,
        count: typeof component.count === "number" ? component.count : null,
        signals: Array.isArray(component.signals) ? component.signals : [],
        status: "mapped",
      };
    })
    .filter((entry) => entry !== null);

  const missing = WHATSAPP_OVERLAY_DOM_COMPONENTS
    .filter((component) => !seen.has(component.id))
    .map((component) => ({
      componentId: component.id,
      label: labelForComponentId(component.id),
      surface: component.surface,
      purpose: component.purpose,
      status: "missing",
    }));

  return {
    ok: true,
    enabled: placeholders.length > 0,
    generatedAt: Date.now(),
    relay: {
      status: "running",
      pid: null,
      scope: "extension-local",
      topicPatterns: [],
      lastHeartbeatAt: null,
      lastCursor: null,
      lastError: null,
      hasHello: true,
      hasSnapshot: Boolean(publishedState),
    },
    page: {
      screen: publishedState?.view?.screen ?? null,
      title: publishedState?.view?.title ?? null,
      selectedChat: publishedState?.view?.selectedChat ?? null,
      chatIdCandidate: publishedState?.view?.chatIdCandidate ?? null,
      postedAt: publishedState?.postedAt ?? null,
      componentCount: components.length,
      chatRowCount: publishedState?.view?.chatRows?.length ?? 0,
    },
    placeholders,
    missing,
  };
}
