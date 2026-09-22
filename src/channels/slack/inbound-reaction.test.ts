import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  authorizeRuntimeContext,
  setApprovalServiceDependenciesForTest,
  type ApprovalServiceDependencies,
} from "../../approval/service.js";
import { SLACK_APPROVAL_ACTION_APPROVE } from "../../approval/slack-blocks.js";
import { dbCreateContext, dbDeleteContext, dbGetContext } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  APPROVAL_TEST_NOW_MS,
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_TIMEOUT_MS,
  seedApprovalContact,
} from "../../approval/test-support.js";
import { SlackSocketModeService } from "./socket-mode.js";
import { slackInboundReactionFromEnvelope } from "./reactions.js";
import type { SlackSocketEnvelope } from "./types.js";

function reactionEnvelope(input: {
  envelopeId?: string;
  reaction: string;
  targetTs: string;
  user?: string;
  itemType?: string;
  type?: string;
}): SlackSocketEnvelope {
  return {
    envelope_id: input.envelopeId ?? `env-reaction-${input.targetTs}`,
    payload: {
      team_id: "T1",
      event_id: `Ev${input.targetTs}`,
      event: {
        type: input.type ?? "reaction_added",
        user: input.user ?? "U123",
        reaction: input.reaction,
        item: {
          type: input.itemType ?? "message",
          channel: "C123",
          ts: input.targetTs,
        },
        event_ts: "1713000001.000200",
      },
    },
  };
}

function emptySlackRouterConfig() {
  return {
    agents: {},
    routes: [],
    defaultAgent: "ravi-hil",
    defaultDmScope: "per-peer" as const,
    accountAgents: {},
    instanceToAccount: {},
    instances: {},
  };
}

describe("slackInboundReactionFromEnvelope", () => {
  it("maps Slack +1 / heart names onto the approval unicode set", () => {
    expect(
      slackInboundReactionFromEnvelope(reactionEnvelope({ reaction: "+1", targetTs: "1713000000.000100" })),
    ).toEqual({
      targetMessageId: "1713000000.000100",
      emoji: "👍",
      senderId: "U123",
    });
    expect(
      slackInboundReactionFromEnvelope(reactionEnvelope({ reaction: "thumbsup", targetTs: "1713000000.000100" })),
    ).toEqual({
      targetMessageId: "1713000000.000100",
      emoji: "👍",
      senderId: "U123",
    });
    expect(
      slackInboundReactionFromEnvelope(reactionEnvelope({ reaction: "heart", targetTs: "1713000000.000200" })),
    ).toEqual({
      targetMessageId: "1713000000.000200",
      emoji: "❤️",
      senderId: "U123",
    });
  });

  it("ignores non-message items, removals, and malformed events", () => {
    expect(
      slackInboundReactionFromEnvelope(reactionEnvelope({ reaction: "+1", targetTs: "F123", itemType: "file" })),
    ).toBeNull();
    expect(
      slackInboundReactionFromEnvelope(
        reactionEnvelope({ reaction: "+1", targetTs: "1713000000.000100", type: "reaction_removed" }),
      ),
    ).toBeNull();
    expect(
      slackInboundReactionFromEnvelope({
        envelope_id: "env-missing-item",
        payload: { event: { type: "reaction_added", user: "U123", reaction: "+1" } },
      }),
    ).toBeNull();
  });
});

