import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { listPermissionDenials, setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import { type ContextCapability, type ContextRecord, getDb } from "../router/router-db.js";
import { ADMIN_BOOTSTRAP_KIND } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  type AuthorizeMcpUseDeps,
  authorizeMcpUse,
  isLegacyCredentialedMcpServer,
  type McpDenialRecordInput,
  mcpServerHoldsCredential,
} from "./authorize.js";
import {
  attachMcpServer,
  createMcpServer,
  getMcpServer,
  MCP_DAMAGED_ENV_KEYS,
  recordMcpServerProbe,
  setMcpConfigChangedEmitterForTests,
  updateMcpAttachments,
  updateMcpServerConfig,
} from "./registry-db.js";

let stateDir: string | null = null;
let audits: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-mcp-authorize-");
  setMcpConfigChangedEmitterForTests(() => {});
  audits = [];
  setPermissionAuditPublisherForTest((_topic, data) => {
    audits.push(data);
  });
});

afterEach(async () => {
  setPermissionAuditPublisherForTest();
  setMcpConfigChangedEmitterForTests(null);
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const AGENT = "main";

function toolGrant(objectId: string): ContextCapability {
  return { permission: "use", objectType: "tool", objectId };
}

function context(metadata: Record<string, unknown>, extra: Partial<ContextRecord> = {}): ContextRecord {
  return {
    contextId: `ctx_${Math.random().toString(36).slice(2)}`,
    contextKey: "rctx_test",
    kind: "agent-runtime",
    agentId: AGENT,
    sessionKey: "agent:main:main",
    sessionName: "main-session",
    capabilities: [toolGrant("mcp__github__*")],
    metadata,
    createdAt: Date.now(),
    ...extra,
  };
}

/** The operator's own turn: the admin bootstrap root (the terminal). */
function operatorTurn(capabilities: ContextCapability[] = [toolGrant("mcp__github__*")]): ContextRecord {
  return context(
    {},
    {
      kind: ADMIN_BOOTSTRAP_KIND,
      capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }, ...capabilities],
    },
  );
}

/** A resolved contact who is not the operator, in their direct chat. */
function contactTurn(): ContextRecord {
  return context({
    actorPrincipal: "contact:c_friend",
    actorResolution: "resolved",
    agentIdentityCompartment: "dm:chat_friend",
  });
}

/** A context with no actor and no parent: Ravi cannot say whose turn it is. */
function unknownTurn(): ContextRecord {
  return context({});
}

function heartbeatTurn(): ContextRecord {
  return context({ actorPrincipal: "automation:heartbeat", agentIdentityCompartment: "automation:heartbeat" });
}

function deliveryTurn(): ContextRecord {
  return context({
    actorPrincipal: "automation:mcp-call:mc_01",
    agentIdentityCompartment: "automation:mcp-call:mc_01",
  });
}

function registerGithub(options: { audience?: "operator" | "any"; authKind?: "none" | "oauth"; era?: "modern" } = {}) {
  createMcpServer({
    name: "github",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    authKind: options.authKind ?? "none",
  });
  attachMcpServer({ agentId: AGENT, server: "github", audience: options.audience ?? "operator" });
  recordMcpServerProbe("github", {
    status: "ok",
    era: options.era ?? "modern",
    catalog: {
      tools: [
        { name: "search", exposedName: "mcp__github__search" },
        { name: "create_issue", exposedName: "mcp__github__create_issue" },
        // A stored exposed name grants nothing: it is recomputed from the tool name.
        { name: "bad.name", exposedName: "mcp__github__bad_name" },
      ],
      dropped: [],
    },
  });
}

function call(ctx: ContextRecord | undefined, deps: AuthorizeMcpUseDeps = {}, tool = "search") {
  return authorizeMcpUse({ context: ctx, agentId: AGENT, server: "github", tool, surface: "call" }, deps);
}

