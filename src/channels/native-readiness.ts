/**
 * Can a native channel actually deliver? Replies for native channels (Slack)
 * are queued on CHANNEL_OUTBOUND whether or not `ravi-channels` can send them,
 * so the gateway, the backfill, `ravi doctor` and `ravi update` use these
 * checks to say when the queue has nowhere to go. They only read state; they
 * never change routing or delivery.
 */

import { which } from "bun";
import { getCredentialConnection } from "../credentials/store.js";
import type { CredentialConnectionRecord } from "../credentials/types.js";
import type { ChannelConfig } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { type OutboundAccountConfig, resolveOutboundAccount } from "./account-resolution.js";
import { canonicalChannelId } from "./capabilities.js";

const log = logger.child("channels:native-readiness");

export type NativeChannelCredentialIssue =
  | "credential_connection_missing"
  | "connection_not_found"
  | "connection_disabled";

export type CredentialConnectionLookup = (provider: string, connection: string) => CredentialConnectionRecord | null;

/** The Slack Hub gateway transport authenticates with the runtime credential, not the broker. */
export function usesHubGatewayTransport(channel: Pick<ChannelConfig, "defaults">): boolean {
  return channel.defaults?.transport === "hub_gateway_v1";
}

export function nativeChannelCredentialIssue(
  channel: Pick<ChannelConfig, "provider" | "credentialConnection" | "defaults">,
  lookup: CredentialConnectionLookup = getCredentialConnection,
): NativeChannelCredentialIssue | null {
  if (usesHubGatewayTransport(channel)) return null;
  const connection = channel.credentialConnection?.trim();
  if (!connection) return "credential_connection_missing";
  let record: CredentialConnectionRecord | null;
  try {
    record = lookup(canonicalChannelId(channel.provider), connection);
  } catch {
    // An identifier the broker rejects can never resolve either.
    return "connection_not_found";
  }
  if (!record) return "connection_not_found";
  if (record.status !== "active") return "connection_disabled";
  return null;
}

export type NativeOutboundReadiness =
  | { ok: true; channelName: string }
  | {
      ok: false;
      reason: "no_native_channel" | NativeChannelCredentialIssue;
      channelName?: string;
      credentialConnection?: string;
    };

export function nativeOutboundReadiness(
  target: { channel: string; accountId?: string; instanceId?: string },
  options: { config?: OutboundAccountConfig; lookup?: CredentialConnectionLookup } = {},
): NativeOutboundReadiness {
  const account = target.accountId?.trim() || target.instanceId?.trim() || "";
  const resolved = resolveOutboundAccount(account, { channel: target.channel, config: options.config });
  if (resolved.kind !== "native") return { ok: false, reason: "no_native_channel" };
  const issue = nativeChannelCredentialIssue(resolved.channel, options.lookup);
  if (!issue) return { ok: true, channelName: resolved.channelName };
  return {
    ok: false,
    reason: issue,
    channelName: resolved.channelName,
    ...(resolved.channel.credentialConnection ? { credentialConnection: resolved.channel.credentialConnection } : {}),
  };
}

const READINESS_CHECK_INTERVAL_MS = 60_000;
const UNDELIVERABLE_WARN_INTERVAL_MS = 10 * 60_000;
const readinessCheckedAt = new Map<string, number>();
const undeliverableWarnedAt = new Map<string, number>();

/**
 * Warn, at most every ten minutes per channel and account, when a reply was
 * queued for native outbound but no native channel can deliver it. Queuing
 * still happens: the job is delivered once the channel is fixed. The check
 * itself runs at most once a minute per key, so busy chats stay cheap.
 * Returns the readiness it evaluated, or null when it skipped the check.
 */
