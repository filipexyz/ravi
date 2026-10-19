import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { closeConsoleScopeStore, upsertConsoleScopeDefault } from "../../console-scope/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { getCliOnlyMetadata, getCommandsMetadata, getOptionsMetadata, getReturnsMetadata } from "../decorators.js";
import { dbCreateAgent } from "../../router/router-db.js";
import { dbListTriggers } from "../../triggers/triggers-db.js";
import { pageCommentFilter } from "../../pages/comment-follow.js";
import { SHIP_LIVE_DATA_OVERRIDE_WARNING, SHIP_LIVE_DATA_REFUSAL_LINES, wrapHtml5Document } from "../../pages/ship.js";
import { PagesAssertionAudienceCommands, PagesChatCommands, PagesCommands, PagesPasswordCommands } from "./pages.js";

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
      command.set(["proj", "demo"], undefined, "/report", false, undefined, true, true),
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

  it("marks ship as the one-shot and create/publish as advanced/compat", () => {
    const commands = getCommandsMetadata(PagesCommands);
    const byName = Object.fromEntries(commands.map((command) => [command.name, command]));
    expect(byName.ship?.description).toContain("One-shot");
    expect(byName.ship?.helpAfter).toContain('ravi pages ship --title "Weekly report" --body "<h1>OK</h1>" --json');
    expect(byName.ship?.helpAfter).not.toContain("--json --execute");
    expect(byName.create?.description).toMatch(/Advanced\/compat|host-only/i);
    expect(byName.create?.helpAfter).toContain("Prefer");
    expect(byName.publish?.description).toMatch(/Advanced\/compat|art_\*/);
    expect(byName.publish?.helpAfter).toContain("Prefer");
    expect(byName.visibility?.helpAfter).toContain("--route");
    expect(byName.visibility?.helpAfter).toContain("defaultVisibility");
    expect(getOptionsMetadata(new PagesCommands(), "visibility").map((option) => option.flags)).toContain(
      "--route <path>",
    );
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

  it("shows a host's pending custom domain with the DNS still missing", async () => {
    const client = makeClient(async () => [
      {
        id: "site_1",
        slug: "demo",
        defaultHostname: "demo.ravi.page",
        defaultVisibility: "public",
        status: "active",
        customDomains: [
          { hostname: "docs.example.com", status: "ready" },
          {
            hostname: "example.com",
            status: "pending",
            apex: true,
            nextAction: {
              code: "configure_pages_dns",
              message: "Add or keep these records in the hostname's authoritative DNS.",
              dnsRecords: [{ name: "example.com", type: "CNAME", value: "cname.ravi.page" }],
            },
          },
        ],
      },
    ]);
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.list("proj"));

    expect(output).toContain("custom domain docs.example.com  ready");
    expect(output).toContain("custom domain example.com  not serving yet: the DNS below is missing");
    expect(output).toContain("CNAME example.com = cname.ravi.page");
    expect(output).toContain("a plain A record does not reach Pages");
    expect(output).toContain("Check again: ravi pages domains demo example.com --project proj --check --execute");
  });

  it("lists a host's pending custom domains once below its published Pages", async () => {
    const pending = {
      hostname: "www.example.com",
      status: "pending",
      nextAction: {
        code: "wait_for_pages",
        message: "Ravi Pages is still provisioning this hostname.",
        dnsRecords: [],
      },
    };
    const client = makeClient(async () => ({
      pages: ["/", "/docs"].map((path) => ({
        id: `release_route${path}`,
        title: path,
        path,
        siteSlug: "demo",
        defaultHostname: "demo.ravi.page",
        urls: [`https://demo.ravi.page${path}`],
        customDomains: [pending],
      })),
      total: 2,
    }));
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.published("proj"));

    expect(output).toContain("Custom domains of demo not serving yet");
    expect(output.match(/custom domain www\.example\.com/g)).toHaveLength(1);
    expect(output).toContain("Ravi Pages is still provisioning it");
    expect(output).not.toContain("https://www.example.com");
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
      command.create(["proj", "demo"], undefined, "public", true, undefined, true, true),
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
    expect(payload.contentPublishCommand).toContain("ravi pages publish");
    expect(payload.contentPublishCommand).not.toContain("--execute");
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
      command.update(["proj", "demo"], undefined, "public", undefined, true, true),
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

    await captureConsole(() => command.visibility(["proj", "demo", "private"], undefined, undefined, undefined, true));

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

  it("updates one route visibility through the authorized Console route API", async () => {
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
        route: {
          bindingId: "binding_1",
          effectiveVisibility: "public",
          id: "route_1",
          path: "/",
          visibility: "public",
        },
        url: "https://demo.ravi.page/",
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.visibility(["proj", "demo", "public"], undefined, "/", undefined, true, true),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/cli/projects/proj/pages/visibility",
        body: {
          siteRef: "demo",
          path: "/",
          visibility: "public",
        },
      },
    ]);
    expect(payload).toMatchObject({
      success: true,
      target: "route",
      path: "/",
      defaultVisibility: "private",
      effectiveVisibility: "public",
      route: { path: "/", visibility: "public", effectiveVisibility: "public" },
      url: "https://demo.ravi.page/",
    });

    const human = await captureConsole(() =>
      command.visibility(["proj", "demo", "public"], undefined, "/", undefined, false, true),
    );
    expect(human.output).toContain("Visibility public");
    expect(human.output).toContain("Default    private (site)");
  });

  it("route visibility dry-run does not call Console", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return {};
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectContractError(
      () => command.visibility(["proj", "demo", "public"], undefined, "/", undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({
      site: "demo",
      scope: "route",
      route: "/",
      currentVisibility: "explicit route policy",
      targetVisibility: "public",
      siteDefaultVisibility: "unchanged",
    });
    expect(calls).toHaveLength(0);
  });

  it("reduces one route visibility immediately without --execute", async () => {
    const calls: Array<{ body: unknown; method: string; path: string }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return {
        site: { id: "site_1", slug: "demo", defaultHostname: "demo.ravi.page", defaultVisibility: "public" },
        route: { path: "/foo", visibility: "private", effectiveVisibility: "private" },
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.visibility(["proj", "demo", "private"], undefined, "foo", undefined, true),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/cli/projects/proj/pages/visibility",
        body: { siteRef: "demo", path: "/foo", visibility: "private" },
      },
    ]);
    expect(payload).toMatchObject({
      target: "route",
      path: "/foo",
      effectiveVisibility: "private",
      defaultVisibility: "public",
    });
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
      command.domains(["filipe-ai", "filipe-ai", "www.filipe.ai", "filipe.ai"], undefined, true, undefined, true, true),
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
    // The gateway checks the declared return schema; the resolved scope used to
    // be rejected as an unrecognized key, turning a completed publish into a 500.
    expect(payload.scope).toMatchObject({ project: { ref: "proj" } });
    const publishReturnSchema = getReturnsMetadata(PagesCommands).get("publish");
    expect(publishReturnSchema?.safeParse(payload).error?.issues).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Agent-first contract (Manual v2): write brake (exit 3), Console not-found
// mapping (SITE_NOT_FOUND / ROUTE_NOT_FOUND, exit 1) and compact --fields.
// The real context module is in play here, so braked calls run inside
// runWithContext to make the contract helpers throw instead of process.exit.
// ---------------------------------------------------------------------------

describe("pages agent-first contract", () => {
  it("create is dry-run by default and only writes the host with --execute", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return {
        id: "site_1",
        slug: "demo",
        defaultHostname: "demo.ravi.page",
        defaultVisibility: "private",
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectContractError(
      () => command.create(["proj", "demo"], undefined, "private", true, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      project: "proj",
      slug: "demo",
      visibility: "private",
      isDefault: true,
    });
    // The brake runs before any Console call.
    expect(calls).toEqual([]);

    const { output } = await captureConsole(() =>
      command.create(["proj", "demo"], undefined, "private", true, undefined, true, true),
    );
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/cli/projects/proj/pages",
        body: { slug: "demo", defaultVisibility: "private", isDefault: true },
      },
    ]);
    expect(payload).toMatchObject({ success: true, site: { slug: "demo" } });
  });

  it("domains without --execute dry-runs before credentials or Console", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    let credentialReads = 0;
    const client = makeClient(async (method, path) => {
      calls.push({ method, path });
      return {};
    });
    const command = new PagesCommands({
      client,
      readCredentials: () => {
        credentialReads += 1;
        return makeCredentials();
      },
    });

    const error = await expectContractError(
      () => command.domains(["proj", "demo", "docs.example.com"], undefined, true, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      project: "proj",
      site: "demo",
      hostnameCount: 1,
      readinessCheck: true,
      dnsSetup: [
        {
          hostname: "docs.example.com",
          dnsRecords: [{ type: "CNAME", name: "docs.example.com", value: "cname.ravi.page" }],
        },
      ],
    });
    expect(credentialReads).toBe(0);
    expect(calls).toEqual([]);
  });

  it("publish is dry-run by default and only uploads with --execute", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-publish-unbraked-test-");
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Docs</h1>");
    const calls: string[] = [];
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1" },
      })),
      createPageUploadSession: mock(async () => {
        calls.push("createPageUploadSession");
        return {
          uploadSession: { id: "upl_unbraked" },
          uploadPolicy: { directUpload: false },
        };
      }),
      finalizeArtifactPublish: mock(async () => {
        calls.push("finalizeArtifactPublish");
        return {
          artifact: { id: "cloud_art_unbraked" },
          site: { id: "site_1", slug: "demo", defaultHostname: "demo.ravi.page" },
          url: "https://demo.ravi.page/guide",
        };
      }),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const publish = (execute?: boolean) =>
      command.publish(
        ["proj", "demo", dir],
        undefined,
        "/guide",
        "public",
        "Docs",
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
        undefined,
        execute,
      );

    const error = await expectContractError(() => publish(), "WRITE_REQUIRES_EXECUTE", 3);

    expect(error.details.plan).toMatchObject({
      project: "proj",
      site: "demo",
      route: "/guide",
      visibility: "public",
      entrypoint: "index.html",
      artifactVersion: "latest",
      activate: true,
      replaceRelease: false,
    });
    // The brake runs before any Console call.
    expect(calls).toEqual([]);

    const { output } = await captureConsole(() => publish(true));

    expect(calls).toEqual(["createPageUploadSession", "finalizeArtifactPublish"]);
    expect(JSON.parse(output)).toMatchObject({
      success: true,
      url: "https://demo.ravi.page/guide",
    });
  });

  it("publish dry-run rejects a missing source or entrypoint before the brake", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-publish-dry-run-validation-test-");
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Docs</h1>");
    const client = {
      me: mock(async () => {
        throw new Error("dry-run validation must not call Console");
      }),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });
    const dryRun = (source: string, route: string | undefined, entrypoint: string | undefined) =>
      runWithContext({}, () =>
        command.publish(
          ["proj", "demo", source],
          undefined,
          route,
          undefined,
          undefined,
          undefined,
          undefined,
          entrypoint,
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

    const entrypointError = await dryRun(dir, "/guide", "missing.html").catch((error: unknown) => error);
    expect(entrypointError).toBeInstanceOf(CloudAuthError);
    expect((entrypointError as CloudAuthError).code).toBe("PAYLOAD_INVALID");
    expect((entrypointError as CloudAuthError).issues).toEqual([
      { path: ["entrypoint"], code: "invalid", message: "Package entrypoint is not included in files: missing.html" },
    ]);

    const sourceError = await dryRun(join(dir, "nope"), "/guide", undefined).catch((error: unknown) => error);
    expect(sourceError).toBeInstanceOf(CloudAuthError);
    expect((sourceError as CloudAuthError).code).toBe("PAYLOAD_INVALID");
    expect((sourceError as CloudAuthError).issues?.[0]?.path).toEqual(["source"]);

    // A valid source still brakes, and the plan shows the route the Console will use.
    const brake = await expectContractError(() => dryRun(dir, "guide", "index.html"), "WRITE_REQUIRES_EXECUTE", 3);
    expect(brake.details.plan).toMatchObject({ route: "/guide", entrypoint: "index.html" });
    expect(client.me).not.toHaveBeenCalled();
  });

  it("password set without --execute never prompts for the password nor calls Console", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeClient(async (method, path) => {
      calls.push({ method, path });
      return passwordResponse();
    });
    let prompted = false;
    const command = new PagesPasswordCommands({
      client,
      readCredentials: makeReadCredentials(),
      readPassword: async () => {
        prompted = true;
        return "never-used";
      },
    });

    const error = await expectContractError(
      () => command.set(["proj", "demo"], undefined, "/sentinel/private", false, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      project: "proj",
      site: "demo",
      routePresent: true,
      action: "set",
    });
    expect(JSON.stringify(error.details.plan)).not.toContain("/sentinel/private");
    expect(Object.keys(error.details.plan as Record<string, unknown>)).not.toContain("password");
    expect(prompted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("password remove keeps validation BEFORE the brake and exits 3 once the visibility is valid", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeClient(async (method, path) => {
      calls.push({ method, path });
      return passwordResponse();
    });
    const command = new PagesPasswordCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectContractError(
      () => command.remove(["proj", "demo"], undefined, "/sentinel/private", "private", undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toEqual({
      project: "proj",
      site: "demo",
      routePresent: true,
      replacementVisibility: "private",
    });
    expect(JSON.stringify(error.details.plan)).not.toContain("/sentinel/private");
    expect(calls).toHaveLength(0);
  });

  it("update to public without --execute exits 3; reducing visibility writes immediately", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeClient(async (method, path) => {
      calls.push({ method, path });
      return {
        site: { id: "site_1", slug: "demo", defaultHostname: "demo.ravi.page", defaultVisibility: "private" },
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    await expectContractError(
      () => command.update(["proj", "demo"], undefined, "public", undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(calls).toHaveLength(0);

    await captureConsole(() => command.update(["proj", "demo"], undefined, "private", undefined, true));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PATCH" });
  });

  it("visibility shortcut to public is braked too", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeClient(async (method, path) => {
      calls.push({ method, path });
      return { site: { id: "site_1", slug: "demo" } };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectContractError(
      () => command.visibility(["proj", "demo", "public"], undefined, undefined, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({
      site: "demo",
      scope: "site",
      defaultVisibility: "public",
      targetVisibility: "public",
    });
    expect(calls).toHaveLength(0);
  });

  it("maps a Console 'site not found' failure to the SITE_NOT_FOUND envelope (exit 1)", async () => {
    const privateProviderMessage =
      "Pages site not found: https://user:SENTINEL_PROVIDER_4Q7M@example.test/private?token=value";
    const client = makeClient(async () => {
      throw new CloudAuthError("PAYLOAD_INVALID", privateProviderMessage, { status: 404 });
    });
    const command = new PagesPasswordCommands({
      client,
      readCredentials: makeReadCredentials(),
      readPassword: async () => {
        throw new Error("unexpected password prompt");
      },
    });

    const error = await expectContractError(
      () => command.status(["proj", "ghost"], undefined, undefined, undefined, true),
      "SITE_NOT_FOUND",
      1,
    );

    expect(error.details.suggestedAction).toContain("ravi pages list");
    const serialized = JSON.stringify(error.envelope());
    expect(error.envelope().error.message).toBe("Pages site was not found.");
    expect(serialized).not.toContain("SENTINEL_PROVIDER_4Q7M");
    expect(serialized).not.toContain("user:");
    expect(serialized).not.toContain("/private");
  });

  it("maps a Console 'route not found' failure to the ROUTE_NOT_FOUND envelope (exit 1)", async () => {
    const client = makeClient(async () => {
      throw new CloudAuthError("PAYLOAD_INVALID", "Route not found: /missing", { status: 404 });
    });
    const command = new PagesPasswordCommands({
      client,
      readCredentials: makeReadCredentials(),
      readPassword: async () => {
        throw new Error("unexpected password prompt");
      },
    });

    const error = await expectContractError(
      () => command.status(["proj", "demo"], undefined, "/missing", undefined, true),
      "ROUTE_NOT_FOUND",
      1,
    );

    expect(error.details.suggestedAction).toContain("ravi pages published");
  });

  it("ship publishes without --execute and ignores a leftover --execute", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-brake-test-");
    const listAndCreate: Array<{ method: string; path: string; body: unknown }> = [];
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1" },
      })),
      requestJson: mock(async (method: string, path: string, body: unknown) => {
        listAndCreate.push({ method, path, body });
        if (method === "GET" && path === "/api/cli/projects/proj/pages") {
          return [
            {
              id: "site_1",
              slug: "acme-proj",
              isDefault: true,
              defaultHostname: "acme-proj.ravi.page",
              defaultVisibility: "private",
            },
          ];
        }
        if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_unbraked_ship" },
        uploadPolicy: { directUpload: false },
      })),
      finalizeArtifactPublish: mock(async () => ({
        artifact: { id: "cloud_art_unbraked_ship" },
        site: {
          id: "site_1",
          slug: "acme-proj",
          isDefault: true,
          defaultHostname: "acme-proj.ravi.page",
        },
        url: "https://acme-proj.ravi.page/",
      })),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const ship = (execute?: boolean) =>
      command.ship(
        [],
        "proj",
        "Weekly report",
        "<h1>OK</h1>",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        execute,
      );

    const withoutExecute = await captureConsole(() => ship());

    expect(listAndCreate).toEqual([
      { method: "GET", path: "/api/cli/projects/proj/pages", body: undefined },
      { method: "POST", path: KIT_PATH, body: kitRequest("acme-proj", "/", "<h1>OK</h1>") },
    ]);
    expect(JSON.parse(withoutExecute.output)).toMatchObject({
      artifactId: "cloud_art_unbraked_ship",
      slug: "acme-proj",
      success: true,
      url: "https://acme-proj.ravi.page/",
    });

    // Callers that still pass --execute keep working: the flag is ignored.
    const withExecute = await captureConsole(() => ship(true));

    expect(JSON.parse(withExecute.output)).toMatchObject({
      artifactId: "cloud_art_unbraked_ship",
      success: true,
      url: "https://acme-proj.ravi.page/",
    });
    expect(client.finalizeArtifactPublish).toHaveBeenCalledTimes(2);
  });

  it("ship with --execute wraps --body as HTML5, reuses an existing slug, and returns the JSON shape", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-command-test-");
    const listAndCreate: Array<{ method: string; path: string; body: unknown }> = [];
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1" },
      })),
      requestJson: mock(async (method: string, path: string, body: unknown) => {
        listAndCreate.push({ method, path, body });
        if (method === "GET" && path === "/api/cli/projects/proj/pages") {
          return [
            {
              id: "site_title",
              slug: "weekly-report",
              isDefault: false,
              defaultHostname: "weekly-report.ravi.page",
            },
            {
              id: "site_1",
              slug: "acme-proj",
              isDefault: true,
              defaultHostname: "acme-proj.ravi.page",
              defaultVisibility: "private",
            },
          ];
        }
        if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          projectRef: "proj",
          siteRef: "acme-proj",
          packageManifest: {
            entrypoint: "index.html",
            files: [{ path: "index.html" }],
          },
        });
        return {
          uploadSession: { id: "upl_ship" },
          uploadPolicy: { directUpload: false },
        };
      }),
      finalizeArtifactPublish: mock(async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          uploadSessionId: "upl_ship",
          artifact: { name: "Weekly report" },
          publish: {
            activate: true,
            siteRef: "acme-proj",
            visibility: "private",
            route: { path: "/", visibility: "private" },
          },
          source: { tool: "ravi pages ship" },
        });
        return {
          artifact: { id: "cloud_art_ship" },
          artifactVersion: { id: "cloud_ver_ship", versionNumber: 1 },
          site: {
            id: "site_1",
            slug: "acme-proj",
            isDefault: true,
            defaultHostname: "acme-proj.ravi.page",
            defaultVisibility: "private",
          },
          publish: { id: "pub_ship" },
          release: { id: "rel_ship", url: "https://acme-proj.ravi.page/" },
          routes: [{ id: "route_ship", path: "/" }],
          url: "https://acme-proj.ravi.page/",
        };
      }),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.ship(
        [],
        "proj",
        "Weekly report",
        "<h1>OK</h1>",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(listAndCreate).toEqual([
      { method: "GET", path: "/api/cli/projects/proj/pages", body: undefined },
      { method: "POST", path: KIT_PATH, body: kitRequest("acme-proj", "/", "<h1>OK</h1>") },
    ]);
    expect(payload).toEqual({
      artifactId: "cloud_art_ship",
      commentFollow: {
        filter: pageCommentFilter({ pageId: "site_1", routePath: "/", orgId: "org_1" }),
        ok: false,
        orgId: "org_1",
        pageId: "site_1",
        projectId: null,
        routePath: "/",
        session: "main",
        skipped: "missing_creator",
        topic: "ravi.watch.console.page.comment.created",
        warning: "Page comment trigger skipped: no creator agent in the current session.",
      },
      kit: { status: "applied", changedFiles: [], warnings: [], theme: null, widgets: [] },
      presentation: null,
      route: "/",
      site: {
        id: "site_1",
        slug: "acme-proj",
        isDefault: true,
        defaultHostname: "acme-proj.ravi.page",
        defaultVisibility: "private",
      },
      slug: "acme-proj",
      success: true,
      url: "https://acme-proj.ravi.page/",
      visibility: "private",
    });
    expect(listAndCreate.some((call) => call.method === "POST" && call.path === "/api/cli/projects/proj/pages")).toBe(
      false,
    );
  });

  it("ship --execute creates one page-comment trigger for the creator and reuses it", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-comment-follow-");
    dbCreateAgent({ id: "creator", cwd: "/tmp/page-creator-home" });
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1" },
      })),
      requestJson: mock(async (method: string, path: string, body?: unknown) => {
        if (method === "GET" && path === "/api/cli/projects/proj/pages") {
          return [{ id: "site_1", slug: "acme-proj", isDefault: true, defaultHostname: "acme-proj.ravi.page" }];
        }
        if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_follow" },
        uploadPolicy: { directUpload: false },
      })),
      finalizeArtifactPublish: mock(async () => ({
        artifact: { id: "cloud_art_follow", projectId: "proj_real" },
        site: { id: "site_1", slug: "acme-proj", isDefault: true, projectId: "proj_real" },
        url: "https://acme-proj.ravi.page/",
      })),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({
      client,
      readCredentials: makeReadCredentials(),
      pageCommentFollow: { emitTriggersRefresh: async () => {} },
    });
    const ship = () =>
      runWithContext({ agentId: "creator", sessionName: "creator-main" }, () =>
        command.ship(
          [],
          "proj",
          "Weekly report",
          "<h1>OK</h1>",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          undefined,
          true,
        ),
      );

    const first = await captureConsole(ship);
    const second = await captureConsole(ship);
    const firstPayload = JSON.parse(first.output);
    const secondPayload = JSON.parse(second.output);
    const triggers = dbListTriggers();

    expect(firstPayload.commentFollow).toMatchObject({
      ok: true,
      reused: false,
      agentId: "creator",
      pageId: "site_1",
      routePath: "/",
      orgId: "org_1",
      projectId: "proj_real",
      topic: "ravi.watch.console.page.comment.created",
      session: "main",
      replySession: "creator-main",
    });
    expect(secondPayload.commentFollow).toMatchObject({
      ok: true,
      reused: true,
      triggerId: firstPayload.commentFollow.triggerId,
      agentId: "creator",
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      name: "page-comment:site_1:/",
      agentId: "creator",
      topic: "ravi.watch.console.page.comment.created",
      replySession: "creator-main",
    });
    expect(triggers[0]?.filter).toBe(
      pageCommentFilter({ pageId: "site_1", routePath: "/", orgId: "org_1", projectId: "proj_real" }),
    );
  });

  it("ship with --execute creates the legacy host when an explicit slug is new", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-create-command-test-");
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Docs</h1>");
    const listAndCreate: Array<{ method: string; path: string; body: unknown }> = [];
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1" },
      })),
      requestJson: mock(async (method: string, path: string, body: unknown) => {
        listAndCreate.push({ method, path, body });
        if (method === "GET" && path === "/api/cli/projects/proj/pages") return [];
        if (method === "POST" && path === "/api/cli/projects/proj/pages") {
          return {
            id: "site_new",
            slug: "docs",
            defaultHostname: "docs.ravi.page",
            defaultVisibility: "private",
          };
        }
        if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_new" },
        uploadPolicy: { directUpload: false },
      })),
      finalizeArtifactPublish: mock(async () => ({
        artifact: { id: "cloud_art_new" },
        site: { id: "site_new", slug: "docs", defaultHostname: "docs.ravi.page" },
        url: "https://docs.ravi.page/",
      })),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.ship(
        ["proj", "docs"],
        undefined,
        "Documentation",
        undefined,
        undefined,
        dir,
        "private",
        "/",
        "index.html",
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );
    const payload = JSON.parse(output);

    expect(listAndCreate).toEqual([
      { method: "GET", path: "/api/cli/projects/proj/pages", body: undefined },
      {
        method: "POST",
        path: "/api/cli/projects/proj/pages",
        body: { slug: "docs", defaultVisibility: "private" },
      },
      { method: "POST", path: KIT_PATH, body: kitRequest("docs", "/", "<h1>Docs</h1>") },
    ]);
    expect(payload).toMatchObject({
      artifactId: "cloud_art_new",
      route: "/",
      slug: "docs",
      url: "https://docs.ravi.page/",
      visibility: "private",
    });
    expect(listAndCreate.some((call) => JSON.stringify(call.body ?? {}).includes("documentation"))).toBe(false);
  });

  it("ship without a slug publishes a route on the project default host and ignores the title slug", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-default-host-");
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1", slug: "acme" },
      })),
      requestJson: mock(async (method: string, path: string, body: unknown) => {
        calls.push({ method, path, body });
        if (method === "GET" && path === "/api/cli/projects/proj/pages") {
          return [
            { id: "site_title", slug: "nome-da-pagina", isDefault: false, routeCount: 1 },
            {
              id: "site_default",
              slug: "acme-proj",
              isDefault: true,
              defaultHostname: "acme-proj.ravi.page",
            },
          ];
        }
        if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({ projectRef: "proj", siteRef: "acme-proj" });
        return { uploadSession: { id: "upl_default" }, uploadPolicy: { directUpload: false } };
      }),
      finalizeArtifactPublish: mock(async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          publish: { siteRef: "acme-proj", route: { path: "/nome" } },
        });
        return {
          artifact: { id: "cloud_art_default" },
          site: { id: "site_default", slug: "acme-proj", isDefault: true },
          url: "https://acme-proj.ravi.page/nome",
        };
      }),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({
      client,
      readCredentials: () => ({ ...makeCredentials(), organization: { id: "org_1", slug: "acme", name: "Acme" } }),
    });

    const { output } = await captureConsole(() =>
      command.ship(
        [],
        "proj",
        "Nome da Página",
        "<h1>OK</h1>",
        undefined,
        undefined,
        undefined,
        "/nome",
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );

    expect(calls).toEqual([
      { method: "GET", path: "/api/cli/projects/proj/pages", body: undefined },
      { method: "POST", path: KIT_PATH, body: kitRequest("acme-proj", "/nome", "<h1>OK</h1>") },
    ]);
    expect(JSON.parse(output)).toMatchObject({
      route: "/nome",
      slug: "acme-proj",
      url: "https://acme-proj.ravi.page/nome",
    });
    expect(output).not.toContain("nome-da-pagina");
  });

  it("ship without a slug creates the project-owned default host instead of a title slug", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-create-default-");
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1", slug: "acme" },
      })),
      requestJson: mock(async (method: string, path: string, body: unknown) => {
        calls.push({ method, path, body });
        if (method === "GET" && path === "/api/cli/projects/proj/pages") return [];
        if (method === "POST" && path === "/api/cli/projects/proj/pages") {
          return {
            id: "site_owned",
            slug: "acme-proj",
            isDefault: true,
            defaultHostname: "acme-proj.ravi.page",
          };
        }
        if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({ siteRef: "acme-proj" });
        return { uploadSession: { id: "upl_owned" }, uploadPolicy: { directUpload: false } };
      }),
      finalizeArtifactPublish: mock(async () => ({
        artifact: { id: "cloud_art_owned" },
        site: { id: "site_owned", slug: "acme-proj", isDefault: true },
        url: "https://acme-proj.ravi.page/relatorio",
      })),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({
      client,
      readCredentials: () => ({ ...makeCredentials(), organization: { id: "org_1", slug: "acme", name: "Acme" } }),
    });

    const { output } = await captureConsole(() =>
      command.ship(
        [],
        "proj",
        "Relatório semanal",
        "<h1>OK</h1>",
        undefined,
        undefined,
        undefined,
        "/relatorio",
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );

    expect(calls).toEqual([
      { method: "GET", path: "/api/cli/projects/proj/pages", body: undefined },
      {
        method: "POST",
        path: "/api/cli/projects/proj/pages",
        body: { slug: "acme-proj", defaultVisibility: "private", isDefault: true },
      },
      { method: "POST", path: KIT_PATH, body: kitRequest("acme-proj", "/relatorio", "<h1>OK</h1>") },
    ]);
    expect(JSON.parse(output)).toMatchObject({ route: "/relatorio", slug: "acme-proj" });
    expect(JSON.stringify(calls)).not.toContain("relatorio-semanal");
  });

  it("ship without a slug does not create a host from the title when no default host can be resolved", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-no-default-");
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1" },
      })),
      requestJson: mock(async (method: string, path: string, body: unknown) => {
        calls.push({ method, path, body });
        if (method === "GET" && path === "/api/cli/projects/proj/pages") {
          return [{ id: "site_extra", slug: "weekly-report", isDefault: false, routeCount: 1 }];
        }
        if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async () => {
        throw new Error("upload should not start");
      }),
      finalizeArtifactPublish: mock(async () => {
        throw new Error("publish should not start");
      }),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectCloudError(() =>
      command.ship(
        [],
        "proj",
        "Weekly report",
        "<h1>OK</h1>",
        undefined,
        undefined,
        undefined,
        "/weekly",
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );

    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toContain("does not create");
    expect(calls).toEqual([{ method: "GET", path: "/api/cli/projects/proj/pages", body: undefined }]);
    expect(JSON.stringify(calls)).not.toContain("weekly-report");
  });

  it("rejects a reserved legacy host slug before creating it", async () => {
    const command = new PagesCommands({
      client: makeClient(async () => {
        throw new Error("console should not be called");
      }),
      readCredentials: makeReadCredentials(),
    });

    const error = await expectCloudError(() =>
      command.ship(
        ["ravi-custom"],
        "proj",
        "Reserved",
        "<h1>OK</h1>",
        undefined,
        undefined,
        undefined,
        "/",
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );

    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.message).toContain("reserved");
  });

  it("list --fields narrows each site to the requested fields", async () => {
    const client = makeClient(async () => [
      { id: "site_1", slug: "demo", defaultHostname: "demo.ravi.page", defaultVisibility: "public", status: "active" },
    ]);
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.list("proj", undefined, undefined, undefined, undefined, true, "slug,status"),
    );
    const payload = JSON.parse(output);

    expect(payload.sites).toEqual([{ slug: "demo", status: "active" }]);
    expect(payload.items).toEqual([{ slug: "demo", status: "active" }]);
  });

  it("lists assertion audiences and drops assertion tokens from the Console payload", async () => {
    const planted = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ2aWV3ZXIifQ.signature";
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return {
        assertion: planted,
        audiences: [
          { audience: "api.example", aud: "stale.example", origins: ["https://api.example"], token: planted },
          { aud: "legacy.example", origins: ["https://legacy.example"] },
          { aud: planted, origins: ["https://evil.example"] },
        ],
        jwksUrl: "https://console.example/.well-known/jwks.json",
        siteRef: "demo",
        token: planted,
      };
    });
    const command = new PagesAssertionAudienceCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.list("demo", "proj", undefined, undefined, undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([
      {
        accessToken: "access-secret",
        body: undefined,
        method: "GET",
        path: "/api/cli/projects/proj/pages/demo/viewer-assertion-audiences",
      },
    ]);
    expect(payload).toMatchObject({
      audiences: [
        { aud: "api.example", origins: ["https://api.example"] },
        { aud: "legacy.example", origins: ["https://legacy.example"] },
      ],
      jwksUrl: "https://console.example/api/public/pages/viewer-assertions/jwks",
      projectRef: "proj",
      siteRef: "demo",
      success: true,
      total: 2,
    });
    expect(output).not.toContain("stale.example");
    expect(output).not.toContain(planted);
    expect(output).not.toContain("access-secret");
  });

  it("puts a hostname siteRef on the Console viewer-assertion path", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeClient(async (method, path) => {
      calls.push({ method, path });
      return { audiences: [], siteRef: "site_1" };
    });
    const command = new PagesAssertionAudienceCommands({ client, readCredentials: makeReadCredentials() });

    await captureConsole(() => command.list("acme-proj.ravi.page", "proj", undefined, undefined, undefined, true));

    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/cli/projects/proj/pages/acme-proj.ravi.page/viewer-assertion-audiences",
      },
    ]);
  });

  it("documents that assertion audience --origin is a Pages host origin", () => {
    const commands = getCommandsMetadata(PagesAssertionAudienceCommands);
    const set = commands.find((command) => command.name === "set");
    expect(set?.description).toContain("this Pages site");
    expect(set?.helpAfter).toContain(
      "ravi pages assertion audiences set --site demo --aud https://api.example --origin https://demo.ravi.page --execute",
    );
    expect(set?.helpAfter).toContain("not the third-party API");
    expect(set?.helpAfter).not.toContain("--origin https://api.example");
    const origin = getOptionsMetadata(new PagesAssertionAudienceCommands(), "set").find((option) =>
      option.flags.startsWith("--origin"),
    );
    expect(origin?.description).toContain("this Pages site");
    expect(origin?.description).toContain("not the third-party API");
  });

  it("brakes assertion audience set before Console and replaces origins on execute", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return {
        audiences: [{ audience: "https://api.example", origins: ["https://demo.ravi.page", "https://docs.example"] }],
        siteRef: "demo",
      };
    });
    const command = new PagesAssertionAudienceCommands({ client, readCredentials: makeReadCredentials() });
    const set = (execute?: boolean) =>
      command.set(
        "demo",
        "https://api.example",
        ["https://demo.ravi.page", "https://docs.example"],
        "proj",
        undefined,
        true,
        execute,
      );

    const error = await expectContractError(() => set(), "WRITE_REQUIRES_EXECUTE", 3);
    expect(error.details.plan).toEqual({
      project: "proj",
      site: "demo",
      aud: "https://api.example",
      originCount: 2,
      origins: ["https://demo.ravi.page", "https://docs.example"],
    });
    expect(calls).toEqual([]);

    const { output } = await captureConsole(() => set(true));
    expect(calls).toEqual([
      {
        method: "PUT",
        path: "/api/cli/projects/proj/pages/demo/viewer-assertion-audiences",
        body: {
          aud: "https://api.example",
          origins: ["https://demo.ravi.page", "https://docs.example"],
        },
      },
    ]);
    expect(JSON.parse(output)).toMatchObject({
      action: "set",
      aud: "https://api.example",
      audiences: [{ aud: "https://api.example", origins: ["https://demo.ravi.page", "https://docs.example"] }],
      jwksUrl: "https://console.example/api/public/pages/viewer-assertions/jwks",
      origins: ["https://demo.ravi.page", "https://docs.example"],
      success: true,
    });
  });

  it("forwards a Console 400 when --origin is not this Pages site hostname", async () => {
    const client = makeClient(async () => {
      throw new CloudAuthError("PAYLOAD_INVALID", "hostname must be this site's default or active custom hostname", {
        status: 400,
      });
    });
    const command = new PagesAssertionAudienceCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectContractError(
      () => command.set("demo", "https://api.example", ["https://api.example"], "proj", undefined, true, true),
      "PAYLOAD_INVALID",
      2,
    );

    expect(error.message).toContain("https origin of this Pages site");
    expect(error.message).toContain("hostname must be this site's default or active custom hostname");
    expect(error.details.suggestedAction).toContain("https://<site>.ravi.page");
    expect(error.details.status).toBe(400);
  });

  it("hides a provider dump on assertion audience set 400 and still states the Pages-host rule", async () => {
    const secret = "SENTINEL_PROVIDER_4Q7M";
    const client = makeClient(async () => {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        `hostname must be this site's default or active custom hostname https://user:${secret}@evil.test/private?token=value`,
        { status: 400 },
      );
    });
    const command = new PagesAssertionAudienceCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectContractError(
      () => command.set("demo", "https://api.example", ["https://api.example"], "proj", undefined, true, true),
      "PAYLOAD_INVALID",
      2,
    );

    expect(error.message).toContain("https origin of this Pages site");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.envelope())).not.toContain(secret);
    expect(JSON.stringify(error.envelope())).not.toContain("user:");
  });

  it("rejects assertion audience set without an https origin before the brake", async () => {
    const command = new PagesAssertionAudienceCommands({
      client: makeClient(async () => {
        throw new Error("console should not be called");
      }),
      readCredentials: makeReadCredentials(),
    });

    const missingOrigin = await expectCloudError(() =>
      runWithContext({}, () => command.set("demo", "api.example", undefined, "proj", undefined, true)),
    );
    expect(missingOrigin.code).toBe("PAYLOAD_INVALID");

    const httpOrigin = await expectCloudError(() =>
      runWithContext({}, () => command.set("demo", "api.example", ["http://api.example"], "proj", undefined, true)),
    );
    expect(httpOrigin.code).toBe("PAYLOAD_INVALID");
    expect(httpOrigin.message).toContain("https");

    const tooManyOrigins = await expectCloudError(() =>
      runWithContext({}, () =>
        command.set(
          "demo",
          "api.example",
          Array.from({ length: 9 }, (_, index) => `https://origin-${index}.example`),
          "proj",
          undefined,
          true,
        ),
      ),
    );
    expect(tooManyOrigins.code).toBe("PAYLOAD_INVALID");
    expect(tooManyOrigins.message).toContain("8");
  });

  it("brakes assertion audience remove and deletes one aud on execute", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return { audiences: [], siteRef: "demo" };
    });
    const command = new PagesAssertionAudienceCommands({ client, readCredentials: makeReadCredentials() });

    const missingAud = await expectCloudError(() =>
      runWithContext({}, () => command.remove("demo", undefined, "proj", undefined, true)),
    );
    expect(missingAud.code).toBe("PAYLOAD_INVALID");
    expect(calls).toEqual([]);

    const error = await expectContractError(
      () => command.remove("demo", "api.example", "proj", undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(error.details.plan).toEqual({
      project: "proj",
      site: "demo",
      aud: "api.example",
    });
    expect(calls).toEqual([]);

    await captureConsole(() => command.remove("demo", "api.example", "proj", undefined, true, true));
    expect(calls).toEqual([
      {
        method: "DELETE",
        path: "/api/cli/projects/proj/pages/demo/viewer-assertion-audiences",
        body: { aud: "api.example" },
      },
    ]);
  });

  it("ships with uses including ravi.identity.assertion and does not embed a JWT", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-uses-");
    const planted = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzaGlwIn0.signature";
    let finalizeBody: Record<string, unknown> | undefined;
    const client = {
      me: mock(async () => ({
        user: { email: "alice@example.com" },
        organization: { id: "org_1" },
      })),
      requestJson: mock(async (method: string, path: string, body?: unknown) => {
        if (method === "GET" && path === "/api/cli/projects/proj/pages") {
          return [
            {
              id: "site_1",
              slug: "acme-proj",
              isDefault: true,
              defaultHostname: "acme-proj.ravi.page",
            },
          ];
        }
        if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_uses" },
        uploadPolicy: { directUpload: false },
      })),
      finalizeArtifactPublish: mock(async (input: Record<string, unknown>) => {
        finalizeBody = input;
        return {
          artifact: { id: "cloud_art_uses" },
          site: { id: "site_1", slug: "acme-proj", defaultHostname: "acme-proj.ravi.page" },
          url: "https://acme-proj.ravi.page/app",
        };
      }),
    } as unknown as ConsoleApiClient;
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const rejected = await expectCloudError(() =>
      command.ship(
        [],
        "proj",
        "App",
        "<h1>OK</h1>",
        undefined,
        undefined,
        undefined,
        "/app",
        undefined,
        ["ravi.identity.assertion", planted],
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );
    expect(rejected.code).toBe("PAYLOAD_INVALID");
    expect(finalizeBody).toBeUndefined();

    const { output } = await captureConsole(() =>
      command.ship(
        [],
        "proj",
        "App",
        "<h1>OK</h1>",
        undefined,
        undefined,
        undefined,
        "/app",
        undefined,
        ["ravi.identity.assertion"],
        undefined,
        true,
        undefined,
        undefined,
        true,
      ),
    );

    expect(finalizeBody).toMatchObject({
      publish: { uses: ["ravi.identity.assertion"] },
    });
    expect(JSON.parse(output)).toMatchObject({
      route: "/app",
      uses: ["ravi.identity.assertion"],
    });
    expect(JSON.stringify(finalizeBody)).not.toContain(planted);
    expect(output).not.toContain(planted);
    expect(output).not.toContain("access-secret");
  });

  it("ship refuses ravi.bases.* uses on a public route before any Console call (exit 2)", async () => {
    const client = makeClient(async () => {
      throw new Error("console should not be called");
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });
    const shipPublicBases = (asJson: boolean) =>
      command.ship(
        [],
        "loja",
        "Estoque",
        "<h1>OK</h1>",
        undefined,
        undefined,
        "public",
        "/estoque",
        undefined,
        ["ravi.bases.views.describe,ravi.bases.views.query"],
        undefined,
        asJson,
      );

    let caught: unknown;
    const json = await captureConsole(async () => {
      try {
        await runWithContext({}, () => shipPublicBases(true));
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(ContractError);
    expect((caught as ContractError).code).toBe("LIVE_DATA_PUBLIC_ROUTE");
    expect((caught as ContractError).exitCode).toBe(2);
    const envelope = JSON.parse(json.output);
    expect(envelope).toMatchObject({
      success: false,
      op: "pages ship",
      error: {
        code: "LIVE_DATA_PUBLIC_ROUTE",
        message: SHIP_LIVE_DATA_REFUSAL_LINES[0],
        retryable: false,
        basesUses: ["ravi.bases.views.describe", "ravi.bases.views.query"],
        visibility: "public",
        override: "--members-best-effort",
      },
    });
    expect(envelope.error.issues.map((issue: { message: string }) => issue.message)).toEqual([
      ...SHIP_LIVE_DATA_REFUSAL_LINES,
    ]);
    expect(envelope.error.suggestedAction).toContain("Drop --visibility");

    // Text mode prints the headline, then the members fix, outsiders fix and override.
    const text = await captureConsoleError(async () => {
      await expect(runWithContext({}, () => shipPublicBases(false))).rejects.toBeInstanceOf(ContractError);
    });
    expect(text.split("\n")).toEqual([...SHIP_LIVE_DATA_REFUSAL_LINES]);
    expect(client.me).not.toHaveBeenCalled();
    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("ship --members-best-effort publishes ravi.bases.* on a public route with a members-only warning", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-best-effort-");
    const { client, finalizeBodies } = makeShipClient();
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });
    const ship = (asJson: boolean) =>
      command.ship(
        [],
        "proj",
        "Estoque",
        "<h1>OK</h1>",
        undefined,
        undefined,
        "public",
        "/estoque",
        undefined,
        ["ravi.bases.views.query"],
        undefined,
        asJson,
        true,
        undefined,
      );

    const { output } = await captureConsole(() => ship(true));

    expect(finalizeBodies[0]).toMatchObject({
      publish: { visibility: "public", uses: ["ravi.bases.views.query"] },
    });
    expect(JSON.parse(output)).toMatchObject({
      success: true,
      visibility: "public",
      uses: ["ravi.bases.views.query"],
      warnings: [SHIP_LIVE_DATA_OVERRIDE_WARNING],
    });

    const text = await captureConsole(() => ship(false));
    expect(text.output).toContain(`warning: ${SHIP_LIVE_DATA_OVERRIDE_WARNING}`);
    expect(SHIP_LIVE_DATA_OVERRIDE_WARNING).toContain("Only org members already signed in get live data");
  });

  it("ship keeps public routes without ravi.bases.* and private routes with ravi.bases.* unchanged", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-live-data-ok-");
    const { client, finalizeBodies } = makeShipClient();
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });
    const ship = (visibility: string | undefined, uses: string[]) =>
      captureConsole(() =>
        command.ship(
          [],
          "proj",
          "Estoque",
          "<h1>OK</h1>",
          undefined,
          undefined,
          visibility,
          "/estoque",
          undefined,
          uses,
          undefined,
          true,
        ),
      );

    const publicAssertion = JSON.parse((await ship("public", ["ravi.identity.assertion"])).output);
    const privateBases = JSON.parse((await ship(undefined, ["ravi.bases.views.query"])).output);
    const protectedBases = JSON.parse((await ship("protected_link", ["ravi.bases.views.query"])).output);

    expect(publicAssertion).toMatchObject({ success: true, visibility: "public" });
    expect(privateBases).toMatchObject({ success: true, visibility: "private", uses: ["ravi.bases.views.query"] });
    expect(protectedBases).toMatchObject({ success: true, visibility: "protected_link" });
    for (const payload of [publicAssertion, privateBases, protectedBases]) {
      expect(payload).not.toHaveProperty("warnings");
    }
    expect(finalizeBodies.map((body) => (body.publish as { visibility: string }).visibility)).toEqual([
      "public",
      "private",
      "protected_link",
    ]);
  });
});

