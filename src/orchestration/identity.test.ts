import { describe, expect, test } from "bun:test";
import {
  makeOccurrenceKey,
  parseOccurrenceIdentity,
  sameOccurrence,
  type RequirementOccurrence,
  type TaskResultOccurrence,
  type ThreadDecisionOccurrence,
} from "./identity.js";

const requirement: RequirementOccurrence = {
  schemaVersion: 1,
  kind: "requirement",
  chatId: "chat:storage-test",
  commitmentKey: "agreement:storage-test",
  taskId: "subject:shared",
  requirementKind: "dependency_complete",
  subjectId: "cause:shared",
};
const result: TaskResultOccurrence = {
  schemaVersion: 1,
  kind: "task_result",
  chatId: "chat:storage-test",
  taskId: "subject:shared",
  outcomeKind: "completed",
  outcomeVersion: 1,
};

const decision: ThreadDecisionOccurrence = {
  schemaVersion: 1,
  kind: "thread_decision",
  chatId: "chat:storage-test",
  threadId: "subject:shared",
  decisionRef: "cause:shared",
};

describe("occurrence identity", () => {
  test("canonical_keys_match_contract_vectors", () => {
    expect(makeOccurrenceKey(requirement)).toBe("57e78208d64d7eaa2a0a35924284567307e9ae15509e182cb8a5582df24f479f");
    expect(makeOccurrenceKey(result)).toBe("f58d6258c80785e08f706b8803eb87e28f38462e74fbf6506937793d273a382b");
    expect(makeOccurrenceKey(decision)).toBe("9eb3f6a543a26a80bb6d8e0bccda8e3ccd053c5a7d94100d890705b6185820d6");
    expect(sameOccurrence(decision, { ...decision })).toBe(true);
    expect(sameOccurrence(decision, result)).toBe(false);
    expect(sameOccurrence(decision, requirement)).toBe(false);
    expect(
      sameOccurrence(result, {
        outcomeVersion: result.outcomeVersion,
        outcomeKind: result.outcomeKind,
        taskId: result.taskId,
        chatId: result.chatId,
        kind: result.kind,
        schemaVersion: result.schemaVersion,
      }),
    ).toBe(true);
    expect(sameOccurrence(result, requirement)).toBe(false);
    expect(sameOccurrence(result, { ...result, outcomeVersion: 2 })).toBe(false);
    expect(sameOccurrence(requirement, { ...requirement, subjectId: "another-upstream" })).toBe(false);
  });

  test("identity_preserves_exact_ids_and_variant_scope", () => {
    expect(sameOccurrence(result, { ...result, taskId: "subject:shared " })).toBe(false);
    expect(sameOccurrence(result, { ...result, chatId: "another-chat" })).toBe(false);
    expect(sameOccurrence(requirement, { ...requirement, commitmentKey: "another-agreement" })).toBe(false);
    expect(sameOccurrence(requirement, { ...requirement, requirementKind: "decision_answered" })).toBe(false);
    expect(sameOccurrence(result, { ...result, outcomeKind: "failed" })).toBe(false);
    expect(sameOccurrence(decision, { ...decision, threadId: " subject:shared " })).toBe(false);
    expect(sameOccurrence(decision, { ...decision, threadId: "SUBJECT:SHARED" })).toBe(false);
    expect(sameOccurrence(decision, { ...decision, decisionRef: "another-decision" })).toBe(false);
  });

  test("parser_rejects_unknown_variants_and_foreign_fields", () => {
    const invalid = [
      { ...decision, kind: "unknown" },
      { ...decision, taskId: "fabricated-task" },
      { ...decision, taskId: null },
      { ...decision, taskId: undefined },
      { ...decision, requirementKind: "none" },
      { ...decision, outcomeKind: "completed" },
      { ...decision, threadId: "" },
      { ...decision, decisionRef: null },
      { ...result, kind: "thread_decision", threadId: "thread", decisionRef: "decision" },
      { ...result, requirementKind: "none" },
      { ...result, commitmentKey: undefined },
      { ...result, threadId: null },
      { ...requirement, outcomeKind: "completed" },
      { ...requirement, requirementKind: "none" },
      { ...result, schemaVersion: 2 },
      { ...result, taskId: "" },
      { ...result, chatId: null },
      { ...requirement, commitmentKey: "" },
      { ...requirement, subjectId: "" },
      { ...result, outcomeKind: "done" },
      null,
      [],
    ];
    for (const input of invalid) expect(() => parseOccurrenceIdentity(input)).toThrow(TypeError);
  });

  test("thread_decision_has_no_task_field", () => {
    const parsed = parseOccurrenceIdentity(decision);
    expect(parsed).toEqual(decision);
    expect(Object.hasOwn(parsed, "taskId")).toBe(false);
    if (parsed.kind === "thread_decision") {
      // @ts-expect-error A thread decision has no taskId, even as a nullable field.
      expect(parsed.taskId).toBeUndefined();
    }
  });

  test("parser_rejects_invalid_outcome_versions", () => {
    for (const outcomeVersion of [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(() => parseOccurrenceIdentity({ ...result, outcomeVersion })).toThrow(TypeError);
    }
    expect(parseOccurrenceIdentity({ ...result, outcomeVersion: Number.MAX_SAFE_INTEGER })).toEqual({
      ...result,
      outcomeVersion: Number.MAX_SAFE_INTEGER,
    });
  });
});
