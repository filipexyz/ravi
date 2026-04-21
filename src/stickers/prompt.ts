import { channelSupportsStickers } from "../channels/capabilities.js";
import type { PromptContextSection } from "../prompt-builder.js";
import type { AgentConfig } from "../router/types.js";
import type { ChannelContext } from "../runtime/message-types.js";
import { listStickers, stickerAllowedForAgent, stickerAllowedOnChannel, type StickerCatalogEntry } from "./catalog.js";

type StickerDefaults = {
  enabled?: unknown;
};

function asStickerDefaults(value: unknown): StickerDefaults | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as StickerDefaults;
}

export function agentHasStickersEnabled(agent: Pick<AgentConfig, "defaults">): boolean {
  const defaults = agent.defaults ?? {};
  if (defaults.stickersEnabled === true) return true;
  const stickerDefaults = asStickerDefaults(defaults.stickers);
  return stickerDefaults?.enabled === true;
}

export function runtimeHasStickersEnabled(
  agent: Pick<AgentConfig, "defaults">,
  sessionRuntimeParams?: Record<string, unknown>,
): boolean {
  const sessionStickerDefaults = asStickerDefaults(sessionRuntimeParams?.stickers);
  return agentHasStickersEnabled(agent) || sessionStickerDefaults?.enabled === true;
}

export function stickersAvailableForPrompt(
  agentId: string,
  ctx: Pick<ChannelContext, "channelId" | "channelName">,
  stickers = listStickers(),
): StickerCatalogEntry[] {
  if (!channelSupportsStickers(ctx)) return [];

  return stickers.filter(
    (sticker) =>
      sticker.enabled && stickerAllowedOnChannel(sticker, ctx.channelId) && stickerAllowedForAgent(sticker, agentId),
  );
}

function renderStickerLine(sticker: StickerCatalogEntry): string {
  const avoid = sticker.avoid ? ` Avoid when: ${sticker.avoid}` : "";
  return `- \`${sticker.id}\` — ${sticker.label}: ${sticker.description}${avoid}`;
}

export function buildStickerPromptSection(
  agent: AgentConfig,
  ctx?: ChannelContext,
  options: { sessionRuntimeParams?: Record<string, unknown> } = {},
): PromptContextSection | null {
  if (!ctx || !runtimeHasStickersEnabled(agent, options.sessionRuntimeParams) || !channelSupportsStickers(ctx)) {
    return null;
  }

  const stickers = stickersAvailableForPrompt(agent.id, ctx);
  if (stickers.length === 0) {
    return null;
  }

  return {
    id: "channel.stickers",
    title: "Stickers",
    priority: 85,
    source: "stickers:catalog",
    content: [
      "Stickers are a separate response surface from text replies, emoji reactions, and silent replies.",
      "Use stickers sparingly when a lightweight visual acknowledgment is better than text.",
      "To send one, run `ravi stickers send <id>`.",
      "If the sticker is the whole response, send the sticker and then reply with exactly `@@SILENT@@`; do not also send text.",
      "",
      "Available sticker ids:",
      ...stickers.map(renderStickerLine),
    ].join("\n"),
  };
}
