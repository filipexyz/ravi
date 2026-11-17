import { createHash } from "node:crypto";

export type ChatId = string;
export type TaskId = string;
export type ThreadId = string;
export type DecisionId = string;
export type CommitmentKey = string;
export type OccurrenceKey = string;
export type TaskOutcomeKind = "completed" | "failed";

interface OccurrenceScopeV1 {
  schemaVersion: 1;
  chatId: ChatId;
}

export interface RequirementOccurrence extends OccurrenceScopeV1 {
  kind: "requirement";
  commitmentKey: CommitmentKey;
  taskId: TaskId;
  requirementKind: "dependency_complete" | "decision_answered";
  subjectId: string;
}

export interface TaskResultOccurrence extends OccurrenceScopeV1 {
  kind: "task_result";
  taskId: TaskId;
  outcomeKind: TaskOutcomeKind;
  outcomeVersion: number;
}

export interface ThreadDecisionOccurrence extends OccurrenceScopeV1 {
  kind: "thread_decision";
  threadId: ThreadId;
  decisionRef: DecisionId;
}

export type OccurrenceIdentityV1 = RequirementOccurrence | TaskResultOccurrence | ThreadDecisionOccurrence;

function requireFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError("Invalid occurrence identity fields");
  }
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Occurrence IDs must be nonempty strings");
  return value;
}

/** Reject unknown variants and foreign fields before hashing or writing storage. */
export function parseOccurrenceIdentity(input: unknown): OccurrenceIdentityV1 {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Occurrence identity must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.schemaVersion !== 1) throw new TypeError("Unsupported occurrence identity version");
  const chatId = requireId(value.chatId);
  if (value.kind === "thread_decision") {
    requireFields(value, ["schemaVersion", "kind", "chatId", "threadId", "decisionRef"]);
    return {
      schemaVersion: 1,
      kind: "thread_decision",
      chatId,
      threadId: requireId(value.threadId),
      decisionRef: requireId(value.decisionRef),
    };
  }
  if (value.kind === "requirement") {
    requireFields(value, [
      "schemaVersion",
      "kind",
      "chatId",
      "taskId",
      "commitmentKey",
      "requirementKind",
      "subjectId",
    ]);
    if (value.requirementKind !== "dependency_complete" && value.requirementKind !== "decision_answered") {
      throw new TypeError("Unsupported requirement kind");
    }
    return {
      schemaVersion: 1,
      kind: "requirement",
      chatId,
      taskId: requireId(value.taskId),
      commitmentKey: requireId(value.commitmentKey),
      requirementKind: value.requirementKind,
      subjectId: requireId(value.subjectId),
    };
  }
  if (value.kind === "task_result") {
    requireFields(value, ["schemaVersion", "kind", "chatId", "taskId", "outcomeKind", "outcomeVersion"]);
    if (value.outcomeKind !== "completed" && value.outcomeKind !== "failed") {
      throw new TypeError("Unsupported task outcome kind");
    }
    if (
      typeof value.outcomeVersion !== "number" ||
      !Number.isSafeInteger(value.outcomeVersion) ||
      value.outcomeVersion < 1
    ) {
      throw new TypeError("Outcome version must be a positive safe integer");
    }
    return {
      schemaVersion: 1,
      kind: "task_result",
      chatId,
      taskId: requireId(value.taskId),
      outcomeKind: value.outcomeKind,
      outcomeVersion: value.outcomeVersion,
    };
  }
  throw new TypeError("Unsupported occurrence kind");
}

function serializeIdentity(input: OccurrenceIdentityV1): string {
  const value = parseOccurrenceIdentity(input);
  switch (value.kind) {
    case "requirement":
      return JSON.stringify([
        "attention.occurrence.v1",
        value.kind,
        value.chatId,
        value.commitmentKey,
        value.taskId,
        value.requirementKind,
        value.subjectId,
      ]);
    case "task_result":
      return JSON.stringify([
        "attention.occurrence.v1",
        value.kind,
        value.chatId,
        value.taskId,
        value.outcomeKind,
        value.outcomeVersion,
      ]);
    case "thread_decision":
      return JSON.stringify(["attention.occurrence.v1", value.kind, value.chatId, value.threadId, value.decisionRef]);
  }
}

export function makeOccurrenceKey(identity: OccurrenceIdentityV1): OccurrenceKey {
  return createHash("sha256").update(serializeIdentity(identity), "utf8").digest("hex");
}

export function sameOccurrence(left: OccurrenceIdentityV1, right: OccurrenceIdentityV1): boolean {
  return serializeIdentity(left) === serializeIdentity(right);
}