describe("authorizeMcpUse matrix", () => {
  it("allows the operator's own turn on an attached, granted, logged-in server", () => {
    registerGithub();
    const result = call(operatorTurn());
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    expect(result.server.name).toBe("github");
    expect(result.attachment.audience).toBe("operator");
    expect(listPermissionDenials()).toEqual([]);
  });

  it("denies without a context (no_turn), and for an ended or foreign context", () => {
    registerGithub();
    expect(call(undefined)).toMatchObject({ allowed: false, code: "no_turn" });
    expect(call(operatorTurn(), { now: () => 10 })).toMatchObject({ allowed: true });
    const revoked = { ...operatorTurn(), revokedAt: 5 };
    expect(call(revoked, { now: () => 10 })).toMatchObject({ allowed: false, code: "no_turn" });
    const foreign = { ...operatorTurn(), agentId: "other" };
    expect(call(foreign)).toMatchObject({ allowed: false, code: "no_turn" });
  });

  it("denies an unregistered server (not_registered)", () => {
    expect(call(operatorTurn())).toMatchObject({ allowed: false, code: "not_registered" });
  });

  it("denies a disabled server (disabled), before the attachment check", () => {
    createMcpServer({ name: "github", transport: "http", url: "https://mcp.example.com/mcp" });
    updateMcpServerConfig("github", { enabled: false });
    // Disabled and not attached: the earlier check decides.
    expect(call(operatorTurn())).toMatchObject({ allowed: false, code: "disabled" });
  });

  it("denies a server not attached to the agent (not_attached)", () => {
    createMcpServer({ name: "github", transport: "http", url: "https://mcp.example.com/mcp" });
    attachMcpServer({ agentId: "other", server: "github" });
    expect(call(operatorTurn())).toMatchObject({ allowed: false, code: "not_attached" });
  });

  it("denies an operator-audience server on a contact turn and on an unclassifiable turn (audience)", () => {
    registerGithub();
    expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience" });
    expect(call(unknownTurn())).toMatchObject({ allowed: false, code: "audience" });
  });

  it("lets the heartbeat routine use an operator-audience server", () => {
    registerGithub();
    expect(call(heartbeatTurn())).toMatchObject({ allowed: true });
  });

  it("denies a background-result delivery turn on an operator-audience server", () => {
    registerGithub();
    expect(call(deliveryTurn())).toMatchObject({ allowed: false, code: "audience" });
  });

  it("lets anyone use an audience-any server without a credential", () => {
    registerGithub({ audience: "any", authKind: "none" });
    expect(call(contactTurn())).toMatchObject({ allowed: true });
  });

  it("keeps a credentialed legacy row operator-only even when widened to any (audience_legacy)", () => {
    registerGithub({ audience: "any", authKind: "oauth", era: "modern" });
    expect(call(contactTurn())).toMatchObject({ allowed: true });

    recordMcpServerProbe("github", { status: "ok", era: "legacy" });
    expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
    expect(call(operatorTurn())).toMatchObject({ allowed: true });
  });

  it("treats a credentialed row whose era is not yet known as legacy", () => {
    createMcpServer({ name: "github", transport: "http", url: "https://mcp.example.com/mcp", authKind: "oauth" });
    attachMcpServer({ agentId: AGENT, server: "github", audience: "any" });
    expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
  });

  it("denies a tool the turn is not granted (capability)", () => {
    registerGithub();
    const ctx = operatorTurn([toolGrant("mcp__github__search")]);
    expect(call(ctx, {}, "search")).toMatchObject({ allowed: true });
    // The admin bootstrap context holds admin system *, so use a narrowed context for the denial.
    const narrow = context({}, { kind: "cli-runtime", capabilities: [toolGrant("mcp__github__search")] });
    const deps: AuthorizeMcpUseDeps = { isOperatorOwnTurn: () => true };
    expect(call(narrow, deps, "search")).toMatchObject({ allowed: true });
    expect(call(narrow, deps, "create_issue")).toMatchObject({ allowed: false, code: "capability" });
  });

  it("never lets a grant on mcp__a__* reach server a-b", () => {
    createMcpServer({ name: "a-b", transport: "http", url: "https://mcp.example.com/mcp" });
    attachMcpServer({ agentId: AGENT, server: "a-b", audience: "any" });
    const ctx = context({}, { kind: "cli-runtime", capabilities: [toolGrant("mcp__a__*")] });
    const result = authorizeMcpUse({ context: ctx, agentId: AGENT, server: "a-b", tool: "x", surface: "call" });
    expect(result).toMatchObject({ allowed: false, code: "capability" });
  });

  it("denies a tool name that cannot be exposed (capability)", () => {
    registerGithub();
    expect(call(operatorTurn(), {}, "bad.name")).toMatchObject({ allowed: false, code: "capability" });
  });

  it("denies a server that needs a login (needs_login) and names the command", () => {
    registerGithub();
    recordMcpServerProbe("github", { status: "needs_login" });
    const result = call(operatorTurn());
    expect(result).toMatchObject({ allowed: false, code: "needs_login" });
    if (result.allowed) return;
    // `ravi mcp login` is braked: the hint is the command that signs in, not its dry run.
    expect(result.reason).toContain("run ravi mcp login github --execute");
  });

  it("checks the capability before the login state", () => {
    registerGithub();
    recordMcpServerProbe("github", { status: "needs_login" });
    const ctx = context({}, { kind: "cli-runtime", capabilities: [] });
    expect(call(ctx, { isOperatorOwnTurn: () => true })).toMatchObject({ allowed: false, code: "capability" });
  });
});

