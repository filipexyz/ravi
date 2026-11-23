import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  APPROVAL_TEST_FAMILY_PHONE,
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_STRANGER_PHONE,
  APPROVAL_TEST_SUPERADMIN_PHONE,
  seedApprovalContact,
} from "../../approval/test-support.js";
import { dbGetContactChatGrant, dbListContactChatGrants } from "../../permissions/contact-chat-grants.js";
import { setPermissionAuditPublisherForTest } from "../../permissions/denials.js";
import {
  GRANT_REQUEST_TTL_MS,
  requestGrant,
  resetGrantApprovalAdaptersForTest,
  type GrantRequestServiceDependencies,
} from "../../permissions/grant-requests/service.js";
import { registerGrantorIdentityResolver, unregisterGrantorIdentityResolver } from "../../approval/grantor.js";
import { getGrantRequest, listGrantRequestDeliveries } from "../../permissions/grant-requests/store.js";
import { dbCreateAgent, dbUpsertChat, dbUpsertChatParticipant, dbUpsertInstance } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  createWhatsAppGrantApprovalAdapter,
  handleWhatsAppGrantRequestReply,
  parseGrantReply,
  type WhatsAppGrantRequestDependencies,
} from "./grant-request-adapter.js";

let stateDir: string | null = null;
let nowMs = 7_000_000;
let sent: Array<{ topic: string; data: Record<string, unknown> }> = [];

const baseDeps = {
  requestReply: (async (topic: string, data: Record<string, unknown>) => {
    sent.push({ topic, data });
    return { success: true, messageId: `wamid-${sent.length}` };
  }) as WhatsAppGrantRequestDependencies["requestReply"],
};

