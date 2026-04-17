import { WHATSAPP_OVERLAY_DOM_MODEL } from "./dom-spec.js";
import type { OverlayPublishedState } from "./state.js";

export interface OverlayV3RelayHealth {
  status: "stopped" | "starting" | "running" | "broken";
  pid: number | null;
  scope: string;
  topicPatterns: string[];
  lastHeartbeatAt: string | null;
  lastCursor: string | null;
  lastError: string | null;
  hasHello: boolean;
  hasSnapshot: boolean;
}

export interface OverlayV3PlaceholderEntry {
  componentId: string;
  label: string;
  surface: string;
  purpose: string;
  selector: string | null;
  confidence: "high" | "medium" | "low";
  score: number;
  count: number | null;
  signals: string[];
  status: "mapped";
}

export interface OverlayV3PlaceholderMissing {
  componentId: string;
  label: string;
  surface: string;
  purpose: string;
  status: "missing";
}

export interface OverlayV3PlaceholderSnapshot {
  ok: true;
  enabled: boolean;
  generatedAt: number;
  relay: OverlayV3RelayHealth;
  page: {
    screen: string | null;
    title: string | null;
    selectedChat: string | null;
    chatIdCandidate: string | null;
    postedAt: number | null;
    componentCount: number;
    chatRowCount: number;
  };
  placeholders: OverlayV3PlaceholderEntry[];
  missing: OverlayV3PlaceholderMissing[];
}

const specById = new Map(WHATSAPP_OVERLAY_DOM_MODEL.components.map((entry) => [entry.id, entry]));

function labelForComponentId(componentId: string): string {
  return componentId.replaceAll("-", " ");
}

function getComponentSpec(componentId: string) {
  return specById.get(componentId as (typeof WHATSAPP_OVERLAY_DOM_MODEL.components)[number]["id"]);
}

export function buildOverlayV3PlaceholderSnapshot(input: {
  publishedState: OverlayPublishedState | null;
  relay: OverlayV3RelayHealth;
}): OverlayV3PlaceholderSnapshot {
  const publishedState = input.publishedState;
  const components = publishedState?.view.components ?? [];
  const seen = new Set<string>();

  const placeholders: OverlayV3PlaceholderEntry[] = components
    .map((component) => {
      const spec = getComponentSpec(component.id);
      if (!spec || seen.has(component.id)) {
        return null;
      }
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
      } satisfies OverlayV3PlaceholderEntry;
    })
    .filter((entry) => entry !== null);

  const missing: OverlayV3PlaceholderMissing[] = WHATSAPP_OVERLAY_DOM_MODEL.components
    .filter((component) => !seen.has(component.id))
    .map((component) => ({
      componentId: component.id,
      label: labelForComponentId(component.id),
      surface: component.surface,
      purpose: component.purpose,
      status: "missing" as const,
    }));

  return {
    ok: true,
    enabled: placeholders.length > 0,
    generatedAt: Date.now(),
    relay: input.relay,
    page: {
      screen: publishedState?.view.screen ?? null,
      title: publishedState?.view.title ?? null,
      selectedChat: publishedState?.view.selectedChat ?? null,
      chatIdCandidate: publishedState?.view.chatIdCandidate ?? null,
      postedAt: publishedState?.postedAt ?? null,
      componentCount: components.length,
      chatRowCount: publishedState?.view.chatRows?.length ?? 0,
    },
    placeholders,
    missing,
  };
}
