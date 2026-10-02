/**
 * Per-instance outbound routing, deny by default.
 *
 * - A canonical WhatsApp instance (bound or not) goes to the WhatsApp sender; an
 *   unbound one fails there with 404 WHATSAPP_NOT_BOUND and never reaches the bridge.
 * - A WhatsApp-family provider ravi does not serve (twilio-whatsapp, gupshup, …) fails
 *   with 422 CHANNEL_PROVIDER_UNSUPPORTED.
 * - Any other instance record goes to the legacy bridge (Telegram/Discord), or fails
 *   with 503 LEGACY_BRIDGE_NOT_CONFIGURED when there is none.
 * - A ref with no instance record fails with 404 INSTANCE_NOT_FOUND.
 */

import { configStore } from "../../config-store.js";
import type { InstanceConfig } from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import { logger } from "../../utils/logger.js";
import { isWhatsAppChannelType, isWhatsAppFamilyChannelType, resolveWhatsAppBinding } from "../whatsapp/contract.js";
import { CHANNEL_TRANSPORT_ERROR_CODES, ChannelTransportError } from "./errors.js";
import type {
  ChannelMediaType,
  ChannelMessageSender,
  ChannelReactionTarget,
  ChannelSendOptions,
  ChannelSendResult,
} from "./sender.js";

const log = logger.child("channels:outbound-router");

export type ChannelSenderRoute = "whatsapp" | "bridge" | "unsupported" | "unknown";
export type SenderRoutingConfig = Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;

function findInstanceRecord(config: SenderRoutingConfig, ref: string): InstanceConfig | null {
  const instances = config.instances ?? {};
  const live = (record: InstanceConfig | undefined) => (record && !record.deletedAt ? record : null);
  const byName = live(instances[ref]);
  if (byName) return byName;
  const accountName = config.instanceToAccount?.[ref];
  const byAccount = accountName ? live(instances[accountName]) : null;
  if (byAccount) return byAccount;
  return Object.values(instances).find((record) => !record.deletedAt && record.instanceId?.trim() === ref) ?? null;
}

/**
 * Default-deny classification of an instance ref (UUID or account name). The first rule that matches wins:
 * 1. resolveWhatsAppBinding(config, ref) hit                                   → "whatsapp"
 * 2. instance record found (by name, or via instanceToAccount[ref] for a UUID, or a record whose
 *    instanceId === ref):
 *      isWhatsAppChannelType(record.channel)                                    → "whatsapp" (unbound: the
 *                                                                                 WhatsApp client answers 404
 *                                                                                 WHATSAPP_NOT_BOUND)
 *      isWhatsAppFamilyChannelType(record.channel)                              → "unsupported"
 *      otherwise                                                                → "bridge"
 * 3. no record                                                                  → "unknown"
 * Deleted records (deletedAt) count as "no record".
 */
export function classifyInstanceRoute(config: SenderRoutingConfig, instanceId: string): ChannelSenderRoute {
  const ref = instanceId.trim();
  if (!ref) return "unknown";
  if (resolveWhatsAppBinding(config, ref)) return "whatsapp";
  const record = findInstanceRecord(config, ref);
  if (!record) return "unknown";
  if (isWhatsAppChannelType(record.channel)) return "whatsapp";
  if (isWhatsAppFamilyChannelType(record.channel)) return "unsupported";
  return "bridge";
}

export interface ChannelSenderRouterOptions {
  whatsapp: ChannelMessageSender;
  /** Legacy bridge sender (Telegram/Discord). Null → bridge routes fail with LEGACY_BRIDGE_NOT_CONFIGURED. */
  bridge?: ChannelMessageSender | null;
  /** Default configStore.getConfig(). */
  getConfig?: () => SenderRoutingConfig;
}

export interface ChannelSenderRouter extends ChannelMessageSender {
  routeFor(instanceId: string): ChannelSenderRoute;
  readonly hasBridge: boolean;
}

