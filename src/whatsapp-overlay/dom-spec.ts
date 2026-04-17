export type OverlaySurfaceId = "app-shell" | "chat-list-pane" | "conversation-pane" | "right-drawer" | "modal-layer";

export type OverlayComponentId =
  | "app-root"
  | "chat-list"
  | "selected-chat-row"
  | "conversation-root"
  | "conversation-header"
  | "timeline"
  | "message-anchor"
  | "composer"
  | "drawer"
  | "modal";

export type OverlaySignalKind =
  | "role"
  | "data-testid"
  | "aria-label"
  | "title"
  | "text"
  | "contenteditable"
  | "selection"
  | "visibility"
  | "scrollable"
  | "geometry";

export type OverlayRelationKind = "inside" | "contains" | "adjacent" | "left-of" | "right-of" | "below" | "above";

export interface OverlaySelectorHint {
  name: string;
  selector: string;
  weight: number;
  note?: string;
}

export interface OverlaySignalSpec {
  kind: OverlaySignalKind;
  required?: boolean;
  key?: string;
  value?: string;
  regex?: string;
  note?: string;
}

export interface OverlayRelationSpec {
  kind: OverlayRelationKind;
  target: OverlayComponentId;
  required?: boolean;
  note?: string;
}

export interface OverlayGeometrySpec {
  pane?: "left" | "center" | "right" | "overlay";
  minWidth?: number;
  minHeight?: number;
  scrollable?: boolean;
  sticky?: boolean;
  note?: string;
}

export interface OverlayExtractorSpec {
  field: string;
  source: "title" | "text" | "attribute" | "html";
  attribute?: string;
  regex?: string;
  note?: string;
}

export interface OverlayComponentSpec {
  id: OverlayComponentId;
  surface: OverlaySurfaceId;
  purpose: string;
  selectors: OverlaySelectorHint[];
  signals: OverlaySignalSpec[];
  relations?: OverlayRelationSpec[];
  geometry?: OverlayGeometrySpec;
  extractors?: OverlayExtractorSpec[];
  usage?: string[];
}

export interface OverlayModelSpec {
  version: string;
  principles: string[];
  scoring: {
    hardSignalsFirst: boolean;
    geometryAsTieBreaker: boolean;
    classNameFallbackOnly: boolean;
    requireStableMatchTicks: number;
  };
  selectorSynthesis: string[];
  components: OverlayComponentSpec[];
}

/**
 * WhatsApp Web DOM model for the Ravi overlay.
 *
 * The rule is simple:
 * - identify semantic components first
 * - score evidence from stable signals
 * - use geometry and relations to disambiguate
 * - only then synthesize the actual selector we will use in runtime
 *
 * We do not model "a CSS selector".
 * We model "what a component is" and let selectors be one source of evidence.
 */