describe("native Slack reaction_added", () => {
  let stateDir: string | null = null;
  const createdContextIds = new Set<string>();
  let subscribeEvents: Array<{ topic: string; data: Record<string, unknown> }> = [];
  let emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
  let requestReplyResult: { messageId?: string } = { messageId: "1713000000.000100" };

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-inbound-reaction-");
    subscribeEvents = [];
    emitted = [];
    requestReplyResult = { messageId: "1713000000.000100" };
    setApprovalServiceDependenciesForTest({
      now: () => APPROVAL_TEST_NOW_MS,
      requestReply: (async <T>(_topic: string, _data: Record<string, unknown>) => {
        return requestReplyResult as T;
      }) satisfies ApprovalServiceDependencies["requestReply"],
      finalizeSlackApproval: async () => {},
      nats: {
        emit: async (topic: string, data: Record<string, unknown>) => {
          emitted.push({ topic, data });
        },
        subscribe: ((...args: unknown[]) => {
          const topics = args.filter((arg): arg is string => typeof arg === "string");
          return (async function* () {
            for (const event of subscribeEvents) {
              if (topics.includes(event.topic)) {
                yield event;
              }
            }
          })();
        }) satisfies ApprovalServiceDependencies["nats"]["subscribe"],
      },
    });
  });

  afterEach(async () => {
    setApprovalServiceDependenciesForTest();
    for (const contextId of createdContextIds) {
      dbDeleteContext(contextId);
    }
    createdContextIds.clear();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function createService(published: Array<{ topic: string; payload: Record<string, unknown> }>) {
    return new SlackSocketModeService({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: "ravi-slack",
      routeAccountId: "ravi-slack",
      instanceId: "slack-instance-1",
      getRouterConfig: emptySlackRouterConfig,
      publishPrompt: async () => {
        throw new Error("Slack reactions must not create a session prompt");
      },
      publishInteraction: async (topic, payload) => {
        published.push({ topic, payload });
      },
      webClient: {} as never,
    });
  }

  it("publishes ravi.inbound.reaction and does not start a turn", async () => {
    const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const service = createService(published);

    await expect(
      service.handleEnvelope(reactionEnvelope({ reaction: "+1", targetTs: "1713000000.000100" })),
    ).resolves.toBe("processed");
    await expect(
      service.handleEnvelope(reactionEnvelope({ reaction: "+1", targetTs: "1713000000.000100" })),
    ).resolves.toBe("duplicate");

    expect(published).toEqual([
      {
        topic: "ravi.inbound.reaction",
        payload: {
          targetMessageId: "1713000000.000100",
          emoji: "👍",
          senderId: "U123",
        },
      },
    ]);
  });

  it("does not resolve Slack approval from reaction_added", async () => {
    const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const service = createService(published);
    await service.handleEnvelope(reactionEnvelope({ reaction: "+1", targetTs: "1713000000.000100" }));
    subscribeEvents = published.map((entry) => ({ topic: entry.topic, data: entry.payload }));
    seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Owner",
      tags: ["permission.admin"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "ravi-slack" },
    });

    const context = dbCreateContext({
      contextId: "ctx_slack_reaction_not_approval",
      contextKey: "rctx_slack_reaction_not_approval",
      kind: "agent-runtime",
      sessionName: "dev-main",
      capabilities: [],
      metadata: {
        approvalSource: {
          channel: "slack",
          accountId: "ravi-slack",
          chatId: "C123",
        },
      },
      createdAt: 1000,
    });
    createdContextIds.add(context.contextId);

    const result = await authorizeRuntimeContext({
      context,
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      timeoutMs: APPROVAL_TEST_TIMEOUT_MS,
    });

    expect(published[0]?.topic).toBe("ravi.inbound.reaction");
    expect(result).toMatchObject({
      allowed: false,
      approved: false,
      inherited: false,
    });
    expect(result.reason ?? "").toMatch(/Timeout/);
    expect(dbGetContext(context.contextId)?.capabilities).toEqual([]);
  });

  it("ignores file reactions and reaction_removed", async () => {
    const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const service = createService(published);

    await expect(
      service.handleEnvelope(reactionEnvelope({ reaction: "+1", targetTs: "F123", itemType: "file" })),
    ).resolves.toBe("ignored");
    await expect(
      service.handleEnvelope(
        reactionEnvelope({
          envelopeId: "env-removed",
          reaction: "+1",
          targetTs: "1713000000.000100",
          type: "reaction_removed",
        }),
      ),
    ).resolves.toBe("ignored");
    expect(published).toEqual([]);
  });

  it("does not start a turn for approval button interactions", async () => {
    const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const service = createService(published);

    await expect(
      service.handleEnvelope({
        envelope_id: "env-approval-button",
        payload: {
          type: "block_actions",
          team: { id: "T1" },
          user: { id: "U123" },
          channel: { id: "C123" },
          message: { ts: "1713000000.000100" },
          actions: [
            {
              type: "button",
              action_id: SLACK_APPROVAL_ACTION_APPROVE,
              value: "req_opaque",
            },
          ],
        },
      }),
    ).resolves.toBe("processed");

    expect(published).toEqual([
      {
        topic: "ravi.inbound.interaction",
        payload: expect.objectContaining({
          provider: "slack",
          actionId: SLACK_APPROVAL_ACTION_APPROVE,
          value: "req_opaque",
          userId: "U123",
          messageTs: "1713000000.000100",
        }),
      },
    ]);
  });
});
