import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { configStore } from "../../config-store.js";
import {
  closeRouterDb,
  dbAcceptChannelBackendIngress,
  dbCreateAgent,
  dbUpsertChannel,
  dbUpsertChat,
  dbUpsertChatMessage,
  getDb,
} from "../../router/router-db.js";
import type { MessageTarget, ResponseMediaAttachment } from "../../runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  processChannelOutboundJob,
  channelOutboundRequestFingerprint,
  type ChannelOutboundProcessingResult,
} from "../outbound-consumer.js";
import {
  getChannelOutboundReceipt,
  pruneExpiredChannelOutboundReceipts,
  sqliteChannelOutboundReceiptStore,
} from "../outbound-receipts.js";
import { getChannelOutboundPublishJob, saveChannelOutboundPublishJob } from "../outbound-publish-outbox.js";
import { buildChannelTextOutboundJob, type ChannelOutboundJob } from "../outbound-stream.js";
import type { NativeTextDelivery, NativeTextDeliveryRequest } from "../native/types.js";
import {
  createChannelBackendAutomaticOutputOrigin,
  resolveSlackAutomaticOutputContextFromBinding,
} from "./automatic-output-origin.js";
import {
  freezeSlackAutomaticTerminalManifest,
  getSlackAutomaticTerminalManifest,
} from "./automatic-terminal-manifest.js";
import { getSlackAutomaticOutputDecision, reserveSlackAutomaticOutput } from "./automatic-output-circuit.js";
import { deliverSlackAutomaticMedia } from "./automatic-media-output.js";
import { SlackTextDelivery, slackClientMessageId } from "./socket-mode.js";

let stateDir: string | null = null;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("slack-canonical-text-");
  dbCreateAgent({ id: "agent-a", name: "Agent A", cwd: stateDir });
  dbUpsertChannel({ name: "local", provider: "slack", credentialConnection: "installation-a" });
  configStore.refresh();
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function fixture(
  turn = "turn-a",
  freeze = true,
  threadId: string | undefined = "1.000001",
  media: ResponseMediaAttachment[] = [],
  text = "Complete answer",
) {
  const chat = dbUpsertChat({ channel: "slack", instanceId: "local", platformChatId: "C123", chatType: "group" });
  const message = dbUpsertChatMessage({
    chatId: chat.id,
    channel: "slack",
    instanceId: "local",
    providerMessageId: turn,
    rawChatId: "C123",
    actorType: "unknown",
    rawProvenance: { source: "slack.socket_mode", senderKind: "bot" },
  });
  dbAcceptChannelBackendIngress({
    channelInstanceId: "local",
    idempotencyKey: turn,
    requestFingerprint: turn,
    requestId: turn,
    localActorId: "bot",
    agentId: "agent-a",
    clientMessageId: turn,
    sessionKey: "agent:agent-a:slack:local:group:C123",
    sessionName: "session-a",
    turnId: turn,
    external: {
      channelKind: "slack",
      connectionId: "local",
      conversationId: threadId ? `C123~${threadId}` : "C123",
      senderId: "B123",
      messageId: turn,
    },
    content: {},
    receivedAt: 1,
    acceptedAt: 100,
    canonical: { chatId: chat.id, messageId: message.canonicalMessageId },
  });
  const binding = {
    channelInstanceId: "local",
    agentId: "agent-a",
    chatId: chat.id,
    messageId: message.canonicalMessageId,
    sessionId: "session-a",
    turnId: turn,
  };
  const context = resolveSlackAutomaticOutputContextFromBinding(binding)!;
  const freezeManifest = () => freezeSlackAutomaticTerminalManifest({ ...context, kind: "final_answer", text, media });
  const manifest = freeze ? freezeManifest() : undefined;
  const job = (wrapper: string) =>
    buildChannelTextOutboundJob({
      requestId: wrapper,
      sessionName: "session-a",
      emitId: wrapper,
      idempotencyKey: wrapper,
      target: context.target,
      text,
      format: "markdown",
      responsePhase: "final_answer",
      automatic: createChannelBackendAutomaticOutputOrigin(binding),
      ...(manifest ? { automaticTerminalResponseId: manifest.responseId } : {}),
    });
  return { binding, context, manifest, freezeManifest, job };
}

