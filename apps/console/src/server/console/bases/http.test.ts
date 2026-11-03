import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { projectMoveProjectScopedTables } from "@/server/admin/projects";
import { BASES_ACTION_IDS } from "@/shared/bases/api";

import { basesSystemCaller } from "./context";
import { handleBasesRequest, matchBasesRoute, stripClientHint } from "./http";

const ID = "0e0e0e0e-0000-4000-8000-000000000001";
const ID2 = "0e0e0e0e-0000-4000-8000-000000000002";

// Every row of the table in src/shared/bases/api.ts.
const ROUTES: Array<[string, string[]]> = [
  ["GET", []],
  ["POST", []],
  ["GET", ["crm"]],
  ["GET", ["crm", "activity"]],
  ["PATCH", ["crm"]],
  ["POST", ["crm", "archive"]],
  ["POST", ["crm", "restore"]],
  ["POST", ["crm", "properties"]],
  ["PATCH", ["crm", "properties", "stage"]],
  ["POST", ["crm", "properties", ID, "delete"]],
  ["POST", ["crm", "properties", "stage", "restore"]],
  ["POST", ["crm", "rows", "query"]],
  ["POST", ["crm", "rows", "aggregate"]],
  ["POST", ["crm", "rows"]],
  ["GET", ["crm", "rows", ID]],
  ["PATCH", ["crm", "rows", ID]],
  ["POST", ["crm", "rows", ID, "archive"]],
  ["POST", ["crm", "rows", ID, "restore"]],
  ["POST", ["crm", "rows", ID, "purge"]],
  ["GET", ["crm", "rows", ID, "history"]],
  ["POST", ["crm", "rows", ID, "agent", "summary"]],
  ["POST", ["crm", "rows", ID, "agent", "summary", "rerun"]],
  ["GET", ["crm", "views"]],
  ["POST", ["crm", "views"]],
  ["GET", ["crm", "views", ID]],
  ["PATCH", ["crm", "views", ID]],
  ["POST", ["crm", "views", ID, "archive"]],
  ["POST", ["crm", "views", ID, "query"]],
  ["POST", ["crm", "views", ID, "version"]],
  ["POST", ["crm", "views", ID, "rows"]],
  ["GET", ["crm", "views", ID, "rows", ID2]],
  ["PATCH", ["crm", "views", ID, "rows", ID2]],
  ["POST", ["crm", "views", ID, "rows", ID2, "archive"]],
  ["GET", ["crm", "views", ID, "rows", ID2, "history"]],
  ["GET", ["crm", "charts"]],
  ["POST", ["crm", "charts"]],
  ["GET", ["crm", "charts", ID]],
  ["PATCH", ["crm", "charts", ID]],
  ["POST", ["crm", "charts", ID, "archive"]],
  ["POST", ["crm", "charts", ID, "data"]],
  ["GET", ["crm", "subscriptions"]],
  ["POST", ["crm", "subscriptions"]],
  ["POST", ["crm", "subscriptions", ID, "revoke"]],
];

describe("routing", () => {
  test("covers every route of the API table", () => {
    expect(ROUTES.length).toBe(BASES_ACTION_IDS.length);
    for (const [method, segments] of ROUTES) {
      expect(matchBasesRoute(method, segments)).not.toBeNull();
    }
  });

  test("captures the base ref and ids", () => {
    const match = matchBasesRoute("PATCH", ["crm", "views", ID.toUpperCase(), "rows", ID2]);
    expect(match?.baseRef).toBe("crm");
    expect(match?.params).toEqual([ID, ID2]);
    expect(matchBasesRoute("PATCH", ["crm", "properties", "stage"])?.params).toEqual(["stage"]);
  });

  test("unknown paths, wrong methods, and non-uuid ids do not match", () => {
    expect(matchBasesRoute("DELETE", ["crm"])).toBeNull();
    expect(matchBasesRoute("GET", ["crm", "rows", "query"])).toBeNull();
    expect(matchBasesRoute("GET", ["crm", "rows", "not-a-uuid"])).toBeNull();
    expect(matchBasesRoute("POST", ["crm", "views", ID, "rows", ID2, "purge"])).toBeNull();
    expect(matchBasesRoute("GET", ["crm", "sql"])).toBeNull();
    expect(matchBasesRoute("POST", ["crm", "rows", "sql"])).toBeNull();
  });

  test("unknown paths are 404 not_found before any lookup", async () => {
    const promise = handleBasesRequest({
      caller: basesSystemCaller(ID, "req"),
      workspace: null,
      method: "GET",
      projectRef: "web",
      segments: ["crm", "unknown"],
      body: {},
      searchParams: new URLSearchParams(),
      idempotencyKey: null,
    });
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).status).toBe(404);
    expect((error as ConsoleApiError).payload).toEqual({ error: "not_found" });
  });

  test("strips the untrusted clientHint from bodies", () => {
    expect(stripClientHint({ values: { a: 1 }, clientHint: { agentId: "x" } })).toEqual({ values: { a: 1 } });
    expect(stripClientHint({ values: {} })).toEqual({ values: {} });
    expect(stripClientHint([1])).toEqual([1]);
    expect(stripClientHint(null)).toBeNull();
  });
});

describe("storage", () => {
  test("every bases table with project_id is in the admin project-move list", () => {
    for (const table of [
      "bases",
      "base_properties",
      "base_rows",
      "base_row_ledger",
      "base_views",
      "base_charts",
      "base_operations",
      "base_subscriptions",
    ]) {
      expect(projectMoveProjectScopedTables as readonly string[]).toContain(table);
    }
  });
});
