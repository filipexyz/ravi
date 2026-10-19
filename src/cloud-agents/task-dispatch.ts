/**
 * `ravi tasks dispatch <task> --agent <id> --cloud` (spec `cloud/agents`,
 * "Task dispatch"): the task runs as a cloud run of the local agent's Library
 * definition instead of a local session. The result comes back through the
 * daemon's cloud task watcher (task-watcher.ts).
 *
 * Everything that only reads (the task, the local agent, its Library item, the
 * Console project) happens in `prepare`, before the write brake; `execute`
 * starts the run (it spends the org's money), records it here and marks the
 * task in progress.
 */

import { randomUUID } from "node:crypto";

import { dbGetLibraryAgentState } from "../library/agents-db.js";
import { isLibraryNotFoundError, openLibrarySession } from "../library/client.js";
import { parseLibraryRef } from "../library/refs.js";
import { LibraryCommandError } from "../library/service.js";
import type { TaskRecord } from "../tasks/types.js";
import {
  cloudAgentsLoginRequiredError,
  openCloudAgentsSession,
  type CloudAgentsSession,
  type CloudAgentsSessionOptions,
} from "./client.js";
import { dbGetActiveCloudTaskRunForTask, dbRecordCloudTaskRun } from "./task-runs-db.js";
import type { CloudRun, CloudRunStartBody } from "./types.js";

export const CLOUD_AGENT_NOT_PUBLISHED = "CLOUD_AGENT_NOT_PUBLISHED";
export const CLOUD_TASK_RUN_ACTIVE = "CLOUD_TASK_RUN_ACTIVE";
export const CLOUD_TASK_FINISHED = "CLOUD_TASK_FINISHED";
export const CLOUD_TASK_SESSION_REQUIRED = "CLOUD_TASK_SESSION_REQUIRED";
const PROMPT_MAX_CHARS = 50_000;

/** Where the local agent's definition lives in the Library. */
export interface CloudAgentLibraryRef {
  ref: string;
  slug: string;
  /** The project of a project item; null for an org item. */
  project: string | null;
  source: "installed" | "library";
}

export interface CloudTaskDispatchDeps {
  openSession?: (options: CloudAgentsSessionOptions) => Promise<CloudAgentsSession | null>;
  /** Finds the agent in the Library when it was not installed from there (tests replace it). */
  findLibraryAgent?: (input: { agentId: string; project: string | null }) => Promise<CloudAgentLibraryRef | null>;
  newIdempotencyKey?: () => string;
}

export interface CloudTaskDispatchPlan {
  taskId: string;
  agentId: string;
  library: { ref: string; source: "installed" | "library" };
  project: string;
  budgetUsd: number | null;
  repositories: string[];
  /** The session that gets the result and approval requests. */
  informSession: string;
  promptChars: number;
  effect: string;
}

export interface PreparedCloudTaskDispatch {
  plan: CloudTaskDispatchPlan;
  body: CloudRunStartBody;
  session: CloudAgentsSession;
}

/** The prompt a cloud run gets for a task: the task itself and what its last message is for. */
export function buildCloudTaskPrompt(task: Pick<TaskRecord, "id" | "title" | "instructions">): string {
  const prompt = [
    `Task ${task.id}: ${task.title}`,
    "",
    task.instructions.trim(),
    "",
    "You run this task in a Ravi cloud run for the person who dispatched it. Your last message is the task's result: say what you did and what you found. Write files they should keep to /mnt/session/outputs.",
  ].join("\n");
  return prompt.length > PROMPT_MAX_CHARS ? `${prompt.slice(0, PROMPT_MAX_CHARS - 1)}…` : prompt;
}

