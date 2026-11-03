import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";

import {
  describeOperationChange,
  listOperationDefinitions,
  listOperationsForActor,
  operationAllowedForBoundProject,
  PAGES_READ_OPERATION_ID,
  PAGES_SHIP_OPERATION_ID,
  runOperation,
  type OperationDeps,
} from "./registry";
import { OPERATION_HANDLERS } from "./handlers";
import type { OperationActor } from "./types";

const VIEW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const site = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  organizationId: "org",
  projectId: PROJECT,
  defaultHostname: "acme-site.ravi.page",
  defaultVisibility: "private" as const,
  activeReleaseId: null,
};

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

function deps(overrides: OperationDeps = {}): OperationDeps & { audits: string[] } {
  const audits: string[] = [];
  return {
    audits,
    isRateLimited: () => false,
    insertAudit: async (row) => {
      audits.push(`${row.action}:${String(row.metadataJson.outcome ?? "")}`);
    },
    findProject: (async () => ({ id: PROJECT })) as unknown as OperationDeps["findProject"],
    basesFeatureEnabled: async () => true,
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConsoleApiError);
    return (error as ConsoleApiError).payload.error;
  }
  throw new Error("expected a rejection");
}

describe("Console operation registry", () => {
  test("offers no visibility, invite or delete operation; the only publish is ship on MCP and the only archive a row archive", () => {
    const ids = listOperationDefinitions().map((definition) => definition.id);
    expect(ids).toContain(PAGES_READ_OPERATION_ID);
    const ship = listOperationDefinitions().find((definition) => definition.id === PAGES_SHIP_OPERATION_ID)!;
    expect(ship).toMatchObject({ class: "write", needsConfirmation: true, surfaces: ["mcp"], guests: false });
    expect(ship.inputSchema("mcp").required).toEqual(["project", "title"]);
    expect(listOperationsForActor({ kind: "member", surface: "page_chat", site }).some((definition) => definition.id === PAGES_SHIP_OPERATION_ID)).toBe(false);
    for (const id of ids) expect(id).not.toMatch(/\.publish$|visibility|invite|delete/);
    expect(ids.filter((id) => id.includes("archive"))).toEqual(["ravi.bases.views.rows.archive"]);
    expect(listOperationDefinitions().every((definition) => definition.class !== "destructive")).toBe(true);
  });

  test("row archive is a confirmed, project-scoped write without an idempotency key", async () => {
    const archive = listOperationDefinitions().find((definition) => definition.id === "ravi.bases.views.rows.archive")!;
    expect(archive).toMatchObject({ class: "write", needsConfirmation: true, surfaces: ["page_chat", "mcp"], guests: false });
    expect(archive.inputSchema("mcp").required).toEqual(expect.arrayContaining(["project", "viewId", "rowId", "expectedVersion"]));
    const calls: unknown[] = [];
    const d = deps({
      bases: {
        archiveRow: (async (_caller: unknown, input: unknown) => {
          calls.push(input);
          return { row: { rowId: "row-1", version: 3, values: {} }, users: {}, idempotentReplay: false };
        }) as never,
      },
    });
    const input = { project: PROJECT, viewId: VIEW, rowId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", expectedVersion: 2 };
    expect(await rejection(runOperation({ id: "ravi.bases.views.rows.archive", actor: actor(), input }, d))).toBe("operation_confirmation_required");
    expect(calls).toEqual([]);
    const done = await runOperation({ id: "ravi.bases.views.rows.archive", actor: actor(), input, confirmed: true }, d);
    expect(done.output).toEqual({ rowId: "row-1", version: 3 });
    expect(calls).toEqual([{ projectId: PROJECT, viewId: VIEW, rowId: input.rowId, expectedVersion: 2 }]);
  });

  test("guests get only guest operations, and a Page's uses narrow the list", () => {
    const guest = listOperationsForActor({ kind: "guest", surface: "page_chat", site }).map((definition) => definition.id);
    expect(guest).toEqual(["ravi.knowledge.search"]);
    const narrowed = listOperationsForActor({ kind: "member", surface: "page_chat", site }, new Set([PAGES_READ_OPERATION_ID]));
    expect(narrowed.map((definition) => definition.id)).toEqual([PAGES_READ_OPERATION_ID]);
    expect(listOperationsForActor({ kind: "member", surface: "mcp", site: null }).some((definition) => definition.id === "ravi.knowledge.search")).toBe(false);
  });

  test("project-scoped operations ask MCP clients for a project and hide the idempotency key", () => {
    const create = listOperationDefinitions().find((definition) => definition.id === "ravi.bases.views.rows.create")!;
    const mcp = create.inputSchema("mcp");
    expect(mcp.required).toContain("project");
    expect(mcp.properties?.idempotencyKey).toBeUndefined();
    expect(create.inputSchema("page_chat").required ?? []).not.toContain("project");
  });

  test("Pages lists require projectRef on MCP, where no site supplies the project", () => {
    for (const id of ["ravi.pages.sites.list", "ravi.pages.published.list"]) {
      const definition = listOperationDefinitions().find((candidate) => candidate.id === id)!;
      expect(definition.inputSchema("mcp").required).toContain("projectRef");
      expect(definition.inputSchema("page_chat").required ?? []).not.toContain("projectRef");
    }
  });

  test("a write never runs unconfirmed, and unknown or guest-closed operations are refused", async () => {
    const d = deps();
    const input = { project: PROJECT, viewId: VIEW, values: { nome: "Ana" } };
    expect(await rejection(runOperation({ id: "ravi.bases.views.rows.create", actor: actor(), input }, d))).toBe("operation_confirmation_required");
    expect(await rejection(runOperation({ id: "ravi.pages.publish", actor: actor(), input: {} }, d))).toBe("operation_not_found");
    expect(await rejection(runOperation({ id: "ravi.projects.list", actor: actor({ kind: "guest", orgRole: null }), input: {} }, d))).toBe("operation_forbidden");
    expect(d.audits.every((line) => line.startsWith("operations.run.denied"))).toBe(true);
  });

  test("a confirmed write runs as the person with a key derived from the seed", async () => {
    const keys: string[] = [];
    const d = deps({
      bases: {
        createRow: (async (_caller: unknown, input: { idempotencyKey: string }) => {
          keys.push(input.idempotencyKey);
          return { row: { rowId: "row-1", version: 1 } };
        }) as never,
      },
    });
    const input = { project: PROJECT, viewId: VIEW, values: { nome: "Ana" } };
    const first = await runOperation({ id: "ravi.bases.views.rows.create", actor: actor(), input, confirmed: true, idempotencySeed: "call-1" }, d);
    await runOperation({ id: "ravi.bases.views.rows.create", actor: actor(), input, confirmed: true, idempotencySeed: "call-1" }, d);
    await runOperation({ id: "ravi.bases.views.rows.create", actor: actor(), input, confirmed: true, idempotencySeed: "call-2" }, d);
    expect(first.output).toMatchObject({ rowId: "row-1" });
    expect(keys[0]).toMatch(/^op:[0-9a-f]{40}$/);
    expect(keys[1]).toBe(keys[0]!);
    expect(keys[2]).not.toBe(keys[0]!);
  });

  test("pages.read in a Page chat reads this site when no URL is given", async () => {
    const urls: string[] = [];
    const d = deps({
      readPage: (async ({ input }: { input: { url: string } }) => {
        urls.push(input.url);
        return { page: { url: input.url, title: "Relatório", path: "/relatorio" }, content: { text: "oi", nextCursor: null, truncated: false }, routes: [] };
      }) as never,
    });
    const result = await runOperation({ id: PAGES_READ_OPERATION_ID, actor: actor({ surface: "page_chat", site, pagesSessionId: "s" }), input: { path: "/relatorio" } }, d);
    expect(urls).toEqual(["https://acme-site.ravi.page/relatorio"]);
    expect(result.output).toMatchObject({ contentTrust: "untrusted", text: "oi" });
  });

  test("a project-bound actor (cloud run token) never reaches another project", async () => {
    const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const bound = actor({ boundProjectId: PROJECT });
    const described: string[] = [];
    const d = deps({
      listProjects: (async () => [
        { id: PROJECT, slug: "mine", name: "Mine" },
        { id: OTHER, slug: "other", name: "Other" },
      ]) as never,
      findProject: (async (_workspace: unknown, ref: string) => ({ id: ref === "other" ? OTHER : PROJECT })) as never,
      bases: {
        describeView: (async (_caller: unknown, input: { projectId: string }) => {
          described.push(input.projectId);
          throw new ConsoleApiError(404, { error: "stub_view" });
        }) as never,
      },
      readPage: (async ({ input }: { input: { url: string } }) => ({
        page: { url: input.url, title: "T", path: "/", projectId: input.url.includes("other") ? OTHER : PROJECT },
        content: { text: "secret", nextCursor: null, truncated: false },
        routes: [],
      })) as never,
    });

    // Every catalog-era operation an MCP run token is offered is checked; handler modules test their own projects.
    const handlerIds = new Set(OPERATION_HANDLERS.map((handler) => handler.definition.id));
    for (const definition of listOperationsForActor({ kind: "member", surface: "mcp", site: null })) {
      if (handlerIds.has(definition.id)) continue;
      expect(["ravi.projects.list", "ravi.pages.sites.list", "ravi.pages.published.list", "ravi.pages.theme.get", PAGES_READ_OPERATION_ID]
        .concat(["ravi.cloud_agents.runs.start", "ravi.cloud_agents.runs.get", PAGES_SHIP_OPERATION_ID])
        .some((id) => id === definition.id) || definition.id.startsWith("ravi.bases.")).toBe(true);
    }

    const listed = await runOperation({ id: "ravi.projects.list", actor: bound, input: {} }, d);
    expect(JSON.stringify(listed.output)).toContain(PROJECT);
    expect(JSON.stringify(listed.output)).not.toContain(OTHER);
    expect(await rejection(runOperation({ id: "ravi.bases.views.describe", actor: bound, input: { project: "other", viewId: VIEW } }, d))).toBe(
      "operation_forbidden",
    );
    expect(await rejection(runOperation({ id: "ravi.pages.sites.list", actor: bound, input: { projectRef: "other" } }, d))).toBe("operation_forbidden");
    expect(
      await rejection(runOperation({ id: PAGES_SHIP_OPERATION_ID, actor: bound, input: { project: "other", title: "T", body: "x" }, confirmed: true }, d)),
    ).toBe("operation_forbidden");
    expect(await rejection(runOperation({ id: PAGES_READ_OPERATION_ID, actor: bound, input: { url: "https://other.ravi.page/" } }, d))).toBe(
      "operation_forbidden",
    );
    expect(await rejection(runOperation({ id: "ravi.knowledge.search", actor: { ...bound, surface: "page_chat", site: { ...site, projectId: OTHER } }, input: { query: "x" } }, d))).toBe(
      "operation_forbidden",
    );

    expect(await rejection(runOperation({ id: "ravi.bases.views.describe", actor: bound, input: { project: "mine", viewId: VIEW } }, d))).toBe("stub_view");
    expect(described).toEqual([PROJECT]);
    expect((await runOperation({ id: PAGES_READ_OPERATION_ID, actor: bound, input: { url: "https://mine.ravi.page/" } }, d)).output).toMatchObject({
      text: "secret",
    });
  });

  test("a cloud run token never reaches personal or run-control operations", async () => {
    const bound = actor({ boundProjectId: PROJECT });
    const personal = [
      "ravi.calendar.events.list",
      "ravi.calendar.events.get",
      "ravi.bugs.list",
      "ravi.bugs.create",
      "ravi.feedback.submit",
      "ravi.library.search",
      "ravi.library.propose",
      "ravi.cloud_agents.runs.message",
      "ravi.cloud_agents.runs.stop",
      "ravi.cloud_agents.approvals.decide",
      "ravi.bases.views.create",
      "ravi.bases.views.update",
      "ravi.pages.comments.mark_read",
    ];
    for (const id of personal) {
      expect(operationAllowedForBoundProject(id)).toBe(false);
      const confirmed = listOperationDefinitions().find((definition) => definition.id === id)!.needsConfirmation;
      expect(await rejection(runOperation({ id, actor: bound, input: { project: "mine" }, confirmed }, deps()))).toBe("operation_forbidden");
    }
    for (const id of ["ravi.bases.create", "ravi.bases.views.list", "ravi.meetings.transcript", "ravi.knowledge.retrieve", "ravi.cloud_agents.runs.list"]) {
      expect(operationAllowedForBoundProject(id)).toBe(true);
    }
  });

  test("new operations are MCP only, never for guests, and never destructive", () => {
    for (const handler of OPERATION_HANDLERS) {
      expect(handler.definition.surfaces).toEqual(["mcp"]);
      expect(handler.definition.guests).toBe(false);
      expect(handler.definition.class).not.toBe("destructive");
      expect(handler.definition.needsConfirmation).toBe(handler.definition.class === "write");
      expect(handler.definition.id).not.toMatch(/archive|delete|purge|restore|visibility|invite|share|password|publish/);
      if (handler.definition.class === "write") expect(handler.describeChange).toBeDefined();
    }
    expect(listOperationsForActor({ kind: "member", surface: "page_chat", site }).some((definition) => OPERATION_HANDLERS.some((handler) => handler.definition.id === definition.id))).toBe(false);
  });

  test("ship never runs unconfirmed, and its card names the project, route and visibility", async () => {
    const input = { project: "prs", title: "Teste", body: "<h1>Oi</h1>" };
    expect(await rejection(runOperation({ id: PAGES_SHIP_OPERATION_ID, actor: actor(), input }, deps()))).toBe("operation_confirmation_required");
    expect(describeOperationChange(PAGES_SHIP_OPERATION_ID, input)).toEqual([
      { label: "ação", value: "publicar uma página no Ravi Pages" },
      { label: "projeto", value: "prs" },
      { label: "título", value: "Teste" },
      { label: "rota", value: "/ (substitui o que essa rota mostra hoje)" },
      { label: "visibilidade", value: "privada (só membros com acesso)" },
      { label: "conteúdo", value: "<h1>Oi</h1>" },
    ]);
    expect(describeOperationChange(PAGES_SHIP_OPERATION_ID, { ...input, route: "/x", visibility: "public" })).toContainEqual({
      label: "visibilidade",
      value: "pública (qualquer pessoa com o link)",
    });
  });

  test("the confirmation card lists the values and the row", () => {
    expect(describeOperationChange("ravi.bases.views.rows.update", { rowId: "r1", values: { status: "pago" } })).toEqual([
      { label: "linha", value: "r1" },
      { label: "status", value: "pago" },
    ]);
    expect(describeOperationChange("ravi.bases.views.rows.archive", { rowId: "r1", viewId: VIEW, expectedVersion: 2 })).toEqual([
      { label: "linha", value: "r1" },
      { label: "ação", value: "arquivar a linha" },
    ]);
  });
});
