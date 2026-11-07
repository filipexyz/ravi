import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { spawn } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeSessionStore, getOrCreateSession } from "../../router/sessions.js";
import { closeRouterDb, getDb } from "../../router/router-db.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import type { RuntimeLaunchPrompt } from "../../runtime/message-types.js";
import { RuntimeStartCapacityError } from "../../runtime/start-admission.js";
import { recordSessionEvent, upsertSessionTurn } from "../../session-trace/session-trace-db.js";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  withoutRaviRuntimeContextEnv,
} from "../../test/ravi-state.js";
import { registerInboundSlackThread } from "./thread-lifecycle-store.js";
import { reconcileSlackThreadLifecycle } from "./thread-lifecycle.js";
import { admitThreadAttention } from "./thread-attention-admission.js";

let state: string;
let now: number;
const parentKey = "admission-parent";
const childKey = "admission-parent:thread:1713000000.000100";
const childName = "admission-child";
const requestId = "admission-thread";
const firstTurn = "admission-turn-1";

function seedTurn(turnId: string, startedAt: number) {
  upsertSessionTurn({
    turnId,
    sessionKey: childKey,
    sessionName: childName,
    status: "running",
    startedAt,
    updatedAt: startedAt,
  });
  const caller = createRuntimeContext({
    kind: "turn-runtime",
    agentId: "main",
    sessionKey: childKey,
    sessionName: childName,
    capabilities: [],
  });
  recordSessionEvent({
    sessionKey: childKey,
    sessionName: childName,
    turnId,
    eventType: "adapter.request",
    eventGroup: "runtime",
    timestamp: startedAt,
    payloadJson: { context_id: caller.contextId },
  });
}

beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-attention-admission-");
  now = Date.now();
  getOrCreateSession(parentKey, "main", "/tmp/ravi", { name: parentKey });
  getOrCreateSession(childKey, "main", "/tmp/ravi", { name: childName });
  registerInboundSlackThread({
    requestId,
    parentSessionKey: parentKey,
    parentSessionName: parentKey,
    childSessionKey: childKey,
    childSessionName: childName,
    accountId: "test-slack",
    instanceId: "test-slack",
    platformChatId: "C_TEST",
    threadCanonicalChatId: "chat-test",
    providerThreadId: "1713000000.000100",
    seenAt: now - 20 * 60_000,
  });
  seedTurn(firstTurn, now - 20 * 60_000);
});
afterEach(async () => {
  await cleanupIsolatedRaviState(state);
});

