import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import type { CloudCredentials, CredentialExchangeInput } from "../../cloud-auth/types.js";
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
        clientId: "client_123",
        endpoints: {
          deviceAuthorization: "https://api.workos.com/user_management/authorize/device",
          token: "https://api.workos.com/user_management/authenticate",
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
      workosAccessToken: "provider-secret",
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
