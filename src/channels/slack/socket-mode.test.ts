import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  createContact,
  ensureContactFromInbound,
  linkContactIdentity,
  resolvePlatformIdentity,
  upsertAgentPlatformIdentity,
} from "../../contacts.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { canWithCapabilities } from "../../permissions/provider-runtime.js";
import {
  attachChatToSession,
  getOrCreateSession,
  getSessionByName,
  listSessionSubscriptions,
} from "../../router/index.js";
import type { AgentConfig } from "../../router/index.js";
import {
  dbFindChatMessage,
  dbGetChat,
  dbGetContext,
  dbListChatParticipants,
  dbUpsertChat,
  getDb,
} from "../../router/router-db.js";
import type { InstanceConfig } from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import type { MessageContext, MessageTarget, RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import {
  buildRuntimeRequestContext,
  refreshRuntimeRequestContextForTurn,
} from "../../runtime/runtime-request-context.js";
import type { TaskRuntimeResolution } from "../../tasks/types.js";
import {
  SlackAssistantThreadPresence,
  SlackPresenceStack,
  SlackReactionPresence,
  SlackSocketModeService,
  SlackTextDelivery,
  createSlackNativeRuntimesFromEnv,
  slackClientMessageId,
} from "./socket-mode.js";
import type { SlackRoutingPolicy, SlackSocketEnvelope } from "./types.js";

let stateDir: string | null = null;

function seedAgent(id: string, cwd: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `
      INSERT INTO agents (id, name, cwd, dm_scope, created_at, updated_at)
      VALUES (?, ?, ?, 'per-peer', ?, ?)
      ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at
      `,
    )
    .run(id, id, cwd, now, now);
}

