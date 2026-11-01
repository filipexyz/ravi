import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { BridgeStore } from "./store.js";
import { BridgeService } from "./service.js";
import { withConsoleInvocation, type ConsoleInvocation } from "../sdk/gateway/console-context.js";
import { CONSOLE_PROTOCOL } from "../sdk/gateway/console-contract.js";
import { acceptCatalogDelegation } from "../sdk/gateway/console-catalog-authority.js";
import { permissionCatalog } from "./permission-catalog.js";
import { dbCreateAgent } from "../router/router-db.js";
function fixture(resource: string, action: string, kind: "read" | "mutate" = "read"): ConsoleInvocation {
  const store = new BridgeStore(":memory:"),
    enrollment = {
      id: randomUUID(),
      orgId: randomUUID(),
      installationId: randomUUID(),
      runtimeId: randomUUID(),
      issuer: "https://fixture.test",
      issuerPublicKey: "unused",
      issuerKeyId: "unused",
      epoch: 1,
      active: true,
    };
  store.putEnrollment(enrollment);
  const grant = {
    protocol: CONSOLE_PROTOCOL,
    orgId: enrollment.orgId,
    installationId: enrollment.installationId,
    enrollmentId: enrollment.id,
    epoch: 1,
    projectId: randomUUID(),
    connectionId: randomUUID(),
    policyRevision: 1,
    policyDigest: "a".repeat(64),
    origin: { kind: "browser" as const, sessionId: "fixture" },
    operationId: randomUUID(),
    createdAt: Date.now(),
    requestDigest: "a".repeat(64),
    command: `${resource}.${action}`,
    access: { kind, resource, action },
    scope: { kind: "installation" as const },
    agents: [{ id: "desktop-fixture", capabilities: [], approvalCapabilities: [] }],
    canSend: true,
    canApprove: false,
    sub: randomUUID(),
    iss: enrollment.issuer,
    jti: randomUUID(),
    exp: Math.floor(Date.now() / 1000) + 30,
  };
  const service = new BridgeService(store, enrollment.runtimeId, "fixture", {
    agents: () => [],
    start: async () => {},
    cancel: () => false,
  });
  service.acceptDelegation(grant);
  return { grant, enrollment, service };
}

test("catalog metadata has no execution authority, secrets or effect on conversation revision heads", async () => {
  await expect(permissionCatalog()).rejects.toThrow("CONSOLE_AUTHORITY_REQUIRED");
  dbCreateAgent({
    id: "catalog-fixture",
    name: "Catalog agent",
    cwd: "/private-catalog-sentinel",
    systemPromptAppend: "SECRET_SENTINEL",
  });
  const value = fixture("sessions.conversations", "list");
  const original = value.grant.policyRevision;
  value.grant = {
    ...value.grant,
    command: "desktop.permissions.catalog",
    access: { kind: "read", resource: "desktop.permissions", action: "catalog" },
    agents: [],
    canSend: false,
    canApprove: false,
    policyRevision: original + 1,
  };
  acceptCatalogDelegation(value.service, value.grant);
  const result = await withConsoleInvocation(value, () => permissionCatalog());
  expect(result.agents.find((a) => a.id === "catalog-fixture")).toEqual({
    id: "catalog-fixture",
    name: "Catalog agent",
  });
  expect(result.actions.some((a) => a.capability.objectType === "tool" && a.capability.objectId === "Bash")).toBe(true);
  expect(result.actions.some((a) => a.category === "command" && a.capability.objectType === "agents")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
  expect(JSON.stringify(result)).not.toContain("/private-catalog-sentinel");
  expect(
    result.actions.every(
      (a) => !/[?*]/.test(a.capability.objectId) || a.capability.objectType === "context.bridge-tool-hook",
    ),
  ).toBe(true);
  expect(
    value.service.store.db.query("SELECT revision FROM delegation_heads WHERE project_id=?").get(value.grant.projectId),
  ).toEqual({ revision: original });
  expect(() => acceptCatalogDelegation(value.service, { ...value.grant, canSend: true })).toThrow("INVALID_DELEGATION");
  expect(() => acceptCatalogDelegation(value.service, { ...value.grant, policyRevision: original })).toThrow(
    "STALE_DELEGATION",
  );
  value.grant.exp = 1;
  await expect(withConsoleInvocation(value, () => permissionCatalog())).rejects.toThrow("CONSOLE_AUTHORITY_REQUIRED");
  value.service.store.close();
});
