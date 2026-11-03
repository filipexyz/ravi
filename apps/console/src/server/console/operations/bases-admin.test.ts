import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import type { BasesCaller } from "@/server/console/bases/context";
import type { BaseScope, BasesProjectScope } from "@/server/console/bases/scope";
import type {
  BaseChart,
  BaseDetail,
  BaseProperty,
  BaseRowHistoryResponse,
  BaseSummary,
  BaseView,
  BaseViewPublic,
} from "@/shared/bases/types";

import {
  BASES_ADMIN_OPERATIONS,
  BASES_HISTORY_MAX_CHARS,
  basesAdminOperations,
  type BasesAdminOperationDeps,
} from "./bases-admin";
import type { OperationActor, OperationHandler } from "./types";

const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BASE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const VIEW = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CHART = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ROW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "99999999-9999-4999-8999-999999999999";

function actor(overrides: Partial<OperationActor> = {}): OperationActor {
  return {
    kind: "member",
    organizationId: "org",
    userId: "user-1",
    email: "Ana@Acme.test",
    orgRole: "developer",
    surface: "mcp",
    requestId: "req",
    site: null,
    pagesSessionId: null,
    ...overrides,
  };
}

const CAPS = { manage: true, readDirect: true, writeDirect: true };

const SUMMARY: BaseSummary = {
  id: BASE,
  organizationId: "org",
  projectId: PROJECT,
  slug: "pedidos",
  name: "Pedidos",
  description: null,
  icon: null,
  timezone: "UTC",
  schemaVersion: 3,
  version: 2,
  status: "active",
  rowCount: 7,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  capabilities: CAPS,
};

const PROPERTY: BaseProperty = {
  id: "prop-1",
  key: "status",
  name: "Status",
  description: null,
  type: "select",
  config: { options: [{ id: "o1", name: "Novo", color: "blue" }] } as BaseProperty["config"],
  position: 0,
  required: false,
  deletedAt: null,
};

const VIEW_CAPS = { read: true, aggregateOnly: false, writeColumns: ["status"], create: true, archive: true, manage: true, approve: [] };

const MANAGER_VIEW: BaseView = {
  id: VIEW,
  baseId: BASE,
  name: "All rows",
  description: null,
  columns: ["status"],
  query: { filter: null, sort: [] },
  layout: { type: "table" } as BaseView["layout"],
  access: {
    read: [{ kind: "project_role", minRole: "viewer" }],
    write: { principals: [], columns: [], create: false, archive: false, set: {}, allowEscape: false },
  },
  position: 0,
  version: 4,
  status: "active",
  valid: true,
  invalidReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  capabilities: VIEW_CAPS,
};

const PUBLIC_VIEW: BaseViewPublic = {
  id: VIEW,
  baseId: BASE,
  name: "Abertos",
  description: null,
  layout: { type: "table" } as BaseViewPublic["layout"],
  version: 4,
  columns: [{ key: "status", name: "Status", type: "select", config: {}, required: false }],
  capabilities: { ...VIEW_CAPS, manage: false, writeColumns: [] },
  valid: true,
};

