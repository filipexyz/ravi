import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbSetSetting, closeRouterDb } from "../router/router-db.js";
import { createQueuedRuntimeUserMessage, createRuntimeMessageGenerator } from "../runtime/delivery-queue.js";
import type { RuntimeHostStreamingSession } from "../runtime/host-session.js";
import type { RuntimeSessionHandle } from "../runtime/types.js";
import { commitRenderedSignals, releaseRenderedSignals, renderSignalsForTurn } from "./render.js";
import { raiseSignal } from "./service.js";
import { dbListSignalSurfaces } from "./signal-db.js";

let root = "";
const originalStateDir = process.env.RAVI_STATE_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ravi-signals-seam-"));
  process.env.RAVI_STATE_DIR = join(root, ".ravi");
  dbSetSetting("signals.enabled", "true");
});

afterEach(() => {
  closeRouterDb();
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

function makeRuntimeSession(): RuntimeSessionHandle {
  return {
    provider: "codex",
    events: (async function* () {})(),
    interrupt: async () => {},
  };
}

function makeStreamingSession(overrides: Partial<RuntimeHostStreamingSession> = {}): RuntimeHostStreamingSession {
  return {
    agentId: "main",
    queryHandle: makeRuntimeSession(),
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentModel: "gpt-5.4",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    ...overrides,
  };
}

describe("signals piggyback seam", () => {
  it("appends the signal block to the turn that already exists", async () => {
    raiseSignal({
      key: "host.disk.free",
      kind: "fact",
      producerId: "test.code",
      producerClass: "code",
      producerType: "code",
      scopeType: "install",
      scopeId: "install",
      targetSessions: ["seam-session"],
      severity: "piggyback",
      title: "Disk free below 15%",
      clearWhen: { type: "producer_resolve", ttl_ms: 86_400_000 },
      now: Date.now(),
    });

    const queued = createQueuedRuntimeUserMessage({ prompt: "hello" });
    const session = makeStreamingSession({ pendingMessages: [queued] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "seam-session",
      session,
      stashedMessages: new Map(),
      transformTurnPrompt: ({ combinedPrompt }) => {
        const rendered = renderSignalsForTurn({ sessionName: "seam-session", enabled: true });
        return rendered.suffix ? `${combinedPrompt}${rendered.suffix}` : combinedPrompt;
      },
    });

    const result = await generator.next();
    expect(result.done).toBe(false);
    const content = result.value && "message" in result.value ? String(result.value.message.content) : "";
    expect(content).toContain("hello");
    expect(content).toContain("<ravi-signals");
    expect(content).toContain("Disk free below 15%");

    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("leaves the prompt untouched when no signal is eligible", async () => {
    const queued = createQueuedRuntimeUserMessage({ prompt: "hello" });
    const session = makeStreamingSession({ pendingMessages: [queued] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "seam-session",
      session,
      stashedMessages: new Map(),
      transformTurnPrompt: ({ combinedPrompt }) => {
        const rendered = renderSignalsForTurn({ sessionName: "seam-session", enabled: true });
        return rendered.suffix ? `${combinedPrompt}${rendered.suffix}` : combinedPrompt;
      },
    });
    const result = await generator.next();
    const content = result.value && "message" in result.value ? String(result.value.message.content) : "";
    expect(content).toBe("hello");
    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });

  it("confirms the reserved surfaces when the prompt is handed over, and releases them when the turn fails", async () => {
    const { signal } = raiseSignal({
      key: "seam.reserve",
      kind: "fact",
      producerId: "test.code",
      producerClass: "code",
      producerType: "code",
      scopeType: "install",
      scopeId: "install",
      targetSessions: ["seam-session"],
      severity: "piggyback",
      title: "Reserved fact",
      clearWhen: { type: "producer_resolve", ttl_ms: 86_400_000 },
      now: Date.now(),
    });
    const transform = ({ combinedPrompt }: { combinedPrompt: string }) => {
      const rendered = renderSignalsForTurn({ sessionName: "seam-session", enabled: true });
      return {
        prompt: `${combinedPrompt}${rendered.suffix}`,
        commit: () => void commitRenderedSignals(rendered.reservations),
        release: (reason: string) => void releaseRenderedSignals(rendered.reservations, reason),
      };
    };

    const failing = makeStreamingSession({ pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "one" })] });
    const broken = createRuntimeMessageGenerator({
      sessionName: "seam-session",
      session: failing,
      stashedMessages: new Map(),
      transformTurnPrompt: transform,
      traceTurnStart: async () => {
        throw new Error("trace store down");
      },
    });
    await expect(broken.next()).rejects.toThrow("trace store down");
    expect(dbListSignalSurfaces(signal.id).map((row) => row.status)).toEqual(["failed"]);

    const session = makeStreamingSession({ pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "two" })] });
    const generator = createRuntimeMessageGenerator({
      sessionName: "seam-session",
      session,
      stashedMessages: new Map(),
      transformTurnPrompt: transform,
    });
    const result = await generator.next();
    const content = result.value && "message" in result.value ? String(result.value.message.content) : "";
    expect(content).toContain("Reserved fact");
    expect(dbListSignalSurfaces(signal.id).map((row) => row.status)).toEqual(["failed", "sent"]);
    session.done = true;
    session.onTurnComplete?.();
    await generator.return(undefined);
  });
});
