import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import type { ContextRecord } from "../../router/router-db.js";
import { runWithContext } from "../context.js";
import { evaluateFilter } from "../../triggers/filter.js";
import type { Trigger, TriggerInput } from "../../triggers/types.js";
import type { BasesCommandDeps, BasesTriggerStore } from "./bases.js";

// hasContext() true makes contract helpers throw ContractError instead of exiting.
const actualContext = await import("../context.js");
mock.module("../context.js", () => ({
  ...actualContext,
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const {
  BasesCommands,
  BasesPropsCommands,
  BasesRowsCommands,
  BasesViewsCommands,
  BasesChartsCommands,
  subscriptionTriggerFilter,
} = await import("./bases.js");
const { ContractError } = await import("../agent-contract.js");
const { getReturnsMetadata } = await import("../decorators.js");
const { parseGroupByOption, parseSortOption } = await import("../../bases/input.js");
const { buildRegistry } = await import("../registry-snapshot.js");
const { dispatch } = await import("../../sdk/gateway/dispatcher.js");

afterAll(() => mock.restore());

const ROOT = "/api/cli/projects/sales/bases";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ravi bases brakes", () => {
  it("dry-runs purge, base archive, view archive, and chart archive without calling the Console", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({}));

    const attempts: Array<() => Promise<unknown>> = [
      () => new BasesRowsCommands(deps).purge("crm", "row_1", "sales", undefined, true, undefined),
      () => new BasesCommands(deps).archive("crm", undefined, "sales", undefined, true, undefined),
      () => new BasesCommands(deps).restore("crm", "3", "sales", undefined, true, undefined),
      () => new BasesViewsCommands(deps).archive("crm", "view_1", undefined, "sales", undefined, true, undefined),
      () => new BasesChartsCommands(deps).archive("crm", "chart_1", undefined, "sales", undefined, true, undefined),
    ];
    for (const attempt of attempts) {
      const { error, output } = await captureFailure(attempt);
      expect(error).toBeInstanceOf(ContractError);
      expect(error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
      expect(JSON.parse(output)).toMatchObject({ success: false, error: { code: "WRITE_REQUIRES_EXECUTE" } });
    }
    expect(calls).toEqual([]);
  });

  it("purges with --execute and sends confirm", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({ purged: true, rowId: "row_1" }));

    const { output, result } = await captureConsole(() =>
      new BasesRowsCommands(deps).purge("crm", "row_1", "sales", undefined, true, true),
    );

    expect(calls).toEqual([
      { method: "POST", path: `${ROOT}/crm/rows/row_1/purge`, body: { confirm: true }, headers: {} },
    ]);
    expect(JSON.parse(output)).toMatchObject({ success: true, purged: true, rowId: "row_1" });
    expectReturnsMatch(BasesRowsCommands, "purge", result);
  });
});