export function warnIfNativeOutboundUndeliverable(
  target: { channel: string; accountId?: string; instanceId?: string },
  options: { config?: OutboundAccountConfig; lookup?: CredentialConnectionLookup; now?: number } = {},
): NativeOutboundReadiness | null {
  const key = `${canonicalChannelId(target.channel)}:${target.accountId || target.instanceId || ""}`;
  const now = options.now ?? Date.now();
  const checked = readinessCheckedAt.get(key);
  if (checked !== undefined && now - checked < READINESS_CHECK_INTERVAL_MS) return null;
  readinessCheckedAt.set(key, now);

  let readiness: NativeOutboundReadiness;
  try {
    readiness = nativeOutboundReadiness(target, options);
  } catch {
    return null;
  }
  if (readiness.ok) return readiness;
  const last = undeliverableWarnedAt.get(key);
  if (last !== undefined && now - last < UNDELIVERABLE_WARN_INTERVAL_MS) return readiness;
  undeliverableWarnedAt.set(key, now);
  log.warn("Reply queued for native outbound, but no native channel can deliver it", {
    channel: target.channel,
    accountId: target.accountId,
    reason: readiness.reason,
    ...(readiness.channelName ? { channelName: readiness.channelName } : {}),
    ...(readiness.credentialConnection ? { credentialConnection: readiness.credentialConnection } : {}),
    hint: "run `ravi doctor --domain channels`",
  });
  return readiness;
}

export function resetNativeOutboundWarningsForTests(): void {
  readinessCheckedAt.clear();
  undeliverableWarnedAt.clear();
}

export interface NativeChannelRuntimeEntry {
  name: string;
  provider: string;
  transport: "broker" | "hub_gateway_v1";
  credentialConnection?: string;
  issue: NativeChannelCredentialIssue | null;
  backend?: CredentialConnectionRecord["backend"];
  /** Backend prerequisites missing from this process (names only, never values). */
  missingPrerequisites: string[];
}

export interface NativeChannelRuntimeSnapshot {
  channels: NativeChannelRuntimeEntry[];
  /** PM2 status of `ravi-channels`; "missing" when PM2 has no such process, null when PM2 is unavailable. */
  runnerStatus: string | null;
}

export interface InspectNativeChannelRuntimeDeps {
  listChannels: () => ChannelConfig[];
  lookup?: CredentialConnectionLookup;
  commandOnPath?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  runnerStatus: () => string | null;
}

/** Read-only view of every enabled native channel and whether the runner can start it. */
export function inspectNativeChannelRuntime(deps: InspectNativeChannelRuntimeDeps): NativeChannelRuntimeSnapshot {
  const lookup = deps.lookup ?? getCredentialConnection;
  const commandOnPath = deps.commandOnPath ?? ((command: string) => Boolean(which(command)));
  const env = deps.env ?? process.env;
  const channels = deps
    .listChannels()
    .filter((channel) => channel.enabled !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((channel): NativeChannelRuntimeEntry => {
      const provider = canonicalChannelId(channel.provider);
      const credentialConnection = channel.credentialConnection?.trim() || undefined;
      if (usesHubGatewayTransport(channel)) {
        return { name: channel.name, provider, transport: "hub_gateway_v1", issue: null, missingPrerequisites: [] };
      }
      let record: CredentialConnectionRecord | null = null;
      if (credentialConnection) {
        try {
          record = lookup(provider, credentialConnection);
        } catch {
          record = null;
        }
      }
      const issue = nativeChannelCredentialIssue(channel, () => record);
      const missingPrerequisites: string[] = [];
      if (record?.backend === "keychain" && !commandOnPath("security")) missingPrerequisites.push("security");
      if (record?.backend === "vault") {
        if (!env.VAULT_ADDR?.trim()) missingPrerequisites.push("VAULT_ADDR");
        if (!env.VAULT_TOKEN?.trim()) missingPrerequisites.push("VAULT_TOKEN");
      }
      return {
        name: channel.name,
        provider,
        transport: "broker",
        ...(credentialConnection ? { credentialConnection } : {}),
        issue,
        ...(record ? { backend: record.backend } : {}),
        missingPrerequisites,
      };
    });
  return { channels, runnerStatus: deps.runnerStatus() };
}
