import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createRuntimeContext, resolveRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbDeleteTagBinding, dbEnsureTagBinding } from "../tags/tag-db.js";
import { getDb } from "../router/router-db.js";
import { can } from "./engine.js";
import {
  applyPermissionPolicies,
  dryRunPermissionPolicies,
  explainPermissionPoliciesForAsset,
  reconcilePermissionPolicies,
  validatePermissionPolicies,
} from "./policies.js";
import { grantRelation, listRelations } from "./relations.js";

let stateDir: string | null = null;
let policyDir: string;
const TRUSTED_POLICY_TAG = "policy.profile.trusted-dev";

function writePolicy(name: string, policy: Record<string, unknown>): void {
  writeFileSync(join(policyDir, `${name}.json`), JSON.stringify(policy, null, 2));
}

function trustedContactPolicy(roleId = "trusted-dev"): Record<string, unknown> {
  return {
    id: "trusted-contacts-role",
    selector: {
      assetType: "contact",
      tag: TRUSTED_POLICY_TAG,
      acceptedBindingSources: ["manual"],
    },
    emits: [
      {
        subject: { fromAsset: true },
        relation: "member",
        object: { type: "role", id: roleId },
      },
    ],
    grant: {
      mode: "temporary",
      ttl: "2h",
    },
  };
}

