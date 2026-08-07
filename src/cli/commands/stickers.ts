/**
 * Sticker Commands - typed sticker catalog and WhatsApp sticker sending
 */

import "reflect-metadata";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { contractDryRun, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { cliOffsetPaginationSchema, looseObjectSchema } from "../return-schemas.js";
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

/**
 * STICKER_NOT_FOUND envelope (Manual v2): the id does not exist in the typed
 * catalog. Suggestions come from the LOCAL catalog (`listStickers`) — ids and
 * labels — a cheap local file read, no live channel call involved.
 */
function failStickerNotFound(op: string, id: string, asJson?: boolean): never {
  const candidates = listStickers().flatMap((sticker) => [sticker.id, sticker.label]);
  contractFail(op, "STICKER_NOT_FOUND", `Sticker not found: ${id}`, {
    asJson,
    details: {
      suggestedAction: "Check the sticker id (list with: ravi stickers list --json)",
      suggestions: suggestSimilar(id, candidates),
    },
  });
}

const stickerReturnSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
    avoid: z.string().nullable(),
    channels: z.array(z.string()),
    agents: z.array(z.string()),
    media: looseObjectSchema,
    enabled: z.boolean(),
    createdAt: z.number().nullable(),
    updatedAt: z.number().nullable(),
  })
  .passthrough();

const stickerMutationReturnSchema = z.object({
  success: z.boolean(),
  action: z.string(),
  sticker: stickerReturnSchema,
});

const stickersListReturnSchema = z.object({
  total: z.number(),
  pagination: cliOffsetPaginationSchema,
  items: z.array(stickerReturnSchema),
  stickers: z.array(stickerReturnSchema),
});

const stickerShowReturnSchema = z.object({
  sticker: stickerReturnSchema,
});

const stickerRemoveReturnSchema = z.object({
  success: z.boolean(),
  action: z.literal("remove"),
  stickerId: z.string(),
});

const stickerSendReturnSchema = z.object({
  success: z.literal(true),
  topic: z.literal("ravi.stickers.send"),
  sticker: z.object({
    id: z.string(),
    label: z.string(),
  }),
  target: z.object({
    channel: z.string(),
    accountId: z.string(),
    chatId: z.string(),
  }),
  event: looseObjectSchema,
});

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
  @CommandAccess({ kind: "mutate", resource: "stickers", action: "add", risk: "medium" })
  @Returns(stickerMutationReturnSchema)
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
    // Declared UNBRAKED: adding a catalog entry is local config, reversible with
    // `stickers remove`, and touches no live channel — no --execute required.
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
  @CommandAccess({ kind: "read", resource: "stickers", action: "list", risk: "low" })
  @Returns(stickersListReturnSchema)
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching stickers to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    const stickers = listStickers();
    const page = paginateCliItems(stickers, { limit, offset });
    const pageStickers = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "stickers", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageStickers.length,
      total: page.total,
    });
    // Compact mode (Manual v2 7.9): narrows the JSON items only; the text list
    // below keeps rendering from the full records.
    const compactItems = pickFields(pageStickers.map(serializeSticker), fields);
    const payload = {
      total: page.total,
      pagination,
      items: compactItems,
      stickers: compactItems,
    };

    if (asJson) {
      printJson(payload);
    } else if (pageStickers.length === 0) {
      console.log("No stickers configured.");
    } else {
      for (const sticker of pageStickers) {
        const state = sticker.enabled ? "enabled" : "disabled";
        console.log(`${sticker.id} — ${sticker.label} (${state})`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }

    return payload;
  }

  @Command({ name: "show", description: "Show one sticker catalog entry" })
  @CommandAccess({ kind: "read", resource: "stickers", action: "show", risk: "low" })
  @Returns(stickerShowReturnSchema)
  show(
    @Arg("id", { description: "Sticker id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sticker = getSticker(id);
    if (!sticker) {
      failStickerNotFound("stickers show", id, asJson);
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
  @CommandAccess({ kind: "mutate", resource: "stickers", action: "remove", risk: "destructive", requiresConfirmation: true })
  @Returns(stickerRemoveReturnSchema)
  remove(
    @Arg("id", { description: "Sticker id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually remove the sticker; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    // Validation BEFORE the brake: unknown id is exit 1 + suggestions, not a
    // dry-run of a removal that could never happen.
    const sticker = getSticker(id);
    if (!sticker) {
      failStickerNotFound("stickers remove", id, asJson);
    }

    if (execute !== true) {
      // Write brake (Manual v2 7.8): removal deletes the catalog entry (the
      // media file reference included) and there is no undo — dry-run by
      // default, exit 3 before touching the catalog.
      contractDryRun(
        "stickers remove",
        {
          stickerId: sticker.id,
          label: sticker.label,
          mediaPath: sticker.media.path,
          enabled: sticker.enabled,
        },
        { asJson },
      );
    }

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
  @CommandAccess({ kind: "mutate", resource: "stickers", action: "send", risk: "high", requiresConfirmation: true })
  @Returns(stickerSendReturnSchema)
  async send(
    @Arg("id", { description: "Sticker id" }) id: string,
    @Option({ flags: "--session <nameOrKey>", description: "Resolve target from a session route" }) session?: string,
    @Option({ flags: "--channel <channel>", description: "Explicit target channel" }) channel?: string,
    @Option({ flags: "--account <id>", description: "Explicit channel account id" }) account?: string,
    @Option({ flags: "--to <chatId>", description: "Explicit target chat id" }) to?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually send the sticker; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    // Validation BEFORE the brake: unknown sticker, missing media, target
    // resolution and channel-capability checks all fail with exit 1 before any
    // dry-run plan is shown.
    const sticker = getSticker(id);
    if (!sticker) {
      failStickerNotFound("stickers send", id, asJson);
    }
    if (!existsSync(sticker.media.path)) {
      contractFail("stickers send", "STICKER_MEDIA_NOT_FOUND", `Sticker media file not found: ${sticker.media.path}`, {
        asJson,
        details: {
          suggestedAction: `Re-add the sticker media (ravi stickers add ${sticker.id} <mediaPath> --overwrite ...)`,
        },
      });
    }

    const target = resolveSendTarget({ channel, account, to, session });
    const eventPayload = buildStickerSendEvent(sticker, target);

    if (execute !== true) {
      // Write brake (Manual v2 7.8): a sticker reaches a real chat on a live
      // channel and cannot be unsent — dry-run by default, exit 3 BEFORE the
      // NATS emit that triggers delivery.
      contractDryRun(
        "stickers send",
        {
          sticker: {
            id: sticker.id,
            label: sticker.label,
          },
          target: {
            channel: eventPayload.channel,
            accountId: eventPayload.accountId,
            chatId: eventPayload.chatId,
            ...(eventPayload.threadId ? { threadId: eventPayload.threadId } : {}),
          },
          filename: eventPayload.filename,
          mimeType: eventPayload.mimeType,
        },
        { asJson },
      );
    }

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
