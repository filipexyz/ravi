import { afterAll, describe, expect, it, mock } from "bun:test";

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
  it("reports mutation commands disabled", () => {
    const commands = new PermissionsCommands();
    const payload = commands.status(true);

    expect(payload).toMatchObject({
      status: "provider-runtime",
      mutationCommands: { enabled: false },
      authorizationProviders: [{ id: "local-operator" }, { id: "context-capabilities" }],
      capabilityMaterializers: [
        { id: "runtime-bootstrap" },
        { id: "agent-runtime-permissions" },
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
    });
  });
});