describe("ravi bases rows writes", () => {
  it("creates a row from --values and --set with a generated idempotency key", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({ row: row(1), users: {}, idempotentReplay: false }));

    const { result } = await captureConsole(() =>
      new BasesRowsCommands(deps).add(
        "crm",
        undefined,
        '{"title":"Acme","stage":"lead"}',
        ["stage=won", "amount:=1200"],
        "Notes",
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls).toEqual([
      {
        method: "POST",
        path: `${ROOT}/crm/rows`,
        body: {
          values: { title: "Acme", stage: "won", amount: 1200 },
          body: "Notes",
          idempotencyKey: "ravi-cli:test-key-0001",
        },
        headers: { "Idempotency-Key": "ravi-cli:test-key-0001" },
      },
    ]);
    expect(result).toMatchObject({ idempotencyKey: "ravi-cli:test-key-0001", row: { rowId: "row_1" } });
    expectReturnsMatch(BasesRowsCommands, "add", result);
  });

  it("requires --expected-version or --last-write-wins before any Console call", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({}));

    const { error, output } = await captureFailure(() =>
      new BasesRowsCommands(deps).update(
        "crm",
        "row_1",
        undefined,
        undefined,
        ["stage=won"],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(error).toMatchObject({ code: "PAYLOAD_INVALID", exitCode: 2 });
    expect(JSON.parse(output).error.message).toContain("--expected-version");
    expect(calls).toEqual([]);
  });

  it("updates through a view with an explicit version and idempotency key", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({ row: row(3), users: {}, idempotentReplay: false }));

    await captureConsole(() =>
      new BasesRowsCommands(deps).update(
        "crm",
        "row_1",
        "view_1",
        undefined,
        ["stage=won"],
        undefined,
        undefined,
        "2",
        undefined,
        "retry-key-0042",
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls[0]).toEqual({
      method: "PATCH",
      path: `${ROOT}/crm/views/view_1/rows/row_1`,
      body: { values: { stage: "won" }, expectedVersion: 2, idempotencyKey: "retry-key-0042" },
      headers: { "Idempotency-Key": "retry-key-0042" },
    });
  });

  it("returns VERSION_CONFLICT with the current row and a retry hint", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => {
      throw new CloudAuthError("VERSION_CONFLICT", "Row changed since version 1.", {
        status: 409,
        requestId: "req_9",
        details: { error: "version_conflict", current: row(4) },
      });
    });

    const { error, output } = await captureFailure(() =>
      new BasesRowsCommands(deps).update(
        "crm",
        "row_1",
        undefined,
        undefined,
        ["stage=won"],
        undefined,
        undefined,
        "1",
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(error).toMatchObject({ code: "VERSION_CONFLICT", exitCode: 1 });
    const envelope = JSON.parse(output);
    expect(envelope).toMatchObject({
      success: false,
      error: {
        code: "VERSION_CONFLICT",
        retryable: false,
        consoleError: "version_conflict",
        requestId: "req_9",
        current: { rowId: "row_1", version: 4 },
      },
    });
    expect(envelope.error.suggestedAction).toContain("--expected-version 4");
  });

  it("maps Console fieldErrors to issues", async () => {
    const deps = makeDeps([], () => {
      throw new CloudAuthError("PAYLOAD_INVALID", "Invalid values.", {
        status: 400,
        details: { error: "validation_failed", fieldErrors: { amount: "must be a number" } },
      });
    });

    const { output } = await captureFailure(() =>
      new BasesRowsCommands(deps).add(
        "crm",
        undefined,
        undefined,
        ["amount=abc"],
        undefined,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(JSON.parse(output).error).toMatchObject({
      code: "PAYLOAD_INVALID",
      consoleError: "validation_failed",
      issues: [{ path: ["values", "amount"], message: "must be a number" }],
    });
  });

  it("tells old logins to run ravi login again for the Bases scopes", async () => {
    const deps = makeDeps(
      [],
      () => {
        throw new CloudAuthError("PROJECT_ACCESS_DENIED", "No access to this project.", { status: 403 });
      },
      { scopes: ["console.projects.read"] },
    );

    const { error, output } = await captureFailure(() =>
      new BasesCommands(deps).list(undefined, undefined, undefined, undefined, "sales", undefined, true),
    );

    expect(error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    const envelope = JSON.parse(output);
    expect(envelope.error.missingScopes).toEqual(["console.bases.read", "console.bases.write"]);
    expect(envelope.error.suggestedAction).toContain("ravi login");
  });
});

describe("ravi bases rows idempotency warning", () => {
  const agentHint = () => ({ agentId: "main", sessionKey: "agent:main:trigger:t1", sdk: "ravi-cli" });
  const noAgent = () => null;
  const writeDeps = (calls: Call[], clientHint: BasesTestDeps["clientHint"]): BasesTestDeps => ({
    ...makeDeps(calls, () => ({ row: row(2), users: {}, idempotentReplay: false })),
    clientHint,
  });
  const add = (deps: BasesTestDeps, idempotencyKey: string | undefined, asJson: boolean) =>
    new BasesRowsCommands(deps).add(
      "crm",
      undefined,
      undefined,
      ["stage=won"],
      undefined,
      undefined,
      idempotencyKey,
      "sales",
      undefined,
      asJson,
    );
  const update = (deps: BasesTestDeps, idempotencyKey: string | undefined, asJson: boolean) =>
    new BasesRowsCommands(deps).update(
      "crm",
      "row_1",
      undefined,
      undefined,
      ["stage=won"],
      undefined,
      undefined,
      "1",
      undefined,
      idempotencyKey,
      "sales",
      undefined,
      asJson,
    );

  it("still writes from an agent session without --idempotency-key, and warns in JSON", async () => {
    for (const [method, run] of [
      ["add", add],
      ["update", update],
    ] as const) {
      const calls: Call[] = [];
      const { output, result } = await captureConsole(() => run(writeDeps(calls, agentHint), undefined, true));

      expect(calls).toHaveLength(1);
      expect(calls[0]?.headers["Idempotency-Key"]).toBe("ravi-cli:test-key-0001");
      const warnings = (result as { warnings?: string[] }).warnings;
      expect(warnings).toHaveLength(1);
      expect(warnings?.[0]).toContain("a retry would get a new generated key");
      expect(warnings?.[0]).toContain("--idempotency-key <stable key>, e.g. <base>:<row>:<step>");
      expect(JSON.parse(output).warnings).toEqual(warnings);
      expectReturnsMatch(BasesRowsCommands, method, result);
    }
  });

  it("prints one warning line in human output", async () => {
    const { output } = await captureConsole(() => add(writeDeps([], agentHint), undefined, false));
    const lines = output.split("\n");

    expect(lines[0]).toBe("✓ Row created: row_1 v2");
    expect(lines.filter((line) => line.startsWith("warning: "))).toHaveLength(1);
    expect(lines[1]).toStartWith("warning: written without --idempotency-key");
  });

  it("does not warn with --idempotency-key or outside an agent session", async () => {
    for (const run of [add, update]) {
      const withKey = await captureConsole(() => run(writeDeps([], agentHint), "crm:msg-42:intake", true));
      expect(withKey.result).toMatchObject({ idempotencyKey: "crm:msg-42:intake" });
      expect(withKey.result).not.toHaveProperty("warnings");

      const outside = await captureConsole(() => run(writeDeps([], noAgent), undefined, false));
      expect(outside.result).not.toHaveProperty("warnings");
      expect(outside.output).not.toContain("warning:");
    }
  });

  it("detects the agent session from the gateway context when no hint is injected", async () => {
    const calls: Call[] = [];
    const deps: BasesTestDeps = makeDeps(calls, () => ({ row: row(2), users: {}, idempotentReplay: false }));
    delete deps.clientHint;

    const unkeyed = await dispatchThroughGateway(BasesRowsCommands, "add", deps, {
      base: "crm",
      set: ["stage=won"],
      project: "sales",
    });
    const keyed = await dispatchThroughGateway(BasesRowsCommands, "add", deps, {
      base: "crm",
      set: ["stage=won"],
      idempotencyKey: "crm:msg-42:intake",
      project: "sales",
    });

    expect(unkeyed).toMatchObject({ status: 200, body: { success: true, warnings: [expect.any(String)] } });
    expect(keyed.status).toBe(200);
    expect(keyed.body).not.toHaveProperty("warnings");
    expect(calls[0]?.body).toMatchObject({ clientHint: { agentId: "bases-agent", sdk: "ravi-sdk-gateway" } });
  });
});

describe("ravi bases rows query", () => {
  it("follows cursors with --all without changing the query and caps at --max-rows", async () => {
    const calls: Call[] = [];
    const pages = [
      { columns: ["title"], rows: [row(1, "row_1"), row(1, "row_2")], nextCursor: "c1", users: {} },
      { columns: ["title"], rows: [row(1, "row_3"), row(1, "row_4")], nextCursor: "c2", users: {} },
      { columns: ["title"], rows: [row(1, "row_5")], nextCursor: null, users: {} },
    ];
    const deps = makeDeps(calls, () => pages[calls.length - 1]);
    const filter = '{"prop":"stage","op":"eq","value":"won"}';

    const { result } = await captureConsole(() =>
      new BasesRowsCommands(deps).query(
        "crm",
        undefined,
        filter,
        "amount:desc",
        "2",
        undefined,
        true,
        "3",
        undefined,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    const query = {
      filter: { prop: "stage", op: "eq", value: "won" },
      sort: [{ prop: "amount", dir: "desc" }],
      limit: 2,
    };
    expect(calls.map((call) => call.body)).toEqual([query, { ...query, cursor: "c1" }]);
    expect(calls.every((call) => call.path === `${ROOT}/crm/rows/query`)).toBe(true);
    expect(result).toMatchObject({ truncated: true, nextCursor: "c2", pagination: { count: 4, hasMore: true } });
    expect((result as { pagination: { nextCommand: string } }).pagination.nextCommand).toContain("--cursor c2");
    expectReturnsMatch(BasesRowsCommands, "query", result);
  });

  it("queries through a view on the view path", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({ columns: [], rows: [], nextCursor: null, users: {} }));

    await captureConsole(() =>
      new BasesViewsCommands(deps).query(
        "crm",
        "view_1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `${ROOT}/crm/views/view_1/query`,
      body: { includeBody: true },
    });
  });
});

describe("ravi bases rows import", () => {
  it("previews the mapping as a dry-run, then imports in keyed batches with --execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-bases-import-"));
    tempDirs.push(dir);
    const file = join(dir, "deals.csv");
    writeFileSync(file, "Deal Name,Amount,Notes\nAcme,100,first\nBeta,200,\nGamma,300,third\n");

    const calls: Call[] = [];
    const deps = makeDeps(calls, (call) => {
      if (call.method === "GET") return baseDetail();
      const rows = (call.body as { rows: unknown[] }).rows;
      return { rows: rows.map((_, index) => row(1, `row_${index}`)), users: {}, idempotentReplay: false };
    });
    const command = new BasesRowsCommands(deps);

    const preview = await captureFailure(() =>
      command.import("crm", file, ["Notes=body"], "2", "sales", undefined, true, undefined),
    );
    expect(preview.error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(JSON.parse(preview.output).error.plan).toMatchObject({ rows: 3, batches: 2, batchSize: 2 });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);

    calls.length = 0;
    const { result } = await captureConsole(() =>
      command.import("crm", file, ["Notes=body"], "2", "sales", undefined, true, true),
    );
    const writes = calls.filter((call) => call.method === "POST");
    expect(writes).toHaveLength(2);
    const keys = writes.map((call) => call.headers["Idempotency-Key"]);
    expect(keys[0]).toMatch(/^ravi-import:[0-9a-f]{40}:0$/);
    expect(keys[1]).toBe(keys[0]?.replace(/:0$/, ":1"));
    expect(writes[0]?.body).toMatchObject({
      rows: [{ values: { name: "Acme", amount: 100 }, body: "first" }, { values: { name: "Beta", amount: 200 } }],
      idempotencyKey: keys[0],
    });
    expect(result).toMatchObject({ created: 3, batchCount: 2, rowCount: 3 });
    expectReturnsMatch(BasesRowsCommands, "import", result);

    calls.length = 0;
    await captureConsole(() => command.import("crm", file, ["Notes=body"], "2", "sales", undefined, true, true));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.headers["Idempotency-Key"])).toEqual(keys);
  });

  it("stops before the brake when cells do not fit their property type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-bases-import-"));
    tempDirs.push(dir);
    const file = join(dir, "bad.csv");
    writeFileSync(file, "Deal Name,Amount\nAcme,lots\n");
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => baseDetail());

    const { error, output } = await captureFailure(() =>
      new BasesRowsCommands(deps).import("crm", file, undefined, undefined, "sales", undefined, true, true),
    );
    expect(error).toMatchObject({ code: "PAYLOAD_INVALID", exitCode: 2 });
    expect(JSON.parse(output).error.issues[0]).toMatchObject({ path: ["rows", 2, "amount"] });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });
});

