/**
 * In-process skill nudge — the skill half of the Hermes-adapted learning loop.
 *
 * A DEDICATED counterpart to the memory nudge (curation-runtime.ts), kept as a
 * separate module because it is a separate concern (RM: "cria um agente dedicado
 * e isola as responsabilidades"): its own cadence env, its own transcript file,
 * its own durable watermark (skillCuration), and it dispatches its own
 * `curador-skills` profile — never bolted onto the memory curador.
 *
 * Same Hermes-adapted shape as memory (S1):
 *   - Cadence counter lives ONLY in this module's in-process Map (per session),
 *     never in the DB — nothing can clobber it (I1/I16). Resets on restart.
 *   - Increments once per completed turn, from the runtime turn loop.
 *   - At the interval it dispatches a `curador-skills` task that reads the delta
 *     (bounded by the DURABLE skill watermark, read-only here) and writes via
 *     `ravi skills guard` — never a raw SKILL.md edit.
 *   - Reentrancy guard (I15): curator sessions (`*-curator`) never tick.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { getMessagesAfterId, type Message } from "../db.js";
import { getAgent } from "../router/index.js";
import { getSession } from "../router/sessions.js";
import { logger } from "../utils/logger.js";
import { readSkillCurationState } from "./skill-curation-state.js";

const log = logger.child("skills:nudge");

const SKILL_CURATOR_PROFILE_ID = "curador-skills";

/** Turns between skill nudges. Overridable via `RAVI_SKILL_NUDGE_INTERVAL`. */
function nudgeInterval(): number {
  const raw = process.env.RAVI_SKILL_NUDGE_INTERVAL;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
}

/** In-process per-session turn counter. Reset on daemon restart (by design). */
const turnCounts = new Map<string, number>();

/**
 * Report/system sessions the cadence must never tick: curator sessions
 * (reentrancy) and curation-report reply-sessions (memory-log / skill-log),
 * which are outbound-only trigger targets, not conversations. Overridable via
 * `RAVI_NUDGE_SKIP_SESSIONS` (comma-separated) for future report groups.
 */
