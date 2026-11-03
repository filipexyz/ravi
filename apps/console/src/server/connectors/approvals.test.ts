import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ConsoleAuthState } from "@/lib/auth/session";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import {
  decideApprovalFlow,
  getApprovalPageState,
  normalizeApprovalId,
  resolveApprovalAccess,
  type ApprovalDeps,
} from "./approvals";

const ORG = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "44444444-4444-4444-8444-444444444444";
const ME = "33333333-3333-4333-8333-333333333333";
const SOMEONE = "66666666-6666-4666-8666-666666666666";
const APPROVAL = "77777777-7777-4777-8777-777777777777";

const auth = { mode: "workos", viewer: { email: "me@example.test", mark: "M", name: "Me" } } as ConsoleAuthState;
const impersonated = {
  ...auth,
  initialAuth: { impersonator: { email: "support@example.test", reason: null } },
} as unknown as ConsoleAuthState;

function workspaceFor(organizationId: string, role = "developer") {
  return {
    membership: { role, status: "active" },
    mode: "workos",
    organization: { id: organizationId },
    user: { id: ME },
  } as unknown as ConsoleWorkspace;
}

function deps(overrides: Partial<ApprovalDeps> = {}): ApprovalDeps {
  return {
    currentUserId: async () => ME,
    featureDenial: async () => null,
    findOwner: async () => ({ id: APPROVAL, organizationId: ORG, ownerUserId: ME, unmanaged: false }),
    workspaceIn: async (_auth, organizationId) => workspaceFor(organizationId),
    ...overrides,
  };
}

describe("resolveApprovalAccess", () => {
  test("the owner, in the approval's organization (not the selected one)", async () => {
    const access = await resolveApprovalAccess(auth, APPROVAL.toUpperCase(), deps());
    expect(access).toMatchObject({ actor: { organizationId: ORG, userId: ME }, approvalId: APPROVAL, kind: "ok" });
  });

  test("someone else's approval, an unknown id and a malformed id are not found, without asking further", async () => {
    let workspaceLookups = 0;
    const counting = deps({
      workspaceIn: async (_auth, organizationId) => {
        workspaceLookups += 1;
        return workspaceFor(organizationId);
      },
    });
    expect(
      await resolveApprovalAccess(auth, APPROVAL, {
        ...counting,
        findOwner: async () => ({ id: APPROVAL, organizationId: ORG, ownerUserId: SOMEONE, unmanaged: false }),
      }),
    ).toEqual({ kind: "not_found" });
    expect(await resolveApprovalAccess(auth, APPROVAL, { ...counting, findOwner: async () => null })).toEqual({ kind: "not_found" });
    expect(await resolveApprovalAccess(auth, "not-a-uuid", counting)).toEqual({ kind: "not_found" });
    expect(workspaceLookups).toBe(0);
  });

  test("on an organization account nobody manages, any owner or admin decides; a member learns nothing", async () => {
    const unmanaged = async () => ({ id: APPROVAL, organizationId: ORG, ownerUserId: SOMEONE, unmanaged: true });
    for (const role of ["owner", "admin"]) {
      const access = await resolveApprovalAccess(
        auth,
        APPROVAL,
        deps({ findOwner: unmanaged, workspaceIn: async (_auth, organizationId) => workspaceFor(organizationId, role) }),
      );
      expect(access).toMatchObject({ actor: { organizationId: ORG, userId: ME }, approvalId: APPROVAL, kind: "ok" });
    }
    expect(await resolveApprovalAccess(auth, APPROVAL, deps({ findOwner: unmanaged }))).toEqual({ kind: "not_found" });
    expect(await resolveApprovalAccess(auth, APPROVAL, deps({ findOwner: unmanaged, workspaceIn: async () => null }))).toEqual({
      kind: "not_found",
    });
    // A managed account's approval stays its manager's, even for an admin.
    expect(
      await resolveApprovalAccess(
        auth,
        APPROVAL,
        deps({
          findOwner: async () => ({ id: APPROVAL, organizationId: ORG, ownerUserId: SOMEONE, unmanaged: false }),
          workspaceIn: async (_auth, organizationId) => workspaceFor(organizationId, "admin"),
        }),
      ),
    ).toEqual({ kind: "not_found" });
  });

  test("an impersonation session is refused before any lookup", async () => {
    let looked = false;
    const access = await resolveApprovalAccess(
      impersonated,
      APPROVAL,
      deps({
        findOwner: async () => {
          looked = true;
          return null;
        },
      }),
    );
    expect(access).toEqual({ kind: "denied", reason: "impersonation" });
    expect(looked).toBe(false);
  });

  test("no longer a member of the approval's organization, or no connectors there", async () => {
    expect(await resolveApprovalAccess(auth, APPROVAL, deps({ workspaceIn: async () => null }))).toEqual({
      kind: "denied",
      reason: "not_member",
    });
    expect(await resolveApprovalAccess(auth, APPROVAL, deps({ featureDenial: async () => "feature_forbidden" }))).toEqual({
      kind: "denied",
      reason: "feature_forbidden",
    });
  });

  test("normalizeApprovalId accepts only a uuid", () => {
    expect(normalizeApprovalId(` ${APPROVAL} `)).toBe(APPROVAL);
    expect(normalizeApprovalId("../x")).toBeNull();
    expect(normalizeApprovalId(undefined)).toBeNull();
  });
});