describe("authorizeMcpUse surfaces", () => {
  it("lists only granted, exposable catalog tools and records no denial for a list", () => {
    registerGithub();
    const narrow = context({}, { kind: "cli-runtime", capabilities: [toolGrant("mcp__github__search")] });
    const deps: AuthorizeMcpUseDeps = { isOperatorOwnTurn: () => true };
    const listed = authorizeMcpUse({ context: narrow, agentId: AGENT, server: "github", surface: "list" }, deps);
    expect(listed).toMatchObject({ allowed: true, tools: ["mcp__github__search"] });

    const none = context({}, { kind: "cli-runtime", capabilities: [] });
    const empty = authorizeMcpUse({ context: none, agentId: AGENT, server: "github", surface: "list" }, deps);
    expect(empty).toMatchObject({ allowed: false, code: "capability" });
    const unattached = authorizeMcpUse({ context: undefined, agentId: AGENT, server: "x", surface: "list" });
    expect(unattached).toMatchObject({ allowed: false, code: "no_turn" });
    expect(listPermissionDenials()).toEqual([]);
  });

  it("skips the tool check on the skill surface and requires a tool on the others", () => {
    registerGithub();
    const none = context({}, { kind: "cli-runtime", capabilities: [] });
    const deps: AuthorizeMcpUseDeps = { isOperatorOwnTurn: () => true };
    expect(authorizeMcpUse({ context: none, agentId: AGENT, server: "github", surface: "skill" }, deps)).toMatchObject({
      allowed: true,
    });
    for (const surface of ["call", "task-input", "elicitation", "upload"] as const) {
      expect(authorizeMcpUse({ context: operatorTurn(), agentId: AGENT, server: "github", surface })).toMatchObject({
        allowed: false,
        code: "invalid_request",
      });
      expect(
        authorizeMcpUse({ context: none, agentId: AGENT, server: "github", tool: "search", surface }, deps),
      ).toMatchObject({ allowed: false, code: "capability" });
    }
  });
});

describe("authorizeMcpUse fails closed", () => {
  it("denies when the turn classifier throws", () => {
    registerGithub();
    const result = call(operatorTurn(), {
      isOperatorOwnTurn: () => {
        throw new Error("boom");
      },
    });
    expect(result).toMatchObject({ allowed: false, code: "audience" });
  });

  it("denies when the capability check or the registry throws", () => {
    registerGithub();
    expect(
      call(operatorTurn(), {
        canUseTool: () => {
          throw new Error("boom");
        },
      }),
    ).toMatchObject({ allowed: false, code: "error" });
    expect(
      call(operatorTurn(), {
        getServer: () => {
          throw new Error("boom");
        },
      }),
    ).toMatchObject({ allowed: false, code: "error" });
  });

  it("still answers with the denial when recording it throws", () => {
    const result = call(undefined, {
      recordDenial: () => {
        throw new Error("ledger down");
      },
    });
    expect(result).toMatchObject({ allowed: false, code: "no_turn" });
  });
});

