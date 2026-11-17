/**
 * Route-agent migration must release inbound chat subscriptions (bug c274ad9d).
 *
 * An inbound DM pins the canonical chat to agent A's session. After the route
 * agent changes to B, the next matchRoute result is what the consumer uses —
 * unless the operator explicitly attached the chat.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createContact } from "../contacts.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { loadRouterConfig } from "./config.js";
import {
  detachRouteBookkeepingSubscriptions,
  listRouteStickyOverrides,
  sessionHasExplicitAttach,
} from "./route-sticky-attach.js";
import { matchRoute } from "./resolver.js";
import { dbCreateAgent, dbCreateRoute, dbUpdateRoute, dbUpsertChat, dbUpsertInstance } from "./router-db.js";
import { attachChatToSession, findSessionByAttachedChat, getOrCreateSession } from "./sessions.js";

let stateDir: string | null = null;

const PHONE = "5511999999999";
const LID = "224420715061374";
const INSTANCE_ID = "omni-main";

async function setupInstance(): Promise<void> {
  dbCreateAgent({ id: "michael-test", cwd: "/tmp/michael-test" });
  dbCreateAgent({ id: "nba-front-user", cwd: "/tmp/nba-front-user" });
  dbUpsertInstance({
    name: "main",
    instanceId: INSTANCE_ID,
    channel: "whatsapp",
    agent: "michael-test",
  });
}

function pinChat(input: {
  sessionKey: string;
  agentId: string;
  platformChatId: string;
  normalizedChatId?: string;
  instanceId?: string;
  accountId?: string;
  attachedByType: "system" | "user" | "agent";
  attachedReason: string;
}) {
  const session = getOrCreateSession(input.sessionKey, input.agentId, `/tmp/${input.agentId}`, {
    accountId: input.accountId ?? "main",
    channel: "whatsapp",
    chatType: "dm",
    name: `${input.agentId}-dm`,
  });
  const chat = dbUpsertChat({
    channel: "whatsapp",
    instanceId: input.instanceId ?? INSTANCE_ID,
    platformChatId: input.platformChatId,
    normalizedChatId: input.normalizedChatId,
    chatType: "dm",
    title: input.platformChatId,
  });
  attachChatToSession({
    sessionKey: session.sessionKey,
    chatId: chat.id,
    role: "primary",
    attachedByType: input.attachedByType,
    attachedReason: input.attachedReason,
    setOutputTarget: true,
  });
  return { session, chat };
}

describe("route agent migration releases inbound subscriptions", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-route-sticky-");
    await setupInstance();
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("detaches an inbound subscription so the next route resolution uses the new agent", () => {
    dbCreateRoute({
      pattern: PHONE,
      accountId: "main",
      agent: "michael-test",
      channel: "whatsapp",
    });
    const { chat } = pinChat({
      // Session key is the LID form, so the exact-phone session heuristic does
      // not see it. The subscription is what kept inbound on michael-test.
      sessionKey: `agent:michael-test:whatsapp:main:dm:lid:${LID}`,
      agentId: "michael-test",
      platformChatId: `${PHONE}@s.whatsapp.net`,
      attachedByType: "system",
      attachedReason: "inbound-route",
    });
    dbUpdateRoute(PHONE, { agent: "nba-front-user" }, "main");

    const released = detachRouteBookkeepingSubscriptions({
      accountId: "main",
      pattern: PHONE,
      targetAgent: "nba-front-user",
      channel: "whatsapp",
    });

    expect(released.detached).toBe(1);
    expect(released.preserved).toEqual([]);
    expect(findSessionByAttachedChat(chat.id)).toBeNull();

    const matched = matchRoute(loadRouterConfig(), {
      phone: PHONE,
      accountId: "main",
      channel: "whatsapp",
    });
    expect(matched?.agentId).toBe("nba-front-user");
    expect(matched?.sessionKey.startsWith("agent:nba-front-user:")).toBe(true);
    expect(listRouteStickyOverrides({ accountId: "main", pattern: PHONE, channel: "whatsapp" })).toEqual([]);
  });

  it("releases a Slack channel pinned to the previous agent (group:<id> route, bug a2d9fc1c)", () => {
    dbUpsertInstance({ name: "slack-main", instanceId: "slack-main", channel: "slack", agent: "michael-test" });
    const session = getOrCreateSession(
      "agent:michael-test:slack:slack-main:group:C0ABC123",
      "michael-test",
      "/tmp/michael-test",
      { accountId: "slack-main", channel: "slack", chatType: "group", name: "michael-test-c0abc123" },
    );
    const chat = dbUpsertChat({
      channel: "slack",
      instanceId: "slack-main",
      platformChatId: "C0ABC123",
      chatType: "group",
      title: "C0ABC123",
    });
    attachChatToSession({
      sessionKey: session.sessionKey,
      chatId: chat.id,
      role: "primary",
      attachedByType: "system",
      attachedReason: "slack-socket-mode",
      setOutputTarget: true,
    });
    dbCreateRoute({
      pattern: "group:C0ABC123",
      accountId: "slack-main",
      agent: "nba-front-user",
      session: "nba-front-user-fixed",
      channel: "slack",
    });

    expect(listRouteStickyOverrides({ accountId: "slack-main", pattern: "group:C0ABC123", channel: "slack" })).toEqual([
      expect.objectContaining({ chatId: chat.id, agentId: "michael-test" }),
    ]);

    const released = detachRouteBookkeepingSubscriptions({
      accountId: "slack-main",
      pattern: "group:C0ABC123",
      targetAgent: "nba-front-user",
      channel: "slack",
    });

    expect(released.detached).toBe(1);
    expect(findSessionByAttachedChat(chat.id)).toBeNull();
  });

  it("keeps an explicit sessions attach and reports that it still overrides the route", () => {
    dbCreateRoute({
      pattern: PHONE,
      accountId: "main",
      agent: "michael-test",
      channel: "whatsapp",
    });
    const sessionKey = `agent:michael-test:whatsapp:main:dm:${PHONE}`;
    const { chat } = pinChat({
      sessionKey,
      agentId: "michael-test",
      platformChatId: `${PHONE}@s.whatsapp.net`,
      attachedByType: "user",
      attachedReason: "cli-attach",
    });
    dbUpdateRoute(PHONE, { agent: "nba-front-user" }, "main");

    const released = detachRouteBookkeepingSubscriptions({
      accountId: "main",
      pattern: PHONE,
      targetAgent: "nba-front-user",
      channel: "whatsapp",
    });

    expect(released.detached).toBe(0);
    expect(released.preserved).toHaveLength(1);
    expect(released.preserved[0]?.explicit).toBe(true);
    expect(released.preserved[0]?.agentId).toBe("michael-test");
    expect(findSessionByAttachedChat(chat.id)?.sessionKey).toBe(sessionKey);
    expect(sessionHasExplicitAttach(sessionKey)).toBe(true);

    const overrides = listRouteStickyOverrides({
      accountId: "main",
      pattern: PHONE,
      channel: "whatsapp",
    });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.agentId).toBe("michael-test");
    expect(overrides[0]?.detachCommand).toContain(`--chat ${chat.id}`);

    const matched = matchRoute(loadRouterConfig(), {
      phone: PHONE,
      accountId: "main",
      channel: "whatsapp",
    });
    expect(matched?.agentId).toBe("nba-front-user");
    expect(matched?.sessionKey).not.toBe(sessionKey);
  });

  it("finds a contact-canonical DM when the route pattern is the phone and the platform id is the LID", () => {
    const contact = createContact({ phone: "5511888777666", name: "Front" });
    dbCreateRoute({
      pattern: "5511888777666",
      accountId: "main",
      agent: "michael-test",
      channel: "whatsapp",
    });
    const { chat } = pinChat({
      sessionKey: `agent:michael-test:whatsapp:main:dm:lid:${LID}`,
      agentId: "michael-test",
      platformChatId: `${LID}@lid`,
      normalizedChatId: `contact:${contact.id}`,
      attachedByType: "system",
      attachedReason: "inbound-route",
    });
    dbUpdateRoute("5511888777666", { agent: "nba-front-user" }, "main");

    const released = detachRouteBookkeepingSubscriptions({
      accountId: "main",
      pattern: "5511888777666",
      targetAgent: "nba-front-user",
      channel: "whatsapp",
    });

    expect(released.detached).toBe(1);
    expect(findSessionByAttachedChat(chat.id)).toBeNull();
    expect(
      matchRoute(loadRouterConfig(), {
        phone: "5511888777666",
        accountId: "main",
        channel: "whatsapp",
      })?.agentId,
    ).toBe("nba-front-user");
  });

  it("does not detach a subscription on a different instance", () => {
    dbUpsertInstance({
      name: "other",
      instanceId: "omni-other",
      channel: "whatsapp",
      agent: "michael-test",
    });
    dbCreateRoute({
      pattern: PHONE,
      accountId: "main",
      agent: "nba-front-user",
      channel: "whatsapp",
    });
    const { chat } = pinChat({
      sessionKey: `agent:michael-test:whatsapp:other:dm:${PHONE}`,
      agentId: "michael-test",
      platformChatId: `${PHONE}@s.whatsapp.net`,
      instanceId: "omni-other",
      accountId: "other",
      attachedByType: "system",
      attachedReason: "inbound-route",
    });

    const released = detachRouteBookkeepingSubscriptions({
      accountId: "main",
      pattern: PHONE,
      targetAgent: "nba-front-user",
      channel: "whatsapp",
    });

    expect(released.detached).toBe(0);
    expect(findSessionByAttachedChat(chat.id)?.sessionKey).toContain("michael-test");
  });
});