const CHART_RECORD: BaseChart = {
  id: CHART,
  baseId: BASE,
  viewId: VIEW,
  name: "Por status",
  description: null,
  spec: { mark: "bar", encoding: { x: { field: "status", type: "nominal" }, y: { type: "quantitative", aggregate: "count" } } },
  position: 0,
  version: 1,
  status: "active",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

const DETAIL: BaseDetail = {
  ...SUMMARY,
  properties: [PROPERTY],
  views: [MANAGER_VIEW],
  charts: [CHART_RECORD],
  members: [{ id: MEMBER, displayName: "Ana", avatarUrl: "https://img.test/a.png" }],
};

function history(text: string, entries = 1): BaseRowHistoryResponse {
  return {
    entries: Array.from({ length: entries }, (_, index) => ({
      id: `entry-${index}`,
      sequence: index + 1,
      rowId: ROW,
      version: index + 1,
      action: "updated" as const,
      changedKeys: ["notes"],
      before: { notes: "old" },
      after: { notes: text },
      bodyChanged: false,
      actorType: "user" as const,
      actorId: "user-2",
      surface: "console" as const,
      viewId: VIEW,
      lastWriteWins: false,
      createdAt: "2026-10-02T00:00:00.000Z",
      agent: null,
    })),
    nextCursor: "next-1",
    users: { "user-2": { id: "user-2", displayName: "Bia", avatarUrl: "https://img.test/b.png" } },
  };
}

type Recorded = {
  findProject: Array<{ ref: string; action: string; role: string; userId: string }>;
  callers: BasesCaller[];
  baseRefs: string[];
  services: Array<{ name: string; args: unknown[] }>;
};

function makeDeps(overrides: Partial<BasesAdminOperationDeps> = {}) {
  const recorded: Recorded = { findProject: [], callers: [], baseRefs: [], services: [] };
  const track =
    <T>(name: string, result: (...args: unknown[]) => T) =>
    async (...args: unknown[]) => {
      recorded.services.push({ name, args });
      return result(...args);
    };
  const deps: BasesAdminOperationDeps = {
    featureEnabled: async () => true,
    findProject: (async (workspace: { user: { id: string }; membership: { role: string } }, ref: string, action: string) => {
      recorded.findProject.push({ ref, action, role: workspace.membership.role, userId: workspace.user.id });
      return { id: PROJECT, slug: "prs", organizationId: "org", status: "active" };
    }) as unknown as BasesAdminOperationDeps["findProject"],
    resolveBasesProject: async (input) => {
      recorded.callers.push(input.caller);
      expect(input.workspace?.membership.role).toBe("developer");
      expect(input.projectRef).toBe(PROJECT);
      return {
        caller: input.caller,
        project: { id: PROJECT, slug: "prs", organizationId: "org", status: "active" },
        access: { manage: true },
        projectReadOnly: false,
      } as unknown as BasesProjectScope;
    },
    resolveBaseScope: async (projectScope, ref) => {
      recorded.baseRefs.push(ref);
      return { ...projectScope, base: { id: BASE, projectId: PROJECT } } as unknown as BaseScope;
    },
    listBases: track("listBases", () => ({ bases: [SUMMARY] })) as BasesAdminOperationDeps["listBases"],
    getBaseDetail: track("getBaseDetail", () => DETAIL) as BasesAdminOperationDeps["getBaseDetail"],
    createBase: track("createBase", () => ({ status: 201, payload: DETAIL })) as BasesAdminOperationDeps["createBase"],
    createProperty: track("createProperty", () => ({ base: SUMMARY, property: PROPERTY, report: null })) as BasesAdminOperationDeps["createProperty"],
    updateProperty: track("updateProperty", () => ({ base: SUMMARY, property: PROPERTY, report: null })) as BasesAdminOperationDeps["updateProperty"],
    listViews: track("listViews", () => ({ views: [MANAGER_VIEW, PUBLIC_VIEW] })) as BasesAdminOperationDeps["listViews"],
    createView: track("createView", () => ({ status: 201, payload: MANAGER_VIEW })) as BasesAdminOperationDeps["createView"],
    updateView: track("updateView", () => MANAGER_VIEW) as BasesAdminOperationDeps["updateView"],
    viewVersionForCaller: track("viewVersionForCaller", () => ({ fingerprint: "fp-1" })) as BasesAdminOperationDeps["viewVersionForCaller"],
    historyThroughView: track("historyThroughView", () => history("new")) as BasesAdminOperationDeps["historyThroughView"],
    listCharts: track("listCharts", () => ({ charts: [CHART_RECORD] })) as BasesAdminOperationDeps["listCharts"],
    getChart: track("getChart", () => CHART_RECORD) as BasesAdminOperationDeps["getChart"],
    createChart: track("createChart", () => ({ status: 201, payload: CHART_RECORD })) as BasesAdminOperationDeps["createChart"],
    updateChart: track("updateChart", () => CHART_RECORD) as BasesAdminOperationDeps["updateChart"],
    ...overrides,
  };
  const handlers = basesAdminOperations(deps);
  const get = (id: string): OperationHandler => {
    const handler = handlers.find((candidate) => candidate.definition.id === id);
    if (!handler) throw new Error(`no handler ${id}`);
    return handler;
  };
  return { deps, recorded, get };
}

/** The person's identity reached the Bases services: the caller is this user, org and role, on the console surface. */
function expectIdentity(recorded: Recorded, access: "read" | "write") {
  expect(recorded.findProject[0]).toEqual({ ref: "prs", action: access, role: "developer", userId: "user-1" });
  const caller = recorded.callers[0]!;
  expect(caller.organizationId).toBe("org");
  expect(caller.user).toEqual({ id: "user-1", email: "ana@acme.test" });
  expect(caller.orgRole).toBe("developer");
  expect(caller.actorType).toBe("user");
  expect(caller.surface).toBe("console");
  const scope = recorded.services[0]?.args[0] as { caller?: BasesCaller } | BasesCaller | undefined;
  const serviceCaller = scope && "caller" in scope ? scope.caller : scope;
  expect((serviceCaller as BasesCaller).user?.id).toBe("user-1");
}

const SAMPLE_INPUTS: Record<string, Record<string, unknown>> = {
  "ravi.bases.list": { project: "prs" },
  "ravi.bases.get": { project: "prs", base: "pedidos" },
  "ravi.bases.views.list": { project: "prs", base: "pedidos" },
  "ravi.bases.views.version": { project: "prs", viewId: VIEW },
  "ravi.bases.views.rows.history": { project: "prs", base: "pedidos", viewId: VIEW, rowId: ROW },
  "ravi.bases.charts.list": { project: "prs", base: "pedidos" },
  "ravi.bases.charts.get": { project: "prs", base: "pedidos", chartId: CHART },
  "ravi.bases.create": { project: "prs", name: "Pedidos", properties: [{ name: "Status", type: "select" }] },
  "ravi.bases.properties.create": { project: "prs", base: "pedidos", name: "Notas", type: "text", expectedSchemaVersion: 3 },
  "ravi.bases.properties.update": { project: "prs", base: "pedidos", property: "status", name: "Situação", expectedSchemaVersion: 3 },
  "ravi.bases.views.create": { project: "prs", base: "pedidos", name: "Abertos", columns: ["status"] },
  "ravi.bases.views.update": { project: "prs", base: "pedidos", viewId: VIEW, expectedVersion: 4, name: "Abertos" },
  "ravi.bases.charts.create": {
    project: "prs",
    base: "pedidos",
    viewId: VIEW,
    name: "Por status",
    spec: { mark: "bar", encoding: { x: { field: "status", type: "nominal" } } },
  },
  "ravi.bases.charts.update": { project: "prs", base: "pedidos", chartId: CHART, expectedVersion: 1, name: "Status" },
};

describe("bases admin definitions", () => {
  test("every handler is MCP only, project bound, and confirms exactly its writes", () => {
    const ids = BASES_ADMIN_OPERATIONS.map((handler) => handler.definition.id);
    expect(ids.sort()).toEqual(Object.keys(SAMPLE_INPUTS).sort());
    for (const handler of BASES_ADMIN_OPERATIONS) {
      const { definition } = handler;
      // A view grants who reads Bases data, so a cloud run never creates or changes one.
      expect(handler.projectBound).toBe(!["ravi.bases.views.create", "ravi.bases.views.update"].includes(handler.definition.id));
      expect(definition.surfaces).toEqual(["mcp"]);
      expect(definition.guests).toBe(false);
      expect(definition.class === "read" || definition.class === "write").toBe(true);
      expect(definition.needsConfirmation).toBe(definition.class === "write");
      expect(Boolean(handler.describeChange)).toBe(definition.class === "write");
      expect(Boolean(definition.validateInput)).toBe(definition.class === "write");
      const schema = definition.inputSchema("mcp");
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required?.[0]).toBe("project");
      expect(Object.keys(schema.properties ?? {})[0]).toBe("project");
      expect(JSON.stringify(schema)).not.toContain("idempotencyKey");
      expect(JSON.stringify(schema)).not.toContain("$schema");
    }
  });

  test("writes validate with the services' own schemas and refuse idempotency keys and unknown fields", () => {
    const { get } = makeDeps();
    const create = get("ravi.bases.views.create").definition;
    expect(() => create.validateInput!(SAMPLE_INPUTS["ravi.bases.views.create"]!)).not.toThrow();
    expect(() => create.validateInput!({ ...SAMPLE_INPUTS["ravi.bases.views.create"], idempotencyKey: "abcdefgh1" })).toThrow();
    expect(() => create.validateInput!({ ...SAMPLE_INPUTS["ravi.bases.views.create"], color: "red" })).toThrow();
    expect(() =>
      create.validateInput!({ ...SAMPLE_INPUTS["ravi.bases.views.create"], access: { read: [{ kind: "page_viewer", siteId: "nope" }] } }),
    ).toThrow();
    const property = get("ravi.bases.properties.create").definition;
    expect(() => property.validateInput!({ ...SAMPLE_INPUTS["ravi.bases.properties.create"], type: "spreadsheet" })).toThrow();
  });
});

