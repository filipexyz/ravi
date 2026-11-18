/**
 * Work the operator asked for keeps the operator when an agent does it in
 * another session: a Slack thread the parent session keeps handing work to,
 * and a task the task runtime dispatches. Both run through the real runtime
 * context builder and the Bases actor decision (`accessActorFromTurn`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { accessActorFromTurn } from "../access/actor.js";
import { registerInboundSlackThread } from "../channels/slack/thread-lifecycle-store.js";
import { runWithContext } from "../cli/context.js";
import { createContact } from "../contacts.js";
import { resolveConnectorTurn } from "../link/connector-turn.js";
import { dbCreateAgent, dbGetContext, type ContextRecord } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { prepareTaskDispatch } from "../tasks/dispatch-admission.js";
import { createTask } from "../tasks/service.js";
import { dbCompleteTask, dbDispatchTask } from "../tasks/task-db.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext } from "./context-registry.js";
import {
  resolveRequesterContext,
  resolveRequesterContextIdFor,
  resolveTaskTurnRequester,
  type DelegatedRequesterDeps,
} from "./delegated-requester.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { buildRuntimeRequestContext } from "./runtime-request-context.js";
import { buildChannelTurnOrigin, buildSessionRelayTurnOrigin } from "./turn-origin.js";

const runtimeResolution: TaskRuntimeResolution = {
  options: {},
  sources: { model: null, effort: null, thinking: null },
  hasTaskRuntimeContext: false,
};
const mainAgent = { id: "deleg-main", cwd: "/tmp/deleg-main" };
const workerAgent = { id: "deleg-worker", cwd: "/tmp/deleg-worker" };
const PARENT_NAME = "deleg-dm";
const THREAD_NAME = "deleg-thread";
const keyOf = (agentId: string, name: string) => `agent:${agentId}:slack:group:deleg:${name}`;

type Turn = ReturnType<typeof buildRuntimeRequestContext>["runtimeContext"];

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-delegated-requester-");
  dbCreateAgent(mainAgent);
  dbCreateAgent(workerAgent);
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function promptFrom(contactId: string, text: string): RuntimeLaunchPrompt {
  const chat = { channel: "whatsapp", accountId: "main", chatId: "120363428243036323@g.us", canonicalChatId: "chat_1" };
  return {
    prompt: text,
    source: { ...chat, actorType: "contact", contactId },
    context: {
      channelId: "whatsapp",
      channelName: "WhatsApp",
      accountId: "main",
      chatId: chat.chatId,
      canonicalChatId: chat.canonicalChatId,
      messageId: `msg_${contactId}_${text.length}`,
      senderId: contactId,
      senderName: contactId,
      isGroup: true,
      groupName: "Ravi",
      timestamp: 1000,
      actorType: "contact",
      contactId,
    },
  };
}

function turnIn(prompt: RuntimeLaunchPrompt, agent: typeof mainAgent, name: string): Turn {
  const key = keyOf(agent.id, name);
  getOrCreateSession(key, agent.id, agent.cwd, { name });
  return buildRuntimeRequestContext({
    dbSessionKey: key,
    sessionName: name,
    sessionCwd: agent.cwd,
    agent,
    prompt,
    runtimeProviderId: "codex",
    model: "gpt-5",
    runtimeResolution,
    resolvedSource: prompt.source,
  }).runtimeContext;
}

/** The person's own message to the parent (orchestrating) session. */
function humanTurn(phone = "5511900077001") {
  const contact = createContact({ phone, name: "Requester" });
  return {
    contact,
    turn: turnIn(promptFrom(contact.id, "open a thread and write the blog base"), mainAgent, PARENT_NAME),
  };
}

/** A parent turn no person started: a [System] Inform relayed from another session. */
function parentAgentTurn(from: Turn): Turn {
  const origin = buildSessionRelayTurnOrigin("inform", {
    agentId: from.agentId,
    sessionKey: from.sessionKey,
    sessionName: from.sessionName,
    contextId: from.contextId,
  });
  return turnIn(
    { ...promptFrom("forged-contact", "[System] Inform: thread done"), _turnOrigin: origin },
    mainAgent,
    PARENT_NAME,
  );
}

