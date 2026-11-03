import { describe, expect, test } from "bun:test";

import { ApiError } from "@/lib/api/client";

import type { AgentGrantRow, ToolRow, UsageRow } from "@/server/connectors/console-client";

import {
  consentAgentName,
  consentChoice,
  consentDecideBody,
  consentDecisionCopy,
  consentOperator,
  CONSENT_WRITES_LINE,
  consentStateCopy,
  consentTitle,
  consentTrustLine,
  consentView,
  defaultConsentConnectionId,
  finishConnectedView,
  isAgentOnOtherAccount,
  isSharedAccountsOff,
  noManagerText,
  sharedGrantConflict,
  sharedGrantConflictText,
  grantAccount,
  grantOperator,
  grantsByConnection,
  grantTitle,
  managerName,
  newestGrantsFirst,
  organizationInstallationLabel,
  sharedConversationsText,
  sharedGrantDraftError,
  accessLabel,
  activityView,
  approvalAskedBy,
  approvalPreview,
  approvalReasonText,
  approvalStateCopy,
  approvalSummaryLine,
  approvalView,
  approveGate,
  capabilityLabel,
  capabilityProvider,
  ceilingChange,
  ceilingHint,
  ceilingValue,
  CONNECTABLE_PROVIDERS,
  decisionCopy,
  groupTools,
  isMissingRoute,
  previewGapText,
  routineLabel,
  shownCeiling,
  stricterPolicy,
  toolPolicyHint,
  toolPolicyOptions,
  toolPolicyValue,
  usageDetails,
  usageTitle,
  usedBySentence,
  connectionLabel,
  connectionName,
  connectionStatus,
  connectLinkCopy,
  connectorErrorText,
  connectStartBody,
  defaultConnectionId,
  FINISH_OTHER_BROWSER_COPY,
  finishRejectedCopy,
  historyReason,
  isHistory,
  permissionsSentence,
  splitConnections,
  type Connection,
} from "./model";

let seq = 0;
function connection(overrides: Partial<Connection> = {}): Connection {
  seq += 1;
  return {
    accessMode: "full",
    createdAt: `2026-10-0${Math.min(seq, 9)}T10:00:00.000Z`,
    displayName: "google",
    email: `person${seq}@example.test`,
    grantedAt: `2026-10-0${Math.min(seq, 9)}T10:00:00.000Z`,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    isDefault: false,
    lastUsedAt: null,
    provider: "google",
    requiresReauth: false,
    revokedAt: null,
    scopeKind: "user",
    scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    status: "active",
    usedBy: [],
    ...overrides,
  };
}

describe("connection names", () => {
  test("the account email is the name; the provider default name is not a label", () => {
    const row = connection({ displayName: "google", email: "ana@example.test" });
    expect(connectionName(row)).toBe("ana@example.test");
    expect(connectionLabel(row)).toBeNull();
  });

  test("a custom name shows as the label, never instead of the email", () => {
    const row = connection({ displayName: "Work", email: "ana@example.test" });
    expect(connectionName(row)).toBe("ana@example.test");
    expect(connectionLabel(row)).toBe("Work");
    expect(connectionLabel(connection({ displayName: "ANA@example.test", email: "ana@example.test" }))).toBeNull();
    expect(connectionLabel(connection({ displayName: "Google" }))).toBeNull();
  });

  test("without an email the label or the provider names the row", () => {
    expect(connectionName(connection({ displayName: "Work", email: null }))).toBe("Work");
    expect(connectionName(connection({ displayName: "google", email: null }))).toBe("Google account");
  });
});

describe("status labels", () => {
  test("uses the personal-connections labels", () => {
    expect(connectionStatus(connection()).label).toBe("Connected");
    expect(connectionStatus(connection({ requiresReauth: true }))).toMatchObject({
      label: "Needs reconnecting",
      next: "reconnect",
    });
    expect(connectionStatus(connection({ status: "revoke_pending" }))).toMatchObject({
      label: "Disconnecting…",
      next: "retry-disconnect",
    });
    expect(connectionStatus(connection({ status: "suspended" })).label).toBe("Paused by Ravi");
    expect(connectionStatus(connection({ status: "degraded" })).label).toBe("Paused by Ravi");
    expect(connectionStatus(connection({ requiresReauth: true, status: "suspended" })).label).toBe("Paused by Ravi");
  });

  test("every history status reads Disconnected, with the reason apart", () => {
    for (const status of ["revoked_by_user", "revoked_by_operator", "revoked_by_provider", "tampered"]) {
      const row = connection({ status });
      expect(isHistory(row)).toBe(true);
      expect(connectionStatus(row).label).toBe("Disconnected");
    }
    expect(historyReason(connection({ status: "revoked_by_user" }))).toBe("You disconnected it");
    expect(historyReason(connection({ status: "revoked_by_provider" }))).toBe("Google ended access");
    expect(isHistory(connection({ status: "revoke_pending" }))).toBe(false);
  });
});