export async function prepareCloudTaskDispatch(
  input: {
    task: TaskRecord;
    agentId: string;
    project?: string | null;
    budgetUsd?: number;
    repositories?: Array<{ repo: string; branch?: string }>;
    informSession: string | null;
  },
  deps: CloudTaskDispatchDeps = {},
): Promise<PreparedCloudTaskDispatch> {
  const { task, agentId } = input;
  if (task.status === "done" || task.status === "failed") {
    throw new LibraryCommandError(CLOUD_TASK_FINISHED, `Task ${task.id} is already ${task.status}.`, 1, {
      suggestedAction: `Create a new task, or read this one with: ravi tasks show ${task.id}`,
    });
  }
  // The Console records a task run only with the session its result goes to.
  const informSession = input.informSession?.trim() || null;
  if (!informSession) {
    throw new LibraryCommandError(
      CLOUD_TASK_SESSION_REQUIRED,
      "A cloud task run needs the session that gets its result and approval requests.",
      2,
      {
        suggestedAction: `Pass --report-to <session>: ravi tasks dispatch ${task.id} --agent ${agentId} --cloud --report-to <session> --execute`,
      },
    );
  }
  const active = dbGetActiveCloudTaskRunForTask(task.id);
  if (active) {
    throw new LibraryCommandError(
      CLOUD_TASK_RUN_ACTIVE,
      `Task ${task.id} already runs in the cloud (run ${active.runId}).`,
      1,
      { suggestedAction: `Follow it with: ravi cloud runs follow ${active.runId}`, runId: active.runId },
    );
  }

  const open = deps.openSession ?? ((options: CloudAgentsSessionOptions) => openCloudAgentsSession(options));
  const explicitProject = input.project?.trim() || null;
  const session = await open({ project: explicitProject });
  if (!session) throw cloudAgentsLoginRequiredError();

  const library = await resolveCloudAgentLibraryRef(agentId, explicitProject ?? session.project, deps);
  const project = explicitProject ?? library.project ?? session.project;
  if (!project) {
    throw new LibraryCommandError("CLOUD_PROJECT_REQUIRED", "No Console project resolved for this dispatch.", 2, {
      suggestedAction: "Pass --project <project-slug> (list them with: ravi projects list)",
    });
  }

  const prompt = buildCloudTaskPrompt(task);
  const body: CloudRunStartBody = {
    project,
    agent: library.slug,
    prompt,
    trigger: "task",
    // The Console takes the installation from the login session, not from the body.
    origin: { kind: "task", sessionName: informSession, taskId: task.id },
    idempotencyKey: (deps.newIdempotencyKey ?? (() => `ravi-task:${task.id}:${randomUUID()}`))(),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    ...(input.repositories ? { repositories: input.repositories } : {}),
  };
  return {
    session,
    body,
    plan: {
      taskId: task.id,
      agentId,
      library: { ref: library.ref, source: library.source },
      project,
      budgetUsd: input.budgetUsd ?? null,
      repositories: (input.repositories ?? []).map((entry) => entry.repo),
      informSession,
      promptChars: prompt.length,
      effect: `start a paid cloud run of ${library.ref} with the organization's Anthropic key (budget ${
        input.budgetUsd !== undefined ? `US$ ${input.budgetUsd}` : "the agent's default"
      })`,
    },
  };
}

export async function executeCloudTaskDispatch(prepared: PreparedCloudTaskDispatch): Promise<CloudRun> {
  const run = await prepared.session.client.startRun(prepared.body);
  dbRecordCloudTaskRun({
    runId: run.id,
    taskId: prepared.plan.taskId,
    agentId: prepared.plan.agentId,
    sessionName: prepared.plan.informSession,
    project: prepared.plan.project,
    status: run.status,
  });
  return run;
}

/**
 * The Library item of a local agent: the one it was installed from, else an
 * agent definition with the agent's id as slug in the caller's view (org
 * items plus the project's). Refuses when there is none.
 */
export async function resolveCloudAgentLibraryRef(
  agentId: string,
  project: string | null,
  deps: CloudTaskDispatchDeps = {},
): Promise<CloudAgentLibraryRef> {
  const origin = dbGetLibraryAgentState(agentId)?.origin;
  const installed = origin ? parseLibraryRef(origin.ref) : null;
  if (installed) {
    return { ref: installed.ref, slug: installed.slug, project: installed.project ?? null, source: "installed" };
  }
  const found = await (deps.findLibraryAgent ?? findLibraryAgentBySlug)({ agentId, project });
  if (found) return found;
  throw new LibraryCommandError(
    CLOUD_AGENT_NOT_PUBLISHED,
    `Agent '${agentId}' is not a Library agent definition, so it cannot run in the cloud.`,
    1,
    { suggestedAction: `Publish it first: ravi agents publish ${agentId} --scope <org|project-slug> --execute` },
  );
}

async function findLibraryAgentBySlug(input: {
  agentId: string;
  project: string | null;
}): Promise<CloudAgentLibraryRef | null> {
  const slug = input.agentId.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) return null;
  const session = await openLibrarySession({ kind: "agent", project: input.project, resolveProject: false });
  if (!session) throw cloudAgentsLoginRequiredError();
  try {
    const shown = await session.client.showSlug(slug, { project: input.project });
    const ref =
      shown.item.ref ||
      (shown.item.scope === "org" ? `org/${shown.item.slug}` : `${shown.item.project?.slug ?? ""}/${shown.item.slug}`);
    return {
      ref,
      slug: shown.item.slug,
      project: shown.item.scope === "project" ? (shown.item.project?.slug ?? null) : null,
      source: "library",
    };
  } catch (error) {
    if (isLibraryNotFoundError(error)) return null;
    throw error;
  }
}
