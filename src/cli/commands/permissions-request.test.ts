import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_STRANGER_PHONE,
  seedApprovalContact,
} from "../../approval/test-support.js";
import { dbGetContactChatGrant, dbListContactChatGrants } from "../../permissions/contact-chat-grants.js";
import { setPermissionAuditPublisherForTest } from "../../permissions/denials.js";
import {
  decideGrantRequest,
  registerGrantApprovalAdapter,
  resetGrantApprovalAdaptersForTest,
} from "../../permissions/grant-requests/service.js";
import type { GrantApprovalChannelAdapter } from "../../permissions/grant-requests/types.js";
import { dbCreateAgent, dbUpdateAgent, dbUpsertChat } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runWithContext } from "../context.js";
import { getCommandAccessMetadata, getCommandsMetadata, getOptionsMetadata } from "../decorators.js";
import { PermissionsCommands, requestFullAccessApproval } from "./permissions.js";

let stateDir: string | null = null;
let delivered: Array<{ contactId: string; requestId: string }> = [];

describe("permissions request / request-status", () => {
  let admin: ReturnType<typeof seedApprovalContact>;
  let grantee: ReturnType<typeof seedApprovalContact>;
  let chatId: string;

  function register(options: { reachable?: boolean; failDelivery?: boolean } = {}) {
    const adapter: GrantApprovalChannelAdapter = {
      channel: "test-channel",
      listReachableContacts: () => (options.reachable === false ? [] : [{ contactId: admin.id, address: {} }]),
      deliver: async ({ request, contactId }) => {
        if (options.failDelivery) throw new Error("channel is down");
        delivered.push({ contactId, requestId: request.id });
        return { ref: { messageId: "m1" } };
      },
    };
    registerGrantApprovalAdapter(adapter);
  }

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permissions-request-");
    setPermissionAuditPublisherForTest(async () => {});
    resetGrantApprovalAdaptersForTest();
    delivered = [];
    admin = seedApprovalContact({ phone: APPROVAL_TEST_SLACK_OWNER_PHONE, name: "Admin", tags: ["permission.admin"] });
    grantee = seedApprovalContact({ phone: APPROVAL_TEST_STRANGER_PHONE, name: "Breno", tags: ["lead"] });
    chatId = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "120363000000000001@g.us",
      chatType: "group",
      title: "Rbbt <> X-One",
    }).id;
    for (const [id, profile] of [
      ["xone", "full-access"],
      ["chatonly", "chat-only"],
      ["plain", undefined],
    ] as const) {
      dbCreateAgent({ id, cwd: `/tmp/${id}` });
      if (profile) dbUpdateAgent(id, { defaults: { runtimePermissions: { profile } } });
    }
  });

  afterEach(async () => {
    setPermissionAuditPublisherForTest();
    resetGrantApprovalAdaptersForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function request(
    input: Partial<Parameters<typeof requestFullAccessApproval>[0]> = {},
    source?: { channel: string; accountId: string; chatId: string } | null,
  ) {
    return runWithContext(
      {
        agentId: "main",
        sessionName: "main",
        suppressCliOutput: true,
        ...(source === null ? {} : { source: source ?? { channel: "slack", accountId: "main", chatId: "D1" } }),
      },
      () =>
        requestFullAccessApproval({
          profile: "full-access",
          to: `contact:${grantee.id}`,
          chat: chatId,
          agentId: "xone",
          execute: true,
          ...input,
        }),
    ).catch((error: unknown) => error);
  }

  it("asks the approvers and returns at once, whatever channel the turn came from", async () => {
    register();

    const fromSlack = await request({}, { channel: "slack", accountId: "main", chatId: "D1" });
    expect(fromSlack).toMatchObject({
      status: "pending",
      contactId: grantee.id,
      chatId,
      agent: "xone",
      reused: false,
      deliveries: [{ contactId: admin.id, channel: "test-channel" }],
    });
    // A second ask for the same plan from a turn of another channel reuses the open request.
    const fromWhatsapp = await request({}, { channel: "whatsapp", accountId: "main", chatId: "G1" });
    const fromTerminal = await request({}, null);
    expect(fromWhatsapp).toMatchObject({ status: "pending", reused: true });
    expect(fromTerminal).toMatchObject({ status: "pending", reused: true });
    expect(delivered).toHaveLength(1);
    expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
  });

  it("only plans without --execute: nobody is asked", async () => {
    register();

    const error = await request({ execute: false });

    expect(error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(delivered).toEqual([]);
  });

  it("fails closed with a clear code when nobody can be asked", async () => {
    // No adapter at all (for example a CLI outside the daemon).
    expect(await request()).toMatchObject({ code: "FULL_ACCESS_APPROVAL_UNAVAILABLE", exitCode: 3 });
    register({ reachable: false });
    expect(await request()).toMatchObject({ code: "FULL_ACCESS_APPROVER_UNAVAILABLE", exitCode: 3 });
    resetGrantApprovalAdaptersForTest();
    register({ failDelivery: true });
    expect(await request()).toMatchObject({ code: "FULL_ACCESS_APPROVER_UNREACHABLE", exitCode: 3 });
    expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
  });

  it("accepts only full-access, one contact, one chat and an executor that already holds admin", async () => {
    register();

    expect(await request({ profile: "bootstrap" })).toMatchObject({ code: "USAGE_ERROR" });
    expect(await request({ to: `contact:${grantee.id},contact:other` })).toMatchObject({ code: "USAGE_ERROR" });
    expect(await request({ to: "agent:xone" })).toMatchObject({ code: "USAGE_ERROR" });
    expect(await request({ chat: undefined })).toMatchObject({ code: "USAGE_ERROR" });
    expect(await request({ agentId: undefined })).toMatchObject({ code: "USAGE_ERROR" });
    expect(await request({ agentId: "no-such-agent" })).toMatchObject({ code: "USAGE_ERROR" });
    for (const agentId of ["chatonly", "plain"]) {
      expect(await request({ agentId })).toMatchObject({ code: "FULL_ACCESS_EXECUTOR_CEILING", exitCode: 3 });
    }
    expect(delivered).toEqual([]);
  });

  it("reports the request state, and 'applied' only once the grant is read back in place", async () => {
    register();
    const asked = (await request()) as { requestId: string };
    const status = () =>
      runWithContext({ suppressCliOutput: true }, () => new PermissionsCommands().requestStatus(asked.requestId, true));

    expect(status()).toMatchObject({ status: "pending", applied: false, contactId: grantee.id, agent: "xone" });

    decideGrantRequest({
      requestId: asked.requestId,
      decision: "approve",
      actor: { channel: "test-channel", senderId: APPROVAL_TEST_SLACK_OWNER_PHONE },
    });

    expect(status()).toMatchObject({
      status: "approved",
      applied: true,
      decidedByContactId: admin.id,
      decidedVia: "test-channel",
    });
    expect(
      dbGetContactChatGrant({
        contactId: grantee.id,
        profileSlug: "permission-admin",
        scopeType: "chat",
        scopeId: chatId,
      }),
    ).not.toBeNull();
    // The revoke command the request printed really removes the grant.
    const revoked = runWithContext({ suppressCliOutput: true }, () =>
      new PermissionsCommands().deny("permission-admin", `contact:${grantee.id}`, chatId, undefined, false, true, true),
    );
    expect(revoked.changedCount).toBe(1);
    expect(dbListContactChatGrants({ contactId: grantee.id })).toEqual([]);
    expect(() =>
      runWithContext({ suppressCliOutput: true }, () => new PermissionsCommands().requestStatus("pgr_missing", true)),
    ).toThrow();
  });

  it("declares its confirmation brake and does not hold the gateway waiting for a decision", () => {
    const meta = getCommandsMetadata(PermissionsCommands).find((command) => command.name === "request");
    const access = getCommandAccessMetadata(PermissionsCommands).get("request");
    expect(access).toMatchObject({ kind: "mutate", requiresConfirmation: true });
    // It returns as soon as the approvers are asked, so no long remote timeout is needed.
    expect(meta?.remoteTimeoutMs).toBeUndefined();
    const options = getOptionsMetadata(PermissionsCommands.prototype, "request");
    const execute = options.find((option) => option.flags.includes("--execute"));
    expect(execute?.index).toBe(Math.max(...options.map((option) => option.index)));
    expect(getCommandAccessMetadata(PermissionsCommands).get("requestStatus")).toMatchObject({ kind: "read" });
  });
});