describe("lists", () => {
  test("splits live rows from history, default first, and drops GitHub rows", () => {
    const older = connection({ createdAt: "2026-01-01T00:00:00.000Z", grantedAt: "", isDefault: true });
    const newer = connection({ createdAt: "2026-05-01T00:00:00.000Z", grantedAt: "" });
    const gone = connection({ status: "revoked_by_user" });
    const github = connection({ provider: "github" });
    const { current, history } = splitConnections([newer, gone, older, github]);
    expect(current.map((row) => row.id)).toEqual([older.id, newer.id]);
    expect(history.map((row) => row.id)).toEqual([gone.id]);
  });

  test("the default is the live marked row, as the CLI picks it, else the newest working row", () => {
    const older = connection({ createdAt: "2026-01-01T00:00:00.000Z", grantedAt: "" });
    const newer = connection({ createdAt: "2026-05-01T00:00:00.000Z", grantedAt: "" });
    expect(defaultConnectionId([older, newer], "google")).toBe(newer.id);
    const marked = { ...older, isDefault: true };
    expect(defaultConnectionId([marked, newer], "google")).toBe(marked.id);
    // `ravi gmail` still runs on a marked row that needs reconnecting, so the badge stays on it.
    const brokenMarked = { ...older, isDefault: true, requiresReauth: true };
    expect(defaultConnectionId([brokenMarked, newer], "google")).toBe(brokenMarked.id);
    for (const status of ["degraded", "suspended", "revoke_pending"]) {
      expect(defaultConnectionId([{ ...older, isDefault: true, status }, newer], "google")).toBe(older.id);
    }
    // A marked row with no credentials left doesn't count.
    expect(defaultConnectionId([{ ...older, isDefault: true, status: "revoked_by_user" }, newer], "google")).toBe(newer.id);
    expect(defaultConnectionId([{ ...newer, requiresReauth: true }, older], "google")).toBe(older.id);
    expect(defaultConnectionId([connection({ status: "revoked_by_user" })], "google")).toBeNull();
    expect(defaultConnectionId([connection({ requiresReauth: true })], "google")).toBeNull();
  });
});

describe("permissions", () => {
  test("says what the scopes allow, without identity scopes", () => {
    expect(permissionsSentence(connection().scopes)).toBe("Read email · Send email");
    expect(permissionsSentence(["openid", "email"])).toBe("Basic profile only");
    expect(accessLabel(connection({ accessMode: "read_only" }))).toBe("Read only");
  });

  test("the read-only catalog option drops every write permission", () => {
    const google = CONNECTABLE_PROVIDERS.find((provider) => provider.id === "google");
    expect(google?.permissions).toContain("Send email");
    expect(google?.readOnlyPermissions).toEqual(["Read email", "See calendar"]);
  });
});

describe("connect start body", () => {
  test("never carries a project; reconnect keeps the access mode unless told otherwise", () => {
    expect(connectStartBody("google")).toEqual({ accessMode: "full", provider: "google" });
    expect(connectStartBody("google", { accessMode: "read_only" })).toEqual({ accessMode: "read_only", provider: "google" });
    const readOnly = connection({ accessMode: "read_only" });
    expect(connectStartBody("google", { reconnect: readOnly })).toEqual({
      accessMode: "read_only",
      provider: "google",
      reconnectConnectionId: readOnly.id,
    });
    expect(connectStartBody("google", { accessMode: "full", reconnect: readOnly })).toEqual({
      accessMode: "full",
      provider: "google",
      reconnectConnectionId: readOnly.id,
    });
  });
});

describe("connect page copy", () => {
  test("an impersonation session and another browser get their own copy", () => {
    expect(connectLinkCopy("impersonation").title).toBe("Connecting needs the person's own session");
    expect(FINISH_OTHER_BROWSER_COPY.description).toContain("Start again");
  });

  test("the mismatch copy tells the person what to do", () => {
    expect(connectLinkCopy("user_mismatch").description).toBe(
      "This link was made for another Ravi account. Sign in as that person or ask them for a new link.",
    );
    expect(connectLinkCopy("something-else").title).toBe("This link isn't valid");
    expect(finishRejectedCopy("provider_denied").description).toContain("You didn't allow access in Google");
    expect(finishRejectedCopy("whatever").title).toBe("Nothing was connected");
    expect(finishRejectedCopy("account_changed").title).toBe("That's a different account");
    expect(finishRejectedCopy("account_changed").description).toContain("nothing changed");
    expect(finishRejectedCopy("forbidden").title).toBe("You can't connect this organization account");
    expect(finishRejectedCopy("identity_missing").description).toContain("allow Ravi to see your email address");
    expect(finishRejectedCopy("not_member").description).toContain("no longer a member");
  });

  test("finishing an organization account never says it's the person's own", () => {
    const base = { accountChanged: false, created: true, email: "support@acme.test", provider: "google", reconnected: false };
    const created = finishConnectedView({ ...base, scopeKind: "organization" });
    expect(created).toEqual({
      account: "support@acme.test",
      href: "/org/connectors",
      linkLabel: "View organization accounts",
      listedIn: "Organization accounts",
      sentence:
        "is now an account of the organization, and you manage it: its approvals come to you. Agents use it only where an owner or admin shares it.",
      title: "Organization Google account connected",
    });
    expect(created.sentence).not.toContain("your Ravi account");
    const reconnected = finishConnectedView({ ...base, created: false, reconnected: true, scopeKind: "organization" });
    expect(reconnected.title).toBe("Organization Google account reconnected");
    expect(reconnected.sentence).toBe("works again for the agents that share it.");
    expect(finishConnectedView({ ...base, email: null, scopeKind: "organization" }).sentence).toMatch(/^The organization's Google account is now/);

    // A personal account, or a Worker that doesn't say: the person's own connections.
    for (const scopeKind of ["user", undefined] as const) {
      const own = finishConnectedView({ ...base, scopeKind });
      expect(own).toMatchObject({ account: "support@acme.test", href: "/connectors", listedIn: "Connectors", title: "Google connected" });
      expect(own.sentence).toBe("is connected to your Ravi account. Agents use it only as you allow.");
    }
    expect(finishConnectedView({ ...base, accountChanged: true, created: true, reconnected: false }).title).toBe("Google connected");
    expect(finishConnectedView({ ...base, created: false, reconnected: true }).title).toBe("Google reconnected");
  });
});

describe("errors in plain words", () => {
  test("rename names the Worker's limit", () => {
    expect(connectorErrorText(new ApiError(400, "payload_invalid", "x"), "rename")).toBe("Use a name of 1 to 120 characters.");
  });

  test("only the Console's own 401 says the session ended", () => {
    expect(connectorErrorText(new ApiError(401, "unauthorized", "x"))).toBe("Your session ended. Sign in again.");
    expect(connectorErrorText(new ApiError(502, "connector_service_unavailable", "x"))).toContain("Try again in a moment");
    expect(connectorErrorText(new ApiError(403, "impersonation", "x"), "rename")).toContain("signed in as someone else");
  });
});

function tool(overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    available: true,
    capability: "gmail.message.send",
    ceiling: null,
    class: "write",
    label: "Send email",
    policy: "needs_approval",
    userPolicy: null,
    ...overrides,
  };
}