describe("bases admin reads", () => {
  test("ravi.bases.list lists the project's bases as the person", async () => {
    const { recorded, get } = makeDeps();
    const output = (await get("ravi.bases.list").run({ actor: actor(), input: { project: "prs", includeArchived: true } })) as {
      bases: Array<Record<string, unknown>>;
    };
    expectIdentity(recorded, "read");
    expect(recorded.services[0]).toMatchObject({ name: "listBases", args: [expect.anything(), { includeArchived: true }] });
    expect(output.bases[0]).toMatchObject({ id: BASE, slug: "pedidos", schemaVersion: 3, rowCount: 7 });
    expect(output.bases[0]).not.toHaveProperty("organizationId");
  });

  test("ravi.bases.get returns the schema and members without avatars", async () => {
    const { recorded, get } = makeDeps();
    const output = (await get("ravi.bases.get").run({ actor: actor(), input: { project: "prs", base: "pedidos" } })) as Record<string, unknown>;
    expectIdentity(recorded, "read");
    expect(recorded.baseRefs).toEqual(["pedidos"]);
    expect(output).toMatchObject({ id: BASE, properties: [{ id: "prop-1", key: "status", type: "select" }] });
    expect(output.members).toEqual([{ id: MEMBER, displayName: "Ana" }]);
    expect((output.views as Array<Record<string, unknown>>)[0]).toHaveProperty("access");
  });

  test("ravi.bases.views.list keeps manager and public view shapes", async () => {
    const { recorded, get } = makeDeps();
    const output = (await get("ravi.bases.views.list").run({ actor: actor(), input: { project: "prs", base: "pedidos" } })) as {
      views: Array<Record<string, unknown>>;
    };
    expectIdentity(recorded, "read");
    expect(output.views[0]).toMatchObject({ id: VIEW, access: MANAGER_VIEW.access, version: 4 });
    expect(output.views[1]).not.toHaveProperty("access");
    expect(output.views[1]).toMatchObject({ columns: [{ key: "status", name: "Status" }] });
  });

  test("ravi.bases.views.version calls the for-caller wrapper with the person and the resolved project", async () => {
    const { recorded, get } = makeDeps();
    const output = await get("ravi.bases.views.version").run({ actor: actor(), input: { project: "prs", viewId: VIEW.toUpperCase() } });
    expect(output).toEqual({ fingerprint: "fp-1" });
    expect(recorded.findProject[0]?.action).toBe("read");
    const [caller, target] = recorded.services[0]!.args as [BasesCaller, unknown];
    expect(caller.user?.id).toBe("user-1");
    expect(caller.organizationId).toBe("org");
    expect(caller.orgRole).toBe("developer");
    expect(target).toEqual({ projectId: PROJECT, viewId: VIEW });
  });

  test("ravi.bases.views.rows.history is untrusted, capped and keeps the cursor", async () => {
    const { recorded, get } = makeDeps({
      historyThroughView: (async (...args: unknown[]) => {
        recorded.services.push({ name: "historyThroughView", args });
        return history("x".repeat(2_000));
      }) as BasesAdminOperationDeps["historyThroughView"],
    });
    const output = (await get("ravi.bases.views.rows.history").run({
      actor: actor(),
      input: { ...SAMPLE_INPUTS["ravi.bases.views.rows.history"], cursor: "c-1", limit: 5 },
    })) as Record<string, unknown>;
    expectIdentity(recorded, "read");
    const [, viewId, rowId, params] = recorded.services[0]!.args as [unknown, string, string, URLSearchParams];
    expect([viewId, rowId, params.get("cursor"), params.get("limit")]).toEqual([VIEW, ROW, "c-1", "5"]);
    expect(output.contentTrust).toBe("untrusted");
    expect(output.truncated).toBe(true);
    expect(output.nextCursor).toBe("next-1");
    const entry = (output.entries as Array<{ after: { notes: string } }>)[0]!;
    expect(entry.after.notes.length).toBe(500);
    expect(output.users).toEqual({ "user-2": { id: "user-2", displayName: "Bia" } });
  });

  test("ravi.bases.views.rows.history asks for fewer entries when a page is too long", async () => {
    const limits: string[] = [];
    const { get } = makeDeps({
      historyThroughView: (async (_scope: unknown, _view: string, _row: string, params: URLSearchParams) => {
        limits.push(params.get("limit") ?? "");
        return history("y".repeat(400), Number(params.get("limit")));
      }) as unknown as BasesAdminOperationDeps["historyThroughView"],
    });
    const output = (await get("ravi.bases.views.rows.history").run({
      actor: actor(),
      input: { ...SAMPLE_INPUTS["ravi.bases.views.rows.history"], limit: 50 },
    })) as { limit: number };
    expect(limits[0]).toBe("50");
    expect(limits.length).toBeGreaterThan(1);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(BASES_HISTORY_MAX_CHARS + 100);
  });

  test("ravi.bases.charts.list and ravi.bases.charts.get", async () => {
    const list = makeDeps();
    const listed = (await list.get("ravi.bases.charts.list").run({ actor: actor(), input: { project: "prs", base: "pedidos" } })) as {
      charts: unknown[];
    };
    expectIdentity(list.recorded, "read");
    expect(listed.charts[0]).toMatchObject({ id: CHART, viewId: VIEW, status: "active" });

    const one = makeDeps();
    const chart = await one.get("ravi.bases.charts.get").run({ actor: actor(), input: SAMPLE_INPUTS["ravi.bases.charts.get"]! });
    expectIdentity(one.recorded, "read");
    expect(one.recorded.services[0]?.args[1]).toBe(CHART);
    expect(chart).toMatchObject({ id: CHART, spec: CHART_RECORD.spec });
  });
});

