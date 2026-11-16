import { describe, expect, test } from "bun:test";
import type { RawAttentionInput, RawTaskFacts } from "./raw-attention-input.js";

type ThreadInput = Extract<RawAttentionInput, { kind: "thread_decision" }>;
type TaskResultInput = Extract<RawAttentionInput, { kind: "task_result" }>;
type RequirementInput = Extract<RawAttentionInput, { kind: "requirement" }>;

const threadInput: ThreadInput = {
  nowMs: 100,
  kind: "thread_decision",
  identity: {
    schemaVersion: 1,
    kind: "thread_decision",
    chatId: "chat:attention",
    threadId: "LegacyThread:Opaque-ID",
    decisionRef: "decision:independent",
  },
  thread: { id: "LegacyThread:Opaque-ID" },
  decision: {
    id: "decision:independent",
    origin: { type: "thread", id: "LegacyThread:Opaque-ID" },
    status: "open",
    blocks: true,
    ownerType: "human",
    ownerId: "contact:owner",
    revision: 1,
    answeredAt: null,
  },
};
const taskFacts: RawTaskFacts = { id: "task:independent", status: "done", completedAt: 100 };
const taskResultInput: TaskResultInput = {
  nowMs: 100,
  kind: "task_result",
  identity: {
    schemaVersion: 1,
    kind: "task_result",
    chatId: "chat:attention",
    taskId: taskFacts.id,
    outcomeKind: "completed",
    outcomeVersion: 1,
  },
  task: taskFacts,
  commitment: null,
  outcome: null,
  artifacts: [],
};
const requirementInput: RequirementInput = {
  nowMs: 100,
  kind: "requirement",
  identity: {
    schemaVersion: 1,
    kind: "requirement",
    chatId: "chat:attention",
    taskId: "task:blocked",
    commitmentKey: "agreement:delivery",
    requirementKind: "dependency_complete",
    subjectId: "task:upstream",
  },
  task: { id: "task:blocked", status: "blocked", completedAt: null },
  commitment: null,
  requirement: {
    kind: "dependency_complete",
    taskId: "task:blocked",
    dependsOnTaskId: "task:upstream",
    satisfiedAt: null,
    satisfiedByEventId: null,
    satisfactionEvent: null,
  },
  artifacts: [],
};

// Compiled by the targeted and CI typechecks; invalid shapes are never consumed.
function assertRejectedInputs(): void {
  // @ts-expect-error A thread decision has no task input.
  const threadWithTask: ThreadInput = { ...threadInput, task: taskFacts };
  // @ts-expect-error A task result has no requirement input.
  const resultWithRequirement: TaskResultInput = { ...taskResultInput, requirement: requirementInput.requirement };
  // @ts-expect-error The outer discriminant must agree with the identity variant.
  const mismatchedIdentity: RawAttentionInput = { ...taskResultInput, identity: threadInput.identity };
  // @ts-expect-error Evidence is classified later, not supplied in the raw input.
  const readyVerdict: TaskResultInput = { ...taskResultInput, evidenceStatus: "artifact_bytes_verified" };
  void [threadWithTask, resultWithRequirement, mismatchedIdentity, readyVerdict];
}
void assertRejectedInputs;

describe("raw attention input contract", () => {
  test("thread_decision_input_requires_no_task", () => {
    const hasNoTask: "task" extends keyof ThreadInput ? false : true = true;
    expect(hasNoTask).toBe(true);
    expect(threadInput).not.toHaveProperty("task");
    expect(threadInput.identity).not.toHaveProperty("taskId");
    expect(threadInput.thread.id).toBe("LegacyThread:Opaque-ID");
    expect(threadInput.decision.origin.id).toBe(threadInput.identity.threadId);
  });

  test("task_result_input_requires_no_requirement_or_version_producer", () => {
    const hasNoRequirement: "requirement" extends keyof TaskResultInput ? false : true = true;
    expect(hasNoRequirement).toBe(true);
    expect(taskResultInput).not.toHaveProperty("requirement");
    expect(taskResultInput.identity.outcomeVersion).toBe(1);
    expect(taskResultInput.outcome).toBeNull();
    expect(taskResultInput.artifacts).toEqual([]);
  });

  test("requirement_input_retains_raw_dependency_without_classification", () => {
    expect(requirementInput.requirement.kind).toBe("dependency_complete");
    expect(requirementInput.requirement).toHaveProperty("satisfactionEvent", null);
    for (const input of [threadInput, taskResultInput, requirementInput]) {
      expect(input).not.toHaveProperty("impact");
      expect(input).not.toHaveProperty("evidenceStatus");
      expect(input).not.toHaveProperty("newMaterial");
    }
  });
});
