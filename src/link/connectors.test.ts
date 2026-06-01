import { describe, expect, it, mock } from "bun:test";

import type { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import type { LinkApiClient } from "./client.js";
import { startConnect } from "./connectors.js";

describe("connector link helpers", () => {
  it("resolves --project slug through Console and sends projectId to Link", async () => {
    const linkCalls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const consoleClient = makeConsoleClient(async () => [
      { id: "proj_1", slug: "nx-hv", name: "Namastex - Hapvida" },
      { id: "proj_2", slug: "r-console", name: "r-console" },
    ]);
    const link = makeLinkClient(async (method, path, accessToken, body) => {
      linkCalls.push({ method, path, accessToken, body });
      return {
        connectUrl: "https://provider.example/oauth",
        pendingGrantId: "grant_1",
        expiresAt: "2026-06-01T03:00:00.000Z",
      };
    });

    await startConnect(
      { provider: "google", project: "nx-hv", displayName: "Gmail Luis" },
      { consoleClient, link, readCredentials: makeReadCredentials() },
    );

    expect(linkCalls).toEqual([
      {
        method: "POST",
        path: "/cli/connect/start",
        accessToken: "access-secret",
        body: {
          provider: "google",
          projectId: "proj_1",
          scopes: undefined,
          displayName: "Gmail Luis",
        },
      },
    ]);
  });

  it("does not call Link without --project when multiple projects are accessible", async () => {
    const link = makeLinkClient(async () => {
      throw new Error("Link should not be called");
    });
    const consoleClient = makeConsoleClient(async () => [
      { id: "proj_1", slug: "nx-hv" },
      { id: "proj_2", slug: "r-console" },
    ]);

    await expect(
      startConnect({ provider: "google" }, { consoleClient, link, readCredentials: makeReadCredentials() }),
    ).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    } satisfies Partial<CloudAuthError>);
  });

  it("uses the only accessible project when --project is omitted", async () => {
    const linkCalls: Array<{ body: unknown }> = [];
    const consoleClient = makeConsoleClient(async () => [{ id: "proj_1", slug: "nx-hv" }]);
    const link = makeLinkClient(async (_method, _path, _accessToken, body) => {
      linkCalls.push({ body });
      return {
        connectUrl: "https://provider.example/oauth",
        pendingGrantId: "grant_1",
        expiresAt: "2026-06-01T03:00:00.000Z",
      };
    });

    await startConnect({ provider: "google" }, { consoleClient, link, readCredentials: makeReadCredentials() });

    expect(linkCalls[0]?.body).toMatchObject({ projectId: "proj_1" });
  });
});

function makeConsoleClient(handler: () => Promise<unknown>): ConsoleApiClient {
  return {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1" },
    })),
    requestJson: mock(async () => handler()),
  } as unknown as ConsoleApiClient;
}

function makeLinkClient(
  handler: (method: string, path: string, accessToken: string, body: unknown) => Promise<unknown>,
): LinkApiClient {
  return {
    request: mock(async (method: string, path: string, accessToken: string, body: unknown) =>
      handler(method, path, accessToken, body),
    ),
  } as unknown as LinkApiClient;
}

function makeReadCredentials() {
  return () =>
    ({
      version: 1,
      consoleUrl: "https://console.example",
      installationId: "ins_123",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      accessTokenExpiresAt: "2030-05-10T00:00:00.000Z",
      refreshTokenExpiresAt: "2030-06-10T00:00:00.000Z",
      scopes: ["console.projects.read", "console.projects.link"],
      user: { email: "alice@example.com" },
      organization: { id: "org_1", name: "Acme" },
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
    }) satisfies CloudCredentials;
}