function slackChannel(input: {
  name: string;
  credentialConnection?: string;
  enabled?: boolean;
  defaults?: Record<string, unknown>;
}) {
  return {
    name: input.name,
    provider: "slack",
    enabled: input.enabled ?? true,
    ...(input.credentialConnection ? { credentialConnection: input.credentialConnection } : {}),
    ...(input.defaults ? { defaults: input.defaults } : {}),
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Slack Socket Mode routing", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-socket-mode-");
    seedAgent("ravi-hil", "/tmp/ravi-hil");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("scopes native text delivery to the configured Slack workspace", () => {
    const delivery = new SlackTextDelivery({} as never, {} as never, {
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      instanceId: "0bc9635c-1ee9-42e3-9112-95be9cdb0334",
      connection: "ravi-rbbt-slack",
    });

    expect(
      delivery.supports({
        channel: "slack",
        accountId: "0bc9635c-1ee9-42e3-9112-95be9cdb0334",
        instanceId: "0bc9635c-1ee9-42e3-9112-95be9cdb0334",
        chatId: "C123",
      }),
    ).toBe(true);
    expect(
      delivery.supports({
        channel: "slack",
        accountId: "hana-slack",
        instanceId: "hana-slack",
        chatId: "C456",
      }),
    ).toBe(false);
  });

  it("uses a stable UUID client_msg_id and preserves Slack's provider timestamp", async () => {
    const postMessage = mock(async () => ({
      channel: "C123",
      ts: "1713000000.000100",
      messageId: "slack:C123:1713000000.000100",
      raw: { ok: true },
    }));
    const delivery = new SlackTextDelivery({ postMessage } as never, { threadReplyMode: "thread" } as never);
    const idempotencyKey = "runtime:ravi-channels:emit_1:slack:T1:C123:thread";

    const result = await delivery.deliverText({
      sessionName: "ravi-channels",
      emitId: "emit_1",
      idempotencyKey,
      target: {
        channel: "slack",
        accountId: "T1",
        chatId: "C123",
        threadId: "1712999999.000010",
      },
      text: "hello Slack",
    });

    const clientMsgId = slackClientMessageId(idempotencyKey);
    expect(clientMsgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(slackClientMessageId(idempotencyKey)).toBe(clientMsgId);
    expect(slackClientMessageId(`${idempotencyKey}:other`)).not.toBe(clientMsgId);
    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "hello Slack",
      threadTs: "1712999999.000010",
      clientMsgId,
    });
    expect(result).toEqual({
      provider: "slack",
      messageId: "slack:C123:1713000000.000100",
      platformMessageId: "1713000000.000100",
      providerTimestamp: 1_713_000_000_000,
      raw: { ok: true },
    });
  });

  it("discovers all configured Slack channels without connection env overrides", async () => {
    const resolveSecret = mock(async ({ connection }: { connection: string }) => ({
      secret: JSON.stringify({
        appToken: `xapp-${connection}`,
        botToken: `xoxb-${connection}`,
      }),
      connection: { connection },
    }));

    const runtimes = await createSlackNativeRuntimesFromEnv({} as NodeJS.ProcessEnv, {
      resolveSecret,
      channels: {
        "ravi-rbbt-slack": slackChannel({
          name: "ravi-rbbt-slack",
          credentialConnection: "rbbt-secret",
        }),
        "hana-slack": slackChannel({
          name: "hana-slack",
          credentialConnection: "hana-secret",
        }),
      },
    });

    expect(resolveSecret.mock.calls.map((call) => call[0].connection)).toEqual(["hana-secret", "rbbt-secret"]);
    expect(runtimes.map((runtime) => runtime.accountId)).toEqual(["hana-slack", "ravi-rbbt-slack"]);
    expect(runtimes.map((runtime) => runtime.connection)).toEqual(["hana-secret", "rbbt-secret"]);
  });

  it("keeps bot alias defaults isolated per configured Slack account", async () => {
    const resolveSecret = mock(async ({ connection }: { connection: string }) => ({
      secret: JSON.stringify({ appToken: `xapp-${connection}`, botToken: `xoxb-${connection}` }),
      connection: { connection },
    }));

    const runtimes = await createSlackNativeRuntimesFromEnv({} as NodeJS.ProcessEnv, {
      resolveSecret,
      channels: {
        "ravi-rbbt-slack": slackChannel({
          name: "ravi-rbbt-slack",
          credentialConnection: "rbbt-secret",
          defaults: { botMessageAliasesByChat: { CDEMO: ["Ravi"] } },
        }),
        "hana-slack": slackChannel({
          name: "hana-slack",
          credentialConnection: "hana-secret",
          defaults: { botMessageAliasesByChat: { CDEMO: ["Hana"] } },
        }),
      },
    });

    const policies = Object.fromEntries(
      runtimes.map((runtime) => [
        runtime.accountId,
        (runtime.socketMode as unknown as { routingPolicy: { botMessageAliasesByChat: unknown } }).routingPolicy
          .botMessageAliasesByChat,
      ]),
    );
    expect(policies).toEqual({
      "hana-slack": { CDEMO: ["Hana"] },
      "ravi-rbbt-slack": { CDEMO: ["Ravi"] },
    });
  });

  it("routes Slack channels through group routes and attaches the source chat for output", async () => {
    const config: RouterConfig = {
      agents: {
        "ravi-hil": {
          id: "ravi-hil",
          cwd: "/tmp/ravi-hil",
          dmScope: "per-peer",
        },
      },
      routes: [
        {
          pattern: "group:C123",
          accountId: "ravi-rbbt-slack",
          agent: "ravi-hil",
          session: "ravi-hil",
          priority: 100,
          policy: "open",
          channel: "slack",
        },
      ],
      defaultAgent: "ravi-hil",
      defaultDmScope: "per-peer",
      accountAgents: { "ravi-rbbt-slack": "ravi-hil" },
      instanceToAccount: {},
      instances: {},
    };
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      instanceId: "slack-instance-1",
      getRouterConfig: () => config,
      publishPrompt: async (sessionName, payload) => {
        published.push({ sessionName, payload });
      },
      webClient: {} as never,
    });
    const envelope: SlackSocketEnvelope = {
      envelope_id: "env-1",
      payload: {
        team_id: "T1",
        event_id: "Ev1",
        event_time: 1_713_000_000,
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "ravi?",
          ts: "1713000000.000100",
        },
      },
    };

    await service.handleEnvelope(envelope);

    expect(published).toHaveLength(1);
    expect(published[0]?.sessionName).toBe("ravi-hil");
    expect(published[0]?.payload).toMatchObject({
      deliveryBarrier: "after_tool",
      deliveryBarrierSource: "default",
      source: {
        channel: "slack",
        accountId: "ravi-rbbt-slack",
        instanceId: "slack-instance-1",
        chatId: "C123",
      },
    });
    expect(
      (published[0]?.payload.source as { suppressPresence?: boolean } | undefined)?.suppressPresence,
    ).toBeUndefined();

    const canonicalChatId = (published[0]?.payload.source as { canonicalChatId?: string } | undefined)?.canonicalChatId;
    expect(typeof canonicalChatId).toBe("string");
    expect(dbGetChat(canonicalChatId!)).toMatchObject({
      channel: "slack",
      instanceId: "slack-instance-1",
      platformChatId: "C123",
    });
    const session = getSessionByName("ravi-hil");
    expect(typeof session?.sessionKey).toBe("string");
    expect(listSessionSubscriptions(session!.sessionKey)).toEqual([
      expect.objectContaining({
        chatId: canonicalChatId,
        role: "primary",
        speechMode: "speak",
      }),
    ]);
  });

  it("routes Slack inbound to an existing chat subscription when no route matches", async () => {
    seedAgent("route-agent", "/tmp/route-agent");
    seedAgent("owner-agent", "/tmp/owner-agent");
    const chat = dbUpsertChat({
      channel: "slack",
      instanceId: "ravi-rbbt-slack",
      platformChatId: "C123",
      chatType: "group",
      title: "C123",
      rawProvenance: { source: "test" },
      seenAt: 1_713_000_000_000,
    });
    const ownerSession = getOrCreateSession(
      "agent:owner-agent:slack:ravi-rbbt-slack:group:C123",
      "owner-agent",
      "/tmp/owner-agent",
      {
        name: "owner-agent",
        channel: "slack",
        accountId: "ravi-rbbt-slack",
        groupId: "C123",
        lastChannel: "slack",
        lastTo: "C123",
        lastAccountId: "ravi-rbbt-slack",
      },
    );
    attachChatToSession({
      sessionKey: ownerSession.sessionKey,
      chatId: chat.id,
      role: "primary",
      attachedByType: "system",
      attachedReason: "test-owner",
      speechMode: "speak",
      setOutputTarget: true,
    });

    const config: RouterConfig = {
      agents: {
        "route-agent": {
          id: "route-agent",
          cwd: "/tmp/route-agent",
          dmScope: "per-peer",
        },
        "owner-agent": {
          id: "owner-agent",
          cwd: "/tmp/owner-agent",
          dmScope: "per-peer",
        },
      },
      routes: [],
      defaultAgent: "route-agent",
      defaultDmScope: "per-peer",
      accountAgents: {},
      instanceToAccount: { "ravi-rbbt-slack": "ravi-rbbt-slack" },
      instances: {},
    };
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      instanceId: "ravi-rbbt-slack",
      getRouterConfig: () => config,
      publishPrompt: async (sessionName, payload) => {
        published.push({ sessionName, payload });
      },
      webClient: {} as never,
    });

    await service.handleEnvelope({
      envelope_id: "env-subscription-owner-1",
      payload: {
        team_id: "T1",
        event_id: "Ev1",
        event_time: 1_713_000_001,
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "still here?",
          ts: "1713000001.000100",
        },
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.sessionName).toBe("owner-agent");
    expect(getSessionByName("route-agent")).toBeNull();
    expect(listSessionSubscriptions(ownerSession.sessionKey)).toEqual([
      expect.objectContaining({
        chatId: chat.id,
        role: "primary",
        speechMode: "speak",
      }),
    ]);
  });

  it("publishes Block Kit interactions as native inbound interaction events", async () => {
    const order: string[] = [];
    const prompts: unknown[] = [];
    const interactions: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const service = new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      instanceId: "slack-instance-1",
      getRouterConfig: () => ({
        agents: {},
        routes: [],
        defaultAgent: "ravi-hil",
        defaultDmScope: "per-peer",
        accountAgents: {},
        instanceToAccount: {},
        instances: {},
      }),
      publishPrompt: async (_sessionName, payload) => {
        prompts.push(payload);
      },
      publishInteraction: async (topic, payload) => {
        order.push("publish");
        interactions.push({ topic, payload });
      },
      webClient: {} as never,
    });

    const result = await service.handleEnvelope(
      {
        envelope_id: "env-block-actions-1",
        payload: {
          type: "block_actions",
          team: { id: "T1" },
          user: { id: "U123" },
          channel: { id: "C123" },
          trigger_id: "trigger-1",
          container: {
            type: "message",
            channel_id: "C123",
            message_ts: "1713000000.000100",
          },
          message: {
            ts: "1713000000.000100",
            thread_ts: "1713000000.000100",
          },
          response_url: "https://hooks.slack.test/secret",
          actions: [
            {
              type: "button",
              block_id: "ravi_blockkit_actions",
              action_id: "ravi_blockkit_approve",
              value: "approve",
              action_ts: "1713000001.000200",
            },
          ],
        },
      },
      async () => {
        order.push("ack");
      },
    );

    expect(result).toBe("processed");
    expect(order).toEqual(["ack", "publish"]);
    expect(prompts).toHaveLength(0);
    expect(interactions).toEqual([
      {
        topic: "ravi.inbound.interaction",
        payload: expect.objectContaining({
          provider: "slack",
          source: "slack.socket_mode",
          accountId: "ravi-rbbt-slack",
          instanceId: "slack-instance-1",
          envelopeId: "env-block-actions-1",
          interactionType: "block_actions",
          teamId: "T1",
          userId: "U123",
          channelId: "C123",
          messageTs: "1713000000.000100",
          threadTs: "1713000000.000100",
          triggerId: "trigger-1",
          containerType: "message",
          actionId: "ravi_blockkit_approve",
          blockId: "ravi_blockkit_actions",
          actionType: "button",
          value: "approve",
          responseUrlId: expect.any(String),
          responseUrlPresent: true,
          actions: [
            {
              actionId: "ravi_blockkit_approve",
              blockId: "ravi_blockkit_actions",
              type: "button",
              value: "approve",
              actionTs: "1713000001.000200",
            },
          ],
        }),
      },
    ]);
    expect(JSON.stringify(interactions[0]?.payload)).not.toContain("hooks.slack.test");
  });

  it("publishes Slack Work Object link and detail events as inbound interactions", async () => {
    const interactions: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const service = new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      instanceId: "slack-instance-1",
      getRouterConfig: () => ({
        agents: {},
        routes: [],
        defaultAgent: "ravi-hil",
        defaultDmScope: "per-peer",
        accountAgents: {},
        instanceToAccount: {},
        instances: {},
      }),
      publishInteraction: async (topic, payload) => {
        interactions.push({ topic, payload });
      },
      webClient: {} as never,
    });

    await expect(
      service.handleEnvelope({
        envelope_id: "env-link-shared-1",
        payload: {
          team_id: "T1",
          event_id: "EvLinkShared1",
          event: {
            type: "link_shared",
            user: "U123",
            channel: "C123",
            message_ts: "1713000000.000100",
            links: [{ url: "https://example.com/tasks/123", domain: "example.com" }],
          },
        },
      }),
    ).resolves.toBe("processed");

    await expect(
      service.handleEnvelope({
        envelope_id: "env-entity-details-1",
        payload: {
          team_id: "T1",
          event_id: "EvEntityDetails1",
          event: {
            type: "entity_details_requested",
            user: "U123",
            channel: "C123",
            message_ts: "1713000000.000100",
            thread_ts: "1713000000.000100",
            trigger_id: "trigger-entity-1",
            entity_url: "https://example.com/tasks/123",
            app_unfurl_url: "https://example.com/tasks/123?source=slack",
            external_ref: { id: "123", type: "task" },
            link: { url: "https://example.com/tasks/123", domain: "example.com" },
            user_locale: "en-US",
          },
        },
      }),
    ).resolves.toBe("processed");

    await expect(
      service.handleEnvelope({
        envelope_id: "env-entity-details-direct-1",
        payload: {
          type: "entity_details_requested",
          team: { id: "T1" },
          user: "U123",
          channel: "C123",
          message_ts: "1713000000.000100",
          trigger_id: "trigger-entity-direct-1",
          entity_url: "https://example.com/tasks/123",
          external_ref: { id: "123", type: "task" },
        },
      }),
    ).resolves.toBe("processed");

    expect(interactions).toHaveLength(3);
    expect(interactions[0]).toMatchObject({
      topic: "ravi.inbound.interaction",
      payload: {
        provider: "slack",
        source: "slack.socket_mode",
        accountId: "ravi-rbbt-slack",
        instanceId: "slack-instance-1",
        envelopeId: "env-link-shared-1",
        eventId: "EvLinkShared1",
        interactionType: "link_shared",
        teamId: "T1",
        userId: "U123",
        channelId: "C123",
        messageTs: "1713000000.000100",
        linkCount: 1,
        links: [{ url: "https://example.com/tasks/123", domain: "example.com" }],
      },
    });
    expect(interactions[1]).toMatchObject({
      topic: "ravi.inbound.interaction",
      payload: {
        provider: "slack",
        interactionType: "entity_details_requested",
        envelopeId: "env-entity-details-1",
        eventId: "EvEntityDetails1",
        channelId: "C123",
        messageTs: "1713000000.000100",
        threadTs: "1713000000.000100",
        triggerId: "trigger-entity-1",
        entityUrl: "https://example.com/tasks/123",
        appUnfurlUrl: "https://example.com/tasks/123?source=slack",
        userLocale: "en-US",
        externalRef: { id: "123", type: "task" },
        link: { url: "https://example.com/tasks/123", domain: "example.com" },
      },
    });
    expect(interactions[2]).toMatchObject({
      topic: "ravi.inbound.interaction",
      payload: {
        provider: "slack",
        interactionType: "entity_details_requested",
        envelopeId: "env-entity-details-direct-1",
        teamId: "T1",
        channelId: "C123",
        messageTs: "1713000000.000100",
        triggerId: "trigger-entity-direct-1",
        entityUrl: "https://example.com/tasks/123",
        externalRef: { id: "123", type: "task" },
      },
    });
  });

  it("forks Slack thread replies from a forced route session", async () => {
    getOrCreateSession("ravi-hil", "ravi-hil", "/tmp/ravi-hil", { name: "ravi-hil" });
    const config: RouterConfig = {
      agents: {
        "ravi-hil": {
          id: "ravi-hil",
          cwd: "/tmp/ravi-hil",
          dmScope: "per-peer",
        },
      },
      routes: [
        {
          pattern: "group:C123",
          accountId: "ravi-rbbt-slack",
          agent: "ravi-hil",
          session: "ravi-hil",
          priority: 100,
          policy: "open",
          channel: "slack",
        },
      ],
      defaultAgent: "ravi-hil",
      defaultDmScope: "per-peer",
      accountAgents: { "ravi-rbbt-slack": "ravi-hil" },
      instanceToAccount: {},
      instances: {},
    };
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const inboundEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const service = new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      instanceId: "slack-instance-1",
      getRouterConfig: () => config,
      publishPrompt: async (sessionName, payload) => {
        published.push({ sessionName, payload });
      },
      publishInteraction: async (topic, payload) => {
        inboundEvents.push({ topic, payload });
      },
      webClient: {} as never,
    });

    await service.handleEnvelope({
      envelope_id: "env-thread-1",
      payload: {
        team_id: "T1",
        event_id: "EvThread1",
        event_time: 1_713_000_030,
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "vamos aprofundar aqui",
          ts: "1713000030.000200",
          thread_ts: "1713000000.000100",
        },
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.sessionName).toBe("ravi-hil-t-1713000000000100");
    expect(published[0]?.payload.source).toMatchObject({
      channel: "slack",
      chatId: "C123",
      threadId: "1713000000.000100",
    });

    const parent = getSessionByName("ravi-hil");
    expect(parent?.sessionKey).toBe("ravi-hil");
    const child = getSessionByName("ravi-hil-t-1713000000000100");
    expect(child?.sessionKey).toBe("ravi-hil:thread:1713000000.000100");

    const canonicalChatId = (published[0]?.payload.source as { canonicalChatId?: string } | undefined)?.canonicalChatId;
    expect(typeof canonicalChatId).toBe("string");
    expect(dbGetChat(canonicalChatId!)).toMatchObject({
      channel: "slack",
      instanceId: "slack-instance-1",
      platformChatId: "C123#1713000000.000100",
      chatType: "thread",
    });
    expect(listSessionSubscriptions(child!.sessionKey)).toEqual([
      expect.objectContaining({
        chatId: canonicalChatId,
        role: "primary",
        speechMode: "speak",
      }),
    ]);
    expect(inboundEvents).toEqual([
      {
        topic: "ravi.inbound.thread.created",
        payload: expect.objectContaining({
          provider: "slack",
          eventType: "thread.created",
          accountId: "ravi-rbbt-slack",
          routeAccountId: "ravi-rbbt-slack",
          instanceId: "slack-instance-1",
          teamId: "T1",
          channelId: "C123",
          channelType: "channel",
          peerKind: "group",
          userId: "U123",
          messageTs: "1713000030.000200",
          sourceMessageTs: "1713000030.000200",
          threadTs: "1713000000.000100",
          canonicalChatId,
          sessionKey: "ravi-hil:thread:1713000000.000100",
          sessionName: "ravi-hil-t-1713000000000100",
          agentId: "ravi-hil",
          routePattern: "group:C123",
          routeSession: "ravi-hil",
          envelopeId: "env-thread-1",
          eventId: "EvThread1",
          eventTimeMs: 1_713_000_030_000,
        }),
      },
    ]);

    await service.handleEnvelope({
      envelope_id: "env-thread-2",
      payload: {
        team_id: "T1",
        event_id: "EvThread2",
        event_time: 1_713_000_031,
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "segunda mensagem",
          ts: "1713000031.000300",
          thread_ts: "1713000000.000100",
        },
      },
    });

    expect(published).toHaveLength(2);
    expect(published[1]?.sessionName).toBe("ravi-hil-t-1713000000000100");
    expect(inboundEvents).toHaveLength(1);
  });

  it("uses a temporary Slack reaction as the native working presence indicator", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const presence = new SlackReactionPresence(
      {
        addReaction: async (input: Record<string, unknown>) => {
          calls.push({ method: "add", input });
          return { ok: true };
        },
        removeReaction: async (input: Record<string, unknown>) => {
          calls.push({ method: "remove", input });
          return { ok: true };
        },
      } as never,
      { reactionName: "hourglass_flowing_sand" },
    );
    const target = {
      channel: "slack",
      accountId: "ravi-rbbt-slack",
      chatId: "C123",
      sourceMessageId: "1713000000.000100",
    };

    await presence.sendPresence({ sessionName: "ravi-hil", target, active: true });
    await presence.sendPresence({ sessionName: "ravi-hil", target, active: true });
    await presence.sendPresence({ sessionName: "ravi-hil", target, active: false });

    expect(calls).toEqual([
      {
        method: "add",
        input: {
          channel: "C123",
          timestamp: "1713000000.000100",
          name: "hourglass_flowing_sand",
        },
      },
      {
        method: "remove",
        input: {
          channel: "C123",
          timestamp: "1713000000.000100",
          name: "hourglass_flowing_sand",
        },
      },
    ]);
  });

  it("clears Slack reaction presence even when local active state was lost", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const presence = new SlackReactionPresence(
      {
        addReaction: async (input: Record<string, unknown>) => {
          calls.push({ method: "add", input });
          return { ok: true };
        },
        removeReaction: async (input: Record<string, unknown>) => {
          calls.push({ method: "remove", input });
          return { ok: true };
        },
      } as never,
      { reactionName: "hourglass_flowing_sand" },
    );

    const result = await presence.sendPresence({
      sessionName: "ravi-hil",
      target: {
        channel: "slack",
        accountId: "ravi-rbbt-slack",
        chatId: "C123",
        sourceMessageId: "1713000000.000100",
      },
      active: false,
    });

    expect(result).toMatchObject({
      provider: "slack",
      status: "inactive",
      reason: "cleared_without_local_state",
    });
    expect(calls).toEqual([
      {
        method: "remove",
        input: {
          channel: "C123",
          timestamp: "1713000000.000100",
          name: "hourglass_flowing_sand",
        },
      },
    ]);
  });

  it("uses the stable Slack thread as the native working presence indicator", async () => {
    const calls: Record<string, unknown>[] = [];
    const presence = new SlackAssistantThreadPresence(
      {
        setAssistantThreadStatus: async (input: Record<string, unknown>) => {
          calls.push(input);
          return { ok: true };
        },
      } as never,
      { statusText: "is working..." },
    );
    const target = {
      channel: "slack",
      accountId: "ravi-rbbt-slack",
      chatId: "C123",
      threadId: "1713000000.000100",
      sourceMessageId: "1713000040.000200",
      statusAnchorKind: "last_outbound_message" as const,
      statusAnchorMessageId: "1713000060.000300",
    };

    await expect(presence.sendPresence({ sessionName: "ravi-hil", target, active: true })).resolves.toMatchObject({
      provider: "slack",
      status: "active",
    });
    await expect(presence.sendPresence({ sessionName: "ravi-hil", target, active: false })).resolves.toMatchObject({
      provider: "slack",
      status: "inactive",
    });

    expect(calls).toEqual([
      {
        channelId: "C123",
        threadTs: "1713000000.000100",
        status: "is working...",
      },
      {
        channelId: "C123",
        threadTs: "1713000000.000100",
        status: "",
      },
    ]);
  });

  it("uses outbound status anchors as Slack assistant thread ids for root messages", async () => {
    const calls: Record<string, unknown>[] = [];
    const presence = new SlackAssistantThreadPresence({
      setAssistantThreadStatus: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { ok: true };
      },
    } as never);

    await presence.sendPresence({
      sessionName: "ravi-hil",
      target: {
        channel: "slack",
        accountId: "ravi-rbbt-slack",
        chatId: "C123",
        sourceMessageId: "1713000040.000200",
        statusAnchorKind: "last_outbound_message",
        statusAnchorMessageId: "1713000060.000300",
      },
      active: true,
    });

    expect(calls).toEqual([
      {
        channelId: "C123",
        threadTs: "1713000060.000300",
        status: "is working...",
      },
    ]);
  });

  it("does not fall back to reactions when Slack assistant status is unavailable", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const assistantPresence = new SlackAssistantThreadPresence({
      setAssistantThreadStatus: async () => {
        throw new Error("missing_scope");
      },
    } as never);
    const reactionPresence = new SlackReactionPresence({
      addReaction: async (input: Record<string, unknown>) => {
        calls.push({ method: "add", input });
        return { ok: true };
      },
      removeReaction: async (input: Record<string, unknown>) => {
        calls.push({ method: "remove", input });
        return { ok: true };
      },
    } as never);
    const presence = new SlackPresenceStack(assistantPresence, reactionPresence);

    await expect(
      presence.sendPresence({
        sessionName: "ravi-hil",
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "1713000000.000100",
        },
        active: true,
      }),
    ).rejects.toThrow("missing_scope");

    expect(calls).toEqual([]);
  });

  it("uses reactions only when explicitly configured", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const assistantPresence = new SlackAssistantThreadPresence({
      setAssistantThreadStatus: async (input: Record<string, unknown>) => {
        calls.push({ method: "assistant", input });
        return { ok: true };
      },
    } as never);
    const reactionPresence = new SlackReactionPresence({
      addReaction: async (input: Record<string, unknown>) => {
        calls.push({ method: "add", input });
        return { ok: true };
      },
      removeReaction: async (input: Record<string, unknown>) => {
        calls.push({ method: "remove", input });
        return { ok: true };
      },
    } as never);
    const presence = new SlackPresenceStack(assistantPresence, reactionPresence, { reactionMode: "always" });

    await expect(
      presence.sendPresence({
        sessionName: "ravi-hil",
        target: {
          channel: "slack",
          accountId: "ravi-rbbt-slack",
          chatId: "C123",
          sourceMessageId: "1713000000.000100",
        },
        active: true,
      }),
    ).resolves.toMatchObject({
      provider: "slack",
      status: "active",
    });

    expect(calls).toEqual([
      {
        method: "assistant",
        input: {
          channelId: "C123",
          threadTs: "1713000000.000100",
          status: "is working...",
        },
      },
      {
        method: "add",
        input: {
          channel: "C123",
          timestamp: "1713000000.000100",
          name: "hourglass_flowing_sand",
        },
      },
    ]);
  });

  it("does not remove reactions as part of native assistant status clear by default", async () => {
    const calls: Array<{ method: string; input?: Record<string, unknown> }> = [];
    const assistantPresence = new SlackAssistantThreadPresence({
      setAssistantThreadStatus: async (input: Record<string, unknown>) => {
        calls.push({ method: "assistant", input });
        return { ok: true };
      },
    } as never);
    const reactionPresence = new SlackReactionPresence({
      addReaction: async (input: Record<string, unknown>) => {
        calls.push({ method: "add", input });
        return { ok: true };
      },
      removeReaction: async (input: Record<string, unknown>) => {
        calls.push({ method: "remove", input });
        return { ok: true };
      },
    } as never);
    const presence = new SlackPresenceStack(assistantPresence, reactionPresence);

    await presence.sendPresence({
      sessionName: "ravi-hil",
      target: {
        channel: "slack",
        accountId: "ravi-rbbt-slack",
        chatId: "C123",
        sourceMessageId: "1713000000.000100",
      },
      active: false,
    });

    expect(calls).toEqual([
      {
        method: "assistant",
        input: {
          channelId: "C123",
          threadTs: "1713000000.000100",
          status: "",
        },
      },
    ]);
  });

  it("routes Slack audio file_share events as media prompts", async () => {
    const config: RouterConfig = {
      agents: {
        "ravi-hil": {
          id: "ravi-hil",
          cwd: "/tmp/ravi-hil",
          dmScope: "per-peer",
        },
      },
      routes: [
        {
          pattern: "group:C123",
          accountId: "ravi-rbbt-slack",
          agent: "ravi-hil",
          session: "ravi-hil",
          priority: 100,
          policy: "open",
          channel: "slack",
        },
      ],
      defaultAgent: "ravi-hil",
      defaultDmScope: "per-peer",
      accountAgents: { "ravi-rbbt-slack": "ravi-hil" },
      instanceToAccount: {},
      instances: {},
    };
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      instanceId: "slack-instance-1",
      getRouterConfig: () => config,
      publishPrompt: async (sessionName, payload) => {
        published.push({ sessionName, payload });
      },
      webClient: {} as never,
    });
    const envelope: SlackSocketEnvelope = {
      envelope_id: "env-audio-1",
      payload: {
        team_id: "T1",
        event_id: "EvAudio1",
        event_time: 1_713_000_010,
        event: {
          type: "message",
          subtype: "file_share",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "",
          ts: "1713000010.000100",
          files: [
            {
              id: "F123",
              name: "audio_message.m4a",
              title: "audio_message.m4a",
              mimetype: "audio/mp4",
              filetype: "m4a",
              size: 2_558_655,
              media_display_type: "audio",
              url_private_download: "https://files.slack.test/private/F123",
            },
          ],
        },
      },
    };

    await service.handleEnvelope(envelope);

    expect(published).toHaveLength(1);
    expect(String(published[0]?.payload.prompt)).toContain("[Audio: audio_message.m4a, audio/mp4, 2.4 MB]");
    expect(String(published[0]?.payload.prompt)).toContain("Transcript: unavailable");

    const canonicalChatId = (published[0]?.payload.source as { canonicalChatId?: string } | undefined)?.canonicalChatId;
    expect(typeof canonicalChatId).toBe("string");
    const stored = dbFindChatMessage({
      channel: "slack",
      instanceId: "slack-instance-1",
      chatId: canonicalChatId!,
      providerMessageId: "1713000010.000100",
    });
    expect(stored?.messageType).toBe("audio");
    expect(stored?.content).toMatchObject({
      type: "audio",
      files: [
        {
          id: "F123",
          name: "audio_message.m4a",
          mimeType: "audio/mp4",
          mediaDisplayType: "audio",
        },
      ],
    });
    expect(JSON.stringify(stored?.content)).not.toContain("url_private");
    expect(JSON.stringify(stored?.content)).not.toContain("files.slack.test");
  });

  it("resolves Slack sender identity onto prompt source and stored messages", async () => {
    const identity = ensureContactFromInbound({
      channel: "slack",
      instanceId: "slack-instance-1",
      platformSenderId: "U123",
      contactIdentity: "U123",
      displayName: "Luis",
      chatId: "C123",
      intakeMode: "pending",
      source: "test",
    });
    expect(identity.contact?.id).toBeTruthy();
    expect(identity.platformIdentity?.id).toBeTruthy();

    const config: RouterConfig = {
      agents: {
        "ravi-hil": {
          id: "ravi-hil",
          cwd: "/tmp/ravi-hil",
          dmScope: "per-peer",
        },
      },
      routes: [
        {
          pattern: "group:C123",
          accountId: "ravi-rbbt-slack",
          agent: "ravi-hil",
          session: "ravi-hil",
          priority: 100,
          policy: "open",
          channel: "slack",
        },
      ],
      defaultAgent: "ravi-hil",
      defaultDmScope: "per-peer",
      accountAgents: { "ravi-rbbt-slack": "ravi-hil" },
      instanceToAccount: {},
      instances: {},
    };
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "ravi-rbbt-slack",
      routeAccountId: "ravi-rbbt-slack",
      instanceId: "slack-instance-1",
      getRouterConfig: () => config,
      publishPrompt: async (sessionName, payload) => {
        published.push({ sessionName, payload });
      },
      webClient: {} as never,
    });

    await service.handleEnvelope({
      envelope_id: "env-identity-1",
      payload: {
        team_id: "T1",
        event_id: "EvIdentity1",
        event_time: 1_713_000_020,
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "publica",
          ts: "1713000020.000100",
        },
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.payload.source).toMatchObject({
      actorType: "contact",
      contactId: identity.contact!.id,
      platformIdentityId: identity.platformIdentity!.id,
    });
    expect(published[0]?.payload.context).toMatchObject({
      actorType: "contact",
      contactId: identity.contact!.id,
      platformIdentityId: identity.platformIdentity!.id,
    });

    const canonicalChatId = (published[0]?.payload.source as { canonicalChatId?: string } | undefined)?.canonicalChatId;
    const stored = dbFindChatMessage({
      channel: "slack",
      instanceId: "slack-instance-1",
      chatId: canonicalChatId!,
      providerMessageId: "1713000020.000100",
    });
    expect(stored).toMatchObject({
      actorType: "contact",
      contactId: identity.contact!.id,
      platformIdentityId: identity.platformIdentity!.id,
    });
  });
});

