import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { createContact, getContact } from "../../contacts.js";
import { recordPermissionDenial } from "../../permissions/denials.js";
import { readAgentRuntimePermissionsConfig } from "../../permissions/agent-runtime-permissions-provider.js";
import { dbCreateAgent } from "../../router/router-db.js";
import { dbCreateTagDefinition, dbGetTagDefinition } from "../../tags/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";

afterAll(() => mock.restore());

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../../permissions/provider-registry.js", () => ({
  getConfiguredPermissionProviders: () => [
    { id: "local-operator", version: "bootstrap", required: true },
    { id: "context-capabilities", version: "snapshot/v1", required: true },
  ],
  getConfiguredCapabilityMaterializers: () => [
    { id: "runtime-bootstrap", version: "bootstrap/v1", required: true },
    { id: "agent-runtime-permissions", version: "agent-defaults/v1", required: true },
    { id: "agent-identity-permissions", version: "agent-identity/v1", required: true },
    { id: "contact-policy-permissions", version: "contact-tags/v1", required: true },
  ],
}));

mock.module("../../permissions/provider-runtime.js", () => ({
  authorizePermission: (request: {
    localOperator?: boolean;
    permission: string;
    objectType: string;
    objectId: string;
  }) => ({
    decision: request.localOperator ? "allow" : "deny",
    allowed: request.localOperator === true,
    providerId: request.localOperator ? "local-operator" : "provider-runtime",
    providerVersion: request.localOperator ? "bootstrap" : "runtime",
    reasonCode: request.localOperator ? "local_operator_no_subject" : "no_permission_provider_configured",
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
  }),
  materializeSubjectCapabilities: (subjectType: string, subjectId: string) =>
    subjectType === "agent" && subjectId === "main"
      ? [{ permission: "view", objectType: "agent", objectId: "*", source: "agent-runtime-permissions:agent:main" }]
      : [],
}));

const { PermissionsCommands } = await import("./permissions.js");

