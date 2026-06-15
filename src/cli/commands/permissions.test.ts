import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());

interface TestRelation {
  id: number;
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
  source: string;
  grantMode?: "temporary" | "permanent";
  expiresAt?: number | null;
  revokedAt?: number | null;
  revocationBatchId?: string | null;
  reason?: string | null;
  issuedBy?: string | null;
  createdAt: number;
}

let relations: TestRelation[] = [];
let nextRelationId = 1;
let previousLegacyLocalGrantsMutation: string | undefined;

function matchesFilter(relation: TestRelation, filter?: Record<string, unknown>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => {
    if (key === "includeInactive") return true;
    return relation[key as keyof TestRelation] === value;
  });
}

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  fail: (message: string) => {
    throw new Error(message);
  },
  getContext: () => undefined,
}));

mock.module("../../permissions/relations.js", () => ({
  DEFAULT_MANUAL_GRANT_TTL_MS: 60 * 60 * 1000,
  grantRelation: (
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
    source: string,
    options?: {
      permanent?: boolean;
      ttlMs?: number;
      expiresAt?: number;
      reason?: string;
      issuedBy?: string;
    },
  ) => {
    const existing = relations.find((item) =>
      matchesFilter(item, {
        subjectType,
        subjectId,
        relation,
        objectType,
        objectId,
      }),
    );
    if (existing) {
      existing.source = source;
      existing.grantMode = options?.permanent ? "permanent" : source === "manual" ? "temporary" : "permanent";
      existing.expiresAt = options?.permanent ? null : (options?.expiresAt ?? 3601);
      existing.reason = options?.reason ?? null;
      existing.issuedBy = options?.issuedBy ?? null;
      existing.revokedAt = null;
      existing.revocationBatchId = null;
      return existing;
    }
    const created = {
      id: nextRelationId++,
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId,
      source,
      grantMode: options?.permanent
        ? ("permanent" as const)
        : source === "manual"
          ? ("temporary" as const)
          : ("permanent" as const),
      expiresAt: options?.permanent ? null : source === "manual" ? (options?.expiresAt ?? 3601) : null,
      revokedAt: null,
      revocationBatchId: null,
      reason: options?.reason ?? null,
      issuedBy: options?.issuedBy ?? null,
      createdAt: 1,
    };
    relations.push(created);
    return created;
  },
  grantRelationIfAbsentOrOwned: (
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
    source: string,
    options?: {
      permanent?: boolean;
      ttlMs?: number;
      expiresAt?: number;
      reason?: string;
      issuedBy?: string;
    },
  ) => {
    const existing = relations.find((item) =>
      matchesFilter(item, {
        subjectType,
        subjectId,
        relation,
        objectType,
        objectId,
      }),
    );
    if (existing && !existing.revokedAt && existing.source !== source) {
      return { status: "conflict", relation: existing, conflictSource: existing.source };
    }
    if (existing) {
      existing.source = source;
      existing.grantMode = options?.permanent ? "permanent" : source === "manual" ? "temporary" : "permanent";
      existing.expiresAt = options?.permanent ? null : (options?.expiresAt ?? 3601);
      existing.reason = options?.reason ?? null;
      existing.issuedBy = options?.issuedBy ?? null;
      existing.revokedAt = null;
      existing.revocationBatchId = null;
      return { status: "refreshed", relation: existing };
    }
    const created = {
      id: nextRelationId++,
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId,
      source,
      grantMode: options?.permanent
        ? ("permanent" as const)
        : source === "manual"
          ? ("temporary" as const)
          : ("permanent" as const),
      expiresAt: options?.permanent ? null : source === "manual" ? (options?.expiresAt ?? 3601) : null,
      revokedAt: null,
      revocationBatchId: null,
      reason: options?.reason ?? null,
      issuedBy: options?.issuedBy ?? null,
      createdAt: 1,
    };
    relations.push(created);
    return { status: "created", relation: created };
  },
  revokeRelation: (subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) => {
    const before = relations.length;
    relations = relations.filter(
      (item) =>
        !matchesFilter(item, {
          subjectType,
          subjectId,
          relation,
          objectType,
          objectId,
        }),
    );
    return relations.length < before;
  },
  revokeRelationIfSource: (
    subjectType: string,
    subjectId: string,
    relation: string,
    objectType: string,
    objectId: string,
    source: string,
    options?: { revokedAt?: number; revocationBatchId?: string | null },
  ) => {
    const item = relations.find((candidate) =>
      matchesFilter(candidate, {
        subjectType,
        subjectId,
        relation,
        objectType,
        objectId,
        source,
      }),
    );
    if (!item) return false;
    item.revokedAt = options?.revokedAt ?? 1;
    item.revocationBatchId = options?.revocationBatchId ?? null;
    return true;
  },
  hasRelation: (subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) =>
    relations.some((item) =>
      matchesFilter(item, {
        subjectType,
        subjectId,
        relation,
        objectType,
        objectId,
      }),
    ),
  listRelations: (filter?: Record<string, unknown>) =>
    relations.filter((relation) => {
      if (!filter?.includeInactive && relation.revokedAt) return false;
      return matchesFilter(relation, filter);
    }),
  clearRelations: (filter?: Record<string, unknown>) => {
    const before = relations.length;
    relations = relations.filter((relation) => !matchesFilter(relation, filter));
    return before - relations.length;
  },
  restoreRelationsRevokedAt: (revokedAt: number, options?: { apply?: boolean }) => {
    const matched = relations.filter((relation) => relation.revokedAt === revokedAt);
    if (options?.apply) {
      for (const relation of matched) {
        relation.revokedAt = null;
        relation.revocationBatchId = null;
      }
    }
    return {
      matched: matched.length,
      restored: options?.apply ? matched.length : 0,
      relations: matched,
    };
  },
  restoreRelationsRevocationBatch: (revocationBatchId: string, options?: { apply?: boolean }) => {
    const matched = relations.filter((relation) => relation.revocationBatchId === revocationBatchId);
    if (options?.apply) {
      for (const relation of matched) {
        relation.revokedAt = null;
        relation.revocationBatchId = null;
      }
    }
    return {
      matched: matched.length,
      restored: options?.apply ? matched.length : 0,
      relations: matched,
    };
  },
  pruneRevokedRelations: (options?: { apply?: boolean; olderThanSeconds?: number }) => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = options?.olderThanSeconds != null ? now - options.olderThanSeconds : now;
    const matched = relations.filter((relation) => relation.revokedAt != null && relation.revokedAt <= cutoff);
    if (options?.apply) {
      for (const relation of matched) {
        const idx = relations.indexOf(relation);
        if (idx >= 0) relations.splice(idx, 1);
      }
    }
    return { matched: matched.length, pruned: options?.apply ? matched.length : 0, cutoff };
  },
  syncRelationsFromConfig: () => {
    relations.push({
      id: nextRelationId++,
      subjectType: "agent",
      subjectId: "main",
      relation: "admin",
      objectType: "system",
      objectId: "*",
      source: "config",
      grantMode: "permanent",
      expiresAt: null,
      revokedAt: null,
      reason: null,
      issuedBy: null,
      createdAt: 1,
    });
  },
}));

