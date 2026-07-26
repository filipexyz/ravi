import { createHash } from "node:crypto";
import type { StoredRemoteInstallationCredential } from "../../cloud-auth/installation-storage.js";
import type { ChannelConfig } from "../../router/router-db.js";

export interface InstallationChannelRegistry {
  get(provider: string):
    | {
        readonly descriptor?: {
          readonly requiredHostCapabilities?: readonly string[];
        };
      }
    | undefined;
}

export function mergeInstallationCredentialChannels(input: {
  readonly configured: Readonly<Record<string, ChannelConfig>>;
  readonly credentials: readonly StoredRemoteInstallationCredential[];
  readonly registry: InstallationChannelRegistry;
  readonly now?: number;
}): Record<string, ChannelConfig> {
  const merged: Record<string, ChannelConfig> = {
    ...input.configured,
  };
  const now = input.now ?? Date.now();

  for (const stored of [...input.credentials].sort((left, right) =>
    left.endpointUrl.localeCompare(right.endpointUrl),
  )) {
    const provider = stored.credential.provider;
    const driver = input.registry.get(provider);
    if (driver?.descriptor?.requiredHostCapabilities?.includes("installation_credentials") !== true) {
      continue;
    }
    if (stored.credential.expiresAt !== undefined && Date.parse(stored.credential.expiresAt) <= now) {
      continue;
    }
    const alreadyConfigured = Object.values(merged).some(
      (channel) => channel.provider === provider && channel.credentialConnection === stored.endpointUrl,
    );
    if (alreadyConfigured) continue;

    const name = installationChannelName(provider, stored.endpointUrl);
    if (merged[name] !== undefined) continue;
    merged[name] = {
      name,
      provider,
      enabled: true,
      credentialConnection: stored.endpointUrl,
      createdAt: 0,
      updatedAt: 0,
    };
  }
  return merged;
}

export function installationChannelName(provider: string, endpointUrl: string): string {
  const digest = createHash("sha256").update(provider).update("\0").update(endpointUrl).digest("hex").slice(0, 24);
  return `remote-${digest}`;
}
