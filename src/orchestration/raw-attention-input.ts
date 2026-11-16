import type {
  ChatId,
  CommitmentKey,
  RequirementOccurrence,
  TaskId,
  TaskOutcomeKind,
  TaskResultOccurrence,
  ThreadDecisionOccurrence,
} from "./identity.js";

/** Structured agreement input; persistence and its producer belong to later PRs. */
export interface CommitmentV1 {
  schemaVersion: 1;
  key: CommitmentKey;
  revision: number;
  chatId: ChatId;
  taskId: TaskId;
  agreementRef: { kind: "chat_message" | "decision_answer"; id: string };
  recordedByContextRef: string;
  recordedAtMs: number;
  dueAtMs: number | null;
  outputKey: string;
  acceptance: { kind: "artifact_bytes" } | { kind: "unsupported"; code: string };
}

export interface EvidenceRefV1 {
  outputKey: string;
  artifactId: string;
  versionNumber: number;
  assetPath: string;
}

export interface RawDecision {
  id: string;
  origin: { type: "task" | "thread"; id: string };
  status: "open" | "answered" | "superseded";
  blocks: boolean;
  ownerType: "human" | "agent" | "unassigned";
  ownerId: string | null;
  revision: number;
  answeredAt: number | null;
}

export type RawRequirement =
  | {
      kind: "dependency_complete";
      taskId: string;
      dependsOnTaskId: string;
      satisfiedAt: number | null;
      satisfiedByEventId: number | null;
      satisfactionEvent: { id: number; taskId: string; type: string } | null;
    }
  | (RawDecision & { kind: "decision_answered" });

export interface RawArtifact {
  ref: EvidenceRefV1;
  versionId: string | null;
  taskLinks: readonly { targetType: string; targetId: string; relation: string }[];
  asset: { blobPath: string; declaredSha256: string } | null;
  bytes: Uint8Array | null;
}

export type RawTaskFacts = { id: string; status: string; completedAt: number | null };

/** Supplied data only. Canonical outcome-version production belongs to PR2. */
export interface TaskOutcomeRecordV1 {
  taskId: TaskId;
  kind: TaskOutcomeKind;
  version: number;
  sourceDigest: string;
}

/** Source inputs, not impact/evidence/materiality verdicts or an attention grant. */
export type RawAttentionInput = { nowMs: number } & (
  | {
      kind: "requirement";
      identity: RequirementOccurrence;
      task: RawTaskFacts;
      commitment: CommitmentV1 | null;
      requirement: RawRequirement;
      artifacts: readonly RawArtifact[];
    }
  | {
      kind: "task_result";
      identity: TaskResultOccurrence;
      task: RawTaskFacts;
      commitment: CommitmentV1 | null;
      outcome: TaskOutcomeRecordV1 | null;
      artifacts: readonly RawArtifact[];
    }
  | {
      kind: "thread_decision";
      identity: ThreadDecisionOccurrence;
      thread: { id: string };
      decision: RawDecision;
    }
);
