import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { openStateDatabase } from "../db/state-boundary.js";
import { getRaviDbPath } from "../router/router-db.js";
import {
  getOrCreateSession,
  resolveSession,
  updateSessionEffortOverride,
  updateSessionModelOverride,
} from "../router/sessions.js";
import type { AgentConfig, SessionEntry } from "../router/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeProbeRequest, RuntimeProbeResult } from "./runtime-probe.js";
import {
  applySessionRuntimeUpdate,
  parseSessionRuntimeUpdateAxes,
  SessionRuntimeUpdateError,
  type SessionRuntimeUpdateDeps,
} from "./session-runtime-update.js";

const PROVIDERS = ["claude", "codex", "pi", "grok"];

function baseSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionKey: "agent:main:chat:1",
    name: "main-test",
    agentId: "main",
    runtimeProvider: "pi",
    providerSessionId: "prov-sess-1",
    modelOverride: "deepseek/deepseek-flash",
    ...overrides,
  } as SessionEntry;
}

interface HarnessValues {
  runtimeProviderOverride: string | null;
  modelOverride: string | null;
  effortOverride: string | null;
  thinkingLevel: string | null;
}

interface Harness {
  deps: Partial<SessionRuntimeUpdateDeps>;
  calls: string[];
  record: () => SessionEntry;
  probeRequests: RuntimeProbeRequest[];
  /** Simulate a concurrent `sessions update` landing: writes values and bumps the revision. */
  concurrentUpdate: (values: Partial<HarnessValues>) => void;
}

function makeHarness(options: {
  initial: SessionEntry;
  probe?: (request: RuntimeProbeRequest) => RuntimeProbeResult;
}): Harness {
  const values: HarnessValues = {
    runtimeProviderOverride: options.initial.runtimeProviderOverride ?? null,
    modelOverride: options.initial.modelOverride ?? null,
    effortOverride: options.initial.effortOverride ?? null,
    thinkingLevel: options.initial.thinkingLevel ?? null,
  };
  let revision = options.initial.runtimeProviderConfigRevision ?? 0;
  const calls: string[] = [];
  const probeRequests: RuntimeProbeRequest[] = [];
  const read = (): SessionEntry =>
    ({
      ...options.initial,
      runtimeProviderOverride: values.runtimeProviderOverride ?? undefined,
      modelOverride: values.modelOverride ?? undefined,
      effortOverride: values.effortOverride ?? undefined,
      thinkingLevel: values.thinkingLevel ?? undefined,
      runtimeProviderConfigRevision: revision,
    }) as SessionEntry;
  const owned = (ownedRevision: number, written: HarnessValues): boolean =>
    revision === ownedRevision &&
    values.runtimeProviderOverride === written.runtimeProviderOverride &&
    values.modelOverride === written.modelOverride &&
    values.effortOverride === written.effortOverride &&
    values.thinkingLevel === written.thinkingLevel;
  return {
    calls,
    probeRequests,
    record: read,
    concurrentUpdate: (next) => {
      Object.assign(values, next);
      revision += 1;
      calls.push("concurrent-update");
    },
    deps: {
      // Models the SQLite transaction the real store gives the apply: a throw
      // anywhere inside undoes every write made since the start. The real
      // transaction is exercised against SQLite in the "real session store"
      // describe below.
      applyAtomically: (write) => {
        const savedValues = { ...values };
        const savedRevision = revision;
        try {
          return write();
        } catch (error) {
          Object.assign(values, savedValues);
          revision = savedRevision;
          calls.push("applyAtomically:rolled-back");
          throw error;
        }
      },
      updateProviderOverride: (_key, value) => {
        values.runtimeProviderOverride = value ?? null;
        // Mirror the real store: the provider setter bumps the config revision.
        revision += 1;
        calls.push(`set:provider=${value}`);
      },
      updateModelOverride: (_key, value) => {
        values.modelOverride = value ?? null;
        calls.push(`set:model=${value}`);
      },
      updateEffortOverride: (_key, value) => {
        values.effortOverride = value ?? null;
        calls.push(`set:effort=${value}`);
      },
      updateThinkingLevel: (_key, value) => {
        values.thinkingLevel = value ?? null;
        calls.push(`set:thinking=${value}`);
      },
      bumpConfigRevision: () => {
        revision += 1;
        calls.push("bumpConfigRevision");
      },
      restoreIfOwned: (_key, ownedRevision, written, restore) => {
        if (!owned(ownedRevision, written as HarnessValues)) {
          calls.push("restoreIfOwned:superseded");
          return false;
        }
        Object.assign(values, restore);
        revision += 1;
        calls.push("restoreIfOwned:restored");
        return true;
      },
      configOwned: (_key, ownedRevision, written) => owned(ownedRevision, written as HarnessValues),
      clearProviderSessionIfOwned: (_key, ownedRevision, written) => {
        if (!owned(ownedRevision, written as HarnessValues)) {
          calls.push("clearProviderSession:superseded");
          return false;
        }
        calls.push("clearProviderSession");
        return true;
      },
      rematerializeSessionToAgentRuntime: () => {
        calls.push("rematerialize");
        return null;
      },
      readSession: read,
      probe: async (request) => {
        probeRequests.push(request);
        return (
          options.probe?.(request) ?? {
            ok: true,
            provider: request.provider,
            model: request.model,
            durationMs: 5,
          }
        );
      },
      listProviderIds: () => PROVIDERS,
    },
  };
}

