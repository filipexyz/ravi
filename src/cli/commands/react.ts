/**
 * React Commands - Emoji reactions
 */

import "reflect-metadata";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { getContext } from "../context.js";
import { contractFail, suggestSimilar } from "../agent-contract.js";
import { nats } from "../../nats.js";
import { buildChannelChatActionJob } from "../../channels/outbound-stream.js";
import { publishChannelOutboundJobDurably } from "../../channels/outbound-publish-outbox.js";
import { dbFindChat, dbFindChatMessage, dbGetChatMessage, dbListChatMessages } from "../../router/router-db.js";

const reactSendReturnSchema = z.object({
  status: z.enum(["queued", "accepted"]),
  queued: z.boolean(),
  executionMode: z.enum(["durable", "legacy"]),
  topic: z.string(),
  reaction: z.object({
    messageId: z.string(),
    emoji: z.string(),
  }),
  target: z.object({
    channel: z.string(),
    accountId: z.string(),
    chatId: z.string(),
  }),
  event: z
    .object({
      channel: z.string(),
      accountId: z.string(),
      chatId: z.string(),
      messageId: z.string(),
      emoji: z.string(),
    })
    .passthrough(),
  requestId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  publishedNow: z.boolean().optional(),
  publishPending: z.boolean().optional(),
  nextAttemptAt: z.number().optional(),
});

@Group({
  name: "react",
  description: "Emoji reactions",
  scope: "open",
})
export class ReactCommands {
  @Command({ name: "send", description: "Send an emoji reaction to a message" })
  @CommandAccess({ kind: "mutate", resource: "react", action: "send", risk: "high" })
  @Returns(reactSendReturnSchema)
  async send(
    @Arg("messageId", { description: "Message ID to react to (from [mid:ID] tag)" }) messageId: string,
    @Arg("emoji", { description: "Emoji to react with" }) emoji: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    // Declared UNBRAKED (Manual v2 write classification): an emoji reaction is
    // trivially reversible — WhatsApp replaces a reaction with the next one and
    // removes it with an empty reaction, and the Slack chat_action contract has
    // an explicit remove operation. Braking the cheapest acknowledgement
    // surface would add exit-3 friction to every lightweight ack, so `react
    // send` performs immediately, no --execute required.
    const ctx = getContext();
    const source = ctx?.source;

    if (!source) {
      contractFail(
        "react send",
        "NO_CHANNEL_CONTEXT",
        "No channel context available — cannot determine where to send reaction",
        {
          asJson,
          details: {
            suggestedAction: "Run from a routed channel session; reactions always target the current chat",
          },
        },
      );
    }

    const { channel, accountId, chatId } = source;

    // MESSAGE_NOT_FOUND envelope (Manual v2): validated best-effort against the
    // LOCAL chat ledger. When the current chat is known to the ledger and the
    // message id resolves to nothing there (neither providerMessageId nor
    // canonical cm id), exit 1 with suggestions of real recent provider ids.
    // When the chat itself is not ledgered, validation is skipped (fail-open):
    // an unmatched reaction emit is harmless and reversible.
    const ledgerInstanceId = source.instanceId ?? accountId;
    const ledgerChat = dbFindChat({ channel, instanceId: ledgerInstanceId, platformChatId: chatId });
    if (ledgerChat) {
      const known =
        dbFindChatMessage({
          channel,
          instanceId: ledgerInstanceId,
          chatId: ledgerChat.id,
          providerMessageId: messageId,
        }) ?? dbGetChatMessage(messageId);
      if (!known) {
        const recent = dbListChatMessages(ledgerChat.id, 30);
        contractFail("react send", "MESSAGE_NOT_FOUND", `Message not found in current chat: ${messageId}`, {
          asJson,
          details: {
            suggestedAction:
              "Use a [mid:ID] from a visible message in this chat (or inspect: ravi sessions actions --json)",
            suggestions: suggestSimilar(
              messageId,
              recent.map((message) => message.providerMessageId),
            ),
          },
        });
      }
    }

    const eventPayload = {
      channel,
      accountId,
      chatId,
      messageId,
      emoji,
    };

    if (channel.toLowerCase() === "slack") {
      const canonicalChatId = source.canonicalChatId?.trim();
      if (!canonicalChatId) {
        contractFail(
          "react send",
          "INVALID_TARGET",
          "invalid_target: Slack reactions require a canonical chat target",
          {
            asJson,
            details: {
              suggestedAction: "Run from a Slack-routed session whose source carries canonicalChatId",
            },
          },
        );
      }
      const job = buildChannelChatActionJob({
        sessionName: ctx?.sessionName ?? ctx?.sessionKey ?? ctx?.agentId ?? "cli",
        target: {
          channel: "slack",
          accountId,
          instanceId: source.instanceId ?? accountId,
          chatId,
          canonicalChatId,
          ...(source.threadId ? { threadId: source.threadId } : {}),
        },
        content: {
          type: "chat_action",
          actionId: "message.react",
          providerMessageId: messageId,
          emoji,
          operation: "add",
        },
      });
      const published = await publishChannelOutboundJobDurably(job);
      const payload = {
        status: "queued" as const,
        queued: true,
        executionMode: "durable" as const,
        topic: "ravi.channel.outbound.slack",
        reaction: {
          messageId,
          emoji,
        },
        target: {
          channel,
          accountId,
          chatId,
        },
        event: eventPayload,
        requestId: job.request.requestId,
        idempotencyKey: job.request.idempotencyKey,
        publishedNow: published.ok && published.publishedNow,
        publishPending: !published.ok,
        ...(published.ok ? {} : { nextAttemptAt: published.nextAttemptAt }),
      };
      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(`Queued reaction ${emoji} for message ${messageId}`);
      }
      return payload;
    }

    await nats.emit("ravi.outbound.reaction", eventPayload);

    const payload = {
      status: "accepted" as const,
      queued: false,
      executionMode: "legacy" as const,
      topic: "ravi.outbound.reaction",
      reaction: {
        messageId,
        emoji,
      },
      target: {
        channel,
        accountId,
        chatId,
      },
      event: eventPayload,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Reaction ${emoji} accepted for message ${messageId}`);
    }

    return payload;
  }
}