function delivery(send?: (request: NativeTextDeliveryRequest) => Promise<void>) {
  const requests: NativeTextDeliveryRequest[] = [];
  const adapter: NativeTextDelivery = {
    channelId: "slack",
    supports: () => true,
    deliverText: mock(async (request) => {
      requests.push(request);
      await send?.(request);
      return { provider: "slack", platformMessageId: "1.000009" };
    }),
  };
  return { adapter, requests };
}
const baseOptions = {
  emitEvent: async () => {},
  flushNats: async () => {},
  recordDeliveryTrace: () => null,
  persistDeliveredMessage: () => ({}),
  knowledgeGuard: () => null,
  now: () => 101,
};

describe("canonical Slack terminal text delivery", () => {
  it("sends one text part once across different wrapper IDs and fresh consumer invocations", async () => {
    const f = fixture();
    const d = delivery();
    for (const wrapper of ["output-a", "output-b", "output-c"]) {
      const result = await processChannelOutboundJob(f.job(wrapper), { ...baseOptions, deliveries: [d.adapter] });
      expect(result.disposition).toBe("ack");
    }
    expect(d.requests).toHaveLength(1);
    expect(d.requests[0]?.idempotencyKey).toBe(`${f.manifest!.responseId}:text`);
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.state).toBe("complete");
    expect(getChannelOutboundReceipt("output-a")).toBeNull();
    const future = Date.now() + 60 * 24 * 60 * 60 * 1_000;
    expect(pruneExpiredChannelOutboundReceipts(future, future)).toBe(0);
    closeRouterDb();
    await processChannelOutboundJob(f.job("after-restart-and-prune"), { ...baseOptions, deliveries: [d.adapter] });
    expect(d.requests).toHaveLength(1);
  });

  it("shares a send claim when different wrappers race and resumes bookkeeping without another send", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const d = delivery(async () => gate);
    const first = processChannelOutboundJob(f.job("first"), { ...baseOptions, deliveries: [d.adapter] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await processChannelOutboundJob(f.job("second"), { ...baseOptions, deliveries: [d.adapter] });
    expect(second).toMatchObject({ disposition: "nak", phase: "receipt_claim" });
    release();
    await first;
    await processChannelOutboundJob(f.job("second"), { ...baseOptions, deliveries: [d.adapter] });
    expect(d.requests).toHaveLength(1);
  });

  it("shares one canonical send claim and Slack token across two worker processes", async () => {
    if (!stateDir) throw new Error("isolated state missing");
    const f = fixture();
    const raced = await raceTextProcesses(stateDir, [f.job("worker-a"), f.job("worker-b")]);
    expect(new Set(raced.pids).size).toBe(2);
    expect(raced.pids).not.toContain(process.pid);
    expect(raced.results).toContainEqual({ disposition: "ack", status: "delivered", retryable: false });
    expect(raced.results.find((result) => result.disposition === "nak")).toMatchObject({ phase: "receipt_claim" });
    expect(raced.posts).toHaveLength(1);
    expect(raced.posts[0]).toMatchObject({
      channel: "C123",
      threadTs: "1.000001",
      clientMsgId: slackClientMessageId(`${f.manifest!.responseId}:text`),
    });
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)).toMatchObject({
      state: "complete",
      retainIdentity: true,
    });
    for (const wrapper of ["worker-a", "worker-b"]) expect(getChannelOutboundReceipt(wrapper)).toBeNull();
    const future = Date.now() + 60 * 24 * 60 * 60 * 1_000;
    expect(pruneExpiredChannelOutboundReceipts(future, future)).toBe(0);
    closeRouterDb();
    const d = delivery();
    await processChannelOutboundJob(f.job("after-workers-exit"), { ...baseOptions, deliveries: [d.adapter] });
    expect(d.requests).toHaveLength(0);
  }, 30_000);

  it("reuses the Slack token after provider success before receipt persistence without claiming exactly-once", async () => {
    const f = fixture();
    const post = mock(async (_request: unknown) => ({ ok: true, ts: "1.000009", messageId: "message", raw: {} }));
    const adapter = new SlackTextDelivery(
      { postMessage: post } as never,
      { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "channel_root" },
      undefined,
      { isKnowledgeGuardedChat: () => false },
    );
    const first = await processChannelOutboundJob(f.job("accepted-before-receipt"), {
      ...baseOptions,
      deliveries: [adapter],
      claimLeaseMs: 10,
      receiptStore: {
        ...sqliteChannelOutboundReceiptStore,
        recordSent: () => {
          throw new Error("receipt storage unavailable after provider success");
        },
      },
    });
    expect(first).toMatchObject({ disposition: "nak", phase: "receipt_write" });
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.state).toBe("claimed");
    closeRouterDb();
    const second = await processChannelOutboundJob(f.job("ambiguous-retry"), {
      ...baseOptions,
      deliveries: [adapter],
      now: () => 112,
    });
    expect(second).toMatchObject({ disposition: "ack", status: "delivered" });
    // Slack's acceptance-before-receipt window can produce a second call. Only
    // the stable provider token is guaranteed here, not remote exactly-once.
    expect(post).toHaveBeenCalledTimes(2);
    for (const [request] of post.mock.calls) {
      expect(request).toMatchObject({ clientMsgId: slackClientMessageId(`${f.manifest!.responseId}:text`) });
    }
  });

  it("keeps publication suppression keyed by the original wrapper while sharing the terminal receipt", async () => {
    const f = fixture();
    for (let i = 0; i < 4; i++)
      reserveSlackAutomaticOutput({
        idempotencyKey: `previous-${i}`,
        requestFingerprint: `previous-${i}`,
        scope: f.context.scope,
        sourceId: `input-${i}`,
        sourceReceivedAt: 1,
        now: 100,
      });
    const d = delivery();
    for (const wrapper of ["suppressed-a", "suppressed-b"]) {
      const job = f.job(wrapper);
      const savedPublication = saveChannelOutboundPublishJob(job, 100);
      const result = await processChannelOutboundJob(job, { ...baseOptions, deliveries: [d.adapter] });
      expect(result).toMatchObject({ disposition: "ack", status: "dropped" });
      expect(getChannelOutboundPublishJob(wrapper)).toMatchObject({
        status: "suppressed",
        requestFingerprint: savedPublication.requestFingerprint,
      });
    }
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.state).toBe("suppressed");
    expect(getChannelOutboundReceipt(`${f.manifest!.responseId}:text`)?.requestFingerprint).not.toBe(
      channelOutboundRequestFingerprint(f.job("suppressed-a")),
    );
    expect(d.requests).toHaveLength(0);
  });

  it("does not revive a wrapper suppressed before a manifest existed", async () => {
    const f = fixture("late-manifest", false);
    const job = f.job("early-output");
    const d = delivery();
    expect(await processChannelOutboundJob(job, { ...baseOptions, deliveries: [d.adapter] })).toMatchObject({
      status: "dropped",
    });
    f.freezeManifest();
    expect(await processChannelOutboundJob(job, { ...baseOptions, deliveries: [d.adapter] })).toMatchObject({
      status: "dropped",
    });
    expect(d.requests).toHaveLength(0);
  });

  it("honors the frozen thread after the replacement adapter switches to channel_root", async () => {
    const f = fixture();
    const post = mock(async (_request: unknown) => ({ ok: true, ts: "1.000009", messageId: "message", raw: {} }));
    const adapter = new SlackTextDelivery(
      { postMessage: post } as never,
      { subscriptionScope: "thread", threadReplyMode: "channel_root", rootReplyMode: "channel_root" },
      undefined,
      { isKnowledgeGuardedChat: () => false },
    );
    await processChannelOutboundJob(f.job("thread-output"), { ...baseOptions, deliveries: [adapter] });
    expect(post.mock.calls[0]?.[0]).toMatchObject({ channel: "C123", threadTs: "1.000001" });
    const explicit = f.job("explicit");
    delete explicit.request.origin.automatic;
    delete explicit.request.origin.automaticTerminalResponseId;
    explicit.request.policyHints = { _trustedFrozenTarget: true };
    (explicit.request as unknown as Record<string, unknown>)._trustedFrozenTarget = true;
    explicit.request.target = { ...explicit.request.target, ...{ _trustedFrozenTarget: true } };
    await processChannelOutboundJob(explicit, { ...baseOptions, deliveries: [adapter] });
    expect((post.mock.calls[1]?.[0] as { threadTs?: string })?.threadTs).toBeUndefined();
  });

  it("keeps a frozen root destination on a replacement same_thread adapter", async () => {
    const f = fixture("root-turn", true, "");
    const post = mock(async (_request: unknown) => ({ ok: true, ts: "1.000009", messageId: "message", raw: {} }));
    const adapter = new SlackTextDelivery(
      { postMessage: post } as never,
      { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "new_thread" },
      undefined,
      { isKnowledgeGuardedChat: () => false },
    );
    await processChannelOutboundJob(f.job("root-output"), { ...baseOptions, deliveries: [adapter] });
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0]?.[0] as { threadTs?: string })?.threadTs).toBeUndefined();
    const changed = f.job("forged-thread");
    changed.request.target = { ...changed.request.target, threadId: "9.999999" };
    changed.request.targetThreadId = "9.999999";
    (changed.request as unknown as Record<string, unknown>)._trustedFrozenTarget = true;
    expect(await processChannelOutboundJob(changed, { ...baseOptions, deliveries: [adapter] })).toMatchObject({
      status: "dropped",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  for (const frozenThread of ["1.000001", ""]) {
    for (const order of ["text-first", "media-first"] as const) {
      it(`keeps text and media at the frozen ${frozenThread ? "thread" : "root"} after database reopen and reply-policy change (${order})`, async () => {
        if (!stateDir) throw new Error("isolated state missing");
        const turn = `mixed-${frozenThread ? "thread" : "root"}-${order}`;
        const multipart = Boolean(frozenThread) && order === "media-first";
        const paragraphs = multipart
          ? Array.from({ length: 450 }, (_, index) => `Response paragraph ${index}: ${"full content ".repeat(20)}`)
          : ["Complete answer"];
        const media: ResponseMediaAttachment[] = Array.from({ length: multipart ? 2 : 1 }, (_, index) => ({
          type: "document",
          filePath: join(stateDir!, `${turn}-${index}.txt`),
          filename: `${turn}-${index}.txt`,
          caption: `Complete attachment ${index}`,
          source: "runtime.generated_media",
        }));
        for (const part of media) writeFileSync(part.filePath, `Complete attachment bytes for ${part.filename}`);
        const f = fixture(turn, true, frozenThread, media, paragraphs.join("\n\n"));
        const manifest = f.manifest!;
        expect(getSlackAutomaticOutputDecision(manifest.responseId)).toBeNull();
        const originalDb = getDb();
        closeRouterDb();
        expect(getDb()).not.toBe(originalDb);
        configStore.refresh();
        expect(getSlackAutomaticTerminalManifest(manifest.responseId)?.target).toEqual(manifest.target);

        const observed: Array<{ kind: "text" | "media"; channel: string; thread?: string }> = [];
        const post = mock(
          async (request: { channel: string; threadTs?: string; blocks?: Array<{ text?: string }> }) => {
            observed.push({ kind: "text", channel: request.channel, thread: request.threadTs });
            return { ok: true, ts: "1.000009", messageId: "message", raw: {} };
          },
        );
        const sendText = async () => {
          // The persisted ingress/manifest contains the old effective policy.
          // The replacement adapter now applies the opposite reply policy.
          const adapter = new SlackTextDelivery(
            { postMessage: post } as never,
            frozenThread
              ? { subscriptionScope: "thread", threadReplyMode: "channel_root", rootReplyMode: "channel_root" }
              : { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "new_thread" },
            undefined,
            { isKnowledgeGuardedChat: () => false },
          );
          expect(
            await processChannelOutboundJob(f.job(`${turn}-text`), {
              ...baseOptions,
              deliveries: [adapter],
            }),
          ).toMatchObject({ disposition: "ack", status: "delivered" });
        };
        const send = mock(
          async ({
            target,
            media: part,
            fileBytes,
          }: {
            target: MessageTarget;
            media: ResponseMediaAttachment;
            fileBytes: Buffer;
          }) => {
            expect(target).toEqual(manifest.target);
            expect(fileBytes).toEqual(Buffer.from(`Complete attachment bytes for ${part.filename}`));
            observed.push({ kind: "media", channel: target.chatId, thread: target.threadId });
            return { fileId: `F-${part.filename}`, messageId: "1.000010" };
          },
        );
        const sendMedia = async () => {
          for (const [mediaIndex, part] of media.entries()) {
            expect(
              await deliverSlackAutomaticMedia(
                {
                  sessionName: "session-a",
                  response: {
                    _automaticOutputOrigin: createChannelBackendAutomaticOutputOrigin(f.binding),
                    _automaticTerminalResponseId: manifest.responseId,
                  },
                  target: manifest.target,
                  media: part,
                  originalMedia: part,
                  mediaIndex,
                },
                {
                  send,
                  emitDelivery: async () => {},
                  flushTelemetry: async () => {},
                  now: () => 101,
                },
              ),
            ).toMatchObject({
              handled: true,
              status: "delivered",
              idempotencyKey: `${manifest.responseId}:media:${mediaIndex}`,
            });
          }
        };
        const assertOneTerminalDecision = () => {
          expect(getSlackAutomaticOutputDecision(manifest.responseId)).toEqual({ status: "allowed", decidedAt: 101 });
          expect(
            getDb()
              .prepare("SELECT idempotency_key, status FROM slack_automatic_output_decisions WHERE scope = ?")
              .all(manifest.scope),
          ).toEqual([{ idempotency_key: manifest.responseId, status: "allowed" }]);
        };
        const steps = order === "text-first" ? [sendText, sendMedia] : [sendMedia, sendText];
        await steps[0]!();
        assertOneTerminalDecision();
        closeRouterDb();
        configStore.refresh();
        await steps[1]!();
        assertOneTerminalDecision();
        const textPostCount = post.mock.calls.length;
        if (multipart) expect(textPostCount).toBeGreaterThan(4);
        else expect(textPostCount).toBe(1);
        const deliveredBody = post.mock.calls
          .flatMap(([request]) => request.blocks ?? [])
          .map((block) => block.text)
          .join("\n\n");
        for (const paragraph of paragraphs) expect(deliveredBody).toContain(paragraph.trim());
        const textParts = Array.from({ length: textPostCount }, () => "text" as const);
        const mediaParts = media.map(() => "media" as const);
        expect(observed).toEqual(
          (order === "text-first" ? [...textParts, ...mediaParts] : [...mediaParts, ...textParts]).map((kind) => ({
            kind,
            channel: "C123",
            thread: frozenThread || undefined,
          })),
        );
        for (const part of ["text", ...media.map((_, index) => `media:${index}`)]) {
          expect(getChannelOutboundReceipt(`${manifest.responseId}:${part}`)?.state).toBe("complete");
        }
        closeRouterDb();
        await sendText();
        await sendMedia();
        assertOneTerminalDecision();
        expect(post).toHaveBeenCalledTimes(textPostCount);
        expect(send).toHaveBeenCalledTimes(media.length);
      });
    }
  }

  it("resumes failed telemetry under another wrapper without resending the retained part", async () => {
    const f = fixture();
    const d = delivery();
    const first = await processChannelOutboundJob(f.job("first-telemetry"), {
      ...baseOptions,
      deliveries: [d.adapter],
      emitEvent: async () => {
        throw new Error("Disconnected");
      },
    });
    expect(first).toMatchObject({ disposition: "nak", phase: "telemetry_emit" });
    closeRouterDb();
    const emitEvent = mock(async (_topic: string, _payload: unknown) => {});
    const second = await processChannelOutboundJob(f.job("next-telemetry"), {
      ...baseOptions,
      deliveries: [d.adapter],
      emitEvent,
    });
    expect(second).toMatchObject({ disposition: "ack", status: "delivered" });
    expect(d.requests).toHaveLength(1);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        idempotencyKey: `${f.manifest!.responseId}:text`,
        publicationIdempotencyKey: "next-telemetry",
        jobId: "next-telemetry",
      }),
    );
  });

  it("rejects a different source session or canonical chat without poisoning the real part", async () => {
    const f = fixture();
    const d = delivery();
    const otherSession = f.job("wrong-session");
    otherSession.request.origin.sessionName = "another-session";
    const otherChat = f.job("wrong-canonical-chat");
    otherChat.request.target = { ...otherChat.request.target, canonicalChatId: "another-canonical-chat" };
    for (const job of [otherSession, otherChat]) {
      expect(await processChannelOutboundJob(job, { ...baseOptions, deliveries: [d.adapter] })).toMatchObject({
        status: "dropped",
      });
    }
    expect(d.requests).toHaveLength(0);
    await processChannelOutboundJob(f.job("valid"), { ...baseOptions, deliveries: [d.adapter] });
    expect(d.requests).toHaveLength(1);
  });
});

