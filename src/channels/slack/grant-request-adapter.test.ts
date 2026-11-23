import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { answerSlackApprovalClick } from "../../approval/slack-click-feedback.js";
import { setApprovalGrantorRouterConfigForTest } from "./grantors.js";
import {
  SLACK_PERMISSION_GRANT_ACTION_EXACT,
  SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
  SLACK_PERMISSION_GRANT_ACTION_IGNORE,
  SLACK_PERMISSION_GRANT_ACTION_SCOPE,
} from "../../approval/slack-blocks.js";
import {
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_SLACK_STRANGER_USER,
  APPROVAL_TEST_STRANGER_PHONE,
  seedApprovalContact,
} from "../../approval/test-support.js";
import { dbGetContactChatGrant, dbListContactChatGrants } from "../../permissions/contact-chat-grants.js";
import { setPermissionAuditPublisherForTest } from "../../permissions/denials.js";
import { getGrantRequest } from "../../permissions/grant-requests/store.js";
import {
  GRANT_REQUEST_TTL_MS,
  requestGrant,
  resetGrantApprovalAdaptersForTest,
  type GrantRequestServiceDependencies,
} from "../../permissions/grant-requests/service.js";
import { dbCreateAgent, dbUpsertChat, dbUpsertInstance, getDb } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  GRANT_REQUEST_ID_PREFIX,
  createSlackGrantApprovalAdapter,
  handleSlackGrantRequestInteraction,
  type SlackGrantRequestDependencies,
} from "./grant-request-adapter.js";

let stateDir: string | null = null;
let nowMs = 5_000_000;
let sentRequests: Array<{ topic: string; data: Record<string, unknown> }> = [];
let responses: Array<{ responseUrlId: string; payload: Record<string, unknown> }> = [];

let slackDeps: SlackGrantRequestDependencies;
const baseSlackDeps: Omit<SlackGrantRequestDependencies, "service"> = {
  requestReply: (async (topic: string, data: Record<string, unknown>) => {
    sentRequests.push({ topic, data });
    return { messageId: "dm_1", deliveries: [{ userId: data.to, kind: "dm", chatId: "D999", messageId: "dm_1" }] };
  }) as SlackGrantRequestDependencies["requestReply"],
  respond: async (input) => {
    responses.push(input);
  },
};

