import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  grantRelation,
  hasRelation,
  listRelations,
  pruneRevokedRelations,
  restoreRelationsRevocationBatch,
  restoreRelationsRevokedAt,
  revokeRelation,
} from "./relations.js";

let stateDir: string | null = null;

describe("REBAC relation lifetime", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-relations-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates manual grants as temporary by default", () => {
    const before = Math.floor(Date.now() / 1000);
    const relation = grantRelation("agent", "dev", "execute", "group", "contacts", "manual");

    expect(relation?.grantMode).toBe("temporary");
    expect(relation?.expiresAt).toBeNumber();
    expect(relation?.expiresAt).toBeGreaterThan(before);
    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(true);
  });

  it("keeps non-manual grants permanent unless a lifetime is explicit", () => {
    const relation = grantRelation("agent", "dev", "execute", "group", "contacts", "config");

    expect(relation?.grantMode).toBe("permanent");
    expect(relation?.expiresAt).toBeNull();
  });

  it("does not authorize expired grants but keeps them visible with includeInactive", () => {
    grantRelation("agent", "dev", "execute", "group", "contacts", "manual", {
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });

    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(false);
    expect(listRelations({ subjectType: "agent", subjectId: "dev" })).toHaveLength(0);
    expect(
      listRelations({
        subjectType: "agent",
        subjectId: "dev",
        includeInactive: true,
      }),
    ).toHaveLength(1);
  });

  it("supports explicit permanent manual grants", () => {
    const relation = grantRelation("agent", "dev", "execute", "group", "contacts", "manual", {
      permanent: true,
    });

    expect(relation?.grantMode).toBe("permanent");
    expect(relation?.expiresAt).toBeNull();
    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(true);
  });

  it("soft-revokes relations out of authorization checks", () => {
    grantRelation("agent", "dev", "execute", "group", "contacts", "manual");

    expect(revokeRelation("agent", "dev", "execute", "group", "contacts")).toBe(true);
    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(false);

    const inactive = listRelations({
      subjectType: "agent",
      subjectId: "dev",
      includeInactive: true,
    });
    expect(inactive).toHaveLength(1);
    expect(inactive[0].revokedAt).toBeNumber();
  });

  it("restores relations revoked in the same timestamp batch", () => {
    grantRelation("agent", "dev", "execute", "group", "contacts", "manual");
    grantRelation("agent", "dev", "use", "tool", "Read", "manual");
    const revokedAt = 123_456;

    expect(revokeRelation("agent", "dev", "execute", "group", "contacts", { revokedAt })).toBe(true);
    expect(revokeRelation("agent", "dev", "use", "tool", "Read", { revokedAt })).toBe(true);

    const planned = restoreRelationsRevokedAt(revokedAt);
    expect(planned).toMatchObject({ matched: 2, restored: 0 });
    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(false);

    const restored = restoreRelationsRevokedAt(revokedAt, { apply: true });
    expect(restored).toMatchObject({ matched: 2, restored: 2 });
    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(true);
    expect(hasRelation("agent", "dev", "use", "tool", "Read")).toBe(true);
  });

  it("restores only the requested revocation batch id even when timestamps collide", () => {
    const revokedAt = 123_456;
    grantRelation("agent", "dev", "execute", "group", "contacts", "manual");
    grantRelation("agent", "ops", "use", "tool", "Read", "manual");

    expect(
      revokeRelation("agent", "dev", "execute", "group", "contacts", {
        revokedAt,
        revocationBatchId: "batch-a",
      }),
    ).toBe(true);
    expect(
      revokeRelation("agent", "ops", "use", "tool", "Read", {
        revokedAt,
        revocationBatchId: "batch-b",
      }),
    ).toBe(true);

    const restored = restoreRelationsRevocationBatch("batch-a", { apply: true });

    expect(restored).toMatchObject({ matched: 1, restored: 1 });
    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(true);
    expect(hasRelation("agent", "ops", "use", "tool", "Read")).toBe(false);
  });

  it("restores only one subject's grants from a shared revocation batch", () => {
    grantRelation("agent", "dev", "execute", "group", "contacts", "manual");
    grantRelation("agent", "dev", "use", "tool", "Read", "manual");
    grantRelation("chat", "chat_x", "execute", "group", "contacts", "manual");
    const batchId = "incident-1";

    revokeRelation("agent", "dev", "execute", "group", "contacts", { revocationBatchId: batchId });
    revokeRelation("agent", "dev", "use", "tool", "Read", { revocationBatchId: batchId });
    revokeRelation("chat", "chat_x", "execute", "group", "contacts", { revocationBatchId: batchId });

    const planned = restoreRelationsRevocationBatch(batchId, { subjectType: "agent", subjectId: "dev" });
    expect(planned).toMatchObject({ matched: 2, restored: 0 });

    const restored = restoreRelationsRevocationBatch(batchId, {
      apply: true,
      subjectType: "agent",
      subjectId: "dev",
    });
    expect(restored).toMatchObject({ matched: 2, restored: 2 });
    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(true);
    expect(hasRelation("agent", "dev", "use", "tool", "Read")).toBe(true);
    // The other subject in the same batch stays revoked.
    expect(hasRelation("chat", "chat_x", "execute", "group", "contacts")).toBe(false);
  });

  it("restores a subject scope from a legacy timestamp batch", () => {
    grantRelation("agent", "dev", "execute", "group", "contacts", "manual");
    grantRelation("chat", "chat_x", "execute", "group", "contacts", "manual");
    const revokedAt = 987_654;

    revokeRelation("agent", "dev", "execute", "group", "contacts", { revokedAt });
    revokeRelation("chat", "chat_x", "execute", "group", "contacts", { revokedAt });

    const restored = restoreRelationsRevokedAt(revokedAt, { apply: true, subjectType: "agent", subjectId: "dev" });
    expect(restored).toMatchObject({ matched: 1, restored: 1 });
    expect(hasRelation("agent", "dev", "execute", "group", "contacts")).toBe(true);
    expect(hasRelation("chat", "chat_x", "execute", "group", "contacts")).toBe(false);
  });

  it("prunes old revoked relations without touching active or recent ones", () => {
    const now = Math.floor(Date.now() / 1000);
    grantRelation("agent", "dev", "use", "tool", "Read", "manual", { permanent: true });
    grantRelation("agent", "dev", "execute", "group", "old", "manual", { permanent: true });
    grantRelation("agent", "dev", "execute", "group", "recent", "manual", { permanent: true });

    // one old revocation, one recent revocation, one still-active grant
    revokeRelation("agent", "dev", "execute", "group", "old", { revokedAt: now - 100 * 24 * 60 * 60 });
    revokeRelation("agent", "dev", "execute", "group", "recent", { revokedAt: now - 1 * 24 * 60 * 60 });

    const planned = pruneRevokedRelations({ olderThanSeconds: 90 * 24 * 60 * 60 });
    expect(planned).toMatchObject({ matched: 1, pruned: 0 });

    const pruned = pruneRevokedRelations({ apply: true, olderThanSeconds: 90 * 24 * 60 * 60 });
    expect(pruned).toMatchObject({ matched: 1, pruned: 1 });

    const all = listRelations({ subjectType: "agent", subjectId: "dev", includeInactive: true });
    const ids = all.map((r) => r.objectId).sort();
    // old revoked row is gone; recent revoked + active remain
    expect(ids).toEqual(["Read", "recent"]);
    expect(hasRelation("agent", "dev", "use", "tool", "Read")).toBe(true);
  });
});