function usage(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    agentId: "main",
    conversation: "dm",
    installationId: "i1",
    installationName: "ana-mbp",
    lastUsedAt: "2026-10-10T08:00:00.000Z",
    legacyCli: false,
    mode: "owner",
    routineKey: null,
    useCount: 3,
    ...overrides,
  };
}

describe("tools", () => {
  test("group Read then Write; destructive tools are writes; empty groups are left out", () => {
    const read = tool({ capability: "gmail.message.read", class: "read", label: "Read your email" });
    const send = tool();
    const remove = tool({ capability: "gmail.message.trash", class: "destructive", label: "Delete email" });
    expect(groupTools([send, read, remove]).map((group) => [group.title, group.tools.map((item) => item.capability)])).toEqual([
      ["Read", ["gmail.message.read"]],
      ["Write", ["gmail.message.send", "gmail.message.trash"]],
    ]);
    expect(groupTools([read]).map((group) => group.key)).toEqual(["read"]);
    expect(groupTools([])).toEqual([]);
  });

  test("options looser than the ceiling are disabled", () => {
    const disabled = (ceiling: ToolRow["ceiling"]) =>
      toolPolicyOptions({ ceiling })
        .filter((option) => option.disabled)
        .map((option) => option.label);
    expect(disabled(null)).toEqual([]);
    expect(disabled("always_allow")).toEqual([]);
    expect(disabled("needs_approval")).toEqual(["Always allow"]);
    expect(disabled("blocked")).toEqual(["Always allow", "Needs approval"]);
    expect(toolPolicyOptions({ ceiling: null }).map((option) => option.value)).toEqual(["always_allow", "needs_approval", "blocked"]);
  });

  test("the select shows the rule in force, never looser than the ceiling", () => {
    expect(toolPolicyValue(tool({ policy: "always_allow" }))).toBe("always_allow");
    expect(toolPolicyValue(tool({ ceiling: "needs_approval", policy: "always_allow" }))).toBe("needs_approval");
    expect(toolPolicyValue(tool({ ceiling: "needs_approval", policy: "blocked" }))).toBe("blocked");
    expect(stricterPolicy("always_allow", "blocked")).toBe("blocked");
    expect(stricterPolicy("blocked", "needs_approval")).toBe("blocked");
    expect(stricterPolicy("needs_approval", null)).toBe("needs_approval");
  });

  test("hints say what limits a tool", () => {
    expect(toolPolicyHint(tool())).toBeNull();
    expect(toolPolicyHint(tool({ ceiling: "needs_approval" }))).toBe("Your organization requires approval, so Always allow is off.");
    expect(toolPolicyHint(tool({ ceiling: "blocked" }))).toBe("Your organization blocked this tool.");
    expect(toolPolicyHint(tool({ available: false }))).toBe("This account is read only. Allow writing to use it.");
    expect(toolPolicyHint(tool({ available: false, class: "read" }))).toContain("Reconnect");
  });
});

describe("used by and activity", () => {
  test("names who used the account, where, and how", () => {
    expect(usageTitle(usage())).toBe("Agent main on ana-mbp");
    expect(usageTitle(usage({ agentId: null, conversation: "terminal" }))).toBe("The terminal on ana-mbp");
    expect(usageTitle(usage({ agentId: null, installationName: null }))).toBe("The terminal");
    expect(usageDetails(usage())).toBe("Direct message · Only when you ask");
    expect(usageDetails(usage({ conversation: "automation", routineKey: "cron:daily-brief" }))).toBe(
      "Cron job daily-brief · Routine · Only when you ask",
    );
    expect(usageDetails(usage({ conversation: "terminal", mode: "person_asking" }))).toBe("The person asking");
  });

  test("rows from an old CLI say an older Ravi version", () => {
    const legacy = usage({ agentId: null, conversation: "legacy_cli", legacyCli: true });
    expect(usageTitle(legacy)).toBe("An older Ravi version on ana-mbp");
    expect(usageDetails(legacy)).toContain("Update ravi");
    expect(usedBySentence([legacy])).toBe("Used by: an older Ravi version on ana-mbp");
  });

  test("routines in words", () => {
    expect(routineLabel("cron:abc")).toBe("Cron job abc");
    expect(routineLabel("heartbeat")).toBe("Heartbeat");
    expect(routineLabel("trigger:t1")).toBe("Trigger t1");
    expect(routineLabel("")).toBeNull();
    expect(routineLabel("custom")).toBe("custom");
  });

  test("the row's Used by line names the first two and counts the rest", () => {
    expect(usedBySentence([])).toBeNull();
    expect(usedBySentence([usage(), usage({ routineKey: "cron:x" })])).toBe("Used by: main on ana-mbp");
    expect(
      usedBySentence([
        usage(),
        usage({ agentId: null, installationName: null }),
        usage({ agentId: "ops", installationName: "server" }),
        usage({ agentId: "x", installationName: null }),
      ]),
    ).toBe("Used by: main on ana-mbp, the terminal +2 more");
  });

  test("activity in words, never content", () => {
    // The Worker lists connector.action.executed / denied / failed and audits a
    // write that waits for its owner as denied, with its code in the metadata.
    const denied = (code?: string | null) => activityView({ action: "connector.action.denied", code, outcome: "denied" });
    expect(activityView({ action: "connector.action.executed", outcome: "ok" })).toEqual({ badge: null, text: "Ran" });
    expect(activityView({ action: "connector.action.failed", outcome: "failed" })).toEqual({ badge: null, text: "Failed" });
    expect(denied("connector_approval_required")).toEqual({ badge: null, text: "Asked for your approval" });
    expect(denied("connector_approval_pending").text).toBe("Waiting for your approval");
    expect(denied("connector_approval_denied").text).toBe("You denied it");
    expect(denied("connector_tool_blocked").text).toBe("Refused");
    expect(denied("connector_group_blocked").text).toBe("Refused");
    // Without the code it may have waited for an approval: never "Refused".
    expect(denied(null)).toEqual({ badge: null, text: "Didn't run" });
    expect(denied(undefined).text).toBe("Didn't run");
    expect(activityView({ action: "connector.something_new", outcome: "denied" })).toEqual({
      badge: { label: "Refused", tone: "warn" },
      text: "Something new",
    });
    expect(activityView({ action: "connector.something_new", outcome: "failed" }).badge).toEqual({ label: "Failed", tone: "err" });
    expect(activityView({ action: "connector.something_new", outcome: "ok" })).toEqual({ badge: null, text: "Something new" });
    expect(capabilityLabel("gmail.message.send")).toBe("Send email");
    expect(capabilityLabel("gmail.message.send", [tool({ label: "Send mail" })])).toBe("Send mail");
    expect(capabilityLabel("x.y")).toBe("x.y");
    expect(capabilityLabel(null)).toBeNull();
  });
});

