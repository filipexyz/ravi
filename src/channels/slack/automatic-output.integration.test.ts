import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { configStore } from "../../config-store.js";
import {
  closeRouterDb,
  dbCreateAgent,
  dbGetChannelBackendIngressReceiptByTurnId,
  dbGetChannelBackendRuntimeState,
  dbGetChatMessage,
  dbUpsertChannel,
  dbUpsertInstance,
  getDb,
} from "../../router/router-db.js";
import { closeSessionStore } from "../../router/sessions.js";
import type { RouterConfig } from "../../router/types.js";
import type { ChannelBackendPromptMetadata, MessageTarget } from "../../runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { channelOutputSinks } from "../backend.js";
import { processChannelOutboundJob, type ChannelOutboundProcessingResult } from "../outbound-consumer.js";
import {
  getChannelOutboundPublishJob,
  getChannelOutboundPublishOutboxSummary,
  publishChannelOutboundJobDurably,
  reconcileDueChannelOutboundPublishes,
} from "../outbound-publish-outbox.js";
import { getChannelOutboundReceipt } from "../outbound-receipts.js";
import type { ChannelOutboundJob } from "../outbound-stream.js";
import { channelRuntimeEventSinks, projectChannelRuntimeEvent } from "../runtime-events.js";
import { createSlackNativeChannelDriver } from "./driver.js";
import { resolveSlackAutomaticOutputContextFromBinding } from "./automatic-output-origin.js";
import {
  freezeSlackAutomaticTerminalManifest,
  slackAutomaticTerminalResponseId,
} from "./automatic-terminal-manifest.js";
import { slackClientMessageId } from "./client-message-id.js";
import { SlackSocketModeService, SlackTextDelivery } from "./socket-mode.js";
import type { SlackRoutingPolicy, SlackSocketEnvelope } from "./types.js";

const WINDOW_MS = 5 * 60_000;
const INITIAL_TIME = 1_793_750_000_000;
const CHANNEL = "CACCEPTANCE";

interface PublishedTurn {
  sessionName: string;
  payload: Record<string, unknown>;
  metadata: ChannelBackendPromptMetadata;
}

interface ProviderReply {
  text: string;
  commentary?: string[];
  error?: string;
}

interface WireMessage {
  channel: string;
  text: string;
  blocks?: readonly { type: string; text?: unknown }[];
  threadTs?: string;
  clientMsgId?: string;
  ts: string;
}

// Real Socket Mode admission, canonical SQLite backend/runtime projection,
// native driver sinks, durable publication and consumer/receipt processing.
// Only the model and Slack HTTP transport are substituted. Delivered wire
// messages enqueue new peer ingress; the test never invents later loop turns.
class SlackLoopHarness {
  time = INITIAL_TIME;
  sequence = 0;
  readonly work: Array<() => Promise<void>> = [];
  readonly peers: SlackPeer[] = [];
  readonly results: Array<{ job: ChannelOutboundJob; result: ChannelOutboundProcessingResult }> = [];
  readonly telemetry: Array<Record<string, unknown>> = [];

  now = () => this.time;

  timestamp(): string {
    return `${Math.floor(this.time / 1_000)}.${String(++this.sequence).padStart(6, "0")}`;
  }

  async peer(name: string, options: { routingPolicy?: Partial<SlackRoutingPolicy>; instanceId?: string } = {}) {
    const peer = new SlackPeer(this, name, options);
    this.peers.push(peer);
    await peer.initialize();
    return peer;
  }

  async drain(maxWork = 200): Promise<void> {
    for (let count = 0; this.work.length > 0; count++) {
      if (count >= maxWork) throw new Error(`Automatic reply queue did not drain after ${maxWork} operations`);
      await this.work.shift()!();
    }
  }

  async consume(job: ChannelOutboundJob): Promise<ChannelOutboundProcessingResult> {
    const result = await processChannelOutboundJob(job, {
      deliveries: this.peers.map((peer) => peer.delivery),
      now: this.now,
      knowledgeGuard: () => null,
      emitEvent: async (_topic, payload) => {
        this.telemetry.push(payload as Record<string, unknown>);
      },
      flushNats: async () => {},
      recordDeliveryTrace: () => null,
    });
    this.results.push({ job, result });
    return result;
  }

