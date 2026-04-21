import type { ChannelContext } from "../runtime/message-types.js";

export type ChannelCapability = "polls" | "reactions" | "stickers";

export interface ChannelCapabilitySet {
  readonly channelId: string;
  readonly displayName: string;
  readonly capabilities: readonly ChannelCapability[];
}

const CHANNEL_ALIASES: Record<string, string> = {
  whatsapp: "whatsapp",
  "whatsapp-baileys": "whatsapp",
  "whatsapp baileys": "whatsapp",
  matrix: "matrix",
  tui: "tui",
};

const CHANNEL_CAPABILITIES: Record<string, ChannelCapabilitySet> = {
  whatsapp: {
    channelId: "whatsapp",
    displayName: "WhatsApp",
    capabilities: ["polls", "reactions", "stickers"],
  },
  matrix: {
    channelId: "matrix",
    displayName: "Matrix",
    capabilities: ["reactions"],
  },
  tui: {
    channelId: "tui",
    displayName: "TUI",
    capabilities: [],
  },
};

export function canonicalChannelId(channel: string | undefined): string {
  const normalized = (channel ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  return CHANNEL_ALIASES[normalized] ?? normalized;
}

export function resolveChannelCapabilitySet(
  input: Pick<ChannelContext, "channelId" | "channelName">,
): ChannelCapabilitySet {
  const canonical = canonicalChannelId(input.channelId);
  const byId = CHANNEL_CAPABILITIES[canonical];
  if (byId) return byId;

  const byName = CHANNEL_CAPABILITIES[canonicalChannelId(input.channelName)];
  if (byName) return byName;

  return {
    channelId: canonical,
    displayName: input.channelName || input.channelId || "Unknown",
    capabilities: [],
  };
}

export function channelCapabilities(
  input: Pick<ChannelContext, "channelId" | "channelName">,
): readonly ChannelCapability[] {
  return resolveChannelCapabilitySet(input).capabilities;
}

export function supportsChannelCapability(
  input: Pick<ChannelContext, "channelId" | "channelName">,
  capability: ChannelCapability,
): boolean {
  return channelCapabilities(input).includes(capability);
}

export function channelSupportsStickers(input: Pick<ChannelContext, "channelId" | "channelName">): boolean {
  return supportsChannelCapability(input, "stickers");
}

export function assertChannelSupportsStickers(input: Pick<ChannelContext, "channelId" | "channelName">): void {
  if (!channelSupportsStickers(input)) {
    const label = input.channelName || input.channelId || "unknown";
    throw new Error(`Stickers are not supported on channel: ${label}`);
  }
}

export function renderChannelCapabilities(input: Pick<ChannelContext, "channelId" | "channelName">): string {
  const capabilities = channelCapabilities(input);
  return capabilities.length > 0 ? capabilities.join(",") : "none";
}