describe("approvals", () => {
  const approval = {
    agentId: "main",
    capability: "gmail.message.send",
    connectionId: "c1",
    conversation: "dm",
    email: "ana@example.test",
    expiresAt: "2026-10-10T10:15:00.000Z",
    id: "a1",
    installationName: "ana-mbp",
    label: "Send email",
    preview: null,
    reason: "policy" as const,
    requestedAt: "2026-10-10T10:00:00.000Z",
    routine: null,
    sessionName: "main-dm",
    speakerKind: "owner",
    status: "pending",
  };

  test("why the owner is asked", () => {
    expect(approvalReasonText("policy")).toBe("Your rules ask for approval");
    expect(approvalReasonText("write_after_read")).toBe(
      "This agent read your email or calendar in the same task, so writing needs your OK",
    );
  });

  test("what happens next after a decision", () => {
    expect(decisionCopy("approved").description).toBe("The agent can continue now.");
    expect(decisionCopy("denied").description).toBe("The agent was told no.");
    expect(decisionCopy("expired").title).toBe("This request expired");
  });

  test("a pending approval past its expiry reads expired; decided ones keep their state", () => {
    const now = Date.parse("2026-10-10T10:10:00.000Z");
    expect(approvalView(approval, now)).toBe("pending");
    expect(approvalView(approval, Date.parse("2026-10-10T10:15:00.000Z"))).toBe("expired");
    for (const status of ["approved", "consumed", "denied", "expired"] as const) {
      expect(approvalView({ ...approval, status }, now)).toBe(status);
    }
    expect(approvalStateCopy("consumed").title).toBe("This request already ran");
    expect(approvalStateCopy("denied").description).toContain("The agent was told no.");
    expect(approvalStateCopy("whatever").title).toBe("We couldn't find this request");
    expect(approvalStateCopy("impersonation").title).toBe("Deciding needs the person's own session");
  });

  test("who asked lists only what the request says", () => {
    expect(approvalAskedBy(approval)).toEqual([
      { label: "Computer", value: "ana-mbp" },
      { label: "Agent", value: "main" },
      { label: "Session", value: "main-dm" },
      { label: "Conversation", value: "Direct message" },
    ]);
    expect(approvalAskedBy({ ...approval, agentId: null, conversation: null, installationName: null, routine: { id: "daily", kind: "cron" }, sessionName: null })).toEqual([
      { label: "Routine", value: "Cron job daily" },
    ]);
    expect(approvalSummaryLine(approval)).toBe("ana@example.test · Agent main on ana-mbp");
  });

  test("the preview: envelope fields, the body excerpt, and anything else as JSON", () => {
    expect(approvalPreview(null)).toEqual({ body: null, fields: [], gaps: [], html: null, missing: true, other: null });
    const preview = approvalPreview({
      bcc: [],
      body: "Hello\nthere",
      cc: "c@example.test",
      subject: "Lunch",
      to: ["a@example.test", "b@example.test"],
    });
    expect(preview.fields).toEqual([
      { label: "To", value: "a@example.test, b@example.test" },
      { label: "Cc", value: "c@example.test" },
      { label: "Subject", value: "Lunch" },
    ]);
    expect(preview.body).toBe("Hello\nthere");
    expect(preview.other).toBeNull();
    expect(preview.gaps).toEqual([]);
    expect(approveGate(preview)).toBe("allowed");
    expect(approvalPreview({ calendarId: "primary", timeMin: "t" }).other).toBe(
      JSON.stringify({ calendarId: "primary", timeMin: "t" }, null, 2),
    );
    expect(approvalPreview({}).missing).toBe(false);
    expect(capabilityProvider("gmail.message.send")).toBe("google");
    expect(capabilityProvider("gcal.event.list")).toBe("google");
    expect(capabilityProvider("slack.post")).toBeNull();
  });
});

