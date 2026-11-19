/**
 * A trigger fire through the real turn start: what the runtime records for the
 * turn (its session, where it answers) and what Bases then decides from it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolveAccessActor } from "../access/actor.js";
import { registerInboundSlackThread } from "../channels/slack/thread-lifecycle-store.js";
import { writeCachedActorBinding } from "../cloud-auth/actor-bindings.js";
import { type AgentConfig } from "../router/index.js";
import { dbCanonicalizeDmChatForContact, dbUpsertChat } from "../router/router-db.js";
import {
  attachChatToSession,
  getOrCreateSession,
  resetSession,
  resolveSession,
  updateSessionSource,
} from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { TriggerRunAuthority } from "../triggers/authority.js";
import type { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { resolveRuntimeContext } from "./context-registry.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { buildRuntimeStartRequest, resolveRuntimePromptSource } from "./runtime-request-builder.js";
import type { RuntimeCapabilities, RuntimeSessionHandle } from "./types.js";

const AGENT_ID = "main";
const PROVIDER_ID = "trace-provider";
const MODEL = "trace-model";
const TRIGGER_ID = "ab12cd34";
/** The trigger's own session: the one only its `isolated` fires enter while a person owns it. */
const OWN_SESSION = `agent:${AGENT_ID}:trigger:${TRIGGER_ID}:own`;
// A trigger's own session goes by its key.
const OWN_SESSION_NAME = OWN_SESSION;
const CHAT_SESSION = `agent:${AGENT_ID}:whatsapp:dm:5511888888888`;
const OWNER_JID = "5511999999999@s.whatsapp.net";
const ANA_JID = "5511888888888@s.whatsapp.net";
const OWNER = {
  activeUserId: "user_luis",
  activeOrgId: "org_1",
  ownerName: "Luis",
  getContactStatus: () => "allowed",
};

const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: { permissionMode: "ravi-host", accessRequirement: "tool_and_executable", supportsParallelCalls: false },
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
  stateDir = await createIsolatedRaviState("ravi-runtime-request-trigger-owner-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function emptyRuntimeSession(): RuntimeSessionHandle {
  return { provider: PROVIDER_ID, events: (async function* () {})(), interrupt: async () => {} };
}

function directChat(platformChatId: string, contactId: string, consoleUserId: string) {
  const chat = dbUpsertChat({ channel: "whatsapp", instanceId: "", platformChatId, chatType: "dm" });
  writeCachedActorBinding({
    contactId,
    actorPrincipal: `contact:${contactId}`,
    consoleUserId,
    orgId: "org_1",
    installationId: "inst_1",
  });
  return dbCanonicalizeDmChatForContact({ chatId: chat.id, contactId, platformChatId });
}

function attachOutput(sessionKey: string, chatId: string): void {
  attachChatToSession({
    sessionKey,
    chatId,
    role: "primary",
    attachedByType: "system",
    attachedReason: "inbound-route",
    setOutputTarget: true,
  });
}

function snapshot(overrides: Partial<TriggerRunAuthority> = {}): TriggerRunAuthority {
  return {
    triggerId: TRIGGER_ID,
    ownerPrincipal: "operator",
    ownerIsOperator: true,
    ownSessionKey: OWN_SESSION,
    ...overrides,
  };
}

function fire(
  authority: TriggerRunAuthority | undefined,
  extra: Partial<RuntimeLaunchPrompt> = {},
): RuntimeLaunchPrompt {
  return {
    prompt: "[Trigger: rows] summarize the row",
    _trigger: true,
    _triggerId: TRIGGER_ID,
    ...(authority ? { _triggerAuthority: authority } : {}),
    ...extra,
  };
}