describe("ravi bases props", () => {
  it("prints the server dry-run report for a delete and confirms with --execute", async () => {
    const calls: Call[] = [];
    const report = {
      dryRun: true,
      activeRows: 10,
      converted: 0,
      cleared: 10,
      missing: 0,
      dependents: { views: [{ id: "view_1", name: "Pipeline" }], charts: [] },
    };
    const deps = makeDeps(calls, (call) => {
      if (call.method === "GET") return baseDetail();
      const confirmed = (call.body as { confirm?: boolean }).confirm === true;
      return {
        base: baseSummary(),
        property: { ...property("amount", "number"), deletedAt: confirmed ? "2026-10-06T00:00:00.000Z" : null },
        report: confirmed ? { ...report, dryRun: false } : report,
      };
    });
    const command = new BasesPropsCommands(deps);

    const preview = await captureFailure(() => command.delete("crm", "amount", undefined, "sales", undefined, true));
    expect(preview.error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(JSON.parse(preview.output).error.plan.migration.dependents.views).toEqual([
      { id: "view_1", name: "Pipeline" },
    ]);
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["GET", `${ROOT}/crm`, undefined],
      ["POST", `${ROOT}/crm/properties/amount/delete`, { expectedSchemaVersion: 5 }],
    ]);

    calls.length = 0;
    const { result } = await captureConsole(() => command.delete("crm", "amount", "5", "sales", undefined, true, true));
    expect(calls).toEqual([
      {
        method: "POST",
        path: `${ROOT}/crm/properties/amount/delete`,
        body: { expectedSchemaVersion: 5, confirm: true },
        headers: {},
      },
    ]);
    expectReturnsMatch(BasesPropsCommands, "delete", result);
  });

  it("adds a status property with grouped options and the current schema version", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, (call) =>
      call.method === "GET"
        ? baseDetail()
        : { base: baseSummary(), property: property("status", "status"), report: null },
    );

    await captureConsole(() =>
      new BasesPropsCommands(deps).add(
        "crm",
        "Status",
        "status",
        undefined,
        undefined,
        "Todo:todo,Doing:in_progress,Done:done",
        undefined,
        undefined,
        undefined,
        ...noTypedPropertyFlags(),
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls[1]).toMatchObject({
      method: "POST",
      path: `${ROOT}/crm/properties`,
      body: {
        name: "Status",
        type: "status",
        config: {
          options: [
            { name: "Todo", group: "todo" },
            { name: "Doing", group: "in_progress" },
            { name: "Done", group: "done" },
          ],
        },
        expectedSchemaVersion: 5,
      },
    });
  });
});

describe("ravi bases subscriptions and listings", () => {
  it("subscribes and reports the inbox delivery subject", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => subscription());

    const { result } = await captureConsole(() =>
      new BasesCommands(deps).subscribe("crm", ...noSubscribeFilter(), "sales", undefined, true),
    );

    expect(calls[0]).toMatchObject({ method: "POST", path: `${ROOT}/crm/subscriptions`, body: {} });
    expect(result).toMatchObject({ delivery: { natsSubject: "ravi.console.inbox.item", category: "bases" } });
    expectReturnsMatch(BasesCommands, "subscribe", result);
  });

  it("lists bases with offset pagination and validates against the return contract", async () => {
    const deps = makeDeps([], () => ({ bases: [baseSummary()] }));

    const { result } = await captureConsole(() =>
      new BasesCommands(deps).list(undefined, undefined, undefined, undefined, "sales", undefined, true),
    );

    expect(result).toMatchObject({ total: 1, projectRef: "sales", bases: [{ slug: "crm" }] });
    expectReturnsMatch(BasesCommands, "list", result);
  });

  it("shows a base detail that satisfies the return contract", async () => {
    const deps = makeDeps([], () => baseDetail());
    const { result } = await captureConsole(() => new BasesCommands(deps).show("crm", "sales", undefined, true));
    expectReturnsMatch(BasesCommands, "show", result);
  });
});

