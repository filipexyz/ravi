import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeCredential } from "./credential-store.js";
import { probeRuntimeTurn, type RuntimeProbeRequest } from "./runtime-probe.js";
import type { RuntimeEvent, RuntimeStartRequest, SessionRuntimeProvider } from "./types.js";

const NO_POOL: Awaited<ReturnType<NonNullable<RuntimeProbeRequest["resolveCredential"]>>> = {
  attemptBinding: null,
  selected: null,
  candidates: [],
  rejected: [],
  managedPoolConfigured: false,
};

function fakeProvider(
  makeEvents: (request: RuntimeStartRequest) => AsyncIterable<RuntimeEvent>,
  capture?: (request: RuntimeStartRequest) => void,
): SessionRuntimeProvider {
  return {
    id: "fake",
    getCapabilities: () => {
      throw new Error("not used by the probe");
    },
    startSession: (request: RuntimeStartRequest) => {
      capture?.(request);
      return {
        provider: "fake",
        events: makeEvents(request),
        interrupt: async () => {},
      };
    },
  };
}

describe("probeRuntimeTurn", () => {
  it("succeeds on a completed turn and forwards the requested selection", async () => {
    let seen: RuntimeStartRequest | undefined;
    const provider = fakeProvider(
      // eslint-disable-next-line require-yield
      async function* () {
        yield { type: "assistant.message", text: "OK" } as RuntimeEvent;
        yield { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as RuntimeEvent;
      },
      (request) => {
        seen = request;
      },
    );

    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      effort: "low",
      thinking: "off",
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(seen?.model).toBe("sonnet");
    expect(seen?.effort).toBe("low");
    expect(seen?.thinking).toBe("off");
    expect(seen?.allowedTools).toEqual([]);
  });

  it("starts the provider with the allowlisted env, not the daemon's secrets", async () => {
    let seen: RuntimeStartRequest | undefined;
    const provider = fakeProvider(
      async function* () {
        yield { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } } as unknown as RuntimeEvent;
      },
      (request) => {
        seen = request;
      },
    );

    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      env: {
        PATH: "/usr/bin:/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "canary-claude-login",
        RAVI_ADMIN_TOKEN: "canary-admin",
        OPENAI_API_KEY: "canary-openai",
        DEVIN_API_KEY: "canary-devin",
      },
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
    });

    expect(result.ok).toBe(true);
    expect(seen?.env?.PATH).toBe("/usr/bin:/bin");
    // Claude inherits its own login, and only that.
    expect(seen?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("canary-claude-login");
    expect(seen?.env?.RAVI_ADMIN_TOKEN).toBeUndefined();
    expect(seen?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(seen?.env?.DEVIN_API_KEY).toBeUndefined();
  });

  it("fails with the provider error on a failed turn", async () => {
    const provider = fakeProvider(async function* () {
      yield {
        type: "turn.failed",
        error: "model not found: fable-9-9",
      } as unknown as RuntimeEvent;
    });

    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "fable-9-9",
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("model not found: fable-9-9");
  });

  it("times out a hung provider and reports the timeout", async () => {
    const provider = fakeProvider(async function* (request) {
      await new Promise<void>((resolve) => {
        request.abortController.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "turn.interrupted" } as unknown as RuntimeEvent;
    });

    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      timeoutMs: 50,
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  });

  it("fails fast when the managed credential pool has no candidate for the selection", async () => {
    let started = false;
    const provider = fakeProvider(async function* () {
      started = true;
      yield { type: "turn.complete", usage: {} } as unknown as RuntimeEvent;
    });

    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      createProvider: () => provider,
      resolveCredential: async () => ({
        ...NO_POOL,
        managedPoolConfigured: true,
        rejected: [{ credentialId: "cred_1", label: "team", reason: "model not allowed" }],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("No managed runtime credential");
    expect(result.error).toContain("model not allowed");
    expect(started).toBe(false);
  });

  it("returns a failed probe instead of rejecting when the scratch directory cannot be created", async () => {
    let started = false;
    const provider = fakeProvider(async function* () {
      started = true;
      yield { type: "turn.complete", usage: {} } as unknown as RuntimeEvent;
    });

    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
      createScratchDir: () => {
        throw new Error("ENOSPC: no space left on device, mkdtemp");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOSPC");
    expect(started).toBe(false);
  });

  it("keeps the settled result when the scratch directory cannot be removed", async () => {
    const provider = fakeProvider(async function* () {
      yield { type: "turn.complete", usage: {} } as unknown as RuntimeEvent;
    });

    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
      removeScratchDir: () => {
        throw new Error("EBUSY: resource busy or locked, rm");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("bounds credential resolution with the probe timeout", async () => {
    let started = false;
    const provider = fakeProvider(async function* () {
      started = true;
      yield { type: "turn.complete", usage: {} } as unknown as RuntimeEvent;
    });

    const startedAt = Date.now();
    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      timeoutMs: 50,
      createProvider: () => provider,
      // A refresh hook that never returns.
      resolveCredential: () => new Promise(() => {}),
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("resolving the runtime credential");
    expect(started).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("charges credential resolution against the same deadline as the turn", async () => {
    const provider = fakeProvider(async function* (request) {
      await new Promise<void>((resolve) => {
        request.abortController.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "turn.interrupted" } as unknown as RuntimeEvent;
    });

    const startedAt = Date.now();
    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      timeoutMs: 300,
      createProvider: () => provider,
      resolveCredential: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return NO_POOL;
      },
    });

    // 200ms of resolution left ~100ms for the turn: the probe ends near 300ms,
    // not at 200ms + a fresh 300ms window.
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(450);
  });

  it("does not let a stalled close hold the settled result past the teardown grace", async () => {
    const provider: SessionRuntimeProvider = {
      id: "fake",
      getCapabilities: () => {
        throw new Error("not used by the probe");
      },
      startSession: () => ({
        provider: "fake",
        events: (async function* () {
          yield { type: "turn.complete", usage: {} } as unknown as RuntimeEvent;
        })(),
        interrupt: async () => {},
        // A transport that never finishes closing.
        close: () => new Promise<void>(() => {}),
      }),
    };

    const startedAt = Date.now();
    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      timeoutMs: 50,
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
    });

    expect(result.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("times out a provider stream that ignores the interrupt and the abort", async () => {
    const provider = fakeProvider(async function* () {
      await new Promise<void>(() => {});
      yield { type: "turn.complete", usage: {} } as unknown as RuntimeEvent;
    });

    const startedAt = Date.now();
    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      timeoutMs: 50,
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds a provider whose stream and close() both hang, within the timeout plus two graces", async () => {
    const provider: SessionRuntimeProvider = {
      id: "fake",
      getCapabilities: () => {
        throw new Error("not used by the probe");
      },
      startSession: () => ({
        provider: "fake",
        // Ignores the interrupt and the abort...
        events: (async function* () {
          await new Promise<void>(() => {});
          yield { type: "turn.complete", usage: {} } as unknown as RuntimeEvent;
        })(),
        interrupt: async () => {},
        // ...and its transport never finishes closing either.
        close: () => new Promise<void>(() => {}),
      }),
    };

    const startedAt = Date.now();
    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      timeoutMs: 100,
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
    // Both waits ran in sequence: the deadline plus the stream grace (100 + 100), then the
    // close grace (100). A probe that waited on either forever would never get here.
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("fails when the provider is unknown", async () => {
    const result = await probeRuntimeTurn({
      provider: "nope",
      model: "x",
      createProvider: () => {
        throw new Error("Unknown runtime provider 'nope'");
      },
      resolveCredential: async () => NO_POOL,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown runtime provider");
  });

  it("fails when the provider stream ends without a terminal event", async () => {
    // eslint-disable-next-line require-yield
    const provider = fakeProvider(async function* () {
      // ends immediately
    });

    const result = await probeRuntimeTurn({
      provider: "claude",
      model: "sonnet",
      createProvider: () => provider,
      resolveCredential: async () => NO_POOL,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("without a terminal turn event");
  });
});

describe("probeRuntimeTurn with a managed credential pool", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-probe-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("settles the reserved credential attempt as failed when the scratch directory cannot be created", async () => {
    createRuntimeCredential({
      id: "rcred_probe",
      label: "Probe credential",
      runtimeProvider: "codex",
      priority: 10,
      bindings: [
        {
          sourceKind: "env",
          targetKind: "env",
          targetName: "OPENAI_API_KEY",
          secretRef: "env:RAVI_TEST_PROBE_KEY",
          sourceHint: "RAVI_TEST_PROBE_KEY",
          sensitive: true,
          remoteForward: false,
        },
      ],
    });
    let started = false;
    const provider = fakeProvider(async function* () {
      started = true;
      yield { type: "turn.complete", usage: {} } as unknown as RuntimeEvent;
    });

    // The real resolver: it reserves an attempt row for the selected credential before the probe
    // goes on to create its scratch directory.
    const result = await probeRuntimeTurn({
      provider: "codex",
      model: "gpt-5",
      env: { RAVI_TEST_PROBE_KEY: "sk-test_probe_secret_value" },
      createProvider: () => provider,
      createScratchDir: () => {
        throw new Error("ENOSPC: no space left on device, mkdtemp");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOSPC");
    expect(result.credentialId).toBe("rcred_probe");
    expect(started).toBe(false);
    const attempt = getDb()
      .prepare(
        "SELECT status, completed_at AS completedAt, metadata_json AS metadata FROM runtime_credential_attempts WHERE credential_id = ?",
      )
      .get("rcred_probe") as { status: string; completedAt: number | null; metadata: string | null } | null;
    // Not left reserved: the attempt is settled with the probe failure as its reason.
    expect(attempt?.status).toBe("failed");
    expect(attempt?.completedAt).not.toBeNull();
    expect(attempt?.metadata).toContain("ENOSPC");
  });
});
