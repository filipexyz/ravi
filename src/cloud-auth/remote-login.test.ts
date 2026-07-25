import { describe, expect, it, mock } from "bun:test";
import {
  REMOTE_LOGIN_DISCOVERY_PROTOCOL,
  REMOTE_LOGIN_DISCOVERY_SCHEMA_VERSION,
  REMOTE_LOGIN_PROVIDER_PROTOCOL,
  REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
  RemoteLoginContractError,
  discoverRemoteLoginEndpoint,
  loadRemoteLoginProvider,
  normalizeRemoteLoginEndpoint,
  parseRemoteLoginProviderModuleConfigs,
  reconcileRemoteInstallation,
  type RemoteLoginDiscovery,
} from "./remote-login.js";

const discovery: RemoteLoginDiscovery = {
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
};

describe("remote login discovery", () => {
  it("loads a versioned, origin-bound contract", async () => {
    const fetcher = mock(async () => Response.json(discovery));

    await expect(discoverRemoteLoginEndpoint("https://auth.example/", fetcher)).resolves.toEqual(discovery);
    expect(fetcher).toHaveBeenCalledWith(
      "https://auth.example/.well-known/ravi-auth",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
      }),
    );
  });

  it("rejects issuer substitution, insecure remote HTTP, and embedded credentials", async () => {
    await expect(
      discoverRemoteLoginEndpoint("https://auth.example", async () =>
        Response.json({
          ...discovery,
          issuer: "https://other.example",
          authConfigEndpoint: "https://other.example/v1/auth/config",
          sessionEndpoints: {
            exchange: "https://other.example/v1/auth/exchange",
            refresh: "https://other.example/v1/auth/refresh",
            logout: "https://other.example/v1/auth/logout",
            me: "https://other.example/v1/me",
          },
        }),
      ),
    ).rejects.toEqual(expect.objectContaining({ reason: "issuer_mismatch" }));
    expect(() => normalizeRemoteLoginEndpoint("http://auth.example")).toThrow();
    expect(() => normalizeRemoteLoginEndpoint("https://user:secret@auth.example")).toThrow();
    expect(normalizeRemoteLoginEndpoint("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
  });
});

describe("remote post-login provider contract", () => {
  it("loads only an explicitly configured local provider and validates its result", async () => {
    const moduleSpecifier = new URL("./remote-login.test.ts", import.meta.url).href;
    const configs = parseRemoteLoginProviderModuleConfigs(
      JSON.stringify([
        {
          protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
          schemaVersion: REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
          provider: "example",
          moduleSpecifier,
        },
      ]),
    );
    const provider = {
      descriptor: {
        protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
        schemaVersion: REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
        provider: "example",
      },
      reconcileInstallation: mock(async () => ({
        provider: "example",
        credentialId: "credential_1",
        material: { privateKeyPem: "secret-key-material" },
        publicMetadata: { installationId: "installation_1" },
      })),
    };
    const loaded = await loadRemoteLoginProvider("example", configs, async () => ({
      remoteLoginProvider: provider,
    }));
    const result = await reconcileRemoteInstallation(loaded, {
      endpointUrl: "https://auth.example",
      discovery,
      humanCredentials: {
        version: 1,
        consoleUrl: "https://auth.example",
        authMode: "remote",
        installationId: "client_installation_1",
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        accessTokenExpiresAt: null,
        scopes: [],
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z",
      },
      installation: {
        clientInstallationId: "client_installation_1",
        name: "Test runtime",
        hostname: "test-host",
        platform: "test-platform",
      },
    });

    expect(result).toEqual({
      provider: "example",
      credentialId: "credential_1",
      material: { privateKeyPem: "secret-key-material" },
      publicMetadata: { installationId: "installation_1" },
    });
    expect(provider.reconcileInstallation).toHaveBeenCalledTimes(1);
  });

  it("rejects remote module specifiers, duplicate providers, and provider mismatches", async () => {
    expect(() =>
      parseRemoteLoginProviderModuleConfigs(
        JSON.stringify([
          {
            protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
            schemaVersion: 1,
            provider: "example",
            moduleSpecifier: "https://untrusted.example/provider.js",
          },
        ]),
      ),
    ).toThrow(RemoteLoginContractError);
    expect(() =>
      parseRemoteLoginProviderModuleConfigs(
        JSON.stringify([
          {
            protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
            schemaVersion: 1,
            provider: "example",
            moduleSpecifier: "@example/one",
          },
          {
            protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
            schemaVersion: 1,
            provider: "example",
            moduleSpecifier: "@example/two",
          },
        ]),
      ),
    ).toThrow(expect.objectContaining({ reason: "duplicate_provider" }));
    await expect(
      loadRemoteLoginProvider(
        "example",
        [
          {
            protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
            schemaVersion: 1,
            provider: "example",
            moduleSpecifier: "@example/provider",
          },
        ],
        async () => ({
          remoteLoginProvider: {
            descriptor: {
              protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
              schemaVersion: 1,
              provider: "other",
            },
            reconcileInstallation() {},
          },
        }),
      ),
    ).rejects.toEqual(expect.objectContaining({ reason: "provider_mismatch" }));
  });

  it("rejects provider material that cannot round-trip through JSON", async () => {
    const provider = {
      descriptor: {
        protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
        schemaVersion: REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
        provider: "example",
      },
      reconcileInstallation: async () => ({
        provider: "example",
        credentialId: "credential_1",
        material: { silentlyDropped: undefined },
      }),
    };

    await expect(
      reconcileRemoteInstallation(provider, {
        endpointUrl: "https://auth.example",
        discovery,
        humanCredentials: {
          version: 1,
          consoleUrl: "https://auth.example",
          authMode: "remote",
          installationId: "client_installation_1",
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          accessTokenExpiresAt: null,
          scopes: [],
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
        installation: {
          clientInstallationId: "client_installation_1",
          name: "Test runtime",
          hostname: "test-host",
          platform: "test-platform",
        },
      }),
    ).rejects.toEqual(expect.objectContaining({ reason: "invalid_provider_result" }));
  });
});
