import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  listOperationsForActor,
  PAGES_SHIP_OPERATION_ID,
  type OperationDefinition,
  type OperationRunResult,
} from "@/server/console/operations";

import {
  callConsoleMcpTool,
  canonicalInputHash,
  CONSOLE_MCP_CONFIRMATION_TTL_MS,
  CONSOLE_MCP_SCOPES,
  handleConsoleToolsCallRequest,
  handleConsoleToolsListRequest,
  listConsoleMcpTools,
  signConfirmationToken,
  type ConsoleMcpCaller,
  type ConsoleMcpToolsDeps,
} from "./console-tools";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BRIDGE = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-18T12:00:00Z");
const KEYS = { current: { id: "k2", key: "current-secret-key" }, previous: { id: "k1", key: "previous-secret-key" } };

const READ_OP = definition({ id: "ravi.bases.views.query", class: "read" });
const WRITE_OP = definition({ id: "ravi.bases.views.rows.create", class: "write" });
const DESTRUCTIVE_OP = definition({ id: "ravi.bases.views.rows.archive", class: "destructive" });
const PAGE_CHAT_ONLY = definition({ id: "ravi.knowledge.search", class: "read", surfaces: ["page_chat"] });

function definition(input: {
  id: string;
  class: OperationDefinition["class"];
  surfaces?: OperationDefinition["surfaces"];
}): OperationDefinition {
  return {
    id: input.id,
    title: `Title ${input.id}`,
    description: `Does ${input.id}`,
    class: input.class,
    needsConfirmation: input.class !== "read",
    surfaces: input.surfaces ?? ["page_chat", "mcp"],
    guests: false,
    inputSchema: () => ({
      type: "object",
      additionalProperties: false,
      required: ["project", "viewId"],
      properties: { project: { type: "string" }, viewId: { type: "string" }, values: { type: "object" } },
    }),
  };
}

function caller(scopes: string[] = [CONSOLE_MCP_SCOPES.read, CONSOLE_MCP_SCOPES.write]): ConsoleMcpCaller {
  return { organizationId: ORG, userId: USER, bridgeId: BRIDGE, scopes, requestId: "req_1" };
}

function makeDeps(overrides: Partial<ConsoleMcpToolsDeps> = {}) {
  const runs: Array<Parameters<NonNullable<ConsoleMcpToolsDeps["runOperation"]>>[0]> = [];
  const memberLookups: unknown[] = [];
  const deps: ConsoleMcpToolsDeps = {
    loadMember: async (input) => {
      memberLookups.push(input);
      return { orgRole: "developer", email: "ana@example.com" };
    },
    listOperations: () => [READ_OP, WRITE_OP, DESTRUCTIVE_OP, PAGE_CHAT_ONLY],
    runOperation: async (input): Promise<OperationRunResult> => {
      runs.push(input);
      return { id: input.id, class: input.id === WRITE_OP.id ? "write" : "read", output: { ok: true, id: input.id } };
    },
    describeChange: (_id, input) => [{ label: "viewId", value: String((input as { viewId?: string }).viewId) }],
    validateWriteInput: () => {},
    confirmationKeys: () => KEYS,
    now: () => NOW,
    randomId: () => "tok_1",
    ...overrides,
  };
  return { deps, runs, memberLookups };
}