mock.module("../../permissions/grant-notifications.js", () => ({
  notifyPermissionGrantCreated: () => {},
  notifyPermissionGrantsCreated: () => {},
}));

mock.module("../../permissions/provider-runtime.js", () => ({
  can: (subjectType: string, subjectId: string, permission: string, objectType: string, objectId: string) =>
    relations.some((item) =>
      matchesFilter(item, {
        subjectType,
        subjectId,
        relation: permission,
        objectType,
        objectId,
      }),
    ),
}));

mock.module("../../permissions/policies.js", () => ({
  applyPermissionPolicies: () => ({
    mode: "apply",
    valid: true,
    rules: [],
    errors: [],
    warnings: [],
    actions: [],
    revoked: [],
    summary: {},
  }),
  dryRunPermissionPolicies: () => ({
    mode: "dry-run",
    valid: true,
    rules: [],
    errors: [],
    warnings: [],
    actions: [],
    revoked: [],
    summary: {},
  }),
  explainPermissionPoliciesForAsset: () => ({
    assetType: "contact",
    assetId: "c1",
    valid: true,
    tags: [],
    actions: [],
    materializations: [],
    errors: [],
    warnings: [],
  }),
  listPermissionPolicyMaterializations: () => [],
  loadPermissionPolicyRulesFromDirectory: () => ({ rules: [], errors: [] }),
  revalidatePolicyMaterializationsBeforeAuthorization: () => [],
  reconcilePermissionPolicies: () => ({
    mode: "reconcile",
    valid: true,
    rules: [],
    errors: [],
    warnings: [],
    actions: [],
    revoked: [],
    summary: {},
  }),
  validatePermissionPolicies: () => ({ rules: [], errors: [], warnings: [], valid: true }),
}));

