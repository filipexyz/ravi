import { describe, expect, it } from "bun:test";
import type { AgentConfig, SessionEntry } from "../router/types.js";
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

interface Harness {
  deps: Partial<SessionRuntimeUpdateDeps>;
  calls: string[];
  record: () => SessionEntry;
  probeRequests: RuntimeProbeRequest[];
}

function makeHarness(options: {
  initial: SessionEntry;
  probe?: (request: RuntimeProbeRequest) => RuntimeProbeResult;
}): Harness {
  const state: Record<string, unknown> = {
    runtimeProviderOverride: options.initial.runtimeProviderOverride,
    modelOverride: options.initial.modelOverride,
    effortOverride: options.initial.effortOverride,
    thinkingLevel: options.initial.thinkingLevel,
  };
  const calls: string[] = [];
  const probeRequests: RuntimeProbeRequest[] = [];
  const read = (): SessionEntry =>
    ({
      ...options.initial,
      runtimeProviderOverride: state.runtimeProviderOverride ?? undefined,
      modelOverride: state.modelOverride ?? undefined,
      effortOverride: state.effortOverride ?? undefined,
      thinkingLevel: state.thinkingLevel ?? undefined,
    }) as SessionEntry;
  return {
    calls,
    probeRequests,
    record: read,
    deps: {
      updateProviderOverride: (_key, value) => {
        state.runtimeProviderOverride = value ?? undefined;
        calls.push(`set:provider=${value}`);
      },
      updateModelOverride: (_key, value) => {
        state.modelOverride = value ?? undefined;
        calls.push(`set:model=${value}`);
      },
      updateEffortOverride: (_key, value) => {
        state.effortOverride = value ?? undefined;
        calls.push(`set:effort=${value}`);
      },
      updateThinkingLevel: (_key, value) => {
        state.thinkingLevel = value ?? undefined;
        calls.push(`set:thinking=${value}`);
      },
      clearProviderSession: () => {
        calls.push("clearProviderSession");
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

  it("fails fast on a model the installed catalog does not know, writing nothing", async () => {
    const harness = makeHarness({ initial: baseSession() });
    await expect(
      applySessionRuntimeUpdate({
        session: baseSession(),
        agent: null,
        axes: { provider: { set: "claude" }, model: { set: "fable-9-9" } },
        deps: harness.deps,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MODEL" });
    expect(harness.calls).toEqual([]);
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
    expect(result.probe?.ok).toBe(false);
    expect(result.probe?.error).toContain("Not logged in");
    expect(result.clearedProviderSession).toBe(false);
    expect(harness.calls).not.toContain("clearProviderSession");
    // Apply then restore, for exactly the touched axes.
    expect(harness.calls).toEqual([
      "set:provider=claude",
      "set:model=opus",
      "set:effort=low",
      "set:provider=null",
      "set:model=deepseek/deepseek-flash",
      "set:effort=high",
    ]);
    const after = harness.record();
    expect(after.runtimeProviderOverride ?? null).toBeNull();
    expect(after.modelOverride).toBe("deepseek/deepseek-flash");
    expect(after.effortOverride).toBe("high");
    expect(result.after).toEqual(result.before);
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
