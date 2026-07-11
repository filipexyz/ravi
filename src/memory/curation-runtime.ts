/**
 * In-process memory nudge — a clean, Hermes-adapted cadence driver.
 *
 * NousResearch's Hermes agent keeps its self-nudge counter in the agent's own
 * turn loop as in-process instance state (never in contended cross-process
 * storage) and reviews/persists memory inline every N turns. Our previous
 * design instead counted cadence in a NATS Stop hook (separate process) that
 * shared the `runtime_session_json` DB column with the runtime's own per-turn
 * write. That is a lost-update: the runtime clobbered the counter every turn,
 * so it never accumulated and cadence never fired; it also depended on a
 * cross-process hop that did not fire reliably for omni turns.
 *
 * This is the Hermes-adapted replacement, built from scratch:
 *   - The counter lives ONLY in this module's in-process `Map` (per session).
 *     It never touches the DB, so nothing can clobber it and no other terminal
 *     path (silent/interrupted) can drop it.
 *   - It increments once per completed turn, driven from the runtime turn loop
 *     (host-event-loop turn.complete) — the single in-process point that runs
 *     for every session.
 *   - When a session reaches the nudge interval, it dispatches the existing
 *     `curador-memoria` task directly (in-process), which reads the delta and
 *     writes MEMORY.md through the deterministic guard — the proven half.
 *
 * The counter resets when the daemon restarts (process memory), exactly like
 * Hermes resetting on session boundaries; the nudge is a best-effort cadence,
 * not a durable ledger. The durable part — which messages were already curated
 * — stays in the DB watermark (`lastCuratedMessageId`), advanced when the
 * curador completes, and is only ever READ here.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { getMessagesAfterId, type Message } from "../db.js";
import { getSession } from "../router/sessions.js";
import { logger } from "../utils/logger.js";
import { readMemoryCurationState } from "./curation-state.js";

const log = logger.child("memory:nudge");

const CURATOR_PROFILE_ID = "curador-memoria";

/**
 * Turns between nudges. Overridable via `RAVI_MEMORY_NUDGE_INTERVAL` so the
 * cadence can be tuned (and validated fast) without a code change.
 */
function nudgeInterval(): number {
  const raw = process.env.RAVI_MEMORY_NUDGE_INTERVAL;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
}

/** In-process per-session turn counter. Reset on daemon restart (by design). */
const turnCounts = new Map<string, number>();

export interface MemoryNudgeInput {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  /** Agent cwd (may contain a leading `~`). Curator paths hang off this. */
  agentCwd: string | undefined;
}

/**
 * Count one completed turn for a session and, at the nudge interval, dispatch
 * the curador. Pure in-process bookkeeping — never writes the DB counter, never
 * touches the params column. Best-effort and fire-and-forget: nothing here may
 * block or break the turn (R2). Curator sessions (`*-curator`) never tick, so a
 * curador turn can never schedule another curador.
 */
export function noteTurnForMemoryNudge(input: MemoryNudgeInput): void {
  try {
    if (!input.agentId || !input.agentCwd || input.sessionName.endsWith("-curator")) {
      return;
    }
    const interval = nudgeInterval();
    const count = (turnCounts.get(input.sessionKey) ?? 0) + 1;
    turnCounts.set(input.sessionKey, count);
    log.info("memory nudge tick", {
      sessionName: input.sessionName,
      agentId: input.agentId,
      turnCount: count,
      interval,
    });
    if (count % interval === 0) {
      void dispatchCurador(input, count).catch((err) => {
        log.warn("memory nudge dispatch failed (best-effort)", {
          agentId: input.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    // Never let nudge bookkeeping surface into the turn loop.
    log.warn("memory nudge tick errored (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatchCurador(input: MemoryNudgeInput, cadenceTurn: number): Promise<void> {
  const agentCwd = (input.agentCwd ?? "").replace("~", homedir());

  // The durable watermark (which messages were already curated) lives in the DB
  // and is only READ here — the transcript is just the delta since it.
  const session = getSession(input.sessionKey);
  const sinceMessageId = session ? readMemoryCurationState(session, 10).lastCuratedMessageId : 0;
  const messages = getMessagesAfterId(input.sessionName, sinceMessageId);
  const highestMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : sinceMessageId;
  writeCuratorTranscript(agentCwd, messages, sinceMessageId);

  const { createTask, queueOrDispatchTask } = await import("../tasks/index.js");
  const created = createTask({
    title: `Curate memory for ${input.agentId} (nudge turn ${cadenceTurn})`,
    instructions: "In-process memory nudge dispatched by the runtime turn loop (Hermes-adapted).",
    profileId: CURATOR_PROFILE_ID,
    createdBy: "runtime:memory-nudge",
    createdByAgentId: input.agentId,
    createdBySessionName: input.sessionName,
    profileInput: {
      agent_id: input.agentId,
      transcript_path: `${agentCwd}/CURATOR_TRANSCRIPT.md`,
      since_message_id: String(sinceMessageId),
      highest_message_id: String(highestMessageId),
      memory_path: `${agentCwd}/MEMORY.md`,
      memory_dir: `${agentCwd}/memory`,
      cadence_turn: String(cadenceTurn),
      originator: "runtime-memory-nudge",
      originator_session: input.sessionName,
    },
  });
  await queueOrDispatchTask(created.task.id, {
    agentId: input.agentId,
    sessionName: `${created.task.id}-curator`,
    assignedBy: "runtime:memory-nudge",
    assignedByAgentId: input.agentId,
    assignedBySessionName: input.sessionName,
  });
  log.info("memory nudge DUE — curador dispatched in-process", {
    agentId: input.agentId,
    sessionName: input.sessionName,
    cadenceTurn,
    taskId: created.task.id,
    deltaMessages: messages.length,
  });
}

/** R27 — render the session's new `messages` rows (the delta) as the transcript. */
function writeCuratorTranscript(agentCwd: string, messages: Message[], sinceMessageId: number): void {
  const path = `${agentCwd}/CURATOR_TRANSCRIPT.md`;
  const header = `# Session transcript delta — messages.id > ${sinceMessageId}\n\n`;
  const body =
    messages.length === 0
      ? "_(no new messages since the last curation cycle)_\n"
      : messages.map((m) => `## msg#${m.id} — ${m.role} — ${m.created_at}\n\n${m.content}\n`).join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, header + body, "utf-8");
  } catch (err) {
    log.warn("Failed to write CURATOR_TRANSCRIPT.md (best-effort)", {
      agentCwd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