mock.module("../../permissions/explain.js", () => ({
  explainPermissionDecision: (input: { agentId: string; relation: string; objectType: string; objectId: string }) => ({
    request: {
      relation: input.relation,
      objectType: input.objectType,
      objectId: input.objectId,
      object: `${input.objectType}:${input.objectId}`,
      agent: `agent:${input.agentId}`,
      actor: null,
      chat: null,
      sessionKey: null,
    },
    final: { allowed: true, path: "agent", reason: "mock" },
    branches: [],
    matchedRelations: [],
    nearMissRelations: [],
    revocationEvents: [],
    recommendations: [],
  }),
  explainPermissionDenial: (id: number) => ({
    denial: { id },
    current: {
      request: {
        relation: "execute",
        objectType: "group",
        objectId: "sessions_info",
        object: "group:sessions_info",
        agent: "agent:reviewer",
        actor: null,
        chat: null,
        sessionKey: null,
      },
      final: { allowed: false, path: "agent", reason: "mock" },
      branches: [],
      matchedRelations: [],
      nearMissRelations: [],
      revocationEvents: [],
      recommendations: [],
    },
    currentlyDenied: true,
  }),
}));

mock.module("../tool-registry.js", () => ({
  SDK_TOOLS: ["Bash", "Read"],
  TOOL_GROUPS: {
    safe: ["Read"],
  },
  resolveToolGroup: (name: string) => (name === "safe" ? ["Read"] : undefined),
}));

mock.module("../../bash/permissions.js", () => ({
  getDefaultAllowlist: () => ["git"],
}));

const { PermissionsCommands } = await import("./permissions.js");

function captureJson(run: () => void): Record<string, unknown> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return JSON.parse(lines.join("\n")) as Record<string, unknown>;
}

