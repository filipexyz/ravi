import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS } from "../approval/slack-blocks.js";
import {
  APPROVAL_TEST_FAMILY_PHONE,
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_STRANGER_PHONE,
  APPROVAL_TEST_SUPERADMIN_PHONE,
  seedApprovalContact,
} from "../approval/test-support.js";
import { dbGetContactChatGrant, dbListContactChatGrants } from "../permissions/contact-chat-grants.js";
import { setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import {
  GRANT_REQUEST_TTL_MS,
  requestGrant,
  resetGrantApprovalAdaptersForTest,
  type GrantRequestServiceDependencies,
} from "../permissions/grant-requests/service.js";
import { getGrantRequest, listGrantRequestDeliveries } from "../permissions/grant-requests/store.js";
import { dbCreateAgent, dbUpsertChat, dbUpsertChatParticipant, dbUpsertInstance } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createSlackGrantApprovalAdapter, handleSlackGrantRequestInteraction } from "./slack/grant-request-adapter.js";
import {
  createWhatsAppGrantApprovalAdapter,
  handleWhatsAppGrantRequestReply,
  type WhatsAppGrantRequestDependencies,
} from "./whatsapp/grant-request-adapter.js";

let stateDir: string | null = null;
let nowMs = 9_000_000;
let slackSent: Array<Record<string, unknown>> = [];
let whatsappSent: Array<Record<string, unknown>> = [];
let slackResponses: Array<Record<string, unknown>> = [];

/**
 * A request asked from one channel's turn, offered on both, answered on the
 * other. Both adapters are the real ones; only the outbound transport is faked.
 */
