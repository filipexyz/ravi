import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAgent, updateAgent } from "../router/config.js";
import { getOrCreateSession, getSession, updateProviderSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  describeSessionAgentDefaultDiff,
  rematerializeSessionToAgentRuntime,
  sessionHasStaleRuntimeProvider,
  syncAgentSessionsToAgentRuntime,
} from "./agent-session-runtime-sync.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-agent-session-runtime-sync-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("syncAgentSessionsToAgentRuntime", () => {
  it("rematerializes no-override sessions whose last-used provider drifted from the agent", () => {
    const agent = createAgent({
      id: "ravi-console",
      cwd: "/tmp/ravi-console",
      provider: "codex",
      model: "gpt-5.5",
    });
    getOrCreateSession("agent:ravi-console:wa", "ravi-console", agent.cwd, {
      name: "wa-group",
      runtimeProvider: "codex",
    });
    getOrCreateSession("agent:ravi-console:trigger", "ravi-console", agent.cwd, {
      name: "trigger-job",
      runtimeProvider: "claude",
    });
    getOrCreateSession("agent:ravi-console:fresh", "ravi-console", agent.cwd, {
      name: "fresh-session",
    });

    updateAgent("ravi-console", { provider: "pi", model: "deepseek/deepseek-flash" });
    const updated = { ...agent, provider: "pi", model: "deepseek/deepseek-flash" };

    const result = syncAgentSessionsToAgentRuntime({ agent: updated, rematerialize: true });

    expect(getSession("agent:ravi-console:wa")?.runtimeProvider).toBe("pi");
    expect(getSession("agent:ravi-console:trigger")?.runtimeProvider).toBe("pi");
    expect(getSession("agent:ravi-console:fresh")?.runtimeProvider).toBeUndefined();
    expect(result.rematerializedSessions.map((session) => session.sessionName)).toEqual(["trigger-job", "wa-group"]);
    expect(result.rematerializedSessions).toEqual([
      expect.objectContaining({
        sessionName: "trigger-job",
        sessionKey: "agent:ravi-console:trigger",
        reasons: ["stale_runtime_provider"],
        previousRuntimeProvider: "claude",
        runtimeProvider: "pi",
      }),
      expect.objectContaining({
        sessionName: "wa-group",
        previousRuntimeProvider: "codex",
        runtimeProvider: "pi",
      }),
    ]);
    expect(result.sessionOverrides).toEqual([]);
  });

  it("preserves explicit provider/model overrides and lists them with reasons", () => {
    const agent = createAgent({
      id: "ravi-console",
      cwd: "/tmp/ravi-console",
      provider: "codex",
    });
    getOrCreateSession("agent:ravi-console:pinned", "ravi-console", agent.cwd, {
      name: "pinned",
      runtimeProvider: "codex",
      runtimeProviderOverride: "codex",
    });
    getOrCreateSession("agent:ravi-console:model-pin", "ravi-console", agent.cwd, {
      name: "model-pin",
      runtimeProvider: "codex",
      modelOverride: "gpt-5.6",
    });

    const updated = { ...agent, provider: "pi" };
    const result = syncAgentSessionsToAgentRuntime({ agent: updated, rematerialize: true });

    expect(getSession("agent:ravi-console:pinned")).toMatchObject({
      runtimeProvider: "codex",
      runtimeProviderOverride: "codex",
    });
    expect(getSession("agent:ravi-console:model-pin")).toMatchObject({
      runtimeProvider: "pi",
      modelOverride: "gpt-5.6",
    });
    expect(result.sessionOverrides).toEqual([
      {
        sessionName: "model-pin",
        reasons: ["model_override"],
        model: "gpt-5.6",
      },
      {
        sessionName: "pinned",
        reasons: ["provider_override"],
        provider: "codex",
      },
    ]);
    expect(result.rematerializedSessions.map((session) => session.sessionName)).toEqual(["model-pin"]);
  });

  it("clears provider and model overrides with --force and rematerializes those sessions", () => {
    const agent = createAgent({
      id: "ravi-console",
      cwd: "/tmp/ravi-console",
      provider: "codex",
    });
    getOrCreateSession("agent:ravi-console:pinned", "ravi-console", agent.cwd, {
      name: "pinned",
      runtimeProvider: "codex",
      runtimeProviderOverride: "codex",
      modelOverride: "gpt-5.6",
    });

    const updated = { ...agent, provider: "pi" };
    const result = syncAgentSessionsToAgentRuntime({
      agent: updated,
      rematerialize: true,
      force: true,
    });

    expect(getSession("agent:ravi-console:pinned")).toMatchObject({
      runtimeProvider: "pi",
    });
    expect(getSession("agent:ravi-console:pinned")?.runtimeProviderOverride).toBeUndefined();
    expect(getSession("agent:ravi-console:pinned")?.modelOverride).toBeUndefined();
    expect(result.sessionOverrides).toEqual([]);
    expect(result.forcedClearedOverrides).toEqual([
      {
        sessionName: "pinned",
        reasons: ["provider_override", "model_override"],
        provider: "codex",
        model: "gpt-5.6",
      },
    ]);
    expect(result.rematerializedSessions).toEqual([
      expect.objectContaining({
        sessionName: "pinned",
        previousRuntimeProvider: "codex",
        runtimeProvider: "pi",
      }),
    ]);
  });

  it("clears an incompatible stored provider session when rematerializing last-used", () => {
    const agent = createAgent({
      id: "ravi-console",
      cwd: "/tmp/ravi-console",
      provider: "codex",
    });
    getOrCreateSession("agent:ravi-console:wa", "ravi-console", agent.cwd, {
      name: "wa-group",
    });
    updateProviderSession("agent:ravi-console:wa", "codex", "resp_old", {
      runtimeSessionDisplayId: "resp_old",
    });

    const result = syncAgentSessionsToAgentRuntime({
      agent: { ...agent, provider: "pi" },
      rematerialize: true,
    });

    const after = getSession("agent:ravi-console:wa");
    expect(after?.runtimeProvider).toBe("pi");
    expect(after?.providerSessionId).toBeUndefined();
    expect(after?.sdkSessionId).toBeUndefined();
    expect(result.rematerializedSessions[0]?.clearedProviderSession).toBe(true);
  });

  it("does not rematerialize when last-used already matches the agent default", () => {
    const agent = createAgent({
      id: "ravi-console",
      cwd: "/tmp/ravi-console",
      provider: "pi",
    });
    getOrCreateSession("agent:ravi-console:wa", "ravi-console", agent.cwd, {
      name: "wa-group",
      runtimeProvider: "pi",
    });

    const result = syncAgentSessionsToAgentRuntime({ agent, rematerialize: true });

    expect(result.rematerializedSessions).toEqual([]);
    expect(getSession("agent:ravi-console:wa")?.runtimeProvider).toBe("pi");
  });
});

