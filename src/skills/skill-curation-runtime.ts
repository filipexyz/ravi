import { homedir } from "node:os";
import { getMessagesAfterId } from "../db.js";
import { getAgent } from "../router/index.js";
import { getSession } from "../router/sessions.js";
import { sessionScopedCuratorTranscriptPath, writeCuratorTranscript } from "../runtime/curator-transcript.js";
import { isLearningLoopSessionExcluded } from "../runtime/learning-loop-sessions.js";
import { logger } from "../utils/logger.js";
import { readSkillCurationState } from "./skill-curation-state.js";

const log = logger.child("skills:nudge");
const SKILL_CURATOR_PROFILE_ID = "curador-skills";

export const isNonConversationalSession = isLearningLoopSessionExcluded;
export const sessionScopedTranscriptPath = sessionScopedCuratorTranscriptPath;

export interface SkillNudgeInput {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  skillsInPlay?: string[];
}

export async function dispatchSkillCuratorForCadence(input: SkillNudgeInput, cadenceTurn: number): Promise<void> {
  const rawCwd = getAgent(input.agentId)?.cwd;
  if (!rawCwd) {
    log.warn("skill nudge: agent has no cwd, cannot dispatch curator", { agentId: input.agentId });
    return;
  }
  const agentCwd = rawCwd.replace("~", homedir());
  const session = getSession(input.sessionKey);
  const sinceMessageId = session ? readSkillCurationState(session).lastCuratedMessageId : 0;
  const messages = getMessagesAfterId(input.sessionName, sinceMessageId);
  if (messages.length === 0) {
    log.info("skill nudge due but delta empty — skipping dispatch", {
      sessionName: input.sessionName,
      agentId: input.agentId,
      cadenceTurn,
    });
    return;
  }

  const { createTask, listTasks, queueOrDispatchTask } = await import("../tasks/index.js");
  const duplicate = ["dispatched", "in_progress", "blocked"].some((status) =>
    listTasks({ status: status as "dispatched" | "in_progress" | "blocked" }).some(
      (task) =>
        task.profileId === SKILL_CURATOR_PROFILE_ID &&
        (task.profileInput?.originator_session_key ?? task.profileInput?.originator_session) === input.sessionKey,
    ),
  );
  if (duplicate) {
    log.info("skill nudge due but curator already active — skipping dispatch", {
      sessionName: input.sessionName,
      agentId: input.agentId,
      cadenceTurn,
    });
    return;
  }

  const highestMessageId = messages[messages.length - 1]!.id;
  const transcriptPath = sessionScopedCuratorTranscriptPath(agentCwd, input.sessionName, "SKILL_CURATOR_TRANSCRIPT");
  writeCuratorTranscript(transcriptPath, messages, sinceMessageId, "skills");
  const created = createTask({
    title: `Curate skills for ${input.agentId} (nudge turn ${cadenceTurn})`,
    instructions: "Durable skill nudge dispatched by the runtime terminal-turn loop.",
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
  log.info("skill nudge due — curator dispatched", {
    agentId: input.agentId,
    sessionName: input.sessionName,
    cadenceTurn,
    taskId: created.task.id,
    deltaMessages: messages.length,
  });
}