describe("ravi bases views bind", () => {
  const VIEW_PATH = `${ROOT}/crm/views/view_1`;

  function fullView(layout: Record<string, unknown>, version = 4) {
    return {
      id: "view_1",
      baseId: "base_1",
      name: "Pedidos",
      description: null,
      columns: ["titulo", "status", "total"],
      query: { filter: null, sort: [] },
      layout,
      access: { principals: [] },
      position: 0,
      version,
      status: "active",
      valid: true,
      invalidReason: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      capabilities: { read: true, aggregateOnly: false, writeColumns: [], create: true, archive: true, manage: true },
    };
  }

  function describeView(layout: Record<string, unknown>) {
    const view = fullView(layout);
    return {
      id: view.id,
      baseId: view.baseId,
      name: view.name,
      description: null,
      layout: { type: layout.type },
      version: view.version,
      columns: [],
      capabilities: view.capabilities,
      valid: true,
      view,
    };
  }

  /** GET answers the described view; PATCH echoes the sent layout at the next version. */
  function bindDeps(calls: Call[], layout: Record<string, unknown>) {
    return makeDeps(calls, (call) => {
      if (call.method === "GET") return describeView(layout);
      const body = call.body as { layout: Record<string, unknown> };
      const widget = body.layout.widget as Record<string, unknown> | null;
      return fullView(
        { ...body.layout, widget: widget ? { itemId: "item_1", ref: "org/pedido-card", ...widget } : null },
        5,
      );
    });
  }

  it("merges layout.widget into the full current layout at the version it read", async () => {
    const calls: Call[] = [];
    const layout = { type: "board", groupBy: "status", cardFields: ["total"], widget: null };
    const deps = bindDeps(calls, layout);

    const { result } = await captureConsole(() =>
      new BasesViewsCommands(deps).bind(
        "crm",
        "view_1",
        "org/pedido-card",
        ["valor=total", "titulo=titulo"],
        "compact",
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls).toEqual([
      { method: "GET", path: VIEW_PATH, body: undefined, headers: {} },
      {
        method: "PATCH",
        path: VIEW_PATH,
        body: {
          layout: {
            type: "board",
            groupBy: "status",
            cardFields: ["total"],
            widget: { ref: "org/pedido-card", fields: { valor: "total", titulo: "titulo" }, variant: "compact" },
          },
          expectedVersion: 4,
        },
        headers: {},
      },
    ]);
    expect(result).toMatchObject({ baseRef: "crm", widget: { itemId: "item_1", ref: "org/pedido-card" } });
    expectReturnsMatch(BasesViewsCommands, "bind", result);
  });

  it("unbinds with none, sends an item id as itemId, and keeps the rest of the layout", async () => {
    const calls: Call[] = [];
    const deps = bindDeps(calls, {
      type: "gallery",
      coverProp: "capa",
      widget: { itemId: "item_1", ref: "org/pedido-card", fields: { valor: "total" } },
    });

    const { result } = await captureConsole(() =>
      new BasesViewsCommands(deps).bind("crm", "view_1", "none", undefined, undefined, "sales", undefined, true),
    );
    expect(calls[1]?.body).toEqual({
      layout: { type: "gallery", coverProp: "capa", widget: null },
      expectedVersion: 4,
    });
    expect(result).toMatchObject({ widget: null });
    expectReturnsMatch(BasesViewsCommands, "bind", result);

    const itemId = "6f1c2e8a-3b4d-4c5e-8f90-1a2b3c4d5e6f";
    await captureConsole(() =>
      new BasesViewsCommands(deps).bind("crm", "view_1", itemId, undefined, undefined, "sales", undefined, true),
    );
    expect(calls[3]?.body).toMatchObject({ layout: { widget: { itemId } } });
    expect((calls[3]?.body as { layout: { widget: Record<string, unknown> } } | undefined)?.layout.widget).toEqual({
      itemId,
    });
  });

  it("refuses a table layout with exit 2 and never writes", async () => {
    const calls: Call[] = [];
    const deps = bindDeps(calls, { type: "table" });

    const { error, output } = await captureFailure(() =>
      new BasesViewsCommands(deps).bind(
        "crm",
        "view_1",
        "org/pedido-card",
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );
    expect(error).toMatchObject({ code: "PAYLOAD_INVALID", exitCode: 2 });
    expect(JSON.parse(output).error.message).toContain("board, list, gallery or calendar");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("rejects malformed --field and --field with none before any Console call", async () => {
    const calls: Call[] = [];
    const deps = bindDeps(calls, { type: "list" });
    const attempts = [
      () =>
        new BasesViewsCommands(deps).bind(
          "crm",
          "view_1",
          "none",
          ["valor=total"],
          undefined,
          "sales",
          undefined,
          true,
        ),
      () => new BasesViewsCommands(deps).bind("crm", "view_1", "card", ["valor"], undefined, "sales", undefined, true),
      () =>
        new BasesViewsCommands(deps).bind("crm", "view_1", "card", ["a=b", "a=c"], undefined, "sales", undefined, true),
    ];
    for (const attempt of attempts) {
      const { error } = await captureFailure(attempt);
      expect(error).toMatchObject({ code: "PAYLOAD_INVALID", exitCode: 2 });
    }
    expect(calls).toEqual([]);
  });
});

describe("ravi bases through the daemon gateway", () => {
  it("declares --sort and --group-by as one comma-separated string, the value commander forwards", () => {
    const registry = buildRegistry([BasesCommands, BasesRowsCommands, BasesViewsCommands]);
    const options = registry.commands.flatMap((command) =>
      command.options
        .filter((option) => option.name === "sort" || option.name === "groupBy")
        .map((option) => ({ command: command.fullName, option })),
    );

    expect(options.map(({ command, option }) => `${command} ${option.name}`).sort()).toEqual([
      "bases.aggregate groupBy",
      "bases.rows.export sort",
      "bases.rows.query sort",
      "bases.views.query sort",
    ]);
    for (const { option } of options) {
      expect(option.parsed.kind).toBe("required-value");
      expect(option.schema.safeParse("created_time:month,status").success).toBe(true);
    }
  });

  it("parses --sort and --group-by from one comma-separated string or a string array", () => {
    const sort = [
      { prop: "amount", dir: "desc" as const },
      { prop: "created_time", dir: "asc" as const },
    ];
    expect(parseSortOption("amount:desc, created_time")).toEqual(sort);
    expect(parseSortOption(["amount:desc", "created_time"])).toEqual(sort);
    expect(parseSortOption(["amount:desc,created_time"])).toEqual(sort);
    expect(parseSortOption("")).toBeUndefined();
    expect(() => parseSortOption(["a", "b,c", "d"])).toThrow("at most 3");

    const groupBy = [{ prop: "created_time", timeUnit: "month" }, { prop: "status" }];
    expect(parseGroupByOption("created_time:month,status")).toEqual(groupBy);
    expect(parseGroupByOption(["created_time:month", "status"])).toEqual(groupBy);
    expect(() => parseGroupByOption("a,b,c")).toThrow("at most 2");
  });

  it("runs rows query --sort and aggregate --group-by end to end through the gateway dispatcher", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, (call) => {
      if (call.method === "GET") return baseDetail();
      if (call.path.endsWith("/aggregate")) return { groups: [], suppressedGroups: 0, users: {} };
      return { columns: [], rows: [], nextCursor: null, users: {} };
    });

    const query = await dispatchThroughGateway(BasesRowsCommands, "query", deps, {
      base: "crm",
      sort: "amount:desc,created_time",
      project: "sales",
    });
    const aggregate = await dispatchThroughGateway(BasesCommands, "aggregate", deps, {
      base: "crm",
      groupBy: "created_time:month,status",
      agg: ["count", "sum:amount:total"],
      project: "sales",
    });

    expect(query).toMatchObject({ status: 200, body: { success: true, baseRef: "crm" } });
    expect(aggregate).toMatchObject({ status: 200, body: { success: true, groups: [] } });
    expect(calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body])).toEqual([
      [
        `${ROOT}/crm/rows/query`,
        {
          sort: [
            { prop: "amount", dir: "desc" },
            { prop: "created_time", dir: "asc" },
          ],
        },
      ],
      [
        `${ROOT}/crm/rows/aggregate`,
        {
          groupBy: [{ prop: "created_time", timeUnit: "month" }, { prop: "status" }],
          aggregate: [
            { op: "count", as: "count" },
            { op: "sum", prop: "amount", as: "total" },
          ],
        },
      ],
    ]);
  });
});

