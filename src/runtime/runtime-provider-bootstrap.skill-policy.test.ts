import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dbCreateAgent, dbDeleteSkillGrant, dbGetContext, dbUpsertSkillGrant } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createClaudeRuntimeProvider } from "./claude-provider.js";
import { createRuntimeContext } from "./runtime-context-store.js";
import { prepareRuntimeProviderBootstrap } from "./runtime-provider-bootstrap.js";
import type { SessionRuntimeProvider } from "./types.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-skill-bootstrap-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

function futureProvider(observed: string[][]): SessionRuntimeProvider {
  return {
    id: "future-adapter",
    getCapabilities: () => ({
      ...createClaudeRuntimeProvider().getCapabilities(),
      skillExposure: {
        contractVersion: 1,
        modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
        modes: ["textual"],
        nativeDiscovery: { user: "none", project: "none", plugins: "none" },
        contextUpdate: "rebuild",
      },
      tools: { ...createClaudeRuntimeProvider().getCapabilities().tools, availableCapabilities: [] },
    }),
    prepareSession(input) {
      const preparedIds = input.skillPolicy?.skills.map((skill) => skill.id) ?? ["unfiltered-default"];
      observed.push(preparedIds);
      return { skillExposure: { snapshotId: input.skillPolicy?.id ?? "missing", mode: "textual", preparedIds } };
    },
    startSession() {
      throw new Error("A bootstrap must not call a model");
    },
  };
}

describe("runtime bootstrap uses the global skill policy", () => {
  test("preserves the authoritative source and session while attaching the policy binding", async () => {
    const agent = dbCreateAgent({ id: "restricted", cwd: stateDir });
    const source = { channel: "whatsapp", accountId: "fixture-account", chatId: "fixture-chat" };
    const context = createRuntimeContext({ agentId: agent.id, capabilities: [], sessionName: "restricted", source });
    const runtimeProvider = futureProvider([]);
    const prepared = await prepareRuntimeProviderBootstrap({
      agent,
      context,
      runtimeProvider,
      runtimeCapabilities: runtimeProvider.getCapabilities(),
      sessionName: "restricted",
      executionId: "run-source",
      sessionCwd: stateDir,
      sourcePlugins: [],
      toolContext: {},
    });
    expect(dbGetContext(context.contextId)?.source).toEqual(source);
    expect(dbGetContext(context.contextId)?.sessionName).toBe("restricted");
    await expect(prepared.refreshSkillPolicy()).resolves.toBeUndefined();
    await expect(prepared.verifySkillPolicy()).resolves.toBeUndefined();
  }, 60_000);

  test("invalidates dispatch when the adapter removes a previously available tool", async () => {
    const agent = dbCreateAgent({ id: "restricted", cwd: stateDir });
    const context = createRuntimeContext({ agentId: agent.id, capabilities: [] });
    const baseProvider = futureProvider([]);
    let availableCapabilities = ["fs.read"];
    const runtimeProvider: SessionRuntimeProvider = {
      ...baseProvider,
      getCapabilities: () => ({
        ...baseProvider.getCapabilities(),
        tools: { ...baseProvider.getCapabilities().tools, availableCapabilities },
      }),
    };
    const prepared = await prepareRuntimeProviderBootstrap({
      agent,
      context,
      runtimeProvider,
      runtimeCapabilities: runtimeProvider.getCapabilities(),
      sessionName: "restricted",
      executionId: "run-dynamic",
      sessionCwd: stateDir,
      sourcePlugins: [],
      toolContext: {},
    });
    expect(() => prepared.verifySkillPolicyAtDispatch()).not.toThrow();
    availableCapabilities = [];
    expect(() => prepared.verifySkillPolicyAtDispatch()).toThrow("fresh authorized runtime context");
  }, 20_000);

  test("rebinds a freshly resolved equivalent context before delivering the next turn", async () => {
    const agent = dbCreateAgent({ id: "restricted", cwd: stateDir });
    const context = createRuntimeContext({ agentId: agent.id, capabilities: [] });
    const runtimeProvider = futureProvider([]);
    const prepared = await prepareRuntimeProviderBootstrap({
      agent,
      context,
      runtimeProvider,
      runtimeCapabilities: runtimeProvider.getCapabilities(),
      sessionName: "restricted",
      executionId: "run-1",
      sessionCwd: stateDir,
      sourcePlugins: [],
      toolContext: {},
    });
    const previousSnapshotId = prepared.skillPolicy.id;
    Object.assign(context, createRuntimeContext({ agentId: agent.id, capabilities: [] }));
    await expect(prepared.refreshSkillPolicy()).resolves.toBeUndefined();
    await expect(prepared.verifySkillPolicy()).resolves.toBeUndefined();
    expect(prepared.skillPolicy.id).toBe(previousSnapshotId);
  }, 20_000);

  test("prepares a valid empty snapshot and persists its execution binding", async () => {
    const agent = dbCreateAgent({ id: "restricted", cwd: stateDir });
    const context = createRuntimeContext({ agentId: agent.id, capabilities: [] });
    const observed: string[][] = [];
    const runtimeProvider = futureProvider(observed);
    const prepared = await prepareRuntimeProviderBootstrap({
      agent,
      context,
      runtimeProvider,
      runtimeCapabilities: runtimeProvider.getCapabilities(),
      sessionName: "restricted",
      executionId: "run-1",
      sessionCwd: stateDir,
      sourcePlugins: [],
      toolContext: {},
    });
    expect(prepared.skillPolicy.status).toBe("empty");
    expect(observed).toEqual([[]]);
    expect(prepared.runtimePlugins).toEqual([]);
    expect(dbGetContext(context.contextId)?.metadata?.skillPolicyBinding !== undefined).toBe(true);
    await expect(prepared.verifySkillPolicy()).resolves.toBeUndefined();
  }, 20_000);

  test("revoked grants invalidate the prepared binding without preparing an expanded catalog", async () => {
    const agent = dbCreateAgent({ id: "restricted", cwd: stateDir });
    const context = createRuntimeContext({ agentId: agent.id, capabilities: [] });
    const path = join(stateDir, ".agents", "skills", "permitted");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "SKILL.md"),
      '---\nname: permitted\ndescription: Test\nravi.requires: {"kind":"none"}\n---\nInstructions\n',
    );
    const id = "local:workspace:agents:permitted";
    dbUpsertSkillGrant({ agentId: agent.id, skillName: id });
    const observed: string[][] = [];
    const runtimeProvider = futureProvider(observed);
    const prepared = await prepareRuntimeProviderBootstrap({
      agent,
      context,
      runtimeProvider,
      runtimeCapabilities: runtimeProvider.getCapabilities(),
      sessionName: "restricted",
      executionId: "run-1",
      sessionCwd: stateDir,
      sourcePlugins: [],
      toolContext: {},
    });
    expect(prepared.skillPolicy.skills.map((skill) => skill.id)).toEqual([id]);
    await expect(prepared.verifySkillPolicy()).resolves.toBeUndefined();
    dbDeleteSkillGrant(agent.id, id);
    await expect(prepared.verifySkillPolicy()).rejects.toThrow("fresh authorized runtime context");
    expect(observed).toEqual([[id]]);
  }, 20_000);
});