describe("PermissionsCommands --json", () => {
  beforeEach(() => {
    relations = [];
    nextRelationId = 1;
    previousLegacyLocalGrantsMutation = process.env.RAVI_ENABLE_LEGACY_LOCAL_GRANTS_MUTATION;
    process.env.RAVI_ENABLE_LEGACY_LOCAL_GRANTS_MUTATION = "1";
  });

  afterEach(() => {
    if (previousLegacyLocalGrantsMutation === undefined) {
      delete process.env.RAVI_ENABLE_LEGACY_LOCAL_GRANTS_MUTATION;
    } else {
      process.env.RAVI_ENABLE_LEGACY_LOCAL_GRANTS_MUTATION = previousLegacyLocalGrantsMutation;
    }
  });

  it("returns the granted relation as structured JSON", () => {
    const payload = captureJson(() => new PermissionsCommands().grant("agent:dev", "execute", "group:contacts", true));

    expect(payload).toMatchObject({
      status: "granted",
      target: {
        type: "permission-relation",
        subject: "agent:dev",
        relation: "execute",
        object: "group:contacts",
      },
      changedCount: 1,
      relation: {
        subject: "agent:dev",
        relation: "execute",
        object: "group:contacts",
        source: "manual",
      },
    });
  });

  it("accepts delegated override relations through the CLI", () => {
    const payload = captureJson(() =>
      new PermissionsCommands().grant("chat:chat_group_1", "delegate_use", "tool:Bash", true),
    );

    expect(payload).toMatchObject({
      status: "granted",
      target: {
        subject: "chat:chat_group_1",
        relation: "delegate_use",
        object: "tool:Bash",
      },
      relation: {
        subject: "chat:chat_group_1",
        relation: "delegate_use",
        object: "tool:Bash",
      },
    });
  });

  it("accepts explicit deny relations through the CLI", () => {
    const payload = captureJson(() =>
      new PermissionsCommands().grant("chat:chat_group_1", "deny_execute", "group:sessions_info", true),
    );

    expect(payload).toMatchObject({
      status: "granted",
      target: {
        subject: "chat:chat_group_1",
        relation: "deny_execute",
        object: "group:sessions_info",
      },
      relation: {
        subject: "chat:chat_group_1",
        relation: "deny_execute",
        object: "group:sessions_info",
      },
    });
  });

  it("rejects delegated superadmin overrides", () => {
    expect(() => new PermissionsCommands().grant("chat:chat_group_1", "delegate_admin", "system:*", true)).toThrow(
      /Unknown relation/,
    );
  });

  it("returns permission check decisions as structured JSON", () => {
    new PermissionsCommands().grant("agent:dev", "execute", "group:contacts");

    const payload = captureJson(() => new PermissionsCommands().check("agent:dev", "execute", "group:contacts", true));

    expect(payload).toEqual({
      subject: { raw: "agent:dev", type: "agent", id: "dev" },
      permission: "execute",
      object: { raw: "group:contacts", type: "group", id: "contacts" },
      allowed: true,
    });
  });

  it("serializes list filters and relation entities in --json mode", () => {
    new PermissionsCommands().grant("agent:dev", "use", "toolgroup:safe");

    const payload = captureJson(() =>
      new PermissionsCommands().list("agent:dev", undefined, undefined, undefined, true),
    );

    expect(payload).toMatchObject({
      total: 1,
      filter: {
        subjectType: "agent",
        subjectId: "dev",
      },
      relations: [
        {
          subject: "agent:dev",
          relation: "use",
          object: "toolgroup:safe",
          objectMembers: ["Read"],
        },
      ],
    });
  });

  it("plans only active manual permanent wildcard grants as legacy by default", () => {
    relations.push(
      {
        id: nextRelationId++,
        subjectType: "agent",
        subjectId: "legacy",
        relation: "use",
        objectType: "tool",
        objectId: "*",
        source: "manual",
        grantMode: "permanent",
        expiresAt: null,
        revokedAt: null,
        reason: null,
        issuedBy: null,
        createdAt: 1,
      },
      {
        id: nextRelationId++,
        subjectType: "agent",
        subjectId: "specific",
        relation: "use",
        objectType: "tool",
        objectId: "Bash",
        source: "manual",
        grantMode: "permanent",
        expiresAt: null,
        revokedAt: null,
        reason: null,
        issuedBy: null,
        createdAt: 1,
      },
      {
        id: nextRelationId++,
        subjectType: "agent",
        subjectId: "temporary",
        relation: "use",
        objectType: "tool",
        objectId: "*",
        source: "manual",
        grantMode: "temporary",
        expiresAt: 9999999999,
        revokedAt: null,
        reason: null,
        issuedBy: null,
        createdAt: 1,
      },
      {
        id: nextRelationId++,
        subjectType: "agent",
        subjectId: "config",
        relation: "admin",
        objectType: "system",
        objectId: "*",
        source: "config",
        grantMode: "permanent",
        expiresAt: null,
        revokedAt: null,
        reason: null,
        issuedBy: null,
        createdAt: 1,
      },
    );

    const payload = captureJson(() => new PermissionsCommands().legacy(true));

    expect(payload).toMatchObject({
      status: "planned",
      dryRun: true,
      totalCandidates: 1,
      selectedCount: 1,
      changedCount: 0,
      sample: [
        {
          subject: "agent:legacy",
          relation: "use",
          object: "tool:*",
        },
      ],
    });
  });

  it("requires explicit confirmation before applying legacy cleanup", () => {
    expect(() => new PermissionsCommands().legacy(true, true)).toThrow(/--confirm legacy-cleanup/);
  });

  it("revokes selected legacy grants when confirmed", () => {
    relations.push({
      id: nextRelationId++,
      subjectType: "agent",
      subjectId: "legacy",
      relation: "use",
      objectType: "tool",
      objectId: "*",
      source: "manual",
      grantMode: "permanent",
      expiresAt: null,
      revokedAt: null,
      reason: null,
      issuedBy: null,
      createdAt: 1,
    });

    const payload = captureJson(() =>
      new PermissionsCommands().legacy(true, true, "legacy-cleanup", undefined, undefined, undefined, undefined, true),
    );

    expect(payload).toMatchObject({
      status: "applied",
      dryRun: false,
      totalCandidates: 1,
      selectedCount: 1,
      changedCount: 1,
      revocationBatchId: expect.stringMatching(/^rev_/),
      blastRadius: {
        zeroedSubjectsCount: 1,
      },
    });
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      revokedAt: expect.any(Number),
      revocationBatchId: payload.revocationBatchId,
    });
  });

  it("restores selected revocation batch id without restoring same-second revocations", () => {
    relations.push(
      {
        id: nextRelationId++,
        subjectType: "agent",
        subjectId: "legacy",
        relation: "use",
        objectType: "tool",
        objectId: "*",
        source: "manual",
        grantMode: "permanent",
        expiresAt: null,
        revokedAt: 123,
        revocationBatchId: "batch-a",
        reason: null,
        issuedBy: null,
        createdAt: 1,
      },
      {
        id: nextRelationId++,
        subjectType: "agent",
        subjectId: "other",
        relation: "use",
        objectType: "tool",
        objectId: "Read",
        source: "manual",
        grantMode: "permanent",
        expiresAt: null,
        revokedAt: 123,
        revocationBatchId: "batch-b",
        reason: null,
        issuedBy: null,
        createdAt: 1,
      },
    );

    const payload = captureJson(() =>
      new PermissionsCommands().restoreBatch("batch-a", true, true, "restore-revocation"),
    );

    expect(payload).toMatchObject({
      status: "restored",
      changedCount: 1,
      target: {
        batch: "batch-a",
        revokedAt: null,
      },
    });
    expect(relations.find((relation) => relation.subjectId === "legacy")).toMatchObject({
      revokedAt: null,
      revocationBatchId: null,
    });
    expect(relations.find((relation) => relation.subjectId === "other")).toMatchObject({
      revokedAt: 123,
      revocationBatchId: "batch-b",
    });
  });

  it("requires break-glass when legacy cleanup would zero a subject", () => {
    relations.push({
      id: nextRelationId++,
      subjectType: "agent",
      subjectId: "legacy",
      relation: "use",
      objectType: "tool",
      objectId: "*",
      source: "manual",
      grantMode: "permanent",
      expiresAt: null,
      revokedAt: null,
      reason: null,
      issuedBy: null,
      createdAt: 1,
    });

    expect(() =>
      new PermissionsCommands().legacy(true, true, "legacy-cleanup", undefined, undefined, undefined),
    ).toThrow(/zero active grants/);
  });

  it("explains a permission decision as structured JSON", () => {
    const payload = captureJson(() =>
      new PermissionsCommands().explain(
        "execute",
        "group:sessions_info",
        "reviewer",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );

    expect(payload).toMatchObject({
      request: {
        relation: "execute",
        object: "group:sessions_info",
        agent: "agent:reviewer",
      },
      final: {
        allowed: true,
      },
    });
  });
});
