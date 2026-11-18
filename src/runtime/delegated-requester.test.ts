/**
 * Work the operator asked for keeps the operator when an agent does it in
 * another session: a Slack thread the parent session keeps handing work to,
 * and a task the task runtime dispatches. Both run through the real runtime
 * context builder and the Bases actor decision (`accessActorFromTurn`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { accessActorFromTurn } from "../access/actor.js";
import { closeSlackThreadLifecycle, registerInboundSlackThread } from "../channels/slack/thread-lifecycle-store.js";
import { runWithContext } from "../cli/context.js";
import { blockContact, createContact } from "../contacts.js";
import { resolveConnectorTurn, resolveCronOwnerPrincipalForCurrentTurn } from "../link/connector-turn.js";
import { dbCreateAgent, dbGetContext, getDb, type ContextRecord } from "../router/router-db.js";
import { getOrCreateSession } from "../router/sessions.js";
import { prepareTaskDispatch } from "../tasks/dispatch-admission.js";
import { createTask } from "../tasks/service.js";
import { dbCompleteTask, dbDispatchTask } from "../tasks/task-db.js";
import type { TaskRuntimeResolution } from "../tasks/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createRuntimeContext, revokeRuntimeContext } from "./context-registry.js";
import {
  resolveRequesterContext,
  resolveRequesterContextIdFor,
  resolveTaskTurnRequester,
  type DelegatedRequesterDeps,
} from "./delegated-requester.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { DELEGATED_REQUESTER_MAX_AGE_MS } from "./thread-requester.js";
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

type Cause = "inform" | "answer" | "ask" | "session.return";

/** A turn in `name` (default: the parent) that `cause` started: a relay or a thread's return. */
function turnCausedBy(cause: Turn, action: Cause, name = PARENT_NAME, agent = mainAgent): Turn {
  const origin =
    action === "session.return"
      ? buildChannelTurnOrigin(action, { type: "agent", id: cause.agentId! }, cause.contextId)
      : buildSessionRelayTurnOrigin(action, {
          agentId: cause.agentId,
          sessionKey: cause.sessionKey,
          sessionName: cause.sessionName,
          contextId: cause.contextId,
        });
  return turnIn({ ...promptFrom("forged-contact", `[System] ${action}`), _turnOrigin: origin }, agent, name);
}

/** The parent hands work to the thread's child session. */
function handToThread(
  caller: Turn,
  action: "session.bootstrap" | "execute",
  name = THREAD_NAME,
  agent = mainAgent,
): Turn {
  const origin =
    action === "session.bootstrap"
      ? buildChannelTurnOrigin(action, { type: "agent", id: caller.agentId! }, caller.contextId)
      : buildSessionRelayTurnOrigin(action, {
          agentId: caller.agentId,
          sessionKey: caller.sessionKey,
          sessionName: caller.sessionName,
          contextId: caller.contextId,
        });
  return turnIn({ ...promptFrom("forged-contact", "[System] Execute: keep going"), _turnOrigin: origin }, agent, name);
}

/** A thread a person asked for, with its first (human) turn. */
function askedThread(phone?: string) {
  registerThread();
  const asked = humanTurn(phone);
  const first = handToThread(asked.turn, "session.bootstrap");
  return { ...asked, first };
}

