import { afterEach, describe, expect, it } from "bun:test";
import { dbUpsertChat, type ChannelConfig, type InstanceConfig } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { RouteConfig, RouterConfig } from "../../router/types.js";
import { resolveRouteSeededSlackChat } from "./route-seeded-chat.js";

function slackChannel(name: string): ChannelConfig {
  return { name, provider: "slack", enabled: true, createdAt: 1, updatedAt: 1 };
}

function route(pattern: string, accountId: string, extra: Partial<RouteConfig> = {}): RouteConfig {
  return { pattern, accountId, agent: "main", session: "fixed-session", ...extra };
}

function config(routes: RouteConfig[], instances: Record<string, InstanceConfig> = {}) {
  return {
    routes,
    instances,
    instanceToAccount: {},
    channels: {
      "workspace-a": slackChannel("workspace-a"),
      "workspace-b": slackChannel("workspace-b"),
      zap: { name: "zap", provider: "whatsapp", enabled: true, createdAt: 1, updatedAt: 1 },
    },
  } satisfies Pick<RouterConfig, "routes" | "instances" | "instanceToAccount" | "channels">;
}

describe("resolveRouteSeededSlackChat", () => {
  it("seeds a routed private channel on its Slack account", () => {
    const seed = resolveRouteSeededSlackChat(config([route("group:C0PRIVATE1", "workspace-a")]), "C0PRIVATE1");
    expect(seed).toEqual({ instanceId: "workspace-a", platformChatId: "C0PRIVATE1", chatType: "group" });
  });

  it("accepts the group: form of the ref", () => {
    const seed = resolveRouteSeededSlackChat(config([route("group:C0PRIVATE1", "workspace-a")]), "group:C0PRIVATE1");
    expect(seed?.platformChatId).toBe("C0PRIVATE1");
  });

  it("uses the configured instance id when the account maps to one", () => {
    const instance: InstanceConfig = {
      name: "workspace-a",
      instanceId: "11111111-2222-3333-4444-555555555555",
      channel: "slack",
      dmPolicy: "open",
      groupPolicy: "open",
      contactIntakeMode: "pending",
      createdAt: 1,
      updatedAt: 1,
    };
    const seed = resolveRouteSeededSlackChat(
      config([route("group:C0PRIVATE1", "workspace-a")], { "workspace-a": instance }),
      "C0PRIVATE1",
    );
    expect(seed?.instanceId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("does not seed without an exact group route for that channel", () => {
    expect(resolveRouteSeededSlackChat(config([route("group:*", "workspace-a")]), "C0PRIVATE1")).toBeNull();
    expect(resolveRouteSeededSlackChat(config([route("C0PRIVATE1", "workspace-a")]), "C0PRIVATE1")).toBeNull();
    expect(resolveRouteSeededSlackChat(config([]), "C0PRIVATE1")).toBeNull();
  });

  it("does not seed refs that are not Slack channel ids or routes on other providers", () => {
    expect(resolveRouteSeededSlackChat(config([route("group:C0PRIVATE1", "zap")]), "C0PRIVATE1")).toBeNull();
    expect(
      resolveRouteSeededSlackChat(
        config([route("group:C0PRIVATE1", "workspace-a", { channel: "whatsapp" })]),
        "C0PRIVATE1",
      ),
    ).toBeNull();
    expect(resolveRouteSeededSlackChat(config([route("D0DIRECT01", "workspace-a")]), "D0DIRECT01")).toBeNull();
    expect(resolveRouteSeededSlackChat(config([route("group:C0PRIVATE1", "workspace-a")]), "chat_123")).toBeNull();
  });

  it("does not seed through a disabled legacy Slack instance", () => {
    const instance: InstanceConfig = {
      name: "legacy-slack",
      channel: "slack",
      enabled: false,
      dmPolicy: "open",
      groupPolicy: "open",
      contactIntakeMode: "pending",
      createdAt: 1,
      updatedAt: 1,
    };
    const seed = resolveRouteSeededSlackChat(
      config([route("group:C0PRIVATE1", "legacy-slack")], { "legacy-slack": instance }),
      "C0PRIVATE1",
    );
    expect(seed).toBeNull();
    expect(
      resolveRouteSeededSlackChat(
        config([route("group:C0PRIVATE1", "legacy-slack")], { "legacy-slack": { ...instance, enabled: true } }),
        "C0PRIVATE1",
      ),
    ).not.toBeNull();
  });

  it("refuses when routes on two Slack accounts name the same channel id", () => {
    const routes = [route("group:C0PRIVATE1", "workspace-a"), route("group:C0PRIVATE1", "workspace-b")];
    expect(resolveRouteSeededSlackChat(config(routes), "C0PRIVATE1")).toBeNull();
  });
});

describe("route-seeded Slack chat identity", () => {
  let stateDir: string | null = null;
  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("is the chat the first Socket Mode inbound upserts", async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-route-seed-");
    const seed = resolveRouteSeededSlackChat(config([route("group:C0PRIVATE1", "workspace-a")]), "C0PRIVATE1");
    if (!seed) throw new Error("expected a seed");
    const seeded = dbUpsertChat({
      channel: "slack",
      instanceId: seed.instanceId,
      platformChatId: seed.platformChatId,
      chatType: seed.chatType,
      title: seed.platformChatId,
      rawProvenance: { source: "ravi.sessions.attach" },
    });
    // Same identity fields `SlackSocketModeService.routeMessage` passes for a private channel message.
    const inbound = dbUpsertChat({
      channel: "slack",
      instanceId: "workspace-a",
      platformChatId: "C0PRIVATE1",
      chatType: "group",
      title: "C0PRIVATE1",
      rawProvenance: { source: "slack.socket_mode" },
    });
    expect(inbound.id).toBe(seeded.id);
  });
});
