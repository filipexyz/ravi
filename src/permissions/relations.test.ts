import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { grantRelation, hasRelation, listRelations, revokeRelation } from "./relations.js";

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
});
