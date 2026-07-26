import { describe, expect, it } from "bun:test";
import type { StoredRemoteInstallationCredential } from "../../cloud-auth/installation-storage.js";
import type { ChannelConfig } from "../../router/router-db.js";
import { installationChannelName, mergeInstallationCredentialChannels } from "./installation-channels.js";

function stored(endpointUrl: string, provider = "example", expiresAt?: string): StoredRemoteInstallationCredential {
  return {
    endpointUrl,
    credential: {
      provider,
      credentialId: `credential-${provider}`,
      material: { opaque: "secret-material" },
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
  };
}

describe("installation credential native channels", () => {
  it("adds one stable hidden runtime per matching installed provider", () => {
    const registry = {
      get(provider: string) {
        return provider === "example"
          ? {
              descriptor: {
                requiredHostCapabilities: ["installation_credentials"],
              },
            }
          : undefined;
      },
    };
    const channels = mergeInstallationCredentialChannels({
      configured: {},
      credentials: [
        stored("https://two.example"),
        stored("https://one.example"),
        stored("https://ignored.example", "not-installed"),
      ],
      registry,
      now: Date.parse("2026-07-25T13:00:00.000Z"),
    });

    expect(Object.keys(channels)).toEqual([
      installationChannelName("example", "https://one.example"),
      installationChannelName("example", "https://two.example"),
    ]);
    expect(Object.values(channels)[0]).toMatchObject({
      provider: "example",
      enabled: true,
      credentialConnection: "https://one.example",
    });
    expect(JSON.stringify(channels)).not.toContain("secret-material");
  });

  it("preserves explicit configuration and skips duplicates, expiry, and name collisions", () => {
    const endpointUrl = "https://one.example";
    const explicit: ChannelConfig = {
      name: "explicit",
      provider: "example",
      enabled: true,
      credentialConnection: endpointUrl,
      createdAt: 1,
      updatedAt: 1,
    };
    const collisionName = installationChannelName("example", "https://collision.example");
    const collision: ChannelConfig = {
      name: collisionName,
      provider: "other",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const configured = { explicit, [collisionName]: collision };
    const channels = mergeInstallationCredentialChannels({
      configured,
      credentials: [
        stored(endpointUrl),
        stored("https://expired.example", "example", "2026-07-25T12:00:00.000Z"),
        stored("https://collision.example"),
      ],
      registry: {
        get: () => ({
          descriptor: {
            requiredHostCapabilities: ["installation_credentials"],
          },
        }),
      },
      now: Date.parse("2026-07-25T13:00:00.000Z"),
    });

    expect(channels).toEqual(configured);
  });
});