/** Starts the first turn of a session the way the host does, and reads what it recorded. */
async function startTurn(input: { sessionKey: string; sessionName: string; prompt: RuntimeLaunchPrompt }) {
  // The trigger's own session exists because its runner created it.
  getOrCreateSession(input.sessionKey, AGENT_ID, stateDir!, { name: input.sessionName }, { triggerRunner: true });
  const session = resolveSession(input.sessionKey);
  if (!session) throw new Error("expected the session to exist");
  const resolvedSource = resolveRuntimePromptSource(input.prompt, session);
  const streaming: RuntimeHostStreamingSession = {
    sessionKey: input.sessionKey,
    agentId: AGENT_ID,
    queryHandle: emptyRuntimeSession(),
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [createQueuedRuntimeUserMessage(input.prompt)],
    currentSource: resolvedSource,
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
    traceRunId: "run-trigger-owner",
  };
  let attempt = 0;
  const agent: AgentConfig = { id: AGENT_ID, cwd: stateDir!, provider: PROVIDER_ID, settingSources: ["project"] };
  const { runtimeRequest } = await buildRuntimeStartRequest({
    runId: "run-trigger-owner",
    sessionName: input.sessionName,
    prompt: input.prompt,
    session,
    agent,
    runtimeProviderId: PROVIDER_ID,
    runtimeProvider: {
      id: PROVIDER_ID,
      getCapabilities: () => capabilities,
      startSession: () => emptyRuntimeSession(),
    },
    runtimeCapabilities: capabilities,
    sessionCwd: stateDir!,
    dbSessionKey: input.sessionKey,
    model: MODEL,
    runtimeResolution: {
      options: { model: MODEL },
      sources: { model: "agent_default", effort: null, thinking: null },
      hasTaskRuntimeContext: false,
    },
    storedRuntimeSessionParams: undefined,
    canResumeStoredSession: false,
    resolvedSource,
    streamingSession: streaming,
    stashedMessages: new Map(),
    defaultRuntimeProviderId: "claude",
    crashRecovery: {
      startTurnAttempt: () => ({ attemptId: `attempt-trigger-owner-${++attempt}` }),
      markTurnAttemptSafety: () => undefined,
    } as unknown as RuntimeCrashRecoveryCoordinator,
  });
  await expect(runtimeRequest.prompt.next()).resolves.toMatchObject({ done: false });
  const contextKey = runtimeRequest.env?.RAVI_CONTEXT_KEY;
  if (!contextKey) throw new Error("expected a turn context key");
  const env = { RAVI_CONTEXT_KEY: contextKey };
  return {
    streaming,
    metadata: resolveRuntimeContext(contextKey, { touch: false })?.metadata ?? {},
    /** What a Bases command run in this turn is told. */
    bases: () => resolveAccessActor({ triggerRoutines: true, turn: { ...OWNER, env } }),
    /** What every other caller is told. */
    others: () => resolveAccessActor({ turn: { ...OWNER, env } }),
    async end() {
      streaming.done = true;
      await runtimeRequest.prompt.return(undefined);
    },
  };
}