describe("organization rules", () => {
  test("a ceiling change names one tool; No limit is null", () => {
    const ceilings = { "gmail.message.read": "needs_approval" as const, "gmail.message.send": "blocked" as const };
    expect(ceilingValue(ceilings, "gmail.message.send")).toBe("blocked");
    expect(ceilingValue(ceilings, "gcal.event.list")).toBe("none");
    expect(ceilingValue({ "gcal.event.list": "always_allow" }, "gcal.event.list")).toBe("none");
    expect(ceilingChange("gmail.message.send", "none")).toEqual({ capability: "gmail.message.send", ceiling: null });
    expect(ceilingChange("gcal.event.list", "blocked")).toEqual({ capability: "gcal.event.list", ceiling: "blocked" });
    // While a change saves, only that tool's select shows it.
    const pending = ceilingChange("gmail.message.send", "none");
    expect(shownCeiling(ceilings, "gmail.message.send", pending)).toBe("none");
    expect(shownCeiling(ceilings, "gmail.message.read", pending)).toBe("needs_approval");
    expect(shownCeiling(ceilings, "gmail.message.send", null)).toBe("blocked");
  });

  test("with writing tools off, write limits read as blocked", () => {
    expect(ceilingHint({ class: "write" }, { writesAllowed: false })).toBe("Writing tools are off, so this is blocked.");
    expect(ceilingHint({ class: "read" }, { writesAllowed: false })).toBeNull();
    expect(ceilingHint({ class: "write" }, { writesAllowed: true })).toBeNull();
  });

  test("shared accounts being off is told apart from the connector being off", () => {
    const sharedOff = new ApiError(403, "connector_disabled_by_org", "shared_not_allowed", { reason: "shared_not_allowed" });
    expect(isSharedAccountsOff(sharedOff)).toBe(true);
    expect(connectorErrorText(sharedOff, "admin")).toBe(
      "Shared accounts are off for this organization. Turn on Allow shared accounts first.",
    );
    const off = new ApiError(403, "connector_disabled_by_org", "x");
    expect(isSharedAccountsOff(off)).toBe(false);
    expect(connectorErrorText(off, "admin")).toBe("An owner or admin turned this connector off for the organization.");
  });

  test("errors for rules, approvals and admin writes", () => {
    expect(connectorErrorText(new ApiError(409, "connector_policy_above_ceiling", "x"), "policy")).toContain("Pick a stricter one");
    expect(connectorErrorText(new ApiError(403, "connector_forbidden", "x"), "admin")).toBe("Only owners and admins can change this.");
    expect(connectorErrorText(new ApiError(404, "not_found", "x"), "admin")).toBe("This connection no longer exists. Reload the list.");
    expect(connectorErrorText(new ApiError(404, "not_found", "x"), "decide")).toContain("another Ravi account");
    expect(connectorErrorText(new ApiError(400, "connector_approval_invalid", "x"), "decide")).toContain("can't be decided anymore");
  });

  test("connector_forbidden outside admin routes means not an active member, never a role", () => {
    // The Worker's connect start answers it for an inactive member, organization or user.
    for (const action of ["connect", "load", "policy", "rename", "default", "disconnect", "decide"] as const) {
      expect(connectorErrorText(new ApiError(403, "connector_forbidden", "x"), action)).toBe(
        "You aren't an active member of this organization.",
      );
    }
  });

  test("a manager who isn't an owner or admin reads refusals in their own words", () => {
    expect(connectorErrorText(new ApiError(403, "connector_forbidden", "x"), "manage")).toBe(
      "Only this account's manager, owners and admins can change this.",
    );
    expect(connectorErrorText(new ApiError(404, "connector_unavailable", "x"), "manage")).toContain("you don't manage it anymore");
    const sharedOff = new ApiError(403, "connector_disabled_by_org", "x", { reason: "shared_not_allowed" });
    expect(connectorErrorText(sharedOff, "manage")).toBe(
      "Shared accounts are off for this organization. An owner or admin can turn them on.",
    );
  });

  test("an agent that uses another organization account is told apart from a plain refusal", () => {
    const elsewhere = new ApiError(403, "connector_forbidden", "x", { reason: "agent_uses_other_account" });
    expect(isAgentOnOtherAccount(elsewhere)).toBe(true);
    expect(isAgentOnOtherAccount(new ApiError(403, "connector_forbidden", "x"))).toBe(false);
    for (const action of ["admin", "manage"] as const) {
      expect(connectorErrorText(elsewhere, action)).toContain("uses another organization account");
    }
  });
});

describe("rollout: a connectors service without the new routes", () => {
  test("its unknown-route not_found is told apart from a missing connection", () => {
    expect(isMissingRoute(new ApiError(404, "not_found", "Unknown UI route"))).toBe(true);
    expect(isMissingRoute(new ApiError(404, "connector_unavailable", "Connection not found"))).toBe(false);
    expect(isMissingRoute(new ApiError(400, "not_found", "x"))).toBe(false);
    expect(isMissingRoute(new Error("not_found"))).toBe(false);
  });
});

