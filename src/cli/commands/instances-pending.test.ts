import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getContact, listAccountPending, saveAccountPending } from "../../contacts.js";
import { nats } from "../../nats.js";
import { loadRouterConfig, matchRoute } from "../../router/index.js";
import { dbCreateAgent, dbCreateRoute, dbGetRoute, dbListRoutes, dbUpsertInstance } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { InstancesPendingCommands, RoutesCommands } from "./instances.js";

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