describe("a trigger fire that lends its owner's authority, from the start of its turn", () => {
  it("runs in the trigger's own session, answers nowhere, and acts in Bases as the operator who owns it", async () => {
    const turn = await startTurn({ sessionKey: OWN_SESSION, sessionName: OWN_SESSION_NAME, prompt: fire(snapshot()) });

    expect(turn.metadata.triggerRunAuthority).toEqual(snapshot());
    expect(turn.metadata.turnReplyTarget).toEqual({ kind: "none" });
    expect(turn.streaming.suppressChatEmit).toBe(true);
    expect(turn.bases()).toEqual({ kind: "operator" });
    // Only Bases reads the owner: every other caller keeps refusing the turn.
    expect(turn.others()).toMatchObject({ kind: "refused", reason: { kind: "unknown" } });
    await turn.end();
  });

  it("acts for the contact who owns the trigger, as a routine", async () => {
    const turn = await startTurn({
      sessionKey: OWN_SESSION,
      sessionName: OWN_SESSION_NAME,
      prompt: fire(snapshot({ ownerPrincipal: "contact:c_ana", ownerIsOperator: false })),
    });

    expect(turn.bases()).toEqual({
      kind: "contact",
      contactId: "c_ana",
      routine: { kind: "trigger", id: TRIGGER_ID },
    });
    await turn.end();
  });

  it("stays bound to no answer, and loses its owner, when someone's chat is attached to its session after it started", async () => {
    const turn = await startTurn({ sessionKey: OWN_SESSION, sessionName: OWN_SESSION_NAME, prompt: fire(snapshot()) });
    expect(turn.bases()).toEqual({ kind: "operator" });

    // Someone attaches their chat as the session's output while the turn runs:
    // the answer is still posted nowhere, and from then on the session is no
    // longer the trigger's alone, so Bases refuses the rest of the turn.
    const ana = directChat(ANA_JID, "c_ana", "user_ana");
    attachOutput(OWN_SESSION, ana.id);
    expect(turn.streaming.suppressChatEmit).toBe(true);
    expect(turn.streaming.currentReplyTarget ?? null).toBeNull();
    expect(turn.metadata.turnReplyTarget).toEqual({ kind: "none" });
    expect(turn.bases()).toMatchObject({
      kind: "refused",
      reason: { kind: "routine_shared_session", routine: "trigger", jobId: TRIGGER_ID },
    });
    await turn.end();
  });

  it("bases_under_public_a_do_not_reach_attached_chat_b", async () => {
    // Fire 1: nobody reads the answer (public A), so the turn acts in Bases
    // as the owner. What it read stays in the session's history.
    const first = await startTurn({ sessionKey: OWN_SESSION, sessionName: OWN_SESSION_NAME, prompt: fire(snapshot()) });
    expect(first.bases()).toEqual({ kind: "operator" });
    expect(first.metadata.turnReplyTarget).toEqual({ kind: "none" });
    expect(resolveSession(OWN_SESSION)?.triggerOwnerLentAt).toBeNumber();
    await first.end();

    // Between fires, someone attaches their chat as the session's output (public B).
    const ana = directChat(ANA_JID, "c_ana", "user_ana");
    attachOutput(OWN_SESSION, ana.id);

    // Fire 2 starts on a fresh runtime (nothing kept in memory): the history
    // it continues was read for nobody but the owner, so chat B gets no
    // answer from it, and the turn reads nothing new as the owner either.
    const second = await startTurn({
      sessionKey: OWN_SESSION,
      sessionName: OWN_SESSION_NAME,
      prompt: fire(snapshot()),
    });
    expect(second.streaming.suppressChatEmit).toBe(true);
    expect(second.streaming.currentReplyTarget ?? null).toBeNull();
    expect(second.streaming.lastBoundReplyTarget ?? null).toBeNull();
    expect(second.metadata.turnReplyTarget).toEqual({ kind: "none" });
    expect(second.bases()).toMatchObject({
      kind: "refused",
      reason: { kind: "routine_shared_session", routine: "trigger", jobId: TRIGGER_ID },
    });
    await second.end();

    // A fire that lends nothing is held to the same history.
    const third = await startTurn({
      sessionKey: OWN_SESSION,
      sessionName: OWN_SESSION_NAME,
      prompt: fire(snapshot({ ownerPrincipal: "unknown", ownerIsOperator: false })),
    });
    expect(third.streaming.suppressChatEmit).toBe(true);
    expect(third.metadata.turnReplyTarget).toEqual({ kind: "none" });
    await third.end();

    // Keeping the history keeps the hold; only dropping it lets the session
    // answer chat B, with nothing of public A left to answer from.
    resetSession(OWN_SESSION, { preserveHistoryContext: true });
    expect(resolveSession(OWN_SESSION)?.triggerOwnerLentAt).toBeNumber();
    resetSession(OWN_SESSION);
    expect(resolveSession(OWN_SESSION)?.triggerOwnerLentAt).toBeUndefined();
    const afterReset = await startTurn({
      sessionKey: OWN_SESSION,
      sessionName: OWN_SESSION_NAME,
      prompt: fire(snapshot()),
    });
    expect(afterReset.streaming.suppressChatEmit).toBe(false);
    expect(afterReset.metadata.turnReplyTarget).toMatchObject({ kind: "chat", canonicalChatId: ana.id });
    expect(afterReset.bases()).toMatchObject({ kind: "refused", reason: { kind: "routine_shared_session" } });
    expect(resolveSession(OWN_SESSION)?.triggerOwnerLentAt).toBeUndefined();
    await afterReset.end();
  });

  it("is refused with a chat attached to its session, its owner's own direct chat included", async () => {
    const luis = directChat(OWNER_JID, "c_luis", "user_luis");
    getOrCreateSession(OWN_SESSION, AGENT_ID, stateDir!, { name: OWN_SESSION_NAME }, { triggerRunner: true });
    attachOutput(OWN_SESSION, luis.id);
    const turn = await startTurn({ sessionKey: OWN_SESSION, sessionName: OWN_SESSION_NAME, prompt: fire(snapshot()) });

    // The session runs the trigger's fires only: it is not a place to chat.
    expect(turn.metadata.turnReplyTarget).toMatchObject({ kind: "chat", canonicalChatId: luis.id });
    expect(turn.bases()).toMatchObject({
      kind: "refused",
      reason: { kind: "routine_shared_session", routine: "trigger", jobId: TRIGGER_ID },
    });
    await turn.end();
  });

  it("is refused when someone else's chat is its session's output", async () => {
    directChat(OWNER_JID, "c_luis", "user_luis");
    const ana = directChat(ANA_JID, "c_ana", "user_ana");
    getOrCreateSession(OWN_SESSION, AGENT_ID, stateDir!, { name: OWN_SESSION_NAME }, { triggerRunner: true });
    attachOutput(OWN_SESSION, ana.id);
    const turn = await startTurn({ sessionKey: OWN_SESSION, sessionName: OWN_SESSION_NAME, prompt: fire(snapshot()) });

    // The answer would go to that chat, and its conversation shares the session.
    expect(turn.metadata.turnReplyTarget).toMatchObject({ kind: "chat", canonicalChatId: ana.id });
    expect(turn.bases()).toMatchObject({
      kind: "refused",
      reason: { kind: "routine_shared_session", routine: "trigger", jobId: TRIGGER_ID },
    });
    await turn.end();
  });

  it("is refused when someone else's chat feeds its session, even though the answer goes nowhere", async () => {
    const ana = directChat(ANA_JID, "c_ana", "user_ana");
    getOrCreateSession(OWN_SESSION, AGENT_ID, stateDir!, { name: OWN_SESSION_NAME }, { triggerRunner: true });
    attachChatToSession({
      sessionKey: OWN_SESSION,
      chatId: ana.id,
      role: "input",
      attachedByType: "system",
      attachedReason: "inbound-route",
      setOutputTarget: false,
    });
    const turn = await startTurn({ sessionKey: OWN_SESSION, sessionName: OWN_SESSION_NAME, prompt: fire(snapshot()) });

    expect(turn.metadata.turnReplyTarget).toEqual({ kind: "none" });
    expect(turn.bases()).toMatchObject({
      kind: "refused",
      reason: { kind: "routine_shared_session", routine: "trigger", jobId: TRIGGER_ID },
    });
    await turn.end();
  });
});

