import { describe, expect, it, mock } from "bun:test";
import { ConsoleApiClient, getMeWithAutoRefresh, refreshCredentialsForStore } from "./client.js";
import { CloudAuthError } from "./errors.js";
import type { CloudCredentials } from "./types.js";

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

describe("ConsoleApiClient", () => {
  it("calls the Console CLI auth endpoints with JSON and bearer auth", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      calls.push(recordFetchCall(url, init));
      const path = new URL(url).pathname;
      if (path === "/api/cli/auth/config") {
        return jsonResponse({
          configured: true,
          clientId: "client_123",
          scopes: ["openid", "profile", "email"],
          endpoints: {
            deviceAuthorization: "https://api.workos.com/user_management/authorize/device",
            token: "https://api.workos.com/user_management/authenticate",
          },
        });
      }
      if (url === "https://api.workos.com/user_management/authorize/device") {
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABC",
          verification_uri: "https://console.example/device",
          verification_uri_complete: "https://console.example/device?user_code=ABC",
          expires_in: 600,
          interval: 1,
        });
      }
      if (url === "https://api.workos.com/user_management/authenticate") {
        return jsonResponse({
          access_token: "provider-secret",
          refresh_token: "provider-refresh-secret",
          token_type: "Bearer",
          expires_in: 900,
        });
      }
      if (path === "/api/cli/auth/exchange") {
        return jsonResponse({
          credentials: {
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
            accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
            refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
            scopes: ["artifacts:publish"],
            user: { email: "alice@example.com" },
            organization: { id: "org_123", name: "Acme" },
          },
        });
      }
      if (path === "/api/cli/me") {
        return jsonResponse({
          user: { email: "alice@example.com" },
          organization: { id: "org_123", name: "Acme" },
          installation: { id: "ins_123" },
          scopes: ["artifacts:publish"],
          accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
        });
      }
      return jsonResponse({ error: { code: "SERVER_UNAVAILABLE" } }, 500);
    });
    const client = new ConsoleApiClient({ consoleUrl: "https://console.example/", fetch: fetchImpl });

    const config = await client.getAuthConfig();
    const device = await client.startDeviceAuthorization(config);
    const providerToken = await client.pollDeviceToken(config, device.deviceCode);
    const credentials = await client.exchange({
      installationId: "ins_123",
      workosAccessToken: providerToken.accessToken,
    });
    const me = await client.me("access-secret");

    expect(config.clientId).toBe("client_123");
    expect(device.userCode).toBe("ABC");
    expect(providerToken.accessToken).toBe("provider-secret");
    expect(credentials).toMatchObject({
      consoleUrl: "https://console.example",
      installationId: "ins_123",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      scopes: ["artifacts:publish"],
      user: { email: "alice@example.com" },
    });
    expect(me.user?.email).toBe("alice@example.com");
    expect(calls).toMatchObject([
      {
        url: "https://console.example/api/cli/auth/config",
        method: "GET",
        headers: { Accept: "application/json" },
        body: null,
      },
      {
        url: "https://api.workos.com/user_management/authorize/device",
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: {
          client_id: "client_123",
          scope: "openid profile email",
        },
      },
      {
        url: "https://api.workos.com/user_management/authenticate",
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "device-secret",
          client_id: "client_123",
        },
      },
      {
        url: "https://console.example/api/cli/auth/exchange",
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: {
          installationId: "ins_123",
          workosAccessToken: "provider-secret",
        },
      },
      {
        url: "https://console.example/api/cli/me",
        method: "GET",
        headers: { Accept: "application/json", Authorization: "Bearer access-secret" },
        body: null,
      },
    ]);
  });

  it("maps Console safe error codes into CloudAuthError", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "AUTH_EXPIRED",
              message: "The CLI access token expired.",
            },
          },
          401,
        ),
    });

    try {
      await client.me("expired-token");
      throw new Error("Expected client.me to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).code).toBe("AUTH_EXPIRED");
      expect((error as CloudAuthError).status).toBe(401);
      expect((error as CloudAuthError).message).toBe("The CLI access token expired.");
    }
  });

  it("maps OAuth device authorization pending responses", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () =>
        jsonResponse(
          {
            error: "authorization_pending",
            error_description: "User has not completed authentication.",
          },
          400,
        ),
    });

    try {
      await client.pollDeviceToken(
        {
          configured: true,
          clientId: "client_123",
          endpoints: { token: "https://api.workos.com/user_management/authenticate" },
        },
        "device-secret",
      );
      throw new Error("Expected pollDeviceToken to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).code).toBe("AUTH_PENDING");
    }
  });

  it("refreshes once on AUTH_EXPIRED and preserves cached metadata omitted by refresh", async () => {
    const previous = makeCredentials();
    const calls: FetchCall[] = [];
    let meCalls = 0;
    let written: CloudCredentials | null = null;
    let deleted = false;
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async (url, init) => {
        calls.push(recordFetchCall(url, init));
        const path = new URL(url).pathname;
        if (path === "/api/cli/me") {
          meCalls += 1;
          if (meCalls === 1) {
            return jsonResponse({ error: { code: "AUTH_EXPIRED", message: "expired" } }, 401);
          }
          return jsonResponse({
            user: { email: "alice@example.com" },
            organization: { id: "org_123", name: "Acme" },
            installation: { id: "ins_123" },
            scopes: ["artifacts:publish"],
            accessTokenExpiresAt: "2026-05-10T01:00:00.000Z",
          });
        }
        if (path === "/api/cli/auth/refresh") {
          return jsonResponse({
            accessToken: "new-access-secret",
            refreshToken: "new-refresh-secret",
            accessTokenExpiresAt: "2026-05-10T01:00:00.000Z",
          });
        }
        return jsonResponse({ error: { code: "SERVER_UNAVAILABLE" } }, 500);
      },
    });

    const result = await getMeWithAutoRefresh({
      client,
      credentials: previous,
      write: (credentials) => {
        written = credentials;
      },
      delete: () => {
        deleted = true;
      },
    });

    expect(result.credentials.accessToken).toBe("new-access-secret");
    expect(result.me.accessTokenExpiresAt).toBe("2026-05-10T01:00:00.000Z");
    expect(written).toMatchObject({
      accessToken: "new-access-secret",
      refreshToken: "new-refresh-secret",
      scopes: ["artifacts:publish"],
      user: { email: "alice@example.com" },
      organization: { id: "org_123", name: "Acme" },
    });
    expect(deleted).toBe(false);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/cli/me",
      "/api/cli/auth/refresh",
      "/api/cli/me",
    ]);
    expect(calls[1]?.body).toEqual({ refreshToken: "refresh-secret", installationId: "ins_123" });
    expect(calls[2]?.headers.Authorization).toBe("Bearer new-access-secret");
  });

  it("deletes local credentials when refresh is revoked", async () => {
    let deleted = false;
    let wrote = false;
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () => jsonResponse({ error: { code: "INSTALLATION_REVOKED", message: "revoked" } }, 403),
    });

    try {
      await refreshCredentialsForStore({
        client,
        credentials: makeCredentials(),
        write: () => {
          wrote = true;
        },
        delete: () => {
          deleted = true;
        },
      });
      throw new Error("Expected refreshCredentialsForStore to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).code).toBe("INSTALLATION_REVOKED");
    }

    expect(wrote).toBe(false);
    expect(deleted).toBe(true);
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordFetchCall(url: string, init?: RequestInit): FetchCall {
  const rawBody = typeof init?.body === "string" ? init.body : null;
  return {
    url,
    method: init?.method,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: rawBody ? parseBody(rawBody, (init?.headers ?? {}) as Record<string, string>) : null,
  };
}

function parseBody(body: string, headers: Record<string, string>): unknown {
  if (headers["Content-Type"] === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(body).entries());
  }
  return JSON.parse(body) as unknown;
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