describe("Slack Socket Mode foreign bot intake", () => {
  const SLUG = "ravi-rbbt-slack";
  const UUID = "0bc9635c-1ee9-42e3-9112-95be9cdb0334";
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-foreign-bot-");
    seedAgent("route-agent", "/tmp/route-agent");
    seedAgent("foreign-one", "/tmp/foreign-one");
    seedAgent("foreign-two", "/tmp/foreign-two");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function botRouterConfig(): RouterConfig {
    return {
      agents: {
        "route-agent": { id: "route-agent", cwd: "/tmp/route-agent", dmScope: "per-peer" },
        "foreign-one": { id: "foreign-one", cwd: "/tmp/foreign-one", dmScope: "per-peer" },
        "foreign-two": { id: "foreign-two", cwd: "/tmp/foreign-two", dmScope: "per-peer" },
      },
      routes: [
        {
          pattern: "group:C123",
          accountId: SLUG,
          agent: "route-agent",
          session: "route-agent",
          priority: 100,
          policy: "open",
          channel: "slack",
        },
      ],
      defaultAgent: "route-agent",
      defaultDmScope: "per-peer",
      accountAgents: { [SLUG]: "route-agent" },
      instanceToAccount: { [UUID]: SLUG },
      instances: {
        [SLUG]: {
          name: SLUG,
          instanceId: UUID,
          channel: "slack",
          dmPolicy: "open",
          groupPolicy: "open",
          contactIntakeMode: "off",
          createdAt: 1,
          updatedAt: 1,
        },
      },
    };
  }

  function botEnvelope(input: {
    envelopeId: string;
    ts: string;
    text: string;
    botId: string;
    userId?: string;
    channelId?: string;
    threadTs?: string;
    teamId?: string | null;
    eventTeamId?: string | null;
  }): SlackSocketEnvelope {
    return {
      envelope_id: input.envelopeId,
      payload: {
        ...(input.teamId === null ? {} : { team_id: input.teamId ?? "T1" }),
        event_id: `Ev-${input.envelopeId}`,
        event_time: 1_713_000_000,
        event: {
          type: "message",
          subtype: "bot_message",
          channel: input.channelId ?? "C123",
          channel_type: "channel",
          user: input.userId,
          bot_id: input.botId,
          text: input.text,
          ts: input.ts,
          thread_ts: input.threadTs,
          ...(input.eventTeamId === null || input.eventTeamId === undefined ? {} : { team: input.eventTeamId }),
        },
      },
    };
  }

  function humanEnvelope(input: {
    envelopeId: string;
    ts: string;
    teamId?: string | null;
    eventTeamId?: string | null;
  }): SlackSocketEnvelope {
    return {
      envelope_id: input.envelopeId,
      payload: {
        ...(input.teamId === null ? {} : { team_id: input.teamId ?? "T1" }),
        event_id: `Ev-${input.envelopeId}`,
        event_time: 1_713_000_000,
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UHUMAN",
          text: "human message",
          ts: input.ts,
          ...(input.eventTeamId === null || input.eventTeamId === undefined ? {} : { team: input.eventTeamId }),
        },
      },
    };
  }

  function makeBotService(input: {
    published: Array<{ sessionName: string; payload: Record<string, unknown> }>;
    authTest: (options?: { signal?: AbortSignal }) => Promise<{
      ok: boolean;
      bot_id?: string;
      user_id?: string;
      team_id?: string;
    }>;
    routingPolicy?: Partial<SlackRoutingPolicy>;
    now?: () => number;
    authTestFailureRetryMs?: number;
    authTestTimeoutMs?: number;
  }): SlackSocketModeService {
    return new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: SLUG,
      routeAccountId: SLUG,
      instanceId: SLUG,
      routingPolicy: input.routingPolicy,
      getRouterConfig: botRouterConfig,
      publishPrompt: async (sessionName, payload) => {
        input.published.push({ sessionName, payload });
      },
      webClient: { authTest: input.authTest } as never,
      now: input.now,
      authTestFailureRetryMs: input.authTestFailureRetryMs,
      authTestTimeoutMs: input.authTestTimeoutMs,
    });
  }

  it("preserves human intake without Slack team provenance and does not call auth.test", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const authTest = mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" }));
    const service = makeBotService({ published, authTest });

    expect(
      await service.handleEnvelope(
        humanEnvelope({
          envelopeId: "human-without-team",
          ts: "1713000090.000100",
          teamId: null,
          eventTeamId: null,
        }),
      ),
    ).toBe("processed");
    expect(authTest).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    const source = published[0]!.payload.source as MessageTarget;
    expect(dbGetChat(source.canonicalChatId!)).toMatchObject({
      rawProvenance: { teamId: SLUG },
    });
  });

  it("preserves event.team precedence for conflicting human team values without calling auth.test", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const authTest = mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" }));
    const service = makeBotService({ published, authTest });

    expect(
      await service.handleEnvelope(
        humanEnvelope({
          envelopeId: "human-conflicting-team",
          ts: "1713000091.000100",
          teamId: "T-PAYLOAD",
          eventTeamId: "T-EVENT",
        }),
      ),
    ).toBe("processed");
    expect(authTest).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    const source = published[0]!.payload.source as MessageTarget;
    expect(dbGetChat(source.canonicalChatId!)).toMatchObject({
      rawProvenance: { teamId: "T-EVENT" },
    });
  });

  it("ignores the local bot by bot and user ids while caching successful auth.test", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const authTest = mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" }));
    const service = makeBotService({ published, authTest });

    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "self-bot-id",
          ts: "1713000100.000100",
          text: "<@ULOCAL> loop",
          botId: "BLOCAL",
          userId: "UOTHER",
        }),
      ),
    ).toBe("ignored");
    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "self-user-id",
          ts: "1713000101.000100",
          text: "<@ULOCAL> loop",
          botId: "BOTHER",
          userId: "ULOCAL",
        }),
      ),
    ).toBe("ignored");
    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "foreign-mentioned",
          ts: "1713000102.000100",
          text: "oi <@ULOCAL>",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("processed");

    expect(authTest).toHaveBeenCalledTimes(1);
    expect(published).toHaveLength(1);
  });

  it("requires the envelope and auth.test to identify the same Slack team", async () => {
    const fromEvent: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const matchingAuth = mock(async () => ({
      ok: true,
      bot_id: "BLOCAL",
      user_id: "ULOCAL",
      team_id: "T1",
    }));
    const matchingService = makeBotService({ published: fromEvent, authTest: matchingAuth });

    expect(
      await matchingService.handleEnvelope(
        botEnvelope({
          envelopeId: "team-from-event",
          ts: "1713000102.000200",
          text: "<@ULOCAL> status",
          botId: "BFOREIGN",
          teamId: null,
          eventTeamId: "T1",
        }),
      ),
    ).toBe("processed");
    expect(fromEvent).toHaveLength(1);

    const mismatched: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const mismatchedAuth = mock(async () => ({
      ok: true,
      bot_id: "BLOCAL",
      user_id: "ULOCAL",
      team_id: "T2",
    }));
    const mismatchedService = makeBotService({ published: mismatched, authTest: mismatchedAuth });
    expect(
      await mismatchedService.handleEnvelope(
        botEnvelope({
          envelopeId: "team-mismatch",
          ts: "1713000102.000300",
          text: "<@ULOCAL> status",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("ignored");
    expect(mismatchedAuth).toHaveBeenCalledTimes(1);
    expect(mismatched).toHaveLength(0);
  });

  it("fails closed before auth.test when Slack team provenance is absent or conflicting", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const authTest = mock(async () => ({
      ok: true,
      bot_id: "BLOCAL",
      user_id: "ULOCAL",
      team_id: "T1",
    }));
    const service = makeBotService({ published, authTest });

    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "team-absent",
          ts: "1713000102.000400",
          text: "<@ULOCAL> status",
          botId: "BFOREIGN",
          teamId: null,
          eventTeamId: null,
        }),
      ),
    ).toBe("ignored");
    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "team-conflict",
          ts: "1713000102.000500",
          text: "<@ULOCAL> status",
          botId: "BFOREIGN",
          teamId: "T1",
          eventTeamId: "T2",
        }),
      ),
    ).toBe("ignored");
    expect(authTest).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it("requires auth.test ok=true and a complete team-bound identity", async () => {
    for (const [index, response] of [
      { ok: false, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" },
      { ok: true, bot_id: "BLOCAL", user_id: "ULOCAL" },
    ].entries()) {
      const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
      const service = makeBotService({ published, authTest: mock(async () => response) });
      expect(
        await service.handleEnvelope(
          botEnvelope({
            envelopeId: `auth-invalid-${index}`,
            ts: `1713000102.00060${index}`,
            text: "<@ULOCAL> status",
            botId: "BFOREIGN",
          }),
        ),
      ).toBe("ignored");
      expect(published).toHaveLength(0);
    }
  });

  it("rejects structurally invalid bot candidates before auth.test", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const authTest = mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" }));
    const service = makeBotService({ published, authTest });
    const invalidEvents = [
      {
        type: "reaction_added",
        subtype: "bot_message",
        bot_id: "BFOREIGN",
        channel: "C123",
        ts: "1713000103.000100",
      },
      {
        type: "message",
        subtype: "bot_message",
        hidden: true,
        bot_id: "BFOREIGN",
        channel: "C123",
        ts: "1713000104.000100",
      },
      {
        type: "message",
        subtype: "message_changed",
        bot_id: "BFOREIGN",
        channel: "C123",
        ts: "1713000105.000100",
      },
      {
        type: "message",
        subtype: "bot_message",
        bot_id: "BFOREIGN",
        ts: "1713000106.000100",
      },
      {
        type: "message",
        subtype: "bot_message",
        bot_id: "BFOREIGN",
        channel: "C123",
      },
    ];

    for (const [index, event] of invalidEvents.entries()) {
      expect(
        await service.handleEnvelope({
          envelope_id: `structurally-invalid-bot-${index}`,
          payload: { event },
        }),
      ).toBe("ignored");
    }

    expect(authTest).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it("coalesces concurrent auth.test discovery for foreign bot messages", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    let releaseAuth!: (value: { ok: boolean; bot_id: string; user_id: string; team_id: string }) => void;
    const pendingAuth = new Promise<{ ok: boolean; bot_id: string; user_id: string; team_id: string }>((resolve) => {
      releaseAuth = resolve;
    });
    const authTest = mock(async () => pendingAuth);
    const service = makeBotService({ published, authTest });

    const first = service.handleEnvelope(
      botEnvelope({
        envelopeId: "concurrent-1",
        ts: "1713000110.000100",
        text: "<@ULOCAL> first",
        botId: "BFOREIGN",
      }),
    );
    const second = service.handleEnvelope(
      botEnvelope({
        envelopeId: "concurrent-2",
        ts: "1713000111.000100",
        text: "<@ULOCAL> second",
        botId: "BFOREIGN",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(authTest).toHaveBeenCalledTimes(1);
    releaseAuth({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" });
    expect(await Promise.all([first, second])).toEqual(["processed", "processed"]);
    expect(published).toHaveLength(2);
  });

  it("fail-closes auth.test errors and retries only after the bounded failure TTL", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    let now = 1_000;
    let attempts = 0;
    const authTest = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary_auth_failure");
      return { ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" };
    });
    const service = makeBotService({
      published,
      authTest,
      now: () => now,
      authTestFailureRetryMs: 100,
    });

    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "auth-failure-1",
          ts: "1713000120.000100",
          text: "<@ULOCAL> first",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("ignored");
    now = 1_050;
    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "auth-failure-2",
          ts: "1713000121.000100",
          text: "<@ULOCAL> second",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("ignored");
    expect(authTest).toHaveBeenCalledTimes(1);

    now = 1_100;
    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "auth-retry",
          ts: "1713000122.000100",
          text: "<@ULOCAL> retry",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("processed");
    expect(authTest).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(1);
  });

  it("does not cache an incomplete auth.test identity and retries after the failure TTL", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    let now = 2_000;
    let attempts = 0;
    const authTest = mock(async () => {
      attempts += 1;
      if (attempts === 1) return { ok: true, bot_id: "BLOCAL" };
      return { ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" };
    });
    const service = makeBotService({
      published,
      authTest,
      now: () => now,
      authTestFailureRetryMs: 100,
    });

    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "auth-incomplete-1",
          ts: "1713000125.000100",
          text: "<@ULOCAL> first",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("ignored");
    now = 2_050;
    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "auth-incomplete-2",
          ts: "1713000126.000100",
          text: "<@ULOCAL> second",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("ignored");
    expect(authTest).toHaveBeenCalledTimes(1);

    now = 2_100;
    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "auth-incomplete-retry",
          ts: "1713000127.000100",
          text: "<@ULOCAL> retry",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("processed");
    expect(authTest).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(1);
  });

  it("times out a stuck auth.test, fails closed, and permits a later retry", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    let attempts = 0;
    let timedOutSignal: AbortSignal | undefined;
    const authTest = mock(async (options?: { signal?: AbortSignal }) => {
      attempts += 1;
      if (attempts === 1) {
        timedOutSignal = options?.signal;
        return new Promise<{ ok: boolean; bot_id: string; user_id: string; team_id: string }>((_, reject) => {
          timedOutSignal?.addEventListener("abort", () => reject(timedOutSignal?.reason), { once: true });
        });
      }
      return { ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" };
    });
    const service = makeBotService({
      published,
      authTest,
      authTestFailureRetryMs: 0,
      authTestTimeoutMs: 10,
    });

    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "auth-timeout",
          ts: "1713000128.000100",
          text: "<@ULOCAL> first",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("ignored");
    expect(timedOutSignal?.aborted).toBe(true);
    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "auth-timeout-retry",
          ts: "1713000129.000100",
          text: "<@ULOCAL> retry",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("processed");
    expect(authTest).toHaveBeenCalledTimes(2);
    expect(published).toHaveLength(1);
  });

  it("resolves one consistent agent across bot ids, preserves provenance, threads, and dedupe", async () => {
    const identity = upsertAgentPlatformIdentity({
      agentId: "foreign-one",
      channel: "slack",
      instanceId: UUID,
      platformUserId: "BFOREIGN",
      linkedBy: "test",
      linkReason: "slack_connect_agent_interop",
    });
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const authTest = mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" }));
    const service = makeBotService({ published, authTest });
    const envelope = botEnvelope({
      envelopeId: "agent-thread",
      ts: "1713000130.000200",
      threadTs: "1713000130.000100",
      text: "<@ULOCAL> consegue responder?",
      userId: "UFOREIGN",
      botId: "BFOREIGN",
    });

    expect(await service.handleEnvelope(envelope)).toBe("processed");
    expect(await service.handleEnvelope(envelope)).toBe("duplicate");
    expect(published).toHaveLength(1);

    const source = published[0]!.payload.source as MessageTarget;
    const context = published[0]!.payload.context as MessageContext;
    expect(source).toMatchObject({
      instanceId: UUID,
      threadId: "1713000130.000100",
      actorType: "agent",
      actorAgentId: "foreign-one",
      platformIdentityId: identity.id,
      rawSenderId: "UFOREIGN",
      normalizedSenderId: "BFOREIGN",
    });
    expect(source.identityProvenance).toMatchObject({
      source: "platform_identities",
      canonicalInstance: UUID,
      matchedInstance: UUID,
      matchedPlatformUserId: "BFOREIGN",
      candidatePlatformUserIds: ["UFOREIGN", "BFOREIGN"],
      botIdentityReason: "resolved_agent",
    });
    expect(context).toMatchObject({
      senderId: "UFOREIGN",
      senderName: "<@UFOREIGN>",
      actorType: "agent",
      actorAgentId: "foreign-one",
    });

    const canonicalChatId = source.canonicalChatId!;
    expect(dbGetChat(canonicalChatId)).toMatchObject({
      instanceId: UUID,
      platformChatId: "C123#1713000130.000100",
      chatType: "thread",
      rawProvenance: {
        senderKind: "bot",
        userId: "UFOREIGN",
        botId: "BFOREIGN",
      },
    });
    expect(
      dbFindChatMessage({
        channel: "slack",
        instanceId: UUID,
        chatId: canonicalChatId,
        providerMessageId: "1713000130.000200",
      }),
    ).toMatchObject({
      actorType: "agent",
      agentId: "foreign-one",
      platformIdentityId: identity.id,
      rawSenderId: "UFOREIGN",
      normalizedSenderId: "BFOREIGN",
      rawProvenance: {
        senderKind: "bot",
        userId: "UFOREIGN",
        botId: "BFOREIGN",
      },
    });
    expect(dbListChatParticipants(canonicalChatId)).toEqual([
      expect.objectContaining({
        agentId: "foreign-one",
        rawPlatformUserId: "UFOREIGN",
        normalizedPlatformUserId: "BFOREIGN",
        metadata: expect.objectContaining({ slackSenderKind: "bot", slackBotId: "BFOREIGN" }),
      }),
    ]);

    const session = getSessionByName(published[0]!.sessionName)!;
    const runtimePrompt: RuntimeLaunchPrompt = { prompt: "consegue responder?", source, context };
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: session.sessionKey,
      sessionName: published[0]!.sessionName,
      sessionCwd: "/tmp/route-agent",
      agent: { id: "route-agent", cwd: "/tmp/route-agent" },
      prompt: runtimePrompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution: {
        options: {},
        sources: { model: null, effort: null, thinking: null },
        hasTaskRuntimeContext: false,
      },
      resolvedSource: source,
    });
    expect(runtimeContext.metadata).toMatchObject({
      actorPrincipal: "agent:foreign-one",
      actorResolution: "resolved",
    });
    expect(Number(runtimeContext.metadata?.agentIdentityCapabilityCount)).toBeGreaterThan(0);
    expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
  });

  it("admits a bot-only alias message but keeps a contact-owned bot fail-closed", async () => {
    const contact = ensureContactFromInbound({
      channel: "slack",
      instanceId: UUID,
      platformSenderId: "BFOREIGN",
      contactIdentity: "BFOREIGN",
      displayName: "External integration",
      intakeMode: "pending",
      source: "test",
    });
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeBotService({
      published,
      authTest: mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" })),
      routingPolicy: { botMessageAliasesByChat: { C123: ["Hana"] } },
    });

    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "bot-only-contact",
          ts: "1713000140.000100",
          text: "Hana—status",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("processed");
    expect(contact.platformIdentity).not.toBeNull();
    const source = published[0]!.payload.source as MessageTarget;
    expect(source).toMatchObject({
      actorType: "unknown",
      rawSenderId: "BFOREIGN",
      normalizedSenderId: "BFOREIGN",
    });
    expect(source.contactId).toBeUndefined();
    expect(source.platformIdentityId).toBeUndefined();
    expect(source.identityProvenance).toMatchObject({
      senderKind: "bot",
      botIdentityReason: "contact_identity_not_agent",
    });
    expect(dbGetChat(source.canonicalChatId!)).toMatchObject({
      rawProvenance: {
        senderKind: "bot",
        userId: null,
        botId: "BFOREIGN",
      },
    });
    expect(
      dbFindChatMessage({
        channel: "slack",
        instanceId: UUID,
        chatId: source.canonicalChatId!,
        providerMessageId: "1713000140.000100",
      }),
    ).toMatchObject({
      rawProvenance: {
        senderKind: "bot",
        userId: null,
        botId: "BFOREIGN",
      },
    });
    expect(String(published[0]!.payload.prompt)).toContain("<@BFOREIGN>: Hana—status");
  });

  it("resolves bot user_id and bot_id to one agent when both identities agree", async () => {
    upsertAgentPlatformIdentity({
      agentId: "foreign-one",
      channel: "slack",
      instanceId: UUID,
      platformUserId: "UFOREIGN",
    });
    upsertAgentPlatformIdentity({
      agentId: "foreign-one",
      channel: "slack",
      instanceId: UUID,
      platformUserId: "BFOREIGN",
    });
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeBotService({
      published,
      authTest: mock(async () => ({
        ok: true,
        bot_id: "BLOCAL",
        user_id: "ULOCAL",
        team_id: "T1",
      })),
    });

    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "consistent-bot-identities",
          ts: "1713000145.000100",
          text: "<@ULOCAL> status",
          userId: "UFOREIGN",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("processed");
    const source = published[0]!.payload.source as MessageTarget;
    expect(source).toMatchObject({
      actorType: "agent",
      actorAgentId: "foreign-one",
      rawSenderId: "UFOREIGN",
      normalizedSenderId: "UFOREIGN",
    });
    expect(source.identityProvenance).toMatchObject({
      matchedPlatformUserId: "UFOREIGN",
      candidatePlatformUserIds: ["UFOREIGN", "BFOREIGN"],
      botIdentityReason: "resolved_agent",
      platformIdentityCandidates: [
        expect.objectContaining({ platformUserId: "UFOREIGN", ownerType: "agent" }),
        expect.objectContaining({ platformUserId: "BFOREIGN", ownerType: "agent" }),
      ],
    });
  });

  it("fails closed when the bot user and bot ids resolve to different owners", async () => {
    upsertAgentPlatformIdentity({
      agentId: "foreign-one",
      channel: "slack",
      instanceId: UUID,
      platformUserId: "UFOREIGN",
    });
    upsertAgentPlatformIdentity({
      agentId: "foreign-two",
      channel: "slack",
      instanceId: UUID,
      platformUserId: "BFOREIGN",
    });
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeBotService({
      published,
      authTest: mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" })),
    });

    expect(
      await service.handleEnvelope(
        botEnvelope({
          envelopeId: "conflicting-agents",
          ts: "1713000150.000100",
          text: "<@ULOCAL> status",
          userId: "UFOREIGN",
          botId: "BFOREIGN",
        }),
      ),
    ).toBe("processed");
    const source = published[0]!.payload.source as MessageTarget;
    expect(source.actorType).toBe("unknown");
    expect(source.actorAgentId).toBeUndefined();
    expect(source.platformIdentityId).toBeUndefined();
    expect(source.identityProvenance).toMatchObject({ botIdentityReason: "conflicting_agents" });
  });

  it("fails closed when an agent bot id conflicts with a contact-owned user id", async () => {
    ensureContactFromInbound({
      channel: "slack",
      instanceId: UUID,
      platformSenderId: "UCONTACT",
      contactIdentity: "UCONTACT",
      intakeMode: "pending",
      source: "test",
    });
    upsertAgentPlatformIdentity({
      agentId: "foreign-one",
      channel: "slack",
      instanceId: UUID,
      platformUserId: "BAGENT",
    });
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeBotService({
      published,
      authTest: mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" })),
    });

    await service.handleEnvelope(
      botEnvelope({
        envelopeId: "agent-contact-conflict",
        ts: "1713000160.000100",
        text: "<@ULOCAL> status",
        userId: "UCONTACT",
        botId: "BAGENT",
      }),
    );
    const source = published[0]!.payload.source as MessageTarget;
    expect(source.actorType).toBe("unknown");
    expect(source.contactId).toBeUndefined();
    expect(source.actorAgentId).toBeUndefined();
    expect(source.identityProvenance).toMatchObject({ botIdentityReason: "conflicting_platform_owners" });
  });

  it("keeps canonical instance alias collisions fail-closed for bot identities", async () => {
    upsertAgentPlatformIdentity({
      agentId: "foreign-one",
      channel: "slack",
      instanceId: UUID,
      platformUserId: "BFOREIGN",
    });
    upsertAgentPlatformIdentity({
      agentId: "foreign-two",
      channel: "slack",
      instanceId: SLUG,
      platformUserId: "BFOREIGN",
    });
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeBotService({
      published,
      authTest: mock(async () => ({ ok: true, bot_id: "BLOCAL", user_id: "ULOCAL", team_id: "T1" })),
      routingPolicy: { botMessageAliasesByChat: { C123: ["Hana"] } },
    });

    await service.handleEnvelope(
      botEnvelope({
        envelopeId: "alias-owner-conflict",
        ts: "1713000170.000100",
        text: "Hana, status",
        botId: "BFOREIGN",
      }),
    );
    const source = published[0]!.payload.source as MessageTarget;
    expect(source.actorType).toBe("unknown");
    expect(source.actorAgentId).toBeUndefined();
    expect(source.identityProvenance).toMatchObject({
      canonicalInstance: UUID,
      reason: "ambiguous_instance_alias",
      botIdentityReason: "ambiguous_instance_alias",
    });
  });
});

