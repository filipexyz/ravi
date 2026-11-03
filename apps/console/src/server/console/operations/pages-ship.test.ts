import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import type { BasesCaller } from "@/server/console/bases/context";
import type { PageKitResult } from "@/server/console/pages/kit/build";

import { runPagesShip, withHtmlLang, wrapHtml5Document, type PagesShipDeps } from "./pages-ship";
import type { OperationActor } from "./types";

const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SITE = { id: "site-1", slug: "acme-prs", defaultHostname: "acme-prs.ravi.page", defaultVisibility: "private" };

function actor(overrides: Partial<OperationActor> = {}): OperationActor {
  return {
    kind: "member",
    organizationId: "org",
    userId: "user-1",
    email: "ana@acme.test",
    orgRole: "developer",
    surface: "mcp",
    requestId: "req",
    site: null,
    pagesSessionId: null,
    ...overrides,
  };
}

function kitResult(overrides: Partial<PageKitResult> = {}): PageKitResult {
  return {
    files: [{ path: "index.html", changed: false }],
    uses: [],
    presentation: null as unknown as PageKitResult["presentation"],
    diagnostics: [],
    warnings: [],
    ...overrides,
  };
}

type Recorded = {
  kitBodies: unknown[];
  uploads: Array<{ url: string; body: string }>;
  sessions: unknown[];
  finalizes: Array<Record<string, unknown>>;
  createdSites: unknown[];
};

function makeDeps(overrides: Partial<PagesShipDeps> = {}): { deps: PagesShipDeps; recorded: Recorded } {
  const recorded: Recorded = { kitBodies: [], uploads: [], sessions: [], finalizes: [], createdSites: [] };
  const deps: PagesShipDeps = {
    basesCaller: () => ({}) as BasesCaller,
    findProject: (async () => ({ id: PROJECT, slug: "prs", status: "active" })) as unknown as PagesShipDeps["findProject"],
    findDefaultSite: async () => SITE,
    createDefaultSite: async (input) => {
      recorded.createdSites.push(input);
      return SITE;
    },
    runKit: async (input) => {
      recorded.kitBodies.push(input.body);
      return kitResult();
    },
    findUploadSessionId: async () => null,
    createUploadSession: (async (input: unknown) => {
      recorded.sessions.push(input);
      return {
        uploadSession: { id: "upload-1" },
        uploadPolicy: { files: [{ method: "PUT", url: "https://r2.test/put", headers: { "content-type": "text/html" } }] },
      };
    }) as unknown as PagesShipDeps["createUploadSession"],
    finalize: (async (input: { input: Record<string, unknown> }) => {
      recorded.finalizes.push(input.input);
      const publish = input.input.publish as { route: { path: string; visibility: string } };
      return {
        artifact: { id: "artifact-1" },
        release: { id: "release-1" },
        routes: [{ path: publish.route.path, visibility: publish.route.visibility }],
        url: `https://${SITE.defaultHostname}${publish.route.path}`,
      };
    }) as unknown as PagesShipDeps["finalize"],
    storage: {} as PagesShipDeps["storage"],
    fetch: (async (url: string, init: { body: Buffer }) => {
      recorded.uploads.push({ url, body: init.body.toString("utf8") });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
    ...overrides,
  };
  return { deps, recorded };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConsoleApiError);
    return error as ConsoleApiError;
  }
  throw new Error("expected a rejection");
}

