import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  getContact,
  getContactDetails,
  listAccountPending,
  resolvePlatformIdentity,
  saveAccountPending,
  upsertAgentPlatformIdentity,
  upsertContactFromPlatformIdentity,
} from "../../contacts.js";
import { nats } from "../../nats.js";
import { loadRouterConfig, matchRoute } from "../../router/index.js";
import { dbCreateAgent, dbCreateRoute, dbGetRoute, dbListRoutes, dbUpsertInstance } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { InstancesPendingCommands, RoutesCommands } from "./instances.js";
import { ContactsCommands } from "./contacts.js";

let stateDir: string | null = null;
const instance = "pending-review-test";
const agent = "pending-review-agent";
let emitSpy: ReturnType<typeof spyOn>;

function quietly<T>(run: () => T): T {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    return run();
  } finally {
    log.mockRestore();
  }
}

function pendingGroup(chatId: string, phone = chatId) {
  saveAccountPending(instance, phone, { chatId, isGroup: true });
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-pending-review-test-");
  emitSpy = spyOn(nats, "emit").mockResolvedValue(undefined);
  dbCreateAgent({ id: agent, cwd: stateDir });
  dbUpsertInstance({ name: instance, channel: "slack", agent, groupPolicy: "allowlist" });
});

afterEach(async () => {
  emitSpy?.mockRestore();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("pending chat approval", () => {
  it.each(["C0C8470DCGM", "c0c8470dcgm", "group:c0c8470dcgm"])(
    "approves Slack by %s and resolves the persisted route explicitly",
    (ref) => {
      pendingGroup("C0C8470DCGM");
      const commands = new InstancesPendingCommands();
      const listed = quietly(() => commands.list(instance, true));
      expect(listed.chats[0].routePattern).toBe("group:c0c8470dcgm");

      const approved = quietly(() => commands.approve(instance, ref, agent, true));
      expect(approved).toMatchObject({
        reviewKind: "chat",
        routePattern: "group:c0c8470dcgm",
        routeCreated: true,
        removedPending: true,
      });
      expect(listAccountPending(instance)).toEqual([]);
      expect(dbGetRoute("group:08470", instance)).toBeNull();

      // Use the same real resolver and explicit-route predicate as Slack's gate.
      const matched = matchRoute(loadRouterConfig(), {
        phone: "U0TEST",
        groupId: "C0C8470DCGM",
        isGroup: true,
        accountId: instance,
        channel: "slack",
      });
      const explicitRoute = Boolean(matched?.route && matched.route.pattern !== "*");
      expect(explicitRoute).toBe(true);
      expect(matched?.route?.pattern).toBe("group:c0c8470dcgm");

      const explained = quietly(() => new RoutesCommands().explain(instance, "group:C0C8470DCGM", "slack", true));
      expect(explained.liveEffect).toMatchObject({
        verified: true,
        winningPattern: "group:c0c8470dcgm",
        winningAgent: agent,
      });

      const repeated = quietly(() => commands.approve(instance, "group:C0C8470DCGM", agent, true));
      expect(repeated).toMatchObject({ routePattern: "group:c0c8470dcgm", routeCreated: false });
      expect(dbListRoutes(instance)).toHaveLength(1);
    },
  );

  it("does not confuse different Slack ids with the same digits", () => {
    pendingGroup("C0A8470B");
    pendingGroup("C0C8470DCGM");

    quietly(() => new InstancesPendingCommands().approve(instance, "c0c8470dcgm", agent, true));

    expect(dbGetRoute("group:c0c8470dcgm", instance)?.agent).toBe(agent);
    expect(listAccountPending(instance).map((entry) => entry.chatId)).toEqual(["C0A8470B"]);
    expect(dbGetRoute("group:c0a8470b", instance)).toBeNull();
  });

  it("preserves opaque ids even when they have no digits or only the pending key", () => {
    saveAccountPending(instance, "CGENERAL", { isGroup: true });

    const result = quietly(() => new InstancesPendingCommands().approve(instance, "cgeneral", agent, true));

    expect(result).toMatchObject({ routePattern: "group:cgeneral", removedPending: true });
  });

  it("repairs an explicit chat approval without guessing or deleting legacy routes", () => {
    dbCreateRoute({ accountId: instance, pattern: "group:08470", agent, channel: "slack" });

    // The old approve already consumed the pending entry; use the original full id.
    const result = quietly(() => new InstancesPendingCommands().approve(instance, "group:C0C8470DCGM", agent, true));

    expect(result).toMatchObject({ routePattern: "group:c0c8470dcgm", routeCreated: true });
    expect(dbGetRoute("group:c0c8470dcgm", instance)?.agent).toBe(agent);
    expect(dbGetRoute("group:08470", instance)?.agent).toBe(agent);
  });

  it.each([
    ["120363000000001@g.us", "group:120363000000001"],
    ["123456-789@g.us", "group:123456-789"],
    ["120363000000001", "group:120363000000001"],
    ["group:120363000000001", "group:120363000000001"],
  ])("keeps WhatsApp group normalization for %s", (chatId, pattern) => {
    dbUpsertInstance({ name: instance, channel: "whatsapp", agent, groupPolicy: "allowlist" });
    pendingGroup(chatId);

    const result = quietly(() => new InstancesPendingCommands().approve(instance, chatId, agent, true));

    expect(result).toMatchObject({ reviewKind: "chat", routePattern: pattern, removedPending: true });
    expect(dbGetRoute(pattern, instance)?.agent).toBe(agent);
  });

  it("keeps WhatsApp phone approvals and formatted-number lookup", () => {
    dbUpsertInstance({ name: instance, channel: "whatsapp", agent, dmPolicy: "pairing" });
    saveAccountPending(instance, "5511999991234", { chatId: "5511999991234@s.whatsapp.net" });

    const result = quietly(() =>
      new InstancesPendingCommands().approve(instance, "+55 (11) 99999-1234", undefined, true),
    );

    expect(result).toMatchObject({ reviewKind: "contact", removedPending: true });
    expect(getContact("5511999991234")?.status).toBe("allowed");
    expect(dbListRoutes(instance)).toEqual([]);
  });
});

describe("pending Slack contact approval", () => {
  const userId = "U0ABC4D44EF";

  it("approves an already queued unknown Slack user without manufacturing a phone identity", () => {
    saveAccountPending(instance, userId, { name: "Pending Person", chatId: "D0TESTDM" });

    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      new ContactsCommands().pending(instance);
      const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(output).toContain(`slack ${userId}`);
      expect(output).not.toContain(`phone ${userId}`);
    } finally {
      log.mockRestore();
    }

    const commands = new InstancesPendingCommands();
    const approved = quietly(() => commands.approve(instance, userId, undefined, true));
    expect(approved).toMatchObject({ reviewKind: "contact", removedPending: true });
    const identity = resolvePlatformIdentity({ channel: "slack", instanceId: instance, platformUserId: userId });
    expect(identity).toMatchObject({
      ownerType: "contact",
      channel: "slack",
      instanceId: instance,
      platformUserId: userId,
    });
    const details = getContactDetails(identity!.ownerId!);
    expect(details?.contact).toMatchObject({ displayName: "Pending Person", primaryPhone: null });
    expect(details?.policy?.status).toBe("allowed");
    expect(details?.platformIdentities).toHaveLength(1);
    expect(getContact("0444")).toBeNull();
    expect(listAccountPending(instance)).toEqual([]);

    quietly(() => commands.approve(instance, userId.toLowerCase(), undefined, true));
    expect(resolvePlatformIdentity({ channel: "slack", instanceId: instance, platformUserId: userId })?.ownerId).toBe(
      identity!.ownerId,
    );
    expect(getContactDetails(identity!.ownerId!)?.platformIdentities).toHaveLength(1);
    expect(
      resolvePlatformIdentity({ channel: "slack", instanceId: instance, platformUserId: userId.toLowerCase() }),
    ).toBeNull();
  });

  it("does not approve a different workspace or a phone sharing the Slack id digits", () => {
    const foreign = upsertContactFromPlatformIdentity({
      channel: "slack",
      instanceId: "other-workspace",
      platformUserId: userId,
      name: "Other Person",
      status: "pending",
    });
    const phone = upsertContactFromPlatformIdentity({
      channel: "phone",
      platformUserId: "0444",
      name: "Phone Person",
      status: "pending",
    });
    saveAccountPending(instance, userId, { name: "Local Person", chatId: "D0TESTDM" });

    quietly(() => new InstancesPendingCommands().approve(instance, userId, undefined, true));

    const local = resolvePlatformIdentity({ channel: "slack", instanceId: instance, platformUserId: userId });
    expect(local?.ownerType).toBe("contact");
    expect(local?.ownerId).not.toBe(foreign.id);
    expect(local?.ownerId).not.toBe(phone.id);
    expect(getContactDetails(local!.ownerId!)?.policy?.status).toBe("allowed");
    expect(getContact(foreign.id)?.status).toBe("pending");
    expect(getContact(phone.id)?.status).toBe("pending");
    expect(listAccountPending(instance)).toEqual([]);
  });

  it("keeps an agent-owned Slack identity out of human approval and preserves its pending entry", () => {
    const identity = upsertAgentPlatformIdentity({
      agentId: agent,
      channel: "slack",
      instanceId: instance,
      platformUserId: userId,
    });
    saveAccountPending(instance, userId, { name: "Agent", chatId: "D0TESTDM" });

    expect(() => quietly(() => new InstancesPendingCommands().approve(instance, userId, undefined, true))).toThrow();

    expect(resolvePlatformIdentity({ channel: "slack", instanceId: instance, platformUserId: userId })).toMatchObject({
      id: identity.id,
      ownerType: "agent",
      ownerId: agent,
    });
    expect(getContact("0444")).toBeNull();
    expect(listAccountPending(instance)).toHaveLength(1);
  });

  it("reuses the configured instance alias and the pending sender when approved by DM id", () => {
    const instanceAlias = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
    dbUpsertInstance({ name: instance, instanceId: instanceAlias, channel: "slack", agent });
    const contact = upsertContactFromPlatformIdentity({
      channel: "slack",
      instanceId: instance,
      platformUserId: userId,
      name: "Known Person",
      status: "pending",
    });
    saveAccountPending(instance, userId, { name: "Pending Person", chatId: "D0TESTDM" });

    quietly(() => new InstancesPendingCommands().approve(instance, "D0TESTDM", undefined, true));

    expect(getContact(contact.id)).toMatchObject({ name: "Known Person", status: "allowed" });
    expect(getContactDetails(contact.id)?.platformIdentities).toHaveLength(1);
    expect(resolvePlatformIdentity({ channel: "slack", instanceId: instanceAlias, platformUserId: userId })).toBeNull();
    expect(getContact("0444")).toBeNull();
    expect(listAccountPending(instance)).toEqual([]);
  });

  it("rejects conflicting owners across configured Slack instance aliases without changing either policy", () => {
    const instanceAlias = "aaaaaaaa-bbbb-cccc-dddd-111111111111";
    dbUpsertInstance({ name: instance, instanceId: instanceAlias, channel: "slack", agent });
    const contacts = [instance, instanceAlias].map((instanceId) =>
      upsertContactFromPlatformIdentity({ channel: "slack", instanceId, platformUserId: userId, status: "pending" }),
    );
    saveAccountPending(instance, userId, { chatId: "D0TESTDM" });

    expect(() => quietly(() => new InstancesPendingCommands().approve(instance, userId, undefined, true))).toThrow();

    expect(contacts.map((contact) => getContact(contact.id)?.status)).toEqual(["pending", "pending"]);
    expect(listAccountPending(instance)).toHaveLength(1);
    expect(getContact("0444")).toBeNull();
  });
});