describe("pages ship page kit", () => {
  type KitBody = {
    project: string;
    site: string;
    route: string;
    visibility: string;
    theme: string | null;
    files: Array<{ path: string; html: string }>;
  };

  const PRESENTATION = {
    v: 1,
    runtime: { version: "1.0.0", sha256: "a".repeat(64) },
    theme: { itemId: "theme_1", ref: "org/acme", version: 3, hash: "b".repeat(64) },
    widgets: [{ itemId: "widget_1", ref: "org/pedido-card", version: 2 }],
  };
  const THEME_WARNING = "Theme changed since the last publish of /pedidos: org/acme v2 -> v3.";

  function makeKitClient(kit: (body: KitBody) => unknown) {
    const kitBodies: KitBody[] = [];
    const manifests: Array<{ files: Array<{ path: string; sha256: string }> }> = [];
    const finalizeBodies: Array<Record<string, unknown>> = [];
    const client = {
      me: mock(async () => ({ user: { email: "alice@example.com" }, organization: { id: "org_1" } })),
      requestJson: mock(async (method: string, path: string, body?: unknown) => {
        if (method === "GET" && path === "/api/cli/projects/proj/pages") {
          return [{ id: "site_1", slug: "acme-proj", isDefault: true, defaultHostname: "acme-proj.ravi.page" }];
        }
        if (method === "POST" && path === KIT_PATH) {
          kitBodies.push(structuredClone(body) as KitBody);
          return kit(body as KitBody);
        }
        throw new Error(`unexpected ${method} ${path}`);
      }),
      createPageUploadSession: mock(async (input: Record<string, unknown>) => {
        manifests.push(input.packageManifest as (typeof manifests)[number]);
        return { uploadSession: { id: `upl_kit_${manifests.length}` }, uploadPolicy: { directUpload: false } };
      }),
      finalizeArtifactPublish: mock(async (input: Record<string, unknown>) => {
        finalizeBodies.push(input);
        return {
          artifact: { id: `cloud_art_kit_${finalizeBodies.length}` },
          site: { id: "site_1", slug: "acme-proj", defaultHostname: "acme-proj.ravi.page" },
          url: "https://acme-proj.ravi.page/pedidos",
        };
      }),
    } as unknown as ConsoleApiClient;
    return { client, kitBodies, manifests, finalizeBodies };
  }

  function shipKit(
    command: PagesCommands,
    options: {
      asJson?: boolean;
      body?: string;
      dir?: string;
      membersBestEffort?: boolean;
      theme?: string;
      uses?: string[];
      visibility?: string;
    },
  ) {
    return command.ship(
      [],
      "proj",
      "Pedidos",
      options.dir ? undefined : (options.body ?? '<ravi-view view="v1"></ravi-view>'),
      undefined,
      options.dir,
      options.visibility,
      "/pedidos",
      undefined,
      options.uses,
      undefined,
      options.asJson ?? true,
      options.membersBestEffort,
      options.theme,
    );
  }

  /** Inject a theme block into files with a ravi-view tag, like the Console kit does. */
  function kitThemed(body: KitBody) {
    return {
      files: body.files.map((file) =>
        file.html.includes("<ravi-view")
          ? { path: file.path, html: themed(file.html), changed: true }
          : { ...file, changed: false },
      ),
      uses: ["ravi.bases.views.describe", "ravi.bases.views.query"],
      presentation: PRESENTATION,
      diagnostics: [],
      warnings: [THEME_WARNING],
    };
  }

  function themed(html: string): string {
    return html.replace("<head>", '<head><style id="ravi-theme" data-ravi-theme="h">:root{}</style>');
  }

  function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  it("ships --dir from a private copy, writes kit changes there and never touches the caller's folder", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-dir-");
    const dir = await tempDir();
    const index =
      '<!doctype html><html><head><meta charset="utf-8"></head><body><ravi-view view="v1"></ravi-view></body></html>';
    await writeFile(join(dir, "index.html"), index);
    await writeFile(join(dir, "about.htm"), "<head></head><p>Sobre</p>");
    await writeFile(join(dir, "style.css"), "body{}");
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "docs", "page.html"), "<head></head><p>Docs</p>");
    const { client, kitBodies, manifests, finalizeBodies } = makeKitClient(kitThemed);
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const first = JSON.parse((await captureConsole(() => shipKit(command, { dir }))).output);
    await captureConsole(() => shipKit(command, { dir }));

    expect(kitBodies[0]).toMatchObject({
      project: "proj",
      site: "acme-proj",
      route: "/pedidos",
      visibility: "private",
      theme: null,
    });
    expect(kitBodies[0]?.files.map((file) => file.path)).toEqual(["about.htm", "docs/page.html", "index.html"]);
    // The caller's folder keeps its bytes, so the second ship sends the same source.
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(index);
    expect(kitBodies[1]?.files.find((file) => file.path === "index.html")?.html).toBe(index);
    for (const manifest of manifests) {
      expect(manifest.files.find((file) => file.path === "index.html")?.sha256).toBe(sha256(themed(index)));
      expect(manifest.files.map((file) => file.path)).toContain("style.css");
    }
    expect(finalizeBodies[0]).toMatchObject({
      publish: { presentation: PRESENTATION, uses: ["ravi.bases.views.describe", "ravi.bases.views.query"] },
    });
    expect(first).toMatchObject({
      kit: {
        status: "applied",
        changedFiles: ["index.html"],
        warnings: [THEME_WARNING],
        theme: PRESENTATION.theme,
        widgets: PRESENTATION.widgets,
      },
      presentation: PRESENTATION,
      uses: ["ravi.bases.views.describe", "ravi.bases.views.query"],
      warnings: [THEME_WARNING],
    });
    expect(getReturnsMetadata(PagesCommands).get("ship")?.safeParse(first).success).toBe(true);
  });

  it("sends --theme none or a ref, and refuses an empty --theme before any Console call", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-theme-");
    const { client, kitBodies } = makeKitClient(kitUnchanged);
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    await captureConsole(() => shipKit(command, { theme: "none" }));
    await captureConsole(() => shipKit(command, { theme: "org/acme" }));
    expect(kitBodies.map((body) => body.theme)).toEqual(["none", "org/acme"]);

    const meCalls = (client.me as ReturnType<typeof mock>).mock.calls.length;
    const error = await expectCloudError(() => shipKit(command, { theme: "  " }));
    expect(error.code).toBe("PAYLOAD_INVALID");
    expect((client.me as ReturnType<typeof mock>).mock.calls.length).toBe(meCalls);
  });

  it("merges kit uses into --uses and re-runs the public live-data refusal before upload", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-uses-");
    const { client, finalizeBodies } = makeKitClient(kitThemed);
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const merged = JSON.parse(
      (await captureConsole(() => shipKit(command, { uses: ["ravi.identity.assertion,ravi.bases.views.query"] })))
        .output,
    );
    expect(merged.uses).toEqual(["ravi.identity.assertion", "ravi.bases.views.query", "ravi.bases.views.describe"]);
    expect(finalizeBodies[0]).toMatchObject({ publish: { uses: merged.uses } });

    // No ravi.bases.* in --uses: the first check passes, the tags add them, and
    // the merged check refuses the public route before any upload.
    const refused = await expectContractError(
      () => shipKit(command, { visibility: "public" }),
      "LIVE_DATA_PUBLIC_ROUTE",
      2,
    );
    expect(refused.details.basesUses).toEqual(["ravi.bases.views.describe", "ravi.bases.views.query"]);
    expect(client.createPageUploadSession).toHaveBeenCalledTimes(1);

    const overridden = JSON.parse(
      (await captureConsole(() => shipKit(command, { visibility: "public", membersBestEffort: true }))).output,
    );
    expect(overridden.warnings).toEqual([SHIP_LIVE_DATA_OVERRIDE_WARNING, THEME_WARNING]);
    expect(finalizeBodies[1]).toMatchObject({ publish: { visibility: "public" } });
  });

  it("exits 2 with KIT_INVALID and one path:line:column line per diagnostic, uploading nothing", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-invalid-");
    const diagnostics = [
      {
        severity: "error",
        code: "WIDGET_FIELD_MISSING",
        message: "Widget field valor has no matching column (candidates: total: number).",
        path: "index.html",
        line: 12,
        column: 5,
      },
      {
        severity: "warning",
        code: "KIT_UNKNOWN_ATTRIBUTE",
        message: "Unknown attribute foo.",
        path: "index.html",
        line: 3,
      },
    ];
    const { client } = makeKitClient(() => {
      throw new CloudAuthError("PAYLOAD_INVALID", "Page kit found errors.", { status: 422, details: { diagnostics } });
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });
    const lines = [
      "index.html:12:5 error WIDGET_FIELD_MISSING Widget field valor has no matching column (candidates: total: number).",
      "index.html:3 warning KIT_UNKNOWN_ATTRIBUTE Unknown attribute foo.",
    ];

    const error = await expectContractError(() => shipKit(command, {}), "KIT_INVALID", 2);
    expect(error.envelope().error.issues).toEqual(
      lines.map((message, index) => ({
        path: [],
        code: diagnostics[index]?.code,
        message,
      })),
    );

    const text = await captureConsoleError(async () => {
      await expect(runWithContext({}, () => shipKit(command, { asJson: false }))).rejects.toBeInstanceOf(ContractError);
    });
    expect(text.split("\n")).toEqual([
      "Refusing to ship: the page kit found 1 error(s) in the HTML. Nothing was uploaded or published.",
      ...lines,
    ]);
    expect(client.createPageUploadSession).not.toHaveBeenCalled();
  });

  it("exits 2 with KIT_WIDGET_UNAUDITED and the Console audit URL in suggestedAction, uploading nothing", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-unaudited-");
    const url = "https://console.example/library/widgets/org/grafico/versions/2";
    const diagnostics = [
      {
        severity: "error",
        code: "KIT_WIDGET_UNAUDITED",
        message: "Widget org/grafico@2 has code and no passing accessibility audit.",
        path: "index.html",
        line: 3,
        column: 1,
        url,
        widget: "org/grafico@2",
      },
    ];
    const { client } = makeKitClient(() => {
      throw new CloudAuthError("PAYLOAD_INVALID", "Page kit found errors.", { status: 422, details: { diagnostics } });
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });
    const line = `index.html:3:1 error KIT_WIDGET_UNAUDITED Widget org/grafico@2 has code and no passing accessibility audit. ${url}`;

    const error = await expectContractError(() => shipKit(command, {}), "KIT_WIDGET_UNAUDITED", 2);
    const envelope = error.envelope().error;
    expect(envelope.message).toBe(
      "Refusing to ship: org/grafico@2 has no passing accessibility audit yet. Nothing was uploaded or published.",
    );
    expect(envelope.suggestedAction).toBe(
      `An org owner or admin must open ${url} in the Console and run the accessibility audit until it passes, then ship again`,
    );
    expect(envelope.issues).toEqual([{ path: [], code: "KIT_WIDGET_UNAUDITED", message: line }]);
    expect(error.details.widgets).toEqual(["org/grafico@2"]);

    const text = await captureConsoleError(async () => {
      await expect(runWithContext({}, () => shipKit(command, { asJson: false }))).rejects.toBeInstanceOf(ContractError);
    });
    expect(text).toContain(url);
    expect(client.createPageUploadSession).not.toHaveBeenCalled();

    // Mixed with another kit error, the ship stays KIT_INVALID and the line keeps the URL.
    const { client: mixed } = makeKitClient(() => {
      throw new CloudAuthError("PAYLOAD_INVALID", "Page kit found errors.", {
        status: 422,
        details: {
          diagnostics: [
            ...diagnostics,
            { severity: "error", code: "WIDGET_UNKNOWN", message: "Widget org/x does not exist.", path: "index.html" },
          ],
        },
      });
    });
    const mixedError = await expectContractError(
      () => shipKit(new PagesCommands({ client: mixed, readCredentials: makeReadCredentials() }), {}),
      "KIT_INVALID",
      2,
    );
    expect(mixedError.envelope().error.issues).toContainEqual({
      path: [],
      code: "KIT_WIDGET_UNAUDITED",
      message: line,
    });
  });

  it("exits 2 with the Console's KIT_TOO_LARGE diagnostic and its message, uploading nothing", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-too-large-");
    const diagnostics = [
      { severity: "error", code: "KIT_TOO_LARGE", message: "The page kit output is larger than 4 MiB.", path: null },
    ];
    const { client } = makeKitClient(() => {
      throw new CloudAuthError("PAYLOAD_INVALID", "Page kit found errors.", { status: 422, details: { diagnostics } });
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });
    const line = "- error KIT_TOO_LARGE The page kit output is larger than 4 MiB.";

    const error = await expectContractError(() => shipKit(command, {}), "KIT_INVALID", 2);
    expect(error.envelope().error.issues).toEqual([{ path: [], code: "KIT_TOO_LARGE", message: line }]);
    const text = await captureConsoleError(async () => {
      await expect(runWithContext({}, () => shipKit(command, { asJson: false }))).rejects.toBeInstanceOf(ContractError);
    });
    expect(text.split("\n")).toEqual([
      "Refusing to ship: the page kit found 1 error(s) in the HTML. Nothing was uploaded or published.",
      line,
    ]);
    expect(client.createPageUploadSession).not.toHaveBeenCalled();
  });

  it("sends --body without lang and uploads the kit's lang, else the pt-BR fallback", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-lang-");
    const body = '<ravi-view view="v1"></ravi-view>';
    const wrapped = wrapHtml5Document("Pedidos", body);
    // The kit sets lang from the theme locale (here an `en` theme) when the page has none.
    const themedEn = (html: string) => themed(html).replace("<html>", '<html lang="en">');
    const { client, kitBodies, manifests } = makeKitClient((kitBody) => ({
      ...kitThemed(kitBody),
      files: kitBody.files.map((file) => ({ path: file.path, html: themedEn(file.html), changed: true })),
    }));
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });
    await captureConsole(() => shipKit(command, { body }));
    expect(kitBodies[0]?.files[0]?.html).toBe(wrapped);
    expect(manifests[0]?.files.find((file) => file.path === "index.html")?.sha256).toBe(sha256(themedEn(wrapped)));

    // No theme and no tags: the kit leaves the file as sent, and ship adds pt-BR.
    const plain = makeKitClient(kitUnchanged);
    const plainCommand = new PagesCommands({ client: plain.client, readCredentials: makeReadCredentials() });
    await captureConsole(() => shipKit(plainCommand, { body: "<p>Em construção</p>", theme: "none" }));
    const plainWrapped = wrapHtml5Document("Pedidos", "<p>Em construção</p>");
    expect(plain.kitBodies[0]?.files[0]?.html).toBe(plainWrapped);
    expect(plain.manifests[0]?.files.find((file) => file.path === "index.html")?.sha256).toBe(
      sha256(plainWrapped.replace("<html>", '<html lang="pt-BR">')),
    );

    // An older Console without the kit: the same fallback.
    const older = makeKitClient(() => {
      throw new CloudAuthError("PAYLOAD_INVALID", "<!DOCTYPE html><h1>404</h1>", { status: 404 });
    });
    const olderCommand = new PagesCommands({ client: older.client, readCredentials: makeReadCredentials() });
    await captureConsole(() => shipKit(olderCommand, { body }));
    expect(older.manifests[0]?.files.find((file) => file.path === "index.html")?.sha256).toBe(
      sha256(wrapped.replace("<html>", '<html lang="pt-BR">')),
    );
  });

  it("ships the HTML unchanged with KIT_UNAVAILABLE when the Console has no kit route", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-unavailable-");
    const { client, finalizeBodies } = makeKitClient(() => {
      throw new CloudAuthError("PAYLOAD_INVALID", "<!DOCTYPE html><h1>404</h1>", { status: 404 });
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const payload = JSON.parse((await captureConsole(() => shipKit(command, { theme: "org/acme" }))).output);
    expect(payload).toMatchObject({
      success: true,
      presentation: null,
      kit: { status: "unavailable", changedFiles: [], theme: null, widgets: [] },
    });
    expect(payload.kit.warnings).toHaveLength(1);
    expect(payload.kit.warnings[0]).toStartWith("KIT_UNAVAILABLE:");
    expect(payload.warnings).toEqual(payload.kit.warnings);
    expect(payload).not.toHaveProperty("uses");
    expect(finalizeBodies[0]?.publish).not.toHaveProperty("presentation");

    const text = await captureConsole(() => shipKit(command, { asJson: false }));
    expect(text.output).toContain("warning: KIT_UNAVAILABLE:");
  });

  it("fails like other Console errors when the kit call cannot reach the Console", async () => {
    stateDir = await createIsolatedRaviState("ravi-pages-ship-kit-network-");
    const { client } = makeKitClient(() => {
      throw new CloudAuthError("SERVER_UNAVAILABLE", "Console is unavailable. Try again later.");
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const error = await expectCloudError(() => captureConsole(() => shipKit(command, {})));
    expect(error.code).toBe("SERVER_UNAVAILABLE");
    expect(client.createPageUploadSession).not.toHaveBeenCalled();
  });

  it("declares --theme before the trailing --execute", () => {
    const flags = getOptionsMetadata(new PagesCommands(), "ship")
      .sort((left, right) => left.index - right.index)
      .map((option) => option.flags);
    expect(flags.slice(-2)).toEqual(["--theme <ref|none>", "--execute"]);
    const help = getCommandsMetadata(PagesCommands).find((command) => command.name === "ship")?.helpAfter;
    expect(help).toContain("--theme none");
    expect(help).toContain("ravi pages outdated");
  });
});

describe("pages outdated", () => {
  it("lists routes behind on theme, widgets or runtime as JSON and as a table", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeClient(async (method, path) => {
      calls.push({ method, path });
      return {
        items: [
          {
            siteSlug: "acme-proj",
            hostname: "acme-proj.ravi.page",
            route: "/pedidos",
            releaseId: "rel_1",
            publishedAt: "2026-10-15T12:00:00.000Z",
            theme: { pinned: { ref: "org/acme", version: 2 }, current: { ref: "org/acme", version: 3 } },
            widgets: [{ ref: "org/pedido-card", pinned: 1, current: 2 }],
            runtime: { pinned: "1.0.0", current: "1.0.0" },
          },
          {
            siteSlug: "acme-proj",
            hostname: "acme-proj.ravi.page",
            route: "/",
            releaseId: "rel_2",
            publishedAt: null,
            theme: null,
            widgets: [],
            runtime: { pinned: "1.0.0", current: "1.1.0" },
          },
        ],
      };
    });
    const command = new PagesCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.outdated("proj", undefined, true));
    const payload = JSON.parse(output);

    expect(calls).toEqual([{ method: "GET", path: "/api/cli/pages/outdated?project=proj" }]);
    expect(payload).toMatchObject({ success: true, projectRef: "proj", total: 2 });
    expect(payload.items[0]).toMatchObject({ route: "/pedidos", widgets: [{ ref: "org/pedido-card", pinned: 1 }] });
    expect(getReturnsMetadata(PagesCommands).get("outdated")?.safeParse(payload).success).toBe(true);

    const text = await captureConsole(() => command.outdated("proj", undefined, false));
    expect(text.output).toContain("theme org/acme v2→v3; widget org/pedido-card v1→v2");
    expect(text.output).toContain("runtime 1.0.0→1.1.0");
    expect(text.output).toMatch(/HOST\s+ROUTE\s+BEHIND/);
    expect(text.output).toContain("acme-proj.ravi.page  /pedidos");
  });

  it("says nothing is outdated when every route is current", async () => {
    const command = new PagesCommands({
      client: makeClient(async () => ({ items: [] })),
      readCredentials: makeReadCredentials(),
    });
    const { output } = await captureConsole(() => command.outdated("proj", undefined, false));
    expect(output).toBe("Nothing is outdated in project proj.");
  });
});

