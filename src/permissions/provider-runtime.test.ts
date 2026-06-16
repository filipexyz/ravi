import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { runWithContext } from "../cli/context.js";
import type { ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getConfiguredCapabilityMaterializers, getConfiguredPermissionProviders } from "./provider-registry.js";
import {
  agentCan,
  authorizePermission,
  canWithCapabilities,
  canWithCapabilityContext,
  localOperatorCan,
  materializeSubjectCapabilities,
} from "./provider-runtime.js";
import { grantRelation } from "./relations.js";

let stateDir: string | null = null;

describe("Permission Provider Runtime", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permission-provider-runtime-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("does not infer local operator authority from a missing subject", () => {
    const decision = authorizePermission({
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.providerId).toBe("provider-runtime");
    expect(decision.reasonCode).toBe("no_permission_provider_configured");
    expect(agentCan(undefined, "execute", "group", "daemon")).toBe(false);
  });

  it("keeps explicit direct operator calls in the bootstrap provider", () => {
    const decision = authorizePermission({
      localOperator: true,
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
    });

    expect(decision.allowed).toBe(true);
    expect(decision.providerId).toBe("local-operator");
    expect(decision.reasonCode).toBe("local_operator_no_subject");
    expect(decision.requestId).toBeString();
    expect(decision.durationMs).toBeGreaterThanOrEqual(0);
    expect(localOperatorCan("execute", "group", "daemon")).toBe(true);
  });

  it("does not read local grants from the default provider chain", () => {
    expect(agentCan("dev", "use", "app", "apps")).toBe(false);

    grantRelation("agent", "dev", "use", "app", "apps", "test");

    const decision = authorizePermission({
      subject: { type: "agent", id: "dev" },
      permission: "use",
      objectType: "app",
      objectId: "apps",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.providerId).toBe("provider-runtime");
    expect(decision.reasonCode).toBe("no_permission_provider_configured");
    expect(agentCan("dev", "use", "app", "apps")).toBe(false);
  });

  it("keeps local grants out of default capability materialization", () => {
    grantRelation("agent", "dev", "execute", "group", "sessions", "test");

    const capabilities = materializeSubjectCapabilities("agent", "dev");

    expect(capabilities).not.toContainEqual({
      permission: "execute",
      objectType: "group",
      objectId: "sessions",
      source: "test",
    });
    expect(capabilities).toContainEqual({
      permission: "use",
      objectType: "tool",
      objectId: "*",
      source: "runtime-bootstrap:agent",
    });
    expect(
      authorizePermission({
        subject: { type: "agent", id: "dev" },
        permission: "execute",
        objectType: "group",
        objectId: "sessions",
      }).allowed,
    ).toBe(false);
  });

  it("does not bootstrap actor or surface principals by default", () => {
    expect(materializeSubjectCapabilities("contact", "luis")).toEqual([]);
    expect(materializeSubjectCapabilities("chat", "chat_group_1")).toEqual([]);
  });

  it("authorizes runtime contexts through the provider facade", () => {
    const context: ContextRecord = {
      contextId: "ctx_provider_runtime",
      contextKey: "ctx_key_provider_runtime",
      kind: "turn-runtime",
      agentId: "dev",
      capabilities: [{ permission: "use", objectType: "tool", objectId: "Read" }],
      metadata: { authorityMode: "delegated" },
      createdAt: 0,
    };

    const allowed = authorizePermission({
      context,
      permission: "use",
      objectType: "tool",
      objectId: "Read",
    });
    const denied = authorizePermission({
      context,
      permission: "use",
      objectType: "tool",
      objectId: "Bash",
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.providerId).toBe("context-capabilities");
    expect(allowed.reasonCode).toBe("context_capabilities_allow");
    expect(allowed.contextId).toBe("ctx_provider_runtime");
    expect(denied.allowed).toBe(false);
    expect(canWithCapabilityContext(context, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilityContext(context, "use", "tool", "Bash")).toBe(false);
  });

  it("keeps capability snapshots available through the provider facade", () => {
    const capabilities = [{ permission: "access", objectType: "session", objectId: "dev-*" }];

    expect(canWithCapabilities(capabilities, "access", "session", "dev-main")).toBe(true);
    expect(canWithCapabilities(capabilities, "access", "session", "main")).toBe(false);
  });

  it("uses the ambient runtime context for agent helper checks", () => {
    const context: ContextRecord = {
      contextId: "ctx_agent_helper",
      contextKey: "ctx_key_agent_helper",
      kind: "agent-runtime",
      agentId: "dev",
      capabilities: [{ permission: "execute", objectType: "group", objectId: "sessions_info" }],
      metadata: {},
      createdAt: 0,
    };

    const allowed = runWithContext({ agentId: "dev", context }, () =>
      agentCan("dev", "execute", "group", "sessions_info"),
    );
    const denied = runWithContext({ agentId: "dev", context }, () => agentCan("dev", "execute", "group", "daemon"));

    expect(allowed).toBe(true);
    expect(denied).toBe(false);
  });

  it("does not treat an empty subject as a local operator", () => {
    const decision = authorizePermission({
      subject: { type: "agent", id: "" },
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.providerId).toBe("provider-runtime");
    expect(decision.reasonCode).toBe("no_permission_provider_configured");
  });

  it("fails closed when no provider is configured for a request", () => {
    const decision = authorizePermission(
      {
        requestId: "perm_req_test_no_provider",
        subject: { type: "agent", id: "dev" },
        permission: "use",
        objectType: "tool",
        objectId: "Bash",
      },
      { providers: [] },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.providerId).toBe("provider-runtime");
    expect(decision.reasonCode).toBe("no_permission_provider_configured");
    expect(decision.requestId).toBe("perm_req_test_no_provider");
    expect(decision.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the runtime request id through providers and decisions", () => {
    let observedRequestId: string | undefined;
    const decision = authorizePermission(
      {
        requestId: "perm_req_test_provider",
        subject: { type: "agent", id: "dev" },
        permission: "execute",
        objectType: "group",
        objectId: "sessions",
      },
      {
        providers: [
          {
            id: "test-provider",
            version: "test/v1",
            required: true,
            supports: () => true,
            authorize(request) {
              observedRequestId = request.requestId;
              return {
                decision: "allow",
                allowed: true,
                providerId: "test-provider",
                providerVersion: "test/v1",
                reasonCode: "test_allow",
                permission: request.permission,
                objectType: request.objectType,
                objectId: request.objectId,
              };
            },
          },
        ],
      },
    );

    expect(observedRequestId).toBe("perm_req_test_provider");
    expect(decision.requestId).toBe("perm_req_test_provider");
    expect(decision.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("Permission Provider Runtime boundaries", () => {
  it("keeps the deleted native engine out of the source tree", () => {
    expect(existsSync(join(process.cwd(), "src/permissions/engine.ts"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/permissions/engine.test.ts"))).toBe(false);
  });

  it("keeps relation-store grants out of the default authorization chain", () => {
    expect(getConfiguredPermissionProviders().map((provider) => provider.id)).toEqual([
      "local-operator",
      "context-capabilities",
    ]);
    expect(getConfiguredCapabilityMaterializers().map((provider) => provider.id)).toEqual([
      "runtime-bootstrap",
      "local-grants",
    ]);
  });

  it("keeps production authorization callers off direct grant engines and stores", () => {
    const offenders = listSourceFiles(join(process.cwd(), "src"))
      .filter((file) => {
        const rel = toRepoRelative(file);
        if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) return false;
        if (rel.startsWith("src/permissions/")) return false;
        return importsDirectGrantInternals(file);
      })
      .map(toRepoRelative);

    expect(offenders).toEqual([]);
  });

  it("keeps the provider runtime facade off direct grant engines and stores", () => {
    const contents = readFileSync(join(process.cwd(), "src/permissions/provider-runtime.ts"), "utf8");

    expect(
      /from\s+["']\.\/(?:engine|capability-context|relations|local-grants-provider)(?:\.js)?["']/.test(contents),
    ).toBe(false);
  });

  it("keeps app provider execution private behind the provider-runtime facade", () => {
    const offenders = listSourceFiles(join(process.cwd(), "src"))
      .filter((file) => {
        const rel = toRepoRelative(file);
        if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) return false;
        if (rel === "src/permissions/provider-runtime.ts") return false;
        if (rel === "src/permissions/app-permission-provider-runtime.ts") return false;
        return readFileSync(file, "utf8").includes("app-permission-provider-runtime");
      })
      .map(toRepoRelative);

    expect(offenders).toEqual([]);
  });

  it("keeps app permission provider execution outside the app router", () => {
    const contents = readFileSync(join(process.cwd(), "src/apps/router.ts"), "utf8");

    expect(contents).not.toContain("APP_PERMISSION_REQUEST_SCHEMA");
    expect(contents).not.toContain("buildPermissionProviderRequest");
    expect(contents).toContain('from "../permissions/provider-runtime.js"');
  });
});

function importsDirectGrantInternals(file: string): boolean {
  return importsDirectGrantInternalsSource(readFileSync(file, "utf8"));
}

function importsDirectGrantInternalsSource(contents: string): boolean {
  return /from\s+["'][^"']*permissions\/(?:engine|capability-context|relations)(?:\.js)?["']/.test(contents);
}

function listSourceFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...listSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && statSync(fullPath).isFile()) {
      result.push(fullPath);
    }
  }
  return result;
}

function toRepoRelative(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}