describe("ravi bases subscribe filters and --trigger", () => {
  function triggerStore(existing: Trigger[] = []) {
    const created: TriggerInput[] = [];
    let refreshes = 0;
    const store: BasesTriggerStore = {
      agentExists: (agentId) => agentId === "triagem",
      list: () => existing,
      create: (input) => {
        created.push(input);
        return {
          id: "trg_1",
          name: input.name,
          agentId: input.agentId,
          topic: input.topic,
          message: input.message,
          session: input.session ?? "main",
          replySession: input.replySession,
          enabled: input.enabled ?? true,
          cooldownMs: input.cooldownMs ?? 5000,
          filter: input.filter,
          fireCount: 0,
          createdAt: 0,
          updatedAt: 0,
        };
      },
      refresh: async () => {
        refreshes += 1;
      },
    };
    return { store, created, refreshes: () => refreshes };
  }

  function subscribeDeps(calls: Call[], inAgentSession: boolean, store: BasesTriggerStore) {
    const deps = makeDeps(calls, () => ({
      ...subscription(),
      viewId: "view_1",
      properties: ["status"],
      events: ["row.created", "approval.requested"],
    }));
    return { ...deps, inAgentSession: () => inAgentSession, triggers: store };
  }

  it("sends the filter and, from the operator's terminal, creates an enabled trigger on the inbox subject", async () => {
    const calls: Call[] = [];
    const triggers = triggerStore();
    const deps = subscribeDeps(calls, false, triggers.store);

    const { result } = await captureConsole(() =>
      runWithContext({}, () =>
        new BasesCommands(deps).subscribe(
          "crm",
          "view_1",
          "status",
          "row.created,bases.approval.requested",
          true,
          "triagem",
          "crm-fila",
          undefined,
          "sales",
          undefined,
          true,
        ),
      ),
    );

    expect(calls).toEqual([
      {
        method: "POST",
        path: `${ROOT}/crm/subscriptions`,
        body: { viewId: "view_1", properties: ["status"], events: ["row.created", "approval.requested"] },
        headers: {},
      },
    ]);
    expect(triggers.created).toHaveLength(1);
    expect(triggers.created[0]).toMatchObject({
      topic: "ravi.console.inbox.item",
      agentId: "triagem",
      session: "crm-fila",
      enabled: true,
      filter:
        'data.category == "bases" && data.payload.baseId == "base_1" && data.payload.subscriptionId == "sub_1" && (data.eventType == "bases.row.created" || data.eventType == "bases.approval.requested")',
    });
    expect(triggers.refreshes()).toBe(1);
    expect(result).toMatchObject({
      filter: { viewId: "view_1", properties: ["status"], events: ["row.created", "approval.requested"] },
      trigger: { id: "trg_1", enabled: true, created: true, draft: false, enableCommand: null },
    });
    expectReturnsMatch(BasesCommands, "subscribe", result);
  });

  it("creates a disabled draft from an agent session and says how the operator turns it on", async () => {
    const triggers = triggerStore();
    const deps = subscribeDeps([], true, triggers.store);

    const { output, result } = await captureConsole(() =>
      runWithContext({ transport: "tool", agentId: "triagem", sessionName: "triagem-main" }, () =>
        new BasesCommands(deps).subscribe(
          "crm",
          undefined,
          undefined,
          "row.created",
          true,
          "triagem",
          undefined,
          "Drene a fila.",
          "sales",
          undefined,
          undefined,
        ),
      ),
    );

    expect(triggers.created[0]).toMatchObject({
      enabled: false,
      session: "triagem-main",
      replySession: "triagem-main",
      message: "Drene a fila.",
    });
    expect(result).toMatchObject({
      trigger: { id: "trg_1", enabled: false, draft: true, enableCommand: "ravi triggers enable trg_1" },
    });
    expect(output).toContain("ravi triggers enable trg_1");
    expect(output).not.toContain("ids and counts only");
  });

  it("reuses the trigger of the same subscription instead of creating a second one", async () => {
    const filter = subscriptionTriggerFilter({
      baseId: "base_1",
      subscriptionId: "sub_1",
      filtered: true,
      events: ["row.created"],
    });
    const existing = { ...triggerStore().store.create({ name: "x", topic: "ravi.console.inbox.item", message: "m" }) };
    const triggers = triggerStore([{ ...existing, id: "trg_old", agentId: "triagem", filter, enabled: true }]);
    const deps = subscribeDeps([], true, triggers.store);

    const { result } = await captureConsole(() =>
      runWithContext({}, () =>
        new BasesCommands(deps).subscribe(
          "crm",
          undefined,
          undefined,
          "row.created",
          true,
          "triagem",
          undefined,
          undefined,
          "sales",
          undefined,
          true,
        ),
      ),
    );

    expect(triggers.created).toEqual([]);
    expect(triggers.refreshes()).toBe(0);
    expect(result).toMatchObject({ trigger: { id: "trg_old", enabled: true, created: false, draft: false } });
  });

  it("keeps an unfiltered subscription's trigger off the items of filtered subscriptions", () => {
    const unfiltered = subscriptionTriggerFilter({ baseId: "base_1", subscriptionId: "sub_all", filtered: false });
    const filtered = subscriptionTriggerFilter({ baseId: "base_1", subscriptionId: "sub_f", filtered: true });
    const item = (payload: Record<string, unknown>) => ({
      category: "bases",
      eventType: "bases.row.updated",
      payload: { baseId: "base_1", rowId: "row_1", ...payload },
    });

    expect(evaluateFilter(unfiltered, item({}))).toBe(true);
    expect(evaluateFilter(unfiltered, item({ subscriptionId: "sub_f" }))).toBe(false);
    expect(evaluateFilter(filtered, item({ subscriptionId: "sub_f" }))).toBe(true);
    expect(evaluateFilter(filtered, item({}))).toBe(false);
    expect(evaluateFilter(filtered, item({ subscriptionId: "sub_f", baseId: "base_2" }))).toBe(false);
  });

  it("rejects bad filters and trigger flags before any Console call", async () => {
    const calls: Call[] = [];
    const deps = subscribeDeps(calls, false, triggerStore().store);
    const attempts: Array<() => Promise<unknown>> = [
      () =>
        new BasesCommands(deps).subscribe(
          "crm",
          undefined,
          undefined,
          "row.deleted",
          undefined,
          undefined,
          undefined,
          undefined,
          "sales",
          undefined,
          true,
        ),
      () =>
        new BasesCommands(deps).subscribe(
          "crm",
          undefined,
          "a b",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "sales",
          undefined,
          true,
        ),
      () =>
        new BasesCommands(deps).subscribe(
          "crm",
          undefined,
          undefined,
          undefined,
          undefined,
          "triagem",
          undefined,
          undefined,
          "sales",
          undefined,
          true,
        ),
      () =>
        new BasesCommands(deps).subscribe(
          "crm",
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          undefined,
          undefined,
          "sales",
          undefined,
          true,
        ),
      () =>
        new BasesCommands(deps).subscribe(
          "crm",
          undefined,
          undefined,
          undefined,
          true,
          "ghost",
          undefined,
          undefined,
          "sales",
          undefined,
          true,
        ),
    ];
    const codes: string[] = [];
    for (const attempt of attempts) {
      const { error } = await captureFailure(attempt);
      codes.push((error as { code: string }).code);
    }
    expect(codes).toEqual(["PAYLOAD_INVALID", "PAYLOAD_INVALID", "PAYLOAD_INVALID", "PAYLOAD_INVALID", "NOT_FOUND"]);
    expect(calls).toEqual([]);
  });
});

