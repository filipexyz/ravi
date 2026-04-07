import type { LoadedEvalTaskSpec } from "./spec.js";
import { resolveEvalSpecPath } from "./spec.js";
import type { EvalSnapshot, EvalSnapshotDiff } from "./snapshot.js";

export interface EvalExecutionResult {
  state: "complete" | "failed" | "interrupted" | "timeout";
  responseText: string;
  error?: string;
  durationMs: number;
}

export interface EvalCriterionResult {
  id: string;
  type: string;
  pass: boolean;
  details: string;
}

export interface EvalGrade {
  pass: boolean;
  passed: number;
  total: number;
  score: number;
  criteria: EvalCriterionResult[];
}

export function gradeEvalRun(
  task: LoadedEvalTaskSpec,
  execution: EvalExecutionResult,
  _before: EvalSnapshot,
  after: EvalSnapshot,
  diff: EvalSnapshotDiff,
): EvalGrade {
  const criteria: EvalCriterionResult[] = task.spec.rubric.map((criterion) => {
    switch (criterion.type) {
      case "response.contains": {
        const pass = execution.responseText.includes(criterion.needle);
        return {
          id: criterion.id,
          type: criterion.type,
          pass,
          details: pass
            ? `Response contains "${criterion.needle}".`
            : `Response does not contain "${criterion.needle}".`,
        };
      }

      case "transcript.contains": {
        const haystack = after.transcript?.combinedText ?? "";
        const pass = haystack.includes(criterion.needle);
        return {
          id: criterion.id,
          type: criterion.type,
          pass,
          details: pass
            ? `Transcript contains "${criterion.needle}".`
            : `Transcript does not contain "${criterion.needle}".`,
        };
      }

      case "file.exists": {
        const absolutePath = resolveEvalSpecPath(task, criterion.path);
        const artifact = after.files.find((file) => file.absolutePath === absolutePath);
        const pass = artifact ? artifact.kind !== "missing" : false;
        return {
          id: criterion.id,
          type: criterion.type,
          pass,
          details: pass ? `Artifact exists at ${absolutePath}.` : `Artifact missing at ${absolutePath}.`,
        };
      }

      case "file.contains": {
        const absolutePath = resolveEvalSpecPath(task, criterion.path);
        const artifact = after.files.find((file) => file.absolutePath === absolutePath);
        const text = artifact?.text ?? "";
        const pass = text.includes(criterion.needle);
        return {
          id: criterion.id,
          type: criterion.type,
          pass,
          details: pass
            ? `File ${absolutePath} contains "${criterion.needle}".`
            : `File ${absolutePath} does not contain "${criterion.needle}".`,
        };
      }

      case "file.changed": {
        const absolutePath = resolveEvalSpecPath(task, criterion.path);
        const fileDiff = diff.files.find((file) => file.absolutePath === absolutePath);
        const pass = fileDiff?.changed ?? false;
        return {
          id: criterion.id,
          type: criterion.type,
          pass,
          details: pass
            ? `File ${absolutePath} changed (${fileDiff?.reason ?? "changed"}).`
            : `File ${absolutePath} did not change.`,
        };
      }

      default: {
        return {
          id: criterion.id,
          type: criterion.type,
          pass: false,
          details: `Unsupported criterion type: ${criterion.type}`,
        };
      }
    }
  });

  const passed = criteria.filter((criterion) => criterion.pass).length;
  const total = criteria.length;
  return {
    pass: passed === total,
    passed,
    total,
    score: total === 0 ? 0 : passed / total,
    criteria,
  };
}