describe("bases admin writes", () => {
  test("ravi.bases.create resolves the project for writing and passes a derived idempotency key", async () => {
    const { recorded, get } = makeDeps();
    const handler = get("ravi.bases.create");
    const input = SAMPLE_INPUTS["ravi.bases.create"]!;
    const output = (await handler.run({ actor: actor(), input, idempotencySeed: "token-1" })) as Record<string, unknown>;
    expectIdentity(recorded, "write");
    const [, body, key] = recorded.services[0]!.args as [unknown, Record<string, unknown>, string];
    expect(body).toEqual({ name: "Pedidos", properties: [{ name: "Status", type: "select" }] });
    expect(key).toMatch(/^op:[0-9a-f]{40}$/);
    expect(output).toMatchObject({ id: BASE, idempotentReplay: false });

    const again = makeDeps();
    await again.get("ravi.bases.create").run({ actor: actor(), input, idempotencySeed: "token-1" });
    expect(again.recorded.services[0]!.args[2]).toBe(key);

    const lines = handler.describeChange!(input);
    expect(lines[0]).toEqual({ label: "ação", value: "criar uma base" });
    expect(lines).toContainEqual({ label: "projeto", value: "prs" });
    expect(lines).toContainEqual({ label: "nome", value: "Pedidos" });
    expect(lines).toContainEqual({ label: "propriedades", value: "1: Status (select)" });
  });

  test("ravi.bases.properties.create and update", async () => {
    const created = makeDeps();
    await created.get("ravi.bases.properties.create").run({
      actor: actor(),
      input: SAMPLE_INPUTS["ravi.bases.properties.create"]!,
      idempotencySeed: "token-2",
    });
    expectIdentity(created.recorded, "write");
    const [, createBody, createKey] = created.recorded.services[0]!.args as [unknown, Record<string, unknown>, string];
    expect(createBody).toEqual({ name: "Notas", type: "text", expectedSchemaVersion: 3 });
    expect(createKey).toMatch(/^op:/);
    expect(created.get("ravi.bases.properties.create").describeChange!(SAMPLE_INPUTS["ravi.bases.properties.create"]!)).toEqual([
      { label: "ação", value: "adicionar uma propriedade à base" },
      { label: "projeto", value: "prs" },
      { label: "base", value: "pedidos" },
      { label: "nome", value: "Notas" },
      { label: "tipo", value: "text" },
    ]);

    const updated = makeDeps();
    const input = { ...SAMPLE_INPUTS["ravi.bases.properties.update"], type: "multi_select" };
    const output = await updated.get("ravi.bases.properties.update").run({ actor: actor(), input });
    expectIdentity(updated.recorded, "write");
    const [, ref, body] = updated.recorded.services[0]!.args as [unknown, string, Record<string, unknown>];
    expect(ref).toBe("status");
    expect(body).toEqual({ name: "Situação", type: "multi_select", expectedSchemaVersion: 3 });
    expect(output).toMatchObject({ base: { id: BASE }, property: { id: "prop-1" }, report: null });
    const lines = updated.get("ravi.bases.properties.update").describeChange!(input);
    expect(lines[0]).toEqual({ label: "ação", value: "alterar uma propriedade da base" });
    expect(lines).toContainEqual({ label: "migração", value: "só simular: relata o que converteria ou seria limpo, nada muda" });
    // Applying a migration that rewrites every row stays in the Console and CLI.
    await expect(
      updated.get("ravi.bases.properties.update").run({ actor: actor(), input: { ...input, confirm: true } }),
    ).rejects.toThrow();
    expect(updated.get("ravi.bases.properties.update").definition.inputSchema("mcp").properties).not.toHaveProperty("confirm");
  });

  test("agent columns (they run an agent on every row) are refused before any service call", async () => {
    const d = makeDeps();
    for (const [id, input] of [
      ["ravi.bases.properties.create", { ...SAMPLE_INPUTS["ravi.bases.properties.create"], type: "agent" }],
      ["ravi.bases.properties.update", { ...SAMPLE_INPUTS["ravi.bases.properties.update"], type: "agent" }],
      ["ravi.bases.create", { ...SAMPLE_INPUTS["ravi.bases.create"], properties: [{ name: "Resumo", type: "agent" }] }],
    ] as const) {
      await expect(d.get(id).run({ actor: actor(), input: input as Record<string, unknown>, idempotencySeed: "t" })).rejects.toThrow();
      expect(() => d.get(id).definition.validateInput!(input as Record<string, unknown>)).toThrow();
    }
    expect(d.recorded.services).toEqual([]);
  });

  test("ravi.bases.views.create and update describe the access contract", async () => {
    const created = makeDeps();
    const input = {
      ...SAMPLE_INPUTS["ravi.bases.views.create"],
      access: {
        read: [{ kind: "project_role", minRole: "viewer" }],
        write: { principals: [{ kind: "user", userId: MEMBER }], columns: ["status"], create: true },
      },
    };
    const output = await created.get("ravi.bases.views.create").run({ actor: actor(), input, idempotencySeed: "token-3" });
    expectIdentity(created.recorded, "write");
    const [, body, key] = created.recorded.services[0]!.args as [unknown, Record<string, unknown>, string];
    expect(body).toMatchObject({ name: "Abertos", columns: ["status"], access: { write: { create: true, archive: false } } });
    expect(body).not.toHaveProperty("project");
    expect(key).toMatch(/^op:/);
    expect(output).toMatchObject({ view: { id: VIEW }, idempotentReplay: false });
    const lines = created.get("ravi.bases.views.create").describeChange!(input);
    expect(lines.slice(0, 3)).toEqual([
      { label: "ação", value: "criar uma visão da base" },
      { label: "projeto", value: "prs" },
      { label: "base", value: "pedidos" },
    ]);
    expect(lines).toContainEqual({ label: "acesso: leitura", value: "papel no projeto ≥ viewer" });
    expect(lines).toContainEqual({ label: "acesso: escrita", value: `pessoa ${MEMBER}` });
    expect(lines).toContainEqual({ label: "colunas graváveis", value: "status" });
    expect(lines).toContainEqual({ label: "também pode", value: "criar linhas" });

    const updated = makeDeps();
    await updated.get("ravi.bases.views.update").run({ actor: actor(), input: SAMPLE_INPUTS["ravi.bases.views.update"]! });
    expectIdentity(updated.recorded, "write");
    const [, viewId, updateBody] = updated.recorded.services[0]!.args as [unknown, string, Record<string, unknown>];
    expect(viewId).toBe(VIEW);
    expect(updateBody).toEqual({ expectedVersion: 4, name: "Abertos" });
    const updateLines = updated.get("ravi.bases.views.update").describeChange!(SAMPLE_INPUTS["ravi.bases.views.update"]!);
    expect(updateLines[0]?.value).toContain("alterar uma visão");
    expect(updateLines).toContainEqual({ label: "muda", value: "name" });
  });

  test("ravi.bases.charts.create and update", async () => {
    const created = makeDeps();
    const output = await created.get("ravi.bases.charts.create").run({
      actor: actor(),
      input: SAMPLE_INPUTS["ravi.bases.charts.create"]!,
      idempotencySeed: "token-4",
    });
    expectIdentity(created.recorded, "write");
    const [, body, key] = created.recorded.services[0]!.args as [unknown, Record<string, unknown>, string];
    expect(body).toMatchObject({ viewId: VIEW, name: "Por status" });
    expect(key).toMatch(/^op:/);
    expect(output).toMatchObject({ chart: { id: CHART }, idempotentReplay: false });
    const lines = created.get("ravi.bases.charts.create").describeChange!(SAMPLE_INPUTS["ravi.bases.charts.create"]!);
    expect(lines[0]).toEqual({ label: "ação", value: "criar um gráfico da base" });
    expect(lines).toContainEqual({ label: "visão", value: VIEW });

    const updated = makeDeps();
    await updated.get("ravi.bases.charts.update").run({ actor: actor(), input: SAMPLE_INPUTS["ravi.bases.charts.update"]! });
    expectIdentity(updated.recorded, "write");
    const [, chartId, updateBody] = updated.recorded.services[0]!.args as [unknown, string, Record<string, unknown>];
    expect(chartId).toBe(CHART);
    expect(updateBody).toEqual({ expectedVersion: 1, name: "Status" });
    expect(updated.get("ravi.bases.charts.update").describeChange!(SAMPLE_INPUTS["ravi.bases.charts.update"]!)).toContainEqual({
      label: "gráfico",
      value: CHART,
    });
  });
});

