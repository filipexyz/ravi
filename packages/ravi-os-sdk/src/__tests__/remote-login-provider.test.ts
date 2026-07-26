import { describe, expect, it } from "bun:test";
import {
  REMOTE_LOGIN_DISCOVERY_PROTOCOL,
  REMOTE_LOGIN_DISCOVERY_SCHEMA_VERSION,
  REMOTE_LOGIN_PROVIDER_PROTOCOL,
  REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
  RemoteIdentityLinkChallengeSchema,
  RemoteIdentityLinkResultSchema,
  RemoteInstallationCredentialSchema,
  RemoteLoginAuthorizedRequestSchema,
  RemoteLoginAuthorizedResponseSchema,
  RemoteLoginDiscoverySchema,
  RemoteLoginInstallationMetadataSchema,
  RemoteLoginProviderDescriptorSchema,
  RemoteLoginProviderModuleConfigSchema,
  type RemoteLoginProvider,
} from "../remote-login-provider.js";

const fixtureDirectory = new URL("./fixtures/remote-login-provider/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return Bun.file(new URL(name, fixtureDirectory)).json();
}

describe("remote login provider SDK contract", () => {
  it("accepts every projected ABI fixture", async () => {
    expect(RemoteLoginDiscoverySchema.parse(await fixture("discovery.json"))).toBeDefined();
    expect(RemoteLoginInstallationMetadataSchema.parse(await fixture("installation-metadata.json"))).toBeDefined();
    expect(RemoteLoginAuthorizedRequestSchema.parse(await fixture("authorized-request.json"))).toBeDefined();
    expect(RemoteLoginAuthorizedResponseSchema.parse(await fixture("authorized-response.json"))).toBeDefined();
    expect(RemoteLoginProviderDescriptorSchema.parse(await fixture("provider-descriptor.json"))).toBeDefined();
    expect(RemoteInstallationCredentialSchema.parse(await fixture("installation-credential.json"))).toBeDefined();
    expect(RemoteIdentityLinkChallengeSchema.parse(await fixture("identity-link-challenge.json"))).toBeDefined();
    expect(RemoteIdentityLinkResultSchema.parse(await fixture("identity-link-result.json"))).toBeDefined();
    expect(
      RemoteLoginProviderModuleConfigSchema.parse(await fixture("module-config.json")),
    ).toMatchObject({ provider: "example" });
  });

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
      reconcileInstallation: async (context) => {
        const response = await context.authorization.request({
          method: "POST",
          path: "/v1/installations/reconcile",
          body: {
            clientInstallationId: context.installation.clientInstallationId,
          },
        });
        expect(response).toEqual({
          status: 200,
          body: { disposition: "reconciled" },
        });
        return RemoteInstallationCredentialSchema.parse({
          provider: "example",
          credentialId: "credential_1",
          material: { credentialHandle: "opaque-material" },
          publicMetadata: { installationId: "installation_1" },
        });
      },
      consumeIdentityLinkChallenge: async (_context, challenge) => {
        expect(challenge).toHaveLength(43);
        return RemoteIdentityLinkResultSchema.parse({
          provider: "example",
          disposition: "linked",
          publicMetadata: { linkId: "link_1" },
        });
      },
    };

    expect(discovery.installationProvider).toBe("example");
    await expect(
      provider.reconcileInstallation({
        endpointUrl: discovery.issuer,
        discovery,
        authorization: {
          request: async () => ({
            status: 200,
            body: { disposition: "reconciled" },
          }),
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
    await expect(
      provider.consumeIdentityLinkChallenge?.(
        {
          endpointUrl: discovery.issuer,
          discovery,
          authorization: {
            request: async () => ({ status: 200 }),
          },
        },
        RemoteIdentityLinkChallengeSchema.parse("A".repeat(43)),
      ),
    ).resolves.toMatchObject({
      provider: "example",
      disposition: "linked",
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