export function isNonConversationalSession(sessionName: string): boolean {
  if (sessionName.endsWith("-curator")) {
    return true;
  }
  const extra = (process.env.RAVI_NUDGE_SKIP_SESSIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(["memory-log", "skill-log", ...extra]).has(sessionName);
}

export interface SkillNudgeInput {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  /**
   * S3 — skills loaded this session (from `runtimeSession.skillVisibility
   * .loadedSkills`). Feeds the curador's write-order step (1) (patch a skill
   * that was in play). May be empty; when empty the curador skips step (1).
   */
  skillsInPlay?: string[];
}

/**
 * Count one completed turn and dispatch the skill curador at the interval. Pure
 * in-process bookkeeping — best-effort, fire-and-forget, never blocks/breaks the
 * turn. Curator sessions never tick (I15 reentrancy).
 */
export function noteTurnForSkillNudge(input: SkillNudgeInput): void {
  try {
    // Skip curator sessions (I15 reentrancy) and report/system sessions. The
    // latter (e.g. memory-log / skill-log, where curation-report triggers post)
    // are outbound-only and NOT real conversations — ticking them would, at the
    // interval, dispatch a curador FOR the report group, whose completion fires
    // the report trigger again → a self-sustaining feedback loop.
    if (!input.agentId || isNonConversationalSession(input.sessionName)) {
      return;
    }
    const interval = nudgeInterval();
    const count = (turnCounts.get(input.sessionKey) ?? 0) + 1;
    turnCounts.set(input.sessionKey, count);
    log.info("skill nudge tick", {
      sessionName: input.sessionName,
      agentId: input.agentId,
      turnCount: count,
      interval,
    });
    if (count % interval === 0) {
      void dispatchSkillCurador(input, count).catch((err) => {
        log.warn("skill nudge dispatch failed (best-effort)", {
          agentId: input.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    log.warn("skill nudge tick errored (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatchSkillCurador(input: SkillNudgeInput, cadenceTurn: number): Promise<void> {
  const rawCwd = getAgent(input.agentId)?.cwd;
  if (!rawCwd) {
    log.warn("skill nudge: agent has no cwd, cannot dispatch curador", { agentId: input.agentId });
    return;
  }
  const agentCwd = rawCwd.replace("~", homedir());

  // Durable skill watermark (which messages were already skill-curated) — READ
  // ONLY here. Separate from the memory watermark (I16).
  const session = getSession(input.sessionKey);
  const sinceMessageId = session ? readSkillCurationState(session).lastCuratedMessageId : 0;
  const messages = getMessagesAfterId(input.sessionName, sinceMessageId);
  // Skip dispatch on an empty delta: nothing new to curate, and dispatching
  // would (a) waste a curador run and (b) blank another concurrent session's
  // transcript (the file is per-session, but a no-op write is still churn).
  if (messages.length === 0) {
    log.info("skill nudge DUE but delta empty — skipping dispatch", {
      sessionName: input.sessionName,
      agentId: input.agentId,
      cadenceTurn,
    });
    return;
  }
  const highestMessageId = messages[messages.length - 1]!.id;
  // Session-scoped transcript path: an agent serves multiple concurrent
  // sessions, so keying the file by agent cwd alone lets session B overwrite
  // session A's delta before curador A runs (cross-session clobber). Scope it
  // by the (sanitized) session name so each session has its own file.
  const transcriptPath = sessionScopedTranscriptPath(agentCwd, input.sessionName, "SKILL_CURATOR_TRANSCRIPT");
  writeCuratorTranscript(transcriptPath, messages, sinceMessageId, "skills");

  const { createTask, queueOrDispatchTask } = await import("../tasks/index.js");
  const created = createTask({
    title: `Curate skills for ${input.agentId} (nudge turn ${cadenceTurn})`,
    instructions: "In-process skill nudge dispatched by the runtime turn loop (Hermes-adapted).",
    profileId: SKILL_CURATOR_PROFILE_ID,
    createdBy: "runtime:skill-nudge",
    createdByAgentId: input.agentId,
    createdBySessionName: input.sessionName,
    profileInput: {
      agent_id: input.agentId,
      transcript_path: transcriptPath,
      since_message_id: String(sinceMessageId),
      highest_message_id: String(highestMessageId),
      cadence_turn: String(cadenceTurn),
      skills_in_play: JSON.stringify(input.skillsInPlay ?? []),
      originator: "runtime-skill-nudge",
      // Display name for provenance/reporting; real session key for the
      // watermark commit (getSession keys by sessionKey, not the name — M2).
      originator_session: input.sessionName,
      originator_session_key: input.sessionKey,
    },
  });
  await queueOrDispatchTask(created.task.id, {
    agentId: input.agentId,
    sessionName: `${created.task.id}-curator`,
    assignedBy: "runtime:skill-nudge",
    assignedByAgentId: input.agentId,
    assignedBySessionName: input.sessionName,
  });
  log.info("skill nudge DUE — curador dispatched in-process", {
    agentId: input.agentId,
    sessionName: input.sessionName,
    cadenceTurn,
    taskId: created.task.id,
    deltaMessages: messages.length,
  });
}

/**
 * Session-scoped transcript path so concurrent sessions of the same agent never
 * clobber each other's delta. Sanitizes the session name to a safe single path
 * segment and nests under `.curator-transcripts/`.
 */
export function sessionScopedTranscriptPath(agentCwd: string, sessionName: string, base: string): string {
  const safe = sessionName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "session";
  return `${agentCwd}/.curator-transcripts/${base}-${safe}.md`;
}

/** Render the session's new `messages` rows (the delta) as the curator transcript. */
export function writeCuratorTranscript(
  path: string,
  messages: Message[],
  sinceMessageId: number,
  kind: "skills" | "memory",
): void {
  const header = `# Session transcript delta (${kind}) — messages.id > ${sinceMessageId}\n\n`;
  const body =
    messages.length === 0
      ? `_(no new messages since the last ${kind}-curation cycle)_\n`
      : messages.map((m) => `## msg#${m.id} — ${m.role} — ${m.created_at}\n\n${m.content}\n`).join("\n");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, header + body, "utf-8");
  } catch (err) {
    log.warn("Failed to write curator transcript (best-effort)", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
