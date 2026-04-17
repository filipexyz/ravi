import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { nats } from "../nats.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { loadRouterConfig, expandHome } from "../router/index.js";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import type { SessionEntry } from "../router/types.js";
import { gradeEvalRun, type EvalExecutionResult, type EvalGrade } from "./grader.js";
import { captureEvalSnapshot, diffEvalSnapshots, type EvalSnapshot, type EvalSnapshotDiff } from "./snapshot.js";
import type { LoadedEvalTaskSpec } from "./spec.js";

export interface EvalRunResult {
  runId: string;
  outputDir: string;
  session: {
    sessionName: string;
    sessionKey: string;
    agentId: string;
  };
  execution: EvalExecutionResult;
  before: EvalSnapshot;
  after: EvalSnapshot;
  diff: EvalSnapshotDiff;
  grade: EvalGrade;
}

type StreamTerminalState =
  | { kind: "complete" }
  | { kind: "failed"; error: string }
  | { kind: "interrupted"; error: string }
  | { kind: "timeout" };

export async function runEvalTask(task: LoadedEvalTaskSpec, outputDir?: string): Promise<EvalRunResult> {
  const session = resolveOrCreateEvalSession(task);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(task.spec.id)}`;
  const outputRoot = outputDir ?? join(homedir(), ".ravi", "evals", task.spec.id, runId);

  mkdirSync(outputRoot, { recursive: true });

  const before = captureEvalSnapshot(task, session);
  writeFileSync(join(outputRoot, "before.json"), JSON.stringify(before, null, 2));

  const execution = await runPromptAndWait(
    session.name ?? task.spec.session.name,
    task.spec.prompt,
    task.spec.runner.timeoutMs,
  );
  writeFileSync(join(outputRoot, "execution.json"), JSON.stringify(execution, null, 2));

  const refreshedSession = resolveSession(session.name ?? session.sessionKey) ?? session;
  const after = captureEvalSnapshot(task, refreshedSession);
  const diff = diffEvalSnapshots(before, after);
  const grade = gradeEvalRun(task, execution, before, after, diff);

  writeFileSync(join(outputRoot, "after.json"), JSON.stringify(after, null, 2));
  writeFileSync(join(outputRoot, "diff.json"), JSON.stringify(diff, null, 2));
  writeFileSync(join(outputRoot, "grade.json"), JSON.stringify(grade, null, 2));
  writeFileSync(join(outputRoot, "task.json"), JSON.stringify(task.spec, null, 2));

  const result: EvalRunResult = {
    runId,
    outputDir: outputRoot,
    session: {
      sessionName: refreshedSession.name ?? task.spec.session.name,
      sessionKey: refreshedSession.sessionKey,
      agentId: refreshedSession.agentId,
    },
    execution,
    before,
    after,
    diff,
    grade,
  };

  writeFileSync(join(outputRoot, "run.json"), JSON.stringify(result, null, 2));
  return result;
}

function resolveOrCreateEvalSession(task: LoadedEvalTaskSpec): SessionEntry {
  const existing = resolveSession(task.spec.session.name);
  if (existing) {
    return existing;
  }

  const agentId = task.spec.session.agentId;
  if (!agentId) {
    throw new Error(
      `Session "${task.spec.session.name}" does not exist and task spec has no session.agentId to create it.`,
    );
  }

  const config = loadRouterConfig();
  const agent = config.agents[agentId];
  if (!agent) {
    throw new Error(`Agent not found for eval session creation: ${agentId}`);
  }

  getOrCreateSession(task.spec.session.name, agentId, expandHome(agent.cwd), {
    name: task.spec.session.name,
  });

  const created = resolveSession(task.spec.session.name);
  if (!created) {
    throw new Error(`Failed to create eval session: ${task.spec.session.name}`);
  }
  return created;
}

async function runPromptAndWait(sessionName: string, prompt: string, timeoutMs: number): Promise<EvalExecutionResult> {
  const startedAt = Date.now();
  let responseText = "";
  let settled = false;
  let settleCompletion: ((state: StreamTerminalState) => void) | undefined;

  const runtimeStream = nats.subscribe(`ravi.session.${sessionName}.runtime`);
  const claudeStream = nats.subscribe(`ravi.session.${sessionName}.claude`);
  const responseStream = nats.subscribe(`ravi.session.${sessionName}.response`);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    runtimeStream.return(undefined);
    claudeStream.return(undefined);
    responseStream.return(undefined);
  };

  const completion = new Promise<StreamTerminalState>((resolve) => {
    const settle = (state: StreamTerminalState) => {
      if (settled) return;
      settled = true;
      resolve(state);
    };
    settleCompletion = settle;

    timeoutId = setTimeout(() => {
      settle({ kind: "timeout" });
    }, timeoutMs);

    (async () => {
      try {
        for await (const event of runtimeStream) {
          const data = event.data as Record<string, unknown>;
          const type = data.type;
          if (type === "turn.complete") {
            settle({ kind: "complete" });
            break;
          }
          if (type === "turn.failed") {
            settle({ kind: "failed", error: extractRuntimeError(data) ?? "Session failed" });
            break;
          }
          if (type === "turn.interrupted") {
            settle({ kind: "interrupted", error: extractRuntimeError(data) ?? "Session was interrupted" });
            break;
          }
        }
      } catch {
        // Ignore subscription shutdown.
      }
    })();

    (async () => {
      try {
        for await (const event of claudeStream) {
          if ((event.data as Record<string, unknown>).type === "result") {
            settle({ kind: "complete" });
            break;
          }
        }
      } catch {
        // Ignore subscription shutdown.
      }
    })();
  });

  const collectResponse = (async () => {
    try {
      for await (const event of responseStream) {
        const data = event.data as Record<string, unknown>;
        if (typeof data.error === "string" && data.error.trim()) {
          settleCompletion?.({ kind: "failed", error: data.error });
          break;
        }
        if (typeof data.response === "string") {
          responseText += data.response;
        }
      }
    } catch {
      // Ignore subscription shutdown.
    }
  })();

  await publishSessionPrompt(sessionName, { prompt });
  const completionState = await completion;
  cleanup();
  await Promise.race([collectResponse, new Promise((resolve) => setTimeout(resolve, 100))]);

  const durationMs = Date.now() - startedAt;
  if (completionState.kind === "failed" || completionState.kind === "interrupted") {
    return {
      state: completionState.kind,
      responseText,
      error: completionState.error,
      durationMs,
    };
  }

  if (completionState.kind === "timeout") {
    return {
      state: "timeout",
      responseText,
      error: `Timed out waiting for response from ${sessionName} after ${Math.round(timeoutMs / 1000)}s`,
      durationMs,
    };
  }

  return {
    state: "complete",
    responseText,
    durationMs,
  };
}

function extractRuntimeError(data: Record<string, unknown>): string | undefined {
  const direct = data.error;
  if (typeof direct === "string" && direct.trim()) return direct;
  if (direct && typeof direct === "object" && typeof (direct as { message?: unknown }).message === "string") {
    return (direct as { message: string }).message;
  }
  return undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
