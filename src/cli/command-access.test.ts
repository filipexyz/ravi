import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runWithContext } from "./context.js";
import { buildCliCommandOperation, enforceCliCommandAccess } from "./command-access.js";
import type { CommandAccessOptions } from "./decorators.js";
import { createRuntimeContext } from "../runtime/context-registry.js";
import { emptyCredentialsFile, upsertCredentialsEntry, writeCredentialsFile } from "../runtime/credentials-store.js";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  RAVI_RUNTIME_CONTEXT_ENV_KEYS,
} from "../test/ravi-state.js";
import type { ContextRecord } from "../router/router-db.js";
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
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-cli-command-access-test-");
    previousEnv = {};
    previousCredentialsPath = process.env.RAVI_CREDENTIALS_PATH;
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
    expect(result.errorMessage).toContain("permission-demo-writer");
    expect(result.errorMessage).toContain("full-access is break-glass");
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
          denialId: expect.any(Number),
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
        command: "demo create",
        notifiedAt: expect.any(Number),
      }),
    );
  });
});
