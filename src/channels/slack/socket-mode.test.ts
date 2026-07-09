import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureContactFromInbound } from "../../contacts.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { getOrCreateSession, getSessionByName, listSessionSubscriptions } from "../../router/index.js";
import { dbFindChatMessage, dbGetChat, dbUpsertInstance, getDb } from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import {
  SlackAssistantThreadPresence,
  SlackPresenceStack,
  SlackReactionPresence,
  SlackSocketModeService,
} from "./socket-mode.js";
import type { SlackSocketEnvelope } from "./types.js";

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

describe("Slack Socket Mode routing", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-socket-mode-");
    seedAgent("ravi-hil", "/tmp/ravi-hil");
    dbUpsertInstance({
      name: "ravi-rbbt-slack",
      instanceId: "slack-instance-1",
      channel: "slack",
      agent: "ravi-hil",
      groupPolicy: "allowlist",
    });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
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
  });

  it("routes Slack message_replied updates by fetching the latest thread reply", async () => {
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
      webClient: {
        conversationsReplies: async (input: Record<string, unknown>) => {
          expect(input).toMatchObject({
            channel: "C123",
            ts: "1713000000.000100",
            oldest: "1713000040.000300",
            latest: "1713000040.000300",
            inclusive: true,
          });
          return {
            ok: true,
            messages: [
              {
                type: "message",
                user: "U999",
                text: "root",
                ts: "1713000000.000100",
                thread_ts: "1713000000.000100",
              },
              {
                type: "message",
                user: "U123",
                text: "responde esse fio",
                ts: "1713000040.000300",
                thread_ts: "1713000000.000100",
              },
            ],
          };
        },
      } as never,
    });

    await service.handleEnvelope({
      envelope_id: "env-message-replied-1",
      payload: {
        team_id: "T1",
        event_id: "EvReplyUpdate1",
        event_time: 1_713_000_040,
        event: {
          type: "message",
          subtype: "message_replied",
          channel: "C123",
          channel_type: "channel",
          ts: "1713000040.000400",
          message: {
            type: "message",
            user: "U999",
            text: "root",
            ts: "1713000000.000100",
            thread_ts: "1713000000.000100",
            latest_reply: "1713000040.000300",
            replies: [{ user: "U123", ts: "1713000040.000300" }],
          },
        },
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]?.sessionName).toBe("ravi-hil-t-1713000000000100");
    expect(String(published[0]?.payload.prompt)).toContain("responde esse fio");
    expect(published[0]?.payload.source).toMatchObject({
      channel: "slack",
      chatId: "C123",
      threadId: "1713000000.000100",
      sourceMessageId: "1713000040.000300",
    });
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
