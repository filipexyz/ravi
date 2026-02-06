/**
 * Media Commands - Send media files (images, videos, audio, documents)
 */

import "reflect-metadata";
import { readFileSync, existsSync } from "fs";
import { basename, extname } from "path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { getContext, fail } from "../context.js";
import { notif } from "../../notif.js";
import type { OutboundMedia } from "../../channels/types.js";

/** Extension → mimetype map */
const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
};

/** Detect media type from mimetype */
function mediaType(mime: string): OutboundMedia["type"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

@Group({
  name: "media",
  description: "Media sending",
})
export class MediaCommands {
  @Command({ name: "send", description: "Send a media file (image, video, audio, document)" })
  async send(
    @Arg("filePath", { description: "Path to the file to send" }) filePath: string,
    @Option({ flags: "--caption <text>", description: "Caption for the media" }) caption?: string,
    @Option({ flags: "--channel <channel>", description: "Target channel (e.g. whatsapp, matrix)" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Target chat ID" }) to?: string,
    @Option({ flags: "--account <id>", description: "Account ID" }) account?: string,
  ) {
    // Validate file exists
    if (!existsSync(filePath)) {
      fail(`File not found: ${filePath}`);
    }

    // Read file
    const data = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const filename = basename(filePath);
    const mimetype = MIME_MAP[ext] ?? "application/octet-stream";
    const type = mediaType(mimetype);

    // Resolve target
    let targetChannel = channel;
    let targetAccount = account;
    let targetChat = to;

    if (!targetChannel || !targetChat) {
      const ctx = getContext();
      const source = ctx?.source;
      if (!source) {
        fail("No channel context available — use --channel, --to, and --account to specify target");
      }
      targetChannel = targetChannel ?? source.channel;
      targetAccount = targetAccount ?? source.accountId;
      targetChat = targetChat ?? source.chatId;
    }

    const media: OutboundMedia = {
      type,
      data,
      mimetype,
      filename,
      ...(caption ? { caption } : {}),
    };

    await notif.emit("ravi.media.send", {
      channel: targetChannel,
      accountId: targetAccount,
      chatId: targetChat,
      media,
      caption,
    });

    console.log(`✓ ${type} sent: ${filename} (${(data.length / 1024).toFixed(1)}KB)`);
    return { success: true, filename, type, channel: targetChannel, chatId: targetChat };
  }
}