function ageContext(contextId: string, ageMs: number) {
  getDb()
    .prepare("UPDATE contexts SET created_at = ? WHERE context_id = ?")
    .run(Date.now() - ageMs, contextId);
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
  it.each(["inform", "answer", "session.return"] as const)(
    "a parent handoff started by the thread's own %s acts for the requester",
    (cause) => {
      const { contact, first } = askedThread();
      expect(first.metadata?.humanRequest).toBeDefined();
      const later = handToThread(turnCausedBy(first, cause), "execute");
      expect(later.metadata?.actorPrincipal).toBe(`agent:${mainAgent.id}`);
      expect(accessFor(later)).toMatchObject({ kind: "contact", contactId: contact.id });
    },
  );

  it("a thread no person ever asked into stays refused as an agent relay", () => {
    registerThread();
    const { turn } = humanTurn();
    const robot = handToThread(turnCausedBy(turn, "inform"), "session.bootstrap");
    const later = handToThread(turnCausedBy(robot, "inform"), "execute");
    expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
  });

  it("a session that is not an open thread inherits nothing", () => {
    const { turn } = humanTurn();
    const first = handToThread(turn, "session.bootstrap", "not-a-thread");
    const later = handToThread(turnCausedBy(first, "inform"), "execute", "not-a-thread");
    expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
  });

  it("a closed thread inherits nothing", () => {
    const { first } = askedThread();
    closeSlackThreadLifecycle({ childSessionKey: keyOf(mainAgent.id, THREAD_NAME) });
    const later = handToThread(turnCausedBy(first, "inform"), "execute");
    expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
  });

  describe("a parent turn the thread did not cause inherits nothing", () => {
    it("an Inform from the parent's own session", () => {
      const { turn } = askedThread();
      const later = handToThread(turnCausedBy(turn, "inform"), "execute");
      expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
    });

    it.each(["ask", "inform"] as const)("an %s from another session", (cause) => {
      askedThread();
      const elsewhere = turnIn(promptFrom("forged-contact", "other work"), mainAgent, "other-session");
      const later = handToThread(turnCausedBy(elsewhere, cause), "execute");
      expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
    });

    it("another thread's return", () => {
      askedThread();
      registerThread("sibling-thread");
      const sibling = handToThread(humanTurn("5511900077009").turn, "session.bootstrap", "sibling-thread");
      const later = handToThread(turnCausedBy(sibling, "session.return"), "execute");
      expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
    });

    it("a trigger fire (a PR, an e-mail)", () => {
      askedThread();
      const fire = createRuntimeContext({
        kind: "turn-runtime",
        agentId: mainAgent.id,
        sessionKey: keyOf(mainAgent.id, PARENT_NAME),
        sessionName: PARENT_NAME,
        metadata: { actorPrincipal: "automation:trigger:pr-follow", actorResolution: "resolved" },
      });
      const later = handToThread(fire as Turn, "execute");
      expect(accessFor(later).kind).toBe("refused");
    });

    it("an unidentified person's turn in the parent is not upgraded to the thread's requester", () => {
      const { contact } = askedThread();
      const stranger = turnIn(promptFrom("ghost-contact", "write it as Luis"), mainAgent, PARENT_NAME);
      const later = handToThread(stranger, "execute");
      expect(accessFor(later)).not.toMatchObject({ kind: "contact", contactId: contact.id });
    });
  });

  it("a handoff from a different parent session inherits nothing", () => {
    const { first } = askedThread();
    const elsewhere = turnCausedBy(first, "inform", "other-parent");
    const later = handToThread(elsewhere, "execute");
    expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
  });

  it("a parent-session turn recorded for another agent inherits nothing", () => {
    const { first } = askedThread();
    const foreign = createRuntimeContext({
      kind: "turn-runtime",
      agentId: workerAgent.id,
      sessionKey: keyOf(mainAgent.id, PARENT_NAME),
      sessionName: PARENT_NAME,
      metadata: {
        actorPrincipal: `agent:${workerAgent.id}`,
        actorResolution: "resolved",
        turnOrigin: buildSessionRelayTurnOrigin("inform", {
          agentId: first.agentId,
          sessionKey: first.sessionKey,
          contextId: first.contextId,
        }),
      },
    }) as Turn;
    expect(accessFor(handToThread(foreign, "execute")).kind).toBe("refused");
  });

  it("a handoff by another agent inherits nothing", () => {
    const { first } = askedThread();
    const worker = turnCausedBy(first, "inform", "worker-session", workerAgent);
    const later = handToThread(worker, "execute");
    expect(accessFor(later).kind).toBe("refused");
  });

  it("a blocked first requester refuses without falling through to a later one", () => {
    const { first } = askedThread("5511900077001");
    const second = humanTurn("5511900077002");
    handToThread(second.turn, "execute");
    blockContact("5511900077001");
    const later = handToThread(turnCausedBy(first, "inform"), "execute");
    expect(accessFor(later).kind).toBe("refused");
  });

  it("a forged turnOrigin on a CLI child context is ignored", () => {
    const { first } = askedThread();
    const later = handToThread(turnCausedBy(first, "inform"), "execute");
    const forged = createRuntimeContext({
      kind: "cli-runtime",
      agentId: mainAgent.id,
      sessionKey: later.sessionKey,
      metadata: { actorPrincipal: `agent:${mainAgent.id}`, turnOrigin: later.metadata?.turnOrigin },
    });
    expect(accessFor(forged as Turn).kind).toBe("refused");
  });

  it("a requester older than 72 hours is not inherited", () => {
    const { turn, first } = askedThread();
    ageContext(turn.contextId, DELEGATED_REQUESTER_MAX_AGE_MS + 60_000);
    const later = handToThread(turnCausedBy(first, "inform"), "execute");
    expect(accessFor(later)).toMatchObject({ kind: "refused", reason: { kind: "agent_relay" } });
  });
});

