import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { closeConsoleScopeStore, upsertConsoleScopeDefault } from "../../console-scope/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { PagesCommands } from "./pages.js";

const tempDirs: string[] = [];
let stateDir: string | null = null;

afterEach(async () => {
  closeConsoleScopeStore();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (stateDir) {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  }
});

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

    const { output } = await captureConsole(() =>
      command.list("proj", undefined, undefined, undefined, undefined, true),
    );
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

  it("lists published Pages through the versioned Console CLI API", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        pages: [
          {
            id: "release_route_1",
            title: "Docs",
            path: "/docs",
            defaultHostname: "demo.ravi.page",
            urls: ["https://demo.ravi.page/docs", "https://docs.example.com/docs"],
            status: "live · v3 · public",
          },
        ],
        total: 1,
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.published("proj", undefined, undefined, undefined, undefined, true),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/cli/projects/proj/pages/published",
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
      pages: [{ title: "Docs", urls: ["https://demo.ravi.page/docs", "https://docs.example.com/docs"] }],
      items: [{ title: "Docs" }],
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

    const { output } = await captureConsole(() =>
      command.create(["proj", "demo"], undefined, "public", true, undefined, true),
    );
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

    const { output } = await captureConsole(() =>
      command.update(["proj", "demo"], undefined, "public", undefined, true),
    );
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

    await captureConsole(() => command.visibility(["proj", "demo", "private"], undefined, undefined, true));

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
      command.domains(["filipe-ai", "filipe-ai", "www.filipe.ai", "filipe.ai"], undefined, true, undefined, true),
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

  it("publishes a local source to a Pages site through the artifact upload pipeline", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-publish-command-test-");
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Docs</h1>");
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1" },
      })),
      createPageUploadSession: mock(async (input: Record<string, unknown>, accessToken: string) => {
        expect(accessToken).toBe("access-secret");
        calls.push({ method: "createPageUploadSession", payload: input });
        expect(input).toMatchObject({
          projectRef: "proj",
          siteRef: "demo",
          idempotencyKey: "idem-1",
          packageManifest: {
            entrypoint: "index.html",
            files: [{ path: "index.html" }],
          },
        });
        return {
          uploadSession: { id: "upl_123" },
          uploadPolicy: { directUpload: false },
        };
      }),
      finalizeArtifactPublish: mock(async (input: Record<string, unknown>, accessToken: string) => {
        expect(accessToken).toBe("access-secret");
        calls.push({ method: "finalizeArtifactPublish", payload: input });
        expect(input).toMatchObject({
          uploadSessionId: "upl_123",
          idempotencyKey: "idem-1",
          artifact: {
            name: "Docs",
            description: "Docs page",
          },
          publish: {
            siteRef: "demo",
            activate: true,
            replaceRelease: true,
            reason: "ship docs",
            visibility: "public",
            route: {
              path: "/guide",
              visibility: "public",
            },
          },
          source: {
            tool: "ravi pages publish",
            target: "local_artifact",
            versionNumber: 1,
          },
        });
        return {
          artifact: { id: "cloud_art_123" },
          artifactVersion: { id: "cloud_ver_123", versionNumber: 1 },
          site: { id: "site_1", slug: "demo", defaultHostname: "demo.ravi.page", defaultVisibility: "public" },
          publish: { id: "pub_123" },
          release: { id: "rel_123", url: "https://demo.ravi.page/guide" },
          routes: [{ id: "route_123", path: "/guide" }],
        };
      }),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.publish(
        ["proj", "demo", dir],
        undefined,
        "/guide",
        "public",
        "Docs",
        undefined,
        "Docs page",
        "index.html",
        undefined,
        undefined,
        undefined,
        undefined,
        "idem-1",
        "ship docs",
        true,
        undefined,
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(calls.map((call) => call.method)).toEqual(["createPageUploadSession", "finalizeArtifactPublish"]);
    expect(payload).toMatchObject({
      success: true,
      url: "https://demo.ravi.page/guide",
      upload: { attempted: 0, skipped: 1 },
      site: { slug: "demo" },
      release: { id: "rel_123" },
    });
  });

  it("uses the saved Console scope when the Pages project is omitted", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-scope-command-test-");
    upsertConsoleScopeDefault({
      scopeKind: "session",
      scopeKey: "ravi-console",
      consoleUrl: "https://console.example",
      organization: { id: "org_1", name: "Acme" },
      project: { id: "proj_1", slug: "rbbt-ravi", name: "RBBT", ref: "rbbt-ravi" },
    });

    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return [{ id: "site_1", slug: "docs", defaultHostname: "docs.ravi.page" }];
    });
    const command = new PagesCommands({
      client,
      readCredentials: makeReadCredentials(),
      getContext: () => ({ sessionName: "ravi-console" }),
    });

    const { output } = await captureConsole(() =>
      command.list(undefined, undefined, undefined, undefined, undefined, true),
    );
    const payload = JSON.parse(output);

    expect(calls[0]?.path).toBe("/api/cli/projects/rbbt-ravi/pages");
    expect(payload).toMatchObject({
      success: true,
      projectRef: "rbbt-ravi",
      scope: {
        source: "session_default",
        project: { ref: "rbbt-ravi" },
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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ravi-pages-cli-test-"));
  tempDirs.push(dir);
  return dir;
}
