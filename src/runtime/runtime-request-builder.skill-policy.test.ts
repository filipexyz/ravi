import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getHistory, saveMessage } from "../db.js";
import { nats } from "../nats.js";
import { getOrCreateSession, getSession, updateRuntimeProviderState } from "../router/index.js";
import { dbCreateAgent, dbDeleteSkillGrant, dbUpsertSkillGrant } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import { buildRuntimeStartRequest } from "./runtime-request-builder.js";
import type { RuntimeCapabilities, RuntimeSessionHandle, SessionRuntimeProvider } from "./types.js";

const agentId = "policy-builder";
const sessionKey = `agent:${agentId}:main`;
const providerId = "future-policy-provider";
const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: {
    permissionMode: "ravi-host",
    accessRequirement: "tool_and_executable",
    supportsParallelCalls: false,
    availableCapabilities: [],
  },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  skillExposure: {
    contractVersion: 1,
    modes: ["textual"],
    nativeDiscovery: { user: "none", project: "none", plugins: "none" },
    modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
    contextUpdate: "rebuild",
  },
  supportsSessionResume: true,
  supportsSessionFork: true,
  supportsPartialText: true,
  supportsToolHooks: false,
  supportsHostSessionHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};

const provider: SessionRuntimeProvider = {
  id: providerId,
  getCapabilities: () => capabilities,
  prepareSession(input) {
    if (!input.skillPolicy) throw new Error("Fixture requires the real core policy");
    return {
      skillExposure: {
        snapshotId: input.skillPolicy.id,
        mode: input.skillExposureMode ?? "textual",
        preparedIds: input.skillPolicy.skills.map((skill) => skill.id),
      },
    };
  },
  startSession() {
    throw new Error("The request builder must not call a model");
  },
};

let stateDir: string;
let crashRecovery: RuntimeCrashRecoveryCoordinator;
let emitSpy: ReturnType<typeof spyOn>;

function streamingFixture(): RuntimeHostStreamingSession {
  const handle: RuntimeSessionHandle = {
    provider: providerId,
    events: (async function* () {})(),
    interrupt: async () => {},
    close: async () => {},
  };
  return {
    agentId,
    queryHandle: handle,
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [createQueuedRuntimeUserMessage({ prompt: "CURRENT_AUTHORIZED_INPUT" })],
    currentModel: "fixture",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "sentinel",
  };
}

async function request(options: { key?: string; runId?: string; native?: boolean; cliOnly?: boolean } = {}) {
  const key = options.key ?? sessionKey;
  const session = getOrCreateSession(key, agentId, stateDir);
  const streaming = streamingFixture();
  const selectedCapabilities: RuntimeCapabilities = options.native
    ? {
        ...capabilities,
        skillExposure: {
          contractVersion: 1,
          modes: ["native-restricted"],
          nativeDiscovery: { user: "restricted", project: "restricted", plugins: "restricted" },
          modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
          contextUpdate: "rebuild",
        },
      }
    : capabilities;
  const selectedProvider = { ...provider, getCapabilities: () => selectedCapabilities };
  const built = await buildRuntimeStartRequest({
    runId: options.runId ?? "run-1",
    sessionName: key,
    prompt: { prompt: "CURRENT_AUTHORIZED_INPUT", ...(options.cliOnly ? { _cliDestination: true } : {}) },
    session,
    agent: { id: agentId, cwd: stateDir, provider: providerId, settingSources: [] },
    runtimeProviderId: providerId,
    runtimeProvider: selectedProvider,
    runtimeCapabilities: selectedCapabilities,
    sessionCwd: stateDir,
    dbSessionKey: key,
    model: "fixture",
    runtimeResolution: {
      options: { model: "fixture" },
      sources: { model: "agent_default", effort: null, thinking: null },
      hasTaskRuntimeContext: false,
    },
    storedRuntimeSessionParams: session.runtimeSessionParams,
    storedProviderSessionId: session.providerSessionId,
    canResumeStoredSession: Boolean(session.providerSessionId),
    streamingSession: streaming,
    stashedMessages: new Map(),
    defaultRuntimeProviderId: providerId,
    crashRecovery,
  });
  return { ...built, streaming, session };
}

function persistProviderContext(id: string, params?: Record<string, unknown>, key = sessionKey) {
  getOrCreateSession(key, agentId, stateDir);
  updateRuntimeProviderState(key, providerId, {
    providerSessionId: id,
    runtimeSessionDisplayId: id,
    runtimeSessionParams: params,
  });
}

