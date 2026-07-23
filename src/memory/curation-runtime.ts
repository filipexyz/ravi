import { homedir } from "node:os";
import { getMessagesAfterId } from "../db.js";
import { sessionScopedCuratorTranscriptPath, writeCuratorTranscript } from "../runtime/curator-transcript.js";
import { getSession } from "../router/sessions.js";
import { logger } from "../utils/logger.js";
import { readMemoryCurationState } from "./curation-state.js";

const log = logger.child("memory:nudge");
const CURATOR_PROFILE_ID = "curador-memoria";

export interface MemoryNudgeInput {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  agentCwd?: string;
}

export async function dispatchMemoryCuratorForCadence(input: MemoryNudgeInput, cadenceTurn: number): Promise<void> {
  if (!input.agentCwd) {
    log.warn("memory nudge: agent has no cwd, cannot dispatch curator", { agentId: input.agentId });
    return;
  }
  const agentCwd = input.agentCwd.replace("~", homedir());
  const session = getSession(input.sessionKey);
  const sinceMessageId = session ? readMemoryCurationState(session, 10).lastCuratedMessageId : 0;
  const messages = getMessagesAfterId(input.sessionName, sinceMessageId);
  if (messages.length === 0) {
    log.info("memory nudge due but delta empty — skipping dispatch", {
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
        task.profileId === CURATOR_PROFILE_ID &&
        (task.profileInput?.originator_session_key ?? task.profileInput?.originator_session) === input.sessionKey,
    ),
  );
  if (duplicate) {
    log.info("memory nudge due but curator already active — skipping dispatch", {
      sessionName: input.sessionName,
      agentId: input.agentId,
      cadenceTurn,
    });
    return;
  }

  const highestMessageId = messages[messages.length - 1]!.id;
  const transcriptPath = sessionScopedCuratorTranscriptPath(agentCwd, input.sessionName, "MEMORY_CURATOR_TRANSCRIPT");
  writeCuratorTranscript(transcriptPath, messages, sinceMessageId, "memory");
  const created = createTask({
    title: `Curate memory for ${input.agentId} (nudge turn ${cadenceTurn})`,
    instructions: "Durable memory nudge dispatched by the runtime terminal-turn loop.",
    profileId: CURATOR_PROFILE_ID,
    createdBy: "runtime:memory-nudge",
    createdByAgentId: input.agentId,
    createdBySessionName: input.sessionName,
    reportToSessionName: "",
    profileInput: {
      agent_id: input.agentId,
      transcript_path: transcriptPath,
      since_message_id: String(sinceMessageId),
      highest_message_id: String(highestMessageId),
      memory_path: `${agentCwd}/MEMORY.md`,
      memory_dir: `${agentCwd}/memory`,
      cadence_turn: String(cadenceTurn),
      originator: "runtime-memory-nudge",
      originator_session: input.sessionName,
      originator_session_key: input.sessionKey,
    },
  });
  await queueOrDispatchTask(created.task.id, {
    agentId: input.agentId,
    sessionName: `${created.task.id}-curator`,
    assignedBy: "runtime:memory-nudge",
    assignedByAgentId: input.agentId,
    assignedBySessionName: input.sessionName,
    reportToSessionName: "",
  });
  log.info("memory nudge due — curator dispatched", {
    agentId: input.agentId,
    sessionName: input.sessionName,
    cadenceTurn,
    taskId: created.task.id,
    deltaMessages: messages.length,
  });
}
