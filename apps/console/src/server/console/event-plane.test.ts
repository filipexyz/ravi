import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";

import {
  assertEventPlaneCellAllowsBindingStatus,
  assertEventPlaneBindingTransition,
  assertEventPlaneCredentialGrantAllowed,
  assertEventPlaneCredentialGrantTransition,
  assertEventPlanePolicyVersionImmutable,
  assertExpectedVersion,
  assertNoPayloadApprovedBy,
  assertNoSecretLikeFields,
  assertOneActiveEventPlaneBinding,
  assertSafeReference,
  assertSafeSecretRef,
  authorizeEventPlaneControlRequest,
  EventPlaneControlError,
  eventPlaneApprovalActor,
  eventPlaneAuditSummaryView,
  eventPlaneCredentialGrantView,
  eventPlaneObservedCapacityAfterReconciliation,
  eventPlaneReconciliationReportView,
  eventPlaneRequestHash,
  getEventPlaneControlActor,
  getEventPlaneControlToken,
  isReusableEventPlaneIdentityStatus,
  resolveEventPlaneIdempotentResult,
  sanitizeEventPlaneSafeMetadata,
} from "./event-plane";

describe("Event Plane control-plane invariants", () => {
  test("rejects two active organization bindings for the same organization", () => {
    expect(() =>
      assertOneActiveEventPlaneBinding([
        { id: "binding_1", organizationId: "org_1", status: "active" },
        { id: "binding_2", organizationId: "org_1", status: "active" },
      ]),
    ).toThrow(EventPlaneControlError);

    expect(() =>
      assertOneActiveEventPlaneBinding([
        { id: "binding_1", organizationId: "org_1", status: "active" },
        { id: "binding_2", organizationId: "org_1", status: "suspended" },
        { id: "binding_3", organizationId: "org_2", status: "active" },
      ]),
    ).not.toThrow();
  });

  test("rejects invalid binding lifecycle transitions", () => {
    expect(() => assertEventPlaneBindingTransition("active", "provisioning")).toThrow(EventPlaneControlError);
    expect(() => assertEventPlaneBindingTransition("deleted", "active")).toThrow(EventPlaneControlError);
    expect(() => assertEventPlaneBindingTransition("active", "suspended")).not.toThrow();
  });

  test("requires an active cell before binding activation", () => {
    expect(() => assertEventPlaneCellAllowsBindingStatus({ status: "provisioning" }, "provisioning")).not.toThrow();
    expect(() => assertEventPlaneCellAllowsBindingStatus({ status: "provisioning" }, "active")).toThrow(
      EventPlaneControlError,
    );
    expect(() => assertEventPlaneCellAllowsBindingStatus({ status: "active" }, "active")).not.toThrow();
  });

  test("requires exact expected versions for optimistic updates", () => {
    expect(assertExpectedVersion(3, 3)).toBe(3);
    expect(() => assertExpectedVersion(3, undefined)).toThrow(EventPlaneControlError);
    expect(() => assertExpectedVersion(3, 2)).toThrow(EventPlaneControlError);
  });

  test("returns duplicate desired-state requests idempotently only when the hash matches", () => {
    const requestHash = "sha256:abc";
    const response = {
      version: 1,
      binding: {
        id: "binding_1",
        organizationId: "org_1",
        status: "active",
      },
    };

    expect(resolveEventPlaneIdempotentResult(null, requestHash)).toEqual({ replay: false });
    expect(
      resolveEventPlaneIdempotentResult(
        { requestHash, response, status: "completed" },
        requestHash,
      ),
    ).toEqual({ replay: true, response });
    expect(() =>
      resolveEventPlaneIdempotentResult(
        { requestHash: "sha256:different", response, status: "completed" },
        requestHash,
      ),
    ).toThrow(EventPlaneControlError);
  });

  test("ignores body actor and lock fields in idempotency hashes", () => {
    const first = eventPlaneRequestHash("cell.register", {
      actor: { actorType: "user", actorId: "forged-user" },
      expectedVersion: 1,
      idempotencyKey: "idem_one",
      provider: "self_hosted_nats",
      providerRef: "ovh://event-plane/p0",
    });
    const second = eventPlaneRequestHash("cell.register", {
      actor: { actorType: "system", actorId: "different-claim" },
      expectedVersion: 99,
      idempotencyKey: "idem_two",
      provider: "self_hosted_nats",
      providerRef: "ovh://event-plane/p0",
    });

    expect(first).toBe(second);
  });

  test("denies issuance for suspended bindings while allowing terminal bookkeeping", () => {
    expect(() =>
      assertEventPlaneCredentialGrantAllowed({
        bindingStatus: "suspended",
        grantStatus: "issued",
        identityStatus: "active",
        secretRef: "vault://event-plane/grants/grant_1",
      }),
    ).toThrow(EventPlaneControlError);

    expect(() =>
      assertEventPlaneCredentialGrantAllowed({
        bindingStatus: "suspended",
        grantStatus: "revoked",
        identityStatus: "revoked",
      }),
    ).not.toThrow();
    expect(() =>
      assertEventPlaneCredentialGrantAllowed({
        bindingStatus: "suspended",
        grantStatus: "expired",
        identityStatus: "expired",
      }),
    ).not.toThrow();
    expect(() =>
      assertEventPlaneCredentialGrantAllowed({
        bindingStatus: "suspended",
        grantStatus: "failed",
        identityStatus: "failed",
      }),
    ).not.toThrow();
    expect(() =>
      assertEventPlaneCredentialGrantAllowed({
        bindingStatus: "active",
        grantStatus: "issued",
        identityStatus: "active",
        secretRef: "vault://event-plane/grants/grant_1",
      }),
    ).not.toThrow();
  });

  test("enforces credential grant lifecycle transitions on updates", () => {
    expect(() => assertEventPlaneCredentialGrantTransition("issued", "active")).not.toThrow();
    expect(() => assertEventPlaneCredentialGrantTransition("active", "revoked")).not.toThrow();
    expect(() => assertEventPlaneCredentialGrantTransition("active", "expired")).not.toThrow();
    expect(() => assertEventPlaneCredentialGrantTransition("active", "pending")).toThrow(EventPlaneControlError);
    expect(() => assertEventPlaneCredentialGrantTransition("active", "issued")).toThrow(EventPlaneControlError);
    expect(() => assertEventPlaneCredentialGrantTransition("revoked", "active")).toThrow(EventPlaneControlError);
    expect(() => assertEventPlaneCredentialGrantTransition("expired", "issued")).toThrow(EventPlaneControlError);
    expect(() => assertEventPlaneCredentialGrantTransition("failed", "pending")).toThrow(EventPlaneControlError);
    expect(() => assertEventPlaneCredentialGrantTransition("failed", "active")).toThrow(EventPlaneControlError);
    expect(() => assertEventPlaneCredentialGrantTransition("revoked", "revoked")).not.toThrow();
    expect(() => assertEventPlaneCredentialGrantTransition("failed", "failed")).not.toThrow();
  });

  test("keeps failed identities reusable for stable Ravi identity ids", () => {
    expect(isReusableEventPlaneIdentityStatus("failed")).toBe(true);
    expect(isReusableEventPlaneIdentityStatus("revoked")).toBe(false);
    expect(isReusableEventPlaneIdentityStatus("expired")).toBe(false);
  });

  test("requires approved custody refs and rejects raw secret-shaped refs", () => {
    expect(() => assertSafeSecretRef("vault://event-plane/grants/grant_1")).not.toThrow();
    expect(() => assertSafeSecretRef("https://vault.example/grants/grant_1")).toThrow(EventPlaneControlError);
    expect(() => assertSafeSecretRef("vault://event-plane/grants/grant_1?token=raw")).toThrow(
      EventPlaneControlError,
    );
    expect(() => assertSafeReference("Bearer raw-provider-token", "provider_ref")).toThrow(EventPlaneControlError);
  });

  test("keeps secret-like fields out of safe metadata and grant projections", () => {
    expect(() => sanitizeEventPlaneSafeMetadata({ safe: "ok", nested: { token: "raw" } })).toThrow(
      EventPlaneControlError,
    );
    expect(() => assertNoSecretLikeFields({ credentials: { value: "raw" } })).toThrow(
      EventPlaneControlError,
    );

    const now = new Date("2026-07-15T12:00:00.000Z");
    const projection = eventPlaneCredentialGrantView({
      createdAt: now,
      deliveredAt: now,
      expiresAt: null,
      id: "grant_1",
      identityId: "identity_1",
      issuedAt: now,
      providerUserPublicKey: "UD_PUBLIC_ONLY",
      revokedAt: null,
      safeMetadataJson: { rotation: "initial" },
      secretRef: "vault://event-plane/grants/grant_1",
      status: "issued",
      version: 2,
      updatedAt: now,
    });

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("vault://event-plane/grants/grant_1");
    expect(serialized).not.toMatch(/secretRef|secret_ref|privateKey|token|credentials/i);
    expect(projection).toMatchObject({
      custodyRefPresent: true,
      providerUserPublicKey: "UD_PUBLIC_ONLY",
      recordVersion: 2,
      safeMetadata: { rotation: "initial" },
    });
  });

  test("derives approvals from the authenticated control actor and rejects payload attribution", () => {
    expect(eventPlaneApprovalActor({ actorType: "system", actorId: "event-plane-control-service:p0" })).toBe(
      "event-plane-control-service:p0",
    );
    expect(eventPlaneApprovalActor({ actorType: "system" })).toBe("system");
    expect(() => assertNoPayloadApprovedBy("spoofed-approver")).toThrow(EventPlaneControlError);
    expect(() => assertNoPayloadApprovedBy(null)).not.toThrow();
    expect(() => assertNoPayloadApprovedBy(undefined)).not.toThrow();
  });

  test("keeps policy versions immutable by scope type id and version", () => {
    expect(() => assertEventPlanePolicyVersionImmutable(null, "sha256:new")).not.toThrow();
    expect(() =>
      assertEventPlanePolicyVersionImmutable({ policyHash: "sha256:same" }, "sha256:same"),
    ).not.toThrow();
    expect(() =>
      assertEventPlanePolicyVersionImmutable({ policyHash: "sha256:old" }, "sha256:new"),
    ).toThrow(EventPlaneControlError);
  });

  test("schema and service source keep concurrency predicates explicit", async () => {
    const schemaSource = await Bun.file(new URL("../db/schema.ts", import.meta.url)).text();
    const serviceSource = await Bun.file(new URL("./event-plane.ts", import.meta.url)).text();
    const bindingMigration = await Bun.file(
      new URL("../../../drizzle/0032_fuzzy_sunfire.sql", import.meta.url),
    ).text();

    expect(schemaSource).toContain("event_plane_org_bindings_org_cell_live_unique");
    expect(schemaSource).toContain("table.organizationId, table.cellId");
    expect(schemaSource).toContain("status} <> 'deleted'");
    expect(bindingMigration).toContain("event_plane_org_bindings_org_cell_live_unique");
    expect(bindingMigration).toContain('("organization_id","cell_id")');
    expect(bindingMigration).toContain("\"status\" <> 'deleted'");
    expect(serviceSource).toContain("eq(schema.eventPlaneOrgBindings.version, expectedVersion)");
    expect(serviceSource).toContain("eq(schema.eventPlaneCredentialGrants.version, expectedVersion)");
    expect(serviceSource).not.toContain(".onConflictDoUpdate({");
  });

  test("migration preserves stable failed identity uniqueness", async () => {
    const migration = await Bun.file(
      new URL("../../../drizzle/0031_robust_victor_mancha.sql", import.meta.url),
    ).text();

    expect(migration).toContain("event_plane_identities_binding_principal_active_unique");
    expect(migration).toContain("'failed'");
  });

  test("migration adds canonical live organization cell binding uniqueness", async () => {
    const migrations = await readAllDrizzleSql();

    expect(migrations).toContain("event_plane_org_bindings_org_cell_live_unique");
    expect(migrations).toContain("\"organization_id\",\"cell_id\"");
    expect(migrations).toContain("\"event_plane_org_bindings\".\"status\" <> 'deleted'");
  });

  test("stores reconciliation reports as safe observed-state projections", () => {
    const report = {
      cellId: "11111111-1111-4111-8111-111111111111",
      completedAt: "2026-07-15T12:00:10.000Z",
      desiredHash: "sha256:desired",
      drift: [
        {
          reason: "provider account has no active Console binding",
          status: "orphan",
          targetId: "nats://p0/accounts/orphan",
          targetType: "event_plane_provider_account",
        },
      ],
      dryRun: false,
      expectedVersion: 3,
      idempotencyKey: "event-plane:cell:report:test",
      observedHash: "sha256:observed",
      observedStatus: "reachable" as const,
      operationsApplied: 1,
      operationsPlanned: 1,
      orphanCount: 1,
      planHash: "sha256:plan",
      policyBuild: "p0-controller-20260715",
      providerResultCode: "ok",
      resolverRevision: "resolver-rev-1",
      results: [
        {
          durationMs: 7,
          idempotencyKey: "event-plane:op:1",
          operation: "orphan.quarantine",
          providerResultCode: "quarantined",
          status: "quarantined",
        },
      ],
      rollbackCheckpoint: {
        cellId: "11111111-1111-4111-8111-111111111111",
        desiredHash: "sha256:desired",
      },
      startedAt: "2026-07-15T12:00:00.000Z",
    };

    const view = eventPlaneReconciliationReportView(report, new Date("2026-07-15T12:00:11.000Z"));
    const observedCapacity = eventPlaneObservedCapacityAfterReconciliation(
      { maxAccounts: 100 },
      report,
      new Date("2026-07-15T12:00:11.000Z"),
    );

    expect(view).toMatchObject({
      driftCount: 1,
      orphanCount: 1,
      providerResultCode: "ok",
      reportedAt: "2026-07-15T12:00:11.000Z",
    });
    expect(observedCapacity).toMatchObject({
      maxAccounts: 100,
      reconciliation: {
        planHash: "sha256:plan",
        results: [
          {
            operation: "orphan.quarantine",
            providerResultCode: "quarantined",
          },
        ],
      },
    });
    expect(JSON.stringify(observedCapacity)).not.toMatch(/secret|seed|BEGIN NATS|Bearer|privateKey/i);
  });

  test("rejects secret-shaped reconciliation reports before persistence", () => {
    const unsafeReport = {
      cellId: "11111111-1111-4111-8111-111111111111",
      completedAt: "2026-07-15T12:00:10.000Z",
      desiredHash: "sha256:desired",
      drift: [],
      dryRun: false,
      expectedVersion: 3,
      idempotencyKey: "event-plane:cell:report:test",
      observedHash: "sha256:observed",
      observedStatus: "reachable" as const,
      operationsApplied: 1,
      operationsPlanned: 1,
      orphanCount: 0,
      planHash: "sha256:plan",
      policyBuild: null,
      providerResultCode: "ok",
      resolverRevision: null,
      results: [],
      rollbackCheckpoint: {
        seed: `S${"U"}${"A".repeat(60)}`,
      },
      startedAt: "2026-07-15T12:00:00.000Z",
    };

    expect(() => eventPlaneReconciliationReportView(unsafeReport)).toThrow(EventPlaneControlError);
  });

  test("projects Event Plane audit evidence without audit payloads", () => {
    const summary = eventPlaneAuditSummaryView([
      {
        action: "event_plane.cell.reconciliation_report",
        eventCount: 8,
        latestAt: new Date("2026-07-15T12:10:00.000Z"),
      },
      {
        action: "event_plane.identity.ensure",
        eventCount: 3,
        latestAt: new Date("2026-07-15T12:05:00.000Z"),
      },
    ]);

    expect(summary).toEqual({
      version: 1,
      total: 11,
      latestAt: "2026-07-15T12:10:00.000Z",
      actions: [
        {
          action: "event_plane.cell.reconciliation_report",
          count: 8,
          latestAt: "2026-07-15T12:10:00.000Z",
        },
        {
          action: "event_plane.identity.ensure",
          count: 3,
          latestAt: "2026-07-15T12:05:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /beforeJson|afterJson|metadataJson|actorId|payload|secret|token/i,
    );
  });
});

describe("Event Plane control auth", () => {
  test("requires a dedicated sufficiently long control token", () => {
    expect(getEventPlaneControlToken({ RAVI_EVENT_PLANE_CONTROL_TOKEN: "short" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(
      getEventPlaneControlToken({
        RAVI_EVENT_PLANE_CONTROL_TOKEN: "event-plane-control-token-with-enough-length",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("event-plane-control-token-with-enough-length");
  });

  test("derives audit actor from authenticated control-service configuration", () => {
    expect(
      getEventPlaneControlActor({
        RAVI_EVENT_PLANE_CONTROL_ACTOR_ID: "event-plane-control-service:p0",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({ actorType: "system", actorId: "event-plane-control-service:p0" });
  });

  test("authorizes exact bearer token matches only", () => {
    const token = "event-plane-control-token-with-enough-length";
    expect(
      authorizeEventPlaneControlRequest(
        new Request("https://console.test/api/internal/event-plane/desired-state", {
          headers: { authorization: `Bearer ${token}` },
        }),
        token,
      ),
    ).toBe(true);
    expect(
      authorizeEventPlaneControlRequest(
        new Request("https://console.test/api/internal/event-plane/desired-state", {
          headers: { authorization: "Bearer wrong-event-plane-control-token" },
        }),
        token,
      ),
    ).toBe(false);
  });
});

async function readAllDrizzleSql() {
  const drizzleDir = new URL("../../../drizzle/", import.meta.url);
  const migrationNames = readdirSync(drizzleDir).filter((name) => name.endsWith(".sql")).sort();
  const migrations = await Promise.all(
    migrationNames.map((name) => Bun.file(new URL(name, drizzleDir)).text()),
  );
  return migrations.join("\n");
}