  async reconcile(): Promise<void> {
    const result = await reconcileDueChannelOutboundPublishes({
      now: this.now,
      publisher: async (job) => {
        this.work.push(async () => {
          await this.consume(job);
        });
      },
      emitEvent: async () => {},
    });
    expect(result.attempted).toBe(0);
    await this.drain();
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) await peer.stop();
  }
}

class SlackPeer {
  readonly turns: PublishedTurn[] = [];
  readonly jobs: ChannelOutboundJob[] = [];
  readonly wire: WireMessage[] = [];
  readonly delivery: SlackTextDelivery;
  readonly service: SlackSocketModeService;
  readonly config: RouterConfig;
  readonly botId: string;
  readonly userId: string;
  readonly instanceId: string;
  readonly routingPolicy: SlackRoutingPolicy;
  provider: (turn: PublishedTurn, index: number) => ProviderReply = (_turn, index) => ({ text: `Response ${index}` });
  onWire?: (message: WireMessage) => void;
  private stopRuntime?: () => Promise<void>;

  constructor(
    readonly harness: SlackLoopHarness,
    readonly name: string,
    options: { routingPolicy?: Partial<SlackRoutingPolicy>; instanceId?: string },
  ) {
    this.instanceId = options.instanceId ?? name;
    this.botId = `B${name.toUpperCase().replaceAll("-", "")}`;
    this.userId = `U${name.toUpperCase().replaceAll("-", "")}`;
    this.routingPolicy = {
      subscriptionScope: "thread",
      threadReplyMode: "same_thread",
      rootReplyMode: "channel_root",
      ...options.routingPolicy,
    };
    dbCreateAgent({ id: name, name, cwd: `/tmp/${name}` });
    dbUpsertChannel({ name, provider: "slack", credentialConnection: name });
    const instance = dbUpsertInstance({
      name,
      instanceId: this.instanceId,
      channel: "slack",
      dmPolicy: "open",
      groupPolicy: "open",
      contactIntakeMode: "off",
    });
    this.config = {
      agents: { [name]: { id: name, cwd: `/tmp/${name}`, dmScope: "per-peer" } },
      routes: [{ pattern: "*", accountId: name, agent: name, priority: 100, policy: "open", channel: "slack" }],
      defaultAgent: name,
      defaultDmScope: "per-peer",
      accountAgents: { [name]: name },
      instanceToAccount: { [this.instanceId]: name },
      instances: { [name]: instance },
    };
    configStore.refresh();
    const webClient = {
      authTest: async () => ({ ok: true, bot_id: this.botId, user_id: this.userId, team_id: "TACCEPTANCE" }),
      postMessage: async (input: Omit<WireMessage, "ts">) => {
        const message = { ...input, ts: harness.timestamp() };
        this.wire.push(message);
        this.onWire?.(message);
        return { channel: input.channel, ts: message.ts, messageId: message.ts, raw: { ok: true } };
      },
    };
    this.delivery = new SlackTextDelivery(
      webClient as never,
      this.routingPolicy,
      {
        accountId: name,
        routeAccountId: name,
        instanceId: this.instanceId,
        instanceAliases: [name, this.instanceId],
      },
      { isKnowledgeGuardedChat: () => false },
    );
    this.service = new SlackSocketModeService({
      appToken: "xapp-fixture",
      botToken: "xoxb-fixture",
      accountId: name,
      routeAccountId: name,
      instanceId: this.instanceId,
      routingPolicy: this.routingPolicy,
      getRouterConfig: () => this.config,
      webClient: webClient as never,
      now: harness.now,
      publishPrompt: async (sessionName, payload) => {
        const turn = { sessionName, payload, metadata: payload._channelBackend as ChannelBackendPromptMetadata };
        this.turns.push(turn);
        harness.work.push(async () => {
          await this.runProvider(turn);
        });
      },
    });
  }

