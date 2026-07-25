import { describe, expect, it } from "bun:test";
import {
  REMOTE_LOGIN_DISCOVERY_PROTOCOL,
  REMOTE_LOGIN_DISCOVERY_SCHEMA_VERSION,
  REMOTE_LOGIN_PROVIDER_PROTOCOL,
  REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
  RemoteInstallationCredentialSchema,
  RemoteLoginDiscoverySchema,
  RemoteLoginProviderDescriptorSchema,
  type RemoteLoginProvider,
} from "../remote-login-provider.js";

describe("remote login provider SDK contract", () => {
  it("validates discovery, provider, and opaque installation credentials", async () => {
    const discovery = RemoteLoginDiscoverySchema.parse({
      protocol: REMOTE_LOGIN_DISCOVERY_PROTOCOL,
      schemaVersion: REMOTE_LOGIN_DISCOVERY_SCHEMA_VERSION,
      issuer: "https://auth.example",
      authConfigEndpoint: "https://auth.example/v1/auth/config",
      sessionEndpoints: {
        exchange: "https://auth.example/v1/auth/exchange",
        refresh: "https://auth.example/v1/auth/refresh",
        logout: "https://auth.example/v1/auth/logout",
        me: "https://auth.example/v1/me",
      },
      installationProvider: "example",
    });
    const provider: RemoteLoginProvider = {
      descriptor: RemoteLoginProviderDescriptorSchema.parse({
        protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
        schemaVersion: REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
        provider: "example",
      }),
      reconcileInstallation: async () =>
        RemoteInstallationCredentialSchema.parse({
          provider: "example",
          credentialId: "credential_1",
          material: { renewableCredential: "secret" },
          publicMetadata: { installationId: "installation_1" },
        }),
    };

    expect(discovery.installationProvider).toBe("example");
    await expect(
      provider.reconcileInstallation({
        endpointUrl: discovery.issuer,
        discovery,
        humanCredentials: {
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          accessTokenExpiresAt: null,
          scopes: [],
        },
        installation: {
          clientInstallationId: "client_installation_1",
          name: "Example runtime",
          hostname: "example-host",
          platform: "example-platform",
        },
      }),
    ).resolves.toMatchObject({
      provider: "example",
      credentialId: "credential_1",
    });
  });

  it("rejects values that would be silently changed by JSON persistence", () => {
    expect(() =>
      RemoteInstallationCredentialSchema.parse({
        provider: "example",
        credentialId: "credential_1",
        material: { silentlyDropped: undefined },
      }),
    ).toThrow();
  });
});