describe("rematerializeSessionToAgentRuntime", () => {
  it("rewrites a single session last-used provider to the agent default", () => {
    const agent = createAgent({
      id: "dev",
      cwd: "/tmp/dev",
      provider: "pi",
    });
    const session = getOrCreateSession("agent:dev:main", "dev", agent.cwd, {
      name: "dev-main",
      runtimeProvider: "claude",
    });

    const report = rematerializeSessionToAgentRuntime(session, agent);

    expect(report).toMatchObject({
      sessionName: "dev-main",
      previousRuntimeProvider: "claude",
      runtimeProvider: "pi",
    });
    expect(getSession("agent:dev:main")?.runtimeProvider).toBe("pi");
  });

  it("returns null when the session already follows the agent or has a provider override", () => {
    const agent = createAgent({
      id: "dev",
      cwd: "/tmp/dev",
      provider: "pi",
    });
    const following = getOrCreateSession("agent:dev:ok", "dev", agent.cwd, {
      name: "ok",
      runtimeProvider: "pi",
    });
    const pinned = getOrCreateSession("agent:dev:pin", "dev", agent.cwd, {
      name: "pin",
      runtimeProvider: "claude",
      runtimeProviderOverride: "claude",
    });

    expect(rematerializeSessionToAgentRuntime(following, agent)).toBeNull();
    expect(rematerializeSessionToAgentRuntime(pinned, agent)).toBeNull();
  });
});

describe("sessionHasStaleRuntimeProvider", () => {
  it("treats last-used mismatch without an override as drift", () => {
    expect(sessionHasStaleRuntimeProvider({ runtimeProvider: "codex" }, "pi")).toBe(true);
    expect(sessionHasStaleRuntimeProvider({ runtimeProvider: "pi" }, "pi")).toBe(false);
    expect(sessionHasStaleRuntimeProvider({ runtimeProvider: "codex", runtimeProviderOverride: "codex" }, "pi")).toBe(
      false,
    );
    expect(sessionHasStaleRuntimeProvider({}, "pi")).toBe(false);
  });
});

describe("describeSessionAgentDefaultDiff", () => {
  it("returns an actionable propagate hint when the session value differs from the agent", () => {
    const diff = describeSessionAgentDefaultDiff({
      agentId: "ravi-console",
      sessionName: "wa-group",
      axis: "provider",
      sessionValue: "codex",
      agent: { provider: "pi", model: "deepseek/deepseek-flash" },
    });

    expect(diff.agentDefaultDiffers).toBe(true);
    expect(diff.agentDefaultProvider).toBe("pi");
    expect(diff.propagateCommand).toBe("ravi sessions set-provider wa-group codex --propagate");
    expect(diff.hint).toContain("ravi-console");
    expect(diff.hint).toContain("--propagate");
  });

  it("does not flag a session value that already matches the agent default", () => {
    const diff = describeSessionAgentDefaultDiff({
      agentId: "dev",
      sessionName: "dev-main",
      axis: "model",
      sessionValue: "gpt-5.5",
      agent: { provider: "codex", model: "gpt-5.5" },
    });

    expect(diff.agentDefaultDiffers).toBe(false);
    expect(diff.propagateCommand).toBeNull();
  });
});

describe("syncAgentSessionsToAgentRuntime inspect-only", () => {
  it("lists provider overrides even when rematerialize is off", () => {
    const agent = createAgent({
      id: "dev",
      cwd: "/tmp/dev",
      provider: "codex",
    });
    getOrCreateSession("agent:dev:pin", "dev", agent.cwd, {
      name: "pin",
      runtimeProviderOverride: "claude",
    });
    getOrCreateSession("agent:dev:drift", "dev", agent.cwd, {
      name: "drift",
      runtimeProvider: "claude",
    });

    const result = syncAgentSessionsToAgentRuntime({ agent, rematerialize: false });

    expect(result.rematerializedSessions).toEqual([]);
    expect(result.sessionOverrides).toEqual([
      {
        sessionName: "pin",
        reasons: ["provider_override"],
        provider: "claude",
      },
    ]);
    expect(getSession("agent:dev:drift")?.runtimeProvider).toBe("claude");
  });
});
