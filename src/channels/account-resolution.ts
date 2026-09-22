/**
 * Outbound account resolution for Omni instances and native channel accounts.
 *
 * Native Slack accounts created with `ravi channels create <name> --provider slack`
 * have no Omni instance UUID. Callers MUST distinguish `kind` and must not pass a
 * native account slug to Omni APIs.
 */

import { configStore } from "../config-store.js";
import type { ChannelConfig } from "../router/router-db.js";
import type { RouterConfig } from "../router/types.js";
import { canonicalChannelId } from "./capabilities.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const NATIVE_OUTBOUND_PROVIDERS = new Set(["slack"]);

export const NO_INSTANCE_FOR_ACCOUNT = "No instance for account";

export type OutboundAccountConfig = Pick<RouterConfig, "channels" | "instances" | "instanceToAccount">;

export type OutboundAccountResolution =
  | {
      readonly kind: "omni";
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
      readonly reason: "empty" | "disabled" | "not_found";
    };

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
  const channelHint = options.channel ? canonicalChannelId(options.channel) : undefined;
  const omni = resolveOmniInstance(config, account);
  const aliases = nativeAccountAliases(config, account);

  if (channelHint && NATIVE_OUTBOUND_PROVIDERS.has(channelHint)) {
    const native = findNativeChannelAccount(config.channels, account, { provider: channelHint, aliases });
    if (native) return nativeResolution(account, native);
    if (omni.disabled) return { kind: "unresolved", accountId: account, reason: "disabled" };
    if (omni.instanceId) return { kind: "omni", accountId: account, instanceId: omni.instanceId };
    return { kind: "unresolved", accountId: account, reason: "not_found" };
  }

  if (channelHint) {
    if (omni.disabled) return { kind: "unresolved", accountId: account, reason: "disabled" };
    if (omni.instanceId) return { kind: "omni", accountId: account, instanceId: omni.instanceId };
    return { kind: "unresolved", accountId: account, reason: "not_found" };
  }

  if (omni.disabled) return { kind: "unresolved", accountId: account, reason: "disabled" };
  if (omni.instanceId) return { kind: "omni", accountId: account, instanceId: omni.instanceId };

  const native = findNativeChannelAccount(config.channels, account, { aliases });
  if (native) return nativeResolution(account, native);
  return { kind: "unresolved", accountId: account, reason: "not_found" };
}

function nativeResolution(accountId: string, channel: ChannelConfig): Extract<OutboundAccountResolution, { kind: "native" }> {
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

function resolveOmniInstance(
  config: OutboundAccountConfig,
  accountName: string,
): { instanceId?: string; disabled?: boolean } {
  if (UUID_RE.test(accountName)) {
    const mappedAccount = config.instanceToAccount?.[accountName];
    if (mappedAccount && config.instances?.[mappedAccount]?.enabled === false) {
      return { disabled: true };
    }
    return { instanceId: accountName };
  }

  if (config.instances?.[accountName]?.enabled === false) {
    return { disabled: true };
  }

  for (const [uuid, name] of Object.entries(config.instanceToAccount ?? {})) {
    if (name === accountName) return { instanceId: uuid };
  }
  return {};
}
