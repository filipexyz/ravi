/**
 * Media Commands - Send media files (images, videos, audio, documents)
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { sendMediaWithOmniCli } from "../media-send.js";

@Group({
  name: "media",
  description: "Media sending",
  scope: "open",
})
export class MediaCommands {
  @Command({ name: "send", description: "Send a media file (image, video, audio, document)" })
  async send(
    @Arg("filePath", { description: "Path to the file to send" }) filePath: string,
    @Option({ flags: "--caption <text>", description: "Caption for the media" }) caption?: string,
    @Option({ flags: "--channel <channel>", description: "Target channel (informational override)" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Target chat ID" }) to?: string,
    @Option({ flags: "--account <id>", description: "Ravi account/instance alias" }) account?: string,
    @Option({ flags: "--thread-id <id>", description: "Thread/topic ID override" }) threadId?: string,
    @Option({ flags: "--ptt", description: "Send audio as voice note (PTT)" }) ptt?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const sent = await sendMediaWithOmniCli({
        filePath,
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
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