describe("approval preview: the Worker's real shapes", () => {
  // workers/connectors/src/approvals.ts approvalPreview() for gmail.message.send.
  const email = { bcc: [], cc: [], subject: "Re: invoice", to: ["x@example.test"] };

  test("an HTML part and a cut body are gaps, never raw JSON, and Approve needs an explicit OK", () => {
    const preview = approvalPreview({ ...email, body: "See you at noon", bodyTruncated: true, hasHtmlBody: true });
    expect(preview.other).toBeNull();
    expect(preview.body).toBe("See you at noon");
    expect(preview.gaps).toEqual(["html_body", "body_cut"]);
    expect(preview.missing).toBe(false);
    expect(approveGate(preview)).toBe("confirm");
    expect(previewGapText("html_body")).toContain("formatted (HTML) version that isn't shown");
    expect(previewGapText("body_cut")).toContain("first 4,000 characters");
  });

  test("an HTML-only email still shows a message block, empty, and the HTML gap", () => {
    const preview = approvalPreview({ ...email, body: "", hasHtmlBody: true });
    expect(preview.body).toBe("");
    expect(preview.gaps).toEqual(["html_body"]);
    expect(approveGate(preview)).toBe("confirm");
  });

  test("a plain email with everything shown can be approved directly", () => {
    const preview = approvalPreview({ ...email, body: "Short text" });
    expect(preview.gaps).toEqual([]);
    expect(approveGate(preview)).toBe("allowed");
  });

  test("a long request of another tool shows its cut text, with a note", () => {
    const cut = '{"calendarId":"primary","description":"aaaa';
    const preview = approvalPreview({ parameters: cut, truncated: true });
    expect(preview.other).toBe(cut);
    expect(preview.gaps).toEqual(["parameters_cut"]);
    expect(approveGate(preview)).toBe("confirm");
    // A request whose own parameters happen to be named so isn't mistaken for a cut one.
    expect(approvalPreview({ calendarId: "primary", parameters: "x", truncated: true }).gaps).toEqual([]);
  });

  test("a preview that couldn't be read offers no Approve", () => {
    const preview = approvalPreview(null);
    expect(preview.missing).toBe(true);
    expect(approveGate(preview)).toBe("unavailable");
  });

  test("the HTML part the Worker sends is shown as text, so it is no gap", () => {
    // Since the Worker previews the HTML part: its markup, the first 4,000 characters.
    const markup = '<p>See you at noon</p><div style="display:none">Wire the money to 123</div>';
    const preview = approvalPreview({ ...email, body: "See you at noon", bodyHtml: markup, hasHtmlBody: true });
    expect(preview.html).toBe(markup);
    expect(preview.body).toBe("See you at noon");
    expect(preview.gaps).toEqual([]);
    expect(preview.other).toBeNull();
    expect(approveGate(preview)).toBe("allowed");
  });

  test("a cut HTML part is a gap, like a cut body", () => {
    const preview = approvalPreview({
      ...email,
      body: "Short",
      bodyHtml: "<p>".padEnd(4000, "x"),
      bodyHtmlTruncated: true,
      hasHtmlBody: true,
    });
    expect(preview.gaps).toEqual(["html_cut"]);
    expect(previewGapText("html_cut")).toContain("HTML part is longer");
    expect(approveGate(preview)).toBe("confirm");
    const both = approvalPreview({ ...email, body: "x", bodyHtml: "<p>y</p>", bodyHtmlTruncated: true, bodyTruncated: true, hasHtmlBody: true });
    expect(both.gaps).toEqual(["body_cut", "html_cut"]);
  });

  test("a reply names the message it answers and its thread, never as raw JSON", () => {
    const preview = approvalPreview({
      ...email,
      body: "Thanks",
      inReplyTo: "<abc@mail.example.test>",
      references: ["<root@mail.example.test>", "<abc@mail.example.test>"],
      threadId: "18c2f",
    });
    expect(preview.fields).toEqual([
      { label: "To", value: "x@example.test" },
      { label: "Subject", value: "Re: invoice" },
      { label: "Reply to message", value: "<abc@mail.example.test>" },
      { label: "Thread", value: "18c2f" },
      { label: "References", value: "<root@mail.example.test>, <abc@mail.example.test>" },
    ]);
    expect(preview.other).toBeNull();
    expect(preview.html).toBeNull();
  });
});

function grant(overrides: Partial<AgentGrantRow> = {}): AgentGrantRow {
  return {
    agentId: "main",
    connectionId: "c1",
    conversations: ["dm"],
    createdAt: "2026-10-05T10:00:00.000Z",
    email: "me@example.test",
    id: "g1",
    installationId: "i1",
    installationName: "ana-mbp",
    mode: "person_asking",
    operator: { email: "ana@example.test", userId: "u1" },
    provider: "google",
    ...overrides,
  };
}