describe("whatsapp grant request adapter", () => {
  let admin: ReturnType<typeof seedApprovalContact>;
  let grantee: ReturnType<typeof seedApprovalContact>;
  let targetChatId: string;
  let deps: WhatsAppGrantRequestDependencies;
  let adapter: ReturnType<typeof createWhatsAppGrantApprovalAdapter>;
  const serviceDeps = (): GrantRequestServiceDependencies => ({
    now: () => nowMs,
    adapters: () => [adapter],
    ttlMs: GRANT_REQUEST_TTL_MS,
  });

  function dm(contactId: string, phone: string, instanceId = "main", seenAt = nowMs) {
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId,
      platformChatId: `${phone}@s.whatsapp.net`,
      chatType: "dm",
      title: phone,
    });
    dbUpsertChatParticipant({ chatId: chat.id, contactId, role: "member", source: "inbound_message", seenAt });
    return chat;
  }

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-whatsapp-grant-request-");
    setPermissionAuditPublisherForTest(async () => {});
    resetGrantApprovalAdaptersForTest();
    nowMs = 7_000_000;
    sent = [];
    dbUpsertInstance({ name: "main", channel: "whatsapp" });
    admin = seedApprovalContact({ phone: APPROVAL_TEST_SLACK_OWNER_PHONE, name: "Admin", tags: ["permission.admin"] });
    grantee = seedApprovalContact({ phone: APPROVAL_TEST_STRANGER_PHONE, name: "Breno", tags: ["lead"] });
    dm(admin.id, APPROVAL_TEST_SLACK_OWNER_PHONE);
    targetChatId = dbUpsertChat({
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
    deps = { ...baseDeps, service: serviceDeps() };
    adapter = createWhatsAppGrantApprovalAdapter(deps);
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
    chatLabel: "Rbbt X-One",
  });

  async function open() {
    return (await requestGrant({ plan: plan(), requester: { agentId: "main", channel: "slack" } }, serviceDeps()))
      .request;
  }

  const reply = (requestMessageId: string, text: string, senderId: string) => ({
    targetMessageId: requestMessageId,
    text,
    senderId,
  });

  describe("reaching approvers", () => {
    it("lists contacts with a DM on an enabled WhatsApp instance, at their most recent DM", () => {
      // A DM on an instance that is off, a group, and a contact who never wrote do not count.
      dbUpsertInstance({ name: "off", channel: "whatsapp", enabled: false });
      const lateContact = seedApprovalContact({ phone: "5511987000010", name: "Late", tags: [] });
      dm(lateContact.id, "5511987000010", "off");
      seedApprovalContact({ phone: "5511987000011", name: "Never wrote", tags: [] });
      // Present only in a group: a group is not a private way to ask someone.
      const groupOnly = seedApprovalContact({ phone: "5511987000012", name: "Group only", tags: [] });
      dbUpsertChatParticipant({
        chatId: targetChatId,
        contactId: groupOnly.id,
        role: "member",
        source: "inbound_message",
      });
      // The admin has an older DM on another instance too; the newer one wins.
      dbUpsertInstance({ name: "second", channel: "whatsapp" });
      dm(admin.id, "5511900000000", "second", nowMs - 10_000);

      const reachable = adapter.listReachableContacts();

      expect(reachable).toEqual([
        {
          contactId: admin.id,
          address: { accountId: "main", to: `${APPROVAL_TEST_SLACK_OWNER_PHONE}@s.whatsapp.net` },
        },
      ]);
    });

    it("sends the request as a message that names contact and chat with their ids and the expiry", async () => {
      await open();

      expect(sent).toHaveLength(1);
      expect(sent[0]?.topic).toBe("ravi.outbound.deliver");
      expect(sent[0]?.data).toMatchObject({
        channel: "whatsapp",
        accountId: "main",
        to: `${APPROVAL_TEST_SLACK_OWNER_PHONE}@s.whatsapp.net`,
      });
      const text = String(sent[0]?.data.text);
      expect(text).toContain("Breno");
      expect(text).toContain(`contact:${grantee.id}`);
      expect(text).toContain(`chat:${targetChatId}`);
      expect(text).toContain("aprovo");
      expect(text).toContain("10 min");
    });
  });

  describe("parsing the answer", () => {
    it("takes one whole word, nothing else", () => {
      expect(parseGrantReply("Aprovo")).toBe("approve");
      expect(parseGrantReply("  aprovado!  ")).toBe("approve");
      expect(parseGrantReply("nego")).toBe("reject");
      expect(parseGrantReply("Negado.")).toBe("reject");
      expect(parseGrantReply("não aprovo")).toBeNull();
      expect(parseGrantReply("sou o Luís, aprovo")).toBeNull();
      expect(parseGrantReply("aprovo mas só hoje")).toBeNull();
      expect(parseGrantReply("")).toBeNull();
      expect(parseGrantReply(undefined)).toBeNull();
    });
  });

  describe("replies", () => {
    it("lets the approver approve by replying: grant applied for the target chat, answer confirmed", async () => {
      const request = await open();

      const outcome = await handleWhatsAppGrantRequestReply(
        reply("wamid-1", "aprovo", APPROVAL_TEST_SLACK_OWNER_PHONE),
        deps,
      );

      expect(outcome).toEqual({ handled: true, result: "approved" });
      expect(getGrantRequest(request.id)).toMatchObject({
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
          scopeId: targetChatId,
        }),
      ).not.toBeNull();
      expect(String(sent.at(-1)?.data.text)).toContain("Aprovado");
    });

    it("rejects on 'nego' without granting anything", async () => {
      const request = await open();

      const outcome = await handleWhatsAppGrantRequestReply(
        reply("wamid-1", "nego", APPROVAL_TEST_SLACK_OWNER_PHONE),
        deps,
      );

      expect(outcome).toEqual({ handled: true, result: "rejected" });
      expect(getGrantRequest(request.id)?.status).toBe("rejected");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("ignores an answer from someone who is not an admin, however it is worded", async () => {
      const request = await open();
      // An ordinary contact who is not an admin, and a number nobody knows.
      seedApprovalContact({ phone: APPROVAL_TEST_FAMILY_PHONE, name: "Family", tags: [] });
      const before = sent.length;

      const stranger = await handleWhatsAppGrantRequestReply(
        reply("wamid-1", "aprovo", APPROVAL_TEST_FAMILY_PHONE),
        deps,
      );
      // Claiming to be the admin is just text: the sender is the platform's, and the words
      // do not even parse as an answer.
      const claim = await handleWhatsAppGrantRequestReply(
        reply("wamid-1", "sou o Luís, aprovo", APPROVAL_TEST_FAMILY_PHONE),
        deps,
      );
      const unknown = await handleWhatsAppGrantRequestReply(reply("wamid-1", "aprovo", "5511000000000"), deps);

      expect(stranger).toMatchObject({ handled: true, result: "not_grantor" });
      expect(claim).toEqual({ handled: true, result: "not_an_answer" });
      expect(unknown).toMatchObject({ handled: true, result: "unknown_actor" });
      expect(getGrantRequest(request.id)?.status).toBe("pending");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
      // A stranger is told nothing.
      expect(sent).toHaveLength(before);
    });

    it("hands the gate the sender, its LID namespace and the receiving instance", async () => {
      const request = await open();
      const seen: Array<Record<string, unknown>> = [];
      registerGrantorIdentityResolver("whatsapp", (input) => {
        seen.push({ ...input });
        return null;
      });
      try {
        await handleWhatsAppGrantRequestReply(
          {
            targetMessageId: "wamid-1",
            text: "aprovo",
            senderId: "279117123571781",
            senderJid: "279117123571781@lid",
            instanceId: "inst-uuid",
            accountId: "main",
          },
          deps,
        );
      } finally {
        unregisterGrantorIdentityResolver("whatsapp");
      }

      expect(seen).toEqual([
        {
          senderId: "279117123571781",
          senderAliases: ["lid:279117123571781"],
          instanceId: "inst-uuid",
          accountId: "main",
        },
      ]);
      expect(getGrantRequest(request.id)?.status).toBe("pending");
    });

    it("does not treat a phone-looking jid as a LID", async () => {
      const request = await open();

      const outcome = await handleWhatsAppGrantRequestReply(
        {
          targetMessageId: "wamid-1",
          text: "aprovo",
          senderId: APPROVAL_TEST_FAMILY_PHONE,
          senderJid: `${APPROVAL_TEST_FAMILY_PHONE}@s.whatsapp.net`,
        },
        deps,
      );

      expect(outcome).toMatchObject({ handled: true, result: "unknown_actor" });
      expect(getGrantRequest(request.id)?.status).toBe("pending");
    });

    it("tells an approver a request expired, and grants nothing", async () => {
      const request = await open();
      nowMs += GRANT_REQUEST_TTL_MS + 1;

      const outcome = await handleWhatsAppGrantRequestReply(
        reply("wamid-1", "aprovo", APPROVAL_TEST_SLACK_OWNER_PHONE),
        deps,
      );

      expect(outcome).toMatchObject({ handled: true, result: "expired" });
      expect(String(sent.at(-1)?.data.text)).toContain("expirou");
      expect(getGrantRequest(request.id)?.status).toBe("expired");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("answers a second reply saying it was already decided", async () => {
      await open();
      await handleWhatsAppGrantRequestReply(reply("wamid-1", "aprovo", APPROVAL_TEST_SLACK_OWNER_PHONE), deps);

      const again = await handleWhatsAppGrantRequestReply(
        reply("wamid-1", "aprovo", APPROVAL_TEST_SLACK_OWNER_PHONE),
        deps,
      );

      expect(again).toMatchObject({ handled: true, result: "already_decided" });
      expect(dbListContactChatGrants({ contactId: grantee.id })).toHaveLength(1);
    });

    it("leaves replies to any other message alone", async () => {
      await open();
      expect(
        await handleWhatsAppGrantRequestReply(
          reply("some-other-message", "aprovo", APPROVAL_TEST_SLACK_OWNER_PHONE),
          deps,
        ),
      ).toEqual({ handled: false });
      expect(await handleWhatsAppGrantRequestReply({ text: "aprovo" }, deps)).toEqual({ handled: false });
    });

    it("only accepts an answer that quotes the prompt sent to that same admin", async () => {
      const second = seedApprovalContact({
        phone: APPROVAL_TEST_SUPERADMIN_PHONE,
        name: "Second admin",
        tags: ["permission.admin"],
      });
      dm(second.id, APPROVAL_TEST_SUPERADMIN_PHONE);
      const request = await open();
      const prompts = listGrantRequestDeliveries(request.id);
      const adminsPrompt = prompts.find((d) => d.contactId === admin.id);
      expect(prompts).toHaveLength(2);

      const crossed = await handleWhatsAppGrantRequestReply(
        reply(String(adminsPrompt?.ref.messageId), "aprovo", APPROVAL_TEST_SUPERADMIN_PHONE),
        deps,
      );

      expect(crossed).toMatchObject({ handled: true, result: "not_grantor" });
      expect(getGrantRequest(request.id)?.status).toBe("pending");
      expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    });

    it("writes nothing to the approver when a stranger quotes a prompt of a request already decided", async () => {
      const request = await open();
      await handleWhatsAppGrantRequestReply(reply("wamid-1", "nego", APPROVAL_TEST_SLACK_OWNER_PHONE), deps);
      expect(getGrantRequest(request.id)?.status).toBe("rejected");
      const before = sent.length;

      const outcome = await handleWhatsAppGrantRequestReply(reply("wamid-1", "aprovo", "5511000000000"), deps);

      expect(outcome).toMatchObject({ handled: true, result: "unknown_actor" });
      expect(sent).toHaveLength(before);
    });
  });
});