  async initialize(): Promise<void> {
    const driver = createSlackNativeChannelDriver(
      {},
      {
        now: this.harness.now,
        createRuntime: async () => ({
          id: this.name,
          accountId: this.name,
          instanceId: this.instanceId,
          connection: this.name,
          delivery: this.delivery,
          actions: { channelId: "slack", supports: () => true, executeChatAction: async () => ({ provider: "slack" }) },
          presence: {
            channelId: "slack",
            supports: () => true,
            sendPresence: async () => ({ provider: "slack", status: "inactive" }),
          },
          socketMode: this.service,
        }),
        publishOutbound: async (job) => {
          this.jobs.push(job);
          return publishChannelOutboundJobDurably(job, {
            now: this.harness.now,
            publisher: async (saved) => {
              this.harness.work.push(async () => {
                await this.harness.consume(saved);
              });
            },
          });
        },
      },
    );
    const runtime = await driver.createRuntime({
      channel: { name: this.name, provider: "slack", credentialConnection: this.name },
      host: {
        registerOutputSink: channelOutputSinks.register.bind(channelOutputSinks),
        registerRuntimeEventSink: channelRuntimeEventSinks.register.bind(channelRuntimeEventSinks),
      } as never,
    });
    this.stopRuntime = async () => {
      await runtime.stop();
    };
  }

  async stop(): Promise<void> {
    await this.stopRuntime?.();
  }

  envelope(
    text: string,
    options: { botId?: string; userId?: string; human?: boolean; channel?: string; thread?: string; ts?: string } = {},
  ): SlackSocketEnvelope {
    const ts = options.ts ?? this.harness.timestamp();
    return {
      envelope_id: `envelope-${this.name}-${ts}`,
      payload: {
        team_id: "TACCEPTANCE",
        event_id: `event-${this.name}-${ts}`,
        event_time: Math.floor(this.harness.time / 1_000),
        event: {
          type: "message",
          channel: options.channel ?? CHANNEL,
          channel_type: "channel",
          text,
          ts,
          ...(options.thread ? { thread_ts: options.thread } : {}),
          ...(options.human
            ? { user: options.userId ?? "UUNLINKEDHUMAN" }
            : {
                subtype: "bot_message",
                bot_id: options.botId ?? "BEXTERNAL",
                ...(options.userId ? { user: options.userId } : {}),
              }),
        },
      },
    };
  }

  async notice(text: string, options: Parameters<SlackPeer["envelope"]>[1] = {}): Promise<void> {
    expect(await this.service.handleEnvelope(this.envelope(text, options))).toBe("processed");
  }

  connect(receiver: SlackPeer, delayMs = 0): void {
    this.onWire = (message) => {
      this.harness.work.push(async () => {
        this.harness.time += delayMs;
        await receiver.notice(message.text, {
          botId: this.botId,
          userId: this.userId,
          channel: message.channel,
          thread: message.threadTs,
        });
      });
    };
  }

  async runProvider(turn: PublishedTurn): Promise<void> {
    const receipt = dbGetChannelBackendIngressReceiptByTurnId(turn.metadata.binding.turnId);
    expect(receipt?.state).toBe("published");
    expect(turn.payload._skipTurn).toBeUndefined();
    // A transactional domain effect demonstrates that suppression happens
    // downstream of execution, including every independent burst input.
    getDb()
      .prepare("INSERT INTO acceptance_business_effects (turn_id, prompt) VALUES (?, ?)")
      .run(turn.metadata.binding.turnId, String(turn.payload.prompt));
    const reply = this.provider(turn, this.turns.indexOf(turn) + 1);
    for (const text of reply.commentary ?? []) {
      await projectChannelRuntimeEvent({
        metadata: turn.metadata,
        occurredAt: this.harness.time,
        event: { type: "assistant.message", text, metadata: { item: { phase: "commentary" } } },
      });
    }
    // Match the production host's freeze-before-projection boundary.
    await this.prepareTerminal(turn, reply);
    await projectChannelRuntimeEvent({
      metadata: turn.metadata,
      occurredAt: this.harness.time,
      event: reply.error
        ? { type: "turn.failed", error: reply.error, recoverable: false }
        : { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
      ...(reply.error ? {} : { responseText: reply.text }),
    });
  }

  async prepareTerminal(turn: PublishedTurn, reply: ProviderReply): Promise<void> {
    const origin = resolveSlackAutomaticOutputContextFromBinding(turn.metadata.binding);
    if (!origin) return;
    freezeSlackAutomaticTerminalManifest({
      ...origin,
      kind: reply.error ? "safe_error" : "final_answer",
      text: reply.error ? "The agent could not complete this request because of an internal error." : reply.text.trim(),
      media: [],
    });
  }
}

describe("Slack automatic replies through real intake and delivery", () => {
  let stateDir: string | null = null;
  let harness: SlackLoopHarness;
  let dateNow: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-automatic-acceptance-");
    harness = new SlackLoopHarness();
    dateNow = spyOn(Date, "now").mockImplementation(harness.now);
    getDb().exec("CREATE TABLE acceptance_business_effects (turn_id TEXT PRIMARY KEY, prompt TEXT NOT NULL)");
  });