describe("ravi.pages.ship", () => {
  test("publishes a body as a private route on the default host, as the person", async () => {
    const { deps, recorded } = makeDeps();
    const output = await runPagesShip(actor(), { project: "prs", title: "Teste <MCP>", body: "<h1>Oi</h1>", route: "/teste" }, "tok_1", deps);

    expect(output).toMatchObject({
      url: "https://acme-prs.ravi.page/teste",
      route: "/teste",
      visibility: "private",
      host: "acme-prs.ravi.page",
      artifactId: "artifact-1",
      releaseId: "release-1",
      createdHost: false,
    });
    expect(recorded.kitBodies[0]).toMatchObject({ project: PROJECT, site: "acme-prs", route: "/teste", visibility: "private", theme: null });
    expect(recorded.uploads).toHaveLength(1);
    expect(recorded.uploads[0]!.body).toContain('<html lang="pt-BR">');
    expect(recorded.uploads[0]!.body).toContain("<title>Teste &lt;MCP&gt;</title>");
    expect(recorded.uploads[0]!.body).toContain("<h1>Oi</h1>");

    const session = recorded.sessions[0] as { context: Record<string, unknown>; input: Record<string, unknown> };
    expect(session.context).toEqual({ actorId: "user-1", actorType: "user", membershipRole: "developer", organizationId: "org" });
    expect(session.input).toMatchObject({ projectRef: PROJECT, siteRef: SITE.id });
    expect(String(session.input.idempotencyKey)).toStartWith("mcp-ship:");
    expect(recorded.finalizes[0]).toMatchObject({
      uploadSessionId: "upload-1",
      idempotencyKey: session.input.idempotencyKey,
      artifact: { name: "Teste <MCP>" },
      publish: { siteRef: SITE.id, activate: true, replaceRelease: false, visibility: "private", route: { path: "/teste", visibility: "private" } },
    });
  });

  test("a full document keeps its own language and the kit's rewrite is what gets uploaded", async () => {
    const { deps, recorded } = makeDeps({
      runKit: async () => kitResult({ files: [{ path: "index.html", html: "<html lang=\"en\"><body>kit</body></html>", changed: true }] }),
    });
    await runPagesShip(actor(), { project: "prs", title: "Doc", html: "<html><body>x</body></html>" }, "tok_1", deps);
    expect(recorded.uploads[0]!.body).toBe('<html lang="en"><body>kit</body></html>');
  });

  test("creates the project's default host when it has none", async () => {
    const { deps, recorded } = makeDeps({ findDefaultSite: async () => null });
    const output = await runPagesShip(actor(), { project: "prs", title: "T", body: "x", visibility: "public" }, "tok_1", deps);
    expect(output.createdHost).toBe(true);
    expect(recorded.createdSites[0]).toMatchObject({ project: { id: PROJECT, slug: "prs" }, visibility: "public" });
  });

  test("a replayed confirmation returns the first publish instead of uploading again", async () => {
    const { deps, recorded } = makeDeps({ findUploadSessionId: async () => ({ id: "upload-0", status: "finalized" }) });
    const output = await runPagesShip(actor(), { project: "prs", title: "T", body: "x" }, "tok_1", deps);
    expect(output.artifactId).toBe("artifact-1");
    expect(recorded.sessions).toHaveLength(0);
    expect(recorded.uploads).toHaveLength(0);
    expect(recorded.finalizes[0]).toMatchObject({ uploadSessionId: "upload-0" });
  });

  test("refuses people who cannot publish, and projects they cannot write", async () => {
    const { deps } = makeDeps();
    expect((await rejection(runPagesShip(actor({ orgRole: "member" }), { project: "prs", title: "T", body: "x" }, "t", deps))).payload).toMatchObject({
      error: "operation_forbidden",
    });
    const noProject = makeDeps({ findProject: (async () => null) as unknown as PagesShipDeps["findProject"] });
    expect((await rejection(runPagesShip(actor(), { project: "prs", title: "T", body: "x" }, "t", noProject.deps))).payload).toMatchObject({
      error: "operation_forbidden",
    });
    expect(noProject.recorded.sessions).toHaveLength(0);
  });

  test("a cloud run stays in its own project", async () => {
    const { deps, recorded } = makeDeps();
    const error = await rejection(runPagesShip(actor({ boundProjectId: "other-project" }), { project: "prs", title: "T", body: "x" }, "t", deps));
    expect(error.payload).toMatchObject({ error: "operation_forbidden" });
    expect(recorded.sessions).toHaveLength(0);
  });

  test("refuses live Bases data on a public route before any upload", async () => {
    const { deps, recorded } = makeDeps({ runKit: async () => kitResult({ uses: ["ravi.bases.views.query"] }) });
    const error = await rejection(runPagesShip(actor(), { project: "prs", title: "T", body: "<ravi-view>", visibility: "public" }, "t", deps));
    expect(error.payload).toMatchObject({ error: "payload_invalid", fieldErrors: { visibility: expect.stringContaining("ravi.bases.views.query") } });
    expect(recorded.sessions).toHaveLength(0);
  });

  test("kit errors and bad input are payload_invalid", async () => {
    const kitBroken = makeDeps({
      runKit: async () => kitResult({ diagnostics: [{ severity: "error", code: "view_not_found", message: "View x is not available." }] }),
    });
    const error = await rejection(runPagesShip(actor(), { project: "prs", title: "T", body: "x" }, "t", kitBroken.deps));
    expect(error.payload).toMatchObject({ error: "payload_invalid", fieldErrors: { body: "View x is not available." } });

    const { deps } = makeDeps();
    await expect(runPagesShip(actor(), { project: "prs", title: "T", body: "x", html: "<html></html>" }, "t", deps)).rejects.toThrow();
    const route = await rejection(runPagesShip(actor(), { project: "prs", title: "T", body: "x", route: "/a?b" }, "t", deps));
    expect(route.payload).toMatchObject({ error: "payload_invalid", fieldErrors: { route: expect.any(String) } });
  });

  test("publish errors become codes the MCP Worker turns into tool errors", async () => {
    const unread = makeDeps({
      finalize: (async () => {
        throw new ConsoleApiError(409, { error: "publish_unread_comments", fieldErrors: { comments: "Read 2 unread Page comments before publishing." } });
      }) as unknown as PagesShipDeps["finalize"],
    });
    const error = await rejection(runPagesShip(actor(), { project: "prs", title: "T", body: "x" }, "t", unread.deps));
    expect(error.status).toBe(400);
    expect(error.payload).toMatchObject({ error: "payload_invalid", fieldErrors: { route: expect.stringContaining("Read 2 unread") } });

    const storage = makeDeps({ fetch: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch });
    const storageError = await rejection(runPagesShip(actor(), { project: "prs", title: "T", body: "x" }, "t", storage.deps));
    expect(storageError.payload).toEqual({ error: "operation_unavailable" });
  });
});

describe("ship HTML helpers", () => {
  test("wraps a body and sets lang only when the html tag has none", () => {
    const doc = wrapHtml5Document("A & B", "  <p>x</p>  ");
    expect(doc).toContain("<title>A &amp; B</title>");
    expect(doc).toContain("<body>\n<p>x</p>\n</body>");
    expect(withHtmlLang(doc, "pt-BR")).toContain('<html lang="pt-BR">');
    expect(withHtmlLang('<html lang="en">', "pt-BR")).toBe('<html lang="en">');
  });
});