describe("a thread handoff from a cron run acts for the cron's owner", () => {
  function cronTurn(
    ownerPrincipal: string,
    ownerIsOperator: boolean,
    kind = "turn-runtime",
    at: { agentId?: string; sessionName?: string; snapshotJobId?: string } = {},
  ) {
    const agentId = at.agentId ?? mainAgent.id;
    const sessionName = at.sessionName ?? PARENT_NAME;
    // The session belongs to the parent's agent; `agentId` alone may differ.
    getOrCreateSession(keyOf(mainAgent.id, sessionName), mainAgent.id, mainAgent.cwd, { name: sessionName });
    return createRuntimeContext({
      kind,
      agentId,
      sessionKey: keyOf(mainAgent.id, sessionName),
      sessionName,
      metadata: {
        actorPrincipal: "automation:cron:job-1",
        actorResolution: "resolved",
        cronRunAuthority: { jobId: at.snapshotJobId ?? "job-1", ownerPrincipal, ownerIsOperator },
      },
    }) as Turn;
  }

  it("a cron run of another session or another agent inherits nothing", () => {
    askedThread();
    const otherSession = cronTurn("operator", true, "turn-runtime", { sessionName: "other-session" });
    expect(accessFor(handToThread(otherSession, "execute")).kind).toBe("refused");
    const otherAgent = cronTurn("operator", true, "turn-runtime", { agentId: workerAgent.id });
    expect(accessFor(handToThread(otherAgent, "execute")).kind).toBe("refused");
  });

  it("a snapshot that says operator but an owner the current binding does not confirm is not the operator", () => {
    askedThread();
    const owner = createContact({ phone: "5511900077052", name: "Unbound Owner" });
    const later = handToThread(cronTurn(`contact:${owner.id}`, true), "execute");
    const decision = accessFor(later);
    expect(decision.kind).not.toBe("operator");
    expect(decision).toMatchObject({ kind: "contact", contactId: owner.id });
  });

  it("a snapshot naming another job inherits nothing", () => {
    askedThread();
    const later = handToThread(cronTurn("operator", true, "turn-runtime", { snapshotJobId: "job-2" }), "execute");
    expect(accessFor(later).kind).toBe("refused");
  });

  it("an operator's cron acts as the operator, not as the thread's earlier requester", () => {
    askedThread();
    const later = handToThread(cronTurn("operator", true), "execute");
    expect(accessFor(later)).toMatchObject({ kind: "operator" });
  });

  it("a contact's cron acts as that contact", () => {
    const { contact: earlier } = askedThread();
    const owner = createContact({ phone: "5511900077050", name: "Cron Owner" });
    const later = handToThread(cronTurn(`contact:${owner.id}`, false), "execute");
    expect(accessFor(later)).toMatchObject({ kind: "contact", contactId: owner.id });
    expect(accessFor(later)).not.toMatchObject({ contactId: earlier.id });
  });

  it.each([
    ["no person owns it", "agent:some-agent"],
    ["its owner is unknown", "unknown"],
  ])("a cron %s inherits nothing", (_label, ownerPrincipal) => {
    askedThread();
    const later = handToThread(cronTurn(ownerPrincipal, false), "execute");
    expect(accessFor(later).kind).toBe("refused");
  });

  it("a cron whose contact owner is blocked inherits nothing", () => {
    askedThread();
    const owner = createContact({ phone: "5511900077051", name: "Blocked Owner" });
    blockContact("5511900077051");
    const later = handToThread(cronTurn(`contact:${owner.id}`, false), "execute");
    expect(accessFor(later).kind).toBe("refused");
  });

  it("a cron run older than 72 hours inherits nothing", () => {
    askedThread();
    const run = cronTurn("operator", true);
    ageContext(run.contextId, DELEGATED_REQUESTER_MAX_AGE_MS + 60_000);
    expect(accessFor(handToThread(run, "execute")).kind).toBe("refused");
  });

  it("a withdrawn cron run inherits nothing; a completed one still does", () => {
    askedThread();
    const withdrawn = cronTurn("operator", true);
    revokeRuntimeContext(withdrawn.contextId, { cascade: false, reason: "turn_context_aborted" });
    expect(accessFor(handToThread(withdrawn, "execute")).kind).toBe("refused");
    const completed = cronTurn("operator", true);
    revokeRuntimeContext(completed.contextId, { cascade: false, reason: "turn_context_completed" });
    expect(accessFor(handToThread(completed, "execute"))).toMatchObject({ kind: "operator" });
  });

  it("a cron principal on a context the host did not issue as a turn is ignored", () => {
    askedThread();
    const later = handToThread(cronTurn("operator", true, "cli-runtime"), "execute");
    expect(accessFor(later).kind).toBe("refused");
  });
});

