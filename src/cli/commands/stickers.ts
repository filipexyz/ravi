/**
 * Sticker Commands - typed sticker catalog and WhatsApp sticker sending
 */

import "reflect-metadata";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { nats } from "../../nats.js";
import { configStore } from "../../config-store.js";
import { dbGetChat, dbGetSessionChatBinding } from "../../router/router-db.js";
import { resolveSession } from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import {
  addSticker,
  getSticker,
  listStickers,
  removeSticker,
  type StickerCatalogEntry,
} from "../../stickers/catalog.js";
import { buildStickerSendEvent, type StickerSendTarget } from "../../stickers/send.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeSticker(sticker: StickerCatalogEntry): Record<string, unknown> {
  return {
    id: sticker.id,
    label: sticker.label,
    description: sticker.description,
    avoid: sticker.avoid ?? null,
    channels: sticker.channels,
    agents: sticker.agents,
    media: sticker.media,
    enabled: sticker.enabled,
    createdAt: sticker.createdAt ?? null,
    updatedAt: sticker.updatedAt ?? null,
  };
}

function targetFromSession(session: SessionEntry): StickerSendTarget | null {
  const binding = dbGetSessionChatBinding(session.sessionKey);
  const chat = binding ? dbGetChat(binding.chatId) : null;
  if (chat) {
    const accountId = configStore.resolveAccountName(chat.instanceId) ?? session.lastAccountId ?? chat.instanceId;
    const separator = chat.platformChatId.indexOf("#");
    const chatId = separator === -1 ? chat.platformChatId : chat.platformChatId.slice(0, separator);
    const threadId = separator === -1 ? undefined : chat.platformChatId.slice(separator + 1);
    if (accountId && chatId) {
      return {
        channel: chat.channel,
        accountId,
        chatId,
        ...(threadId ? { threadId } : {}),
      };
    }
  }

  if (session.lastChannel && session.lastAccountId && session.lastTo) {
    return {
      channel: session.lastChannel,
      accountId: session.lastAccountId,
      chatId: session.lastTo,
      ...(session.lastThreadId ? { threadId: session.lastThreadId } : {}),
    };
  }

  if (!session.lastContext) return null;

  try {
    const parsed = JSON.parse(session.lastContext) as {
      channelId?: unknown;
      accountId?: unknown;
      chatId?: unknown;
    };
    if (
      typeof parsed.channelId === "string" &&
      typeof parsed.accountId === "string" &&
      typeof parsed.chatId === "string"
    ) {
      return {
        channel: parsed.channelId,
        accountId: parsed.accountId,
        chatId: parsed.chatId,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function resolveSendTarget(options: {
  channel?: string;
  account?: string;
  to?: string;
  session?: string;
}): StickerSendTarget {
  if (options.channel || options.account || options.to) {
    if (!options.channel || !options.account || !options.to) {
      fail("Explicit sticker target requires --channel, --account, and --to together");
    }
    return {
      channel: options.channel,
      accountId: options.account,
      chatId: options.to,
    };
  }

  const ctx = getContext();
  if (ctx?.source) {
    return {
      channel: ctx.source.channel,
      accountId: ctx.source.accountId,
      chatId: ctx.source.chatId,
    };
  }

  const sessionRef = options.session ?? ctx?.sessionName ?? ctx?.sessionKey;
  if (sessionRef) {
    const session = resolveSession(sessionRef);
    if (!session) {
      fail(`Session not found: ${sessionRef}`);
    }
    const target = targetFromSession(session);
    if (target) return target;
  }

  fail("No channel context available — use from a routed session or pass --channel, --account, and --to");
}

@Group({
  name: "stickers",
  description: "Sticker library management and sending",
  scope: "open",
})
export class StickerCommands {
  @Command({ name: "add", description: "Add or update a sticker catalog entry" })
  add(
    @Arg("id", { description: "Stable sticker id (lowercase, digits, dash or underscore)" }) id: string,
    @Arg("mediaPath", { description: "Local sticker media file path" }) mediaPath: string,
    @Option({ flags: "--label <text>", description: "Human label shown to operators" }) label?: string,
    @Option({ flags: "--description <text>", description: "Natural usage description for prompts" })
    description?: string,
    @Option({ flags: "--avoid <text>", description: "When not to use this sticker" }) avoid?: string,
    @Option({ flags: "--channels <csv>", description: "Channel allowlist (default: whatsapp)" }) channels?: string,
    @Option({ flags: "--agents <csv>", description: "Agent allowlist (default: all agents)" }) agents?: string,
    @Option({ flags: "--disabled", description: "Add the sticker disabled" }) disabled?: boolean,
    @Option({ flags: "--overwrite", description: "Overwrite an existing sticker id" }) overwrite?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!description?.trim()) {
      fail("Missing --description. Sticker prompts need a natural usage description.");
    }

    const sticker = addSticker(
      {
        id,
        label: label?.trim() || id,
        description,
        ...(avoid?.trim() ? { avoid } : {}),
        channels: parseCsv(channels) ?? ["whatsapp"],
        agents: parseCsv(agents) ?? [],
        media: {
          kind: "file",
          path: resolve(mediaPath),
        },
        enabled: disabled !== true,
      },
      { overwrite },
    );

    const payload = {
      success: true,
      action: "add",
      sticker: serializeSticker(sticker),
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Sticker saved: ${sticker.id}`);
    }

    return payload;
  }

  @Command({ name: "list", description: "List stickers in the typed catalog" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const stickers = listStickers();
    const payload = {
      total: stickers.length,
      stickers: stickers.map(serializeSticker),
    };

    if (asJson) {
      printJson(payload);
    } else if (stickers.length === 0) {
      console.log("No stickers configured.");
    } else {
      for (const sticker of stickers) {
        const state = sticker.enabled ? "enabled" : "disabled";
        console.log(`${sticker.id} — ${sticker.label} (${state})`);
      }
    }

    return payload;
  }

  @Command({ name: "show", description: "Show one sticker catalog entry" })
  show(
    @Arg("id", { description: "Sticker id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sticker = getSticker(id);
    if (!sticker) {
      fail(`Sticker not found: ${id}`);
    }

    const payload = {
      sticker: serializeSticker(sticker),
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`${sticker.id} — ${sticker.label}`);
      console.log(sticker.description);
      if (sticker.avoid) console.log(`Avoid: ${sticker.avoid}`);
      console.log(`Channels: ${sticker.channels.join(", ")}`);
      console.log(`Agents: ${sticker.agents.length > 0 ? sticker.agents.join(", ") : "all"}`);
      console.log(`Enabled: ${sticker.enabled ? "yes" : "no"}`);
    }

    return payload;
  }

  @Command({ name: "remove", description: "Remove a sticker catalog entry" })
  remove(
    @Arg("id", { description: "Sticker id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const removed = removeSticker(id);
    const payload = {
      success: removed,
      action: "remove",
      stickerId: id,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(removed ? `✓ Sticker removed: ${id}` : `Sticker not found: ${id}`);
    }

    return payload;
  }

  @Command({ name: "send", description: "Send a sticker to the current WhatsApp chat" })
  async send(
    @Arg("id", { description: "Sticker id" }) id: string,
    @Option({ flags: "--session <nameOrKey>", description: "Resolve target from a session route" }) session?: string,
    @Option({ flags: "--channel <channel>", description: "Explicit target channel" }) channel?: string,
    @Option({ flags: "--account <id>", description: "Explicit channel account id" }) account?: string,
    @Option({ flags: "--to <chatId>", description: "Explicit target chat id" }) to?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sticker = getSticker(id);
    if (!sticker) {
      fail(`Sticker not found: ${id}`);
    }
    if (!existsSync(sticker.media.path)) {
      fail(`Sticker media file not found: ${sticker.media.path}`);
    }

    const target = resolveSendTarget({ channel, account, to, session });
    const eventPayload = buildStickerSendEvent(sticker, target);

    await nats.emit("ravi.stickers.send", { ...eventPayload });

    const payload = {
      success: true,
      topic: "ravi.stickers.send",
      sticker: {
        id: sticker.id,
        label: sticker.label,
      },
      target: {
        channel: eventPayload.channel,
        accountId: eventPayload.accountId,
        chatId: eventPayload.chatId,
      },
      event: eventPayload,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Sticker queued: ${sticker.id}`);
    }

    return payload;
  }
}
