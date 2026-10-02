/**
 * Outbound account resolution for channel-backed instances and native channel accounts.
 *
 * - `whatsapp`: a canonical WhatsApp instance (ravi's own runner). `bound` says whether an
 *   enabled WhatsApp channel serves it; an unbound one fails in the sender with
 *   404 WHATSAPP_NOT_BOUND and never reaches the legacy bridge.
 * - `bridge`: an instance record of another channel (Telegram, Discord) served by the
 *   legacy bridge.
 * - `native`: a native channel account (Slack) created with
 *   `ravi channels create <name> --provider slack`. It has no instance UUID; callers MUST
 *   distinguish `kind` and never pass a native account slug to an instance sender.
 * - `unresolved`: nothing to send through. A bare UUID with no instance record is
 *   `not_found` (it is never passed through).
 */

import { configStore } from "../config-store.js";
import type { ChannelConfig, InstanceConfig } from "../router/router-db.js";
import type { RouterConfig } from "../router/types.js";
import { canonicalChannelId } from "./capabilities.js";
import {
  findWhatsAppChannelForInstance,
  isWhatsAppChannelType,
  isWhatsAppFamilyChannelType,
  resolveWhatsAppBinding,
} from "./whatsapp/contract.js";

export const NATIVE_OUTBOUND_PROVIDERS = new Set(["slack"]);

export const NO_INSTANCE_FOR_ACCOUNT = "No instance for account";

export type OutboundAccountConfig = Pick<RouterConfig, "channels" | "instances" | "instanceToAccount">;

export type OutboundUnresolvedReason = "empty" | "disabled" | "not_found" | "not_bound" | "unsupported";

export type OutboundAccountResolution =
  | {
      readonly kind: "whatsapp";
      readonly accountId: string;
      /** Instance UUID. */
      readonly instanceId: string;
      /** The instance's WhatsApp channel row, when one exists (enabled or not). */
      readonly channelName: string | null;
      /** An enabled WhatsApp channel serves this instance. */
      readonly bound: boolean;
    }
  | {
      readonly kind: "bridge";
      readonly accountId: string;
      readonly instanceId: string;
    }
  | {
      readonly kind: "native";
      readonly accountId: string;
      readonly instanceId: string;
      readonly provider: string;
      readonly channelName: string;
      readonly credentialConfigured: boolean;
      readonly channel: ChannelConfig;
    }
  | {
      readonly kind: "unresolved";
      readonly accountId: string;
      readonly reason: OutboundUnresolvedReason;
    };

/**
 * Reply text for an account that cannot be sent through. `not_bound` and `unsupported` get
 * their own hint; everything else keeps the historical `NO_INSTANCE_FOR_ACCOUNT`.
 */
export function unresolvedAccountError(resolved: Extract<OutboundAccountResolution, { kind: "unresolved" }>): string {
  switch (resolved.reason) {
    case "not_bound":
      return `WhatsApp instance ${resolved.accountId} is not connected: ravi instances connect ${resolved.accountId}`;
    case "unsupported":
      return `Instance ${resolved.accountId} uses a WhatsApp provider ravi does not support (only WhatsApp via Baileys)`;
    default:
      return NO_INSTANCE_FOR_ACCOUNT;
  }
}

export function nativeAccountAliases(config: OutboundAccountConfig, accountId: string): string[] {
  const received = accountId.trim();
  if (!received) return [];

  const aliases = new Set<string>([received.toLowerCase()]);
  const mappedAccount = config.instanceToAccount?.[received]?.trim();
  if (mappedAccount) {
    aliases.add(mappedAccount.toLowerCase());
    const mappedInstanceId = config.instances?.[mappedAccount]?.instanceId?.trim();
    if (mappedInstanceId) aliases.add(mappedInstanceId.toLowerCase());
  }

  const namedInstance = config.instances?.[received];
  if (namedInstance?.instanceId?.trim()) aliases.add(namedInstance.instanceId.trim().toLowerCase());
  if (namedInstance?.name?.trim()) aliases.add(namedInstance.name.trim().toLowerCase());

  return [...aliases];
}

export function findNativeChannelAccount(
  channels: Record<string, ChannelConfig> | undefined,
  accountId: string,
  options: { provider?: string; aliases?: readonly string[] } = {},
): ChannelConfig | undefined {
  const aliases = (options.aliases ?? [accountId.trim().toLowerCase()]).filter(Boolean);
  if (aliases.length === 0) return undefined;
  const provider = options.provider ? canonicalChannelId(options.provider) : undefined;

  return Object.values(channels ?? {}).find((channel) => {
    if (channel.enabled === false) return false;
    const channelProvider = canonicalChannelId(channel.provider);
    if (provider && channelProvider !== provider) return false;
    if (!provider && !NATIVE_OUTBOUND_PROVIDERS.has(channelProvider)) return false;
    return [channel.name, channel.credentialConnection]
      .filter((value): value is string => Boolean(value?.trim()))
      .some((value) => aliases.includes(value.trim().toLowerCase()));
  });
}

export function nativeChannelCredentialConfigured(
  config: OutboundAccountConfig,
  accountId: string,
  provider?: string,
): boolean {
  const channel = findNativeChannelAccount(config.channels, accountId, {
    provider,
    aliases: nativeAccountAliases(config, accountId),
  });
  return Boolean(channel?.credentialConnection?.trim());
}

