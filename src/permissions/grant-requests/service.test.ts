import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVAL_TEST_FAMILY_PHONE,
  APPROVAL_TEST_LEAD_PHONE,
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_STRANGER_PHONE,
  APPROVAL_TEST_SUPERADMIN_PHONE,
  seedApprovalContact,
} from "../../approval/test-support.js";
import {
  actorCanGrantRequestedPermission,
  registerGrantorIdentityResolver,
  unregisterGrantorIdentityResolver,
} from "../../approval/grantor.js";
import { dbCreateAgent, dbUpsertChat } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { setPermissionAuditPublisherForTest } from "../denials.js";
import { dbGetContactChatGrant, dbListContactChatGrants } from "../contact-chat-grants.js";
import {
  ensureAgentRuntimeCapability,
  readAgentRuntimePermissionsConfig,
} from "../agent-default-capabilities-provider.js";
import { claimGrantRequest, findOpenGrantRequest, getGrantRequest, listGrantRequestDeliveries } from "./store.js";
import {
  GRANT_REQUEST_TTL_MS,
  GrantRequestError,
  contactHoldsAdmin,
  decideGrantRequest,
  previewGrantRequest,
  requestGrant,
  sweepExpiredGrantRequests,
  type GrantRequestServiceDependencies,
} from "./service.js";
import type { GrantApprovalChannelAdapter, GrantRequestPlan, ReachableContact } from "./types.js";

let stateDir: string | null = null;
let nowMs = 1_000_000;

/** A channel the core has never heard of: it only knows adapters and verified senders. */
function fakeAdapter(
  channel: string,
  reachable: ReachableContact[],
  options: { failDelivery?: boolean } = {},
): GrantApprovalChannelAdapter & { delivered: Array<{ contactId: string; requestId: string }> } {
  const delivered: Array<{ contactId: string; requestId: string }> = [];
  return {
    channel,
    delivered,
    listReachableContacts: () => reachable,
    deliver: async ({ request, contactId }) => {
      if (options.failDelivery) throw new Error("channel is down");
      delivered.push({ contactId, requestId: request.id });
      return { ref: { messageId: `${channel}-${delivered.length}` } };
    },
  };
}

type DecideInput = Omit<Parameters<typeof decideGrantRequest>[0], "deliveredTo"> & { deliveredTo?: string };
let contactByPhone = new Map<string, string>();

/** Decide as the adapter would: the prompt answered was delivered to the contact that owns the sender's phone. */
function decide(input: DecideInput, dependencies?: GrantRequestServiceDependencies) {
  const deliveredTo = input.deliveredTo ?? contactByPhone.get(input.actor.senderId) ?? "";
  return decideGrantRequest({ ...input, deliveredTo }, dependencies);
}

function deps(adapters: GrantApprovalChannelAdapter[]): GrantRequestServiceDependencies {
  return { now: () => nowMs, adapters: () => adapters, ttlMs: GRANT_REQUEST_TTL_MS };
}