describe("permission policies", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permission-policies-test-");
    policyDir = join(stateDir, "permission-policies");
    mkdirSync(policyDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("plans tag-driven grants without writing relations", () => {
    writePolicy("trusted", trustedContactPolicy());
    dbEnsureTagBinding({
      slug: TRUSTED_POLICY_TAG,
      label: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
      source: "manual",
    });

    const result = dryRunPermissionPolicies({ directory: policyDir });

    expect(result.valid).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      status: "would_create",
      subjectType: "contact",
      subjectId: "luis",
      relation: "member",
      objectType: "role",
      objectId: "trusted-dev",
      grantMode: "temporary",
    });
    expect(listRelations({ subjectType: "contact", subjectId: "luis", relation: "member" })).toEqual([]);
  });

  it("applies policy-owned temporary grants and keeps role checks effective", () => {
    writePolicy("trusted", trustedContactPolicy());
    dbEnsureTagBinding({
      slug: TRUSTED_POLICY_TAG,
      label: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
      source: "manual",
    });
    grantRelation("role", "trusted-dev", "use", "tool", "Bash", "manual");

    const result = applyPermissionPolicies({ directory: policyDir });
    const relation = listRelations({
      subjectType: "contact",
      subjectId: "luis",
      relation: "member",
      objectType: "role",
      objectId: "trusted-dev",
    })[0]!;

    expect(result.summary.created).toBe(1);
    expect(relation.source).toBe("policy:trusted-contacts-role");
    expect(relation.grantMode).toBe("temporary");
    expect(relation.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(can("contact", "luis", "use", "tool", "Bash")).toBe(true);
  });

  it("does not overwrite existing manual grants when a policy wants the same tuple", () => {
    writePolicy("trusted", trustedContactPolicy());
    dbEnsureTagBinding({
      slug: TRUSTED_POLICY_TAG,
      label: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
      source: "manual",
    });
    grantRelation("contact", "luis", "member", "role", "trusted-dev", "manual");

    const result = applyPermissionPolicies({ directory: policyDir });
    const relation = listRelations({
      subjectType: "contact",
      subjectId: "luis",
      relation: "member",
      objectType: "role",
      objectId: "trusted-dev",
      includeInactive: true,
    })[0]!;

    expect(result.summary.conflicts).toBe(1);
    expect(result.actions[0]?.conflictSource).toBe("manual");
    expect(relation.source).toBe("manual");
  });

  it("rejects membership into roles whose closure contains broad privileged outputs", () => {
    writePolicy("owner", trustedContactPolicy("owner"));
    grantRelation("role", "owner", "admin", "system", "*", "manual");

    const result = validatePermissionPolicies({ directory: policyDir });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.error.includes("role owner closure contains forbidden output"))).toBe(
      true,
    );
  });

  it("revokes policy-owned grants immediately after policy tag removal", () => {
    writePolicy("trusted", trustedContactPolicy());
    dbEnsureTagBinding({
      slug: TRUSTED_POLICY_TAG,
      label: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
      source: "manual",
    });

    applyPermissionPolicies({ directory: policyDir });
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      capabilities: [{ permission: "use", objectType: "tool", objectId: "Read", source: "effective" }],
      metadata: {
        authorityMode: "delegated",
        actorPrincipal: "contact:luis",
      },
    });
    dbDeleteTagBinding({
      slug: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
    });

    const inactive = listRelations({
      subjectType: "contact",
      subjectId: "luis",
      relation: "member",
      objectType: "role",
      objectId: "trusted-dev",
      includeInactive: true,
    })[0]!;

    expect(
      listRelations({
        subjectType: "contact",
        subjectId: "luis",
        relation: "member",
        objectType: "role",
        objectId: "trusted-dev",
      }),
    ).toEqual([]);
    expect(inactive.revokedAt).toBeTruthy();
    expect(resolveRuntimeContext(context.contextKey, { touch: false })).toBeNull();

    const reconcile = reconcilePermissionPolicies({ directory: policyDir });
    expect(reconcile.summary.revoked).toBe(0);
  });

  it("rejects non-policy selectors unless explicitly acknowledged", () => {
    writePolicy("generic", {
      ...trustedContactPolicy(),
      selector: {
        assetType: "contact",
        tag: "people.trusted",
        acceptedBindingSources: ["manual"],
      },
    });

    const result = validatePermissionPolicies({ directory: policyDir });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.error.includes("is not a policy tag"))).toBe(true);
  });

  it("rejects direct outputs outside the MVP policy matrix", () => {
    writePolicy("direct", {
      id: "bad-direct-contact-tool",
      selector: {
        assetType: "contact",
        tag: TRUSTED_POLICY_TAG,
        acceptedBindingSources: ["manual"],
      },
      emits: [
        {
          subject: { fromAsset: true },
          relation: "use",
          object: { type: "tool", id: "Read" },
        },
      ],
    });

    const result = validatePermissionPolicies({ directory: policyDir });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.error.includes("outside the MVP policy output matrix"))).toBe(true);
  });

  it("rejects delegated wildcard outputs unless break-glass is explicit", () => {
    writePolicy("delegate-wildcard", {
      id: "delegate-wildcard",
      selector: {
        assetType: "chat",
        tag: "policy.allow.tool.all",
        acceptedBindingSources: ["manual"],
      },
      emits: [
        {
          subject: { fromAsset: true },
          relation: "delegate_use",
          object: { type: "tool", id: "*" },
        },
      ],
    });

    const result = validatePermissionPolicies({ directory: policyDir });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.error.includes("forbidden broad output"))).toBe(true);
  });

  it("rejects app wildcard outputs unless break-glass is explicit", () => {
    writePolicy("app-wildcard", {
      id: "app-wildcard",
      selector: {
        assetType: "chat",
        tag: "policy.allow.app.all",
        acceptedBindingSources: ["manual"],
      },
      emits: [
        {
          subject: { fromAsset: true },
          relation: "use",
          object: { type: "app", id: "*" },
        },
      ],
    });

    const result = validatePermissionPolicies({ directory: policyDir });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.error.includes("forbidden broad output"))).toBe(true);
  });

  it("rejects broad contact tag read outputs", () => {
    writePolicy("broad-contact-read", {
      id: "broad-contact-read",
      kind: "profile-definition",
      selector: {
        assetType: "spec",
        tag: "policy.profile.crm-all",
        acceptedBindingSources: ["manual"],
      },
      emits: [
        {
          subject: { type: "role", id: "crm-readers" },
          relation: "read_tagged_contacts",
          object: { type: "system", id: "*" },
        },
      ],
    });

    const result = validatePermissionPolicies({ directory: policyDir });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.error.includes("forbidden broad output"))).toBe(true);
  });

  it("requires approval and a bounded temporary ttl for break-glass broad outputs", () => {
    const basePolicy = {
      id: "breakglass-tools",
      kind: "delegation",
      breakGlass: true,
      selector: {
        assetType: "chat",
        tag: "policy.breakglass.tools",
        acceptedBindingSources: ["manual"],
      },
      emits: [
        {
          subject: { fromAsset: true },
          relation: "delegate_use",
          object: { type: "tool", id: "*" },
        },
      ],
    };

    writePolicy("breakglass", {
      ...basePolicy,
      grant: { mode: "permanent", reason: "review probe" },
    });

    let result = validatePermissionPolicies({ directory: policyDir });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.error.includes("requires approval record"))).toBe(true);
    expect(result.errors.some((error) => error.error.includes("must be temporary"))).toBe(true);

    writePolicy("breakglass", {
      ...basePolicy,
      approval: { approvedBy: "operator", reason: "short emergency window" },
      grant: { mode: "temporary", ttl: "2h", reason: "review probe" },
    });

    result = validatePermissionPolicies({ directory: policyDir });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.error.includes("ttl exceeds"))).toBe(true);

    writePolicy("breakglass", {
      ...basePolicy,
      approval: { approvedBy: "operator", reason: "short emergency window" },
      grant: { mode: "temporary", ttl: "30m", reason: "review probe" },
    });

    result = validatePermissionPolicies({ directory: policyDir });
    expect(result.valid).toBe(true);
  });

  it("requires profile-definition kind before policies can define role capabilities", () => {
    writePolicy("role", {
      id: "role-read-profile",
      selector: {
        assetType: "spec",
        tag: "policy.profile.role-read",
        acceptedBindingSources: ["manual"],
      },
      emits: [
        {
          subject: { type: "role", id: "readers" },
          relation: "use",
          object: { type: "tool", id: "Read" },
        },
      ],
    });

    expect(validatePermissionPolicies({ directory: policyDir }).valid).toBe(false);

    writePolicy("role", {
      id: "role-read-profile",
      kind: "profile-definition",
      selector: {
        assetType: "spec",
        tag: "policy.profile.role-read",
        acceptedBindingSources: ["manual"],
      },
      emits: [
        {
          subject: { type: "role", id: "readers" },
          relation: "use",
          object: { type: "tool", id: "Read" },
        },
      ],
    });

    expect(validatePermissionPolicies({ directory: policyDir }).valid).toBe(true);
  });

  it("dry-runs stale policy-owned revocations without writing", () => {
    writePolicy("trusted", trustedContactPolicy());
    dbEnsureTagBinding({
      slug: TRUSTED_POLICY_TAG,
      label: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
      source: "manual",
    });
    applyPermissionPolicies({ directory: policyDir });
    getDb()
      .prepare(
        `
        DELETE FROM tag_bindings
        WHERE tag_id IN (SELECT id FROM tag_definitions WHERE slug = ?)
          AND asset_type = ?
          AND asset_id = ?
      `,
      )
      .run(TRUSTED_POLICY_TAG, "contact", "luis");

    const result = dryRunPermissionPolicies({ directory: policyDir });
    const stillActive = listRelations({
      subjectType: "contact",
      subjectId: "luis",
      relation: "member",
      objectType: "role",
      objectId: "trusted-dev",
    });

    expect(result.summary.revoked).toBe(1);
    expect(stillActive).toHaveLength(1);
  });

  it("does not revoke stale policy-owned grants during apply", () => {
    writePolicy("trusted", trustedContactPolicy());
    dbEnsureTagBinding({
      slug: TRUSTED_POLICY_TAG,
      label: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
      source: "manual",
    });
    applyPermissionPolicies({ directory: policyDir });
    getDb()
      .prepare(
        `
        DELETE FROM tag_bindings
        WHERE tag_id IN (SELECT id FROM tag_definitions WHERE slug = ?)
          AND asset_type = ?
          AND asset_id = ?
      `,
      )
      .run(TRUSTED_POLICY_TAG, "contact", "luis");

    const apply = applyPermissionPolicies({ directory: policyDir });
    const stillActive = listRelations({
      subjectType: "contact",
      subjectId: "luis",
      relation: "member",
      objectType: "role",
      objectId: "trusted-dev",
    });

    expect(apply.summary.revoked).toBe(0);
    expect(stillActive).toHaveLength(1);

    const reconcile = reconcilePermissionPolicies({ directory: policyDir });
    expect(reconcile.summary.revoked).toBe(1);
  });

  it("revokes policy-owned memberships before authorization when a role closure becomes forbidden", () => {
    writePolicy("trusted", trustedContactPolicy());
    dbEnsureTagBinding({
      slug: TRUSTED_POLICY_TAG,
      label: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
      source: "manual",
    });
    grantRelation("role", "trusted-dev", "use", "tool", "Read", "manual");
    applyPermissionPolicies({ directory: policyDir });

    grantRelation("role", "trusted-dev", "use", "tool", "*", "manual");

    expect(can("contact", "luis", "use", "tool", "Read")).toBe(false);
    const inactive = listRelations({
      subjectType: "contact",
      subjectId: "luis",
      relation: "member",
      objectType: "role",
      objectId: "trusted-dev",
      includeInactive: true,
    })[0]!;
    expect(inactive.revokedAt).toBeTruthy();
  });

  it("explains policy matches for a tagged asset", () => {
    writePolicy("trusted", trustedContactPolicy());
    dbEnsureTagBinding({
      slug: TRUSTED_POLICY_TAG,
      label: TRUSTED_POLICY_TAG,
      assetType: "contact",
      assetId: "luis",
      source: "manual",
    });

    const result = explainPermissionPoliciesForAsset({
      directory: policyDir,
      assetType: "contact",
      assetId: "luis",
    });

    expect(result.valid).toBe(true);
    expect(result.tags.map((tag) => tag.tag)).toContain(TRUSTED_POLICY_TAG);
    expect(result.actions).toHaveLength(1);
  });
});