describe("consent", () => {
  const view = {
    agentDisplayName: null as string | null,
    agentId: "support",
    installationName: "ana-mbp" as string | null,
    provider: "google",
  };

  test("the title names the agent, the computer and the provider", () => {
    expect(consentTitle(view)).toBe("support on ana-mbp wants to use your Google account when you ask it something");
    expect(consentTitle({ ...view, agentDisplayName: " Support bot ", installationName: null })).toBe(
      "Support bot wants to use your Google account when you ask it something",
    );
    expect(consentAgentName({ agentDisplayName: "  ", agentId: "support" })).toBe("support");
  });

  test("who runs it: name and email, or whichever the request has", () => {
    expect(consentOperator({ operatorEmail: "ana@example.test", operatorName: "Ana" })).toBe("Ana (ana@example.test)");
    expect(consentOperator({ operatorEmail: "ana@example.test", operatorName: "ANA@example.test" })).toBe("ANA@example.test");
    expect(consentOperator({ operatorEmail: "ana@example.test", operatorName: null })).toBe("ana@example.test");
    expect(consentOperator({ operatorEmail: null, operatorName: null })).toBeNull();
  });

  test("the default account is preselected, else the first; none when there are none", () => {
    expect(
      defaultConsentConnectionId([
        { email: "a@example.test", id: "a", isDefault: false },
        { email: "b@example.test", id: "b", isDefault: true },
      ]),
    ).toBe("b");
    expect(defaultConsentConnectionId([{ email: null, id: "a", isDefault: false }])).toBe("a");
    expect(defaultConsentConnectionId([])).toBeNull();
  });

  test("a pending request past its expiry reads expired", () => {
    const now = Date.parse("2026-10-10T12:00:00.000Z");
    expect(consentView({ expiresAt: "2026-10-10T11:59:59.000Z" }, now)).toBe("expired");
    expect(consentView({ expiresAt: "2026-10-11T12:00:00.000Z" }, now)).toBe("pending");
    expect(consentView({ expiresAt: "" }, now)).toBe("pending");
  });

  test("states in words; another person's request says only that", () => {
    expect(consentStateCopy("user_mismatch").title).toBe("This request is for another Ravi account.");
    expect(consentStateCopy("expired").title).toBe("This request expired");
    expect(consentStateCopy("used").title).toBe("This request was already answered");
    expect(consentStateCopy("impersonation").title).toBe("Allowing needs the person's own session");
    expect(consentStateCopy("invalid").title).toBe("This link isn't valid");
    expect(consentStateCopy("anything").title).toBe("This link isn't valid");
    for (const state of ["user_mismatch", "expired", "used", "invalid", "not_member", "unavailable"]) {
      expect(consentStateCopy(state).description).not.toContain("@");
    }
  });

  test("what happens next", () => {
    const input = { agent: "support", email: "me@example.test", provider: "Google" };
    expect(consentDecisionCopy("approved", input)).toEqual({
      description:
        "support can now use me@example.test when you ask it something, under your rules. Go back to the conversation and ask again. You can revoke it any time in Connectors.",
      title: "Allowed",
    });
    expect(consentDecisionCopy("denied", input).title).toBe("Denied");
    expect(consentDecisionCopy("expired", input).title).toBe("This request expired");
    expect(consentDecisionCopy("approved", { ...input, email: null }).description).toContain("your Google account");
  });

  test("a stale choice falls back to the default; the default account is sent as no account", () => {
    const accounts = [
      { email: "a@example.test", id: "a", isDefault: true },
      { email: "b@example.test", id: "b", isDefault: false },
    ];
    expect(consentChoice(accounts, null)).toBe("a");
    expect(consentChoice(accounts, "b")).toBe("b");
    // The picked account was disconnected elsewhere and the list was read again.
    expect(consentChoice(accounts, "gone")).toBe("a");
    expect(consentChoice([], "gone")).toBeNull();

    expect(consentDecideBody({ chosen: "a", connections: accounts, decision: "approve", token: "t" })).toEqual({
      decision: "approve",
      token: "t",
    });
    expect(consentDecideBody({ chosen: "b", connections: accounts, decision: "approve", token: "t" })).toEqual({
      connectionId: "b",
      decision: "approve",
      token: "t",
    });
    expect(consentDecideBody({ chosen: "b", connections: accounts, decision: "deny", token: "t" })).toEqual({
      decision: "deny",
      token: "t",
    });
    // Without a default, the only account is pinned.
    expect(
      consentDecideBody({ chosen: "c", connections: [{ email: null, id: "c", isDefault: false }], decision: "approve", token: "t" }),
    ).toEqual({ connectionId: "c", decision: "approve", token: "t" });
  });

  test("the writes line says every write asks first, Always allow included", () => {
    expect(CONSENT_WRITES_LINE).toContain("always ask you first");
    expect(CONSENT_WRITES_LINE).toContain("even ones you set to Always allow");
  });

  test("the trust line says the operator's computer names who is asking", () => {
    expect(consentTrustLine({ installationName: "ana-mbp", operatorEmail: "ana@example.test", operatorName: "Ana" })).toBe(
      "Ana's computer ana-mbp tells Ravi who is asking. Approve only if you trust Ana with your account.",
    );
    expect(consentTrustLine({ installationName: null, operatorEmail: "ana@example.test", operatorName: null })).toBe(
      "ana@example.test's computer tells Ravi who is asking. Approve only if you trust ana@example.test with your account.",
    );
    expect(consentTrustLine({ installationName: null, operatorEmail: null, operatorName: null })).toBe(
      "The computer that runs the agent tells Ravi who is asking. Approve only if you trust whoever runs it with your account.",
    );
  });

  test("allowed with the default account: the agent follows the default", () => {
    expect(
      consentDecisionCopy("approved", { agent: "support", email: "me@example.test", followsDefault: true, provider: "Google" }).description,
    ).toContain("can now use your default Google account (me@example.test now)");
  });

  test("consent errors in words", () => {
    expect(connectorErrorText(new ApiError(403, "user_mismatch", "x"), "consent")).toBe("This request is for another Ravi account.");
    expect(connectorErrorText(new ApiError(409, "connector_connection_required", "x"), "consent")).toBe(
      "Connect an account first, then allow the agent to use it.",
    );
    expect(connectorErrorText(new ApiError(403, "impersonation", "x"), "consent")).toBe(consentStateCopy("impersonation").description);
    expect(connectorErrorText(new ApiError(404, "consent_invalid", "x"), "consent")).toBe(consentStateCopy("invalid").description);
  });
});