describe("bases admin refusals", () => {
  test("a cloud run bound to another project is refused before any Bases service runs", async () => {
    for (const handler of BASES_ADMIN_OPERATIONS) {
      const id = handler.definition.id;
      const { recorded, get } = makeDeps();
      const error = await get(id)
        .run({ actor: actor({ boundProjectId: OTHER_PROJECT }), input: SAMPLE_INPUTS[id]!, idempotencySeed: "seed" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(403);
      expect((error as ConsoleApiError).payload.error).toBe("operation_forbidden");
      expect(recorded.callers).toEqual([]);
      expect(recorded.services).toEqual([]);
    }
  });

  test("a cloud run in its own project goes through", async () => {
    const { recorded, get } = makeDeps();
    await get("ravi.bases.list").run({ actor: actor({ boundProjectId: PROJECT }), input: { project: "prs" } });
    expect(recorded.services[0]?.name).toBe("listBases");
  });

  test("without the console.bases feature nothing is resolved", async () => {
    const { recorded, get } = makeDeps({ featureEnabled: async () => false });
    const error = await get("ravi.bases.get")
      .run({ actor: actor(), input: { project: "prs", base: "pedidos" } })
      .catch((caught: unknown) => caught);
    expect((error as ConsoleApiError).status).toBe(403);
    expect((error as ConsoleApiError).payload.error).toBe("operation_forbidden");
    expect(recorded.findProject).toEqual([]);
    expect(recorded.services).toEqual([]);
  });

  test("bad input is payload_invalid with field errors, and service errors keep their code", async () => {
    const { get } = makeDeps({
      updateView: (async () => {
        throw new ConsoleApiError(409, { error: "version_conflict", reason: "The view changed since it was read." });
      }) as BasesAdminOperationDeps["updateView"],
    });
    const invalid = await get("ravi.bases.views.version")
      .run({ actor: actor(), input: { project: "prs", viewId: "not-a-uuid" } })
      .catch((caught: unknown) => caught);
    expect((invalid as ConsoleApiError).status).toBe(400);
    expect((invalid as ConsoleApiError).payload).toMatchObject({ error: "payload_invalid", fieldErrors: { viewId: "Expected a uuid." } });

    const conflict = await get("ravi.bases.views.update")
      .run({ actor: actor(), input: SAMPLE_INPUTS["ravi.bases.views.update"]! })
      .catch((caught: unknown) => caught);
    expect((conflict as ConsoleApiError).status).toBe(409);
    expect((conflict as ConsoleApiError).payload.error).toBe("version_conflict");
  });
});
