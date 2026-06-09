import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

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
  reason?: string | null;
  issuedBy?: string | null;
  createdAt: number;
}

let relations: TestRelation[] = [];
let nextRelationId = 1;

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
      reason: options?.reason ?? null,
      issuedBy: options?.issuedBy ?? null,
      createdAt: 1,
    };
    relations.push(created);
    return created;
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
  listRelations: (filter?: Record<string, unknown>) => relations.filter((relation) => matchesFilter(relation, filter)),
  clearRelations: (filter?: Record<string, unknown>) => {
    const before = relations.length;
    relations = relations.filter((relation) => !matchesFilter(relation, filter));
    return before - relations.length;
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

mock.module("../../permissions/engine.js", () => ({
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
});