describe("grant requests (core, no channel)", () => {
  let admin: ReturnType<typeof seedApprovalContact>;
  let secondAdmin: ReturnType<typeof seedApprovalContact>;
  let grantee: ReturnType<typeof seedApprovalContact>;
  let bystander: ReturnType<typeof seedApprovalContact>;
  let plan: GrantRequestPlan;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-grant-requests-");
    setPermissionAuditPublisherForTest(async () => {});
    nowMs = 1_000_000;
    admin = seedApprovalContact({ phone: APPROVAL_TEST_SLACK_OWNER_PHONE, name: "Admin", tags: ["permission.admin"] });
    secondAdmin = seedApprovalContact({
      phone: APPROVAL_TEST_SUPERADMIN_PHONE,
      name: "Second admin",
      tags: ["permission.admin"],
    });
    grantee = seedApprovalContact({ phone: APPROVAL_TEST_STRANGER_PHONE, name: "Breno", tags: ["lead"] });
    bystander = seedApprovalContact({ phone: APPROVAL_TEST_LEAD_PHONE, name: "Bystander", tags: ["lead"] });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "120363000000000001@g.us",
      chatType: "group",
      title: "Customer group",
    });
    try {
      dbCreateAgent({ id: "xone", cwd: "/tmp/xone" });
    } catch {
      // Already there in this isolated state.
    }
    contactByPhone = new Map([
      [APPROVAL_TEST_SLACK_OWNER_PHONE, admin.id],
      [APPROVAL_TEST_SUPERADMIN_PHONE, secondAdmin.id],
      [APPROVAL_TEST_STRANGER_PHONE, grantee.id],
      [APPROVAL_TEST_LEAD_PHONE, bystander.id],
    ]);
    plan = {
      profile: "full-access",
      contactId: grantee.id,
      chatId: chat.id,
      executorAgentId: "xone",
      contactLabel: "Breno",
      chatLabel: "Customer group",
    };
  });

  afterEach(async () => {
    setPermissionAuditPublisherForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const requester = { agentId: "main", sessionName: "main", channel: "whatsapp" };
  const sender = (phone: string, channel = "whatsapp") => ({ channel, senderId: phone });

  describe("asking", () => {
    it("offers the request to every admin on every channel that reaches them, and to nobody else", async () => {
      const chatA = fakeAdapter("chan-a", [
        { contactId: admin.id, address: {} },
        { contactId: bystander.id, address: {} },
        { contactId: grantee.id, address: {} },
      ]);
      const chatB = fakeAdapter("chan-b", [{ contactId: secondAdmin.id, address: {} }]);

      const result = await requestGrant({ plan, requester }, deps([chatA, chatB]));

      expect(result.reused).toBe(false);
      expect(chatA.delivered.map((entry) => entry.contactId)).toEqual([admin.id]);
      expect(chatB.delivered.map((entry) => entry.contactId)).toEqual([secondAdmin.id]);
      expect(result.request.grantorContactIds).toEqual([admin.id, secondAdmin.id]);
      expect(result.request.expiresAt - result.request.createdAt).toBe(GRANT_REQUEST_TTL_MS);
      expect(listGrantRequestDeliveries(result.request.id).map((entry) => entry.channel)).toEqual(["chan-a", "chan-b"]);
    });

    it("does not care which channel the turn came from", async () => {
      for (const channel of ["slack", "whatsapp", "terminal", undefined]) {
        const adapter = fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }]);
        const fresh = { ...plan, chatId: `${plan.chatId}-${channel ?? "none"}` };
        const result = await requestGrant(
          { plan: fresh, requester: { agentId: "main", ...(channel ? { channel } : {}) } },
          deps([adapter]),
        );
        expect(result.deliveries).toHaveLength(1);
        expect(adapter.delivered).toHaveLength(1);
      }
    });

    it("reuses an identical open request instead of asking again", async () => {
      const adapter = fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }]);
      const first = await requestGrant({ plan, requester }, deps([adapter]));
      const second = await requestGrant({ plan, requester }, deps([adapter]));

      expect(second.reused).toBe(true);
      expect(second.request.id).toBe(first.request.id);
      expect(adapter.delivered).toHaveLength(1);
    });

    it("fails closed with a clear error and nothing pending when nobody can be asked", async () => {
      await expect(requestGrant({ plan, requester }, deps([]))).rejects.toMatchObject({ code: "no_adapter" });

      const onlyBystanders = fakeAdapter("chan-a", [
        { contactId: bystander.id, address: {} },
        { contactId: grantee.id, address: {} },
      ]);
      await expect(requestGrant({ plan, requester }, deps([onlyBystanders]))).rejects.toMatchObject({
        code: "no_eligible_grantor",
      });

      const down = fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }], { failDelivery: true });
      const error = await requestGrant({ plan, requester }, deps([down])).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GrantRequestError);
      expect(error).toMatchObject({ code: "undeliverable" });
      // The request that could not be delivered is not left waiting for an answer.
      expect(findOpenGrantRequest(plan, nowMs)).toBeNull();
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("previews the approvers without asking anyone", () => {
      const adapter = fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }]);
      expect(previewGrantRequest(plan, deps([adapter])).grantors).toEqual([{ contactId: admin.id, channel: "chan-a" }]);
      expect(adapter.delivered).toEqual([]);
    });
  });

  describe("deciding", () => {
    async function openRequest(adapters = [fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }])]) {
      const result = await requestGrant({ plan, requester }, deps(adapters));
      return result.request;
    }

    it("applies the grant for the target chat only, and writes no agent permission, when an admin approves", async () => {
      const request = await openRequest();

      const result = decide(
        { requestId: request.id, decision: "approve", actor: sender(APPROVAL_TEST_SLACK_OWNER_PHONE) },
        deps([]),
      );

      expect(result.kind).toBe("decided");
      const decided = getGrantRequest(request.id);
      expect(decided).toMatchObject({
        status: "approved",
        outcome: "applied",
        decidedByContactId: admin.id,
        decidedVia: "whatsapp",
      });
      expect(
        dbGetContactChatGrant({
          contactId: grantee.id,
          profileSlug: "permission-admin",
          scopeType: "chat",
          scopeId: plan.chatId,
        }),
      ).not.toBeNull();
      expect(dbListContactChatGrants({ contactId: grantee.id })).toHaveLength(1);
      expect(readAgentRuntimePermissionsConfig("xone")?.capabilities ?? []).toEqual([]);
    });

    it("decides the same way from any channel: asked on one, answered on another", async () => {
      const slackLike = fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }]);
      const whatsappLike = fakeAdapter("chan-b", [{ contactId: secondAdmin.id, address: {} }]);
      const request = await openRequest([slackLike, whatsappLike]);

      const result = decide(
        { requestId: request.id, decision: "approve", actor: sender(APPROVAL_TEST_SUPERADMIN_PHONE, "chan-b") },
        deps([]),
      );

      expect(result.kind).toBe("decided");
      expect(getGrantRequest(request.id)).toMatchObject({ decidedByContactId: secondAdmin.id, decidedVia: "chan-b" });
    });

    it("rejects without granting anything", async () => {
      const request = await openRequest();

      decide({ requestId: request.id, decision: "reject", actor: sender(APPROVAL_TEST_SLACK_OWNER_PHONE) }, deps([]));

      expect(getGrantRequest(request.id)).toMatchObject({ status: "rejected", outcome: null });
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("ignores an answer from someone who is not an admin, or whose sender is unknown", async () => {
      const request = await openRequest();

      const bystanderAnswer = decide(
        { requestId: request.id, decision: "approve", actor: sender(APPROVAL_TEST_LEAD_PHONE) },
        deps([]),
      );
      const stranger = decide({ requestId: request.id, decision: "approve", actor: sender("5511000000000") }, deps([]));
      const nobody = decide(
        { requestId: request.id, decision: "approve", actor: { channel: "whatsapp", senderId: "" } },
        deps([]),
      );

      expect(bystanderAnswer).toMatchObject({ kind: "refused", reason: "not_grantor" });
      expect(stranger).toMatchObject({ kind: "refused", reason: "unknown_actor" });
      expect(nobody).toMatchObject({ kind: "refused", reason: "unknown_actor" });
      expect(getGrantRequest(request.id)?.status).toBe("pending");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("takes identity from the verified sender, never from what the message says", async () => {
      const request = await openRequest();
      // The decision input has no text field at all: a message saying "sou o Luís" from
      // another number is just that other number's verified sender.
      const impostor = decide(
        { requestId: request.id, decision: "approve", actor: sender(APPROVAL_TEST_FAMILY_PHONE) },
        deps([]),
      );

      expect(impostor.kind).toBe("refused");
      expect(getGrantRequest(request.id)?.status).toBe("pending");
    });

    it("never lets the grantee decide their own access, even if they are an admin", async () => {
      const adminGrantee = { ...plan, contactId: secondAdmin.id, chatId: `${plan.chatId}-self` };
      const request = (
        await requestGrant(
          { plan: adminGrantee, requester },
          deps([fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }])]),
        )
      ).request;

      const self = decide(
        { requestId: request.id, decision: "approve", actor: sender(APPROVAL_TEST_SUPERADMIN_PHONE) },
        deps([]),
      );

      expect(self).toMatchObject({ kind: "refused", reason: "grantee_cannot_decide" });
      expect(getGrantRequest(request.id)?.status).toBe("pending");
    });

    it("never lets an agent decide, even one that holds admin: only a human contact approves", async () => {
      const request = await openRequest();
      // A channel whose verified sender resolves to an agent that holds admin.
      // Its id collides with an offered admin's contact id, so only the subject-type check can stop it.
      dbCreateAgent({ id: admin.id, cwd: "/tmp/colliding-agent" });
      ensureAgentRuntimeCapability(admin.id, { permission: "admin", objectType: "system", objectId: "*" });
      registerGrantorIdentityResolver("agent-chan", () => ({ ownerType: "agent", ownerId: admin.id }));
      try {
        const actor = { channel: "agent-chan", senderId: "bot-1" };
        // Premise: the capability gate alone would let this agent through.
        expect(
          actorCanGrantRequestedPermission({ ...actor, permission: "admin", objectType: "system", objectId: "*" }),
        ).toMatchObject({
          allowed: true,
          subjectType: "agent",
        });

        const result = decide({ requestId: request.id, decision: "approve", actor, deliveredTo: admin.id }, deps([]));

        expect(result).toMatchObject({ kind: "refused", reason: "not_grantor" });
        expect(getGrantRequest(request.id)?.status).toBe("pending");
        expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
      } finally {
        unregisterGrantorIdentityResolver("agent-chan");
      }
    });

    it("only accepts an answer through the prompt that was delivered to that same person", async () => {
      const request = await openRequest([
        fakeAdapter("chan-a", [
          { contactId: admin.id, address: {} },
          { contactId: secondAdmin.id, address: {} },
        ]),
      ]);

      // Second admin answers through the prompt that was sent to the first one.
      const crossed = decide(
        {
          requestId: request.id,
          decision: "approve",
          deliveredTo: admin.id,
          actor: sender(APPROVAL_TEST_SUPERADMIN_PHONE, "chan-a"),
        },
        deps([]),
      );
      expect(crossed).toMatchObject({ kind: "refused", reason: "not_grantor" });
      expect(getGrantRequest(request.id)?.status).toBe("pending");

      const own = decide(
        {
          requestId: request.id,
          decision: "approve",
          deliveredTo: secondAdmin.id,
          actor: sender(APPROVAL_TEST_SUPERADMIN_PHONE, "chan-a"),
        },
        deps([]),
      );
      expect(own.kind).toBe("decided");
    });

    it("only accepts answers from people the request was offered to", async () => {
      const request = await openRequest();
      // An admin who was not reachable when the request was made is not one of its approvers.
      const lateAdmin = decide(
        { requestId: request.id, decision: "approve", actor: sender(APPROVAL_TEST_SUPERADMIN_PHONE) },
        deps([]),
      );

      expect(lateAdmin).toMatchObject({ kind: "refused", reason: "not_grantor" });
    });

    it("tells a stranger nothing about an expired or decided request", async () => {
      const request = await openRequest();
      nowMs += GRANT_REQUEST_TTL_MS + 1;
      const stranger = decide({ requestId: request.id, decision: "approve", actor: sender("5511000000000") }, deps([]));
      expect(stranger).toMatchObject({ kind: "refused", reason: "unknown_actor" });
      expect(getGrantRequest(request.id)?.status).toBe("pending");
    });

    it("cannot be decided twice, nor after it expired", async () => {
      const request = await openRequest();
      const actor = sender(APPROVAL_TEST_SLACK_OWNER_PHONE);
      expect(decide({ requestId: request.id, decision: "approve", actor }, deps([])).kind).toBe("decided");

      expect(decide({ requestId: request.id, decision: "approve", actor }, deps([]))).toMatchObject({
        kind: "refused",
        reason: "already_decided",
      });
      expect(decide({ requestId: request.id, decision: "reject", actor }, deps([]))).toMatchObject({
        kind: "refused",
        reason: "already_decided",
      });
      expect(dbListContactChatGrants({ contactId: grantee.id })).toHaveLength(1);
    });

    it("expires after the window: late answers grant nothing and the sweep flips the state", async () => {
      const request = await openRequest();
      nowMs += GRANT_REQUEST_TTL_MS + 1;

      const late = decide(
        { requestId: request.id, decision: "approve", actor: sender(APPROVAL_TEST_SLACK_OWNER_PHONE) },
        deps([]),
      );

      expect(late).toMatchObject({ kind: "refused", reason: "expired" });
      expect(getGrantRequest(request.id)?.status).toBe("expired");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);

      const another = await requestGrant(
        { plan: { ...plan, chatId: `${plan.chatId}-2` }, requester },
        deps([fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }])]),
      );
      nowMs += GRANT_REQUEST_TTL_MS + 1;
      expect(sweepExpiredGrantRequests(deps([])).map((entry) => entry.id)).toEqual([another.request.id]);
      expect(getGrantRequest(another.request.id)?.status).toBe("expired");
    });

    it("lets exactly one caller claim a request, even when both read it as pending", async () => {
      const request = await openRequest();
      const claim = (status: "approved" | "rejected") =>
        claimGrantRequest({
          id: request.id,
          status,
          decidedByContactId: admin.id,
          decidedVia: "test",
          now: nowMs,
        });

      // Two answers that both passed the read check race on the write: only one wins.
      expect(claim("approved")).not.toBeNull();
      expect(claim("rejected")).toBeNull();
      expect(getGrantRequest(request.id)?.status).toBe("approved");

      const late = await requestGrant(
        { plan: { ...plan, chatId: `${plan.chatId}-late` }, requester },
        deps([fakeAdapter("chan-a", [{ contactId: admin.id, address: {} }])]),
      );
      expect(
        claimGrantRequest({
          id: late.request.id,
          status: "approved",
          decidedByContactId: admin.id,
          decidedVia: "test",
          now: late.request.expiresAt,
        }),
      ).toBeNull();
    });

    it("knows an unknown request", () => {
      expect(
        decide(
          { requestId: "pgr_missing", decision: "approve", actor: sender(APPROVAL_TEST_SLACK_OWNER_PHONE) },
          deps([]),
        ),
      ).toMatchObject({ kind: "refused", reason: "not_found" });
    });
  });

  describe("gate", () => {
    it("is the capability gate: admin passes, an ordinary contact does not", () => {
      expect(contactHoldsAdmin(admin.id)).toBe(true);
      expect(contactHoldsAdmin(bystander.id)).toBe(false);
    });
  });

  describe("architecture", () => {
    it("keeps channel rules out of the core", () => {
      const dir = new URL(".", import.meta.url).pathname;
      const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
      expect(files.length).toBeGreaterThan(3);
      for (const file of files) {
        const source = readFileSync(join(dir, file), "utf8");
        expect(moduleSpecifiers(source).filter((specifier) => CHANNEL_SPECIFIER.test(specifier))).toEqual([]);
        // No channel name as a literal either: channels reach the core only through adapters.
        expect(source).not.toMatch(/["'`](slack|whatsapp|telegram|discord)["'`]/i);
      }
    });

    it("finds module specifiers however the import is written", () => {
      const multiline = 'import {\n  a,\n  b,\n} from "../../channels/slack/instance-alias.js";';
      expect(moduleSpecifiers(multiline)).toEqual(["../../channels/slack/instance-alias.js"]);
      expect(moduleSpecifiers('const m = await import("../channels/whatsapp/x.js");')).toEqual([
        "../channels/whatsapp/x.js",
      ]);
      expect(moduleSpecifiers('export * from "./a.js"; import "./side.js";')).toEqual(["./a.js", "./side.js"]);
    });
  });
});

const CHANNEL_SPECIFIER = /channels\/|slack|whatsapp|telegram|discord/i;

/** Every module path a file pulls in: static `from`, bare side-effect imports, dynamic `import(`. */
function moduleSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1] ?? "");
  }
  return found;
}