describe("pages chat", () => {
  function chatResponse(overrides: Record<string, unknown> = {}) {
    return {
      success: true,
      projectRef: "proj",
      siteRef: "acme-website",
      siteId: "site_1",
      host: "acme-website.ravi.page",
      featureEnabled: true,
      settings: { enabled: true, assistantName: "Lia", voice: "tempo", language: "pt-BR", instructions: null },
      voices: ["bossa", "tempo"],
      ...overrides,
    };
  }

  it("shows the settings of a site addressed by hostname", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return chatResponse();
    });
    const command = new PagesChatCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.show("acme-website.ravi.page", "proj", undefined, true));

    expect(calls).toEqual([
      { method: "GET", path: "/api/cli/projects/proj/pages/acme-website.ravi.page/chat", body: undefined },
    ]);
    expect(JSON.parse(output)).toMatchObject({
      featureEnabled: true,
      host: "acme-website.ravi.page",
      projectRef: "proj",
      settings: { enabled: true, assistantName: "Lia", voice: "tempo", language: "pt-BR", instructions: null },
      siteId: "site_1",
      siteRef: "acme-website",
      success: true,
      voices: ["bossa", "tempo"],
    });
    expect(output).not.toContain("access-secret");
  });

  it("warns in text output when the org feature is off", async () => {
    const client = makeClient(async () => chatResponse({ featureEnabled: false }));
    const command = new PagesChatCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() => command.show("acme-website", "proj"));

    expect(output).toContain("Status       off");
    expect(output).toContain("console.pages.chat is off");
  });

  it("applies non-enabling changes immediately with only the set fields", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return chatResponse({ settings: { enabled: false, assistantName: null, voice: "tempo", language: "en-US" } });
    });
    const command = new PagesChatCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      command.set(
        "acme-website",
        "proj",
        "false",
        "tempo",
        undefined,
        true,
        "en-us",
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

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/cli/projects/proj/pages/acme-website/chat",
        body: { enabled: false, assistantName: null, voice: "tempo", language: "en-US" },
      },
    ]);
    expect(JSON.parse(output)).toMatchObject({
      changed: ["enabled", "assistantName", "voice", "language"],
      settings: { enabled: false, voice: "tempo", language: "en-US" },
      success: true,
    });
  });

  it("brakes --enabled true before Console and enables on --execute", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return chatResponse();
    });
    const command = new PagesChatCommands({ client, readCredentials: makeReadCredentials() });
    const instructions = "Responda em uma frase.";
    const set = (execute?: boolean) =>
      command.set(
        "acme-website",
        "proj",
        "true",
        undefined,
        undefined,
        undefined,
        undefined,
        instructions,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        execute,
      );

    const error = await expectContractError(() => set(), "WRITE_REQUIRES_EXECUTE", 3);
    expect(error.details.plan).toMatchObject({
      project: "proj",
      site: "acme-website",
      changes: { enabled: true, instructionsLength: instructions.length },
    });
    expect(JSON.stringify(error.envelope())).not.toContain(instructions);
    expect(calls).toEqual([]);

    const { output } = await captureConsole(() => set(true));
    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/cli/projects/proj/pages/acme-website/chat",
        body: { enabled: true, instructions },
      },
    ]);
    expect(JSON.parse(output)).toMatchObject({ changed: ["enabled", "instructions"], success: true });
  });

  it("rejects invalid input with exit 2 before the brake and before Console", async () => {
    const client = makeClient(async () => {
      throw new Error("console should not be called");
    });
    const command = new PagesChatCommands({ client, readCredentials: makeReadCredentials() });
    const run = (...args: Parameters<PagesChatCommands["set"]>) =>
      expectCloudError(() => runWithContext({}, () => command.set(...args)));

    const badVoice = await run("demo", "proj", "true", "alloy");
    expect(badVoice.code).toBe("PAYLOAD_INVALID");
    expect(badVoice.message).toContain("--voice");

    const badEnabled = await run("demo", "proj", "on");
    expect(badEnabled.message).toContain("--enabled");

    const nothing = await run("demo", "proj");
    expect(nothing.message).toContain("Missing a setting to change");

    const conflict = await run("demo", "proj", undefined, undefined, "Lia", true);
    expect(conflict.message).toContain("Conflicting flags");

    const longName = await run("demo", "proj", undefined, undefined, "x".repeat(61));
    expect(longName.message).toContain("60");

    const missingSite = await run("  ", "proj", undefined, "tempo");
    expect(missingSite.message).toContain("Missing <site>");

    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("maps a Console project denial and a missing site", async () => {
    const denied = new PagesChatCommands({
      client: makeClient(async () => {
        throw new CloudAuthError("PROJECT_ACCESS_DENIED", "Project access denied.", { status: 403 });
      }),
      readCredentials: makeReadCredentials(),
    });
    const deniedError = await expectCloudError(() => denied.show("demo", "proj", undefined, true));
    expect(deniedError.code).toBe("PROJECT_ACCESS_DENIED");

    const missing = new PagesChatCommands({
      client: makeClient(async () => {
        throw new CloudAuthError("PAYLOAD_INVALID", "Pages site not found.", { status: 404 });
      }),
      readCredentials: makeReadCredentials(),
    });
    await expectContractError(() => missing.show("ghost", "proj", undefined, true), "SITE_NOT_FOUND", 1);
  });

  type ChatSetFlags = {
    enabled?: string;
    instructions?: string;
    text?: string;
    replyPolicy?: string;
    textModel?: string;
    clearTextModel?: boolean;
    raviAgent?: string;
    clearRaviAgent?: boolean;
    execute?: boolean;
  };
  const RAVI_AGENT = "11111111-1111-4111-8111-111111111111/finance";

  /** `pages chat set <site> --project proj ... --json` with named flags. */
  function setChat(command: PagesChatCommands, flags: ChatSetFlags) {
    return command.set(
      "acme-website",
      "proj",
      flags.enabled,
      undefined,
      undefined,
      undefined,
      undefined,
      flags.instructions,
      undefined,
      flags.text,
      flags.replyPolicy,
      flags.textModel,
      flags.clearTextModel,
      flags.raviAgent,
      flags.clearRaviAgent,
      undefined,
      true,
      flags.execute,
    );
  }

  it("shows the text chat settings, with defaults for a Console that does not send them", async () => {
    const withText = new PagesChatCommands({
      client: makeClient(async () =>
        chatResponse({
          settings: {
            enabled: false,
            assistantName: "Lia",
            voice: "tempo",
            language: "pt-BR",
            instructions: null,
            text: true,
            replyPolicy: "always",
            textModel: "acme/chat-large-2.1",
            raviAgent: { installationId: "11111111-1111-4111-8111-111111111111", agentId: "finance" },
          },
        }),
      ),
      readCredentials: makeReadCredentials(),
    });
    const { output } = await captureConsole(() => withText.show("acme-website", "proj"));
    expect(output).toContain("Status       on");
    expect(output).toContain("Voice chat   disabled");
    expect(output).toContain("Text chat    enabled");
    expect(output).toContain("Replies      always");
    expect(output).toContain("Text model   acme/chat-large-2.1");
    expect(output).toContain(`Ravi agent   ${RAVI_AGENT}`);

    const older = new PagesChatCommands({
      client: makeClient(async () => chatResponse()),
      readCredentials: makeReadCredentials(),
    });
    const json = await captureConsole(() => older.show("acme-website", "proj", undefined, true));
    expect(JSON.parse(json.output).settings).toMatchObject({
      text: true,
      replyPolicy: "mention",
      textModel: null,
      raviAgent: null,
    });
    const text = await captureConsole(() => older.show("acme-website", "proj"));
    expect(text.output).toContain("Replies      mention");
    expect(text.output).toContain("Text model   (platform default)");
    expect(text.output).toContain("Ravi agent   (none)");
  });

  it("applies text chat changes that do not widen the agent at once", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return chatResponse();
    });
    const command = new PagesChatCommands({ client, readCredentials: makeReadCredentials() });

    const { output } = await captureConsole(() =>
      setChat(command, {
        text: "false",
        replyPolicy: "mention",
        textModel: "Acme/chat-large-2.1",
        clearRaviAgent: true,
      }),
    );
    await captureConsole(() => setChat(command, { clearTextModel: true }));

    expect(calls.map((call) => call.body)).toEqual([
      { text: false, replyPolicy: "mention", textModel: "acme/chat-large-2.1", raviAgent: null },
      { textModel: null },
    ]);
    expect(JSON.parse(output)).toMatchObject({ changed: ["text", "replyPolicy", "textModel", "raviAgent"] });
  });

  it("brakes --text true, --reply-policy always and --ravi-agent before Console", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return chatResponse();
    });
    const command = new PagesChatCommands({ client, readCredentials: makeReadCredentials() });

    const text = await expectContractError(() => setChat(command, { text: "true" }), "WRITE_REQUIRES_EXECUTE", 3);
    expect(text.details.plan).toMatchObject({ changes: { textChat: true } });
    expect(String((text.details.plan as { effect?: unknown }).effect)).toContain("text chat");

    const always = await expectContractError(
      () => setChat(command, { replyPolicy: "always", text: "false" }),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(always.details.plan).toMatchObject({ changes: { replyPolicy: "always", textChat: false } });

    const agent = await expectContractError(
      () => setChat(command, { raviAgent: RAVI_AGENT }),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(agent.details.plan).toMatchObject({ changes: { raviAgent: RAVI_AGENT } });
    expect(String((agent.details.plan as { effect?: unknown }).effect)).toContain(RAVI_AGENT);
    expect(calls).toEqual([]);

    await captureConsole(() =>
      setChat(command, { text: "true", replyPolicy: "always", raviAgent: RAVI_AGENT, execute: true }),
    );
    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/cli/projects/proj/pages/acme-website/chat",
        body: {
          text: true,
          replyPolicy: "always",
          raviAgent: { installationId: "11111111-1111-4111-8111-111111111111", agentId: "finance" },
        },
      },
    ]);
  });

  it("rejects invalid text chat flags with exit 2 before the brake", async () => {
    const client = makeClient(async () => {
      throw new Error("console should not be called");
    });
    const command = new PagesChatCommands({ client, readCredentials: makeReadCredentials() });
    const run = (flags: ChatSetFlags) => expectCloudError(() => runWithContext({}, () => setChat(command, flags)));

    expect((await run({ text: "yes" })).message).toContain("--text must be true or false");
    expect((await run({ replyPolicy: "sometimes" })).message).toContain("--reply-policy");
    expect((await run({ textModel: "chat large" })).message).toContain("--text-model");
    expect((await run({ raviAgent: "macbook-ana/finance" })).message).toContain("--ravi-agent");
    expect((await run({ textModel: "a/b", clearTextModel: true })).message).toContain("Conflicting flags");
    expect((await run({ raviAgent: RAVI_AGENT, clearRaviAgent: true })).message).toContain("Conflicting flags");
    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("declares a conditional brake with --execute last", () => {
    const commands = getCommandsMetadata(PagesChatCommands);
    const set = commands.find((command) => command.name === "set");
    expect(set?.helpAfter).toContain("ravi pages chat set acme-website --enabled true --execute");
    expect(set?.helpAfter).toContain("--enabled false");
    const options = getOptionsMetadata(new PagesChatCommands(), "set");
    const last = options.reduce((max, option) => (option.index > max.index ? option : max));
    expect(last.flags).toBe("--execute");
    expect(getOptionsMetadata(new PagesChatCommands(), "show").map((option) => option.flags)).not.toContain(
      "--execute",
    );
  });
});