describe("a trigger fire that lends nothing, from the start of its turn", () => {
  it("is refused in a chat's session, and answers there as it always did", async () => {
    const ana = directChat(ANA_JID, "c_ana", "user_ana");
    getOrCreateSession(CHAT_SESSION, AGENT_ID, stateDir!, { name: "requests-queue" });
    attachOutput(CHAT_SESSION, ana.id);
    // The runner names no session of the trigger's own for a fire sent to a chat's session.
    const turn = await startTurn({
      sessionKey: CHAT_SESSION,
      sessionName: "requests-queue",
      prompt: fire(snapshot({ ownSessionKey: null })),
    });

    expect(turn.streaming.suppressChatEmit).toBe(false);
    expect(turn.metadata.turnReplyTarget).toMatchObject({ kind: "chat", canonicalChatId: ana.id });
    expect(turn.bases()).toMatchObject({
      kind: "refused",
      reason: { kind: "routine_shared_session", routine: "trigger", jobId: TRIGGER_ID },
    });
    await turn.end();
  });

  it("is refused in a chat's session whose chat was detached, where the answer would go nowhere", async () => {
    getOrCreateSession(CHAT_SESSION, AGENT_ID, stateDir!, { name: "requests-queue" });
    const turn = await startTurn({
      sessionKey: CHAT_SESSION,
      sessionName: "requests-queue",
      prompt: fire(snapshot({ ownSessionKey: null })),
    });

    // Not pinned to no answer: nothing is lent, so the turn is delivered as before.
    expect(turn.streaming.suppressChatEmit).toBe(false);
    expect(turn.bases()).toMatchObject({ kind: "refused", reason: { kind: "routine_shared_session" } });
    await turn.end();
  });

  it("is refused when the turn starts in another session than the one the fire was sent to", async () => {
    // The fire's envelope, snapshot included, reached a chat's session.
    getOrCreateSession(CHAT_SESSION, AGENT_ID, stateDir!, { name: "requests-queue" });
    const turn = await startTurn({ sessionKey: CHAT_SESSION, sessionName: "requests-queue", prompt: fire(snapshot()) });

    expect(turn.streaming.suppressChatEmit).toBe(false);
    expect(turn.bases()).toMatchObject({
      kind: "refused",
      reason: { kind: "routine_shared_session", routine: "trigger", jobId: TRIGGER_ID },
    });
    await turn.end();
  });

  it("is refused for a trigger nobody owns, in its own session, and is delivered as before", async () => {
    const turn = await startTurn({
      sessionKey: OWN_SESSION,
      sessionName: OWN_SESSION_NAME,
      prompt: fire(snapshot({ ownerPrincipal: "unknown", ownerIsOperator: false })),
    });

    expect(turn.streaming.suppressChatEmit).toBe(false);
    expect(turn.metadata.turnReplyTarget).toEqual({ kind: "unresolved" });
    expect(turn.bases()).toMatchObject({
      kind: "refused",
      reason: { kind: "routine_not_operator_owned", routine: "trigger", jobId: TRIGGER_ID, ownerPrincipal: "unknown" },
    });
    await turn.end();
  });

  it("is refused without a snapshot at all", async () => {
    const turn = await startTurn({ sessionKey: OWN_SESSION, sessionName: OWN_SESSION_NAME, prompt: fire(undefined) });

    expect(turn.metadata.triggerRunAuthority).toBeNull();
    expect(turn.streaming.suppressChatEmit).toBe(false);
    expect(turn.bases()).toMatchObject({ kind: "refused", reason: { kind: "unknown" } });
    await turn.end();
  });
});

