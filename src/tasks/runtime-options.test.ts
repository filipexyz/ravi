import { describe, expect, it } from "bun:test";
import { resolveTaskRuntimeOptions } from "./runtime-options.js";

describe("task runtime options", () => {
  it("uses profile runtime defaults ahead of session overrides", () => {
    const resolved = resolveTaskRuntimeOptions({
      profile: { runtimeDefaults: { model: "profile-model", effort: "high" } },
      sessionModelOverride: "session-model",
      agentModel: "agent-model",
      configModel: "global-model",
    });

    expect(resolved.options).toEqual({ model: "profile-model", effort: "high" });
    expect(resolved.sources.model).toBe("profile_default");
    expect(resolved.sources.effort).toBe("profile_default");
    expect(resolved.hasTaskRuntimeContext).toBe(true);
  });

  it("lets task overrides beat profile defaults", () => {
    const resolved = resolveTaskRuntimeOptions({
      task: { runtimeOverride: { model: "task-model", thinking: "verbose" } },
      profile: { runtimeDefaults: { model: "profile-model", thinking: "normal" } },
      agentModel: "agent-model",
      configModel: "global-model",
    });

    expect(resolved.options).toEqual({ model: "task-model", thinking: "verbose" });
    expect(resolved.sources.model).toBe("task_override");
    expect(resolved.sources.thinking).toBe("task_override");
  });

  it("lets dispatch overrides beat task overrides", () => {
    const resolved = resolveTaskRuntimeOptions({
      task: { runtimeOverride: { model: "task-model", effort: "medium" } },
      assignment: { runtimeOverride: { model: "dispatch-model" } },
      profile: { runtimeDefaults: { model: "profile-model", effort: "high" } },
      agentModel: "agent-model",
      configModel: "global-model",
    });

    expect(resolved.options).toEqual({ model: "dispatch-model", effort: "medium" });
    expect(resolved.sources.model).toBe("dispatch_override");
    expect(resolved.sources.effort).toBe("task_override");
  });

  it("falls back through session, agent, and global defaults", () => {
    expect(
      resolveTaskRuntimeOptions({
        sessionModelOverride: "session-model",
        agentModel: "agent-model",
        configModel: "global-model",
      }).options.model,
    ).toBe("session-model");

    expect(
      resolveTaskRuntimeOptions({
        agentModel: "agent-model",
        configModel: "global-model",
      }).options.model,
    ).toBe("agent-model");

    expect(resolveTaskRuntimeOptions({ configModel: "global-model" }).options.model).toBe("global-model");
  });
});