/** The parent hands work to the thread's child session. */
function handToThread(caller: Turn, action: "session.bootstrap" | "execute", name = THREAD_NAME): Turn {
  const origin =
    action === "session.bootstrap"
      ? buildChannelTurnOrigin(action, { type: "agent", id: caller.agentId! }, caller.contextId)
      : buildSessionRelayTurnOrigin(action, {
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          sessionName: caller.sessionName,
          contextId: caller.contextId,
        });
  return turnIn(
    { ...promptFrom("forged-contact", "[System] Execute: keep going"), _turnOrigin: origin },
    mainAgent,
    name,
  );
}

function registerThread(childName = THREAD_NAME) {
  registerInboundSlackThread({
    parentSessionKey: keyOf(mainAgent.id, PARENT_NAME),
    parentSessionName: PARENT_NAME,
    childSessionKey: keyOf(mainAgent.id, childName),
    childSessionName: childName,
    accountId: "slack-main",
    instanceId: "slack-main",
    platformChatId: "C0DELEG",
    threadCanonicalChatId: `chat-${childName}`,
    providerThreadId: `1712345678.${childName.length}`,
  });
}

function accessFor(turn: Turn) {
  return accessActorFromTurn(
    resolveConnectorTurn({
      env: {},
      runtimeContext: { present: true, record: turn },
      activeUserId: "operator-user",
      activeOrgId: "test-org",
      ownerName: "Operator",
    }),
    { getAgentName: () => "Worker" },
  );
}

/** A task created from `creator` (the CLI runs in that turn) and dispatched to the worker. */
function dispatchedTaskTurn(creator: ContextRecord | null) {
  const create = () => createTask({ title: "Write the blog base", instructions: "Write rows", createdBy: "test" });
  const { task } = creator ? runWithContext({ context: creator }, create) : create();
  const sessionName = `task-${task.id}`;
  getOrCreateSession(keyOf(workerAgent.id, sessionName), workerAgent.id, workerAgent.cwd, { name: sessionName });
  const { assignment } = dbDispatchTask(task.id, { agentId: workerAgent.id, sessionName, assignedBy: "test" });
  const payload = prepareTaskDispatch(task, assignment, "Do the task");
  return { task, turn: turnIn(payload, workerAgent, sessionName) };
}

describe("Slack thread turns keep the person who asked for the thread", () => {
  it("a later parent handoff no person started still writes Bases as the requester", () => {
    registerThread();
    const { contact, turn } = humanTurn();
    const first = handToThread(turn, "session.bootstrap");
    expect(first.metadata?.humanRequest).toBeDefined();

    const later = handToThread(parentAgentTurn(turn), "execute");
    expect(later.metadata?.actorPrincipal).toBe(`agent:${mainAgent.id}`);
    expect(accessFor(later)).toMatchObject({ kind: "contact", contactId: contact.id });
  });

  it("a thread no person ever asked into stays refused as an agent relay", () => {
    registerThread();
    const { turn } = humanTurn();
    const later = handToThread(parentAgentTurn(turn), "execute");
    expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
  });

  it("a session that is not an open thread inherits nothing", () => {
    const { turn } = humanTurn();
    handToThread(turn, "session.bootstrap", "not-a-thread");
    const later = handToThread(parentAgentTurn(turn), "execute", "not-a-thread");
    expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
  });
});