describe("a follow addressed to a thread child through the real turn start", () => {
  const PARENT_KEY = `agent:${AGENT_ID}:slack:ravi-slack:C123`;
  const THREAD_TS = "1713000000.000100";
  const CHILD_KEY = `${PARENT_KEY}:thread:${THREAD_TS}`;
  const CHILD_NAME = "slack-follow-child";

  /** A thread child whose only attachment is the thread's own chat, as `create-thread` makes it. */
  function seedThreadChild() {
    getOrCreateSession(PARENT_KEY, AGENT_ID, stateDir!, { name: "slack-follow-parent" });
    getOrCreateSession(CHILD_KEY, AGENT_ID, stateDir!, { name: CHILD_NAME });
    const threadChat = dbUpsertChat({
      channel: "slack",
      instanceId: "slack-instance",
      platformChatId: `C123#${THREAD_TS}`,
      chatType: "thread",
    });
    attachOutput(CHILD_KEY, threadChat.id);
    return threadChat;
  }

  function followFire(source: Record<string, unknown>): RuntimeLaunchPrompt {
    return {
      prompt: "[Trigger: gh-follow] CI completed",
      _trigger: true,
      _triggerId: TRIGGER_ID,
      source: source as never,
    };
  }

  it("answers in the thread when the runner addresses a follow to its open thread child, and nowhere when it does not", async () => {
    const threadChat = seedThreadChild();
    registerInboundSlackThread({
      parentSessionKey: PARENT_KEY,
      parentSessionName: "slack-follow-parent",
      childSessionKey: CHILD_KEY,
      childSessionName: CHILD_NAME,
      accountId: "ravi-slack",
      instanceId: "slack-instance",
      platformChatId: "C123",
      threadCanonicalChatId: threadChat.id,
      providerThreadId: THREAD_TS,
    });
    // A programmatic child remembers the channel root as its last chat and the timestamp apart from it.
    updateSessionSource(CHILD_KEY, { channel: "slack", accountId: "ravi-slack", chatId: "C123" });
    const { sourceForReplySession } = await import("../triggers/runner.js");
    const thread = { channel: "slack", accountId: "ravi-slack", chatId: "C123" };
    const forFollow = sourceForReplySession(
      { replySource: { ...thread, threadId: THREAD_TS } },
      resolveSession(CHILD_KEY),
    );
    const forPlain = sourceForReplySession({ replySource: thread }, resolveSession(CHILD_KEY));

    // The source the runner builds for a follow armed on the open thread leads the reply into that thread.
    const answered = await startTurn({
      sessionKey: CHILD_KEY,
      sessionName: CHILD_NAME,
      prompt: followFire(forFollow!),
    });
    expect(answered.streaming.currentReplyTarget).toMatchObject({
      channel: "slack",
      chatId: "C123",
      threadId: THREAD_TS,
      canonicalChatId: threadChat.id,
    });
    await answered.end();

    // The root-only source it used to build cannot be matched to the thread's attachment: the reply had nowhere to go.
    const dropped = await startTurn({ sessionKey: CHILD_KEY, sessionName: CHILD_NAME, prompt: followFire(forPlain!) });
    expect(dropped.streaming.currentReplyTarget ?? null).toBeNull();
    await dropped.end();
  });
});
