import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import {
  REMOTE_LOGIN_DISCOVERY_PROTOCOL,
  REMOTE_LOGIN_DISCOVERY_SCHEMA_VERSION,
  REMOTE_LOGIN_PROVIDER_PROTOCOL,
  REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
} from "../../cloud-auth/remote-login.js";
import { DEFAULT_CONSOLE_URL, type CloudCredentials, type CredentialExchangeInput } from "../../cloud-auth/types.js";
import { runLogin, runLogout, runWhoami } from "./cloud-auth.js";

describe("cloud auth root command handlers", () => {
  it("prints whoami JSON with identity and expiry metadata but no token material", async () => {
    const credentials = makeCredentials();
    const client = {
      me: mock(async (accessToken: string) => {
        expect(accessToken).toBe("access-secret");
        return {
          user: { email: "alice@example.com" },
          organization: { id: "org_123", name: "Acme" },
          installation: { id: "ins_123" },
          scopes: ["artifacts:publish"],
          accessTokenExpiresAt: "2026-05-10T01:00:00.000Z",
          refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
        };
      }),
    } as unknown as ConsoleApiClient;

    const { output, result } = await captureConsole(() =>
      runWhoami(
        { json: true },
        {
          client,
          readCredentials: () => credentials,
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    );
    const payload = JSON.parse(output);
    const encoded = JSON.stringify(payload);

    expect(result).toEqual(payload);
    expect(payload).toMatchObject({
      success: true,
      authenticated: true,
      session: {
        consoleUrl: "https://console.example",
        user: { email: "alice@example.com" },
        organization: { id: "org_123", name: "Acme" },
        installation: { id: "ins_123" },
        scopes: ["artifacts:publish"],
        accessTokenExpiresAt: "2026-05-10T01:00:00.000Z",
        refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
      },
    });
    expect(encoded).not.toContain("access-secret");
    expect(encoded).not.toContain("refresh-secret");
  });

  it("stores login credentials but redacts tokens from JSON output", async () => {
    let written: CloudCredentials | null = null;
    const exchange = mock(async (input: CredentialExchangeInput) => ({
      ...makeCredentials(),
      installationId: input.installationId,
      accessToken: "login-access-secret",
      refreshToken: "login-refresh-secret",
    }));
    const client = {
      getAuthConfig: mock(async () => ({
        configured: true,
        clientId: "ravi-cli",
        mode: "console_device",
        endpoints: {
          deviceAuthorization: "https://console.example/api/cli/auth/device",
          token: null,
        },
      })),
      startDeviceAuthorization: mock(async () => ({
        verificationUriComplete: "https://console.example/device?user_code=ABC",
        verificationUri: "https://console.example/device",
        userCode: "ABC",
        deviceCode: "device-secret",
        interval: 1,
      })),
      pollDeviceToken: mock(async () => ({
        accessToken: "provider-secret",
      })),
      exchange,
    } as unknown as ConsoleApiClient;

    const { output } = await captureConsole(() =>
      runLogin(
        { console: "https://console.example", json: true, open: false, poll: false },
        {
          client,
          readCredentials: () => null,
          writeCredentials: (credentials) => {
            written = credentials;
          },
          env: { RAVI_CLI_INSTALLATION_NAME: "Test CLI" } as NodeJS.ProcessEnv,
        },
      ),
    );
    const payload = JSON.parse(output);
    const encoded = JSON.stringify(payload);

    expect(written).toMatchObject({
      consoleUrl: "https://console.example",
      accessToken: "login-access-secret",
      refreshToken: "login-refresh-secret",
      scopes: ["artifacts:publish"],
    });
    expect(exchange.mock.calls[0]?.[0]).toMatchObject({
      deviceCode: "device-secret",
      installation: {
        name: "Test CLI",
      },
    });
    expect(payload.session.accessTokenExpiresAt).toBe("2026-05-10T00:00:00.000Z");
    expect(payload.auth.authorizationUrl).toBe("https://console.example/device?user_code=ABC");
    expect(encoded).not.toContain("login-access-secret");
    expect(encoded).not.toContain("login-refresh-secret");
    expect(encoded).not.toContain("provider-secret");
  });

  it("returns the public challenge when no-poll login remains pending", async () => {
    const writeCredentials = mock(() => {});
    const client = {
      getAuthConfig: mock(async () => ({
        configured: true,
        clientId: "ravi-cli",
        mode: "console_device",
        endpoints: {
          deviceAuthorization: "https://console.example/api/cli/auth/device",
          token: null,
        },
      })),
      startDeviceAuthorization: mock(async () => ({
        verificationUriComplete: "https://console.example/device?user_code=ABC",
        verificationUri: "https://console.example/device",
        userCode: "ABC",
        deviceCode: "device-secret",
        expiresIn: 600,
        interval: 1,
      })),
      exchange: mock(async () => {
        throw new CloudAuthError("AUTH_PENDING", "Authorization is still pending.", {
          status: 409,
        });
      }),
    } as unknown as ConsoleApiClient;

    const { output, result } = await captureConsole(() =>
      runLogin(
        {
          console: "https://console.example",
          json: true,
          open: false,
          poll: false,
        },
        {
          client,
          readCredentials: () => null,
          writeCredentials,
        },
      ),
    );
    const payload = JSON.parse(output);
    const encoded = JSON.stringify(payload);

    expect(result).toEqual(payload);
    expect(payload).toEqual({
      success: true,
      status: "pending",
      endpointUrl: "https://console.example",
      auth: {
        provider: null,
        authorizationUrl: "https://console.example/device?user_code=ABC",
        verificationUri: "https://console.example/device",
        userCode: "ABC",
        expiresIn: 600,
        interval: 1,
      },
    });
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(encoded).not.toContain("device-secret");
  });

  it("discovers an explicit remote endpoint and stores its installation credential separately", async () => {
    let writtenHuman: CloudCredentials | null = null;
    let writtenInstallation: unknown;
    const client = loginClient();
    const provider = {
      descriptor: {
        protocol: REMOTE_LOGIN_PROVIDER_PROTOCOL,
        schemaVersion: REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION,
        provider: "example",
      },
      reconcileInstallation: mock(async () => ({
        provider: "example",
        credentialId: "credential_1",
        material: {
          privateKeyPem: "private-key-secret",
          renewableCredential: "renewable-secret",
        },
        publicMetadata: { installationId: "installation_1" },
      })),
    };

    const { output } = await captureConsole(() =>
      runLogin(
        {
          endpoint: "https://auth.example",
          json: true,
          open: false,
          poll: false,
        },
        {
          client,
          readCredentials: () => null,
          writeCredentials: (credentials) => {
            writtenHuman = credentials;
          },
          ensureClientInstallationId: () => "client_installation_1",
          discoverEndpoint: mock(async () => remoteDiscovery()),
          readInstallationCredential: () => null,
          writeInstallationCredential: (endpointUrl, clientInstallationId, credential) => {
            writtenInstallation = { endpointUrl, clientInstallationId, credential };
            return {
              endpointUrl,
              credential,
              createdAt: "2026-07-25T00:00:00.000Z",
              updatedAt: "2026-07-25T00:00:00.000Z",
            };
          },
          loadProvider: mock(async () => provider),
          env: { RAVI_CLI_INSTALLATION_NAME: "Test runtime" } as NodeJS.ProcessEnv,
        },
      ),
    );
    const payload = JSON.parse(output);
    const encoded = JSON.stringify(payload);

    expect(writtenHuman).toMatchObject({
      consoleUrl: "https://auth.example",
      authMode: "remote",
      installationId: "client_installation_1",
      accessToken: "login-access-secret",
      refreshToken: "login-refresh-secret",
    });
    expect(writtenInstallation).toMatchObject({
      endpointUrl: "https://auth.example",
      clientInstallationId: "client_installation_1",
      credential: {
        provider: "example",
        credentialId: "credential_1",
        material: { privateKeyPem: "private-key-secret" },
      },
    });
    expect(payload.installationCredential).toEqual({
      endpointUrl: "https://auth.example",
      provider: "example",
      credentialId: "credential_1",
      publicMetadata: { installationId: "installation_1" },
    });
    expect(encoded).not.toContain("login-access-secret");
    expect(encoded).not.toContain("login-refresh-secret");
    expect(encoded).not.toContain("private-key-secret");
    expect(encoded).not.toContain("renewable-secret");
  });

  it("prompts for a remote endpoint only in an interactive login without stored credentials", async () => {
    const promptEndpoint = mock(async () => "https://auth.example");
    const discoverEndpoint = mock(async () => ({
      ...remoteDiscovery(),
      installationProvider: undefined,
    }));
    await captureConsole(() =>
      runLogin(
        { json: true, open: false, poll: false },
        {
          client: loginClient(),
          readCredentials: () => null,
          writeCredentials: () => {},
          ensureClientInstallationId: () => "client_installation_1",
          isInteractive: true,
          promptEndpoint,
          discoverEndpoint,
        },
      ),
    );

    expect(promptEndpoint).toHaveBeenCalledWith(DEFAULT_CONSOLE_URL);
    expect(discoverEndpoint).toHaveBeenCalledWith("https://auth.example");
  });

  it("rejects ambiguous or unsafe explicit login endpoint selection before reading credentials", async () => {
    const readCredentials = mock(() => makeCredentials());

    await expect(
      runLogin(
        {
          endpoint: "https://auth.example",
          console: "https://console.example",
          json: true,
          open: false,
          poll: false,
        },
        { readCredentials },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "PAYLOAD_INVALID" }));
    await expect(
      runLogin(
        {
          endpoint: "https://user:secret@auth.example",
          json: true,
          open: false,
          poll: false,
        },
        { readCredentials },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "PAYLOAD_INVALID",
        message: "Remote login endpoint must not contain credentials, query, or fragment.",
      }),
    );
    expect(readCredentials).not.toHaveBeenCalled();
  });

  it("revokes on logout, deletes local credentials, and redacts JSON output", async () => {
    const credentials = makeCredentials();
    let deleted = false;
    const client = {
      logout: mock(async () => ({ success: true })),
    } as unknown as ConsoleApiClient;

    const { output, result } = await captureConsole(() =>
      runLogout(
        { json: true },
        {
          client,
          readCredentials: () => credentials,
          deleteCredentials: () => {
            deleted = true;
          },
          writeCredentials: () => {},
        },
      ),
    );
    const payload = JSON.parse(output);
    const encoded = JSON.stringify(payload);

    expect(result).toEqual(payload);
    expect(deleted).toBe(true);
    expect(client.logout).toHaveBeenCalledWith(
      { refreshToken: "refresh-secret", installationId: "ins_123" },
      "access-secret",
    );
    expect(payload).toMatchObject({
      success: true,
      loggedOut: true,
      consoleUrl: "https://console.example",
      revoked: true,
    });
    expect(encoded).not.toContain("access-secret");
    expect(encoded).not.toContain("refresh-secret");
  });

  it("deletes the active human session when remote discovery is unavailable", async () => {
    const credentials = {
      ...makeCredentials(),
      consoleUrl: "https://auth.example",
      authMode: "remote" as const,
    };
    let deleted = false;

    const { output } = await captureConsole(() =>
      runLogout(
        { json: true },
        {
          readCredentials: () => credentials,
          deleteCredentials: () => {
            deleted = true;
          },
          writeCredentials: () => {},
          discoverEndpoint: async () => {
            throw new CloudAuthError("SERVER_UNAVAILABLE", "Remote login discovery failed.");
          },
        },
      ),
    );
    const payload = JSON.parse(output);

    expect(deleted).toBe(true);
    expect(payload).toMatchObject({
      success: true,
      loggedOut: true,
      consoleUrl: "https://auth.example",
      revoked: false,
      revokeError: {
        code: "SERVER_UNAVAILABLE",
      },
    });
  });

  it("deletes invalid local credentials even when Console revoke cannot run", async () => {
    let deleted = false;

    const { output, result } = await captureConsole(() =>
      runLogout(
        { json: true },
        {
          readCredentials: () => {
            throw new CloudAuthError("CREDENTIALS_INVALID", "Stored credentials are invalid.");
          },
          deleteCredentials: () => {
            deleted = true;
          },
          writeCredentials: () => {},
        },
      ),
    );
    const payload = JSON.parse(output);

    expect(result).toEqual(payload);
    expect(deleted).toBe(true);
    expect(payload).toMatchObject({
      success: true,
      loggedOut: true,
      consoleUrl: "https://console.ravi.bot",
      revoked: false,
      revokeError: {
        code: "CREDENTIALS_INVALID",
        message: "Stored credentials are invalid.",
      },
    });
  });
});

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["artifacts:publish"],
    user: { email: "alice@example.com" },
    organization: { id: "org_123", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}

function loginClient(): ConsoleApiClient {
  return {
    getAuthConfig: mock(async () => ({
      configured: true,
      clientId: "ravi-cli",
      mode: "console_device",
      endpoints: {
        deviceAuthorization: "https://auth.example/v1/device",
        token: null,
      },
    })),
    startDeviceAuthorization: mock(async () => ({
      verificationUriComplete: "https://auth.example/device?user_code=ABC",
      verificationUri: "https://auth.example/device",
      userCode: "ABC",
      deviceCode: "device-secret",
      interval: 1,
    })),
    exchange: mock(async (input: CredentialExchangeInput) => ({
      ...makeCredentials(),
      consoleUrl: "https://auth.example",
      installationId: input.installationId,
      accessToken: "login-access-secret",
      refreshToken: "login-refresh-secret",
    })),
  } as unknown as ConsoleApiClient;
}

function remoteDiscovery() {
  return {
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
  } as const;
}