describe("ravi bases views share", () => {
  const VIEW_PATH = `${ROOT}/crm/views/view_1`;

  function managerView(access: Record<string, unknown>, version = 3) {
    return {
      id: "view_1",
      baseId: "base_1",
      name: "Pedidos",
      description: null,
      columns: ["titulo", "status", "total"],
      query: { filter: null, sort: [] },
      layout: { type: "table" },
      access,
      position: 0,
      version,
      status: "active",
      valid: true,
      invalidReason: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      capabilities: { read: true, aggregateOnly: false, writeColumns: [], create: true, archive: true, manage: true },
    };
  }

  function shareDeps(calls: Call[], access: Record<string, unknown>, manager = true) {
    return makeDeps(calls, (call) => {
      if (call.method === "GET" && call.path === VIEW_PATH) {
        const view = managerView(access);
        return {
          id: view.id,
          baseId: view.baseId,
          name: view.name,
          description: null,
          layout: view.layout,
          version: view.version,
          columns: [],
          capabilities: view.capabilities,
          valid: true,
          ...(manager ? { view } : {}),
        };
      }
      if (call.method === "GET" && call.path === "/api/cli/projects/sales/pages") {
        return {
          sites: [
            { id: "site_1", slug: "acme-vendas", defaultHostname: "acme-vendas.ravi.page", isDefault: true },
            { site: { id: "site_2", slug: "outro" } },
          ],
        };
      }
      const body = call.body as { access: Record<string, unknown> };
      return managerView(body.access, 4);
    });
  }

  it("adds a page_viewer for the site to read and write at the version it read, and discloses the host", async () => {
    const calls: Call[] = [];
    const access = {
      read: [{ kind: "project_role", minRole: "viewer" }],
      write: {
        principals: [{ kind: "project_role", minRole: "developer" }],
        columns: ["status"],
        create: false,
        archive: false,
        set: {},
      },
    };
    const deps = shareDeps(calls, access);

    const { result } = await captureConsole(() =>
      new BasesViewsCommands(deps).share(
        "crm",
        "view_1",
        "acme-vendas",
        "titulo",
        true,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET ${VIEW_PATH}`,
      "GET /api/cli/projects/sales/pages",
      `PATCH ${VIEW_PATH}`,
    ]);
    expect(calls[2]?.body).toEqual({
      access: {
        read: [
          { kind: "project_role", minRole: "viewer" },
          { kind: "page_viewer", siteId: "site_1" },
        ],
        write: {
          principals: [
            { kind: "project_role", minRole: "developer" },
            { kind: "page_viewer", siteId: "site_1" },
          ],
          columns: ["status", "titulo"],
          create: true,
          archive: false,
          set: {},
        },
      },
      expectedVersion: 3,
    });
    expect(result).toMatchObject({
      changed: true,
      site: { id: "site_1", hostname: "acme-vendas.ravi.page" },
      grants: { read: true, writeColumns: ["status", "titulo"], create: true, archive: false },
    });
    const disclosure = (result as { disclosure: string[] }).disclosure.join("\n");
    expect(disclosure).toContain("acme-vendas.ravi.page");
    expect(disclosure).toContain('"Pedidos"');
    expect(disclosure).toContain("other write principal");
    expectReturnsMatch(BasesViewsCommands, "share", result);
  });

  it("grants a form site only the write side with --write-only", async () => {
    const calls: Call[] = [];
    const deps = shareDeps(calls, { read: [], write: { principals: [], columns: [], create: false, archive: false } });

    const { result } = await captureConsole(() =>
      new BasesViewsCommands(deps).share(
        "crm",
        "view_1",
        "acme-vendas",
        undefined,
        true,
        undefined,
        true,
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls[2]?.body).toEqual({
      access: {
        read: [],
        write: {
          principals: [{ kind: "page_viewer", siteId: "site_1" }],
          columns: [],
          create: true,
          archive: false,
        },
      },
      expectedVersion: 3,
    });
    expect(result).toMatchObject({ changed: true, grants: { read: false, create: true } });
    expect((result as { disclosure: string[] }).disclosure[0]).toContain("without reading its rows");

    const usage = await captureFailure(() =>
      new BasesViewsCommands(shareDeps([], { read: [] })).share(
        "crm",
        "view_1",
        "acme-vendas",
        undefined,
        undefined,
        undefined,
        true,
        "sales",
        undefined,
        true,
      ),
    );
    expect(usage.error).toMatchObject({ code: "PAYLOAD_INVALID" });
  });

  it("does not write when the site already reads the view", async () => {
    const calls: Call[] = [];
    const deps = shareDeps(calls, { read: [{ kind: "page_viewer", siteId: "site_2" }] });

    const { result } = await captureConsole(() =>
      new BasesViewsCommands(deps).share(
        "crm",
        "view_1",
        "site_2",
        undefined,
        undefined,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(result).toMatchObject({ changed: false, grants: { read: true, writeColumns: [] } });
  });

  it("refuses an unknown site and a caller without manage", async () => {
    const unknown = await captureFailure(() =>
      new BasesViewsCommands(shareDeps([], { read: [] })).share(
        "crm",
        "view_1",
        "nope",
        undefined,
        undefined,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );
    expect(unknown.error).toMatchObject({ code: "NOT_FOUND" });

    const calls: Call[] = [];
    const denied = await captureFailure(() =>
      new BasesViewsCommands(shareDeps(calls, { read: [] }, false)).share(
        "crm",
        "view_1",
        "acme-vendas",
        undefined,
        undefined,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );
    expect(denied.error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });
});

describe("ravi bases creates with idempotency keys", () => {
  it("sends a generated key, or the caller's, in the header and the body of every create", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, (call) => {
      if (call.path.endsWith("/properties"))
        return { base: baseSummary(), property: property("ok", "approval"), report: null };
      if (call.path.endsWith("/views")) return { id: "view_1" };
      if (call.path.endsWith("/charts")) return { id: "chart_1" };
      if (call.method === "GET") return baseDetail();
      return baseDetail();
    });

    const created = await captureConsole(() =>
      new BasesCommands(deps).create(
        "CRM",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );
    await captureConsole(() =>
      new BasesViewsCommands(deps).create("crm", undefined, "Fila", "crm:view:fila", "sales", undefined, true),
    );
    await captureConsole(() =>
      new BasesChartsCommands(deps).create(
        "crm",
        '{"mark":"bar","encoding":{}}',
        "view_1",
        "Por status",
        "crm:chart:status",
        "sales",
        undefined,
        true,
      ),
    );
    await captureConsole(() =>
      new BasesPropsCommands(deps).add(
        "crm",
        "Ok",
        "approval",
        "ok",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "role:developer,user:usr_9",
        "total",
        undefined,
        undefined,
        undefined,
        undefined,
        "crm:prop:ok",
        "5",
        "sales",
        undefined,
        true,
      ),
    );

    const posts = calls.filter((call) => call.method === "POST");
    expect(
      posts.map((call) => [
        call.path,
        call.headers["Idempotency-Key"],
        (call.body as { idempotencyKey: string }).idempotencyKey,
      ]),
    ).toEqual([
      [ROOT, "ravi-cli:test-key-0001", "ravi-cli:test-key-0001"],
      [`${ROOT}/crm/views`, "crm:view:fila", "crm:view:fila"],
      [`${ROOT}/crm/charts`, "crm:chart:status", "crm:chart:status"],
      [`${ROOT}/crm/properties`, "crm:prop:ok", "crm:prop:ok"],
    ]);
    expect(posts.every((call) => !("clientHint" in (call.body as object)))).toBe(true);
    expect(posts[3]?.body).toMatchObject({
      type: "approval",
      config: {
        approvers: [
          { kind: "project_role", minRole: "developer" },
          { kind: "user", userId: "usr_9" },
        ],
        resetOn: ["total"],
      },
      expectedSchemaVersion: 5,
    });
    expect(created.result).toMatchObject({ idempotencyKey: "ravi-cli:test-key-0001" });
    expectReturnsMatch(BasesCommands, "create", created.result);
  });
});

describe("ravi bases approval and agent columns", () => {
  function propsAdd(
    deps: BasesTestDeps,
    type: string,
    flags: Partial<
      Record<"approvers" | "resetOn" | "instructions" | "inputs" | "output" | "agent" | "options", string>
    >,
  ) {
    return new BasesPropsCommands(deps).add(
      "crm",
      "Coluna",
      type,
      undefined,
      undefined,
      flags.options,
      undefined,
      undefined,
      undefined,
      flags.approvers,
      flags.resetOn,
      flags.instructions,
      flags.inputs,
      flags.output,
      flags.agent,
      undefined,
      "5",
      "sales",
      undefined,
      true,
    );
  }

  it("adds an agent column with its instructions, inputs, output and options", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({ base: baseSummary(), property: property("resumo", "agent"), report: null }));

    await captureConsole(() =>
      propsAdd(deps, "agent", {
        instructions: "Classifique o pedido.",
        inputs: "titulo,total",
        output: "select",
        options: "Alta,Baixa",
        agent: "triagem",
      }),
    );

    expect(calls[0]?.body).toMatchObject({
      type: "agent",
      config: {
        instructions: "Classifique o pedido.",
        inputs: ["titulo", "total"],
        output: "select",
        options: [{ name: "Alta" }, { name: "Baixa" }],
        agent: "triagem",
      },
    });
  });

  it("rejects typed flags on the wrong type and incomplete configs before any Console call", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({}));
    const attempts = [
      () => propsAdd(deps, "text", { approvers: "role:viewer" }),
      () => propsAdd(deps, "approval", {}),
      () => propsAdd(deps, "approval", { approvers: "role:owner" }),
      () => propsAdd(deps, "agent", { instructions: "x", inputs: "a" }),
      () => propsAdd(deps, "agent", { instructions: "x", inputs: "a", output: "select" }),
      () => propsAdd(deps, "select", { output: "text" }),
    ];
    for (const attempt of attempts) {
      const { error } = await captureFailure(attempt);
      expect(error).toMatchObject({ code: "PAYLOAD_INVALID", exitCode: 2 });
    }
    expect(calls).toEqual([]);
  });

  it("requests an approval at once, at the version it read, with a key", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, (call) =>
      call.method === "GET" ? { row: row(6), users: {} } : { row: row(7), users: {}, idempotentReplay: false },
    );

    const { result } = await captureConsole(() =>
      new BasesRowsCommands(deps).requestApproval(
        "crm",
        "row_1",
        "ok",
        "Conferir total",
        undefined,
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls).toEqual([
      { method: "GET", path: `${ROOT}/crm/rows/row_1`, body: undefined, headers: {} },
      {
        method: "PATCH",
        path: `${ROOT}/crm/rows/row_1`,
        body: {
          values: { ok: { state: "pending", note: "Conferir total" } },
          expectedVersion: 6,
          idempotencyKey: "ravi-cli:test-key-0001",
        },
        headers: { "Idempotency-Key": "ravi-cli:test-key-0001" },
      },
    ]);
    expect(result).toMatchObject({ property: "ok", state: "pending", row: { version: 7 } });
    expectReturnsMatch(BasesRowsCommands, "requestApproval", result);
  });

  it("dry-runs approve and reject without --execute, then decides through a view with --execute", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({ row: row(4), users: {}, idempotentReplay: false }));
    const rows = new BasesRowsCommands(deps);

    for (const attempt of [
      () =>
        rows.approve("crm", "row_1", "ok", undefined, undefined, "3", undefined, "sales", undefined, true, undefined),
      () =>
        rows.reject("crm", "row_1", "ok", "Falta nota", undefined, "3", undefined, "sales", undefined, true, undefined),
    ]) {
      const { error, output } = await captureFailure(attempt);
      expect(error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
      expect(JSON.parse(output).error.plan).toMatchObject({ row: "row_1", property: "ok" });
    }
    expect(calls).toEqual([]);

    const { result } = await captureConsole(() =>
      rows.reject(
        "crm",
        "row_1",
        "ok",
        "Falta nota",
        "view_1",
        "3",
        "crm:row_1:v3:reject",
        "sales",
        undefined,
        true,
        true,
      ),
    );
    expect(calls).toEqual([
      {
        method: "PATCH",
        path: `${ROOT}/crm/views/view_1/rows/row_1`,
        body: {
          values: { ok: { state: "rejected", note: "Falta nota" } },
          expectedVersion: 3,
          idempotencyKey: "crm:row_1:v3:reject",
        },
        headers: { "Idempotency-Key": "crm:row_1:v3:reject" },
      },
    ]);
    expect(result).toMatchObject({ state: "rejected", viewId: "view_1" });
  });

  it("maps approval_forbidden to an access error that names the approvers", async () => {
    const deps = makeDeps([], () => {
      throw new CloudAuthError("PROJECT_ACCESS_DENIED", "Only approvers may decide.", {
        status: 403,
        details: { error: "approval_forbidden" },
      });
    });

    const { error, output } = await captureFailure(() =>
      new BasesRowsCommands(deps).approve(
        "crm",
        "row_1",
        "ok",
        undefined,
        undefined,
        "3",
        undefined,
        "sales",
        undefined,
        true,
        true,
      ),
    );

    expect(error).toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    const envelope = JSON.parse(output);
    expect(envelope.error.consoleError).toBe("approval_forbidden");
    expect(envelope.error.suggestedAction).toContain("approver");
  });

  it("fills an agent cell with a keyed write and parses the value as JSON when it can", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({ row: row(9), users: {}, idempotentReplay: false }));
    const rows = new BasesRowsCommands(deps);

    const { result } = await captureConsole(() =>
      rows.fill(
        "crm",
        "row_1",
        "resumo",
        "0123456789abcdef",
        '["Alta"]',
        undefined,
        "crm:row_1:resumo:0123",
        "sales",
        undefined,
        true,
      ),
    );
    await captureConsole(() =>
      rows.fill(
        "crm",
        "row_1",
        "resumo",
        "0123456789abcdef",
        "texto livre",
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );
    await captureConsole(() =>
      rows.fill(
        "crm",
        "row_1",
        "resumo",
        "0123456789abcdef",
        undefined,
        "Sem dados",
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      [
        "POST",
        `${ROOT}/crm/rows/row_1/agent/resumo`,
        { inputsHash: "0123456789abcdef", value: ["Alta"], idempotencyKey: "crm:row_1:resumo:0123" },
      ],
      [
        "POST",
        `${ROOT}/crm/rows/row_1/agent/resumo`,
        { inputsHash: "0123456789abcdef", value: "texto livre", idempotencyKey: "ravi-cli:test-key-0001" },
      ],
      [
        "POST",
        `${ROOT}/crm/rows/row_1/agent/resumo`,
        { inputsHash: "0123456789abcdef", error: "Sem dados", idempotencyKey: "ravi-cli:test-key-0001" },
      ],
    ]);
    expect(calls[0]?.headers).toEqual({ "Idempotency-Key": "crm:row_1:resumo:0123" });
    expect(result).toMatchObject({ property: "resumo", row: { version: 9 } });
    expectReturnsMatch(BasesRowsCommands, "fill", result);

    for (const attempt of [
      () => rows.fill("crm", "row_1", "resumo", "nothex", "1", undefined, undefined, "sales", undefined, true),
      () => rows.fill("crm", "row_1", "resumo", "0123456789abcdef", "1", "x", undefined, "sales", undefined, true),
      () =>
        rows.fill(
          "crm",
          "row_1",
          "resumo",
          "0123456789abcdef",
          undefined,
          undefined,
          undefined,
          "sales",
          undefined,
          true,
        ),
    ]) {
      expect((await captureFailure(attempt)).error).toMatchObject({ code: "PAYLOAD_INVALID" });
    }
    expect(calls).toHaveLength(3);
  });

  it("surfaces the current inputsHash on agent_stale", async () => {
    const deps = makeDeps([], () => {
      throw new CloudAuthError("CONFLICT", "The inputs changed.", {
        status: 409,
        details: { error: "agent_stale", inputsHash: "fedcba9876543210" },
      });
    });

    const { error, output } = await captureFailure(() =>
      new BasesRowsCommands(deps).fill(
        "crm",
        "row_1",
        "resumo",
        "0123456789abcdef",
        "1",
        undefined,
        undefined,
        "sales",
        undefined,
        true,
      ),
    );

    expect(error).toMatchObject({ code: "CONFLICT", exitCode: 1 });
    expect(JSON.parse(output).error).toMatchObject({ consoleError: "agent_stale", inputsHash: "fedcba9876543210" });
    expect(JSON.parse(output).error.suggestedAction).toContain("--inputs-hash fedcba9876543210");
  });

  it("reruns an agent cell", async () => {
    const calls: Call[] = [];
    const deps = makeDeps(calls, () => ({ row: row(10), users: {}, idempotentReplay: false }));

    const { result } = await captureConsole(() =>
      new BasesRowsCommands(deps).rerun("crm", "row_1", "resumo", "sales", undefined, true),
    );

    expect(calls).toEqual([
      { method: "POST", path: `${ROOT}/crm/rows/row_1/agent/resumo/rerun`, body: {}, headers: {} },
    ]);
    expectReturnsMatch(BasesRowsCommands, "rerun", result);
  });
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

type BasesTestDeps = BasesCommandDeps;

/** Run one command through the SDK gateway dispatcher (Zod validation included) with mocked Console deps. */
async function dispatchThroughGateway(
  target: new (deps: BasesTestDeps) => object,
  method: string,
  deps: BasesTestDeps,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const entry = buildRegistry([target as unknown as new () => object]).commands.find(
    (command) => command.method === method,
  );
  if (!entry) throw new Error(`${target.name}.${method} is missing from the registry`);
  // The gateway builds commands with `new cls()`; bind the mocked Console deps.
  const bound = class extends target {
    constructor() {
      super(deps);
    }
  };
  const contextRecord: ContextRecord = {
    contextId: "ctx_bases_gateway",
    contextKey: "rctx_bases_gateway",
    kind: "test-runtime",
    agentId: "bases-agent",
    capabilities: [
      { permission: "read", objectType: "bases", objectId: "*", source: "test" },
      { permission: "read", objectType: "bases.rows", objectId: "*", source: "test" },
      { permission: "read", objectType: "bases.views", objectId: "*", source: "test" },
      { permission: "mutate", objectType: "bases.rows", objectId: "*", source: "test" },
    ],
    metadata: { authorityMode: "delegated" },
    createdAt: Date.now(),
  };
  const result = await dispatch({ ...entry, cls: bound }, body, {}, { contextRecord, emitAudit: () => undefined });
  return { status: result.response.status, body: await result.response.json() };
}

function makeDeps(
  calls: Call[],
  handler: (call: Call) => unknown,
  credentialOverrides: Partial<CloudCredentials> = {},
) {
  const client = {
    requestJson: mock(
      async (method: string, path: string, body: unknown, _token: string, headers: Record<string, string> = {}) => {
        const call = { method, path, body, headers };
        calls.push(call);
        return handler(call);
      },
    ),
  } as unknown as ConsoleApiClient;
  return {
    client,
    readCredentials: () => ({ ...makeCredentials(), ...credentialOverrides }),
    newIdempotencyKey: () => "ravi-cli:test-key-0001",
    clientHint: () => null,
    getContext: () => undefined,
    env: {},
  };
}

function expectReturnsMatch(target: Function, method: string, value: unknown) {
  const schema = getReturnsMetadata(target).get(method);
  expect(schema).toBeDefined();
  const parsed = schema?.safeParse(value);
  if (!parsed?.success) throw new Error(`${target.name}.${method} return failed: ${parsed?.error.message}`);
}

async function captureFailure(run: () => Promise<unknown>): Promise<{ error: unknown; output: string }> {
  let failure: unknown;
  const { output } = await captureConsole(async () => {
    try {
      await run();
    } catch (error) {
      failure = error;
    }
  });
  if (failure === undefined) throw new Error("expected the command to fail");
  return { error: failure, output };
}

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const originalError = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  console.error = () => undefined;
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** `props add` flags --approvers .. --idempotency-key, all unset. */
function noTypedPropertyFlags(): [undefined, undefined, undefined, undefined, undefined, undefined, undefined] {
  return [undefined, undefined, undefined, undefined, undefined, undefined, undefined];
}

/** `subscribe` flags --view .. --message, all unset. */
function noSubscribeFilter(): [undefined, undefined, undefined, undefined, undefined, undefined, undefined] {
  return [undefined, undefined, undefined, undefined, undefined, undefined, undefined];
}

function row(version: number, rowId = "row_1") {
  return { rowId, version, values: { title: "Acme" } };
}

function property(key: string, type: string) {
  return {
    id: `prop_${key}`,
    key,
    name: key === "name" ? "Deal Name" : key,
    description: null,
    type,
    config: {},
    position: 0,
    required: false,
    deletedAt: null,
  };
}

function baseSummary() {
  return {
    id: "base_1",
    organizationId: "org_1",
    projectId: "proj_1",
    slug: "crm",
    name: "CRM",
    description: null,
    icon: null,
    timezone: "UTC",
    schemaVersion: 5,
    version: 3,
    status: "active",
    rowCount: 12,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    capabilities: { manage: true, readDirect: true, writeDirect: true },
  };
}

function baseDetail() {
  return {
    ...baseSummary(),
    properties: [property("name", "text"), property("amount", "number")],
    views: [],
    charts: [],
    members: [],
  };
}

function subscription() {
  return {
    id: "sub_1",
    baseId: "base_1",
    localInstallationId: "ins_123",
    installationName: null,
    userId: "usr_1",
    status: "active",
    createdAt: "2026-10-06T00:00:00.000Z",
    revokedAt: null,
  };
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
    scopes: ["console.projects.read", "console.bases.read", "console.bases.write"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