async function run(mode: string, at: number) {
  const child = spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dir, "../../test/shared-state-child-preload.ts"),
      join(import.meta.dir, "thread-attention-crash.fixture.ts"),
      mode,
      String(at),
    ],
    {
      env: { ...withoutRaviRuntimeContextEnv(), RAVI_STATE_DIR: state, NATS_URL: "nats://127.0.0.1:1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, error: code === 0 || code === 23 ? "" : `${stdout}\n${stderr}` }).toEqual({
    code: mode.startsWith("crash-") ? 23 : 0,
    error: "",
  });
}
function handled() {
  const path = join(state, "handled.jsonl");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

async function notice(): Promise<RuntimeLaunchPrompt> {
  let captured: RuntimeLaunchPrompt | undefined;
  const result = await reconcileSlackThreadLifecycle({
    now: () => now,
    publishEvent: async () => {},
    publishPrompt: async (_name, payload) => {
      captured = payload as unknown as RuntimeLaunchPrompt;
    },
  });
  expect(result.failures).toBe(0);
  expect(captured).toBeDefined();
  return captured!;
}
function status() {
  return (
    getDb().query("SELECT admission_status FROM slack_thread_attention_notices WHERE turn_id=?").get(firstTurn) as {
      admission_status: string;
    }
  ).admission_status;
}

describe("durable thread attention admission", () => {
  it("retries a pending notice when broker dedup ACKs an already expired transport message", async () => {
    await run("crash-before-consume", now);
    // Stream TTL (60s) is shorter than dedup (120s): this ACK carries no deliverable message.
    await run("restart", now + 90_000);
    expect(handled()).toHaveLength(0);
    await run("restart", now + 121_000);
    expect(handled()).toHaveLength(1);
    const deliveries = JSON.parse(readFileSync(join(state, "broker.json"), "utf8"));
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1].id).toBe(deliveries[0].id);
  }, 20_000);

  it("claims once across concurrent consumers and database reopen", async () => {
    const prompt = await notice();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = mock(async () => {
      await hold;
    });
    const first = admitThreadAttention(parentKey, prompt, handle);
    expect(status()).toBe("accepting");
    expect(await admitThreadAttention(parentKey, prompt, handle)).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
    release();
    await first;
    closeSessionStore();
    closeRouterDb();
    expect(status()).toBe("admitted");
    expect(await admitThreadAttention(parentKey, prompt, handle)).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("permits only a typed pre-handoff capacity refusal to retry", async () => {
    const prompt = await notice();
    const error = new RuntimeStartCapacityError({
      lane: "background",
      reason: "concurrency_limit",
      active: 1,
      reserved: 0,
      max: 1,
      backgroundLimit: 1,
      queuePosition: null,
      occupants: [],
      largestConsumer: null,
    });
    await expect(
      admitThreadAttention(parentKey, prompt, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(status()).toBe("refused");
    closeSessionStore();
    closeRouterDb();
    const handle = mock(async () => {});
    expect(await admitThreadAttention(parentKey, prompt, handle)).toBe(true);
    expect(status()).toBe("admitted");
    await admitThreadAttention(parentKey, prompt, handle);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it.each(["uncertain", "accepting"])("never guesses away %s after consumer restart", async (outcome) => {
    const prompt = await notice();
    if (outcome === "uncertain") {
      await expect(
        admitThreadAttention(parentKey, prompt, async () => {
          throw new Error("handoff outcome unknown");
        }),
      ).rejects.toThrow("handoff outcome unknown");
    } else {
      getDb().query("UPDATE slack_thread_attention_notices SET admission_status='accepting'").run();
    }
    closeSessionStore();
    closeRouterDb();
    const handle = mock(async () => {});
    expect(await admitThreadAttention(parentKey, prompt, handle)).toBe(true);
    expect(status()).toBe(outcome);
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects unknown occurrences and changed target, authority, physical correlation, or execution flags", async () => {
    const prompt = await notice();
    const handle = mock(async () => {});
    await expect(admitThreadAttention(childName, prompt, handle)).rejects.toThrow("target differs");
    const changed: RuntimeLaunchPrompt[] = [
      { ...prompt, prompt: "different work" },
      { ...prompt, _runtimePrompt: "different hidden work" },
      { ...prompt, _interactiveStart: true },
      { ...prompt, _taskAssignmentId: "bypass" },
      { ...prompt, _decisionDeliveryId: "bypass" },
      { ...prompt, source: { ...prompt.source!, chatId: "OTHER" } },
      { ...prompt, _turnOrigin: { ...prompt._turnOrigin!, callerContextId: "ctx_other" } } as RuntimeLaunchPrompt,
      { ...prompt, _turnOrigin: undefined },
      { ...prompt, _slackThreadLifecycle: { ...prompt._slackThreadLifecycle!, turnId: "other-turn" } },
      { ...prompt, _slackThreadLifecycle: { ...prompt._slackThreadLifecycle!, eventType: "thread.report" } },
    ];
    for (const forged of changed)
      await expect(admitThreadAttention(parentKey, forged, handle)).rejects.toThrow("envelope differs");
    await expect(
      admitThreadAttention(
        parentKey,
        { ...prompt, _slackThreadLifecycle: { ...prompt._slackThreadLifecycle!, eventId: "unknown" } },
        handle,
      ),
    ).rejects.toThrow("receipt missing");
    expect(status()).toBe("pending");
    expect(handle).not.toHaveBeenCalled();
    expect(await admitThreadAttention(parentKey, { prompt: "normal message" }, handle)).toBe(false);
  });

  it.each(["crash-after-consume", "crash-before-consume"])(
    "admits once without loss after %s and expired transport dedup",
    async (crash) => {
      await run(crash, now);
      const receipt = getDb()
        .query("SELECT notified_turn_id, claim_id FROM slack_thread_turn_health WHERE request_id=?")
        .get(requestId) as { notified_turn_id: string | null; claim_id: string | null };
      expect(receipt.notified_turn_id).toBeNull();
      expect(receipt.claim_id).not.toBeNull();
      expect(handled()).toHaveLength(crash === "crash-after-consume" ? 1 : 0);
      // Change the reason while the publisher is dead. Retries must retain the original envelope/authority.
      getDb()
        .query("UPDATE session_turns SET status='failed',completed_at=? WHERE turn_id=?")
        .run(now + 1, firstTurn);
      await run("restart", now + 121_000);
      const deliveries = JSON.parse(readFileSync(join(state, "broker.json"), "utf8"));
      expect(deliveries).toHaveLength(2);
      expect(deliveries[1].id).toBe(deliveries[0].id);
      expect(deliveries[1].sequence).not.toBe(deliveries[0].sequence);
      expect(handled()).toHaveLength(1);
      expect(deliveries[1].payload).toEqual(deliveries[0].payload);
      // A later physical turn must not erase the admission of the old occurrence.
      seedTurn("admission-turn-2", now + 122_000);
      await run("restart", now + 123_000);
      await run("late-copy", now + 124_000);
      expect(handled()).toHaveLength(1);
      await run("restart", now + 122_000 + 15 * 60_000);
      expect(handled()).toHaveLength(2);
    },
    20_000,
  );
});
