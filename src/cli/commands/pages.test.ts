import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { closeConsoleScopeStore, upsertConsoleScopeDefault } from "../../console-scope/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runWithContext } from "../context.js";
import { getCliOnlyMetadata, getOptionsMetadata } from "../decorators.js";
import { PagesCommands, PagesPasswordCommands } from "./pages.js";

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
  it("sets a route password through hidden input and emits only an allowlisted result", async () => {
    const secret = "correct horse battery staple";
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return passwordResponse({
        action: "set",
        configured: true,
        policy: {
          configured: true,
          id: "policy_1",
          passwordHash: "must-be-discarded",
          rotatedAt: "2026-08-03T12:00:00.000Z",
          scope: "route",
          status: "active",
          version: 2,
        },
        unexpectedPassword: secret,
      });
    });
    const command = new PagesPasswordCommands({
      client,
      readCredentials: makeReadCredentials(),
      readPassword: async (options) => {
        expect(options).toMatchObject({ fromStdin: false, prompt: "Page password: " });
        return secret;
      },
    });

    const { output } = await captureConsole(() =>
      command.set(["proj", "demo"], undefined, "/report", false, undefined, true),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        accessToken: "access-secret",
        body: { action: "set", password: secret, path: "/report", siteRef: "demo" },
        method: "POST",
        path: "/api/cli/projects/proj/pages/password",
      },
    ]);
    expect(payload).toMatchObject({
      action: "set",
      configured: true,
      path: "/report",
      policy: { id: "policy_1", status: "active", version: 2 },
      success: true,
      url: "https://demo.ravi.page/report",
    });
    expect(output).not.toContain(secret);
    expect(output).not.toContain("passwordHash");
    expect(output).not.toContain("unexpectedPassword");
  });

  it("reads password status without invoking secret input", async () => {
    const client = makeClient(async () => passwordResponse({ action: "status", configured: false, policy: null }));
    const command = new PagesPasswordCommands({
      client,
      readCredentials: makeReadCredentials(),
      readPassword: async () => {
        throw new Error("unexpected password prompt");
      },
    });

    const { output } = await captureConsole(() =>
      command.status(["proj", "demo"], undefined, undefined, undefined, true),
    );

    expect(JSON.parse(output)).toMatchObject({ action: "status", configured: false, policy: null });
  });

  it("requires an explicit replacement visibility when removing password access", async () => {
    const command = new PagesPasswordCommands({
      client: makeClient(async () => passwordResponse()),
      readCredentials: makeReadCredentials(),
    });

    const { result } = await captureConsole(() =>
      runWithContext({}, () =>
        command
          .remove(["proj", "demo"], undefined, undefined, undefined, undefined, true)
          .then(() => null)
          .catch((error) => error),
      ),
    );
    expect(result).toMatchObject({ code: "PAYLOAD_INVALID" });
  });

  it("does not expose a password argument or option in command metadata", () => {
    const options = getOptionsMetadata(new PagesPasswordCommands(), "set");
    expect(options.map((option) => option.flags)).not.toContain("--password <value>");
    expect(options.map((option) => option.flags)).toContain("--stdin");
    expect(getCliOnlyMetadata(PagesPasswordCommands)).toContain("set");
  });

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

  it("activates by default and disables activation only with --no-activate", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-publish-command-test-");
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Docs</h1>");
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const activations: boolean[] = [];
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
        activations.push((input.publish as { activate?: boolean } | undefined)?.activate ?? false);
        expect(input).toMatchObject({
          uploadSessionId: "upl_123",
          idempotencyKey: "idem-1",
          artifact: {
            name: "Docs",
            description: "Docs page",
          },
          publish: {
            siteRef: "demo",
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

    const publish = (noActivate?: boolean) =>
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
        noActivate,
        undefined,
        true,
      );

    const defaultResult = await captureConsole(() => publish());
    const noActivateResult = await captureConsole(() => publish(true));
    const payload = JSON.parse(noActivateResult.output);

    expect(JSON.parse(defaultResult.output)).toMatchObject({ success: true });
    expect(calls.map((call) => call.method)).toEqual([
      "createPageUploadSession",
      "finalizeArtifactPublish",
      "createPageUploadSession",
      "finalizeArtifactPublish",
    ]);
    expect(activations).toEqual([true, false]);
    expect(payload).toMatchObject({
      success: true,
      url: "https://demo.ravi.page/guide",
      upload: { attempted: 0, skipped: 1 },
      site: { slug: "demo" },
      release: { id: "rel_123" },
    });
  });

  it("publishes to the project Pages host without an explicit site slug", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-project-publish-command-test-");
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Project Docs</h1>");
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
          siteRef: null,
          packageManifest: {
            entrypoint: "index.html",
            files: [{ path: "index.html" }],
          },
        });
        return {
          uploadSession: { id: "upl_project_host" },
          uploadPolicy: { directUpload: false },
        };
      }),
      finalizeArtifactPublish: mock(async (input: Record<string, unknown>, accessToken: string) => {
        expect(accessToken).toBe("access-secret");
        calls.push({ method: "finalizeArtifactPublish", payload: input });
        expect(input).toMatchObject({
          uploadSessionId: "upl_project_host",
          publish: {
            activate: true,
            replaceRelease: false,
            route: {
              path: "/",
            },
          },
          source: {
            tool: "ravi pages publish",
          },
        });
        expect((input.publish as Record<string, unknown>).siteRef).toBeUndefined();
        return {
          artifact: { id: "cloud_art_project" },
          artifactVersion: { id: "cloud_ver_project", versionNumber: 1 },
          site: {
            id: "site_1",
            slug: "rbbt-core",
            defaultHostname: "rbbt-core.ravi.page",
            defaultVisibility: "public",
          },
          publish: { id: "pub_project" },
          release: { id: "rel_project", url: "https://rbbt-core.ravi.page/" },
          routes: [{ id: "route_project", path: "/" }],
          url: "https://rbbt-core.ravi.page/",
        };
      }),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.publish(
        ["proj", dir],
        undefined,
        undefined,
        undefined,
        "Project Docs",
        undefined,
        undefined,
        "index.html",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(calls.map((call) => call.method)).toEqual(["createPageUploadSession", "finalizeArtifactPublish"]);
    expect(payload).toMatchObject({
      success: true,
      url: "https://rbbt-core.ravi.page/",
      site: { slug: "rbbt-core" },
      release: { id: "rel_project" },
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

function passwordResponse(overrides: Record<string, unknown> = {}) {
  return {
    action: "set",
    configured: true,
    path: "/report",
    policy: {
      configured: true,
      id: "policy_1",
      rotatedAt: "2026-08-03T12:00:00.000Z",
      scope: "route",
      status: "active",
      version: 1,
    },
    projectRef: "proj",
    release: { id: "release_2", number: 2 },
    route: {
      bindingId: "binding_2",
      effectiveVisibility: "password",
      id: "route_1",
      path: "/report",
      visibility: "password",
    },
    scope: "route",
    site: { defaultHostname: "demo.ravi.page", id: "site_1", projectId: "project_1" },
    siteRef: "demo",
    url: "https://demo.ravi.page/report",
    ...overrides,
  };
}

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