const KIT_PATH = "/api/cli/pages/kit";

/** The page kit request ship sends for a one-file page (project proj, private, no --theme). */
function kitRequest(site: string, route: string, html: string) {
  return {
    project: "proj",
    site,
    route,
    visibility: "private",
    theme: null,
    files: [{ path: "index.html", html: expect.stringContaining(html) }],
  };
}

/** A Console page kit that changes nothing: files back as sent, no uses, no presentation. */
function kitUnchanged(body: unknown) {
  const files = ((body as { files?: Array<{ path: string; html: string }> } | undefined)?.files ?? []).map((file) => ({
    ...file,
    changed: false,
  }));
  return { files, uses: [], presentation: null, diagnostics: [], warnings: [] };
}

function makeShipClient(): { client: ConsoleApiClient; finalizeBodies: Array<Record<string, unknown>> } {
  const finalizeBodies: Array<Record<string, unknown>> = [];
  const client = {
    me: mock(async () => ({
      user: { email: "alice@example.com" },
      organization: { id: "org_1" },
    })),
    requestJson: mock(async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path === "/api/cli/projects/proj/pages") {
        return [{ id: "site_1", slug: "acme-proj", isDefault: true, defaultHostname: "acme-proj.ravi.page" }];
      }
      if (method === "POST" && path === KIT_PATH) return kitUnchanged(body);
      throw new Error(`unexpected ${method} ${path}`);
    }),
    createPageUploadSession: mock(async () => ({
      uploadSession: { id: `upl_live_data_${finalizeBodies.length}` },
      uploadPolicy: { directUpload: false },
    })),
    finalizeArtifactPublish: mock(async (input: Record<string, unknown>) => {
      finalizeBodies.push(input);
      return {
        artifact: { id: `cloud_art_live_data_${finalizeBodies.length}` },
        site: { id: "site_1", slug: "acme-proj", defaultHostname: "acme-proj.ravi.page" },
        url: "https://acme-proj.ravi.page/estoque",
      };
    }),
  } as unknown as ConsoleApiClient;
  return { client, finalizeBodies };
}

async function captureConsoleError(run: () => Promise<void>): Promise<string> {
  const originalError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
    return lines.join("\n");
  } finally {
    console.error = originalError;
  }
}

async function expectCloudError(run: () => Promise<unknown>): Promise<CloudAuthError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CloudAuthError);
    return error as CloudAuthError;
  }
  throw new Error("expected CloudAuthError");
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractError> {
  let caught: unknown;
  await captureConsole(async () => {
    try {
      await runWithContext({}, run);
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractError;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

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
