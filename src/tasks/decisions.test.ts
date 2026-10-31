import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getDb } from "../router/router-db.js";
import {
  dbArchiveTask,
  dbAnswerTaskDecision,
  dbCreateTask,
  dbDecideTask,
  dbDeleteTask,
  dbDispatchTask,
  dbGetTask,
  dbListOpenTaskDecisions,
  dbListTaskDecisions,
  dbListTaskEvents,
} from "./task-db.js";
import { answerTaskDecision, decideTask, getTaskDetails, listTaskDecisionAttention } from "./service.js";
import { DecisionError, normalizeDecisionKey, parseDecisionOwner } from "../decisions/model.js";

const createdTaskIds: string[] = [];
let stateDir: string | null = null;

setDefaultTimeout(20_000);

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-task-decisions-test-");
});

afterEach(async () => {
  while (createdTaskIds.length > 0) {
    const id = createdTaskIds.pop();
    if (id) dbDeleteTask(id);
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function createTask(title = "Decision test task"): string {
  const created = dbCreateTask({
    title,
    instructions: "exercise the decision primitive",
    createdBy: "test",
    createdByAgentId: "dev",
    createdBySessionName: "decision-test-session",
  });
  createdTaskIds.push(created.task.id);
  return created.task.id;
}

function countDecisions(taskId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS total FROM decisions WHERE origin_type = 'task' AND origin_id = ?")
    .get(taskId) as {
    total: number;
  };
  return row.total;
}

describe("task decisions", () => {
  it("keeps at most one open decision per key and re-decides in place", () => {
    const taskId = createTask();

    const first = dbDecideTask(taskId, {
      key: "deploy-window",
      ask: "Which deploy window?",
      ownerType: "human",
      ownerId: "contact-1",
      blocks: true,
      actor: "dev-session",
    });
    expect(first.created).toBe(true);
    expect(first.decision.id.startsWith("dec_")).toBe(true);
    expect(first.decision.status).toBe("open");
    expect(first.decision.blocks).toBe(true);

    const second = dbDecideTask(taskId, {
      key: "deploy-window",
      ask: "Which deploy window (updated)?",
      ownerType: "agent",
      ownerId: "main",
      blocks: false,
      actor: "dev-session",
    });
    expect(second.created).toBe(false);
    expect(second.decision.id).toBe(first.decision.id);
    expect(second.decision.ask).toBe("Which deploy window (updated)?");
    expect(second.decision.ownerType).toBe("agent");
    expect(second.decision.ownerId).toBe("main");
    expect(second.decision.blocks).toBe(false);
    // Re-decide preserves the original ask provenance so attention age is honest.
    expect(second.decision.askedAt).toBe(first.decision.askedAt);
    expect(second.decision.askedBy).toBe("dev-session");

    expect(countDecisions(taskId)).toBe(1);
    expect(dbListTaskDecisions(taskId)).toHaveLength(1);
  });

  it("separates keys and emits an event per mutation", () => {
    const taskId = createTask();

    dbDecideTask(taskId, { key: "a", ask: "question a", actor: "dev-session" });
    dbDecideTask(taskId, { key: "b", ask: "question b", actor: "dev-session" });
    dbAnswerTaskDecision(taskId, { key: "a", answer: "a answered", actor: "human-1" });

    const types = dbListTaskEvents(taskId).map((event) => event.type);
    expect(types).toContain("task.decision.open");
    expect(types).toContain("task.decision.answered");

    const decisions = dbListTaskDecisions(taskId);
    expect(decisions.map((decision) => [decision.key, decision.status])).toEqual([
      ["b", "open"],
      ["a", "answered"],
    ]);
  });

  it("answers once and never rewrites answered history", () => {
    const taskId = createTask();
    dbDecideTask(taskId, { key: "k", ask: "question", ownerType: "human", ownerId: "contact-1", blocks: true });

    const answered = dbAnswerTaskDecision(taskId, { key: "k", answer: "ship it", actor: "human-1" });
    expect(answered.decision.status).toBe("answered");
    expect(answered.decision.answer).toBe("ship it");
    expect(answered.decision.answeredBy).toBe("human-1");
    expect(answered.decision.answeredAt).toBeGreaterThan(0);

    let error: unknown;
    try {
      dbAnswerTaskDecision(taskId, { key: "k", answer: "second answer", actor: "human-1" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).code).toBe("DECISION_NOT_OPEN");

    // A new ask after the answer opens a fresh decision record.
    const reopened = dbDecideTask(taskId, { key: "k", ask: "again?", ownerType: "human", ownerId: "contact-1" });
    expect(reopened.created).toBe(true);
    expect(reopened.decision.id).not.toBe(answered.decision.id);
    expect(countDecisions(taskId)).toBe(2);
  });

  it("fails typed when the key was never asked", () => {
    const taskId = createTask();
    let error: unknown;
    try {
      dbAnswerTaskDecision(taskId, { key: "missing", answer: "nope", actor: "human-1" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).code).toBe("DECISION_NOT_FOUND");
  });

  it("rejects the worker's own work session as the answerer", () => {
    const taskId = createTask();
    const sessionName = `${taskId}-work`;
    dbDispatchTask(taskId, { agentId: "dev", sessionName, assignedBy: "test" });
    decideTask(taskId, { key: "k", ask: "question", ownerType: "human", ownerId: "contact-1", blocks: true });

    let error: unknown;
    try {
      answerTaskDecision(taskId, {
        key: "k",
        answer: "self answer",
        actor: sessionName,
        agentId: "dev",
        sessionName,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DecisionError);
    expect((error as DecisionError).code).toBe("DECISION_SELF_ANSWER");
    // The decision stays open: nothing was written.
    expect(dbListTaskDecisions(taskId)[0]?.status).toBe("open");

    const answered = answerTaskDecision(taskId, {
      key: "k",
      answer: "decided elsewhere",
      actor: "human-1",
      agentId: "main",
      sessionName: "main-session",
    });
    expect(answered.decision.status).toBe("answered");
    expect(answered.decision.answeredBy).toBe("human-1");
  });

  it("derives parked, waitingFor, age and filters from open decisions only", () => {
    const parkedTask = createTask("Parked task");
    const agentTask = createTask("Agent task");
    dbDispatchTask(agentTask, { agentId: "dev", sessionName: `${agentTask}-work`, assignedBy: "test" });

    dbDecideTask(parkedTask, {
      key: "owner-approval",
      ask: "Can we ship?",
      ownerType: "human",
      ownerId: "contact-1",
      blocks: true,
    });
    // Age the parked ask deterministically so ordering does not depend on clock ticks.
    getDb()
      .prepare("UPDATE decisions SET asked_at = asked_at - 5000 WHERE origin_type = 'task' AND origin_id = ?")
      .run(parkedTask);
    dbDecideTask(parkedTask, { key: "naming", ask: "Name?", ownerType: "unassigned" });
    dbDecideTask(agentTask, { key: "spec", ask: "Which spec?", ownerType: "agent", ownerId: "main", blocks: true });

    const report = listTaskDecisionAttention();
    const parkedEntry = report.entries.find((entry) => entry.taskId === parkedTask);
    const agentEntry = report.entries.find((entry) => entry.taskId === agentTask);
    expect(parkedEntry?.parked).toBe(true);
    expect(parkedEntry?.waitingFor).toBe("human");
    expect(parkedEntry?.decisionCount).toBe(2);
    expect(agentEntry?.parked).toBe(false);
    expect(agentEntry?.waitingFor).toBe("agent");
    expect(report.parkedCount).toBe(1);
    expect(report.decisionCount).toBe(3);
    // Oldest ask first.
    expect(report.entries[0]?.taskId).toBe(parkedTask);

    const humanOnly = listTaskDecisionAttention({ ownerType: "human" });
    expect(humanOnly.entries.map((entry) => entry.taskId)).toEqual([parkedTask]);
    expect(humanOnly.decisionCount).toBe(1);

    const byAgentTask = listTaskDecisionAttention({ agentId: "dev" });
    expect(byAgentTask.entries.map((entry) => entry.taskId)).toEqual([agentTask]);

    const singleTask = listTaskDecisionAttention({ taskId: parkedTask });
    expect(singleTask.entries).toHaveLength(1);

    // Side-effect free: same rows before and after the folds.
    expect(dbListOpenTaskDecisions()).toHaveLength(3);
    const before = getDb().prepare("SELECT COUNT(*) AS total FROM decisions").get() as { total: number };
    listTaskDecisionAttention();
    getTaskDetails(parkedTask);
    const after = getDb().prepare("SELECT COUNT(*) AS total FROM decisions").get() as { total: number };
    expect(after.total).toBe(before.total);
    expect(dbGetTask(parkedTask)?.status).toBe("open");
  });

  it("excludes answered decisions from attention and archived tasks from the fold", () => {
    const taskId = createTask();
    dbDecideTask(taskId, { key: "k", ask: "question", ownerType: "human", ownerId: "contact-1", blocks: true });
    dbAnswerTaskDecision(taskId, { key: "k", answer: "done", actor: "human-1" });
    expect(listTaskDecisionAttention().entries).toHaveLength(0);

    dbDecideTask(taskId, { key: "k2", ask: "question 2", ownerType: "human", ownerId: "contact-1" });
    expect(listTaskDecisionAttention().entries).toHaveLength(1);

    dbArchiveTask(taskId, { actor: "human-1", reason: "not active anymore" });
    expect(listTaskDecisionAttention().entries).toHaveLength(0);
  });

  it("fold is deterministic for the same rows and clock", () => {
    const now = 1_700_000_000_000;
    const rows = [
      {
        decision: {
          id: "dec_b",
          taskId: "task-b",
          key: "k",
          status: "open" as const,
          ownerType: "human" as const,
          ownerId: "contact-1",
          ask: "b?",
          askedBy: "dev",
          askedAt: now - 1000,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          blocks: true,
          createdAt: now - 1000,
          updatedAt: now - 1000,
        },
        taskTitle: "B",
        taskStatus: "open" as const,
        taskPriority: "normal" as const,
        assigneeAgentId: null,
        assigneeSessionName: null,
      },
      {
        decision: {
          id: "dec_a",
          taskId: "task-a",
          key: "k",
          status: "open" as const,
          ownerType: "agent" as const,
          ownerId: "main",
          ask: "a?",
          askedBy: "dev",
          askedAt: now - 500,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          blocks: false,
          createdAt: now - 500,
          updatedAt: now - 500,
        },
        taskTitle: "A",
        taskStatus: "open" as const,
        taskPriority: "high" as const,
        assigneeAgentId: "dev",
        assigneeSessionName: "dev-session",
      },
    ];

    const first = foldTaskDecisionAttention(rows, { now });
    const second = foldTaskDecisionAttention([...rows].reverse(), { now });
    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.taskId)).toEqual(["task-b", "task-a"]);
    expect(first.entries[0]?.ageSeconds).toBe(1);
    expect(first.entries[1]?.ageSeconds).toBe(0);
  });

  it("validates decision keys and owners as usage errors", () => {
    expect(normalizeDecisionKey("Deploy-Window")).toBe("deploy-window");
    expect(() => normalizeDecisionKey("bad key!")).toThrow(DecisionError);
    expect(parseDecisionOwner("human:contact-1")).toEqual({ ownerType: "human", ownerId: "contact-1" });
    expect(parseDecisionOwner(undefined)).toEqual({ ownerType: "unassigned", ownerId: null });
    expect(() => parseDecisionOwner("human:")).toThrow(DecisionError);
    expect(() => parseDecisionOwner("robot:1")).toThrow(DecisionError);

    let error: unknown;
    try {
      normalizeDecisionKey("bad key!");
    } catch (caught) {
      error = caught;
    }
    expect((error as DecisionError).exitCode).toBe(2);
  });
});

import { foldTaskDecisionAttention } from "./decisions.js";