describe("grant requests across channels", () => {
  let slackAdmin: ReturnType<typeof seedApprovalContact>;
  let whatsappAdmin: ReturnType<typeof seedApprovalContact>;
  let grantee: ReturnType<typeof seedApprovalContact>;
  let targetChatId: string;

  const requestReply = (async (_topic: string, data: Record<string, unknown>) => {
    if (data.channel === "slack") {
      slackSent.push(data);
      return {
        messageId: "slack-1",
        deliveries: [{ userId: data.to, kind: "dm", chatId: "D1", messageId: "slack-1" }],
      };
    }
    whatsappSent.push(data);
    return { success: true, messageId: `wamid-${whatsappSent.length}` };
  }) as WhatsAppGrantRequestDependencies["requestReply"];

  const serviceDeps = (): GrantRequestServiceDependencies => ({
    now: () => nowMs,
    adapters: () => [slack, whatsapp],
    ttlMs: GRANT_REQUEST_TTL_MS,
  });
  const slackDeps = () => ({
    service: serviceDeps(),
    requestReply,
    respond: async (input: { payload: Record<string, unknown> }) => {
      slackResponses.push(input.payload);
    },
  });
  const whatsappDeps = () => ({ service: serviceDeps(), requestReply });
  const slack = createSlackGrantApprovalAdapter(slackDeps());
  const whatsapp = createWhatsAppGrantApprovalAdapter(whatsappDeps());

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-cross-channel-grant-");
    setPermissionAuditPublisherForTest(async () => {});
    resetGrantApprovalAdaptersForTest();
    nowMs = 9_000_000;
    slackSent = [];
    whatsappSent = [];
    slackResponses = [];
    dbUpsertInstance({ name: "main", channel: "slack" });
    dbUpsertInstance({ name: "wa", channel: "whatsapp" });
    // One admin reachable only on Slack, another reachable only on WhatsApp.
    slackAdmin = seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Slack admin",
      tags: ["permission.admin"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "main" },
    });
    whatsappAdmin = seedApprovalContact({
      phone: APPROVAL_TEST_SUPERADMIN_PHONE,
      name: "WhatsApp admin",
      tags: ["permission.admin"],
    });
    const dm = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "wa",
      platformChatId: `${APPROVAL_TEST_SUPERADMIN_PHONE}@s.whatsapp.net`,
      chatType: "dm",
      title: "dm",
    });
    dbUpsertChatParticipant({ chatId: dm.id, contactId: whatsappAdmin.id, role: "member", source: "inbound_message" });
    grantee = seedApprovalContact({ phone: APPROVAL_TEST_STRANGER_PHONE, name: "Breno", tags: ["lead"] });
    targetChatId = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "wa",
      platformChatId: "120363000000000001@g.us",
      chatType: "group",
      title: "Customer group",
    }).id;
    try {
      dbCreateAgent({ id: "xone", cwd: "/tmp/xone" });
    } catch {
      // Already there in this isolated state.
    }
  });

  afterEach(async () => {
    setPermissionAuditPublisherForTest();
    resetGrantApprovalAdaptersForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const plan = () => ({
    profile: "full-access" as const,
    contactId: grantee.id,
    chatId: targetChatId,
    executorAgentId: "xone",
    contactLabel: "Breno",
    chatLabel: "Customer group",
  });

  const granted = () =>
    dbGetContactChatGrant({
      contactId: grantee.id,
      profileSlug: "permission-admin",
      scopeType: "chat",
      scopeId: targetChatId,
    }) !== null;

  const slackClick = (requestId: string, userId = APPROVAL_TEST_SLACK_OWNER_USER) => ({
    provider: "slack",
    accountId: "main",
    instanceId: "main",
    channelId: "D1",
    messageTs: "slack-1",
    userId,
    actionId: SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
    value: requestId,
    responseUrlId: "resp",
  });

  it("asked from a Slack turn, answered by the WhatsApp-only admin", async () => {
    const { request, deliveries } = await requestGrant(
      { plan: plan(), requester: { agentId: "main", channel: "slack" } },
      serviceDeps(),
    );

    // Offered on both channels, to each admin where they can be reached.
    expect(deliveries.map((delivery) => [delivery.channel, delivery.contactId]).sort()).toEqual(
      [
        ["slack", slackAdmin.id],
        ["whatsapp", whatsappAdmin.id],
      ].sort(),
    );
    expect(slackSent).toHaveLength(1);
    expect(whatsappSent).toHaveLength(1);

    const outcome = await handleWhatsAppGrantRequestReply(
      { targetMessageId: "wamid-1", text: "aprovo", senderId: APPROVAL_TEST_SUPERADMIN_PHONE },
      whatsappDeps(),
    );

    expect(outcome).toEqual({ handled: true, result: "approved" });
    expect(granted()).toBe(true);
    expect(getGrantRequest(request.id)).toMatchObject({
      decidedByContactId: whatsappAdmin.id,
      decidedVia: "whatsapp",
      requester: { channel: "slack" },
    });
    // The other admin's Slack card is now stale: a click on it is told so and grants nothing more.
    const late = await handleSlackGrantRequestInteraction(slackClick(request.id), slackDeps());
    expect(late).toEqual({ handled: true, result: "already_decided" });
    expect(dbListContactChatGrants({ contactId: grantee.id })).toHaveLength(1);
  });

  it("asked from a WhatsApp turn, answered by the Slack-only admin", async () => {
    const { request } = await requestGrant(
      { plan: plan(), requester: { agentId: "main", channel: "whatsapp" } },
      serviceDeps(),
    );

    const outcome = await handleSlackGrantRequestInteraction(slackClick(request.id), slackDeps());

    expect(outcome).toEqual({ handled: true, result: "approved" });
    expect(granted()).toBe(true);
    expect(getGrantRequest(request.id)).toMatchObject({
      decidedByContactId: slackAdmin.id,
      decidedVia: "slack",
      requester: { channel: "whatsapp" },
    });
    // The WhatsApp admin answering afterwards is told it was already decided.
    const late = await handleWhatsAppGrantRequestReply(
      { targetMessageId: "wamid-1", text: "aprovo", senderId: APPROVAL_TEST_SUPERADMIN_PHONE },
      whatsappDeps(),
    );
    expect(late).toMatchObject({ handled: true, result: "already_decided" });
    expect(dbListContactChatGrants({ contactId: grantee.id })).toHaveLength(1);
  });

  it("refuses a non-admin on either channel and a late answer on both", async () => {
    seedApprovalContact({ phone: APPROVAL_TEST_FAMILY_PHONE, name: "Family", tags: [] });
    const { request } = await requestGrant({ plan: plan(), requester: { agentId: "main" } }, serviceDeps());

    const onWhatsapp = await handleWhatsAppGrantRequestReply(
      { targetMessageId: "wamid-1", text: "aprovo", senderId: APPROVAL_TEST_FAMILY_PHONE },
      whatsappDeps(),
    );
    const onSlack = await handleSlackGrantRequestInteraction(slackClick(request.id, "UNOBODY99"), slackDeps());

    expect(onWhatsapp).toMatchObject({ handled: true, result: "not_grantor" });
    expect(onSlack).toMatchObject({ handled: true, result: "unknown_actor" });
    expect(granted()).toBe(false);

    nowMs += GRANT_REQUEST_TTL_MS + 1;
    const lateWhatsapp = await handleWhatsAppGrantRequestReply(
      { targetMessageId: "wamid-1", text: "aprovo", senderId: APPROVAL_TEST_SUPERADMIN_PHONE },
      whatsappDeps(),
    );
    const lateSlack = await handleSlackGrantRequestInteraction(slackClick(request.id), slackDeps());
    expect(lateWhatsapp).toMatchObject({ result: "expired" });
    expect(lateSlack).toMatchObject({ result: "expired" });
    expect(granted()).toBe(false);
    expect(listGrantRequestDeliveries(request.id)).toHaveLength(2);
  });
});