export const WHATSAPP_OVERLAY_DOM_MODEL: OverlayModelSpec = {
  version: "v0",
  principles: [
    "Class names are fallback only. Prefer data-testid, role, aria, contenteditable, title, and geometry.",
    "A component is recognized by evidence, not by a single selector hit.",
    "The same component may have multiple selector candidates with different weights.",
    "Pane position is structural and more stable than class names in WhatsApp Web.",
    "Selectors used for injection should be synthesized from the winning component match, not hardcoded globally.",
  ],
  scoring: {
    hardSignalsFirst: true,
    geometryAsTieBreaker: true,
    classNameFallbackOnly: true,
    requireStableMatchTicks: 2,
  },
  selectorSynthesis: [
    "Find all candidates for a component.",
    "Score candidates by required signals first, optional signals second.",
    "Reject candidates that violate required relations or pane geometry.",
    "Keep the highest-score visible candidate that remains stable across two consecutive detection ticks.",
    "Use the synthesized selector path for runtime operations such as insertion, extraction, and live monitoring.",
  ],
  components: [
    {
      id: "app-root",
      surface: "app-shell",
      purpose: "Root workspace that contains chat list, conversation pane, and overlays.",
      selectors: [
        { name: "main", selector: "main", weight: 100 },
        { name: "role-application", selector: "main [role='application']", weight: 70 },
      ],
      signals: [
        { kind: "visibility", required: true, note: "Must be visible on screen." },
        { kind: "geometry", required: true, note: "Occupies the main working area." },
      ],
      geometry: { pane: "center", minWidth: 400, minHeight: 400 },
    },
    {
      id: "chat-list",
      surface: "chat-list-pane",
      purpose: "Left navigation column with chats and search results.",
      selectors: [
        { name: "chat-list-testid", selector: "[data-testid='chat-list']", weight: 100 },
        { name: "chat-grid", selector: "div[role='grid']", weight: 65 },
        { name: "aria-chat", selector: "[aria-label*='Chat']", weight: 60 },
      ],
      signals: [
        { kind: "scrollable", required: true },
        { kind: "geometry", required: true, note: "Expected on the left pane." },
      ],
      geometry: { pane: "left", minWidth: 220, scrollable: true },
      usage: ["View detection", "Selected row lookup", "Chat context fallback"],
    },
    {
      id: "selected-chat-row",
      surface: "chat-list-pane",
      purpose: "Current selected chat row in the left pane.",
      selectors: [
        { name: "aria-selected", selector: "[aria-selected='true']", weight: 100 },
        { name: "selected-title", selector: "[aria-selected='true'] [title]", weight: 85 },
      ],
      signals: [
        { kind: "selection", required: true, key: "aria-selected", value: "true" },
        { kind: "visibility", required: true },
      ],
      relations: [{ kind: "inside", target: "chat-list", required: true }],
      extractors: [
        { field: "selectedChatLabel", source: "title", note: "Primary label for the selected conversation." },
        {
          field: "chatIdCandidate",
          source: "html",
          regex: "\\b(?:\\d{10,}@g\\.us|\\d{8,}@s\\.whatsapp\\.net|group:\\d+|120363\\d{6,})\\b",
          note: "Fallback chat id extraction from row markup.",
        },
      ],
    },
    {
      id: "conversation-root",
      surface: "conversation-pane",
      purpose: "Center pane that contains header, timeline, and composer.",
      selectors: [
        { name: "conversation-panel-body", selector: "main [data-testid='conversation-panel-body']", weight: 100 },
        { name: "message-list", selector: "main [aria-label='Message list']", weight: 75 },
        { name: "main-fallback", selector: "main", weight: 40, note: "Only valid if composer + anchors also match." },
      ],
      signals: [
        { kind: "geometry", required: true, note: "Expected in the center pane." },
        { kind: "visibility", required: true },
      ],
      geometry: { pane: "center", minWidth: 320, minHeight: 320 },
    },
    {
      id: "conversation-header",
      surface: "conversation-pane",
      purpose: "Header area with current chat title and actions.",
      selectors: [
        { name: "main-header-title", selector: "main header [title]", weight: 100 },
        { name: "main-header-auto", selector: "main header span[dir='auto']", weight: 90 },
        { name: "main-header-h1", selector: "main header h1", weight: 70 },
      ],
      signals: [
        { kind: "visibility", required: true },
        { kind: "title", required: false, note: "Chat name often appears here, but not on every subview." },
      ],
      relations: [{ kind: "inside", target: "conversation-root", required: true }],
      geometry: { pane: "center", sticky: true },
      extractors: [{ field: "chatTitle", source: "title", note: "Preferred human-readable conversation title." }],
    },
    {
      id: "timeline",
      surface: "conversation-pane",
      purpose: "Scrollable message area used for observation and inline insertion.",
      selectors: [
        { name: "conversation-panel-body", selector: "main [data-testid='conversation-panel-body']", weight: 100 },
        { name: "message-list", selector: "main [aria-label='Message list']", weight: 80 },
        { name: "role-application", selector: "main [role='application']", weight: 50 },
      ],
      signals: [
        { kind: "scrollable", required: true },
        { kind: "visibility", required: true },
      ],
      relations: [{ kind: "inside", target: "conversation-root", required: true }],
      geometry: { pane: "center", scrollable: true },
      usage: ["Inline card injection", "Message anchor search", "Viewport-based instrumentation"],
    },
    {
      id: "message-anchor",
      surface: "conversation-pane",
      purpose: "Stable per-message or per-message-group anchor used to position Ravi cards.",
      selectors: [
        { name: "msg-container", selector: "main [data-testid='msg-container']", weight: 100 },
        { name: "data-id", selector: "main div[data-id]", weight: 85 },
        { name: "msg-testid-prefix", selector: "main [data-testid^='msg-']", weight: 70 },
      ],
      signals: [
        { kind: "visibility", required: true },
        { kind: "geometry", required: false, note: "Usually repeated vertically in the timeline." },
      ],
      relations: [{ kind: "inside", target: "timeline", required: true }],
      extractors: [
        { field: "messageId", source: "attribute", attribute: "data-id" },
        { field: "htmlFingerprint", source: "html", note: "Used to detect DOM recycling/virtualization." },
      ],
      usage: ["Insert Ravi cards after a visible message block", "Map runtime events to nearby messages later"],
    },
    {
      id: "composer",
      surface: "conversation-pane",
      purpose: "Message composer at the bottom of the active conversation.",
      selectors: [
        { name: "footer-editable", selector: "footer [contenteditable='true']", weight: 100 },
        { name: "textbox", selector: "div[contenteditable='true'][role='textbox']", weight: 90 },
        { name: "footer-textbox", selector: "footer div[contenteditable='true']", weight: 80 },
      ],
      signals: [
        { kind: "contenteditable", required: true },
        { kind: "visibility", required: true },
      ],
      relations: [{ kind: "below", target: "timeline", required: false }],
      geometry: { pane: "center", sticky: true },
      usage: ["Conversation detection", "Action toolbar insertion", "Current focus inference"],
    },
    {
      id: "drawer",
      surface: "right-drawer",
      purpose: "Right-side info/config drawer for the active chat or contact.",
      selectors: [
        { name: "main-aside", selector: "main aside", weight: 90 },
        { name: "animated-drawer", selector: "[data-animate-drawer='true']", weight: 100 },
        { name: "close-button", selector: "div[role='button'][aria-label='Close']", weight: 40 },
      ],
      signals: [
        { kind: "visibility", required: true },
        { kind: "geometry", required: true, note: "Expected on the right side." },
      ],
      geometry: { pane: "right", minWidth: 240 },
      usage: ["Config UI", "Session controls", "Agent/channel management inside WhatsApp"],
    },
    {
      id: "modal",
      surface: "modal-layer",
      purpose: "Top-level blocking modal that changes interaction mode.",
      selectors: [{ name: "dialog", selector: "[role='dialog']", weight: 100 }],
      signals: [
        { kind: "role", required: true, key: "role", value: "dialog" },
        { kind: "visibility", required: true },
      ],
      geometry: { pane: "overlay", minWidth: 240, minHeight: 160 },
      usage: ["Screen mode detection", "Suppress inline injection when modal is active"],
    },
  ],
};