describe("PermissionsCommands provider-runtime surface", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permissions-commands-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("reports provider-owned permission orchestration enabled", () => {
    const commands = new PermissionsCommands();
    const payload = commands.status(true);

    expect(payload).toMatchObject({
      status: "provider-runtime",
      mutationCommands: { enabled: true },
      authorizationProviders: [{ id: "local-operator" }, { id: "context-capabilities" }],
      capabilityMaterializers: [
        { id: "runtime-bootstrap" },
        { id: "agent-runtime-permissions" },
        { id: "agent-identity-permissions" },
        { id: "contact-policy-permissions" },
      ],
    });
  });

  it("checks permissions through provider-runtime only", () => {
    const commands = new PermissionsCommands();
    const denied = commands.check("execute", "group", "agents", undefined, true);
    const allowed = commands.check("execute", "group", "agents", true, true);

    expect(denied.allowed).toBe(false);
    expect(denied.decision.providerId).toBe("provider-runtime");
    expect(allowed.allowed).toBe(true);
    expect(allowed.decision.providerId).toBe("local-operator");
  });

  it("suggests matching provider-owned permission tags for denied checks", () => {
    dbCreateTagDefinition({
      slug: "permission-family",
      label: "Family Image",
      kind: "system",
      source: "permissions",
      metadata: {
        permissions: {
          capabilities: ["mutate:image:generate"],
        },
      },
    });

    const commands = new PermissionsCommands();
    const denied = commands.check("mutate", "image", "generate", undefined, true);

    expect(denied.allowed).toBe(false);
    expect(denied.guidance).toMatchObject({
      canonicalCapability: "mutate:image:generate",
      preferredPath: {
        suggestedTags: [
          {
            slug: "permission-family",
            label: "Family Image",
            capabilities: ["mutate:image:generate"],
          },
        ],
      },
      requestShape: {
        profileOrTag: "permission tag permission-family",
      },
    });
  });

  it("materializes provider-owned subject capabilities", () => {
    const commands = new PermissionsCommands();
    const payload = commands.materialize("agent", "main", true);

    expect(payload).toEqual({
      subject: { type: "agent", id: "main" },
      capabilities: [
        {
          permission: "view",
          objectType: "agent",
          objectId: "*",
          source: "agent-runtime-permissions:agent:main",
        },
      ],
      guidance: {
        recurringAccess:
          "Recurring access should come from provider-owned agent identity profiles/tags, not ad-hoc capability lists.",
        breakGlass: "full-access is break-glass and should be explicit.",
      },
    });
  });

  it("plans permission profile application without mutating provider-owned state", () => {
    const contact = createContact({ phone: "+15550000001", name: "Permission Test User" });
    dbCreateAgent({ id: "workflow-agent", cwd: "/tmp" });

    const commands = new PermissionsCommands();
    const payload = commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      "workflow-agent",
      "mutate:image:generate",
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(payload).toMatchObject({
      dryRun: true,
      tagSlug: "permission-image-workflow",
      capabilities: [{ permission: "mutate", objectType: "image", objectId: "generate" }],
      targets: [{ type: "contact", id: contact.id }],
      agentCeilings: ["workflow-agent"],
    });
    expect(payload.operations.every((operation) => operation.status === "planned")).toBe(true);
    expect(dbGetTagDefinition("permission-image-workflow")).toBeNull();
    expect(getContact(contact.id)?.tags).not.toContain("permission-image-workflow");
    expect(readAgentRuntimePermissionsConfig("workflow-agent")).toBeNull();
  });

  it("applies permission profiles through contact policy tags and agent runtime ceilings", () => {
    const contact = createContact({ phone: "+15550000002", name: "Permission Apply User" });
    dbCreateAgent({ id: "apply-agent", cwd: "/tmp" });

    const commands = new PermissionsCommands();
    const payload = commands.allow(
      "image workflow",
      `contact:${contact.id}`,
      "apply-agent",
      "mutate:image:generate",
      undefined,
      undefined,
      true,
      true,
    );

    expect(payload.dryRun).toBe(false);
    expect(payload.changedCount).toBe(3);
    expect(dbGetTagDefinition("permission-image-workflow")?.metadata).toMatchObject({
      permissions: { capabilities: ["mutate:image:generate"] },
    });
    expect(getContact(contact.id)?.tags).toContain("permission-image-workflow");
    expect(readAgentRuntimePermissionsConfig("apply-agent")?.capabilities).toEqual([
      { permission: "mutate", objectType: "image", objectId: "generate" },
    ]);
  });

  it("resolves an agent-identity denial into an agent-owned recurring profile workflow", () => {
    const contact = createContact({ phone: "+15550000003", name: "Permission Resolve User" });
    dbCreateAgent({ id: "resolve-agent", cwd: "/tmp" });
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "resolve-agent",
      relation: "execute",
      objectType: "executable",
      objectId: "curl",
      agentId: "resolve-agent",
      sessionName: "workflow-session",
      contextId: "ctx_permission_resolve_test",
      detail: {
        context: {
          authorityMode: "agent-identity",
          actorPrincipal: `contact:${contact.id}`,
          executorAgentId: "resolve-agent",
          agentIdentityPrincipal: "agent_identity:resolve-agent:chat:chat_alpha",
        },
      },
    });
    expect(denial).not.toBeNull();

    const commands = new PermissionsCommands();
    const payload = commands.resolve(String(denial!.id), "publishing workflow", undefined, true, true);

    expect(payload).toMatchObject({
      dryRun: false,
      tagSlug: "permission-publishing-workflow",
      denial: {
        id: denial!.id,
        missingCapability: "execute:executable:curl",
        subject: "agent:resolve-agent",
      },
      capabilities: [{ permission: "execute", objectType: "executable", objectId: "curl" }],
      targets: [{ type: "agent", id: "resolve-agent" }],
      agentCeilings: [],
    });
    expect(getContact(contact.id)?.tags).not.toContain("permission-publishing-workflow");
    expect(readAgentRuntimePermissionsConfig("resolve-agent")?.capabilities).toEqual([
      { permission: "execute", objectType: "executable", objectId: "curl" },
    ]);
  });
});