  afterEach(async () => {
    await harness.stop();
    dateNow.mockRestore();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function effects(): number {
    return (getDb().prepare("SELECT COUNT(*) AS count FROM acceptance_business_effects").get() as { count: number })
      .count;
  }

  function assertCompleted(peer: SlackPeer): void {
    for (const turn of peer.turns) {
      const runtime = dbGetChannelBackendRuntimeState(turn.metadata.binding.turnId);
      expect(runtime?.state).toBe("completed");
      expect(dbGetChatMessage(runtime!.assistantMessageId!)?.content).toMatchObject({
        blocks: [{ type: "text", text: expect.stringContaining("Response") }],
      });
    }
  }

  it("processes ten independent unmentioned notices exactly once while terminally suppressing excess replies", async () => {
    const peer = await harness.peer("notice-peer");
    for (let i = 0; i < 10; i++) {
      await peer.notice(`Independent business notice ${i}`, { botId: `BFOREIGN${i}` });
      await harness.drain();
      harness.time += 1_000;
    }
    expect(peer.turns).toHaveLength(10);
    expect(effects()).toBe(10);
    assertCompleted(peer);
    expect(peer.wire).toHaveLength(4);
    expect(harness.results.filter(({ result }) => result.status === "dropped")).toHaveLength(6);
    const suppressed = harness.results.filter(({ result }) => result.status === "dropped");
    for (const { job, result } of suppressed) {
      const origin = resolveSlackAutomaticOutputContextFromBinding(job.request.origin.automatic!.binding)!;
      const receiptKey = `${slackAutomaticTerminalResponseId(origin.turnId, origin.target)}:text`;
      expect(result.disposition).toBe("ack");
      expect(getChannelOutboundReceipt(receiptKey)).toMatchObject({
        state: "suppressed",
        suppressionReason: "slack_bot_reply_cooldown",
      });
      expect(getChannelOutboundReceipt(receiptKey)?.platformMessageId).toBeUndefined();
      expect(getChannelOutboundPublishJob(job.request.idempotencyKey)?.status).toBe("suppressed");
    }
    expect(getChannelOutboundPublishOutboxSummary().pendingCount).toBe(0);
    const duplicate = peer.envelope("Independent business notice 0", {
      botId: "BFOREIGN0",
      ts: (peer.turns[0]!.payload.source as MessageTarget).sourceMessageId,
    });
    await peer.service.handleEnvelope(duplicate);
    await harness.drain();
    expect(effects()).toBe(10);
  });

  it("drains an actual fast two-peer reply loop and never replays old outputs after restart or cooldown", async () => {
    const a = await harness.peer("peer-a");
    const b = await harness.peer("peer-b");
    a.connect(b);
    b.connect(a);
    await a.notice("Start a reply-on-message exchange");
    await harness.drain();
    expect(a.wire).toHaveLength(4);
    expect(b.wire).toHaveLength(4);
    expect(a.turns).toHaveLength(5);
    expect(b.turns).toHaveLength(4);
    expect(effects()).toBe(9);
    assertCompleted(a);
    assertCompleted(b);
    expect(harness.work).toHaveLength(0);
    const suppressed = harness.results.find(({ result }) => result.status === "dropped")!;
    expect(suppressed).toBeDefined();
    a.onWire = undefined;
    b.onWire = undefined;
    closeSessionStore();
    closeRouterDb();
    harness.time += WINDOW_MS + 1;
    await harness.reconcile();
    expect((await harness.consume(suppressed.job)).status).toBe("dropped");
    expect(a.wire.length + b.wire.length).toBe(8);
    expect(effects()).toBe(9);
    await a.notice("A genuinely new independent notice after recovery");
    await harness.drain();
    expect(a.wire).toHaveLength(5);
    expect(effects()).toBe(10);
  });

  it("documents the slow-loop limit: changing replies beyond the window continue without suppression", async () => {
    const a = await harness.peer("slow-a");
    const b = await harness.peer("slow-b");
    a.connect(b, WINDOW_MS + 1);
    b.connect(a, WINDOW_MS + 1);
    const changingReply = (peer: SlackPeer) => (_turn: PublishedTurn, index: number) => {
      if (a.turns.length + b.turns.length === 12) {
        a.onWire = undefined;
        b.onWire = undefined;
      }
      return { text: `Response from ${peer.name}, distinct sequence ${index}` };
    };
    a.provider = changingReply(a);
    b.provider = changingReply(b);
    await a.notice("Start slow exchange");
    await harness.drain();
    expect(effects()).toBe(12);
    expect(a.wire.length + b.wire.length).toBe(12);
    expect(new Set([...a.wire, ...b.wire].map(({ text }) => text)).size).toBe(12);
    expect(harness.results.every(({ result }) => result.status === "delivered")).toBe(true);
  });

  it("keeps repeated bot commentary local and preserves the complete final terminal reply", async () => {
    const peer = await harness.peer("progress-peer");
    peer.provider = () => ({
      text: "Response with the complete final result",
      commentary: Array.from({ length: 8 }, (_, i) => `Progress ${i}`),
    });
    for (let i = 0; i < 5; i++) {
      await peer.notice(`Independent request ${i}`);
      await harness.drain();
    }
    expect(effects()).toBe(5);
    expect(peer.wire).toHaveLength(4);
    expect(peer.wire.every(({ text }) => text.includes("complete final result"))).toBe(true);
    expect(peer.wire.some(({ text }) => text.includes("Progress"))).toBe(false);
    assertCompleted(peer);
  });

  it("counts a complete multipart final as one response and never cuts its text at four physical posts", async () => {
    const peer = await harness.peer("multipart-peer");
    const text = Array.from({ length: 450 }, (_, i) => `Response paragraph ${i}: ${"full content ".repeat(20)}`).join(
      "\n\n",
    );
    peer.provider = () => ({ text });
    await peer.notice("Return the complete long result");
    await harness.drain();
    expect(peer.wire.length).toBeGreaterThan(4);
    // Slack's notification fallback summarizes the message; its Markdown
    // blocks hold the full body. Check every paragraph in the actual posts.
    const deliveredBody = peer.wire
      .flatMap((message) => message.blocks ?? [])
      .map((block) => block.text)
      .join("\n\n");
    for (let i = 0; i < 450; i++) expect(deliveredBody).toContain(`Response paragraph ${i}:`);
    expect(harness.results.filter(({ result }) => result.status === "delivered")).toHaveLength(1);
    expect(effects()).toBe(1);
    expect(
      dbGetChatMessage(dbGetChannelBackendRuntimeState(peer.turns[0]!.metadata.binding.turnId)!.assistantMessageId!)
        ?.content,
    ).toEqual({ blocks: [{ type: "text", text: text.trim() }] });
  });

  it("keeps equal rendered fragments and a new turn with the same text distinct under stable canonical tokens", async () => {
    const peer = await harness.peer("equal-fragments-peer");
    const paragraph = "R".repeat(6_000);
    peer.provider = () => ({ text: [paragraph, paragraph, paragraph].join("\n\n") });
    for (const notice of ["First independent request", "Second independent request"]) {
      await peer.notice(notice);
      await harness.drain();
    }
    expect(effects()).toBe(2);
    expect(peer.wire).toHaveLength(6);
    const firstTurnBodies = peer.wire.slice(0, 3).map((message) => JSON.stringify(message.blocks));
    expect(new Set(firstTurnBodies).size).toBeLessThan(firstTurnBodies.length);
    expect(peer.wire.slice(3).map((message) => JSON.stringify(message.blocks))).toEqual(firstTurnBodies);
    expect(new Set(peer.wire.map((message) => message.clientMsgId)).size).toBe(6);
    const expectedTokens = peer.turns.flatMap((turn) => {
      const origin = resolveSlackAutomaticOutputContextFromBinding(turn.metadata.binding)!;
      const partId = `${slackAutomaticTerminalResponseId(origin.turnId, origin.target)}:text`;
      return [0, 1, 2].map((index) => slackClientMessageId(index === 0 ? partId : `${partId}:part:${index}`));
    });
    expect(peer.wire.map((message) => message.clientMsgId)).toEqual(expectedTokens);
    closeSessionStore();
    closeRouterDb();
    for (const job of peer.jobs) {
      expect((await harness.consume(job)).status).toBe("delivered");
      expect((await harness.consume(job)).status).toBe("delivered");
    }
    expect(peer.wire).toHaveLength(6);
  });
});
