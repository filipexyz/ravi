/**
 * The operator's `ravi sessions send` into a session that answers into a
 * chat, run the way the runtime runs it: the turn context comes from
 * `buildRuntimeStartRequest` and its first turn, then a connector call in
 * that turn classifies it from `RAVI_CONTEXT_KEY`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { CloudAuthError } from "../cloud-auth/errors.js";
import { dbUpsertChat } from "../router/router-db.js";
import { attachChatToSession, getOrCreateSession, type AgentConfig, type SessionEntry } from "../router/index.js";
import type { RuntimeCrashRecoveryCoordinator } from "../runtime/crash-recovery.js";
import { createQueuedRuntimeUserMessage } from "../runtime/delivery-queue.js";
import type { RuntimeHostStreamingSession } from "../runtime/host-session.js";
import type { RuntimeLaunchPrompt } from "../runtime/message-types.js";
import { buildRuntimeStartRequest } from "../runtime/runtime-request-builder.js";
import { buildSessionRelayTurnOrigin } from "../runtime/turn-origin.js";
import type { RuntimeCapabilities, RuntimeSessionHandle } from "../runtime/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { resolveConnectorTurn } from "./connector-turn.js";

const SESSION_KEY = "agent:main:whatsapp:wa-main:group:120363012345678901";
const SESSION_NAME = "familia";
const AGENT_ID = "main";
const PROVIDER_ID = "relay-provider";
const MODEL = "relay-model";
const OWNER = { activeUserId: "user_luis", activeOrgId: "org_1", ownerName: "Luis" };

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
  },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  supportsSessionResume: true,
  supportsSessionFork: true,
  supportsPartialText: true,
  supportsToolHooks: true,
  supportsHostSessionHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-connector-turn-relay-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function emptyRuntimeSession(): RuntimeSessionHandle {
  return { provider: PROVIDER_ID, events: (async function* () {})(), interrupt: async () => {} };
}

function streamingSession(prompt: RuntimeLaunchPrompt): RuntimeHostStreamingSession {
  return {
    agentId: AGENT_ID,
    queryHandle: emptyRuntimeSession(),
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [createQueuedRuntimeUserMessage(prompt)],
    currentModel: MODEL,
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: false,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "active",
    traceRunId: "run-connector-relay",
  };
}

/** Start the session's runtime for `prompt` and its first turn; return the turn's env and stream state. */
async function startTurn(prompt: RuntimeLaunchPrompt) {
  const sessionCwd = stateDir ?? "/tmp";
  const session: SessionEntry = {
    sessionKey: SESSION_KEY,
    name: SESSION_NAME,
    agentId: AGENT_ID,
    agentCwd: sessionCwd,
    createdAt: 1,
    updatedAt: 1,
  };
  const agent: AgentConfig = { id: AGENT_ID, cwd: sessionCwd, provider: PROVIDER_ID, settingSources: ["project"] };
  const streaming = streamingSession(prompt);
  let attempt = 0;
  const { runtimeRequest } = await buildRuntimeStartRequest({
    runId: "run-connector-relay",
    sessionName: SESSION_NAME,
    prompt,
    session,
    agent,
    runtimeProviderId: PROVIDER_ID,
    runtimeProvider: {
      id: PROVIDER_ID,
      getCapabilities: () => capabilities,
      startSession: () => emptyRuntimeSession(),
    },
    runtimeCapabilities: capabilities,
    sessionCwd,
    dbSessionKey: SESSION_KEY,
    model: MODEL,
    runtimeResolution: {
      options: { model: MODEL },
      sources: { model: "agent_default", effort: null, thinking: null },
      hasTaskRuntimeContext: false,
    },
    storedRuntimeSessionParams: undefined,
    canResumeStoredSession: false,
    resolvedSource: undefined,
    streamingSession: streaming,
    stashedMessages: new Map(),
    defaultRuntimeProviderId: "claude",
    crashRecovery: {
      startTurnAttempt: () => ({ attemptId: `attempt-connector-relay-${++attempt}` }),
      markTurnAttemptSafety: () => undefined,
    } as unknown as RuntimeCrashRecoveryCoordinator,
  });
  await expect(runtimeRequest.prompt.next()).resolves.toMatchObject({ done: false });
  const env = { RAVI_CONTEXT_KEY: runtimeRequest.env?.RAVI_CONTEXT_KEY ?? "" };
  streaming.done = true;
  streaming.onTurnComplete?.();
  await runtimeRequest.prompt.return(undefined);
  return { env, streaming };
}

/** What `ravi sessions send <session> "..."` publishes from the terminal. */
function relayPrompt(extra: Partial<RuntimeLaunchPrompt> = {}): RuntimeLaunchPrompt {
  return {
    prompt: "what is my latest email?",
    context: { channelId: "whatsapp", channelName: "WhatsApp", isGroup: true, groupName: "Familia" },
    _turnOrigin: buildSessionRelayTurnOrigin("send", undefined),
    ...extra,
  } as RuntimeLaunchPrompt;
}

describe("operator relay into a session that answers into a group", () => {
  beforeEach(() => {
    getOrCreateSession(SESSION_KEY, AGENT_ID, stateDir ?? "/tmp", { name: SESSION_NAME });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "wa-main",
      platformChatId: "120363012345678901@g.us",
      chatType: "group",
    });
    attachChatToSession({
      sessionKey: SESSION_KEY,
      chatId: chat.id,
      role: "primary",
      attachedByType: "system",
      attachedReason: "inbound-route",
      setOutputTarget: true,
    });
  });

  it("blocks the operator's accounts when the session posts the answer into the group", async () => {
    const { env, streaming } = await startTurn(relayPrompt());

    // The runtime would post this turn's answer into the group.
    expect(streaming.currentReplyTarget).toMatchObject({ channel: "whatsapp", chatId: "120363012345678901@g.us" });
    const result = resolveConnectorTurn({ ...OWNER, env });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error as CloudAuthError).code).toBe("CONNECTOR_GROUP_BLOCKED");
    expect(result.error.exitCode).toBe(3);
  });

  it("keeps a relay whose answer comes back to the waiting terminal on the operator's accounts", async () => {
    const { env, streaming } = await startTurn(relayPrompt({ _cliDestination: true }));

    expect(streaming.suppressChatEmit).toBe(true);
    const result = resolveConnectorTurn({ ...OWNER, env });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.turn).toMatchObject({
      actorPrincipal: "automation:operator:local",
      speaker: { kind: "owner" },
      conversation: "terminal",
    });
  });
});
