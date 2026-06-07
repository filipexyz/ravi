import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { PagesCommands } from "./pages.js";

describe("pages CLI commands", () => {
  it("lists project Pages sites through the Console CLI API", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return [
        {
          id: "site_1",
          slug: "demo",
          defaultHostname: "demo.ravi.page",
          defaultVisibility: "public",
          status: "active",
        },
      ];
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.list("proj", undefined, undefined, undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/cli/projects/proj/pages",
        body: undefined,
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      projectRef: "proj",
      total: 1,
      pagination: {
        limit: 50,
        offset: 0,
        returned: 1,
        total: 1,
      },
      sites: [{ slug: "demo", defaultHostname: "demo.ravi.page" }],
    });
  });

  it("creates a project Pages site through the Console CLI API", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        id: "site_1",
        slug: "demo",
        defaultHostname: "demo.ravi.page",
        defaultVisibility: "public",
        status: "active",
        isDefault: true,
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.create("proj", "demo", "public", true, undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/projects/proj/pages",
        body: {
          slug: "demo",
          defaultVisibility: "public",
          isDefault: true,
        },
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      projectRef: "proj",
      site: { slug: "demo", defaultHostname: "demo.ravi.page" },
      url: "https://demo.ravi.page/",
    });
  });

  it("updates a project Pages site visibility through the Console CLI API", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        site: {
          id: "site_1",
          slug: "demo",
          defaultHostname: "demo.ravi.page",
          defaultVisibility: "public",
          status: "active",
        },
        edgeManifestRepair: {
          status: "repaired",
        },
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.update("proj", "demo", "public", undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/cli/projects/proj/pages",
        body: {
          siteRef: "demo",
          defaultVisibility: "public",
        },
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      projectRef: "proj",
      siteRef: "demo",
      site: { slug: "demo", defaultVisibility: "public" },
      edgeManifestRepair: { status: "repaired" },
    });
  });

  it("sets Pages site visibility through the shortcut command", async () => {
    const calls: Array<{ body: unknown; method: string; path: string }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return {
        site: {
          id: "site_1",
          slug: "demo",
          defaultHostname: "demo.ravi.page",
          defaultVisibility: "private",
          status: "active",
        },
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    await captureConsole(() => command.visibility("proj", "demo", "private", undefined, true));

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/cli/projects/proj/pages",
        body: {
          siteRef: "demo",
          defaultVisibility: "private",
        },
      },
    ]);
  });

  it("binds custom hostnames to a project Pages site through the Console CLI API", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        bindings: [
          {
            id: "binding_1",
            hostname: "www.filipe.ai",
            product: "pages",
            status: "active",
            readiness: {
              mode: "serve",
            },
          },
          {
            id: "binding_2",
            hostname: "filipe.ai",
            product: "pages",
            status: "pending",
            readiness: {
              mode: "redirect",
            },
          },
        ],
        hostnames: ["www.filipe.ai", "filipe.ai"],
        site: {
          id: "site_1",
          slug: "filipe-ai",
          defaultHostname: "filipe-ai.ravi.page",
        },
        total: 2,
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.domains("filipe-ai", "filipe-ai", ["www.filipe.ai", "filipe.ai"], true, undefined, true),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/projects/filipe-ai/pages/filipe-ai/domains",
        body: {
          check: true,
          hostnames: ["www.filipe.ai", "filipe.ai"],
        },
        accessToken: "access-secret",
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      projectRef: "filipe-ai",
      siteRef: "filipe-ai",
      total: 2,
      bindings: [{ hostname: "www.filipe.ai" }, { hostname: "filipe.ai" }],
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
