import { assertChannelSupportsStickers, canonicalChannelId } from "../channels/capabilities.js";
import type { ContextSource } from "../router/router-db.js";
import type { MessageTarget } from "../runtime/message-types.js";
import { stickerAllowedOnChannel, stickerFilename, type StickerCatalogEntry } from "./catalog.js";

export interface StickerSendTarget {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
}

export interface StickerSendEvent extends Record<string, unknown> {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
  stickerId: string;
  label: string;
  filePath: string;
  mimeType: string;
  filename: string;
  replyTopic?: string;
}

export function normalizeStickerSendTarget(
  target: StickerSendTarget | ContextSource | MessageTarget,
): StickerSendTarget {
  return {
    channel: canonicalChannelId(target.channel),
    accountId: target.accountId,
    chatId: target.chatId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
  };
}

export function buildStickerSendEvent(sticker: StickerCatalogEntry, target: StickerSendTarget): StickerSendEvent {
  const normalizedTarget = normalizeStickerSendTarget(target);
  assertChannelSupportsStickers({
    channelId: normalizedTarget.channel,
    channelName: normalizedTarget.channel,
  });

  if (!sticker.enabled) {
    throw new Error(`Sticker is disabled: ${sticker.id}`);
  }

  if (!stickerAllowedOnChannel(sticker, normalizedTarget.channel)) {
    throw new Error(`Sticker ${sticker.id} is not allowed on channel: ${normalizedTarget.channel}`);
  }

  return {
    channel: normalizedTarget.channel,
    accountId: normalizedTarget.accountId,
    chatId: normalizedTarget.chatId,
    ...(normalizedTarget.threadId ? { threadId: normalizedTarget.threadId } : {}),
    stickerId: sticker.id,
    label: sticker.label,
    filePath: sticker.media.path,
    mimeType: sticker.media.mimeType ?? "application/octet-stream",
    filename: stickerFilename(sticker),
  };
}
