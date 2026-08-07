/**
 * Media Commands - Send media files (images, videos, audio, documents)
 */

import "reflect-metadata";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { getContext } from "../context.js";
import { contractDryRun, contractFail } from "../agent-contract.js";
import { looseObjectSchema } from "../return-schemas.js";
import { inferMediaMimeType, inferMediaType, sendMediaWithOmniCli } from "../media-send.js";

const mediaSendReturnSchema = z.object({
  success: z.literal(true),
  media: z
    .object({
      filePath: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      type: z.string(),
      caption: z.string().optional(),
      voiceNote: z.boolean(),
    })
    .passthrough(),
  target: z
    .object({
      channel: z.string().optional(),
      accountId: z.string(),
      instanceId: z.string(),
      chatId: z.string(),
      threadId: z.string().optional(),
    })
    .passthrough(),
  delivery: looseObjectSchema,
});

@Group({
  name: "media",
  description: "Media sending",
  scope: "open",
})
export class MediaCommands {
  @Command({ name: "send", description: "Send a media file (image, video, audio, document)" })
  @CommandAccess({ kind: "mutate", resource: "media", action: "send", risk: "high", requiresConfirmation: true })
  @Returns(mediaSendReturnSchema)
  async send(
    @Arg("filePath", { description: "Path to the file to send" }) filePath: string,
    @Option({ flags: "--caption <text>", description: "Caption for the media" }) caption?: string,
    @Option({ flags: "--channel <channel>", description: "Target channel (informational override)" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Target chat ID" }) to?: string,
    @Option({ flags: "--account <id>", description: "Ravi account/instance alias" }) account?: string,
    @Option({ flags: "--thread-id <id>", description: "Thread/topic ID override" }) threadId?: string,
    @Option({ flags: "--ptt", description: "Send audio as voice note (PTT)" }) ptt?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually send the media; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    // Validation BEFORE the brake: a missing file is an execution error (exit 1),
    // not something --execute should be spent on.
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      contractFail("media send", "FILE_NOT_FOUND", `File not found: ${absPath}`, {
        asJson,
        details: {
          suggestedAction: "Check the local file path (the file must exist on this machine) and re-run",
        },
      });
    }

    const mimeType = inferMediaMimeType(absPath);
    const type = inferMediaType(mimeType);
    const source = getContext()?.source;

    if (execute !== true) {
      // Write brake (Manual v2 7.8): media reaches a real chat on a live channel
      // and cannot be reliably unsent, so dry-run by default and exit 3 BEFORE
      // any omni/Slack delivery call.
      contractDryRun(
        "media send",
        {
          filePath: absPath,
          filename: basename(absPath),
          mimeType,
          type,
          caption: caption ?? null,
          voiceNote: ptt === true,
          target: {
            channel: channel ?? source?.channel ?? null,
            accountId: account ?? source?.accountId ?? null,
            chatId: to ?? source?.chatId ?? null,
            threadId: threadId ?? source?.threadId ?? null,
          },
        },
        { asJson },
      );
    }

    try {
      const sent = await sendMediaWithOmniCli({
        filePath: absPath,
        caption,
        voiceNote: ptt === true,
        target: {
          ...(channel ? { channel } : {}),
          ...(account ? { accountId: account } : {}),
          ...(to ? { chatId: to } : {}),
          ...(threadId ? { threadId } : {}),
        },
      });

      const payload = {
        success: true,
        media: {
          filePath: sent.filePath,
          filename: sent.filename,
          mimeType: sent.mimeType,
          type: sent.type,
          ...(caption ? { caption } : {}),
          voiceNote: ptt === true && sent.type === "audio",
        },
        target: {
          ...(sent.target.channel ? { channel: sent.target.channel } : {}),
          accountId: sent.target.accountId,
          instanceId: sent.target.instanceId,
          chatId: sent.target.chatId,
          ...(sent.target.threadId ? { threadId: sent.target.threadId } : {}),
        },
        delivery: sent.delivery,
      };

      if (asJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const deliverySuffix = sent.delivery.messageId ? ` (${sent.delivery.messageId})` : "";
        console.log(`✓ ${sent.type} sent: ${sent.filename}${deliverySuffix}`);
      }

      return payload;
    } catch (error) {
      contractFail("media send", "MEDIA_SEND_FAILED", error instanceof Error ? error.message : String(error), {
        asJson,
        details: {
          retryable: true,
          suggestedAction: "Check the target (--account/--to or session context) and channel availability, then retry",
        },
      });
    }
  }
}
