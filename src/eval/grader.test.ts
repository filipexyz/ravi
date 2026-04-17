import { describe, expect, it } from "bun:test";
import { gradeEvalRun } from "./grader.js";
import type { LoadedEvalTaskSpec } from "./spec.js";
import type { EvalSnapshot } from "./snapshot.js";

describe("gradeEvalRun", () => {
  const task: LoadedEvalTaskSpec = {
    path: "/tmp/eval/spec.json",
    baseDir: "/tmp/eval",
    spec: {
      version: 1,
      id: "smoke",
      prompt: "reply with EVAL_OK",
      session: {
        name: "eval-smoke",
        agentId: "dev",
      },
      artifacts: {
        files: [{ path: "artifact.txt" }],
        transcript: true,
      },
      rubric: [
        { id: "r1", type: "response.contains", needle: "EVAL_OK" },
        { id: "r2", type: "file.changed", path: "artifact.txt" },
        { id: "r3", type: "transcript.contains", needle: "EVAL_OK" },
      ],
      runner: {
        timeoutMs: 120000,
      },
    },
  };

  const before: EvalSnapshot = {
    takenAt: new Date().toISOString(),
    files: [
      {
        path: "/tmp/eval/artifact.txt",
        absolutePath: "/tmp/eval/artifact.txt",
        kind: "file",
        sha256: "before",
      },
    ],
    transcript: {
      enabled: true,
      exists: true,
      path: "/tmp/transcript.jsonl",
      messageCount: 1,
      combinedText: "hello",
      messages: [{ role: "user", text: "hello", time: "t1" }],
    },
  };

  const after: EvalSnapshot = {
    takenAt: new Date().toISOString(),
    files: [
      {
        path: "/tmp/eval/artifact.txt",
        absolutePath: "/tmp/eval/artifact.txt",
        kind: "file",
        sha256: "after",
        text: "artifact EVAL_OK",
      },
    ],
    transcript: {
      enabled: true,
      exists: true,
      path: "/tmp/transcript.jsonl",
      messageCount: 2,
      combinedText: "hello\nEVAL_OK",
      messages: [
        { role: "user", text: "hello", time: "t1" },
        { role: "assistant", text: "EVAL_OK", time: "t2" },
      ],
    },
  };

  it("passes all binary criteria when response, transcript and diff match", () => {
    const grade = gradeEvalRun(
      task,
      {
        state: "complete",
        responseText: "EVAL_OK",
        durationMs: 1000,
      },
      before,
      after,
      {
        files: [
          {
            path: "/tmp/eval/artifact.txt",
            absolutePath: "/tmp/eval/artifact.txt",
            beforeKind: "file",
            afterKind: "file",
            changed: true,
            reason: "content_changed",
          },
        ],
        transcriptChanged: true,
        transcriptMessageDelta: 1,
      },
    );

    expect(grade.pass).toBe(true);
    expect(grade.passed).toBe(3);
    expect(grade.total).toBe(3);
    expect(grade.score).toBe(1);
  });
});