describe("authorizeMcpUse denial records", () => {
  it("records every denial with the gateway as the MCP source", () => {
    registerGithub();
    call(contactTurn());
    const narrow = context({}, { kind: "cli-runtime", capabilities: [] });
    call(narrow, { isOperatorOwnTurn: () => true }, "create_issue");

    const denials = listPermissionDenials();
    expect(denials.map((denial) => [denial.relation, denial.objectType, denial.objectId])).toEqual([
      ["use", "mcp_server", "github"],
      ["use", "tool", "mcp__github__create_issue"],
    ]);
    for (const denial of denials) {
      expect(denial.subjectType).toBe("agent");
      expect(denial.subjectId).toBe(AGENT);
      expect(denial.detail?.mcpServer).toEqual({ name: "github", source: "gateway" });
    }
    expect(denials[0]?.detail).toMatchObject({ mcpCode: "audience", mcpSurface: "call" });
    expect(denials[1]?.detail).toMatchObject({ mcpCode: "capability", mcpTool: "create_issue" });
  });

  it("passes the code, surface and exposed name to the recorder", () => {
    registerGithub();
    const recorded: McpDenialRecordInput[] = [];
    const narrow = context({}, { kind: "cli-runtime", capabilities: [] });
    call(narrow, { isOperatorOwnTurn: () => true, recordDenial: (input) => recorded.push(input) }, "search");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      server: "github",
      tool: "search",
      exposedName: "mcp__github__search",
      surface: "call",
      code: "capability",
    });
  });
});

