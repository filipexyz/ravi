import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { CloudProjectsCommands } from "./cloud-projects.js";

describe("cloud projects CLI commands", () => {
  it("lists Ravi Cloud projects through the Console CLI API", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return [
        {
          id: "proj_1",
          slug: "nx-hv",
          name: "Namastex - Hapvida",
          defaultVisibility: "private",
        },
      ];
    });
    const command = new CloudProjectsCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.list(undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/cli/projects",
        body: undefined,
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      total: 1,
      projects: [{ slug: "nx-hv", name: "Namastex - Hapvida" }],
    });
  });

  it("creates a Ravi Cloud project without a default page site by default", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        project: {
          id: "proj_1",
          slug: "nx-hv",
          name: "Namastex - Hapvida",
          defaultVisibility: "private",
        },
        redirectTo: "/p/proj_1",
      };
    });
    const command = new CloudProjectsCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.create("nx-hv", "Namastex - Hapvida", undefined, "private", undefined, undefined, true),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/projects",
        body: {
          name: "Namastex - Hapvida",
          slug: "nx-hv",
          description: null,
          defaultVisibility: "private",
          createDefaultPageSite: false,
        },
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      project: { slug: "nx-hv", name: "Namastex - Hapvida" },
      redirectTo: "/p/proj_1",
    });
  });

  it("can explicitly request a default page site during project creation", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        project: {
          id: "proj_1",
          slug: "demo",
          name: "Demo",
          defaultVisibility: "private",
        },
      };
    });
    const command = new CloudProjectsCommands({ client, readCredentials: makeReadCredentials() });

    await captureConsole(() => command.create("demo", "Demo", undefined, undefined, "demo", undefined, true));

    expect(calls[0]?.body).toEqual({
      name: "Demo",
      slug: "demo",
      description: null,
      defaultVisibility: "private",
      createDefaultPageSite: true,
      defaultPageSiteSlug: "demo",
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

function makeClient(
  handler: (method: string, path: string, body: unknown, accessToken: string) => Promise<unknown>,
): ConsoleApiClient {
  return {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1" },
    })),
    requestJson: mock(async (method: string, path: string, body: unknown, accessToken: string) =>
      handler(method, path, body, accessToken),
    ),
  } as unknown as ConsoleApiClient;
}

function makeReadCredentials() {
  return () => makeCredentials();
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
    scopes: ["console.projects.read", "console.projects.link"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
