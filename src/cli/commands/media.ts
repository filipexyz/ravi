/**
 * Media Commands - Send media files (images, videos, audio, documents)
 */

import "reflect-metadata";
import { existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { Group, Command, Arg, Option } from "../decorators.js";
import { getContext, fail } from "../context.js";
import { nats } from "../../nats.js";
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

type MediaType = "image" | "video" | "audio" | "document";

/** Detect media type from mimetype */
function mediaType(mime: string): MediaType {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

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
    @Option({ flags: "--channel <channel>", description: "Target channel (e.g. whatsapp, matrix)" }) channel?: string,
    @Option({ flags: "--to <chatId>", description: "Target chat ID" }) to?: string,
    @Option({ flags: "--account <id>", description: "Account ID" }) account?: string,
    @Option({ flags: "--ptt", description: "Send audio as voice note (PTT)" }) ptt?: boolean,
  ) {
    const absPath = resolve(filePath);

    // Validate file exists
    if (!existsSync(absPath)) {
      fail(`File not found: ${absPath}`);
    }

    const ext = extname(absPath).toLowerCase();
    const filename = basename(absPath);
    const mimetype = MIME_MAP[ext] ?? "application/octet-stream";
    const type = mediaType(mimetype);

    // Resolve target: fill missing fields from context
    const source = getContext()?.source;
    const targetChannel = channel ?? source?.channel;
    const targetAccount = account ?? source?.accountId;
    const targetChat = to ?? source?.chatId;

    if (!targetChannel || !targetAccount || !targetChat) {
      fail("No channel context available — use --channel, --to, and --account to specify target");
    }

    await nats.emit("ravi.media.send", {
      channel: targetChannel,
      accountId: targetAccount,
      chatId: targetChat,
      filePath: absPath,
      mimetype,
      type,
      filename,
      caption,
      ...(ptt && type === "audio" ? { voiceNote: true } : {}),
    });

    console.log(`✓ ${type} queued: ${filename}`);
    return { success: true, filename, type, channel: targetChannel, chatId: targetChat };
  }
}
