import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { runWithContext } from "../cli/context.js";
import { createContact } from "../contacts.js";
import { dbCreateAgent, dbUpdateAgent, type ContextRecord } from "../router/router-db.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getConfiguredCapabilityMaterializers, getConfiguredPermissionProviders } from "./provider-registry.js";
import {
  agentCan,
  authorizePermission,
  canWithCapabilities,
  canWithCapabilityContext,
  can,
  localOperatorCan,
  materializeSubjectCapabilities,
} from "./provider-runtime.js";
import { ensureAgentCanViewAgent, ensureAgentCanViewAllAgents } from "./agent-runtime-permissions-provider.js";

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

  it("does not authorize direct subject checks without a provider-owned context", () => {
    expect(agentCan("dev", "use", "app", "apps")).toBe(false);

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

  it("materializes bootstrap capabilities without removed mutation commands", () => {
    const capabilities = materializeSubjectCapabilities("agent", "dev");

    expect(capabilities).toContainEqual({
      permission: "use",
      objectType: "tool",
      objectId: "*",
      source: "runtime-bootstrap:agent",
    });
    expect(canWithCapabilities(capabilities, "execute", "executable", "omni")).toBe(false);
    expect(
      authorizePermission({
        subject: { type: "agent", id: "dev" },
        permission: "execute",
        objectType: "group",
        objectId: "sessions",
      }).allowed,
    ).toBe(false);
  });

  it("stores agent visibility in provider-owned runtime permission defaults", () => {
    dbCreateAgent({ id: "creator", cwd: "/tmp/creator" });
    dbCreateAgent({ id: "created", cwd: "/tmp/created" });

    expect(can("agent", "creator", "view", "agent", "created")).toBe(false);
    expect(ensureAgentCanViewAgent("creator", "created")).toBe(true);
    expect(ensureAgentCanViewAgent("creator", "created")).toBe(false);

    const capabilities = materializeSubjectCapabilities("agent", "creator");
    expect(capabilities).toContainEqual({
      permission: "view",
      objectType: "agent",
      objectId: "created",
      source: "agent-runtime-permissions:agent:creator",
    });
  });

  it("can backfill default-agent visibility for all agents through provider-owned config", () => {
    dbCreateAgent({ id: "worker", cwd: "/tmp/worker" });

    expect(ensureAgentCanViewAllAgents("main")).toBe(false);
    const capabilities = materializeSubjectCapabilities("agent", "main");
    expect(capabilities).toContainEqual({
      permission: "view",
      objectType: "agent",
      objectId: "*",
      source: "agent-runtime-permissions:agent:main",
    });
    expect(canWithCapabilities(capabilities, "view", "agent", "worker")).toBe(true);
  });

  it("materializes declarative full-access agent profiles from agent defaults", () => {
    dbCreateAgent({ id: "trusted-agent", cwd: "/tmp/trusted-agent" });
    dbUpdateAgent("trusted-agent", {
      defaults: { runtimePermissions: { profile: "full-access" } },
    });

    const capabilities = materializeSubjectCapabilities("agent", "trusted-agent");

    expect(capabilities).toContainEqual({
      permission: "admin",
      objectType: "system",
      objectId: "*",
      source: "agent-runtime-permissions:agent:trusted-agent",
    });
    expect(canWithCapabilities(capabilities, "execute", "executable", "omni")).toBe(true);
  });

  it("materializes explicit agent runtime capabilities without growing the bootstrap allowlist", () => {
    dbCreateAgent({ id: "omni-agent", cwd: "/tmp/omni-agent" });
    dbUpdateAgent("omni-agent", {
      defaults: { runtimePermissions: { capabilities: ["execute:executable:omni"] } },
    });

    const capabilities = materializeSubjectCapabilities("agent", "omni-agent");

    expect(capabilities).toContainEqual({
      permission: "execute",
      objectType: "executable",
      objectId: "omni",
      source: "agent-runtime-permissions:agent:omni-agent",
    });
    expect(canWithCapabilities(materializeSubjectCapabilities("agent", "dev"), "execute", "executable", "omni")).toBe(
      false,
    );
  });

  it("materializes compartment-scoped agent identity capabilities from the executor agent", () => {
    dbCreateAgent({ id: "workspace-agent", cwd: "/tmp/workspace-agent" });
    dbUpdateAgent("workspace-agent", {
      defaults: { runtimePermissions: { capabilities: ["mutate:image:generate"] } },
    });

    const capabilities = materializeSubjectCapabilities("agent_identity", "workspace-agent:chat:chat_alpha", {
      executorAgentId: "workspace-agent",
      compartmentType: "chat",
      compartmentId: "chat_alpha",
    });

    expect(capabilities).toContainEqual({
      permission: "mutate",
      objectType: "image",
      objectId: "generate",
      source: "agent-identity:workspace-agent:chat:chat_alpha:executor",
    });
    expect(canWithCapabilities(capabilities, "use", "tool", "Read")).toBe(true);
    expect(canWithCapabilities(capabilities, "mutate", "image", "generate")).toBe(true);
    expect(canWithCapabilities(capabilities, "admin", "system", "*")).toBe(false);
  });

  it("materializes admin authority for allowed admin-tagged contacts", () => {
    const contact = createContact({
      phone: "5511999990000",
      name: "Owner",
      tags: ["permission.admin"],
      status: "allowed",
    });

    const capabilities = materializeSubjectCapabilities("contact", contact.id);

    expect(capabilities).toContainEqual({
      permission: "admin",
      objectType: "system",
      objectId: "*",
      source: `contact-policy:contact:${contact.id}:admin-tag`,
    });
    expect(canWithCapabilities(capabilities, "execute", "group", "pages")).toBe(true);
  });

  it("does not materialize admin authority from generic contact tags", () => {
    const contact = createContact({
      phone: "5511999990001",
      name: "CRM Admin",
      tags: ["admin"],
      status: "allowed",
    });

    const capabilities = materializeSubjectCapabilities("contact", contact.id);

    expect(capabilities).toEqual([]);
  });

  it("materializes scoped family image authority for allowed family-tagged contacts", () => {
    dbCreateTagDefinition({
      slug: "permission-family",
      label: "Family Image",
      kind: "system",
      source: "permissions",
      metadata: {
        permissions: {
          capabilities: [
            "mutate:image:generate",
            "use:tool:image_generate",
            "use:tool:Bash",
            "execute:executable:ravi",
            "read:skills:show",
            "read:context:codex-bash-hook",
            "read:sessions:actions",
          ],
        },
      },
    });
    const contact = createContact({
      phone: "5511999990002",
      name: "Family Member",
      tags: ["permission.family"],
      status: "allowed",
    });

    const capabilities = materializeSubjectCapabilities("contact", contact.id);

    expect(capabilities).toContainEqual({
      permission: "mutate",
      objectType: "image",
      objectId: "generate",
      source: `contact-policy:contact:${contact.id}:tag:permission-family`,
    });
    expect(capabilities).toContainEqual({
      permission: "use",
      objectType: "tool",
      objectId: "image_generate",
      source: `contact-policy:contact:${contact.id}:tag:permission-family`,
    });
    expect(capabilities).toContainEqual({
      permission: "use",
      objectType: "tool",
      objectId: "Bash",
      source: `contact-policy:contact:${contact.id}:tag:permission-family`,
    });
    expect(capabilities).toContainEqual({
      permission: "execute",
      objectType: "executable",
      objectId: "ravi",
      source: `contact-policy:contact:${contact.id}:tag:permission-family`,
    });
    expect(canWithCapabilities(capabilities, "mutate", "image", "generate")).toBe(true);
    expect(canWithCapabilities(capabilities, "read", "skills", "show")).toBe(true);
    expect(canWithCapabilities(capabilities, "read", "context", "codex-bash-hook")).toBe(true);
    expect(canWithCapabilities(capabilities, "read", "sessions", "actions")).toBe(true);
    expect(canWithCapabilities(capabilities, "admin", "system", "*")).toBe(false);
    expect(canWithCapabilities(capabilities, "mutate", "mail", "send")).toBe(false);
  });

  it("does not materialize family image authority for pending family-tagged contacts", () => {
    dbCreateTagDefinition({
      slug: "permission-family",
      label: "Family Image",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["mutate:image:generate"] } },
    });
    const contact = createContact({
      phone: "5511999990003",
      name: "Pending Family Member",
      tags: ["permission.family"],
      status: "pending",
    });

    expect(materializeSubjectCapabilities("contact", contact.id)).toEqual([]);
  });

  it("does not materialize permission tags without a provider-owned tag definition", () => {
    const contact = createContact({
      phone: "5511999990004",
      name: "Undefined Family Member",
      tags: ["permission.family"],
      status: "allowed",
    });

    expect(materializeSubjectCapabilities("contact", contact.id)).toEqual([]);
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

  it("keeps provider-owned config behind the materializer chain", () => {
    expect(getConfiguredPermissionProviders().map((provider) => provider.id)).toEqual([
      "local-operator",
      "context-capabilities",
    ]);
    expect(getConfiguredCapabilityMaterializers().map((provider) => provider.id)).toEqual([
      "runtime-bootstrap",
      "agent-runtime-permissions",
      "agent-identity-permissions",
      "contact-policy-permissions",
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

    expect(/from\s+["']\.\/(?:engine|capability-context)(?:\.js)?["']/.test(contents)).toBe(false);
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