describe("Console MCP tools/list", () => {
  test("lists MCP reads and writes with annotations, never destructive or page-chat-only operations", async () => {
    const { deps, memberLookups } = makeDeps();
    const { tools } = await listConsoleMcpTools(caller(), deps);

    expect(tools.map((tool) => tool.operationId)).toEqual([READ_OP.id, WRITE_OP.id]);
    expect(memberLookups).toEqual([{ organizationId: ORG, userId: USER, bridgeId: BRIDGE, tokenId: null,
      scopes: [CONSOLE_MCP_SCOPES.read, CONSOLE_MCP_SCOPES.write] }]);

    const [read, write] = tools;
    expect(read!.annotations).toEqual({
      title: READ_OP.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(read!.inputSchema.properties).not.toHaveProperty("confirmationToken");

    expect(write!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(write!.inputSchema.properties).toHaveProperty("confirmationToken");
    expect(write!.inputSchema.required).toEqual(["project", "viewId"]);
    expect(write!.description).toContain("Show that preview to the person");
  });

  test("hides writes without the write scope and refuses without the read scope", async () => {
    const { deps } = makeDeps();
    const readOnly = await listConsoleMcpTools(caller([CONSOLE_MCP_SCOPES.read]), deps);
    expect(readOnly.tools.map((tool) => tool.operationId)).toEqual([READ_OP.id]);

    await expect(listConsoleMcpTools(caller(["mcp.bridge.tools.read"]), deps)).rejects.toMatchObject({
      status: 403,
      payload: { error: "scope_required", reason: CONSOLE_MCP_SCOPES.read },
    });
  });

  test("refuses when the membership or bridge is no longer active", async () => {
    const { deps } = makeDeps({ loadMember: async () => null });
    await expect(listConsoleMcpTools(caller(), deps)).rejects.toMatchObject({
      status: 403,
      payload: { error: "mcp_access_revoked" },
    });
  });
});

describe("Console MCP tools/call", () => {
  test("runs a read at once as the member, with the role read from the Console", async () => {
    const { deps, runs } = makeDeps();
    const result = await callConsoleMcpTool(
      caller([CONSOLE_MCP_SCOPES.read]),
      { operationId: READ_OP.id, arguments: { project: "demo", viewId: "v1" } },
      deps,
    );

    expect(result).toEqual({ status: "ok", operationId: READ_OP.id, class: "read", output: { ok: true, id: READ_OP.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.confirmed).toBeUndefined();
    expect(runs[0]!.actor).toEqual({
      kind: "member",
      organizationId: ORG,
      userId: USER,
      email: "ana@example.com",
      orgRole: "developer",
      surface: "mcp",
      requestId: "req_1",
      site: null,
      pagesSessionId: null,
    });
  });

  test("a write without a token returns a preview and a token, and runs nothing", async () => {
    const { deps, runs } = makeDeps();
    const result = await callConsoleMcpTool(
      caller(),
      { operationId: WRITE_OP.id, arguments: { project: "demo", viewId: "v1", values: { name: "Ana" } } },
      deps,
    );

    expect(runs).toHaveLength(0);
    expect(result.status).toBe("confirmation_required");
    if (result.status !== "confirmation_required") throw new Error("expected a preview");
    expect(result.changes).toEqual([{ label: "viewId", value: "v1" }]);
    expect(result.expiresAt).toBe(new Date(NOW + CONSOLE_MCP_CONFIRMATION_TTL_MS).toISOString());
    expect(result.confirmationToken.startsWith("rmc1.")).toBe(true);
    expect(result.summary).toContain("Nothing has changed yet");
  });

  test("the same input (any key order) plus the token runs the write once confirmed, seeded by the token id", async () => {
    const { deps, runs } = makeDeps();
    const preview = await callConsoleMcpTool(
      caller(),
      { operationId: WRITE_OP.id, arguments: { project: "demo", viewId: "v1", values: { a: 1, b: 2 } } },
      deps,
    );
    if (preview.status !== "confirmation_required") throw new Error("expected a preview");

    const result = await callConsoleMcpTool(
      caller(),
      {
        operationId: WRITE_OP.id,
        arguments: { values: { b: 2, a: 1 }, viewId: "v1", project: "demo", confirmationToken: preview.confirmationToken },
      },
      deps,
    );

    expect(result.status).toBe("ok");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: WRITE_OP.id,
      confirmed: true,
      idempotencySeed: "tok_1",
      input: { values: { b: 2, a: 1 }, viewId: "v1", project: "demo" },
    });
    expect(runs[0]!.input).not.toHaveProperty("confirmationToken");
  });

  test("a token for other input, another person, a forged signature or past its expiry never runs", async () => {
    const { deps, runs } = makeDeps();
    const args = { project: "demo", viewId: "v1", values: { name: "Ana" } };
    const preview = await callConsoleMcpTool(caller(), { operationId: WRITE_OP.id, arguments: args }, deps);
    if (preview.status !== "confirmation_required") throw new Error("expected a preview");
    const token = preview.confirmationToken;

    await expect(
      callConsoleMcpTool(
        caller(),
        { operationId: WRITE_OP.id, arguments: { ...args, values: { name: "Bob" }, confirmationToken: token } },
        deps,
      ),
    ).rejects.toMatchObject({ status: 409, payload: { error: "confirmation_invalid" } });

    await expect(
      callConsoleMcpTool(
        { ...caller(), userId: "44444444-4444-4444-8444-444444444444" },
        { operationId: WRITE_OP.id, arguments: { ...args, confirmationToken: token } },
        deps,
      ),
    ).rejects.toMatchObject({ status: 409, payload: { error: "confirmation_invalid" } });

    const forged = `${token.slice(0, token.lastIndexOf("."))}.AAAA`;
    await expect(
      callConsoleMcpTool(caller(), { operationId: WRITE_OP.id, arguments: { ...args, confirmationToken: forged } }, deps),
    ).rejects.toMatchObject({ status: 409, payload: { error: "confirmation_invalid" } });

    const later = makeDeps({ now: () => NOW + CONSOLE_MCP_CONFIRMATION_TTL_MS + 1 });
    await expect(
      callConsoleMcpTool(caller(), { operationId: WRITE_OP.id, arguments: { ...args, confirmationToken: token } }, later.deps),
    ).rejects.toMatchObject({ status: 409, payload: { error: "confirmation_expired" } });

    expect(runs).toHaveLength(0);
    expect(later.runs).toHaveLength(0);
  });

  test("accepts a token signed with the previous key during a key rotation", async () => {
    const { deps, runs } = makeDeps();
    const args = { project: "demo", viewId: "v1" };
    const token = signConfirmationToken(
      {
        userId: USER,
        organizationId: ORG,
        operationId: WRITE_OP.id,
        inputHash: canonicalInputHash(args),
        tokenId: "tok_old",
        expiresAtMs: NOW + 60_000,
      },
      { current: KEYS.previous },
    );
    const result = await callConsoleMcpTool(caller(), { operationId: WRITE_OP.id, arguments: { ...args, confirmationToken: token } }, deps);
    expect(result.status).toBe("ok");
    expect(runs[0]!.idempotencySeed).toBe("tok_old");
  });

  test("a write needs the write scope even with a valid preview flow", async () => {
    const { deps, runs } = makeDeps();
    await expect(
      callConsoleMcpTool(caller([CONSOLE_MCP_SCOPES.read]), { operationId: WRITE_OP.id, arguments: { project: "demo" } }, deps),
    ).rejects.toMatchObject({ status: 403, payload: { error: "scope_required", reason: CONSOLE_MCP_SCOPES.write } });
    expect(runs).toHaveLength(0);
  });

  test("invalid write input is refused before a preview is issued", async () => {
    const { deps } = makeDeps({
      validateWriteInput: () => {
        throw new ConsoleApiError(400, { error: "payload_invalid", fieldErrors: { viewId: "Required" } });
      },
    });
    await expect(
      callConsoleMcpTool(caller(), { operationId: WRITE_OP.id, arguments: { project: "demo" } }, deps),
    ).rejects.toMatchObject({ status: 400, payload: { error: "payload_invalid", fieldErrors: { viewId: "Required" } } });
  });

  test("destructive, page-chat-only and unknown operations are not found", async () => {
    const { deps, runs } = makeDeps();
    for (const operationId of [DESTRUCTIVE_OP.id, PAGE_CHAT_ONLY.id, "ravi.pages.publish"]) {
      await expect(callConsoleMcpTool(caller(), { operationId, arguments: {} }, deps)).rejects.toMatchObject({
        status: 404,
        payload: { error: "operation_not_found" },
      });
    }
    expect(runs).toHaveLength(0);
  });

  test("a write without configured signing keys is unavailable, not run", async () => {
    const { deps, runs } = makeDeps({ confirmationKeys: () => null });
    await expect(
      callConsoleMcpTool(caller(), { operationId: WRITE_OP.id, arguments: { project: "demo" } }, deps),
    ).rejects.toMatchObject({ status: 503, payload: { error: "operation_unavailable" } });
    expect(runs).toHaveLength(0);
  });
});

describe("Console MCP ravi.pages.ship", () => {
  test("is listed with the write scope and previews a publish without running it", async () => {
    const { deps, runs } = makeDeps({ listOperations: listOperationsForActor, describeChange: undefined, validateWriteInput: undefined });
    const { tools } = await listConsoleMcpTools(caller(), deps);
    const ship = tools.find((tool) => tool.operationId === PAGES_SHIP_OPERATION_ID)!;
    expect(ship.needsConfirmation).toBe(true);
    expect(ship.inputSchema.properties).toHaveProperty("confirmationToken");
    expect(ship.description).toContain("Show that preview to the person");
    const readOnly = await listConsoleMcpTools(caller([CONSOLE_MCP_SCOPES.read]), deps);
    expect(readOnly.tools.some((tool) => tool.operationId === PAGES_SHIP_OPERATION_ID)).toBe(false);

    const preview = await callConsoleMcpTool(
      caller(),
      { operationId: PAGES_SHIP_OPERATION_ID, arguments: { project: "prs", title: "Teste", body: "<h1>Oi</h1>", route: "/teste" } },
      deps,
    );
    expect(preview.status).toBe("confirmation_required");
    if (preview.status !== "confirmation_required") throw new Error("expected a preview");
    expect(preview.changes).toContainEqual({ label: "rota", value: "/teste (substitui o que essa rota mostra hoje)" });
    expect(preview.changes).toContainEqual({ label: "visibilidade", value: "privada (só membros com acesso)" });
    expect(runs).toEqual([]);
  });

  test("bad input is refused at the preview, before any token", async () => {
    const { deps, runs } = makeDeps({ listOperations: listOperationsForActor, describeChange: undefined, validateWriteInput: undefined });
    await expect(
      callConsoleMcpTool(
        caller(),
        { operationId: PAGES_SHIP_OPERATION_ID, arguments: { project: "prs", title: "T", body: "x", html: "<html></html>" } },
        deps,
      ),
    ).rejects.toMatchObject({ status: 400, payload: { error: "payload_invalid", fieldErrors: { body: expect.any(String) } } });
    await expect(
      callConsoleMcpTool(caller(), { operationId: PAGES_SHIP_OPERATION_ID, arguments: { project: "prs", title: "T", body: "x", visibility: "password" } }, deps),
    ).rejects.toMatchObject({ status: 400, payload: { error: "payload_invalid" } });
    expect(runs).toEqual([]);
  });
});

describe("Console MCP internal routes", () => {
  const hmacConfig = { currentId: "worker-k1", currentKey: "worker-hmac-secret" };

  function signedRequest(path: string, body: unknown, key = hmacConfig.currentKey) {
    const bodyText = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signingString = [timestamp, "POST", path, createHash("sha256").update(bodyText).digest("hex")].join("\n");
    return new Request(`https://console.ravi.bot${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_route",
        "x-ravi-hmac-timestamp": timestamp,
        "x-ravi-hmac-key-id": hmacConfig.currentId,
        "x-ravi-hmac-signature": createHmac("sha256", key).update(signingString).digest("base64"),
      },
      body: bodyText,
    });
  }

  const callerBody = { organizationId: ORG, userId: USER, bridgeId: BRIDGE, scopes: [CONSOLE_MCP_SCOPES.read] };

  test("tools/list answers a correctly signed Worker request", async () => {
    const { deps } = makeDeps();
    const response = await handleConsoleToolsListRequest(
      signedRequest("/api/internal/mcp/console/tools/list", callerBody),
      { ...deps, hmacConfig },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req_route");
    const body = (await response.json()) as { tools: Array<{ operationId: string }> };
    expect(body.tools.map((tool) => tool.operationId)).toEqual([READ_OP.id]);
  });

  test("rejects a bad signature and a body signed for another path", async () => {
    const { deps, memberLookups } = makeDeps();
    const forged = await handleConsoleToolsListRequest(
      signedRequest("/api/internal/mcp/console/tools/list", callerBody, "wrong-key"),
      { ...deps, hmacConfig },
    );
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: "mcp_unauthorized" });

    const request = signedRequest("/api/internal/mcp/console/tools/list", callerBody);
    const moved = new Request("https://console.ravi.bot/api/internal/mcp/console/tools/call", {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(callerBody),
    });
    expect((await handleConsoleToolsCallRequest(moved, { ...deps, hmacConfig })).status).toBe(401);
    expect(memberLookups).toHaveLength(0);
  });

  test("tools/call maps registry errors to their status and code", async () => {
    const { deps } = makeDeps({
      runOperation: async () => {
        throw new ConsoleApiError(403, { error: "operation_forbidden" });
      },
    });
    const response = await handleConsoleToolsCallRequest(
      signedRequest("/api/internal/mcp/console/tools/call", {
        ...callerBody,
        operationId: READ_OP.id,
        arguments: { project: "demo", viewId: "v1" },
      }),
      { ...deps, hmacConfig },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "operation_forbidden" });
  });

  test("rejects a body without the resolved identity", async () => {
    const { deps } = makeDeps();
    const response = await handleConsoleToolsCallRequest(
      signedRequest("/api/internal/mcp/console/tools/call", { operationId: READ_OP.id, scopes: [] }),
      { ...deps, hmacConfig },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "payload_invalid" });
  });
});

describe("Console MCP tools through a cloud run token", () => {
  const RUN = "44444444-4444-4444-8444-444444444444";
  const TOKEN = "55555555-5555-4555-8555-555555555555";
  const START_OP = definition({ id: "ravi.cloud_agents.runs.start", class: "write" });
  const PROJECT = { id: "66666666-6666-4666-8666-666666666666", slug: "demo" };

  function cloudDeps(writes: "ask" | "auto", approvals: Array<{ id: string; toolName: string; inputHash: string }> = []) {
    const resolved: unknown[] = [];
    const consumed: unknown[] = [];
    const base = makeDeps({
      loadMember: async () => ({ orgRole: "developer", email: "ana@example.com", cloudBridge: true }),
      listOperations: () => [READ_OP, WRITE_OP, START_OP],
      resolveCloudRun: async (input) => {
        resolved.push(input);
        return { bridgeId: BRIDGE, project: PROJECT, runs: [{ id: RUN, writes }] };
      },
      consumeCloudApproval: async (input) => {
        consumed.push(input);
        const index = approvals.findIndex((approval) => input.toolNames.includes(approval.toolName) && approval.inputHash === input.inputHash);
        if (index < 0) return null;
        const [approval] = approvals.splice(index, 1);
        return { id: approval!.id, runId: RUN };
      },
    });
    return { ...base, resolved, consumed };
  }

  const cloudCaller = (): ConsoleMcpCaller => ({ ...caller(), tokenId: TOKEN });

  test("lists writes without the confirmation step and never the run start", async () => {
    const { deps } = cloudDeps("ask");
    const { tools } = await listConsoleMcpTools(cloudCaller(), deps);
    expect(tools.map((tool) => tool.operationId)).toEqual([READ_OP.id, WRITE_OP.id]);
    const write = tools[1]!;
    expect(Object.keys(write.inputSchema.properties as Record<string, unknown>)).not.toContain("confirmationToken");
    expect(write.description).toContain("approves the call in the Ravi Console");
  });

  test("a write runs once against the person's approval of the same tool and input", async () => {
    const args = { project: "demo", viewId: "v1", values: { title: "Hi" } };
    const { deps, runs, resolved, consumed } = cloudDeps("ask", [
      { id: "appr_1", toolName: "ravi_bases_views_rows_create", inputHash: canonicalInputHash(args) },
    ]);
    const result = await callConsoleMcpTool(cloudCaller(), { operationId: WRITE_OP.id, arguments: { values: { title: "Hi" }, viewId: "v1", project: "demo" } }, deps);
    expect(result.status).toBe("ok");
    expect(resolved).toEqual([{ organizationId: ORG, userId: USER, bridgeId: BRIDGE, tokenId: TOKEN }]);
    expect(consumed).toEqual([
      { runIds: [RUN], toolNames: ["ravi_bases_views_rows_create", WRITE_OP.id], inputHash: canonicalInputHash(args), now: new Date(NOW) },
    ]);
    expect(runs).toEqual([{ id: WRITE_OP.id, actor: expect.anything(), input: args, confirmed: true, idempotencySeed: "cloud:appr_1" }]);

    // Consumed once: the same call again is refused.
    const again = await callConsoleMcpTool(cloudCaller(), { operationId: WRITE_OP.id, arguments: args }, deps).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(ConsoleApiError);
    expect((again as ConsoleApiError).status).toBe(403);
    expect((again as ConsoleApiError).payload.error).toBe("cloud_run_write_not_approved");
    expect(runs).toHaveLength(1);
  });

  test("a write with other input than the approved one, or a confirmation token, never runs", async () => {
    const approved = { project: "demo", viewId: "v1", values: { title: "Hi" } };
    const { deps, runs } = cloudDeps("ask", [{ id: "appr_1", toolName: "ravi_bases_views_rows_create", inputHash: canonicalInputHash(approved) }]);
    const other = await callConsoleMcpTool(cloudCaller(), { operationId: WRITE_OP.id, arguments: { ...approved, values: { title: "Bye" } } }, deps).catch(
      (error: unknown) => error,
    );
    expect((other as ConsoleApiError).payload.error).toBe("cloud_run_write_not_approved");
    const forged = signConfirmationToken(
      { userId: USER, organizationId: ORG, operationId: WRITE_OP.id, inputHash: canonicalInputHash({ ...approved, viewId: "v2" }), tokenId: "t", expiresAtMs: NOW + 1000 },
      KEYS,
    );
    const withToken = await callConsoleMcpTool(
      cloudCaller(),
      { operationId: WRITE_OP.id, arguments: { ...approved, viewId: "v2", confirmationToken: forged } },
      deps,
    ).catch((error: unknown) => error);
    expect((withToken as ConsoleApiError).payload.error).toBe("cloud_run_write_not_approved");
    expect(runs).toHaveLength(0);
  });

  test("an agent with automatic writes runs a write without an approval row", async () => {
    const { deps, runs, consumed } = cloudDeps("auto");
    const result = await callConsoleMcpTool(cloudCaller(), { operationId: WRITE_OP.id, arguments: { project: "demo", viewId: "v1" } }, deps);
    expect(result.status).toBe("ok");
    expect(consumed).toHaveLength(0);
    expect(runs[0]).toMatchObject({ confirmed: true, idempotencySeed: "cloud:req_1" });
  });

  test("a run never starts another run, and a token with no active run does nothing, reads included", async () => {
    const { deps, runs } = cloudDeps("auto");
    const start = await callConsoleMcpTool(cloudCaller(), { operationId: START_OP.id, arguments: { project: "demo", viewId: "v1" } }, deps).catch(
      (error: unknown) => error,
    );
    expect((start as ConsoleApiError).status).toBe(403);
    expect((start as ConsoleApiError).payload.error).toBe("operation_forbidden");

    for (const ended of [
      { ...deps, resolveCloudRun: async () => ({ bridgeId: BRIDGE, project: PROJECT, runs: [] }) },
      { ...deps, resolveCloudRun: async () => null },
    ]) {
      for (const operationId of [WRITE_OP.id, READ_OP.id]) {
        const refused = await callConsoleMcpTool(cloudCaller(), { operationId, arguments: { project: "demo", viewId: "v1" } }, ended).catch(
          (error: unknown) => error,
        );
        expect((refused as ConsoleApiError).status).toBe(403);
        expect((refused as ConsoleApiError).payload.error).toBe("cloud_run_not_active");
      }
    }
    expect(runs).toHaveLength(0);
  });

  test("a run token works only in its run's project, by slug or id", async () => {
    const { deps, runs } = cloudDeps("auto");
    for (const project of ["other-project", "77777777-7777-4777-8777-777777777777", 42]) {
      for (const operationId of [READ_OP.id, WRITE_OP.id]) {
        const refused = await callConsoleMcpTool(cloudCaller(), { operationId, arguments: { project, viewId: "v1" } }, deps).catch(
          (error: unknown) => error,
        );
        expect((refused as ConsoleApiError).payload).toMatchObject({ error: "operation_forbidden", reason: expect.stringContaining("demo") });
      }
    }
    const projectRef = await callConsoleMcpTool(cloudCaller(), { operationId: READ_OP.id, arguments: { projectRef: "elsewhere" } }, deps).catch(
      (error: unknown) => error,
    );
    expect((projectRef as ConsoleApiError).payload.error).toBe("operation_forbidden");
    expect(runs).toHaveLength(0);

    expect((await callConsoleMcpTool(cloudCaller(), { operationId: READ_OP.id, arguments: { project: "DEMO", viewId: "v1" } }, deps)).status).toBe("ok");
    expect((await callConsoleMcpTool(cloudCaller(), { operationId: READ_OP.id, arguments: { project: PROJECT.id, viewId: "v1" } }, deps)).status).toBe("ok");
    expect(runs).toHaveLength(2);
    // The registry gets the run's project and keeps every id or URL inside it.
    expect(runs.map((run) => (run as { actor: { boundProjectId?: string } }).actor.boundProjectId)).toEqual([PROJECT.id, PROJECT.id]);
  });

  test("the Worker's token id reaches the run lookup", async () => {
    const hmacConfig = { currentId: "worker-k1", currentKey: "worker-hmac-secret" };
    const body = {
      organizationId: ORG,
      userId: USER,
      bridgeId: BRIDGE,
      scopes: [CONSOLE_MCP_SCOPES.read, CONSOLE_MCP_SCOPES.write],
      tokenId: TOKEN,
      operationId: WRITE_OP.id,
      arguments: { project: "demo", viewId: "v1" },
    };
    const bodyText = JSON.stringify(body);
    const path = "/api/internal/mcp/console/tools/call";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signingString = [timestamp, "POST", path, createHash("sha256").update(bodyText).digest("hex")].join("\n");
    const { deps, resolved } = cloudDeps("ask");
    const response = await handleConsoleToolsCallRequest(
      new Request(`https://console.ravi.bot${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ravi-hmac-timestamp": timestamp,
          "x-ravi-hmac-key-id": hmacConfig.currentId,
          "x-ravi-hmac-signature": createHmac("sha256", hmacConfig.currentKey).update(signingString).digest("base64"),
        },
        body: bodyText,
      }),
      { ...deps, hmacConfig },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "cloud_run_write_not_approved", reason: expect.stringContaining("denied") });
    expect(resolved).toEqual([{ organizationId: ORG, userId: USER, bridgeId: BRIDGE, tokenId: TOKEN }]);
  });
});