export function resolveOutboundAccount(
  accountId: string | undefined,
  options: { channel?: string; config?: OutboundAccountConfig } = {},
): OutboundAccountResolution {
  const account = accountId?.trim() ?? "";
  if (!account) {
    return { kind: "unresolved", accountId: "", reason: "empty" };
  }

  const config = options.config ?? configStore.getConfig();
  const hint = options.channel?.trim() || undefined;
  const channelHint = hint ? canonicalChannelId(hint) : undefined;
  const record = findInstanceRecord(config, account);
  const aliases = nativeAccountAliases(config, account);

  // A Slack hint keeps a matching native Slack channel, even when a same-named WhatsApp
  // instance record exists (instance records default to channel "whatsapp").
  if (channelHint && NATIVE_OUTBOUND_PROVIDERS.has(channelHint)) {
    const native = findNativeChannelAccount(config.channels, account, { provider: channelHint, aliases });
    if (native) return nativeResolution(account, native);
  }

  // WhatsApp next: the instance record (or its WhatsApp binding) decides for any other hint.
  if (record && (isWhatsAppChannelType(record.channel) || resolveWhatsAppBinding(config, account))) {
    return whatsappResolution(config, account, record);
  }
  if (isWhatsAppFamilyChannelType(record?.channel) || isUnsupportedWhatsAppType(hint)) {
    return { kind: "unresolved", accountId: account, reason: "unsupported" };
  }
  // A WhatsApp hint with no instance record: nothing to send through (never a bare UUID).
  if (!record && isWhatsAppChannelType(hint)) {
    return { kind: "unresolved", accountId: account, reason: "not_found" };
  }

  // From here, `record` (if any) is a non-WhatsApp-family instance served by the legacy bridge.
  const bridge = bridgeInstance(config, record);

  if (channelHint && NATIVE_OUTBOUND_PROVIDERS.has(channelHint)) {
    // No matching native channel (checked above): fall back to the bridge record.
    if (bridge.disabled) return { kind: "unresolved", accountId: account, reason: "disabled" };
    if (bridge.instanceId) return { kind: "bridge", accountId: account, instanceId: bridge.instanceId };
    return { kind: "unresolved", accountId: account, reason: "not_found" };
  }

  if (channelHint) {
    if (bridge.disabled) return { kind: "unresolved", accountId: account, reason: "disabled" };
    if (bridge.instanceId) return { kind: "bridge", accountId: account, instanceId: bridge.instanceId };
    return { kind: "unresolved", accountId: account, reason: "not_found" };
  }

  if (bridge.disabled) return { kind: "unresolved", accountId: account, reason: "disabled" };
  if (bridge.instanceId) return { kind: "bridge", accountId: account, instanceId: bridge.instanceId };

  const native = findNativeChannelAccount(config.channels, account, { aliases });
  if (native) return nativeResolution(account, native);
  return { kind: "unresolved", accountId: account, reason: "not_found" };
}

function nativeResolution(
  accountId: string,
  channel: ChannelConfig,
): Extract<OutboundAccountResolution, { kind: "native" }> {
  return {
    kind: "native",
    accountId,
    instanceId: channel.name,
    provider: canonicalChannelId(channel.provider),
    channelName: channel.name,
    credentialConfigured: Boolean(channel.credentialConnection?.trim()),
    channel,
  };
}

/**
 * The live (non-deleted) instance record for an account name or instance UUID: by name, via
 * `instanceToAccount` for a UUID, or a record whose `instanceId` equals the ref.
 */
function findInstanceRecord(config: OutboundAccountConfig, ref: string): InstanceConfig | null {
  const instances = config.instances ?? {};
  const live = (record: InstanceConfig | undefined) => (record && !record.deletedAt ? record : null);
  const byName = live(instances[ref]);
  if (byName) return byName;
  const mappedAccount = config.instanceToAccount?.[ref];
  const byAccount = mappedAccount ? live(instances[mappedAccount]) : null;
  if (byAccount) return byAccount;
  return Object.values(instances).find((record) => !record.deletedAt && record.instanceId?.trim() === ref) ?? null;
}

/** Instance UUID of a record: its own `instanceId`, else the `instanceToAccount` entry naming it. */
function instanceUuidOf(config: OutboundAccountConfig, record: InstanceConfig): string | undefined {
  const own = record.instanceId?.trim();
  if (own) return own;
  for (const [uuid, name] of Object.entries(config.instanceToAccount ?? {})) {
    if (name === record.name) return uuid;
  }
  return undefined;
}

function whatsappResolution(
  config: OutboundAccountConfig,
  accountId: string,
  record: InstanceConfig,
): OutboundAccountResolution {
  if (record.enabled === false) return { kind: "unresolved", accountId, reason: "disabled" };
  const instanceId = instanceUuidOf(config, record);
  if (!instanceId) return { kind: "unresolved", accountId, reason: "not_bound" };
  const binding = resolveWhatsAppBinding(config, instanceId) ?? resolveWhatsAppBinding(config, record.name);
  const channel = binding?.channel ?? findWhatsAppChannelForInstance(config, record.name);
  return {
    kind: "whatsapp",
    accountId,
    instanceId,
    channelName: channel?.name ?? null,
    bound: binding !== null,
  };
}

/** A WhatsApp-family channel type ravi does not serve (twilio-whatsapp, gupshup, …). */
function isUnsupportedWhatsAppType(channelType: string | undefined): boolean {
  return isWhatsAppFamilyChannelType(channelType) && !isWhatsAppChannelType(channelType);
}

/** Legacy-bridge instance for a non-WhatsApp record. No record → nothing (a bare UUID is not passed through). */
function bridgeInstance(
  config: OutboundAccountConfig,
  record: InstanceConfig | null,
): { instanceId?: string; disabled?: boolean } {
  if (!record) return {};
  if (record.enabled === false) return { disabled: true };
  const instanceId = instanceUuidOf(config, record);
  return instanceId ? { instanceId } : {};
}
