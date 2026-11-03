import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import type { BaseProperty, BasePropertyConfig, BasePropertyType } from "@/shared/bases/types";

import {
  agentFilledValue,
  agentInputsHash,
  applyAgentRequests,
  approvalsToReset,
  approvalTransitions,
  canDecideApproval,
  resolveApprovalWrite,
} from "./workflow";

const ANA = "8e0e034f-6cce-4f10-82da-3ebf2c8b49f4";
const BIA = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const NOW = new Date("2026-10-06T12:00:00.000Z");

let nextId = 0;
function prop(key: string, type: BasePropertyType, config: BasePropertyConfig = {}): BaseProperty {
  nextId += 1;
  return {
    id: `bbbbbbbb-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    key,
    name: key,
    description: null,
    type,
    config,
    position: nextId,
    required: false,
    deletedAt: null,
  };
}

const amount = prop("amount", "number");
const title = prop("title", "text");
const byRole = prop("review", "approval", { approvers: [{ kind: "project_role", minRole: "project_admin" }], resetOn: [amount.id] });
const byUser = prop("signoff", "approval", { approvers: [{ kind: "user", userId: ANA }] });
const summary = prop("summary", "agent", { instructions: "Resuma", inputs: [title.id, amount.id], output: "text" });

const human = (id: string, actorType: "user" | "cli" | "system" | "anonymous" = "user") => ({ user: { id, email: `${id}@x.test` }, actorType });
const access = (projectRole: "viewer" | "developer" | "project_admin" | null, activeOrgMember = true) => ({ projectRole, activeOrgMember, userId: null });

function apiError(fn: () => unknown): ConsoleApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConsoleApiError) return error;
    throw error;
  }
  throw new Error("expected a ConsoleApiError");
}

describe("approval deciders", () => {
  test("a project_role principal matches the effective role or above", () => {
    expect(canDecideApproval(byRole, human(BIA), access("project_admin"))).toBe(true);
    expect(canDecideApproval(byRole, human(BIA), access("developer"))).toBe(false);
    expect(canDecideApproval(byRole, human(BIA), access(null))).toBe(false);
  });

  test("a user principal matches only that user, case-insensitively", () => {
    expect(canDecideApproval(byUser, human(ANA.toUpperCase()), access("viewer"))).toBe(true);
    expect(canDecideApproval(byUser, human(BIA), access("project_admin"))).toBe(false);
  });

  test("system, anonymous, non-members, and other property types never decide", () => {
    expect(canDecideApproval(byUser, human(ANA, "system"), access("project_admin"))).toBe(false);
    expect(canDecideApproval(byUser, human(ANA, "anonymous"), access("project_admin"))).toBe(false);
    expect(canDecideApproval(byUser, { user: null, actorType: "user" }, access("project_admin"))).toBe(false);
    expect(canDecideApproval(byUser, human(ANA), access("project_admin", false))).toBe(false);
    expect(canDecideApproval(amount, human(ANA), access("project_admin"))).toBe(false);
    expect(canDecideApproval(byUser, human(ANA, "cli"), access("viewer"))).toBe(true);
  });
});

describe("approval writes", () => {
  test("pending sets who asked and clears the decision; any writer may ask", () => {
    const value = resolveApprovalWrite({
      property: byRole,
      intent: { state: "pending", note: null },
      stored: { state: "approved", requestedBy: ANA, requestedAt: "x", decidedBy: ANA, decidedAt: "y", note: "ok" },
      caller: human(BIA),
      access: access("viewer"),
      now: NOW,
    });
    expect(value).toEqual({ state: "pending", requestedBy: BIA, requestedAt: NOW.toISOString(), decidedBy: null, decidedAt: null, note: null });
  });

  test("a decision by an approver keeps the request and records who decided", () => {
    const value = resolveApprovalWrite({
      property: byRole,
      intent: { state: "rejected", note: "caro" },
      stored: { state: "pending", requestedBy: BIA, requestedAt: "2026-10-01T00:00:00.000Z", decidedBy: null, decidedAt: null, note: null },
      caller: human(ANA),
      access: access("project_admin"),
      now: NOW,
    });
    expect(value).toEqual({
      state: "rejected",
      requestedBy: BIA,
      requestedAt: "2026-10-01T00:00:00.000Z",
      decidedBy: ANA,
      decidedAt: NOW.toISOString(),
      note: "caro",
    });
  });

  test("a decision by a non-approver is 403 approval_forbidden", () => {
    const error = apiError(() =>
      resolveApprovalWrite({ property: byRole, intent: { state: "approved", note: null }, stored: undefined, caller: human(BIA), access: access("developer"), now: NOW }),
    );
    expect(error.status).toBe(403);
    expect(error.payload.error).toBe("approval_forbidden");
  });

  test("resetOn sends decided approvals back when a listed property changed, unless the write set the approval", () => {
    const decided = { [byRole.id]: { state: "approved" } };
    expect(approvalsToReset([byRole, byUser], decided, new Set([amount.id]), new Set()).map((p) => p.key)).toEqual(["review"]);
    expect(approvalsToReset([byRole], decided, new Set([title.id]), new Set())).toEqual([]);
    expect(approvalsToReset([byRole], decided, new Set([amount.id]), new Set([byRole.id]))).toEqual([]);
    expect(approvalsToReset([byRole], { [byRole.id]: { state: "pending" } }, new Set([amount.id]), new Set())).toEqual([]);
  });

  test("transitions report states entered, not states kept", () => {
    expect(approvalTransitions([byRole, byUser], {}, { [byRole.id]: { state: "pending" } })).toEqual([{ propertyId: byRole.id, state: "pending" }]);
    expect(approvalTransitions([byRole], { [byRole.id]: { state: "pending" } }, { [byRole.id]: { state: "pending" } })).toEqual([]);
    expect(approvalTransitions([byRole], { [byRole.id]: { state: "pending" } }, { [byRole.id]: { state: "approved" } })).toEqual([
      { propertyId: byRole.id, state: "approved" },
    ]);
  });
});

describe("agent inputs", () => {
  test("inputsHash is 16 hex over the input values in order, independent of key order inside values", () => {
    const a = agentInputsHash(summary, { [title.id]: "Acme", [amount.id]: 10 });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(agentInputsHash(summary, { [amount.id]: 10, [title.id]: "Acme", other: 1 })).toBe(a);
    expect(agentInputsHash(summary, { [title.id]: "Acme", [amount.id]: 11 })).not.toBe(a);
    expect(agentInputsHash(summary, {})).toBe(agentInputsHash(summary, { [title.id]: null }));
    const swapped = prop("swapped", "agent", { instructions: "x", inputs: [amount.id, title.id], output: "text" });
    expect(agentInputsHash(swapped, { [title.id]: "Acme", [amount.id]: 10 })).not.toBe(a);
  });

  test("create requests every agent column; update only when the hash changed", () => {
    const created: Record<string, unknown> = { [title.id]: "Acme" };
    const requests = applyAgentRequests({ properties: [title, summary], before: null, next: created, now: NOW });
    expect(requests).toEqual([{ propertyId: summary.id, inputsHash: agentInputsHash(summary, created) }]);
    expect(created[summary.id]).toMatchObject({ state: "pending", value: null, error: null });

    const done = agentFilledValue(created[summary.id], requests[0]!.inputsHash, { value: "Resumo" }, NOW);
    const unchanged: Record<string, unknown> = { ...created, [summary.id]: done };
    expect(applyAgentRequests({ properties: [summary], before: created, next: unchanged, now: NOW })).toEqual([]);
    expect(unchanged[summary.id]).toBe(done);

    const changed: Record<string, unknown> = { ...unchanged, [amount.id]: 5 };
    expect(applyAgentRequests({ properties: [summary], before: unchanged, next: changed, now: NOW })).toHaveLength(1);
    // The previous value stays visible while the agent works.
    expect(changed[summary.id]).toMatchObject({ state: "pending", value: "Resumo" });
  });

  test("an error fill keeps the previous value", () => {
    const filled = agentFilledValue({ state: "pending", value: "antes" }, "0123456789abcdef", { error: "timeout" }, NOW);
    expect(filled).toEqual({ state: "error", value: "antes", error: "timeout", inputsHash: "0123456789abcdef", updatedAt: NOW.toISOString() });
  });
});