async function raceTextProcesses(stateDir: string, jobs: ChannelOutboundJob[]) {
  const runDir = join(stateDir, "canonical-text-workers");
  const isolatedHome = join(runDir, "home");
  mkdirSync(isolatedHome, { recursive: true });
  const fixturePath = join(runDir, "worker.test.ts");
  const preload = fileURLToPath(new URL("../../test/isolated-runtime-preload.ts", import.meta.url));
  writeFileSync(
    fixturePath,
    `import { test, expect, mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
const config = JSON.parse(process.env.TEST_CANONICAL_TEXT_WORKER);
const actualOs = { ...(await import("node:os")) };
mock.module("node:os", () => ({ ...actualOs, homedir: () => config.home }));
process.env.RAVI_STATE_DIR = config.stateDir;
async function waitFor(path) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(existsSync(path)).toBe(true);
}
test("deliver from a separate consumer process", async () => {
  const { processChannelOutboundJob } = await import(${JSON.stringify(new URL("../outbound-consumer.ts", import.meta.url).href)});
  const { SlackTextDelivery } = await import(${JSON.stringify(new URL("./socket-mode.ts", import.meta.url).href)});
  const { configStore } = await import(${JSON.stringify(new URL("../../config-store.ts", import.meta.url).href)});
  const router = await import(${JSON.stringify(new URL("../../router/router-db.ts", import.meta.url).href)});
  try {
    configStore.refresh();
    const adapter = new SlackTextDelivery({ postMessage: async (request) => {
      writeFileSync(config.sent, JSON.stringify(request));
      await waitFor(config.release);
      return { ok: true, ts: "1.000009", messageId: "message", raw: {} };
    } }, { subscriptionScope: "thread", threadReplyMode: "same_thread", rootReplyMode: "channel_root" },
      undefined, { isKnowledgeGuardedChat: () => false });
    writeFileSync(config.ready, String(process.pid));
    await waitFor(config.start);
    const result = await processChannelOutboundJob(config.job, {
      deliveries: [adapter], emitEvent: async () => {}, flushNats: async () => {},
      recordDeliveryTrace: () => null, persistDeliveredMessage: () => ({}),
      knowledgeGuard: () => null, now: () => 101,
    });
    writeFileSync(config.result, JSON.stringify(result));
  } finally { router.closeRouterDb(); }
}, 20000);
`,
  );
  const start = join(runDir, "start");
  const release = join(runDir, "release");
  const workers = jobs.map((job, index) => {
    const ready = join(runDir, `ready-${index}`);
    const sent = join(runDir, `sent-${index}.json`);
    const result = join(runDir, `result-${index}.json`);
    const child = spawn(process.execPath, ["test", "--preload", preload, fixturePath], {
      env: {
        ...process.env,
        TEST_CANONICAL_TEXT_WORKER: JSON.stringify({
          stateDir,
          home: isolatedHome,
          ready,
          sent,
          result,
          start,
          release,
          job,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk) => {
      log += chunk;
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Text worker failed (${code}): ${log}`))));
    });
    void exited.catch(() => {});
    return { child, ready, sent, result, exited };
  });
  const waitUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate() && Date.now() < deadline) {
      for (const worker of workers) if (worker.child.exitCode !== null) await worker.exited;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(predicate()).toBe(true);
  };
  try {
    await waitUntil(() => workers.every((worker) => existsSync(worker.ready)));
    writeFileSync(start, "start");
    // Keep the successful provider call open until the other process has either
    // returned its claim result or exposed an erroneous second provider call.
    await waitUntil(() => workers.every((worker) => existsSync(worker.sent) || existsSync(worker.result)));
    writeFileSync(release, "release");
    await Promise.all(workers.map((worker) => worker.exited));
    return {
      pids: workers.map((worker) => Number(readFileSync(worker.ready, "utf8"))),
      results: workers.map(
        (worker) => JSON.parse(readFileSync(worker.result, "utf8")) as ChannelOutboundProcessingResult,
      ),
      posts: workers
        .filter((worker) => existsSync(worker.sent))
        .map((worker) => JSON.parse(readFileSync(worker.sent, "utf8")) as { clientMsgId?: string }),
    };
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    await Promise.allSettled(workers.map((worker) => worker.exited));
  }
}
