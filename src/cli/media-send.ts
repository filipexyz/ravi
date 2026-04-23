import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, basename, extname } from "node:path";
import { getContext } from "./context.js";
import { configStore } from "../config-store.js";

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

export type MediaType = "image" | "video" | "audio" | "document";

export interface MediaSendTargetInput {
  channel?: string;
  accountId?: string;
  chatId?: string;
  threadId?: string;
}

export interface ResolvedMediaSendTarget {
  channel?: string;
  accountId: string;
  instanceId: string;
  chatId: string;
  threadId?: string;
}

export interface OmniSendExecution {
  transport: "omni-send";
  args: string[];
  success: true;
  message?: string;
  messageId?: string;
  status?: string;
  raw?: unknown;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractErrorMessage(json: Record<string, unknown> | null, fallback: string): string {
  if (!json) return fallback;
  const error = json.error;
  if (typeof error === "string" && error.trim()) return error;
  const message = json.message;
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}

function normalizeOutboundChatId(chatId: string): string {
  if (chatId.startsWith("group:")) {
    return `${chatId.slice("group:".length)}@g.us`;
  }
  return chatId;
}

export function inferMediaMimeType(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function inferMediaType(mime: string): MediaType {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

export function resolveMediaSendTarget(input: MediaSendTargetInput = {}): ResolvedMediaSendTarget {
  const source = getContext()?.source;
  const accountId = input.accountId ?? source?.accountId;
  const chatId = input.chatId ?? source?.chatId;
  const channel = input.channel ?? source?.channel;
  const threadId = input.threadId ?? source?.threadId;

  if (!accountId || !chatId) {
    throw new Error("No target context available — use --account and --to, or run from a chat session.");
  }

  const instanceId = configStore.resolveInstanceId(accountId);
  if (!instanceId) {
    throw new Error(`No omni instance mapped for account "${accountId}".`);
  }

  return {
    ...(channel ? { channel } : {}),
    accountId,
    instanceId,
    chatId: normalizeOutboundChatId(chatId),
    ...(threadId ? { threadId } : {}),
  };
}

export async function sendMediaWithOmniCli(args: {
  filePath: string;
  caption?: string;
  type?: MediaType;
  filename?: string;
  voiceNote?: boolean;
  target?: MediaSendTargetInput;
}): Promise<{
  filePath: string;
  filename: string;
  mimeType: string;
  type: MediaType;
  target: ResolvedMediaSendTarget;
  delivery: OmniSendExecution;
}> {
  const absPath = resolve(args.filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const mimeType = inferMediaMimeType(absPath);
  const type = args.type ?? inferMediaType(mimeType);
  const filename = args.filename ?? basename(absPath);
  const target = resolveMediaSendTarget(args.target);

  const omniArgs = ["send", "--instance", target.instanceId, "--to", target.chatId, "--media", absPath];

  if (args.caption) {
    omniArgs.push("--caption", args.caption);
  }
  if (args.voiceNote === true && type === "audio") {
    omniArgs.push("--voice");
  }
  if (target.threadId) {
    omniArgs.push("--thread-id", target.threadId);
  }

  const execution = await new Promise<OmniSendExecution>((resolveExecution, rejectExecution) => {
    const child = spawn("omni", omniArgs, {
      env: {
        ...process.env,
        OMNI_FORMAT: "json",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        rejectExecution(new Error("omni CLI not found in PATH."));
        return;
      }
      rejectExecution(error);
    });
    child.on("close", (code) => {
      const stdoutJson = parseJsonObject(stdout);
      const stderrJson = parseJsonObject(stderr);

      if (code !== 0) {
        const fallback = stderr.trim() || stdout.trim() || `omni send failed with exit code ${code ?? "unknown"}.`;
        rejectExecution(new Error(extractErrorMessage(stderrJson ?? stdoutJson, fallback)));
        return;
      }

      if (!stdoutJson) {
        rejectExecution(new Error(`omni send returned non-JSON stdout: ${stdout.trim() || "<empty>"}`));
        return;
      }

      const data = stdoutJson.data;
      const raw = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
      resolveExecution({
        transport: "omni-send",
        args: omniArgs,
        success: true,
        ...(typeof stdoutJson.message === "string" ? { message: stdoutJson.message } : {}),
        ...(raw && typeof raw.messageId === "string" ? { messageId: raw.messageId } : {}),
        ...(raw && typeof raw.status === "string" ? { status: raw.status } : {}),
        ...(raw ? { raw } : {}),
      });
    });
  });

  return {
    filePath: absPath,
    filename,
    mimeType,
    type,
    target,
    delivery: execution,
  };
}