describe("approval page and decision", () => {
  const env = process.env;
  const originalFetch = globalThis.fetch;
  let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeEach(() => {
    calls = [];
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID = "test-key";
    env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT = "test-secret-value";
    env.RAVI_CONNECTORS_LINK_URL = "https://link.example.test";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        path: String(input).replace("https://link.example.test", ""),
      });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID;
    delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT;
    delete env.RAVI_CONNECTORS_LINK_URL;
  });

  test("the page asks the Worker in the approval's organization", async () => {
    reply = { status: 200, body: { capability: "gmail.message.send", id: APPROVAL, status: "pending" } };
    const state = await getApprovalPageState(auth, APPROVAL, deps());
    expect(state).toMatchObject({ approval: { id: APPROVAL, status: "pending" }, state: "ready" });
    expect(calls).toEqual([{ body: { organizationId: ORG, userId: ME }, path: `/ui/approvals/get/${APPROVAL}` }]);
    // Same answer whatever organization the person has selected.
    await getApprovalPageState(
      auth,
      APPROVAL,
      deps({ findOwner: async () => ({ id: APPROVAL, organizationId: OTHER_ORG, ownerUserId: ME, unmanaged: false }) }),
    );
    expect(calls[1]?.body).toEqual({ organizationId: OTHER_ORG, userId: ME });
  });

  test("a Worker 404 is not found; a Worker outage or a refused signature is unavailable", async () => {
    reply = { status: 404, body: { error: "not_found" } };
    expect(await getApprovalPageState(auth, APPROVAL, deps())).toEqual({ state: "not_found" });
    reply = { status: 500, body: { error: "internal_error" } };
    expect(await getApprovalPageState(auth, APPROVAL, deps())).toEqual({ code: "connector_service_unavailable", state: "unavailable" });
    reply = { status: 401, body: { error: "connector_unauthorized" } };
    expect(await getApprovalPageState(auth, APPROVAL, deps())).toEqual({ code: "connector_service_unavailable", state: "unavailable" });
  });

  test("the page shows nothing of someone else's approval and asks the Worker nothing", async () => {
    const state = await getApprovalPageState(
      auth,
      APPROVAL,
      deps({ findOwner: async () => ({ id: APPROVAL, organizationId: ORG, ownerUserId: SOMEONE, unmanaged: false }) }),
    );
    expect(state).toEqual({ state: "not_found" });
    expect(calls).toHaveLength(0);
  });

  test("an admin opens and decides an approval on an account nobody manages; a member never reaches the Worker", async () => {
    const unmanaged = async () => ({ id: APPROVAL, organizationId: ORG, ownerUserId: SOMEONE, unmanaged: true });
    const asAdmin = deps({ findOwner: unmanaged, workspaceIn: async (_auth, organizationId) => workspaceFor(organizationId, "admin") });
    reply = { status: 200, body: { capability: "gmail.message.send", id: APPROVAL, status: "pending" } };
    expect(await getApprovalPageState(auth, APPROVAL, asAdmin)).toMatchObject({ state: "ready" });
    reply = { status: 200, body: { status: "approved" } };
    expect(await decideApprovalFlow(auth, APPROVAL, "approve", asAdmin)).toEqual({ status: "approved" });
    expect(calls).toEqual([
      { body: { organizationId: ORG, userId: ME }, path: `/ui/approvals/get/${APPROVAL}` },
      { body: { decision: "approve", organizationId: ORG, userId: ME }, path: `/ui/approvals/decide/${APPROVAL}` },
    ]);

    // The Worker keeps the final say: its refusal is not found.
    reply = { status: 404, body: { error: "not_found" } };
    expect(await getApprovalPageState(auth, APPROVAL, asAdmin)).toEqual({ state: "not_found" });

    const asMember = deps({ findOwner: unmanaged });
    expect(await getApprovalPageState(auth, APPROVAL, asMember)).toEqual({ state: "not_found" });
    const refused = await decideApprovalFlow(auth, APPROVAL, "approve", asMember).catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ code: "not_found", status: 404 });
    expect(calls).toHaveLength(3);
  });

  test("deciding forwards the decision; a refusal never reaches the Worker", async () => {
    reply = { status: 200, body: { status: "approved" } };
    expect(await decideApprovalFlow(auth, APPROVAL, "approve", deps())).toEqual({ status: "approved" });
    expect(calls).toEqual([
      { body: { decision: "approve", organizationId: ORG, userId: ME }, path: `/ui/approvals/decide/${APPROVAL}` },
    ]);

    const refused = await decideApprovalFlow(impersonated, APPROVAL, "approve", deps()).catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ code: "impersonation", status: 403 });
    const missing = await decideApprovalFlow(auth, APPROVAL, "deny", deps({ findOwner: async () => null })).catch(
      (caught: unknown) => caught,
    );
    expect(missing).toMatchObject({ code: "not_found", status: 404 });
    expect(calls).toHaveLength(1);
  });
});
