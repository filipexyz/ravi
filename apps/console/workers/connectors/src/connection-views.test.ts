import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { GOOGLE_WRITE_SCOPES } from "./adapters/google";
import { listProviderCapabilities } from "./capabilities/registry";
import {
  toActivityRow,
  toAdminConnectionRow,
  toCliConnectionDetail,
  toCliConnectionItem,
  toConnectionSummary,
  toOrgPolicyView,
  toToolRows,
} from "./connection-views";
import type { ConnectorOrgPolicyRecord, ConnectorUsageRecord, ProviderConnectionRecord } from "./db";

function row(overrides: Partial<ProviderConnectionRecord> = {}): ProviderConnectionRecord {
  return {
    id: "c0000000-0000-4000-8000-000000000001",
    organizationId: "o0000000-0000-4000-8000-000000000001",
    projectId: null,
    userId: "u0000000-0000-4000-8000-000000000001",
    provider: "google",
    scopeKind: "user",
    externalAccountId: "1098",
    externalAccountLogin: "ana@example.com",
    displayName: "ana@example.com",
    status: "active",
    scopesJson: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
    capabilitiesJson: [],
    metadataJson: { legacyProjectId: "p0000000-0000-4000-8000-000000000001" },
    requiresReauth: false,
    isDefault: true,
    managedByUserId: null,
    grantedByUserId: null,
    grantedAt: new Date("2026-10-01T10:00:00Z"),
    lastReauthAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date("2026-10-01T10:00:00Z"),
    updatedAt: new Date("2026-10-01T10:00:00Z"),
    ...overrides,
  };
}

function usage(overrides: Partial<ConnectorUsageRecord>): ConnectorUsageRecord {
  return {
    providerConnectionId: "c0000000-0000-4000-8000-000000000001",
    localInstallationId: "i0000000-0000-4000-8000-000000000001",
    installationName: "laptop",
    agentId: "",
    routineKey: "",
    mode: "owner",
    conversation: "terminal",
    useCount: 1,
    lastUsedAt: new Date("2026-10-02T10:00:00Z"),
    ...overrides,
  };
}

function orgPolicy(overrides: Partial<ConnectorOrgPolicyRecord> = {}): ConnectorOrgPolicyRecord {
  return {
    organizationId: "o0000000-0000-4000-8000-000000000001",
    provider: "google",
    enabled: true,
    writesAllowed: true,
    sharedAllowed: false,
    toolCeilingsJson: {},
    ...overrides,
  };
}

const ALL_GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];