describe("legacy credentialed rows", () => {
  it("are credentialed rows that are, or may be, on the legacy leg", () => {
    expect(
      isLegacyCredentialedMcpServer({
        authKind: "none",
        urlSecret: false,
        envKeys: [],
        era: "legacy",
        protocol: "legacy",
      }),
    ).toBe(false);
    expect(
      isLegacyCredentialedMcpServer({
        authKind: "oauth",
        urlSecret: false,
        envKeys: [],
        era: "modern",
        protocol: "auto",
      }),
    ).toBe(false);
    expect(
      isLegacyCredentialedMcpServer({
        authKind: "bearer",
        urlSecret: false,
        envKeys: [],
        era: "legacy",
        protocol: "auto",
      }),
    ).toBe(true);
    expect(
      isLegacyCredentialedMcpServer({ authKind: "oauth", urlSecret: false, envKeys: [], era: null, protocol: "auto" }),
    ).toBe(true);
    expect(
      isLegacyCredentialedMcpServer({
        authKind: "oauth",
        urlSecret: false,
        envKeys: [],
        era: null,
        protocol: "2026-07-28",
      }),
    ).toBe(false);
    expect(
      isLegacyCredentialedMcpServer({
        authKind: "oauth",
        urlSecret: false,
        envKeys: [],
        era: "modern",
        protocol: "legacy",
      }),
    ).toBe(true);
  });

  it("count a token in the stored URL as the operator's credential, whatever the auth kind", () => {
    // Console bridge URLs embed the bridge token (ADDENDUM C1): such a row is credentialed with auth none.
    createMcpServer({
      name: "github",
      transport: "http",
      url: "https://bridge.example.com/mcp/rbt_abcdefghijklmnopqrstuvwxyz012345",
    });
    attachMcpServer({ agentId: AGENT, server: "github", audience: "any" });
    expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
    recordMcpServerProbe("github", {
      status: "ok",
      era: "legacy",
      catalog: { tools: [{ name: "search", exposedName: "mcp__github__search" }], dropped: [] },
    });
    expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
    expect(call(operatorTurn())).toMatchObject({ allowed: true });
    recordMcpServerProbe("github", { status: "ok", era: "modern" });
    expect(call(contactTurn())).toMatchObject({ allowed: true });

    // A query string is dropped from the display form, so it is a secret too.
    createMcpServer({ name: "query", transport: "http", url: "https://q.example.com/mcp?key=x" });
    expect(isLegacyCredentialedMcpServer(getMcpServer("query")!)).toBe(true);
    expect(isLegacyCredentialedMcpServer(getMcpServer("github")!)).toBe(false);
    expect(
      isLegacyCredentialedMcpServer({ authKind: "none", urlSecret: true, envKeys: [], era: null, protocol: "auto" }),
    ).toBe(true);
  });

  it("count stored stdio env values as the operator's credential", () => {
    expect(
      isLegacyCredentialedMcpServer({
        authKind: "none",
        urlSecret: false,
        envKeys: ["TOKEN"],
        era: null,
        protocol: "auto",
      }),
    ).toBe(true);
    expect(
      isLegacyCredentialedMcpServer({
        authKind: "none",
        urlSecret: false,
        envKeys: ["TOKEN"],
        era: "modern",
        protocol: "auto",
      }),
    ).toBe(false);
    const catalog = { tools: [{ name: "search", exposedName: "mcp__github__search" }], dropped: [] };
    createMcpServer({ name: "github", transport: "stdio", command: "npx", envKeys: ["GITHUB_TOKEN"] });
    expect(getMcpServer("github")).toMatchObject({ authKind: "none", urlSecret: false, envKeys: ["GITHUB_TOKEN"] });
    attachMcpServer({ agentId: AGENT, server: "github", audience: "any" });
    recordMcpServerProbe("github", { status: "ok", catalog });
    const recorded: McpDenialRecordInput[] = [];
    expect(call(contactTurn(), { recordDenial: (input) => recorded.push(input) })).toMatchObject({
      allowed: false,
      code: "audience_legacy",
    });
    expect(recorded).toEqual([expect.objectContaining({ server: "github", code: "audience_legacy" })]);
    recordMcpServerProbe("github", { status: "ok", era: "legacy" });
    expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
    expect(call(deliveryTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
    expect(call(operatorTurn())).toMatchObject({ allowed: true });
    recordMcpServerProbe("github", { status: "ok", era: "modern" });
    expect(call(contactTurn())).toMatchObject({ allowed: true });

    // Env keys added after the widening count at once.
    updateMcpServerConfig("github", { envKeys: [] });
    recordMcpServerProbe("github", { status: "ok", era: "legacy" });
    expect(call(contactTurn())).toMatchObject({ allowed: true });
    updateMcpServerConfig("github", { envKeys: ["GITHUB_TOKEN"] });
    recordMcpServerProbe("github", { status: "ok", era: "legacy", catalog });
    expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
  });

  it("count a stored env key list that does not parse as credentialed, and keep it visible", () => {
    const catalog = { tools: [{ name: "search", exposedName: "mcp__github__search" }], dropped: [] };
    createMcpServer({ name: "github", transport: "stdio", command: "npx", envKeys: ["GITHUB_TOKEN"] });
    attachMcpServer({ agentId: AGENT, server: "github", audience: "any" });
    recordMcpServerProbe("github", { status: "ok", era: "legacy", catalog });
    for (const damaged of ["not json", '{"GITHUB_TOKEN":1}', "[1]", '["BAD KEY"]', "null"]) {
      getDb().prepare("UPDATE mcp_servers SET env_keys_json = ? WHERE name = ?").run(damaged, "github");
      const row = getMcpServer("github")!;
      expect(row.envKeys).toEqual([MCP_DAMAGED_ENV_KEYS]);
      expect(mcpServerHoldsCredential(row)).toBe(true);
      expect(isLegacyCredentialedMcpServer(row)).toBe(true);
      expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
    }
    // Anything handed in that is not a list counts as a credential too.
    expect(
      mcpServerHoldsCredential({ authKind: "none", urlSecret: false, envKeys: undefined as unknown as string[] }),
    ).toBe(true);
    // A well-formed empty list is no credential.
    getDb().prepare("UPDATE mcp_servers SET env_keys_json = ? WHERE name = ?").run("[]", "github");
    expect(mcpServerHoldsCredential(getMcpServer("github")!)).toBe(false);
  });

  it("leave a stdio row without env keys to its audience, as before", () => {
    createMcpServer({ name: "github", transport: "stdio", command: "npx" });
    expect(getMcpServer("github")?.envKeys).toEqual([]);
    expect(isLegacyCredentialedMcpServer(getMcpServer("github")!)).toBe(false);
    attachMcpServer({ agentId: AGENT, server: "github", audience: "operator" });
    recordMcpServerProbe("github", {
      status: "ok",
      era: "legacy",
      catalog: { tools: [{ name: "search", exposedName: "mcp__github__search" }], dropped: [] },
    });
    expect(call(contactTurn())).toMatchObject({ allowed: false, code: "audience" });
    updateMcpAttachments({ server: "github", audience: "any" });
    expect(call(contactTurn())).toMatchObject({ allowed: true });
  });

  it("stay operator-only after a widening to any", () => {
    registerGithub({ audience: "operator", authKind: "oauth", era: "modern" });
    updateMcpAttachments({ server: "github", audience: "any" });
    recordMcpServerProbe("github", { status: "ok", era: "legacy" });
    expect(call(heartbeatTurn())).toMatchObject({ allowed: true });
    expect(call(deliveryTurn())).toMatchObject({ allowed: false, code: "audience_legacy" });
  });
});
