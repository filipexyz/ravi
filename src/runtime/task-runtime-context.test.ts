import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAgent } from "../router/config.js";
import { dbSetSetting } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { configStore } from "../config-store.js";
import {
  HARDCODED_RUNTIME_MODEL,
  RUNTIME_DEFAULT_MODEL_ENV,
  RUNTIME_DEFAULT_MODEL_SETTING,
} from "./runtime-defaults.js";
import { UnusableAgentModelPresetError } from "./runtime-selection.js";
import { resolveRuntimeForPrompt } from "./task-runtime-context.js";

let stateDir: string | null = null;
let previousRaviModel: string | undefined;

describe("resolveRuntimeForPrompt", () => {
  beforeEach(async () => {
    previousRaviModel = process.env[RUNTIME_DEFAULT_MODEL_ENV];
    process.env[RUNTIME_DEFAULT_MODEL_ENV] = "env-sonnet";
    stateDir = await createIsolatedRaviState("ravi-task-runtime-context-");
    configStore.refresh();
  });

  afterEach(async () => {
    if (previousRaviModel === undefined) {
      delete process.env[RUNTIME_DEFAULT_MODEL_ENV];
    } else {
      process.env[RUNTIME_DEFAULT_MODEL_ENV] = previousRaviModel;
    }
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("rejects a missing agent preset instead of swallowing into env", () => {
    expect(() =>
      resolveRuntimeForPrompt({
        sessionName: "preset-session",
        prompt: { prompt: "hello" },
        session: null,
        agent: {
          id: "preset-agent",
          cwd: stateDir ?? "/tmp",
          modelPresetId: "does-not-exist",
        },
      }),
    ).toThrow(UnusableAgentModelPresetError);
  });

  it("keeps a stored agent model ahead of RAVI_MODEL", () => {
    const agent = createAgent({
      id: "direct-agent",
      cwd: stateDir ?? "/tmp",
      model: "agent-opus",
    });

    const resolved = resolveRuntimeForPrompt({
      sessionName: "direct-session",
      prompt: { prompt: "hello" },
      session: null,
      agent,
    });

    expect(resolved.options.model).toBe("agent-opus");
    expect(resolved.sources.model).toBe("agent_default");
  });

  it("uses a stored runtime.defaultModel ahead of RAVI_MODEL", () => {
    dbSetSetting(RUNTIME_DEFAULT_MODEL_SETTING, "stored-opus");
    const agent = createAgent({
      id: "plain-agent",
      cwd: stateDir ?? "/tmp",
    });

    const resolved = resolveRuntimeForPrompt({
      sessionName: "plain-session",
      prompt: { prompt: "hello" },
      session: null,
      agent,
    });

    expect(resolved.options.model).toBe("stored-opus");
    expect(resolved.sources.model).toBe("global_default");
    expect(resolved.options.model).not.toBe("env-sonnet");
    expect(resolved.options.model).not.toBe(HARDCODED_RUNTIME_MODEL);
  });
});