describe("slack grant request adapter", () => {
  let admin: ReturnType<typeof seedApprovalContact>;
  let grantee: ReturnType<typeof seedApprovalContact>;
  let chatId: string;
  const serviceDeps = (): GrantRequestServiceDependencies => ({
    now: () => nowMs,
    adapters: () => [adapter],
    ttlMs: GRANT_REQUEST_TTL_MS,
  });
  slackDeps = { ...baseSlackDeps, service: serviceDeps() };
  const adapter = createSlackGrantApprovalAdapter(slackDeps);

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-grant-request-");
    setApprovalGrantorRouterConfigForTest(() => ({ instances: {}, instanceToAccount: {} }));
    setPermissionAuditPublisherForTest(async () => {});
    resetGrantApprovalAdaptersForTest();
    nowMs = 5_000_000;
    sentRequests = [];
    responses = [];
    dbUpsertInstance({ name: "main", channel: "slack" });
    admin = seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Admin",
      tags: ["permission.admin"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "main" },
    });
    grantee = seedApprovalContact({ phone: APPROVAL_TEST_STRANGER_PHONE, name: "Breno", tags: ["lead"] });
    chatId = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "120363000000000001@g.us",
      chatType: "group",
      title: "Rbbt <> X-One",
    }).id;
    try {
      dbCreateAgent({ id: "xone", cwd: "/tmp/xone" });
    } catch {
      // Already there in this isolated state.
    }
  });

  afterEach(async () => {
    setApprovalGrantorRouterConfigForTest();
    setPermissionAuditPublisherForTest();
    resetGrantApprovalAdaptersForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function plan() {
    return {
      profile: "full-access" as const,
      contactId: grantee.id,
      chatId,
      executorAgentId: "xone",
      contactLabel: "Breno",
      chatLabel: "Rbbt X-One",
    };
  }

  async function open() {
    const result = await requestGrant(
      { plan: plan(), requester: { agentId: "main", channel: "whatsapp" } },
      serviceDeps(),
    );
    return result.request;
  }

  function click(
    requestId: string,
    overrides: Partial<{ actionId: string; userId: string; responseUrlId: string; value: string }> = {},
  ) {
    return {
      provider: "slack",
      accountId: "main",
      instanceId: "main",
      channelId: "D999",
      messageTs: "dm_1",
      userId: overrides.userId ?? APPROVAL_TEST_SLACK_OWNER_USER,
      actionId: overrides.actionId ?? SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
      value: overrides.value ?? requestId,
      responseUrlId: overrides.responseUrlId ?? "resp_1",
    };
  }

  describe("reaching approvers", () => {
    it("lists contacts with a human Slack identity on an enabled Slack instance, nobody else", () => {
      dbUpsertInstance({ name: "off", channel: "slack", enabled: false });
      seedApprovalContact({
        phone: "5511987000001",
        name: "On a disabled workspace",
        tags: [],
        slack: { userId: "UOFFLINE1", instanceId: "off" },
      });
      seedApprovalContact({
        phone: "5511987000002",
        name: "Not a person",
        tags: [],
        slack: { userId: "BBOT00001", instanceId: "main" },
      });

      const reachable = adapter.listReachableContacts();

      expect(reachable).toEqual([
        {
          contactId: admin.id,
          address: { accountId: "main", instanceId: "main", userId: APPROVAL_TEST_SLACK_OWNER_USER },
        },
      ]);
    });

    it("sends a private card to the approver's own Slack user, naming contact and chat with their ids", async () => {
      const request = await open();

      expect(sentRequests).toHaveLength(1);
      const sent = sentRequests[0]!;
      expect(sent.topic).toBe("ravi.outbound.deliver");
      expect(sent.data).toMatchObject({
        channel: "slack",
        accountId: "main",
        to: APPROVAL_TEST_SLACK_OWNER_USER,
        privateTo: [APPROVAL_TEST_SLACK_OWNER_USER],
      });
      const card = JSON.stringify(sent.data.blocks);
      expect(card).toContain("Full access requested");
      expect(card).toContain("Breno");
      expect(card).toContain(`contact:${grantee.id}`);
      expect(card).toContain(`chat:${chatId}`);
      expect(card).toContain(request.id);
      // Only the intent that was asked for is on the card.
      expect(card).not.toContain(SLACK_PERMISSION_GRANT_ACTION_EXACT);
      expect(card).not.toContain("static_select");
    });
  });

  describe("clicks", () => {
    it("lets the admin approve from Slack: grant applied, card replaced, nothing else touched", async () => {
      const request = await open();

      const outcome = await handleSlackGrantRequestInteraction(click(request.id), slackDeps);

      expect(outcome).toEqual({ handled: true, result: "approved" });
      expect(getGrantRequest(request.id)).toMatchObject({
        status: "approved",
        outcome: "applied",
        decidedByContactId: admin.id,
        decidedVia: "slack",
      });
      expect(
        dbGetContactChatGrant({
          contactId: grantee.id,
          profileSlug: "permission-admin",
          scopeType: "chat",
          scopeId: chatId,
        }),
      ).not.toBeNull();
      expect(responses).toHaveLength(1);
      expect(responses[0]?.payload.replace_original).toBe(true);
      expect(JSON.stringify(responses[0]?.payload)).toContain("Full access for Breno");
    });

    it("ignores a click from someone who is not an admin: card kept, note sent, nothing granted", async () => {
      const request = await open();

      const outcome = await handleSlackGrantRequestInteraction(
        click(request.id, { userId: APPROVAL_TEST_SLACK_STRANGER_USER }),
        slackDeps,
      );

      expect(outcome).toEqual({ handled: true, result: "unknown_actor" });
      expect(responses[0]?.payload).toMatchObject({ response_type: "ephemeral", replace_original: false });
      expect(getGrantRequest(request.id)?.status).toBe("pending");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("ignores a click from an admin who was offered the request but was never sent this card", async () => {
      const request = await open();
      // The prompt that was recorded for this admin is gone: nothing ties the click to a delivery.
      getDb().prepare("DELETE FROM permission_grant_request_deliveries WHERE request_id = ?").run(request.id);

      const outcome = await handleSlackGrantRequestInteraction(click(request.id), slackDeps);

      expect(outcome).toEqual({ handled: true, result: "not_grantor" });
      expect(getGrantRequest(request.id)?.status).toBe("pending");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("rejects on Ignore, and answers a later click saying it was already decided", async () => {
      const request = await open();

      const rejected = await handleSlackGrantRequestInteraction(
        click(request.id, { actionId: SLACK_PERMISSION_GRANT_ACTION_IGNORE }),
        slackDeps,
      );
      const later = await handleSlackGrantRequestInteraction(click(request.id), slackDeps);

      expect(rejected).toEqual({ handled: true, result: "rejected" });
      expect(later).toEqual({ handled: true, result: "already_decided" });
      expect(getGrantRequest(request.id)?.status).toBe("rejected");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("tells an approver the request expired and grants nothing", async () => {
      const request = await open();
      nowMs += GRANT_REQUEST_TTL_MS + 1;

      const outcome = await handleSlackGrantRequestInteraction(click(request.id), slackDeps);

      expect(outcome).toEqual({ handled: true, result: "expired" });
      expect(responses[0]?.payload.text).toContain("expired");
      expect(getGrantRequest(request.id)?.status).toBe("expired");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("answers only grant request cards: legacy approval ids and other actions are left alone", async () => {
      expect(await handleSlackGrantRequestInteraction(click("legacy-request-id"), slackDeps)).toEqual({
        handled: false,
      });
      expect(
        await handleSlackGrantRequestInteraction(
          { ...click(`${GRANT_REQUEST_ID_PREFIX}x`), actionId: "something.else" },
          slackDeps,
        ),
      ).toEqual({ handled: false });
      const request = await open();
      for (const actionId of [SLACK_PERMISSION_GRANT_ACTION_EXACT, SLACK_PERMISSION_GRANT_ACTION_SCOPE]) {
        const outcome = await handleSlackGrantRequestInteraction(click(request.id, { actionId }), slackDeps);
        expect(outcome).toEqual({ handled: true, result: "not_offered" });
      }
      expect(getGrantRequest(request.id)?.status).toBe("pending");
    });

    it("is not answered by the legacy click feedback runner", async () => {
      const request = await open();
      const answered = await answerSlackApprovalClick(click(request.id), {
        now: () => nowMs,
        respond: async () => {
          throw new Error("the legacy runner must not answer a grant request click");
        },
      });
      expect(answered).toBeNull();
    });
  });
});