describe("task dispatch turns keep the person who asked for the task", () => {
  it("records the creating turn's verified request and acts for that person in the task turn", () => {
    const { contact, turn } = humanTurn();
    const { task, turn: taskTurn } = dispatchedTaskTurn(turn);
    expect(taskTurn.metadata?.raviThread).toMatchObject({ scope: { type: "task", id: task.id } });
    expect(accessFor(taskTurn)).toMatchObject({ kind: "contact", contactId: contact.id });
  });

  it("a task created from a thread turn that inherits the thread's requester keeps it", () => {
    registerThread();
    const { contact, turn } = humanTurn();
    handToThread(turn, "session.bootstrap");
    const threadTurn = handToThread(parentAgentTurn(turn), "execute");
    const { turn: taskTurn } = dispatchedTaskTurn(threadTurn);
    expect(accessFor(taskTurn)).toMatchObject({ kind: "contact", contactId: contact.id });
  });

  it("a task created with no verified request behind it stays refused", () => {
    const { turn: taskTurn } = dispatchedTaskTurn(null);
    expect(accessFor(taskTurn).kind).toBe("refused");
  });

  it("a task created from a turn no person started stays refused", () => {
    const { turn } = humanTurn();
    const { turn: taskTurn } = dispatchedTaskTurn(parentAgentTurn(turn));
    expect(accessFor(taskTurn).kind).toBe("refused");
  });

  it("a finished task no longer lends its requester", () => {
    const { turn } = humanTurn();
    const { task, turn: taskTurn } = dispatchedTaskTurn(turn);
    dbCompleteTask(task.id, { actor: "test", message: "done" });
    expect(accessFor(taskTurn).kind).toBe("refused");
  });

  it("a forged task scope on a CLI child context is ignored", () => {
    const { turn } = humanTurn();
    const { turn: taskTurn } = dispatchedTaskTurn(turn);
    const forged = createRuntimeContext({
      kind: "cli-runtime",
      agentId: workerAgent.id,
      metadata: { actorPrincipal: "unknown", raviThread: taskTurn.metadata?.raviThread },
    });
    expect(accessFor(forged as Turn).kind).toBe("refused");
  });
});

describe("resolveTaskTurnRequester", () => {
  const row = {
    taskId: "task-1",
    taskStatus: "in_progress",
    taskArchived: false,
    assignmentAgentId: "worker",
    assignmentStatus: "accepted",
    requesterContextId: "ctx_req",
  };
  const resolved = { caller: { contextId: "ctx_req" } as ContextRecord, contactId: "c1", originContextId: "ctx_req" };
  const thread = { handoffId: "thf_1", scope: { type: "task", id: "task-1" } };
  const deps = (over: Partial<typeof row> = {}, requester: unknown = resolved): DelegatedRequesterDeps => ({
    getTaskDispatch: () => ({ ...row, ...over }),
    getContextById: (id) => ({ contextId: id, agentId: "main", sessionKey: "agent:main:dm" }) as ContextRecord,
    resolveRequester: () => requester as never,
  });

  it("resolves the stored requester for the active assignment's own agent", () => {
    expect(resolveTaskTurnRequester({ raviThread: thread, agentId: "worker" }, deps())).toMatchObject({
      contactId: "c1",
      taskId: "task-1",
      requesterContextId: "ctx_req",
    });
  });

  it.each([
    ["another agent", {}, "intruder", thread],
    ["a non-task scope", {}, "worker", { handoffId: "thf_1", scope: { type: "project", id: "task-1" } }],
    ["a handoff of another task", { taskId: "task-2" }, "worker", thread],
    ["a released assignment", { assignmentStatus: "released" }, "worker", thread],
    ["a finished task", { taskStatus: "done" }, "worker", thread],
    ["an archived task", { taskArchived: true }, "worker", thread],
    ["no recorded requester", { requesterContextId: null }, "worker", thread],
  ] as const)("refuses %s", (_label, over, agentId, raviThread) => {
    expect(resolveTaskTurnRequester({ raviThread, agentId }, deps(over as never))).toBeNull();
  });

  it("refuses when the recorded request no longer resolves (withdrawn, blocked)", () => {
    expect(resolveTaskTurnRequester({ raviThread: thread, agentId: "worker" }, deps({}, null))).toBeNull();
  });
});

describe("resolveRequesterContext", () => {
  it("replays the stored turn as its own agent's work handoff from its own session", () => {
    let seen: unknown;
    resolveRequesterContext("ctx_req", {
      getContextById: (id) => ({ contextId: id, agentId: "main", sessionKey: "agent:main:dm" }) as ContextRecord,
      resolveRequester: (prompt) => {
        seen = prompt._turnOrigin;
        return null;
      },
    });
    expect(seen).toMatchObject({
      producer: "session-relay",
      action: "execute",
      principal: { type: "agent", id: "main" },
      session: { key: "agent:main:dm" },
      callerContextId: "ctx_req",
    });
  });

  it("records nothing for a context outside any turn", () => {
    expect(resolveRequesterContextIdFor(null)).toBeNull();
    const orphan = createRuntimeContext({ kind: "cli-runtime", agentId: "main", metadata: {} });
    expect(resolveRequesterContextIdFor(dbGetContext(orphan.contextId))).toBeNull();
  });
});
