import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runWithContext } from "./context.js";
import {
  buildCliCommandOperation,
  enforceCliCommandAccess,
  enforceCliCommandAuthorization,
  redactCommandAccessInput,
} from "./command-access.js";
import { getCommandAccessMetadata, type CommandAccessOptions } from "./decorators.js";
import { SessionCommands } from "./commands/sessions.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { emptyCredentialsFile, upsertCredentialsEntry, writeCredentialsFile } from "../runtime/credentials-store.js";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  RAVI_RUNTIME_CONTEXT_ENV_KEYS,
} from "../test/ravi-state.js";
import { dbCreateAgent, dbSetSetting, dbUpdateAgent, type ContextRecord } from "../router/router-db.js";
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import {
  EXTERNAL_AUTHORITY_ASSERTION_SETTING,
  EXTERNAL_AUTHORITY_PUBKEY_SETTING,
  canonicalize,
  resetExternalAuthorityCacheForTests,
} from "../permissions/external-authority-provider.js";
import { PERMISSION_PROVIDER_IDS_SETTING } from "../permissions/provider-registry.js";
import {
  flushPermissionAuditEvents,
  listPermissionDenials,
  setPermissionAuditPublisherForTest,
} from "../permissions/denials.js";
import { dbCreateTagDefinition } from "../tags/index.js";

const ACCESS: CommandAccessOptions = {
  kind: "mutate",
  resource: "demo.items",
  action: "create",
  risk: "medium",
  input: ["id", "secret", "ignored"],
  redactions: ["secret"],
};

let stateDir: string | null = null;
let previousEnv: Partial<Record<(typeof RAVI_RUNTIME_CONTEXT_ENV_KEYS)[number], string>> = {};
let previousCredentialsPath: string | undefined;
let previousForceLocalOperator: string | undefined;
let auditEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];

function context(capabilities: ContextRecord["capabilities"]): ContextRecord {
  return {
    contextId: "ctx_command_access_test",
    contextKey: "rctx_command_access_test",
    kind: "turn-runtime",
    agentId: "dev",
    capabilities,
    metadata: { authorityMode: "delegated" },
    createdAt: 0,
  };
}