describe("Slack Socket Mode instance alias canonicalization", () => {
  const SLUG = "ravi-rbbt-slack";
  const UUID = "0bc9635c-1ee9-42e3-9112-95be9cdb0334";
  const OTHER_UUID = "11111111-2222-3333-4444-555555555555";

  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-alias-");
    seedAgent("ravi-hil", "/tmp/ravi-hil");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function slackInstance(name: string, instanceId?: string): InstanceConfig {
    return {
      name,
      instanceId,
      channel: "slack",
      dmPolicy: "open",
      groupPolicy: "open",
      contactIntakeMode: "pending",
      createdAt: 1,
      updatedAt: 1,
    };
  }

  function aliasConfig(): RouterConfig {
    return {
      agents: {
        "ravi-hil": { id: "ravi-hil", cwd: "/tmp/ravi-hil", dmScope: "per-peer" },
      },
      routes: [
        {
          pattern: "group:C123",
          accountId: SLUG,
          agent: "ravi-hil",
          session: "ravi-hil",
          priority: 100,
          policy: "open",
          channel: "slack",
        },
      ],
      defaultAgent: "ravi-hil",
      defaultDmScope: "per-peer",
      accountAgents: { [SLUG]: "ravi-hil" },
      instanceToAccount: { [UUID]: SLUG },
      instances: { [SLUG]: slackInstance(SLUG, UUID) },
    };
  }

  function makeService(input: {
    instanceId: string;
    config: RouterConfig;
    published: Array<{ sessionName: string; payload: Record<string, unknown> }>;
  }): SlackSocketModeService {
    return new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: SLUG,
      routeAccountId: SLUG,
      instanceId: input.instanceId,
      getRouterConfig: () => input.config,
      publishPrompt: async (sessionName, payload) => {
        input.published.push({ sessionName, payload });
      },
      webClient: {} as never,
    });
  }

  function slackMessageEnvelope(input: {
    envelopeId: string;
    eventId: string;
    user: string;
    ts: string;
  }): SlackSocketEnvelope {
    return {
      envelope_id: input.envelopeId,
      payload: {
        team_id: "T1",
        event_id: input.eventId,
        event_time: 1_713_000_000,
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: input.user,
          text: "publica",
          ts: input.ts,
        },
      },
    };
  }

  const runtimeResolution: TaskRuntimeResolution = {
    options: {},
    sources: { model: null, effort: null, thinking: null },
    hasTaskRuntimeContext: false,
  };

  function actorResolutionForSource(source: MessageTarget, context: MessageContext): string {
    const agent: AgentConfig = { id: "ravi-hil", cwd: "/tmp/ravi-hil" };
    const session = getSessionByName("ravi-hil");
    const prompt: RuntimeLaunchPrompt = { prompt: "publica", source, context };
    const { runtimeContext } = buildRuntimeRequestContext({
      dbSessionKey: session!.sessionKey,
      sessionName: "ravi-hil",
      sessionCwd: "/tmp/ravi-hil",
      agent,
      prompt,
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: source,
    });
    return String(runtimeContext.metadata?.actorResolution);
  }

  it("resolves an identity stored under the configured UUID when Slack addresses the slug", async () => {
    const identity = ensureContactFromInbound({
      channel: "slack",
      instanceId: UUID,
      platformSenderId: "U123",
      contactIdentity: "U123",
      displayName: "Luis",
      intakeMode: "pending",
      source: "test",
    });
    expect(identity.platformIdentity?.instanceId).toBe(UUID);

    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeService({ instanceId: SLUG, config: aliasConfig(), published });

    await service.handleEnvelope(
      slackMessageEnvelope({ envelopeId: "env-a", eventId: "EvA", user: "U123", ts: "1713000030.000100" }),
    );

    expect(published).toHaveLength(1);
    const source = published[0]!.payload.source as MessageTarget;
    const context = published[0]!.payload.context as MessageContext;
    expect(source).toMatchObject({
      actorType: "contact",
      contactId: identity.contact!.id,
      platformIdentityId: identity.platformIdentity!.id,
      instanceId: UUID,
    });
    expect(source.identityProvenance).toMatchObject({
      source: "platform_identities",
      channel: "slack",
      receivedInstance: SLUG,
      canonicalInstance: UUID,
      matchedInstance: UUID,
      reason: "resolved",
    });

    const canonicalChatId = source.canonicalChatId!;
    const stored = dbFindChatMessage({
      channel: "slack",
      instanceId: UUID,
      chatId: canonicalChatId,
      providerMessageId: "1713000030.000100",
    });
    expect(stored).toMatchObject({ actorType: "contact", contactId: identity.contact!.id });
    const participants = dbListChatParticipants(canonicalChatId);
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({ contactId: identity.contact!.id });

    expect(actorResolutionForSource(source, context)).toBe("resolved");
  });

  it("resolves an identity stored under the configured slug when Slack addresses the UUID", async () => {
    const identity = ensureContactFromInbound({
      channel: "slack",
      instanceId: SLUG,
      platformSenderId: "U123",
      contactIdentity: "U123",
      displayName: "Luis",
      intakeMode: "pending",
      source: "test",
    });
    expect(identity.platformIdentity?.instanceId).toBe(SLUG);

    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeService({ instanceId: UUID, config: aliasConfig(), published });

    await service.handleEnvelope(
      slackMessageEnvelope({ envelopeId: "env-b", eventId: "EvB", user: "U123", ts: "1713000031.000100" }),
    );

    expect(published).toHaveLength(1);
    const source = published[0]!.payload.source as MessageTarget;
    expect(source).toMatchObject({ actorType: "contact", contactId: identity.contact!.id, instanceId: UUID });
    expect(source.identityProvenance).toMatchObject({
      receivedInstance: UUID,
      canonicalInstance: UUID,
      matchedInstance: SLUG,
      reason: "resolved",
    });
  });

  it("never selects the same Slack user id from another workspace", async () => {
    const contact = createContact({ phone: "5511999990001", name: "Other", status: "allowed" });
    linkContactIdentity(contact.id, { channel: "slack", platformUserId: "U123", instanceId: OTHER_UUID });

    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeService({ instanceId: SLUG, config: aliasConfig(), published });

    await service.handleEnvelope(
      slackMessageEnvelope({ envelopeId: "env-c", eventId: "EvC", user: "U123", ts: "1713000032.000100" }),
    );

    expect(published).toHaveLength(1);
    const source = published[0]!.payload.source as MessageTarget;
    const context = published[0]!.payload.context as MessageContext;
    expect(source.actorType).toBe("unknown");
    expect(source.contactId).toBeUndefined();
    expect(source.identityProvenance).toMatchObject({
      canonicalInstance: UUID,
      matchedInstance: null,
      reason: "identity_not_found",
    });
    expect(actorResolutionForSource(source, context)).toBe("missing_contact");
  });

  it("fails closed with ambiguous_instance_alias when equivalent aliases resolve to different owners", async () => {
    const first = createContact({ phone: "5511999990002", name: "Owner UUID", status: "allowed" });
    const second = createContact({ phone: "5511999990003", name: "Owner Slug", status: "allowed" });
    linkContactIdentity(first.id, { channel: "slack", platformUserId: "U123", instanceId: UUID });
    linkContactIdentity(second.id, { channel: "slack", platformUserId: "U123", instanceId: SLUG });

    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeService({ instanceId: SLUG, config: aliasConfig(), published });

    await service.handleEnvelope(
      slackMessageEnvelope({ envelopeId: "env-d", eventId: "EvD", user: "U123", ts: "1713000033.000100" }),
    );

    expect(published).toHaveLength(1);
    const source = published[0]!.payload.source as MessageTarget;
    const context = published[0]!.payload.context as MessageContext;
    expect(source.actorType).toBe("unknown");
    expect(source.contactId).toBeUndefined();
    expect(source.platformIdentityId).toBeUndefined();
    expect(source.identityProvenance).toMatchObject({
      canonicalInstance: UUID,
      matchedInstance: null,
      reason: "ambiguous_instance_alias",
    });

    expect(actorResolutionForSource(source, context)).toBe("missing_contact");
    const { runtimeContext } = (() => {
      const agent: AgentConfig = { id: "ravi-hil", cwd: "/tmp/ravi-hil" };
      const session = getSessionByName("ravi-hil");
      return buildRuntimeRequestContext({
        dbSessionKey: session!.sessionKey,
        sessionName: "ravi-hil",
        sessionCwd: "/tmp/ravi-hil",
        agent,
        prompt: { prompt: "publica", source, context },
        runtimeProviderId: "codex",
        model: "gpt-5",
        runtimeResolution,
        resolvedSource: source,
      });
    })();
    expect(canWithCapabilities(runtimeContext.capabilities, "read_contact", "contact", first.id)).toBe(false);
    expect(canWithCapabilities(runtimeContext.capabilities, "read_contact", "contact", second.id)).toBe(false);
  });

  it("writes canonically and stays duplicate-free across retries of the same message", async () => {
    const identity = ensureContactFromInbound({
      channel: "slack",
      instanceId: UUID,
      platformSenderId: "U123",
      contactIdentity: "U123",
      displayName: "Luis",
      intakeMode: "pending",
      source: "test",
    });

    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeService({ instanceId: SLUG, config: aliasConfig(), published });

    const envelope = slackMessageEnvelope({
      envelopeId: "env-e",
      eventId: "EvE",
      user: "U123",
      ts: "1713000034.000100",
    });
    await service.handleEnvelope(envelope);
    await service.handleEnvelope(envelope);

    const source = published[0]!.payload.source as MessageTarget;
    const canonicalChatId = source.canonicalChatId!;
    const participants = dbListChatParticipants(canonicalChatId);
    expect(participants).toHaveLength(1);
    expect(participants[0]).toMatchObject({ contactId: identity.contact!.id });

    expect(dbGetChat(canonicalChatId)).toMatchObject({ channel: "slack", instanceId: UUID, platformChatId: "C123" });
    expect(resolvePlatformIdentity({ channel: "slack", instanceId: UUID, platformUserId: "U123" })?.id).toBe(
      identity.platformIdentity!.id,
    );
    expect(resolvePlatformIdentity({ channel: "slack", instanceId: SLUG, platformUserId: "U123" })).toBeNull();
  });

  it("keeps a resolved Slack identity and its agent-identity authority stable across turn rotations", async () => {
    const identity = ensureContactFromInbound({
      channel: "slack",
      instanceId: UUID,
      platformSenderId: "U777",
      contactIdentity: "U777",
      displayName: "Luis",
      intakeMode: "pending",
      source: "test",
    });
    expect(identity.platformIdentity?.instanceId).toBe(UUID);

    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeService({ instanceId: SLUG, config: aliasConfig(), published });

    const envelopes = [
      slackMessageEnvelope({ envelopeId: "env-turn-1", eventId: "EvTurn1", user: "U777", ts: "1713000040.000100" }),
      slackMessageEnvelope({ envelopeId: "env-turn-2", eventId: "EvTurn2", user: "U777", ts: "1713000041.000100" }),
      slackMessageEnvelope({ envelopeId: "env-turn-3", eventId: "EvTurn3", user: "U777", ts: "1713000042.000100" }),
    ];
    for (const envelope of envelopes) {
      await service.handleEnvelope(envelope);
    }
    expect(published).toHaveLength(3);

    const agent: AgentConfig = { id: "ravi-hil", cwd: "/tmp/ravi-hil" };
    const session = getSessionByName("ravi-hil");

    const turnPrompt = (index: number): RuntimeLaunchPrompt => {
      const source = published[index]!.payload.source as MessageTarget;
      const context = published[index]!.payload.context as MessageContext;
      return { prompt: "publica", source, context };
    };

    const { runtimeContext, toolContext, raviEnv } = buildRuntimeRequestContext({
      dbSessionKey: session!.sessionKey,
      sessionName: "ravi-hil",
      sessionCwd: "/tmp/ravi-hil",
      agent,
      prompt: turnPrompt(0),
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: turnPrompt(0).source,
    });
    const runtimeEnv: Record<string, string> = { ...raviEnv };

    const assertResolvedTurn = (): void => {
      expect(runtimeContext.metadata?.actorResolution).toBe("resolved");
      expect(runtimeContext.metadata?.actorPrincipal).toBe(`contact:${identity.contact!.id}`);
      expect(Number(runtimeContext.metadata?.agentIdentityCapabilityCount)).toBeGreaterThan(0);
      expect(Number(runtimeContext.metadata?.effectiveCapabilityCount)).toBeGreaterThan(0);
      expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(true);
    };

    assertResolvedTurn();
    const stableCapabilityCount = Number(runtimeContext.metadata?.agentIdentityCapabilityCount);

    let previousContextId = runtimeContext.contextId;
    for (const index of [1, 2]) {
      const refreshed = refreshRuntimeRequestContextForTurn({
        runtimeContext,
        toolContext,
        runtimeEnv,
        dbSessionKey: session!.sessionKey,
        sessionName: "ravi-hil",
        sessionCwd: "/tmp/ravi-hil",
        agent,
        prompt: turnPrompt(index),
        runtimeProviderId: "codex",
        model: "gpt-5",
        runtimeResolution,
        resolvedSource: turnPrompt(index).source,
      });

      expect(refreshed).toBe(runtimeContext);
      expect(runtimeContext.contextId).not.toBe(previousContextId);
      expect(dbGetContext(previousContextId)?.revokedAt).toBeNumber();
      expect(toolContext.contextId).toBe(runtimeContext.contextId);
      expect(toolContext.context).toBe(runtimeContext);
      assertResolvedTurn();
      expect(Number(runtimeContext.metadata?.agentIdentityCapabilityCount)).toBe(stableCapabilityCount);
      previousContextId = runtimeContext.contextId;
    }
  });

  it("keeps an unknown external Slack actor fail-closed with zero authority across turn rotations", async () => {
    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeService({ instanceId: SLUG, config: aliasConfig(), published });

    const envelopes = [
      slackMessageEnvelope({ envelopeId: "env-unk-1", eventId: "EvUnk1", user: "U404", ts: "1713000050.000100" }),
      slackMessageEnvelope({ envelopeId: "env-unk-2", eventId: "EvUnk2", user: "U404", ts: "1713000051.000100" }),
      slackMessageEnvelope({ envelopeId: "env-unk-3", eventId: "EvUnk3", user: "U404", ts: "1713000052.000100" }),
    ];
    for (const envelope of envelopes) {
      await service.handleEnvelope(envelope);
    }
    expect(published).toHaveLength(3);

    const agent: AgentConfig = { id: "ravi-hil", cwd: "/tmp/ravi-hil" };
    const session = getSessionByName("ravi-hil");

    const turnPrompt = (index: number): RuntimeLaunchPrompt => {
      const source = published[index]!.payload.source as MessageTarget;
      const context = published[index]!.payload.context as MessageContext;
      expect(source.actorType).toBe("unknown");
      expect(source.contactId).toBeUndefined();
      return { prompt: "publica", source, context };
    };

    const { runtimeContext, toolContext, raviEnv } = buildRuntimeRequestContext({
      dbSessionKey: session!.sessionKey,
      sessionName: "ravi-hil",
      sessionCwd: "/tmp/ravi-hil",
      agent,
      prompt: turnPrompt(0),
      runtimeProviderId: "codex",
      model: "gpt-5",
      runtimeResolution,
      resolvedSource: turnPrompt(0).source,
    });
    const runtimeEnv: Record<string, string> = { ...raviEnv };

    const assertFailClosedTurn = (): void => {
      expect(runtimeContext.metadata?.actorResolution).toBe("missing_contact");
      expect(Number(runtimeContext.metadata?.agentIdentityCapabilityCount)).toBe(0);
      expect(Number(runtimeContext.metadata?.effectiveCapabilityCount)).toBe(0);
      expect(canWithCapabilities(runtimeContext.capabilities, "use", "tool", "Read")).toBe(false);
    };

    assertFailClosedTurn();

    let previousContextId = runtimeContext.contextId;
    for (const index of [1, 2]) {
      refreshRuntimeRequestContextForTurn({
        runtimeContext,
        toolContext,
        runtimeEnv,
        dbSessionKey: session!.sessionKey,
        sessionName: "ravi-hil",
        sessionCwd: "/tmp/ravi-hil",
        agent,
        prompt: turnPrompt(index),
        runtimeProviderId: "codex",
        model: "gpt-5",
        runtimeResolution,
        resolvedSource: turnPrompt(index).source,
      });

      expect(runtimeContext.contextId).not.toBe(previousContextId);
      expect(dbGetContext(previousContextId)?.revokedAt).toBeNumber();
      assertFailClosedTurn();
      previousContextId = runtimeContext.contextId;
    }
  });

  it("fails closed on a later alias owner conflict even after a participant was cached", async () => {
    const firstOwner = ensureContactFromInbound({
      channel: "slack",
      instanceId: UUID,
      platformSenderId: "U999",
      contactIdentity: "U999",
      displayName: "Owner UUID",
      intakeMode: "pending",
      source: "test",
    });
    expect(firstOwner.platformIdentity?.instanceId).toBe(UUID);

    const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
    const service = makeService({ instanceId: SLUG, config: aliasConfig(), published });

    await service.handleEnvelope(
      slackMessageEnvelope({ envelopeId: "env-cache-1", eventId: "EvCache1", user: "U999", ts: "1713000060.000100" }),
    );

    const firstSource = published[0]!.payload.source as MessageTarget;
    expect(firstSource.actorType).toBe("contact");
    expect(firstSource.contactId).toBe(firstOwner.contact!.id);
    const canonicalChatId = firstSource.canonicalChatId!;
    const cachedParticipants = dbListChatParticipants(canonicalChatId);
    expect(cachedParticipants).toHaveLength(1);
    expect(cachedParticipants[0]).toMatchObject({ contactId: firstOwner.contact!.id });

    const conflict = createContact({ phone: "5511999990009", name: "Owner Slug", status: "allowed" });
    linkContactIdentity(conflict.id, { channel: "slack", platformUserId: "U999", instanceId: SLUG });

    await service.handleEnvelope(
      slackMessageEnvelope({ envelopeId: "env-cache-2", eventId: "EvCache2", user: "U999", ts: "1713000061.000100" }),
    );

    expect(published).toHaveLength(2);
    const secondSource = published[1]!.payload.source as MessageTarget;
    const secondContext = published[1]!.payload.context as MessageContext;
    expect(secondSource.actorType).toBe("unknown");
    expect(secondSource.contactId).toBeUndefined();
    expect(secondSource.platformIdentityId).toBeUndefined();
    expect(secondSource.identityProvenance).toMatchObject({
      canonicalInstance: UUID,
      matchedInstance: null,
      reason: "ambiguous_instance_alias",
    });
    expect(actorResolutionForSource(secondSource, secondContext)).toBe("missing_contact");
  });
});