describe("request builder enforces skill continuity", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-skill-request-");
    dbCreateAgent({ id: agentId, cwd: stateDir });
    getOrCreateSession(sessionKey, agentId, stateDir);
    emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    crashRecovery = new RuntimeCrashRecoveryCoordinator({ instanceId: "skill-request-fixture" });
    crashRecovery.start();
  });
  afterEach(async () => {
    crashRecovery.stopGracefully("fixture_complete");
    emitSpy.mockRestore();
    await cleanupIsolatedRaviState(stateDir);
  });

  test("includes the authorized textual catalog exactly once even for CLI-only delivery", async () => {
    const { runtimeRequest } = await request({ cliOnly: true });
    expect(runtimeRequest.skillPolicy?.status).toBe("empty");
    expect(runtimeRequest.systemPromptAppend.match(/<ravi-authorized-skills /g)).toHaveLength(1);
    expect(runtimeRequest.systemPromptAppend).toContain("\n[]\n</ravi-authorized-skills>");
  }, 60_000);

  test("does not duplicate a native-restricted catalog as textual announcement", async () => {
    const { runtimeRequest } = await request({ native: true });
    expect(runtimeRequest.systemPromptAppend).not.toContain("<ravi-authorized-skills");
  }, 20_000);

  test("does not resume a legacy provider context without policy proof", async () => {
    persistProviderContext("old-unfiltered", { instructions: "LEGACY_PROVIDER_INSTRUCTIONS" });
    saveMessage(sessionKey, "user", "CANONICAL_HISTORY", "old-unfiltered");
    const before = getHistory(sessionKey);
    const { runtimeRequest, session } = await request();
    expect(runtimeRequest.resume).toBeUndefined();
    expect(runtimeRequest.resumeSession).toBeUndefined();
    expect(runtimeRequest.forkSession).toBeUndefined();
    expect(runtimeRequest.systemPromptAppend).not.toContain("LEGACY_PROVIDER_INSTRUCTIONS");
    expect(session.providerSessionId).toBeUndefined();
    expect(getSession(sessionKey)?.providerSessionId).toBeUndefined();
    expect(getSession(sessionKey)?.runtimeSessionParams?.skillPolicySession).toMatchObject({
      snapshotId: runtimeRequest.skillPolicy?.id,
    });
    expect(getHistory(sessionKey)).toEqual(before);
  }, 20_000);

  test("does not inherit an unproved parent context when starting a thread", async () => {
    persistProviderContext("parent-unfiltered", { legacy: true });
    const { runtimeRequest } = await request({ key: `${sessionKey}:thread:child` });
    expect(runtimeRequest.resume).toBeUndefined();
    expect(runtimeRequest.forkSession).toBeUndefined();
    expect(getSession(sessionKey)?.providerSessionId).toBe("parent-unfiltered");
  }, 20_000);

  test("rebinds equivalent authority across executions without discarding a valid session", async () => {
    const first = await request();
    const params = getSession(sessionKey)?.runtimeSessionParams;
    persistProviderContext("authorized-provider-session", params);
    const next = await request({ runId: "run-2" });
    expect(next.runtimeRequest.resume).toBe("authorized-provider-session");
    expect(next.runtimeRequest.skillPolicy?.id).not.toBe(first.runtimeRequest.skillPolicy?.id);
    expect(next.runtimeRequest.resumeSession?.params?.skillPolicySession).toMatchObject({
      snapshotId: next.runtimeRequest.skillPolicy?.id,
    });
    expect(next.runtimeRequest.systemPromptAppend).not.toContain("No verified human input is available");
  }, 20_000);

  test("rebuilds with authorized effect IDs and never copies the saved prompt", async () => {
    persistProviderContext("old-provider", {
      skillPolicyRebuild: {
        contractVersion: 1,
        reason: "skill-policy-change",
        continuity: {
          prompt: "REVOKED_PROMPT",
          humanInputIds: ["forged-human"],
          effects: [
            { id: "effect-completed", status: "completed" },
            { id: "effect-uncertain", status: "uncertain" },
          ],
        },
      },
    });
    const { runtimeRequest } = await request();
    expect(runtimeRequest.resume).toBeUndefined();
    expect(runtimeRequest.systemPromptAppend).toContain("effect-completed");
    expect(runtimeRequest.systemPromptAppend).toContain("effect-uncertain");
    expect(runtimeRequest.systemPromptAppend).not.toContain("REVOKED_PROMPT");
    expect(runtimeRequest.systemPromptAppend).not.toContain("forged-human");
  }, 20_000);

  test("revocation invalidates both the live request and later native resume", async () => {
    const skillDir = join(stateDir, ".agents", "skills", "granted");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      '---\nname: granted\ndescription: Granted fixture\nravi.requires: {"kind":"none"}\n---\nALLOWED_CONTENT\n',
    );
    const id = "local:workspace:agents:granted";
    dbUpsertSkillGrant({ agentId, skillName: id });
    const first = await request();
    expect(first.runtimeRequest.skillPolicy?.skills.map((skill) => skill.id)).toContain(id);
    persistProviderContext("session-before-revocation", getSession(sessionKey)?.runtimeSessionParams);
    dbDeleteSkillGrant(agentId, id);
    await expect(first.runtimeRequest.verifySkillPolicy?.()).rejects.toThrow();
    const next = await request({ runId: "run-revoked" });
    expect(next.runtimeRequest.resume).toBeUndefined();
    expect(next.runtimeRequest.resumeSession).toBeUndefined();
    expect(next.runtimeRequest.skillPolicy?.skills.map((skill) => skill.id)).not.toContain(id);
    expect(getSession(sessionKey)?.providerSessionId).toBeUndefined();
  }, 20_000);
});