describe("CLI command access enforcement", () => {
  it("redacts command-declared audit fields without changing the original input", () => {
    const input = { id: "item-1", secret: "provider-private-value" };

    expect(redactCommandAccessInput(ACCESS, input)).toEqual({ id: "item-1", secret: "[REDACTED]" });
    expect(input.secret).toBe("provider-private-value");
  });

  it("redacts a custom setting value declaratively without changing authorization input", () => {
    const input = { key: "custom.password", value: "SENTINEL_SECRET_7M4Q", json: true };
    const access: CommandAccessOptions = {
      kind: "mutate",
      resource: "settings",
      action: "set",
      risk: "medium",
      redactions: ["value"],
    };

    expect(redactCommandAccessInput(access, input)).toEqual({
      key: "custom.password",
      value: "[REDACTED]",
      json: true,
    });
    expect(input.value).toBe("SENTINEL_SECRET_7M4Q");
  });

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-cli-command-access-test-");
    previousEnv = {};
    previousCredentialsPath = process.env.RAVI_CREDENTIALS_PATH;
    previousForceLocalOperator = process.env.RAVI_CLI_FORCE_LOCAL_OPERATOR;
    auditEvents = [];
    setPermissionAuditPublisherForTest(async (topic, data) => {
      auditEvents.push({ topic, data });
    });
    for (const key of RAVI_RUNTIME_CONTEXT_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        previousEnv[key] = process.env[key];
      }
      delete process.env[key];
    }
    delete process.env.RAVI_CLI_FORCE_LOCAL_OPERATOR;
  });

  afterEach(async () => {
    for (const key of RAVI_RUNTIME_CONTEXT_ENV_KEYS) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
    previousEnv = {};
    if (previousCredentialsPath === undefined) {
      delete process.env.RAVI_CREDENTIALS_PATH;
    } else {
      process.env.RAVI_CREDENTIALS_PATH = previousCredentialsPath;
    }
    previousCredentialsPath = undefined;
    if (previousForceLocalOperator === undefined) {
      delete process.env.RAVI_CLI_FORCE_LOCAL_OPERATOR;
    } else {
      process.env.RAVI_CLI_FORCE_LOCAL_OPERATOR = previousForceLocalOperator;
    }
    previousForceLocalOperator = undefined;
    setPermissionAuditPublisherForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("fails closed when command access metadata is missing", () => {
    const result = enforceCliCommandAccess({
      group: "demo",
      command: "create",
      source: "cli",
    });

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("missing @CommandAccess");
    expect(result.attempted).toEqual([]);
  });

  it("selects and redacts only declared command input", () => {
    const operation = buildCliCommandOperation({
      group: "demo",
      command: "create",
      access: ACCESS,
      source: "tool",
      input: {
        id: "item_1",
        secret: "token",
        extra: "must-not-leak",
      },
    });

    expect(operation).toMatchObject({
      kind: "cli-command",
      source: "tool",
      group: "demo",
      command: "create",
      fullName: "demo.create",
      input: {
        id: "item_1",
        secret: "[REDACTED]",
      },
    });
    expect(operation.input).not.toHaveProperty("extra");
    expect(operation.input).not.toHaveProperty("ignored");
  });

  describe("with an external authority that requires approval", () => {
    function configureExternalAuthority(chain: string, scope: Array<Record<string, unknown>>): void {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const payload = { iss: "issuer", sub: "agent:dev", exp: Math.floor(Date.now() / 1000) + 60, scope };
      const sig = signPayload(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64");
      const assertionPath = join(stateDir!, "assertion.json");
      writeFileSync(assertionPath, JSON.stringify({ ...payload, sig }));
      dbSetSetting(PERMISSION_PROVIDER_IDS_SETTING, chain);
      dbSetSetting(EXTERNAL_AUTHORITY_ASSERTION_SETTING, assertionPath);
      dbSetSetting(EXTERNAL_AUTHORITY_PUBKEY_SETTING, publicKey.export({ type: "spki", format: "pem" }).toString());
      resetExternalAuthorityCacheForTests();
    }

    function runDemoCreate(capabilities: ContextRecord["capabilities"]) {
      return runWithContext({ agentId: "dev", context: context(capabilities) }, () =>
        enforceCliCommandAccess({ group: "demo", command: "create", access: ACCESS, source: "gateway" }),
      );
    }

    const approvalOnSemantic = [
      { permission: "mutate", objectType: "demo.items", objectId: "create", requiresApproval: true },
      // Candidato legado execute:group:demo, sem exigência de aprovação.
      { permission: "execute", objectType: "group", objectId: "demo" },
    ];
    const legacyGrant = [{ permission: "execute", objectType: "group", objectId: "demo", source: "test" }];

    afterEach(() => resetExternalAuthorityCacheForTests());

    it("stops at needs_approval instead of trying a broader candidate the authority allows", async () => {
      delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      configureExternalAuthority("external-authority", approvalOnSemantic);

      const result = runDemoCreate([]);
      await flushPermissionAuditEvents();

      expect(result.allowed).toBe(false);
      expect(result.attempted).toHaveLength(1);
      expect(result.decision?.decision).toBe("needs_approval");
      expect(result.errorMessage).toStartWith("Approval required: agent:dev cannot execute demo create");
      expect(result.errorMessage).toContain("external_authority_requires_approval");
      expect(result.errorMessage).not.toContain("Missing capability");
      expect(result.errorMessage).not.toContain("ravi permissions allow");
      expect(auditEvents).toEqual([
        {
          topic: "ravi.audit.denied",
          data: expect.objectContaining({
            blockType: "cli_command_access_needs_approval",
            denied: "mutate:demo.items:create",
            guidance: expect.not.objectContaining({ allowCommand: expect.anything() }),
          }),
        },
      ]);
    });

    it("keeps the approval when context-capabilities denies earlier candidates first", () => {
      // Ordem natural: autoridade externa somada à cadeia default. O deny de
      // context-capabilities nos candidatos semânticos encerra a cadeia antes
      // da autoridade externa; só o legado execute:group:demo é liberado.
      configureExternalAuthority("operator-control,context-capabilities,external-authority", approvalOnSemantic);

      const result = runDemoCreate(legacyGrant);

      expect(result.allowed).toBe(false);
      expect(result.decision?.decision).toBe("needs_approval");
      expect(result.decision?.objectType).toBe("demo.items");
      expect(result.errorMessage).toStartWith("Approval required:");
    });

    it("keeps the approval when an earlier candidate matches an unconditional scope", () => {
      configureExternalAuthority("external-authority", [
        { permission: "mutate", objectType: "*", objectId: "*" },
        { permission: "execute", objectType: "group", objectId: "demo", requiresApproval: true },
      ]);

      const result = runDemoCreate([]);

      expect(result.allowed).toBe(false);
      expect(result.decision?.decision).toBe("needs_approval");
      expect(result.decision?.objectId).toBe("demo");
    });

    it("still allows when no candidate requires approval", () => {
      configureExternalAuthority("operator-control,context-capabilities,external-authority", [
        { permission: "execute", objectType: "group", objectId: "demo" },
      ]);

      const result = runDemoCreate(legacyGrant);

      expect(result.allowed).toBe(true);
      expect(result.decision?.providerId).toBe("external-authority");
    });
  });

  it("allows explicit local operator execution when no runtime principal exists", () => {
    process.env.RAVI_AGENT_ID = "ambient-agent";

    const result = enforceCliCommandAccess({
      group: "demo",
      command: "create",
      access: ACCESS,
      source: "cli",
    });

    expect(result.allowed).toBe(true);
    expect(result.decision?.providerId).toBe("operator-control");
    expect(result.decision?.permission).toBe("mutate");
    expect(result.decision?.objectType).toBe("demo.items");
    expect(result.decision?.objectId).toBe("create");
  });

  it("does not let env force local operator execution when a context key is present", () => {
    const record = createRuntimeContext({
      kind: "cli-runtime",
      agentId: "main",
      capabilities: [],
      ttlMs: 0,
    });
    process.env.RAVI_CONTEXT_KEY = record.contextKey;
    process.env.RAVI_CLI_FORCE_LOCAL_OPERATOR = "1";

    const result = enforceCliCommandAccess({
      group: "demo",
      command: "create",
      access: ACCESS,
      source: "cli",
    });

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("agent:main cannot execute demo create");
    expect(result.attempted.every((decision) => decision.providerId === "context-capabilities")).toBe(true);
  });

  it("denies instead of falling back to the local operator when the context key does not resolve", () => {
    process.env.RAVI_CONTEXT_KEY = "rctx_unknown_to_this_install";

    const result = enforceCliCommandAccess({
      group: "demo",
      command: "create",
      access: ACCESS,
      source: "cli",
    });

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("requires a resolved runtime principal");
  });

  it("ignores default credential context for direct local CLI authorization", () => {
    const record = createRuntimeContext({
      kind: "cli-runtime",
      agentId: "main",
      capabilities: [],
      ttlMs: 0,
    });
    const credentialsPath = join(stateDir!, "credentials.json");
    process.env.RAVI_CREDENTIALS_PATH = credentialsPath;
    writeCredentialsFile(
      upsertCredentialsEntry(
        emptyCredentialsFile(),
        record.contextKey,
        {
          context_id: record.contextId,
          agent_id: "main",
          label: "test",
          kind: record.kind,
          issued_at: record.createdAt,
          expires_at: record.expiresAt ?? null,
        },
        { setDefault: true },
      ),
      credentialsPath,
    );

    const result = enforceCliCommandAccess({
      group: "demo",
      command: "create",
      access: ACCESS,
      source: "cli",
    });

    expect(result.allowed).toBe(true);
    expect(result.decision?.providerId).toBe("operator-control");
    expect(result.decision?.permission).toBe("mutate");
    expect(result.decision?.objectType).toBe("demo.items");
    expect(result.decision?.objectId).toBe("create");
  });

  it("does not allow tool or gateway execution without a resolved runtime principal", () => {
    process.env.RAVI_AGENT_ID = "ambient-agent";

    for (const source of ["tool", "gateway"] as const) {
      const result = enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source,
      });

      expect(result.allowed).toBe(false);
      expect(result.errorMessage).toContain("requires a resolved runtime principal");
      expect(result.attempted).toEqual([]);
    }
  });

  it("respects commands that disallow local operator fallback", () => {
    const result = enforceCliCommandAccess({
      group: "demo",
      command: "create",
      access: { ...ACCESS, localOperator: false },
      source: "cli",
    });

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("local operator is not allowed");
    expect(result.attempted).toEqual([]);
  });

  it("authorizes runtime contexts through semantic command capabilities first", () => {
    const record = context([{ permission: "mutate", objectType: "demo.items", objectId: "create" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source: "gateway",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.decision?.providerId).toBe("context-capabilities");
    expect(result.decision?.permission).toBe("mutate");
    expect(result.decision?.objectType).toBe("demo.items");
    expect(result.decision?.objectId).toBe("create");
    expect(result.attempted).toHaveLength(1);
  });

  it("treats a semantic provider-runtime decision as final for normal legacy scopes", () => {
    const record = context([{ permission: "mutate", objectType: "media", objectId: "send" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAuthorization({
        group: "media",
        command: "send",
        access: { kind: "mutate", resource: "media", action: "send", risk: "high" },
        source: "tool",
        scope: "open",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.attempted).toHaveLength(1);
    expect(result.decision).toMatchObject({ permission: "mutate", objectType: "media", objectId: "send" });
  });

  it("retains the explicit superadmin boundary after semantic authorization", () => {
    const semanticOnly = context([{ permission: "read", objectType: "secret", objectId: "show" }]);
    const denied = runWithContext({ agentId: "dev", context: semanticOnly }, () =>
      enforceCliCommandAuthorization({
        group: "secret",
        command: "show",
        access: { kind: "read", resource: "secret", action: "show", risk: "low" },
        source: "gateway",
        scope: "superadmin",
      }),
    );
    expect(denied.allowed).toBe(false);
    expect(denied.errorMessage).toContain("requires admin on system:*");

    const breakGlass = context([{ permission: "admin", objectType: "system", objectId: "*" }]);
    const allowed = runWithContext({ agentId: "dev", context: breakGlass }, () =>
      enforceCliCommandAuthorization({
        group: "secret",
        command: "show",
        access: { kind: "read", resource: "secret", action: "show", risk: "low" },
        source: "gateway",
        scope: "superadmin",
      }),
    );
    expect(allowed.allowed).toBe(true);
  });

  it("allows semantic resource wildcard command capabilities", () => {
    const record = context([{ permission: "mutate", objectType: "demo.items", objectId: "*" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source: "gateway",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.decision?.permission).toBe("mutate");
    expect(result.decision?.objectType).toBe("demo.items");
    expect(result.decision?.objectId).toBe("create");
    expect(
      result.attempted.map((decision) => `${decision.permission}:${decision.objectType}:${decision.objectId}`),
    ).toEqual(["mutate:demo.items:create"]);
  });

  it("supports dotted action resource wildcards as a transition alias", () => {
    const record = context([{ permission: "mutate", objectType: "demo.items.create", objectId: "*" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source: "tool",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.decision?.permission).toBe("mutate");
    expect(result.decision?.objectType).toBe("demo.items.create");
    expect(result.decision?.objectId).toBe("*");
  });

  it("authorizes resource-scoped commands through concrete resource capabilities", () => {
    const record = context([{ permission: "mutate", objectType: "task", objectId: "task-own" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "tasks",
        command: "report",
        access: {
          kind: "mutate",
          resource: "tasks",
          action: "report",
          risk: "medium",
          resourceId: "taskId",
          input: ["taskId"],
        },
        input: { taskId: "task-own" },
        source: "tool",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.decision?.permission).toBe("mutate");
    expect(result.decision?.objectType).toBe("task");
    expect(result.decision?.objectId).toBe("task-own");
    expect(
      result.attempted.map((decision) => `${decision.permission}:${decision.objectType}:${decision.objectId}`),
    ).toEqual(["mutate:tasks:report", "mutate:tasks:*", "mutate:tasks.report:*", "mutate:task:task-own"]);
  });

  it("does not let a concrete resource capability authorize a different input resource", () => {
    const record = context([{ permission: "mutate", objectType: "task", objectId: "task-own" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "tasks",
        command: "report",
        access: {
          kind: "mutate",
          resource: "tasks",
          action: "report",
          risk: "medium",
          resourceId: "taskId",
          input: ["taskId"],
        },
        input: { taskId: "task-other" },
        source: "tool",
      }),
    );

    expect(result.allowed).toBe(false);
    expect(
      result.attempted.map((decision) => `${decision.permission}:${decision.objectType}:${decision.objectId}`),
    ).toEqual([
      "mutate:tasks:report",
      "mutate:tasks:*",
      "mutate:tasks.report:*",
      "mutate:task:task-other",
      "execute:group:tasks_report",
      "execute:group:tasks",
    ]);
  });

  it("requires the canonical concrete resource when configured and rejects semantic or legacy fallbacks", () => {
    const strictAccess: CommandAccessOptions = {
      kind: "read",
      resource: "chats.lists",
      action: "preview",
      risk: "low",
      resourceId: "listId",
      requireConcreteResource: true,
      resourceIdPattern: "^crl_[0-9a-f]{24}$",
      input: ["listId"],
    };
    const listId = "crl_0123456789abcdef01234567";

    for (const capability of [
      { permission: "read", objectType: "chats.lists", objectId: "preview" },
      { permission: "read", objectType: "chats.lists", objectId: "*" },
      { permission: "admin", objectType: "system", objectId: "*" },
      { permission: "execute", objectType: "group", objectId: "chats_lists_preview" },
      { permission: "execute", objectType: "group", objectId: "chats_lists" },
    ]) {
      const record = context([capability]);
      const result = runWithContext({ agentId: "dev", context: record }, () =>
        enforceCliCommandAccess({
          group: "chats_lists",
          command: "preview",
          access: strictAccess,
          input: { listId },
          source: "tool",
        }),
      );
      expect(result.allowed).toBe(false);
      expect(result.attempted.map((decision) => decision.objectId)).toEqual([listId]);
      expect(result.errorMessage).toContain(`Missing capability: read:chats.lists:${listId}`);
      expect(result.errorMessage).toContain(`Scope: resource check on chats.lists:${listId}`);
    }

    const concrete = context([{ permission: "read", objectType: "chats.lists", objectId: listId }]);
    const allowed = runWithContext({ agentId: "dev", context: concrete }, () =>
      enforceCliCommandAccess({
        group: "chats_lists",
        command: "preview",
        access: strictAccess,
        input: { listId },
        source: "gateway",
      }),
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.attempted).toHaveLength(1);
    expect(allowed.decision).toMatchObject({ permission: "read", objectType: "chats.lists", objectId: listId });
  });

  it("fails closed before authorization when a strict resource ref is not canonical", () => {
    const record = context([{ permission: "read", objectType: "chats.lists", objectId: "secret-list" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "chats_lists",
        command: "show",
        access: {
          kind: "read",
          resource: "chats.lists",
          action: "show",
          risk: "low",
          resourceId: "listId",
          requireConcreteResource: true,
          resourceIdPattern: "^crl_[0-9a-f]{24}$",
        },
        input: { listId: "secret-list" },
        source: "tool",
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.attempted).toEqual([]);
    expect(result.errorMessage).toContain("Scope: this command needs a concrete chats.lists id");
    expect(result.errorMessage).not.toContain("Scope: global capability check");
  });

  it("falls back to legacy command-specific execute capabilities", () => {
    const record = context([{ permission: "execute", objectType: "group", objectId: "demo_create" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source: "gateway",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.decision?.providerId).toBe("context-capabilities");
    expect(result.decision?.permission).toBe("execute");
    expect(result.decision?.objectType).toBe("group");
    expect(result.decision?.objectId).toBe("demo_create");
  });

  it("falls back to legacy group-level execute capabilities for command execution", () => {
    const record = context([{ permission: "execute", objectType: "group", objectId: "demo" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source: "tool",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.decision?.objectId).toBe("demo");
    expect(
      result.attempted.map((decision) => `${decision.permission}:${decision.objectType}:${decision.objectId}`),
    ).toEqual([
      "mutate:demo.items:create",
      "mutate:demo.items:*",
      "mutate:demo.items.create:*",
      "execute:group:demo_create",
      "execute:group:demo",
    ]);
  });

  it("denies runtime contexts without matching execute capability", () => {
    const record = context([]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source: "gateway",
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("agent:dev cannot execute demo create");
    expect(result.attempted).toHaveLength(5);
    expect(result.attempted.every((decision) => decision.providerId === "context-capabilities")).toBe(true);
  });

  it("includes matching provider-owned permission tags in command denial guidance", () => {
    dbCreateTagDefinition({
      slug: "permission-demo-writer",
      label: "Demo Writer",
      kind: "system",
      source: "permissions",
      metadata: {
        permissions: {
          capabilities: ["mutate:demo.items:create"],
        },
      },
    });

    const record = context([]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source: "gateway",
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("Missing capability: mutate:demo.items:create");
    expect(result.errorMessage).toContain(
      "Required candidates: mutate:demo.items:create, mutate:demo.items:*, mutate:demo.items.create:*, execute:group:demo_create, execute:group:demo",
    );
    expect(result.errorMessage).toContain("permission-demo-writer");
    expect(result.errorMessage).toContain("ravi permissions allow permission-demo-writer --to agent:dev --apply");
    expect(result.errorMessage).toContain("full-access is break-glass");
  });

  it("lets a full-access agent answer another session through the semantic sessions answer gate", () => {
    const access = getCommandAccessMetadata(SessionCommands).get("answer");
    if (!access) throw new Error("Missing @CommandAccess metadata for sessions answer");
    expect(access).toMatchObject({ kind: "mutate", resource: "sessions", action: "answer" });
    expect(access.resourceId).toBeUndefined();

    dbCreateAgent({ id: "answerer", cwd: "/tmp/answerer" });
    dbUpdateAgent("answerer", { defaults: { runtimePermissions: { profile: "full-access" } } });
    const record: ContextRecord = {
      ...context(materializeSubjectCapabilities("agent", "answerer")),
      agentId: "answerer",
    };

    const result = runWithContext({ agentId: "answerer", context: record }, () =>
      enforceCliCommandAuthorization({
        group: "sessions",
        command: "answer",
        access,
        input: { target: "other-session", message: "done" },
        source: "gateway",
        scope: "open",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.decision).toMatchObject({ permission: "mutate", objectType: "sessions", objectId: "answer" });
  });

  it("tells a denied sessions answer caller the check was global, not about the target session", () => {
    const access = getCommandAccessMetadata(SessionCommands).get("answer");
    if (!access) throw new Error("Missing @CommandAccess metadata for sessions answer");

    const record = context([{ permission: "read", objectType: "sessions", objectId: "answer" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAuthorization({
        group: "sessions",
        command: "answer",
        access,
        input: { target: "asker-session", message: "done" },
        source: "gateway",
        scope: "open",
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("Missing capability: mutate:sessions:answer");
    expect(result.errorMessage).toContain(
      "Scope: global capability check; no target resource (session, chat, agent) was checked",
    );
    expect(result.errorMessage).not.toContain("asker-session");
    expect(result.attempted.every((decision) => decision.objectId !== "asker-session")).toBe(true);
  });

  it("lists every pages @CommandAccess candidate and a concrete allow command", () => {
    dbCreateTagDefinition({
      slug: "permission-pages-publisher",
      label: "Pages Publisher",
      kind: "system",
      source: "permissions",
      metadata: {
        permissions: {
          capabilities: ["execute:group:pages"],
        },
      },
    });

    const record = context([]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "pages",
        command: "ship",
        access: { kind: "mutate", resource: "pages", action: "ship", risk: "high" },
        source: "gateway",
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorMessage).toContain("Missing capability: mutate:pages:ship");
    expect(result.errorMessage).toContain(
      "Required candidates: mutate:pages:ship, mutate:pages:*, mutate:pages.ship:*, execute:group:pages_ship, execute:group:pages",
    );
    expect(result.errorMessage).toContain("ravi permissions allow permission-pages-publisher --to agent:dev --apply");
  });

  it("authorizes pages ship through a materialized execute:group:pages ceiling", () => {
    const record = context([{ permission: "execute", objectType: "group", objectId: "pages" }]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "pages",
        command: "ship",
        access: { kind: "mutate", resource: "pages", action: "ship", risk: "high" },
        source: "tool",
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.decision?.permission).toBe("execute");
    expect(result.decision?.objectType).toBe("group");
    expect(result.decision?.objectId).toBe("pages");
  });

  it("records and emits audit denied for runtime command access denies", async () => {
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    const record = context([]);
    const result = runWithContext({ agentId: "dev", context: record }, () =>
      enforceCliCommandAccess({
        group: "demo",
        command: "create",
        access: ACCESS,
        source: "gateway",
      }),
    );
    await flushPermissionAuditEvents();

    expect(result.allowed).toBe(false);
    expect(auditEvents).toEqual([
      {
        topic: "ravi.audit.denied",
        data: expect.objectContaining({
          type: "scope",
          agentId: "dev",
          denied: "mutate:demo.items:create",
          blockType: "cli_command_access_missing_grant",
          command: "[REDACTED:content length=11]",
          denialId: expect.any(Number),
          guidance: expect.objectContaining({ resourceScope: { kind: "global" } }),
          context: expect.objectContaining({
            contextId: "ctx_command_access_test",
            authorityMode: "delegated",
          }),
        }),
      },
    ]);
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "dev", resolved: false })).toContainEqual(
      expect.objectContaining({
        relation: "mutate",
        objectType: "demo.items",
        objectId: "create",
        command: "[REDACTED:content length=11]",
        notifiedAt: expect.any(Number),
      }),
    );
  });
});

describe("CLI command authorization call-site policy", () => {
  it("keeps CLI, tools, and gateway on the shared authorization pipeline", () => {
    for (const relativePath of ["src/cli/registry.ts", "src/cli/tools-export.ts", "src/sdk/gateway/dispatcher.ts"]) {
      const contents = readFileSync(join(process.cwd(), relativePath), "utf8");
      expect(contents).toContain("enforceCliCommandAuthorization");
      expect(contents).not.toContain("enforceScopeCheck");
    }
  });
});
