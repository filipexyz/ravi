import { describe, expect, it, mock } from "bun:test";
import {
  ConsoleApiClient,
  credentialsFromConsoleResponse,
  getMeWithAutoRefresh,
  normalizeConsoleUrl,
  refreshCredentialsForStore,
} from "./client.js";
import { CloudAuthError } from "./errors.js";
import type { CloudCredentials } from "./types.js";

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

describe("ConsoleApiClient", () => {
  it("only allows insecure console URLs for local development", () => {
    const previous = process.env.RAVI_ALLOW_INSECURE_CONSOLE_URL;
    try {
      delete process.env.RAVI_ALLOW_INSECURE_CONSOLE_URL;
      expect(normalizeConsoleUrl("http://localhost:3000")).toBe("http://localhost:3000");
      expect(() => normalizeConsoleUrl("http://console.example")).toThrow(CloudAuthError);

      process.env.RAVI_ALLOW_INSECURE_CONSOLE_URL = "true";
      expect(normalizeConsoleUrl("http://console.example")).toBe("http://console.example");
    } finally {
      if (previous === undefined) {
        delete process.env.RAVI_ALLOW_INSECURE_CONSOLE_URL;
      } else {
        process.env.RAVI_ALLOW_INSECURE_CONSOLE_URL = previous;
      }
    }
  });

  it("calls the Console CLI auth endpoints with JSON and bearer auth", async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      calls.push(recordFetchCall(url, init));
      const path = new URL(url).pathname;
      if (path === "/api/cli/auth/config") {
        return jsonResponse({
          configured: true,
          clientId: "ravi-cli",
          mode: "console_device",
          scopes: [],
          endpoints: {
            deviceAuthorization: "https://console.example/api/cli/auth/device",
            token: null,
          },
        });
      }
      if (path === "/api/cli/auth/device") {
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABC",
          verification_uri: "https://console.example/cli/authorize",
          verification_uri_complete: "https://console.example/cli/authorize?user_code=ABC",
          expires_in: 600,
          interval: 1,
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
    const credentials = await client.exchange({
      installationId: "ins_123",
      deviceCode: device.deviceCode,
    });
    const me = await client.me("access-secret");

    expect(config.clientId).toBe("ravi-cli");
    expect(device.userCode).toBe("ABC");
    expect(device.verificationUri).toBe("https://console.example/cli/authorize");
    expect(device.verificationUriComplete).toBe("https://console.example/cli/authorize?user_code=ABC");
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
        headers: { Accept: "application/json", "x-ravi-cli-auth-flow": "console_device" },
        body: null,
      },
      {
        url: "https://console.example/api/cli/auth/device",
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: {
          client_id: "ravi-cli",
        },
      },
      {
        url: "https://console.example/api/cli/auth/exchange",
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: {
          installationId: "ins_123",
          deviceCode: "device-secret",
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

  it("constructs verification_uri_complete from verification_uri and user_code when omitted", async () => {
    const fetchImpl = mock(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/cli/auth/config") {
        return jsonResponse({
          configured: true,
          clientId: "ravi-cli",
          mode: "console_device",
          endpoints: {
            deviceAuthorization: "https://console.example/api/cli/auth/device",
            token: null,
          },
        });
      }
      if (path === "/api/cli/auth/device") {
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://console.example/cli/authorize",
          expires_in: 600,
          interval: 1,
        });
      }
      return jsonResponse({ error: { code: "SERVER_UNAVAILABLE" } }, 500);
    });
    const client = new ConsoleApiClient({ consoleUrl: "https://console.example/", fetch: fetchImpl });
    const device = await client.startDeviceAuthorization(await client.getAuthConfig());

    expect(device.verificationUri).toBe("https://console.example/cli/authorize");
    expect(device.verificationUriComplete).toBe("https://console.example/cli/authorize?user_code=ABCD-EFGH");
    expect(new URL(device.verificationUriComplete).searchParams.get("user_code")).toBe("ABCD-EFGH");
  });

  it("does not treat a bare verification_uri_complete as the URL to open", async () => {
    const fetchImpl = mock(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/cli/auth/config") {
        return jsonResponse({
          configured: true,
          clientId: "ravi-cli",
          mode: "console_device",
          endpoints: {
            deviceAuthorization: "https://console.example/api/cli/auth/device",
            token: null,
          },
        });
      }
      if (path === "/api/cli/auth/device") {
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://console.example/cli/authorize",
          verification_uri_complete: "https://console.example/cli/authorize",
          expires_in: 600,
          interval: 1,
        });
      }
      return jsonResponse({ error: { code: "SERVER_UNAVAILABLE" } }, 500);
    });
    const client = new ConsoleApiClient({ consoleUrl: "https://console.example/", fetch: fetchImpl });
    const device = await client.startDeviceAuthorization(await client.getAuthConfig());

    expect(device.verificationUriComplete).toBe("https://console.example/cli/authorize?user_code=ABCD-EFGH");
  });

  it("creates artifact upload sessions through the CLI bearer endpoint", async () => {
    const calls: FetchCall[] = [];
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async (url, init) => {
        calls.push(recordFetchCall(url, init));
        return jsonResponse({
          uploadSession: { id: "upl_123" },
          uploadPolicy: { directUpload: false },
        });
      },
    });

    const result = await client.createPageUploadSession(
      {
        projectRef: "proj_123",
        siteRef: "docs",
        idempotencyKey: "idem_123",
        packageManifest: {
          entrypoint: "index.html",
          files: [
            {
              path: "index.html",
              sha256: "abc123",
              sizeBytes: 2,
              contentType: "text/html; charset=utf-8",
            },
          ],
        },
      },
      "access-secret",
    );

    expect(result.uploadSession).toEqual({ id: "upl_123" });
    expect(calls).toMatchObject([
      {
        url: "https://console.example/api/cli/artifacts/upload-sessions",
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer access-secret",
        },
        body: {
          projectRef: "proj_123",
          siteRef: "docs",
          idempotencyKey: "idem_123",
          packageManifest: {
            entrypoint: "index.html",
            files: [
              {
                path: "index.html",
                sha256: "abc123",
                sizeBytes: 2,
                contentType: "text/html; charset=utf-8",
              },
            ],
          },
        },
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

  it("preserves the Pages domain setup code and safe DNS instruction", async () => {
    const message = [
      "Pages domain setup was saved but is not ready yet.",
      "TXT _ravi-verify.example.com = ravi-domain-verification=test-token",
    ].join("\n");
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: "DOMAIN_SETUP_REQUIRED",
              message,
            },
          },
          400,
        ),
    });

    try {
      await client.requestJson("POST", "/api/cli/projects/proj/pages/site/domains", {
        hostnames: ["docs.example.com"],
      });
      throw new Error("Expected domain setup to remain pending");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect(error).toMatchObject({
        code: "DOMAIN_SETUP_REQUIRED",
        message,
        status: 400,
      });
    }
  });

  it("keeps Console 422 validation issues on the mapped error", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () =>
        jsonResponse(
          {
            error: "ValidationError",
            message: "Invalid create body",
            issues: [{ path: ["title"], code: "invalid_type", message: "Expected string, received undefined" }],
          },
          422,
        ),
    });

    try {
      await client.requestJson("POST", "/api/cli/credentials", { title: 1 });
      throw new Error("Expected console validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect(error).toMatchObject({
        code: "PAYLOAD_INVALID",
        status: 422,
        issues: [{ path: ["title"], code: "invalid_type", message: "Expected string, received undefined" }],
      });
    }
  });

  it("maps sandbox Console fetch failures to HOST_UNREACHABLE", async () => {
    const previousPlane = process.env.RAVI_EXECUTION_PLANE;
    process.env.RAVI_EXECUTION_PLANE = "provider-sandbox";
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () => {
        throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      },
    });

    try {
      await expect(client.requestJson("GET", "/api/cli/projects/rbbt-lab/pages/published")).rejects.toMatchObject({
        code: "HOST_UNREACHABLE",
      });
    } finally {
      if (previousPlane === undefined) delete process.env.RAVI_EXECUTION_PLANE;
      else process.env.RAVI_EXECUTION_PLANE = previousPlane;
    }
  });

  it("keeps host Console fetch failures as SERVER_UNAVAILABLE", async () => {
    const previousPlane = process.env.RAVI_EXECUTION_PLANE;
    process.env.RAVI_EXECUTION_PLANE = "host";
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () => {
        throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
      },
    });

    try {
      await expect(client.requestJson("GET", "/api/cli/projects/rbbt-lab/pages/published")).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
    } finally {
      if (previousPlane === undefined) delete process.env.RAVI_EXECUTION_PLANE;
      else process.env.RAVI_EXECUTION_PLANE = previousPlane;
    }
  });

  it("exposes Retry-After seconds on RATE_LIMITED exchange errors", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () =>
        jsonResponse({ error: { code: "RATE_LIMITED", message: "slow down" } }, 429, { "Retry-After": "15" }),
    });

    await expect(client.exchange({ installationId: "ins_123", deviceCode: "device-secret" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      retryAfterMs: 15_000,
    });
  });

  it("prefers the Retry-After header over a body retry_after hint", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () =>
        jsonResponse({ error: { code: "SERVER_UNAVAILABLE", retry_after: 30 } }, 503, { "Retry-After": "2" }),
    });

    await expect(client.exchange({ installationId: "ins_123", deviceCode: "device-secret" })).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      status: 503,
      retryAfterMs: 2_000,
    });
  });

  it("reads retry_after seconds from the error body when the header is absent", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () => jsonResponse({ error: { code: "RATE_LIMITED", retry_after: 15 } }, 429),
    });

    await expect(client.exchange({ installationId: "ins_123", deviceCode: "device-secret" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 15_000,
    });
  });

  it("parses an HTTP-date Retry-After on the device token endpoint", async () => {
    const retryAt = Date.now() + 20_000;
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () =>
        jsonResponse({ error: "too_many_requests" }, 429, { "Retry-After": new Date(retryAt).toUTCString() }),
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
      const retryAfterMs = (error as CloudAuthError).retryAfterMs ?? -1;
      expect((error as CloudAuthError).code).toBe("RATE_LIMITED");
      expect(retryAfterMs).toBeGreaterThan(15_000);
      expect(retryAfterMs).toBeLessThanOrEqual(21_000);
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

  it("deletes local credentials when refresh returns 404 NOT_FOUND", async () => {
    let deleted = false;
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: async () => jsonResponse({ error: { code: "NOT_FOUND", message: "unknown installation" } }, 404),
    });

    try {
      await refreshCredentialsForStore({
        client,
        credentials: makeCredentials(),
        write: () => {},
        delete: () => {
          deleted = true;
        },
      });
      throw new Error("Expected refreshCredentialsForStore to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).code).toBe("CREDENTIALS_INVALID");
    }

    expect(deleted).toBe(true);
  });

  it("creates, polls and cancels link requests without sending installation ids", async () => {
    const calls: FetchCall[] = [];
    const request = { id: "lr_1", status: "pending" as const, expiresAt: "2026-09-16T14:10:00.000Z" };
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: mock(async (url: string, init?: RequestInit) => {
        calls.push(recordFetchCall(url, init));
        const path = new URL(url).pathname;
        if (path === "/api/cli/link/requests" && init?.method === "POST") {
          return jsonResponse(
            { version: 1, status: "pending", request, approveUrl: "https://console.example/link/ravi_lr_token" },
            201,
          );
        }
        if (path === "/api/cli/link/requests/lr_1" && init?.method === "GET") {
          return jsonResponse({
            version: 1,
            request: { ...request, status: "approved", approvedAt: "2026-09-16T14:02:00.000Z" },
            binding: {
              id: "bind_1",
              contactId: "luis",
              consoleUserId: "user_alice",
              organizationId: "org_123",
              installationId: "ins_console",
              platformIdentities: { channel: "slack", platformUserId: "U123" },
              status: "active",
            },
          });
        }
        if (path === "/api/cli/link/requests/lr_1" && init?.method === "DELETE") {
          return jsonResponse({ version: 1, request: { ...request, status: "cancelled" } });
        }
        if (path === "/api/cli/link" && init?.method === "GET") {
          return jsonResponse({ version: 1, binding: null });
        }
        if (path === "/api/cli/link/unlink" && init?.method === "POST") {
          return jsonResponse({ version: 1, binding: null });
        }
        return jsonResponse({ error: { code: "SERVER_UNAVAILABLE" } }, 500);
      }),
    });

    const created = await client.createLinkRequest(
      {
        contactId: "luis",
        platformIdentities: { channel: "slack", accountId: "acme", platformUserId: "U123" },
        requester: { displayName: " Luís Filipe " },
        expectedEmail: "luis@example.com",
      },
      "access-secret",
    );
    const polled = await client.getLinkRequest("lr_1", "access-secret");
    const cancelled = await client.cancelLinkRequest("lr_1", "access-secret");
    await client.resolveActorBinding({ contactId: "luis" }, "access-secret");
    await client.unlinkActorBinding({ contactId: "luis" }, "access-secret");

    expect(created).toEqual({
      status: "pending",
      request,
      approveUrl: "https://console.example/link/ravi_lr_token",
    });
    expect(polled.request).toMatchObject({ id: "lr_1", status: "approved" });
    expect(polled.binding).toMatchObject({
      contactId: "luis",
      consoleUserId: "user_alice",
      installationId: "ins_console",
    });
    expect(cancelled.status).toBe("cancelled");
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /api/cli/link/requests",
      "GET /api/cli/link/requests/lr_1",
      "DELETE /api/cli/link/requests/lr_1",
      "GET /api/cli/link",
      "POST /api/cli/link/unlink",
    ]);
    expect(calls[0]?.body).toEqual({
      contactId: "luis",
      platformIdentities: { channel: "slack", accountId: "acme", platformUserId: "U123" },
      requester: { displayName: "Luís Filipe" },
      expectedEmail: "luis@example.com",
    });
    expect(new URL(calls[3]!.url).search).toBe("?contactId=luis");
    expect(calls[4]?.body).toEqual({ contactId: "luis" });
  });

  it("returns an existing binding without a link when the contact is already linked", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: mock(async () =>
        jsonResponse({
          version: 1,
          status: "already_linked",
          binding: {
            contactId: "luis",
            consoleUserId: "user_alice",
            organizationId: "org_123",
            installationId: "ins_console",
            status: "active",
          },
        }),
      ),
    });

    const result = await client.createLinkRequest({ contactId: "luis" }, "access-secret");
    expect(result).toMatchObject({ status: "already_linked", binding: { consoleUserId: "user_alice" } });
    expect("approveUrl" in result).toBe(false);
  });

  it("maps Console link error codes onto CLI codes", async () => {
    const responses = [
      jsonResponse({ error: { code: "CONFLICT", message: "already bound" } }, 409),
      jsonResponse({ error: { code: "NOT_MEMBER" } }, 403),
      jsonResponse({ error: { code: "INSTALLATION_ORG_MISMATCH" } }, 409),
      jsonResponse({ error: { code: "LOCAL_INSTALLATION_MISSING" } }, 404),
      jsonResponse({ error: { code: "INSTALLATION_MISMATCH" } }, 403),
      new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } }),
    ];
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: mock(async () => responses.shift() ?? jsonResponse({ error: { code: "SERVER_UNAVAILABLE" } }, 500)),
    });
    const create = () => client.createLinkRequest({ contactId: "luis" }, "access-secret");

    await expect(create()).rejects.toMatchObject({ code: "ACTOR_BINDING_CONFLICT", status: 409 });
    await expect(create()).rejects.toMatchObject({ code: "ORG_ACCESS_DENIED", status: 403 });
    await expect(create()).rejects.toMatchObject({ code: "ORG_ACCESS_DENIED", status: 409 });
    await expect(create()).rejects.toMatchObject({ code: "LOCAL_INSTALLATION_MISSING", status: 404 });
    await expect(create()).rejects.toMatchObject({ code: "INSTALLATION_MISMATCH", status: 403 });
    await expect(create()).rejects.toMatchObject({ code: "LINK_REQUESTS_UNAVAILABLE", status: 404 });
  });

  it("surfaces resolve failures instead of reporting the contact as unlinked", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: mock(async () => jsonResponse({ error: { code: "LOCAL_INSTALLATION_MISSING" } }, 404)),
    });

    await expect(client.resolveActorBinding({ contactId: "luis" }, "access-secret")).rejects.toMatchObject({
      code: "LOCAL_INSTALLATION_MISSING",
    });
  });

  it("stores the Console's localInstallation id from exchange responses", () => {
    const credentials = credentialsFromConsoleResponse(
      {
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        localInstallation: { id: "ins_console", name: "luis-mac" },
        user: { id: "user_alice" },
        organization: { id: "org_123" },
      },
      "https://console.example",
      "local-random-uuid",
    );

    expect(credentials.installationId).toBe("ins_console");
  });

  it("treats a null Console binding as unresolved", async () => {
    const client = new ConsoleApiClient({
      consoleUrl: "https://console.example",
      fetch: mock(async () => jsonResponse({ version: 1, binding: null })),
    });

    await expect(client.resolveActorBinding({ contactId: "missing" }, "access-secret")).resolves.toBeNull();
  });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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
