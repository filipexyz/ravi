import { describe, expect, it } from "bun:test";
import { resolveTaskRuntimeOptions } from "./runtime-options.js";

describe("task runtime options", () => {
  it("uses profile runtime defaults ahead of session overrides", () => {
    const resolved = resolveTaskRuntimeOptions({
      profile: { id: "workspace", runtimeDefaults: { model: "profile-model", effort: "high" } },
      sessionModelOverride: "session-model",
      sessionEffortOverride: "ultra",
      agentModel: "agent-model",
      agentEffort: "max",
      configModel: "global-model",
    });

    expect(resolved.options).toEqual({ model: "profile-model", effort: "high" });
    expect(resolved.sources.model).toBe("profile_default");
    expect(resolved.sources.effort).toBe("profile_default");
    expect(resolved.taskProfileId).toBe("workspace");
    expect(resolved.hasTaskRuntimeContext).toBe(true);
  });

  it("lets task overrides beat profile defaults", () => {
    const resolved = resolveTaskRuntimeOptions({
      task: { runtimeOverride: { model: "task-model", thinking: "verbose" } },
      profile: { runtimeDefaults: { model: "profile-model", thinking: "normal" } },
      agentModel: "agent-model",
      configModel: "global-model",
    });

    expect(resolved.options).toEqual({ model: "task-model", effort: "xhigh", thinking: "verbose" });
    expect(resolved.sources.model).toBe("task_override");
    expect(resolved.sources.effort).toBe("runtime_default");
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
    const session = resolveTaskRuntimeOptions({
      sessionModelOverride: "session-model",
      sessionEffortOverride: "max",
      agentModel: "agent-model",
      agentEffort: "ultra",
      configModel: "global-model",
    });
    expect(session.options.model).toBe("session-model");
    expect(session.options.effort).toBe("max");
    expect(session.sources.model).toBe("session_override");
    expect(session.sources.effort).toBe("session_override");

    const agent = resolveTaskRuntimeOptions({
      agentModel: "agent-model",
      agentEffort: "ultra",
      configModel: "global-model",
    });
    expect(agent.options.model).toBe("agent-model");
    expect(agent.options.effort).toBe("ultra");
    expect(agent.sources.model).toBe("agent_default");
    expect(agent.sources.effort).toBe("agent_default");

    expect(resolveTaskRuntimeOptions({ configModel: "global-model" }).options.model).toBe("global-model");
  });

  it("uses xhigh as the default effort when no effort is provided", () => {
    const defaulted = resolveTaskRuntimeOptions({ configModel: "global-model" });
    expect(defaulted.options.effort).toBe("xhigh");
    expect(defaulted.sources.effort).toBe("runtime_default");
  });

  it("accepts the expanded max and ultra effort values", () => {
    const max = resolveTaskRuntimeOptions({
      task: { runtimeOverride: { effort: "max" } },
      configModel: "global-model",
    });
    expect(max.options.effort).toBe("max");
    expect(max.sources.effort).toBe("task_override");

    const ultra = resolveTaskRuntimeOptions({
      profile: { runtimeDefaults: { effort: "ultra" } },
      configModel: "global-model",
    });
    expect(ultra.options.effort).toBe("ultra");
    expect(ultra.sources.effort).toBe("profile_default");
  });

  it("fails clearly for invalid effort values instead of silently falling back", () => {
    expect(() =>
      resolveTaskRuntimeOptions({
        task: { runtimeOverride: { effort: "invalid" as never } },
        configModel: "global-model",
      }),
    ).toThrow(/Invalid runtime effort/);
  });
});