describe("parseSessionRuntimeUpdateAxes", () => {
  it("refuses an unknown provider naming the valid providers", () => {
    expect(() => parseSessionRuntimeUpdateAxes({ provider: "zeus", listProviderIds: () => PROVIDERS })).toThrow(
      /Unknown runtime provider: 'zeus'.*claude, codex, pi, grok/,
    );
  });

  it("refuses an invalid effort naming the valid levels", () => {
    try {
      parseSessionRuntimeUpdateAxes({ effort: "banana" });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionRuntimeUpdateError);
      expect((error as SessionRuntimeUpdateError).code).toBe("INVALID_EFFORT");
      expect((error as Error).message).toContain("none|minimal|low|medium|high|xhigh|max|ultra");
    }
  });

  it("refuses an invalid thinking level naming the valid levels", () => {
    try {
      parseSessionRuntimeUpdateAxes({ thinking: "loud" });
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionRuntimeUpdateError);
      expect((error as SessionRuntimeUpdateError).code).toBe("INVALID_THINKING");
      expect((error as Error).message).toContain("off, normal, verbose");
    }
  });

  it("maps 'clear' to a null set on every axis", () => {
    const axes = parseSessionRuntimeUpdateAxes({
      provider: "clear",
      model: "clear",
      effort: "clear",
      thinking: "clear",
      listProviderIds: () => PROVIDERS,
    });
    expect(axes).toEqual({
      provider: { set: null },
      model: { set: null },
      effort: { set: null },
      thinking: { set: null },
    });
  });
});

