import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getContext } from "../cli/context.js";
import {
  CLI_TRANSCRIPT_PERSIST_TIMEOUT_MS,
  readThisTurnAssistantText,
  sanitizeCliAssistantText,
  snapshotTranscriptCursor,
} from "../cli/session-cli-surface.js";
import {
  SESSION_SEND_TERMINAL_TYPES,
  createSessionSendWaitState,
  isSessionSendWaitTerminal,
  noteSessionSendWaitRuntimeEvent,
} from "../cli/session-send-wait.js";
import { getRecentHistory } from "../db.js";
import { nats } from "../nats.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { loadRouterConfig, expandHome } from "../router/index.js";
import { buildSessionRelayTurnOrigin } from "../runtime/turn-origin.js";
import { getOrCreateSession, resolveSession } from "../router/sessions.js";
import { NO_RUNTIME_SESSION_ID_REASON, runtimeProviderHasTranscript } from "../transcripts.js";
import type { SessionEntry } from "../router/types.js";
import { gradeEvalRun, type EvalExecutionResult, type EvalGrade } from "./grader.js";
import {
  buildEvalTranscriptRun,
  captureEvalSnapshot,
  diffEvalSnapshots,
  findEvalPromptIndex,
  readEvalSessionTranscript,
  type EvalSnapshot,
  type EvalSnapshotDiff,
  type EvalTranscriptRead,
  type EvalTranscriptRunScope,
} from "./snapshot.js";
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
  const sessionName = session.name ?? task.spec.session.name;
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(task.spec.id)}`;
  const outputRoot = outputDir ?? join(homedir(), ".ravi", "evals", task.spec.id, runId);

  mkdirSync(outputRoot, { recursive: true });

  const before = captureEvalSnapshot(task, session);
  writeFileSync(join(outputRoot, "before.json"), JSON.stringify(before, null, 2));

  // The before snapshot may skip the transcript (artifacts.transcript=false),
  // but finding this run's turn always needs the transcript length.
  const beforeTranscript = readEvalSessionTranscript(session);
  const runScope: EvalTranscriptRunScope = {
    prompt: task.spec.prompt,
    sinceMessageCount: beforeTranscript.exists ? beforeTranscript.messages.length : 0,
  };
  const currentSession = () => resolveSession(sessionName) ?? session;
  const readRunTranscript = (): EvalTranscriptRead => readEvalSessionTranscript(currentSession());
  const agentProvider = loadRouterConfig().agents[session.agentId]?.provider;
  const startedWithoutRuntimeSessionId =
    !beforeTranscript.exists && beforeTranscript.reason === NO_RUNTIME_SESSION_ID_REASON;

  const execution = await runPromptAndWait({
    sessionName,
    prompt: task.spec.prompt,
    timeoutMs: task.spec.runner.timeoutMs,
    historyCursor: snapshotTranscriptCursor(getRecentHistory(sessionName, 1)),
    isOwnTurn: () => {
      const read = readRunTranscript();
      return read.exists ? findEvalPromptIndex(read.messages, runScope.prompt, runScope.sinceMessageCount) >= 0 : null;
    },
    readOwnTurnText: () => {
      const read = readRunTranscript();
      if (!read.exists) {
        // A fresh session gets its runtime session ID only after the daemon has
        // already emitted turn.complete, so its transcript shows up a moment later
        // (first the ID, then the file the ID points at).
        const pending =
          (startedWithoutRuntimeSessionId || read.reason === NO_RUNTIME_SESSION_ID_REASON) &&
          runtimeProviderHasTranscript(currentSession().runtimeProvider ?? agentProvider);
        return { readable: false, pending };
      }
      const run = buildEvalTranscriptRun(read.messages, runScope);
      return {
        readable: true,
        text: run.promptIndex >= 0 && run.assistantText ? sanitizeCliAssistantText(run.assistantText) : null,
      };
    },
  });
  writeFileSync(join(outputRoot, "execution.json"), JSON.stringify(execution, null, 2));

  const refreshedSession = resolveSession(session.name ?? session.sessionKey) ?? session;
  const after = captureEvalSnapshot(task, refreshedSession, runScope);
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

/**
 * `pending`: no transcript yet, but one is expected (a fresh session whose
 * runtime session ID is not persisted yet), so keep waiting before history.
 */
export type OwnTurnText = { readable: false; pending?: boolean } | { readable: true; text: string | null };

export interface RunPromptAndWaitInput {
  sessionName: string;
  prompt: string;
  timeoutMs: number;
  /** Highest message id in the session history before the prompt was sent. */
  historyCursor: number;
  /**
   * Whether the session transcript shows this run's prompt was consumed;
   * null when there is no readable transcript to tell turns apart.
   */
  isOwnTurn: () => boolean | null;
  /**
   * Assistant text that followed this run's prompt in the transcript; `text`
   * is null while the transcript has none (yet).
   */
  readOwnTurnText: () => OwnTurnText;
}

/**
 * Send the eval prompt and wait for the turn that consumed it.
 *
 * The prompt goes out as a CLI-destination turn (like `ravi sessions send`
 * from a terminal): the reply stays with the eval instead of being emitted to
 * the session's chat, so the answer is read back from the transcript, not
 * from `.response` events. A terminal event only ends the wait once the
 * transcript shows this run's prompt; a turn that was already running when
 * the eval started (e.g. a previous run that timed out) ends first and is
 * ignored. Claude emits no `turn.started`, so the transcript is also what
 * tells a queued prompt's own terminal apart.
 */
async function runPromptAndWait(input: RunPromptAndWaitInput): Promise<EvalExecutionResult> {
  const { sessionName, prompt, timeoutMs } = input;
  const startedAt = Date.now();
  let settled = false;

  const runtimeStream = nats.subscribe(`ravi.session.${sessionName}.runtime`);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    runtimeStream.return(undefined);
  };

  const completion = new Promise<StreamTerminalState>((resolve) => {
    const settle = (state: StreamTerminalState) => {
      if (settled) return;
      settled = true;
      resolve(state);
    };

    timeoutId = setTimeout(() => {
      settle({ kind: "timeout" });
    }, timeoutMs);

    (async () => {
      try {
        let waitState = createSessionSendWaitState();
        for await (const event of runtimeStream) {
          const data = event.data as Record<string, unknown>;
          const type = data.type;
          waitState = noteSessionSendWaitRuntimeEvent(waitState, type);
          if (typeof type !== "string" || !SESSION_SEND_TERMINAL_TYPES.has(type)) continue;
          // The transcript is the reliable signal. Without one, fall back to the
          // event heuristics `ravi sessions send --wait` uses.
          const ownTurn = input.isOwnTurn() ?? isSessionSendWaitTerminal(waitState, type);
          if (!ownTurn) continue;
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
  });

  await publishSessionPrompt(sessionName, {
    prompt,
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "default",
    _cliDestination: true,
    _turnOrigin: buildSessionRelayTurnOrigin("send", getContext()),
  });
  const completionState = await completion;
  cleanup();

  const responseText = completionState.kind === "timeout" ? readTimedOutTurnText(input) : await readTurnResponse(input);
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

/**
 * The provider may flush the final assistant entry just after the terminal
 * event, so poll briefly. Ravi's stored history is only a fallback for
 * sessions without a readable transcript: its rows after the cursor can
 * include the reply of a turn that was already running when the eval started.
 * A transcript that is still expected is waited for until the deadline, so
 * the after snapshot can grade it; only then does history step in.
 */
export async function readTurnResponse(
  input: Pick<RunPromptAndWaitInput, "sessionName" | "historyCursor" | "readOwnTurnText">,
  persistTimeoutMs = CLI_TRANSCRIPT_PERSIST_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + persistTimeoutMs;
  for (;;) {
    const own = input.readOwnTurnText();
    if (own.readable && own.text !== null) return own.text;
    const expired = Date.now() >= deadline;
    const fromHistory =
      own.readable || (own.pending && !expired)
        ? null
        : readThisTurnAssistantText(getRecentHistory(input.sessionName, 50), input.historyCursor);
    if (fromHistory) return fromHistory.text;
    if (expired) return "";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Whatever the turn said before the timeout; no history fallback, the turn is still running. */
function readTimedOutTurnText(input: RunPromptAndWaitInput): string {
  const own = input.readOwnTurnText();
  return own.readable ? (own.text ?? "") : "";
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
