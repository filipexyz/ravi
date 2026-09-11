import type { SkillExposureCapabilities } from "./skill-exposure-contract.js";
import { resolveSkillPolicy } from "./skill-policy.js";
import type { RuntimeCapabilities, RuntimeStartRequest, SessionRuntimeProvider } from "./types.js";

export function fixtureSkillExposureCapabilities(): SkillExposureCapabilities {
  return {
    contractVersion: 1,
    modes: ["textual"],
    nativeDiscovery: { user: "none", project: "none", plugins: "none" },
    contextUpdate: "rebuild",
    modelCallFence: { contractVersion: 1, guarantee: "before-every-model-call" },
  };
}

export function fixtureRuntimeCapabilities(): RuntimeCapabilities {
  return {
    skillExposure: fixtureSkillExposureCapabilities(),
    runtimeControl: { supported: false, operations: [] },
    dynamicTools: { mode: "none" },
    execution: { mode: "embedded" },
    sessionState: { mode: "provider-session-id" },
    usage: { semantics: "terminal-event" },
    tools: { permissionMode: "ravi-host", accessRequirement: "tool_and_executable", supportsParallelCalls: false },
    systemPrompt: { mode: "append" },
    terminalEvents: { guarantee: "adapter" },
    skillVisibility: { availability: "none", loadedState: "none" },
    supportsSessionResume: false,
    supportsSessionFork: false,
    supportsPartialText: false,
    supportsToolHooks: true,
    supportsPlugins: false,
    supportsMcpServers: false,
    supportsRemoteSpawn: false,
  };
}

export function fixtureRuntimeProvider(onStart: () => void = () => {}): SessionRuntimeProvider {
  return {
    id: "future-fixture-adapter",
    getCapabilities: fixtureRuntimeCapabilities,
    prepareSession: (input) => ({
      skillExposure: {
        snapshotId: input.skillPolicy?.id ?? "missing",
        mode: "textual",
        preparedIds: input.skillPolicy?.skills.map((skill) => skill.id) ?? [],
      },
    }),
    startSession() {
      onStart();
      return { provider: this.id, events: (async function* () {})(), interrupt: async () => {} };
    },
  };
}

export function fixtureRuntimeStartRequest(): RuntimeStartRequest {
  const snapshot = resolveSkillPolicy({
    scope: { agentId: "agent-fixture", executionId: "execution-fixture", contextKey: "rctx_secret_fixture" },
    revisions: { policy: "1", catalog: "1", permissions: "1", toolSurface: "1" },
    catalog: [],
    selection: { baseline: [], fromCapabilities: [], fromGrants: [], local: [] },
    capabilityState: { available: [], authorized: [] },
  });
  return {
    skillPolicy: snapshot,
    skillExposure: { snapshotId: snapshot.id, mode: "textual", preparedIds: [] },
    verifySkillPolicy: () => {},
    verifySkillPolicyAtDispatch: () => {},
    prompt: (async function* () {})(),
    model: "fixture-model",
    cwd: process.cwd(),
    abortController: new AbortController(),
    systemPromptAppend: "",
  };
}
