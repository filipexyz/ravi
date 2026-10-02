import { existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { getContext } from "./context.js";
import { configStore } from "../config-store.js";
import { CHANNEL_TRANSPORT_ERROR_CODES, ChannelTransportError } from "../channels/outbound/errors.js";
import { classifyInstanceRoute, type SenderRoutingConfig } from "../channels/outbound/router.js";
import { sendSlackMedia, type SlackMediaSendInput, type SlackNativeMediaDelivery } from "../channels/slack/media.js";
import { createWhatsAppClient, type WhatsAppClient } from "../channels/whatsapp/client.js";
import { WHATSAPP_RPC_ERROR_CODES } from "../channels/whatsapp/contract.js";
import { WHATSAPP_RUNNER_UNAVAILABLE_MESSAGE } from "../channels/whatsapp/rpc-client.js";
import type { LegacyBridgeSendExecution } from "./media-send-omni.js";

export type { LegacyBridgeSendExecution } from "./media-send-omni.js";

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

/** Media sent by the `ravi channels` runner for a WhatsApp instance. */
export interface WhatsAppMediaDelivery {
  transport: "whatsapp";
  success: true;
  messageId?: string;
  status?: string;
  raw?: unknown;
}

export type MediaSendExecution = LegacyBridgeSendExecution | SlackNativeMediaDelivery | WhatsAppMediaDelivery;

type LegacyBridgeMediaModule = Pick<typeof import("./media-send-omni.js"), "sendMediaWithOmniCli">;

export interface MediaSendDependencies {
  sendSlackMedia?: (input: SlackMediaSendInput) => Promise<SlackNativeMediaDelivery>;
  /** WhatsApp runner client. Defaults to `createWhatsAppClient()`. */
  whatsappClient?: Pick<WhatsAppClient, "messages">;
  /** Live routing config used to classify the instance. Defaults to `configStore.getConfig()`. */
  getRoutingConfig?: () => SenderRoutingConfig;
  /** Legacy bridge (Telegram/Discord) media sender. Defaults to a dynamic import of media-send-omni.js. */
  loadLegacyBridge?: () => Promise<LegacyBridgeMediaModule>;
}

/** Contract failure for a transport error raised by `sendChannelMedia` (runner, routing or provider). */
export interface ChannelMediaFailure {
  code: string;
  message: string;
  retryable: boolean;
  suggestedAction?: string;
}

function suggestedActionFor(error: ChannelTransportError): string | undefined {
  switch (error.code) {
    case WHATSAPP_RPC_ERROR_CODES.runnerUnavailable:
      return WHATSAPP_RUNNER_UNAVAILABLE_MESSAGE;
    case WHATSAPP_RPC_ERROR_CODES.notBound:
      return "Connect the WhatsApp instance first: ravi instances connect <name>";
    case CHANNEL_TRANSPORT_ERROR_CODES.instanceNotFound:
      return "Check the account with `ravi instances list`, or pass --account explicitly.";
    case CHANNEL_TRANSPORT_ERROR_CODES.providerUnsupported:
      return "Use a WhatsApp instance (channel whatsapp) served by the ravi channels runner.";
    default:
      return undefined;
  }
}

/**
 * Map a ChannelTransportError (including WhatsAppRpcError) to a contract failure that keeps
 * its code and retryability. Returns null for any other error.
 */
export function mapChannelMediaFailure(error: unknown): ChannelMediaFailure | null {
  if (!(error instanceof ChannelTransportError)) return null;
  const suggestedAction = suggestedActionFor(error);
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(suggestedAction ? { suggestedAction } : {}),
  };
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

  const instanceId = channel?.toLowerCase() === "slack" ? accountId : configStore.resolveInstanceId(accountId);
  if (!instanceId) {
    throw new Error(`No instance mapped for account "${accountId}".`);
  }

  return {
    ...(channel ? { channel } : {}),
    accountId,
    instanceId,
    chatId: normalizeOutboundChatId(chatId),
    ...(threadId ? { threadId } : {}),
  };
}

/**
 * Send a local file to the resolved chat. The instance is classified like the outbound
 * router does: Slack → native Slack upload; WhatsApp (bound or not) → the `ravi channels`
 * runner (`messages.sendMedia`, absolute path; never Omni); an unsupported WhatsApp-family
 * provider or an unknown instance → ChannelTransportError; Telegram/Discord → the legacy
 * bridge (`omni send`, loaded on demand).
 */
export async function sendChannelMedia(
  args: {
    filePath: string;
    caption?: string;
    type?: MediaType;
    filename?: string;
    voiceNote?: boolean;
    target?: MediaSendTargetInput;
  },
  dependencies: MediaSendDependencies = {},
): Promise<{
  filePath: string;
  filename: string;
  mimeType: string;
  type: MediaType;
  target: ResolvedMediaSendTarget;
  delivery: MediaSendExecution;
}> {
  const absPath = resolve(args.filePath);
  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const mimeType = inferMediaMimeType(absPath);
  const type = args.type ?? inferMediaType(mimeType);
  const filename = args.filename ?? basename(absPath);
  const target = resolveMediaSendTarget(args.target);
  const sent = (delivery: MediaSendExecution) => ({ filePath: absPath, filename, mimeType, type, target, delivery });

  if (target.channel?.toLowerCase() === "slack") {
    return sent(
      await (dependencies.sendSlackMedia ?? sendSlackMedia)({
        accountId: target.accountId,
        chatId: target.chatId,
        filePath: absPath,
        filename,
        ...(args.caption ? { caption: args.caption } : {}),
        ...(target.threadId ? { threadId: target.threadId } : {}),
      }),
    );
  }

  const config = (dependencies.getRoutingConfig ?? (() => configStore.getConfig()))();
  const route = classifyInstanceRoute(config, target.instanceId);

  if (route === "whatsapp") {
    // The channel runner reads the file from disk; a runner failure surfaces as is (no Omni fallback).
    const client = dependencies.whatsappClient ?? createWhatsAppClient();
    const result = await client.messages.sendMedia(target.instanceId, {
      to: target.chatId,
      type,
      filePath: absPath,
      filename,
      mimeType,
      ...(args.caption ? { caption: args.caption } : {}),
      ...(args.voiceNote === true && type === "audio" ? { voiceNote: true } : {}),
    });
    return sent({
      transport: "whatsapp",
      success: true,
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(result.status ? { status: result.status } : {}),
      raw: result,
    });
  }

  if (route === "unsupported") {
    throw new ChannelTransportError(
      `Instance ${target.instanceId} (account "${target.accountId}") uses a WhatsApp provider ravi does not support (only WhatsApp via Baileys)`,
      {
        status: 422,
        code: CHANNEL_TRANSPORT_ERROR_CODES.providerUnsupported,
        retryable: false,
        details: { instanceId: target.instanceId },
      },
    );
  }

  if (route === "unknown") {
    throw new ChannelTransportError(`Instance ${target.instanceId} (account "${target.accountId}") not found`, {
      status: 404,
      code: CHANNEL_TRANSPORT_ERROR_CODES.instanceNotFound,
      retryable: false,
      details: { instanceId: target.instanceId },
    });
  }

  const bridge = await (dependencies.loadLegacyBridge ?? (() => import("./media-send-omni.js")))();
  return sent(
    await bridge.sendMediaWithOmniCli({
      filePath: absPath,
      type,
      target,
      ...(args.caption ? { caption: args.caption } : {}),
      ...(args.voiceNote === true ? { voiceNote: true } : {}),
    }),
  );
}