// The `ravi connectors list` / `show` return schemas the OSS checks an
// answer against in agent turns: the released CLI's, from before personal
// connections (`projectId: z.string()`), and the current one's.
const releasedCliItem = z.object({
  id: z.string(),
  projectId: z.string(),
  provider: z.string(),
  displayName: z.string(),
  status: z.string(),
  requiresReauth: z.boolean(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
});
const releasedCliDetail = releasedCliItem.extend({
  capabilities: z.array(z.string()),
  externalAccountLogin: z.string().nullable(),
  grantedAt: z.string(),
  lastReauthAt: z.string().nullable(),
});
const currentCliItem = releasedCliItem.extend({
  projectId: z.string().nullable(),
  externalAccountLogin: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  accessMode: z.enum(["full", "read_only"]).optional(),
  scopeKind: z.enum(["user", "organization"]).optional(),
});
const currentCliDetail = currentCliItem.extend({
  capabilities: z.array(z.string()),
  externalAccountLogin: z.string().nullable(),
  grantedAt: z.string(),
  lastReauthAt: z.string().nullable(),
  lastUsedAt: z.string().nullable().optional(),
  revokedAt: z.string().nullable().optional(),
});
const cliList = (item: z.ZodType) =>
  z.object({
    connections: z.array(item),
    pagination: z.object({ total: z.number(), limit: z.number(), offset: z.number(), returned: z.number() }),
  });

describe("connection views", () => {
  test("CLI items keep a string projectId that released and current CLIs both accept (until 2027-01-01)", () => {
    const legacyProject = "p0000000-0000-4000-8000-000000000001";
    const rows = [
      row(),
      row({ metadataJson: {} }),
      row({ scopeKind: "project", projectId: "p1", metadataJson: {} }),
      row({ scopeKind: "organization", userId: null, managedByUserId: "u1", metadataJson: {} }),
    ];
    const items = rows.map((entry) => toCliConnectionItem(entry, GOOGLE_WRITE_SCOPES));
    expect(items.map((item) => item.projectId)).toEqual([legacyProject, "", "p1", ""]);
    const listed = { connections: items, pagination: { total: 4, limit: 50, offset: 0, returned: 4 } };
    expect(cliList(releasedCliItem).safeParse(listed).success).toBe(true);
    expect(cliList(currentCliItem).safeParse(listed).success).toBe(true);
    for (const entry of rows) {
      const shown = { connection: toCliConnectionDetail(entry, GOOGLE_WRITE_SCOPES) };
      expect(z.object({ connection: releasedCliDetail }).safeParse(shown).success).toBe(true);
      expect(z.object({ connection: currentCliDetail }).safeParse(shown).success).toBe(true);
    }
    // The metadata itself never reaches the CLI.
    expect(JSON.stringify(items)).not.toContain("legacyProjectId");
  });

  test("CLI items derive the access mode and the scope kind", () => {
    const item = toCliConnectionItem(row({ scopeKind: "project", projectId: "p1" }), GOOGLE_WRITE_SCOPES);
    expect(item.scopeKind).toBe("user");
    expect(item.accessMode).toBe("read_only");
    expect(item.isDefault).toBe(true);
    expect(item.externalAccountLogin).toBe("ana@example.com");
    expect(JSON.stringify(item)).not.toContain("legacyProjectId");

    const full = toCliConnectionItem(
      row({ scopesJson: ["https://www.googleapis.com/auth/gmail.send"] }),
      GOOGLE_WRITE_SCOPES,
    );
    expect(full.accessMode).toBe("full");
  });

  test("CLI detail adds capabilities and dates", () => {
    const detail = toCliConnectionDetail(row({ lastReauthAt: new Date("2026-10-03T00:00:00Z") }), []);
    expect(detail.projectId).toBe("p0000000-0000-4000-8000-000000000001");
    expect(detail.lastReauthAt).toBe("2026-10-03T00:00:00.000Z");
    // Only what the granted scopes allow (Gmail read here), whatever capabilities_json says.
    expect(detail.capabilities).toEqual(["gmail.message.list", "gmail.message.read"]);
  });

  test("CLI detail lists the tools from the registry, by granted scopes and access mode", () => {
    const full = toCliConnectionDetail(row({ scopesJson: ALL_GOOGLE_SCOPES, capabilitiesJson: [] }), GOOGLE_WRITE_SCOPES);
    expect(full.capabilities).toEqual([
      "gmail.message.send",
      "gmail.message.list",
      "gmail.message.read",
      "gcal.event.list",
      "gcal.freebusy.query",
    ]);
    // Connected read only: no write, even when the scope is still granted.
    const readOnly = toCliConnectionDetail(
      row({ scopesJson: ALL_GOOGLE_SCOPES, metadataJson: { accessMode: "read_only" } }),
      GOOGLE_WRITE_SCOPES,
    );
    expect(readOnly.capabilities).not.toContain("gmail.message.send");
    expect(readOnly.capabilities).toContain("gcal.freebusy.query");
    // Calendar only.
    const calendar = toCliConnectionDetail(
      row({ scopesJson: ["openid", "https://www.googleapis.com/auth/calendar.readonly"] }),
      GOOGLE_WRITE_SCOPES,
    );
    expect(calendar.capabilities).toEqual(["gcal.event.list", "gcal.freebusy.query"]);
    // The same list as the Console's available tool rows.
    const tools = toToolRows(row({ scopesJson: ALL_GOOGLE_SCOPES, metadataJson: { accessMode: "read_only" } }), {
      capabilities: listProviderCapabilities("google"),
      orgPolicy: orgPolicy(),
      userPolicies: [],
    });
    expect(tools.filter((tool) => tool.available).map((tool) => tool.capability)).toEqual(readOnly.capabilities);
  });

  test("summaries carry up to five usage rows, newest first", () => {
    const entries = [1, 2, 3, 4, 5, 6].map((day) =>
      usage({ lastUsedAt: new Date(`2026-10-0${day}T10:00:00Z`), agentId: day === 6 ? "main" : "" }),
    );
    entries.push(usage({ providerConnectionId: "c0000000-0000-4000-8000-000000000002" }));
    entries.push(usage({ conversation: "legacy_cli", lastUsedAt: new Date("2026-09-01T00:00:00Z") }));
    const summary = toConnectionSummary(row(), GOOGLE_WRITE_SCOPES, entries);
    expect(summary.usedBy).toHaveLength(5);
    expect(summary.usedBy[0]!.agentId).toBe("main");
    expect(summary.usedBy[0]!.routineKey).toBeNull();
    expect(summary.usedBy.every((entry) => !entry.legacyCli)).toBe(true);
    expect(summary.email).toBe("ana@example.com");
    expect(summary.scopeKind).toBe("user");

    const legacy = toConnectionSummary(row(), GOOGLE_WRITE_SCOPES, [usage({ conversation: "legacy_cli" })]);
    expect(legacy.usedBy[0]!.legacyCli).toBe(true);
  });

  test("CLI items carry who used this connection", () => {
    const entries = [
      usage({ agentId: "main", routineKey: "cron:daily", conversation: "automation" }),
      usage({ providerConnectionId: "c0000000-0000-4000-8000-000000000002", agentId: "other" }),
    ];
    const item = toCliConnectionItem(row(), GOOGLE_WRITE_SCOPES, entries);
    expect(item.usedBy).toEqual([
      expect.objectContaining({ agentId: "main", routineKey: "cron:daily", conversation: "automation", mode: "owner" }),
    ]);
    expect(toCliConnectionItem(row(), GOOGLE_WRITE_SCOPES).usedBy).toEqual([]);
    expect(toCliConnectionDetail(row(), GOOGLE_WRITE_SCOPES, entries).usedBy).toHaveLength(1);
  });

  test("tool rows show the effective policy, the owner's choice, the ceiling and availability", () => {
    const tools = toToolRows(row({ scopesJson: ALL_GOOGLE_SCOPES }), {
      capabilities: listProviderCapabilities("google"),
      orgPolicy: orgPolicy({ toolCeilingsJson: { "gmail.message.read": "needs_approval" } }),
      userPolicies: [
        { capability: "gmail.message.send", policy: "always_allow" },
        { capability: "gcal.event.list", policy: "blocked" },
        { capability: "gmail.message.list", policy: "not-a-policy" },
      ],
    });
    const byId = Object.fromEntries(tools.map((tool) => [tool.capability, tool]));
    expect(tools.map((tool) => tool.capability)).toEqual(listProviderCapabilities("google").map((cap) => cap.id));
    expect(byId["gmail.message.send"]).toMatchObject({
      label: "Send email",
      class: "destructive",
      policy: "always_allow",
      userPolicy: "always_allow",
      ceiling: null,
      available: true,
    });
    expect(byId["gmail.message.read"]).toMatchObject({ policy: "needs_approval", userPolicy: null, ceiling: "needs_approval" });
    expect(byId["gcal.event.list"]).toMatchObject({ policy: "blocked", userPolicy: "blocked" });
    expect(byId["gmail.message.list"]).toMatchObject({ policy: "always_allow", userPolicy: null });
    expect(byId["gcal.freebusy.query"]).toMatchObject({ policy: "always_allow", available: true });

    const noWrites = toToolRows(row({ scopesJson: ALL_GOOGLE_SCOPES, metadataJson: { accessMode: "read_only" } }), {
      capabilities: listProviderCapabilities("google"),
      orgPolicy: orgPolicy({ writesAllowed: false }),
      userPolicies: [],
    });
    const send = noWrites.find((tool) => tool.capability === "gmail.message.send")!;
    expect(send).toMatchObject({ policy: "blocked", ceiling: "blocked", available: false });
    const calendar = toToolRows(row(), {
      capabilities: listProviderCapabilities("google"),
      orgPolicy: orgPolicy(),
      userPolicies: [],
    }).find((tool) => tool.capability === "gcal.freebusy.query")!;
    expect(calendar.available).toBe(false);
  });

  test("activity rows keep only what happened, never parameters", () => {
    const at = new Date("2026-10-05T10:00:00Z");
    expect(
      toActivityRow({
        action: "connector.action.executed",
        createdAt: at,
        metadata: { capability: "gmail.message.send", agentId: "main", conversation: "dm", subject: "x" },
      }),
    ).toEqual({
      action: "connector.action.executed",
      capability: "gmail.message.send",
      at: at.toISOString(),
      agentId: "main",
      conversation: "dm",
      outcome: "ok",
      code: null,
    });
    expect(toActivityRow({ action: "connector.action.denied", createdAt: at, metadata: {} })).toMatchObject({
      capability: null,
      agentId: null,
      outcome: "denied",
      code: null,
    });
    expect(
      toActivityRow({
        action: "connector.action.denied",
        createdAt: at,
        metadata: { code: "connector_tool_blocked" },
      }).code,
    ).toBe("connector_tool_blocked");
    expect(toActivityRow({ action: "connector.action.failed", createdAt: at, metadata: {} }).outcome).toBe("failed");
    const outcome = (action: string) => toActivityRow({ action, createdAt: at, metadata: {} }).outcome;
    expect(outcome("connector.approval.created")).toBe("ok");
    expect(outcome("connector.approval.approved")).toBe("ok");
    expect(outcome("connector.tool_policy.set")).toBe("ok");
    expect(outcome("connector.approval.denied")).toBe("denied");
    expect(outcome("connector.reauth_required")).toBe("failed");
  });

  test("organization policy and admin rows", () => {
    const view = toOrgPolicyView(
      orgPolicy({ toolCeilingsJson: { "gmail.message.send": "needs_approval", "gmail.message.read": "weird" } }),
      listProviderCapabilities("google"),
    );
    expect(view.toolCeilings).toEqual({ "gmail.message.send": "needs_approval", "gmail.message.read": "blocked" });
    expect(view.tools[0]).toEqual({ capability: "gmail.message.send", label: "Send email", class: "destructive" });

    const admin = toAdminConnectionRow({
      ...row({ scopeKind: "organization", userId: null, lastUsedAt: new Date("2026-10-04T00:00:00Z") }),
      memberUserId: "u2",
      memberEmail: "bo@example.com",
      memberName: "Bo",
    });
    expect(admin).toMatchObject({
      scopeKind: "organization",
      email: "ana@example.com",
      member: { userId: "u2", email: "bo@example.com", name: "Bo" },
      lastUsedAt: "2026-10-04T00:00:00.000Z",
    });
    expect(JSON.stringify(admin)).not.toContain("legacyProjectId");
  });
});