describe("applySessionRuntimeUpdate", () => {
  it("refuses an empty update before touching anything", async () => {
    const harness = makeHarness({ initial: baseSession() });
    await expect(
      applySessionRuntimeUpdate({ session: baseSession(), agent: null, axes: {}, deps: harness.deps }),
    ).rejects.toMatchObject({ code: "NOTHING_TO_UPDATE" });
    expect(harness.calls).toEqual([]);
  });

  it("fails fast on a model family the provider does not run, writing nothing", async () => {
    const harness = makeHarness({ initial: baseSession() });
    await expect(
      applySessionRuntimeUpdate({
        session: baseSession(),
        agent: null,
        axes: { provider: { set: "claude" }, model: { set: "claude-zeppelin-9" } },
        deps: harness.deps,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MODEL" });
    expect(harness.calls).toEqual([]);
  });

  it("writes a future version of a known family and lets the probe arbitrate it", async () => {
    const session = baseSession();
    const harness = makeHarness({
      initial: session,
      probe: (request) => ({
        ok: false,
        provider: request.provider,
        model: request.model,
        durationMs: 3,
        error: "model not found: claude-fable-9",
      }),
    });
    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { provider: { set: "claude" }, model: { set: "claude-fable-9" } },
      deps: harness.deps,
    });
    // The write passed fail-fast (known family), the provider refused it in
    // the live probe, and the rollback restored the previous configuration.
    expect(harness.probeRequests[0]?.model).toBe("claude-fable-9");
    expect(result.rolledBack).toBe(true);
    expect(result.probe?.error).toContain("model not found");
    expect(harness.record().modelOverride).toBe("deepseek/deepseek-flash");
  });

  it("applies all axes atomically, probes the persisted effective runtime, then finalizes", async () => {
    const session = baseSession();
    const harness = makeHarness({ initial: session });
    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: {
        provider: { set: "claude" },
        model: { set: "sonnet" },
        effort: { set: "ultra" },
        thinking: { set: "off" },
      },
      deps: harness.deps,
    });

    expect(result.rolledBack).toBe(false);
    expect(result.changed).toEqual({ provider: true, model: true, effort: true, thinking: true });
    expect(result.effective).toEqual({ provider: "claude", model: "sonnet", effort: "ultra", thinking: "off" });
    expect(result.probe?.ok).toBe(true);
    // The probe proved the exact selection the next turn will launch with.
    expect(harness.probeRequests).toHaveLength(1);
    expect(harness.probeRequests[0]).toMatchObject({
      provider: "claude",
      model: "sonnet",
      effort: "ultra",
      thinking: "off",
    });
    // Stored pi provider state is incompatible with the proven claude selection.
    expect(result.clearedProviderSession).toBe(true);
    expect(harness.calls).toEqual([
      "set:provider=claude",
      "set:model=sonnet",
      "set:effort=ultra",
      "set:thinking=off",
      "clearProviderSession",
    ]);
    expect(harness.record().runtimeProviderOverride).toBe("claude");
    expect(harness.record().modelOverride).toBe("sonnet");
  });

  it("rolls back every touched axis when the probe fails", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    const harness = makeHarness({
      initial: session,
      probe: (request) => ({
        ok: false,
        provider: request.provider,
        model: request.model,
        durationMs: 3,
        error: "Not logged in",
      }),
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { provider: { set: "claude" }, model: { set: "opus" }, effort: { set: "low" } },
      deps: harness.deps,
    });

    expect(result.rolledBack).toBe(true);
    expect(result.rollbackError).toBeNull();
    expect(result.superseded).toBe(false);
    expect(result.probe?.ok).toBe(false);
    expect(result.probe?.error).toContain("Not logged in");
    expect(result.clearedProviderSession).toBe(false);
    expect(harness.calls).not.toContain("clearProviderSession");
    // Apply, then one conditional restore that still owned the config.
    expect(harness.calls).toEqual([
      "set:provider=claude",
      "set:model=opus",
      "set:effort=low",
      "restoreIfOwned:restored",
    ]);
    const after = harness.record();
    expect(after.runtimeProviderOverride ?? null).toBeNull();
    expect(after.modelOverride).toBe("deepseek/deepseek-flash");
    expect(after.effortOverride).toBe("high");
    expect(result.after).toEqual(result.before);
  });

  it("keeps the probe verdict and reports the failed restore when the restore throws after a failed probe", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    const harness = makeHarness({
      initial: session,
      probe: (request) => ({
        ok: false,
        provider: request.provider,
        model: request.model,
        durationMs: 7,
        error: "model_not_found: opus-9",
      }),
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { effort: { set: "low" } },
      deps: {
        ...harness.deps,
        restoreIfOwned: () => {
          throw new Error("SQLITE_IOERR: disk I/O error");
        },
      },
    });

    // The probe's failure is not replaced by the restore's error...
    expect(result.probe?.ok).toBe(false);
    expect(result.probe?.error).toContain("model_not_found: opus-9");
    // ...and the result says the unproven configuration is still stored: read
    // back after the failure, not rolled back, and not "superseded" (the stored
    // revision and values are still the ones this update wrote).
    expect(result.rolledBack).toBe(false);
    expect(result.superseded).toBe(false);
    expect(result.storedStateKnown).toBe(true);
    expect(result.rollbackError).toContain("SQLITE_IOERR");
    expect(result.after.effortOverride).toBe("low");
    expect(harness.record().effortOverride).toBe("low");
  });

  const failingProbe = (request: RuntimeProbeRequest): RuntimeProbeResult => ({
    ok: false,
    provider: request.provider,
    model: request.model,
    durationMs: 7,
    error: "model_not_found: opus-9",
  });

  it("reports a concurrent update, not this update's values, when the restore throws after one landed", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    const harness = makeHarness({
      initial: session,
      probe: (request) => {
        // Update B commits while A's probe runs.
        harness.concurrentUpdate({
          runtimeProviderOverride: "claude",
          modelOverride: "opus",
          effortOverride: "medium",
        });
        return failingProbe(request);
      },
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { provider: { set: "claude" }, model: { set: "sonnet" }, effort: { set: "low" } },
      // A's conditional restore then throws before it can check ownership.
      deps: {
        ...harness.deps,
        restoreIfOwned: () => {
          throw new Error("SQLITE_IOERR: disk I/O error");
        },
      },
    });

    expect(result.probe?.error).toContain("model_not_found: opus-9");
    expect(result.rollbackError).toContain("SQLITE_IOERR");
    expect(result.rolledBack).toBe(false);
    // B owns the session now: that is what is reported, not A's obsolete values.
    expect(result.superseded).toBe(true);
    expect(result.storedStateKnown).toBe(true);
    expect(result.after.modelOverride).toBe("opus");
    expect(result.after.effortOverride).toBe("medium");
    expect(harness.record().modelOverride).toBe("opus");
  });

  it("keeps the revision authoritative when a newer update wrote the previous values and the restore throws", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    const harness = makeHarness({
      initial: session,
      probe: (request) => {
        // Update B puts the original values back (revision up) while A's probe runs.
        harness.concurrentUpdate({
          runtimeProviderOverride: session.runtimeProviderOverride ?? null,
          modelOverride: session.modelOverride ?? null,
          effortOverride: session.effortOverride ?? null,
          thinkingLevel: session.thinkingLevel ?? null,
        });
        return failingProbe(request);
      },
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { provider: { set: "claude" }, model: { set: "sonnet" }, effort: { set: "low" } },
      deps: {
        ...harness.deps,
        restoreIfOwned: () => {
          throw new Error("SQLITE_IOERR: disk I/O error before the ownership check");
        },
      },
    });

    expect(result.storedStateKnown).toBe(true);
    // The stored values equal `before`, but the revision is B's: not this update's.
    expect(result.after).toEqual(result.before);
    expect(result.superseded).toBe(true);
  });

  it("stays superseded by revision, with the previous values stored, when the restore throws after committing", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    const harness = makeHarness({ initial: session, probe: failingProbe });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { provider: { set: "claude" }, model: { set: "sonnet" }, effort: { set: "low" } },
      deps: {
        ...harness.deps,
        // The conditional UPDATE commits (previous values stored, revision up) and
        // the call still fails afterwards.
        restoreIfOwned: (...args) => {
          harness.deps.restoreIfOwned?.(...args);
          throw new Error("SQLITE_IOERR: disk I/O error after commit");
        },
      },
    });

    expect(harness.calls).toContain("restoreIfOwned:restored");
    expect(result.rollbackError).toContain("SQLITE_IOERR");
    expect(result.rolledBack).toBe(false);
    expect(result.storedStateKnown).toBe(true);
    // The stored values are the previous ones, under a revision this update did not
    // write. The data cannot tell its own committed restore from a newer writer of
    // the same values, so the revision decides and the CLI words the ambiguity.
    expect(result.superseded).toBe(true);
    expect(result.after).toEqual(result.before);
  });

  it("reports the stored state as unknown when the restore throws and the stored configuration cannot be read", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    let probed = false;
    const harness = makeHarness({
      initial: session,
      probe: (request) => {
        probed = true;
        return failingProbe(request);
      },
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { effort: { set: "low" } },
      deps: {
        ...harness.deps,
        restoreIfOwned: () => {
          throw new Error("SQLITE_IOERR: disk I/O error");
        },
        readSession: (key) => {
          if (probed) throw new Error("SQLITE_IOERR: disk I/O error (read)");
          return harness.deps.readSession!(key);
        },
      },
    });

    // The probe verdict survives both failures.
    expect(result.probe?.error).toContain("model_not_found: opus-9");
    expect(result.rollbackError).toContain("SQLITE_IOERR");
    expect(result.rolledBack).toBe(false);
    // Neither whose configuration is stored nor which one is known: `after` is only
    // what this update wrote, and `superseded` is false only for lack of proof.
    expect(result.storedStateKnown).toBe(false);
    expect(result.superseded).toBe(false);
    expect(result.after.effortOverride).toBe("low");
  });

  it("keeps the superseded verdict when the conditional restore found a newer update and the read-back fails", async () => {
    const session = baseSession();
    let probed = false;
    const harness = makeHarness({
      initial: session,
      probe: (request) => {
        probed = true;
        harness.concurrentUpdate({ runtimeProviderOverride: "claude", modelOverride: "opus" });
        return failingProbe(request);
      },
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { provider: { set: "claude" }, model: { set: "sonnet" } },
      deps: {
        ...harness.deps,
        readSession: (key) => {
          if (probed) throw new Error("SQLITE_IOERR: disk I/O error (read)");
          return harness.deps.readSession!(key);
        },
      },
    });

    // restoreIfOwned ran and did not match: a newer update owns the session, whatever it holds.
    expect(result.probe?.error).toContain("model_not_found: opus-9");
    expect(result.rollbackError).toBeNull();
    expect(result.rolledBack).toBe(false);
    expect(result.superseded).toBe(true);
    expect(result.storedStateKnown).toBe(false);
  });

  it("keeps the probe verdict and the restored state when the read-back after a good restore fails", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    let probed = false;
    const harness = makeHarness({
      initial: session,
      probe: (request) => {
        probed = true;
        return failingProbe(request);
      },
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { effort: { set: "low" } },
      deps: {
        ...harness.deps,
        readSession: (key) => {
          if (probed) throw new Error("SQLITE_IOERR: disk I/O error (read)");
          return harness.deps.readSession!(key);
        },
      },
    });

    expect(result.probe?.error).toContain("model_not_found: opus-9");
    expect(result.rolledBack).toBe(true);
    expect(result.rollbackError).toBeNull();
    expect(result.superseded).toBe(false);
    // The conditional UPDATE matched, so the previous configuration is known to be stored.
    expect(result.storedStateKnown).toBe(true);
    expect(result.after).toEqual(result.before);
  });

  it("restores the previous configuration and rethrows when the probe throws", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    const boom = new Error("ENOSPC: no space left on device, mkdtemp");
    const harness = makeHarness({
      initial: session,
      probe: () => {
        throw boom;
      },
    });

    let thrown: unknown;
    try {
      await applySessionRuntimeUpdate({
        session,
        agent: null,
        axes: { provider: { set: "claude" }, model: { set: "opus" }, effort: { set: "low" } },
        deps: harness.deps,
      });
    } catch (error) {
      thrown = error;
    }

    // The original error reaches the caller untouched.
    expect(thrown).toBe(boom);
    expect(harness.calls).toEqual([
      "set:provider=claude",
      "set:model=opus",
      "set:effort=low",
      "restoreIfOwned:restored",
    ]);
    // The unproven configuration is not left in the store.
    const after = harness.record();
    expect(after.runtimeProviderOverride ?? null).toBeNull();
    expect(after.modelOverride).toBe("deepseek/deepseek-flash");
    expect(after.effortOverride).toBe("high");
  });

  it("rolls the whole apply back and rethrows when a setter throws midway", async () => {
    const session = baseSession({ effortOverride: "high" } as Partial<SessionEntry>);
    const harness = makeHarness({ initial: session });
    const boom = new Error("SQLITE_BUSY: database is locked");

    let thrown: unknown;
    try {
      await applySessionRuntimeUpdate({
        session,
        agent: null,
        axes: { provider: { set: "claude" }, model: { set: "opus" }, effort: { set: "low" } },
        deps: {
          ...harness.deps,
          updateEffortOverride: () => {
            throw boom;
          },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
    // Provider and model were written, effort was not: the transaction undoes the
    // partial state itself. No value-comparison restore runs afterwards.
    expect(harness.calls).toEqual(["set:provider=claude", "set:model=opus", "applyAtomically:rolled-back"]);
    expect(harness.probeRequests).toHaveLength(0);
    const after = harness.record();
    expect(after.runtimeProviderOverride ?? null).toBeNull();
    expect(after.modelOverride).toBe("deepseek/deepseek-flash");
    expect(after.effortOverride).toBe("high");
    expect(after.runtimeProviderConfigRevision ?? 0).toBe(0);
  });

  it("never restores over a concurrent writer that stored the intended values after the failed apply", async () => {
    const session = baseSession();
    const harness = makeHarness({ initial: session });
    const boom = new Error("SQLITE_BUSY: database is locked");

    let thrown: unknown;
    try {
      await applySessionRuntimeUpdate({
        session,
        agent: null,
        axes: { provider: { set: "claude" }, model: { set: "sonnet" } },
        deps: {
          ...harness.deps,
          updateModelOverride: () => {
            throw boom;
          },
          // The other writer waits for the transaction and lands right after the
          // rollback, storing exactly the values this update intended.
          applyAtomically: (write) => {
            try {
              return harness.deps.applyAtomically!(write);
            } catch (error) {
              harness.concurrentUpdate({ runtimeProviderOverride: "claude", modelOverride: "sonnet" });
              throw error;
            }
          },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
    // The old recovery inferred ownership from equal values and would restore here.
    expect(harness.calls.some((call) => call.startsWith("restoreIfOwned"))).toBe(false);
    const after = harness.record();
    expect(after.runtimeProviderOverride).toBe("claude");
    expect(after.modelOverride).toBe("sonnet");
  });

  it("keeps a concurrent update and rethrows when the probe throws after being superseded", async () => {
    const session = baseSession();
    const boom = new Error("transport exploded");
    const harness = makeHarness({
      initial: session,
      probe: () => {
        harness.concurrentUpdate({ runtimeProviderOverride: "claude", modelOverride: "opus" });
        throw boom;
      },
    });

    let thrown: unknown;
    try {
      await applySessionRuntimeUpdate({
        session,
        agent: null,
        axes: { provider: { set: "claude" }, model: { set: "sonnet" } },
        deps: harness.deps,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
    expect(harness.calls).toContain("restoreIfOwned:superseded");
    expect(harness.record().modelOverride).toBe("opus");
  });

  it("rethrows the original error even when the restore itself fails", async () => {
    const session = baseSession();
    const boom = new Error("probe crashed");
    const harness = makeHarness({
      initial: session,
      probe: () => {
        throw boom;
      },
    });

    let thrown: unknown;
    try {
      await applySessionRuntimeUpdate({
        session,
        agent: null,
        axes: { effort: { set: "low" } },
        deps: {
          ...harness.deps,
          restoreIfOwned: () => {
            throw new Error("SQLITE_IOERR: disk I/O error");
          },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(boom);
  });

  it("leaves a concurrent update in place when its own probe fails (lost-update guard)", async () => {
    const session = baseSession();
    const harness = makeHarness({
      initial: session,
      probe: (request) => {
        // Update B lands while A's probe is in flight and finishes successfully.
        harness.concurrentUpdate({ runtimeProviderOverride: "claude", modelOverride: "opus" });
        return { ok: false, provider: request.provider, model: request.model, durationMs: 3, error: "boom" };
      },
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { provider: { set: "claude" }, model: { set: "sonnet" } },
      deps: harness.deps,
    });

    // A's failed probe must NOT overwrite B's successful opus update.
    expect(result.rolledBack).toBe(false);
    expect(result.superseded).toBe(true);
    expect(harness.calls).toContain("restoreIfOwned:superseded");
    const after = harness.record();
    expect(after.modelOverride).toBe("opus");
    expect(after.runtimeProviderOverride).toBe("claude");
    expect(result.after.modelOverride).toBe("opus");
  });

  it("skips destructive finalization when a concurrent update superseded a successful probe", async () => {
    const session = baseSession();
    const harness = makeHarness({
      initial: session,
      probe: (request) => {
        harness.concurrentUpdate({ runtimeProviderOverride: "codex", modelOverride: "gpt-6-astra" });
        return { ok: true, provider: request.provider, model: request.model, durationMs: 3 };
      },
    });

    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { provider: { set: "claude" }, model: { set: "sonnet" } },
      deps: harness.deps,
    });

    expect(result.superseded).toBe(true);
    expect(result.rolledBack).toBe(false);
    // The newer configuration keeps its provider continuity and its values.
    expect(result.clearedProviderSession).toBe(false);
    expect(harness.calls).not.toContain("clearProviderSession");
    expect(harness.calls).not.toContain("rematerialize");
    expect(harness.record().runtimeProviderOverride).toBe("codex");
  });

  it("skips the probe when disabled and reports the change as unproven", async () => {
    const session = baseSession();
    const harness = makeHarness({ initial: session });
    const result = await applySessionRuntimeUpdate({
      session,
      agent: null,
      axes: { effort: { set: "medium" } },
      probe: false,
      deps: harness.deps,
    });

    expect(result.probe).toBeNull();
    expect(result.rolledBack).toBe(false);
    expect(harness.probeRequests).toHaveLength(0);
    expect(harness.record().effortOverride).toBe("medium");
  });

  it("rematerializes agent defaults after a proven provider clear", async () => {
    const session = baseSession({
      runtimeProviderOverride: "codex",
      modelOverride: undefined,
    } as Partial<SessionEntry>);
    const agent = { provider: "pi", model: "deepseek/deepseek-flash" } as AgentConfig;
    const harness = makeHarness({ initial: session });
    const result = await applySessionRuntimeUpdate({
      session,
      agent,
      axes: { provider: { set: null } },
      deps: harness.deps,
    });

    expect(result.rolledBack).toBe(false);
    expect(result.rematerializedToAgentRuntime).toBe(false);
    expect(harness.calls).toContain("rematerialize");
    expect(result.effective.provider).toBe("pi");
  });
});

describe("applySessionRuntimeUpdate against the real session store", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-update-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function seedSession(sessionKey: string): SessionEntry {
    getOrCreateSession(sessionKey, "main", "/tmp/main");
    updateSessionModelOverride(sessionKey, "deepseek/deepseek-flash");
    updateSessionEffortOverride(sessionKey, "high");
    return resolveSession(sessionKey) as SessionEntry;
  }

  it("leaves the stored configuration untouched when a later write throws", async () => {
    const session = seedSession("agent:main:atomic-rollback");
    const revisionBefore = session.runtimeProviderConfigRevision ?? 0;
    const boom = new Error("SQLITE_IOERR: disk I/O error");

    await expect(
      applySessionRuntimeUpdate({
        session,
        agent: null,
        axes: { provider: { set: "claude" }, model: { set: "sonnet" }, effort: { set: "low" } },
        probe: false,
        deps: {
          updateEffortOverride: () => {
            throw boom;
          },
        },
      }),
    ).rejects.toBe(boom);

    // The provider and model writes landed before the throw; the transaction took them back.
    const stored = resolveSession(session.sessionKey);
    expect(stored?.runtimeProviderOverride ?? null).toBeNull();
    expect(stored?.modelOverride).toBe("deepseek/deepseek-flash");
    expect(stored?.effortOverride).toBe("high");
    expect(stored?.runtimeProviderConfigRevision ?? 0).toBe(revisionBefore);
  });

  it("keeps a writer on another connection out until the apply has committed", async () => {
    const session = seedSession("agent:main:atomic-interleave");
    // The house handle: it authorizes the target (isolated state here) like any other writer.
    const other = openStateDatabase(getRaviDbPath());
    other.exec("PRAGMA busy_timeout = 0");
    const intrude = (value: string) =>
      other.prepare("UPDATE sessions SET model_override = ? WHERE session_key = ?").run(value, session.sessionKey);
    let intruderError: unknown = null;
    try {
      const result = await applySessionRuntimeUpdate({
        session,
        agent: null,
        axes: { provider: { set: "claude" }, model: { set: "sonnet" }, effort: { set: "low" } },
        probe: false,
        deps: {
          updateEffortOverride: (key, value) => {
            updateSessionEffortOverride(key, value);
            // Mid-apply: every write above is already issued but not committed.
            try {
              intrude("intruder");
            } catch (error) {
              intruderError = error;
            }
          },
        },
      });

      expect(result.after).toMatchObject({
        runtimeProviderOverride: "claude",
        modelOverride: "sonnet",
        effortOverride: "low",
      });
      // Once the apply has committed, the other connection can write again.
      intrude("after-commit");
      expect(resolveSession(session.sessionKey)?.modelOverride).toBe("after-commit");
    } finally {
      other.close();
    }
    expect(intruderError).toBeInstanceOf(Error);
    expect((intruderError as Error).message).toMatch(/locked|busy/i);
  });
});
