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
    expect(result.decision?.providerId).toBe("local-operator");
    expect(result.decision?.objectId).toBe("demo_create");
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
    expect(result.decision?.providerId).toBe("local-operator");
    expect(result.decision?.objectId).toBe("demo_create");
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

  it("authorizes runtime contexts through command-specific capabilities first", () => {
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
    expect(result.decision?.objectId).toBe("demo_create");
  });

  it("falls back to group-level capabilities for command execution", () => {
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
    expect(result.attempted.map((decision) => decision.objectId)).toEqual(["demo_create", "demo"]);
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
    expect(result.attempted).toHaveLength(2);
    expect(result.attempted.every((decision) => decision.providerId === "context-capabilities")).toBe(true);
  });
});