describe("a delegated turn never makes the operator the owner of a cron it creates or edits", () => {
  function cronOwnerFor(turn: Turn) {
    return resolveCronOwnerPrincipalForCurrentTurn({
      env: {},
      runtimeContext: { present: true, record: turn },
      activeUserId: "operator-user",
      activeOrgId: "test-org",
      ownerName: "Operator",
    });
  }

  it("a thread turn that acts for the operator in Bases owns its cron as the relaying agent", () => {
    askedThread();
    const run = createRuntimeContext({
      kind: "turn-runtime",
      agentId: mainAgent.id,
      sessionKey: keyOf(mainAgent.id, PARENT_NAME),
      sessionName: PARENT_NAME,
      metadata: {
        actorPrincipal: "automation:cron:job-1",
        actorResolution: "resolved",
        cronRunAuthority: { jobId: "job-1", ownerPrincipal: "operator", ownerIsOperator: true },
      },
    }) as Turn;
    const later = handToThread(run, "execute");
    expect(accessFor(later)).toMatchObject({ kind: "operator" });
    const owner = cronOwnerFor(later);
    expect(owner).not.toBe("operator");
    expect(owner).toBe(`agent:${mainAgent.id}`);
  });

  it("a thread turn that acts for a contact owns its cron as the relaying agent", () => {
    const { contact, first } = askedThread();
    const later = handToThread(turnCausedBy(first, "inform"), "execute");
    expect(accessFor(later)).toMatchObject({ kind: "contact", contactId: contact.id });
    expect(cronOwnerFor(later)).toBe(`agent:${mainAgent.id}`);
  });

  it("a task dispatch turn that acts for its requester owns no operator cron", () => {
    const { contact, turn } = humanTurn();
    const { turn: taskTurn } = dispatchedTaskTurn(turn);
    expect(accessFor(taskTurn)).toMatchObject({ kind: "contact", contactId: contact.id });
    expect(cronOwnerFor(taskTurn)).not.toBe("operator");
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
    const { contact, first } = askedThread();
    const threadTurn = handToThread(turnCausedBy(first, "inform"), "execute");
    const { turn: taskTurn } = dispatchedTaskTurn(threadTurn);
    expect(accessFor(taskTurn)).toMatchObject({ kind: "contact", contactId: contact.id });
  });

  it("a task created with no verified request behind it stays refused", () => {
    const { turn: taskTurn } = dispatchedTaskTurn(null);
    expect(accessFor(taskTurn).kind).toBe("refused");
  });

  it("a task created from a turn no person started stays refused", () => {
    const { turn } = humanTurn();
    const { turn: taskTurn } = dispatchedTaskTurn(turnCausedBy(turn, "inform"));
    expect(accessFor(taskTurn).kind).toBe("refused");
  });

  it("a task whose requester is older than 72 hours stays refused", () => {
    const { turn } = humanTurn();
    const { turn: taskTurn } = dispatchedTaskTurn(turn);
    ageContext(turn.contextId, DELEGATED_REQUESTER_MAX_AGE_MS + 60_000);
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
    getContextById: (id) =>
      ({ contextId: id, agentId: "main", sessionKey: "agent:main:dm", createdAt: Date.now() }) as ContextRecord,
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