describe("agent grants", () => {
  test("a grant in words: agent and computer, account, operator", () => {
    expect(grantTitle(grant())).toBe("Agent main on ana-mbp");
    expect(grantTitle(grant({ agentId: "", installationName: null }))).toBe("An agent");
    expect(grantAccount(grant())).toBe("me@example.test");
    expect(grantAccount(grant({ email: null }))).toBe("Google account");
    expect(grantAccount(grant({ connectionId: null, email: null }))).toBe("Your default Google account");
    expect(grantOperator(grant())).toBe("Run by ana@example.test");
    expect(grantOperator(grant({ operator: null }))).toBeNull();
  });

  test("newest first; a grant without a date goes last", () => {
    const rows = newestGrantsFirst([
      grant({ createdAt: "2026-10-01T00:00:00.000Z", id: "old" }),
      grant({ createdAt: "", id: "none" }),
      grant({ createdAt: "2026-10-09T00:00:00.000Z", id: "new" }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["new", "old", "none"]);
  });
});

describe("organization accounts", () => {
  test("conversations in words, Direct messages first", () => {
    expect(sharedConversationsText(["group", "dm"])).toBe("Direct messages · Groups");
    expect(sharedConversationsText(["dm"])).toBe("Direct messages");
    expect(sharedConversationsText(["automation"])).toBe("automation");
    expect(sharedConversationsText([])).toBe("No conversations");
  });

  test("shared grants per account, newest first; personal grants and grants without an account are left out", () => {
    const byConnection = grantsByConnection([
      grant({ connectionId: "c1", createdAt: "2026-10-01T00:00:00.000Z", id: "a", mode: "shared" }),
      grant({ connectionId: "c1", createdAt: "2026-10-03T00:00:00.000Z", id: "b", mode: "shared" }),
      grant({ connectionId: "c2", id: "c", mode: "shared" }),
      grant({ connectionId: "c1", id: "personal", mode: "person_asking" }),
      grant({ connectionId: null, id: "loose", mode: "shared" }),
    ]);
    expect(byConnection.get("c1")?.map((row) => row.id)).toEqual(["b", "a"]);
    expect(byConnection.get("c2")?.map((row) => row.id)).toEqual(["c"]);
    expect([...byConnection.keys()].sort()).toEqual(["c1", "c2"]);
  });

  test("a shared grant needs a computer, a valid agent id and a conversation", () => {
    const ok = { agentId: " support ", conversations: ["dm" as const], installationId: "i1" };
    expect(sharedGrantDraftError(ok)).toBeNull();
    expect(sharedGrantDraftError({ ...ok, installationId: "" })?.field).toBe("installation");
    expect(sharedGrantDraftError({ ...ok, agentId: "  " })?.field).toBe("agent");
    expect(sharedGrantDraftError({ ...ok, agentId: "../main" })?.field).toBe("agent");
    expect(sharedGrantDraftError({ ...ok, agentId: "a b" })?.field).toBe("agent");
    expect(sharedGrantDraftError({ ...ok, agentId: "x".repeat(121) })?.field).toBe("agent");
    expect(sharedGrantDraftError({ ...ok, conversations: [] })?.field).toBe("conversations");
  });

  test("the manager by name from the members list, else the email the Worker sent", () => {
    const members = [{ email: "m@acme.test", id: "m", name: "Maria" }];
    expect(managerName({ managedBy: { email: "m@acme.test", userId: "m" } }, members)).toBe("Maria");
    expect(managerName({ managedBy: { email: "x@acme.test", userId: "x" } }, members)).toBe("x@acme.test");
    expect(managerName({ managedBy: { email: null, userId: "x" } })).toBe("A former member");
    expect(managerName({ managedBy: null })).toBeNull();
    expect(managerName({})).toBeNull();
  });

  test("a computer with whose it is", () => {
    expect(organizationInstallationLabel({ name: "ana-mbp", owner: { email: "ana@acme.test", name: "Ana", userId: "u" } })).toBe(
      "ana-mbp · Ana",
    );
    expect(organizationInstallationLabel({ name: "ci", owner: { email: "ci@acme.test", name: null, userId: "u" } })).toBe(
      "ci · ci@acme.test",
    );
  });

  test("adding an agent that shares another organization account says it moves it", () => {
    const shared = [
      grant({ agentId: "support", connectionId: "sales", email: "sales@acme.test", id: "g-sales", installationId: "olga", mode: "shared" }),
      grant({ agentId: "support", connectionId: "personal", id: "g-own", installationId: "olga", mode: "person_asking" }),
      grant({ agentId: "billing", connectionId: "help", email: "help@acme.test", id: "g-help", installationId: "olga", mode: "shared" }),
    ];
    const target = { agentId: " support ", connectionId: "help", installationId: "olga", provider: "google" };
    const move = sharedGrantConflict(shared, target);
    expect(move).toEqual({ grant: shared[0]!, kind: "move" });
    expect(sharedGrantConflictText(move!, { accountName: "help@acme.test", agentId: target.agentId, installationName: "olga-mbp" })).toBe(
      "support on olga-mbp uses sales@acme.test now. An agent uses one shared Google account at a time, so adding it here moves it: it stops using sales@acme.test.",
    );
    // The same agent on this account again only changes its conversations.
    const update = sharedGrantConflict(shared, { ...target, agentId: "billing" });
    expect(update).toEqual({ grant: shared[2]!, kind: "update" });
    expect(sharedGrantConflictText(update!, { accountName: "help@acme.test", agentId: "billing", installationName: null })).toBe(
      "billing already uses help@acme.test. Adding it again replaces its conversations with the ones you choose here.",
    );
    // Another computer, another agent, another provider or a personal grant: nothing moves.
    expect(sharedGrantConflict(shared, { ...target, installationId: "other" })).toBeNull();
    expect(sharedGrantConflict(shared, { ...target, agentId: "main" })).toBeNull();
    expect(sharedGrantConflict(shared, { ...target, provider: "slack" })).toBeNull();
    expect(sharedGrantConflict(shared, { ...target, agentId: "", installationId: "olga" })).toBeNull();
  });

  test("an account nobody manages sends its approvals to every owner and admin", () => {
    expect(noManagerText()).toContain("owners and admins");
    expect(noManagerText()).not.toContain("one person:");
  });

  test("an organization start carries its scope; a personal one doesn't", () => {
    expect(connectStartBody("google", { scopeKind: "organization" })).toEqual({
      accessMode: "full",
      provider: "google",
      scopeKind: "organization",
    });
    expect(connectStartBody("google")).not.toHaveProperty("scopeKind");
  });
});