function routeError(route: Exclude<ChannelSenderRoute, "whatsapp">, instanceId: string): ChannelTransportError {
  switch (route) {
    case "bridge":
      return new ChannelTransportError(
        `Instance ${instanceId} needs the legacy channel bridge (Omni), which is not configured`,
        {
          status: 503,
          code: CHANNEL_TRANSPORT_ERROR_CODES.legacyBridgeNotConfigured,
          retryable: false,
          details: { instanceId },
        },
      );
    case "unsupported":
      return new ChannelTransportError(
        `Instance ${instanceId} uses a WhatsApp provider ravi does not support (only WhatsApp via Baileys)`,
        {
          status: 422,
          code: CHANNEL_TRANSPORT_ERROR_CODES.providerUnsupported,
          retryable: false,
          details: { instanceId },
        },
      );
    case "unknown":
      return new ChannelTransportError(`Instance ${instanceId} not found`, {
        status: 404,
        code: CHANNEL_TRANSPORT_ERROR_CODES.instanceNotFound,
        retryable: false,
        details: { instanceId },
      });
  }
}

/**
 * Throwing methods reject with a non-retryable ChannelTransportError:
 *   "bridge" without a bridge → (503, LEGACY_BRIDGE_NOT_CONFIGURED); "unsupported" → (422, CHANNEL_PROVIDER_UNSUPPORTED);
 *   "unknown" → (404, INSTANCE_NOT_FOUND). sendTyping/markRead resolve in those cases (debug log).
 * The route is computed per call from getConfig() (live config; no caching).
 */
export function createChannelSenderRouter(options: ChannelSenderRouterOptions): ChannelSenderRouter {
  const whatsapp = options.whatsapp;
  const bridge = options.bridge ?? null;
  const getConfig = options.getConfig ?? (() => configStore.getConfig());

  const routeFor = (instanceId: string): ChannelSenderRoute => classifyInstanceRoute(getConfig(), instanceId);

  /** The sender for this instance, or the error that refuses it. */
  const target = (instanceId: string): ChannelMessageSender | ChannelTransportError => {
    const route = routeFor(instanceId);
    if (route === "whatsapp") return whatsapp;
    if (route === "bridge" && bridge) return bridge;
    return routeError(route, instanceId);
  };

  const resolveOrThrow = (instanceId: string): ChannelMessageSender => {
    const sender = target(instanceId);
    if (sender instanceof ChannelTransportError) throw sender;
    return sender;
  };

  /** For best-effort calls: null (logged) instead of an error. */
  const resolveBestEffort = (instanceId: string, operation: string): ChannelMessageSender | null => {
    const sender = target(instanceId);
    if (!(sender instanceof ChannelTransportError)) return sender;
    log.debug(`${operation} skipped: no sender for instance`, { instanceId, code: sender.code });
    return null;
  };

  return {
    hasBridge: bridge !== null,
    routeFor,
    async send(instanceId: string, to: string, text: string, sendOptions?: ChannelSendOptions) {
      return resolveOrThrow(instanceId).send(instanceId, to, text, sendOptions);
    },
    async sendTyping(instanceId: string, to: string, active?: boolean) {
      const sender = resolveBestEffort(instanceId, "sendTyping");
      if (!sender) return;
      try {
        await sender.sendTyping(instanceId, to, active);
      } catch (err) {
        log.debug("sendTyping failed", { instanceId, error: err });
      }
    },
    async sendReaction(
      instanceId: string,
      to: string,
      messageId: string,
      emoji: string,
      target?: ChannelReactionTarget,
    ) {
      const sender = resolveOrThrow(instanceId);
      return target
        ? sender.sendReaction(instanceId, to, messageId, emoji, target)
        : sender.sendReaction(instanceId, to, messageId, emoji);
    },
    async deleteMessage(instanceId: string, chatId: string, messageId: string) {
      return resolveOrThrow(instanceId).deleteMessage(instanceId, chatId, messageId);
    },
    async editMessage(instanceId: string, chatId: string, messageId: string, text: string) {
      return resolveOrThrow(instanceId).editMessage(instanceId, chatId, messageId, text);
    },
    async sendMedia(
      instanceId: string,
      to: string,
      localPath: string,
      type: ChannelMediaType,
      filename: string,
      caption?: string,
      voiceNote?: boolean,
    ): Promise<ChannelSendResult> {
      return resolveOrThrow(instanceId).sendMedia(instanceId, to, localPath, type, filename, caption, voiceNote);
    },
    async sendSticker(instanceId: string, to: string, localPath: string) {
      return resolveOrThrow(instanceId).sendSticker(instanceId, to, localPath);
    },
    async markRead(instanceId: string, chatId: string, messageIds: string[]) {
      const sender = resolveBestEffort(instanceId, "markRead");
      if (!sender) return;
      try {
        await sender.markRead(instanceId, chatId, messageIds);
      } catch (err) {
        log.debug("markRead failed", { instanceId, error: err });
      }
    },
  };
}
