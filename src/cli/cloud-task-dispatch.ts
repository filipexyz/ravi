/**
 * The `--cloud` branch of `ravi tasks dispatch` (spec `cloud/agents`, "Task
 * dispatch"): plan and brake, start the cloud run, mark the task in progress.
 * Kept out of `src/cli/commands/` because every file there is re-exported by
 * the generated barrel.
 *
 * spec: cloud/agents, tasks, cli
 */

import {
  executeCloudTaskDispatch,
  prepareCloudTaskDispatch,
  type CloudTaskDispatchDeps,
} from "../cloud-agents/task-dispatch.js";
import type { CloudRun } from "../cloud-agents/types.js";
import type { TaskEvent, TaskRecord } from "../tasks/types.js";
import { contractDryRun } from "./agent-contract.js";
import { parseCloudBudget, withCloudAgentsContract } from "./cloud-agents-contract.js";

export interface CloudTaskDispatchCommandDeps extends CloudTaskDispatchDeps {
  /** Records the run on the task (tests replace it). */
  markInProgress?: (input: { taskId: string; actor: string; message: string }) => Promise<{
    task: TaskRecord;
    event: TaskEvent;
  }>;
}

export interface CloudTaskDispatchResult {
  mode: "cloud";
  task: TaskRecord;
  event: TaskEvent;
  cloudRun: CloudRun;
}

export async function runCloudTaskDispatch(
  input: {
    task: TaskRecord;
    agentId: string;
    project?: string;
    budget?: string;
    informSession: string | null;
    actor: string;
    execute: boolean;
    asJson?: boolean;
  },
  deps: CloudTaskDispatchCommandDeps = {},
): Promise<CloudTaskDispatchResult> {
  const op = "tasks dispatch";
  const budgetUsd = parseCloudBudget(op, input.budget, input.asJson);
  return withCloudAgentsContract(
    op,
    input.asJson,
    async () => {
      const prepared = await prepareCloudTaskDispatch(
        {
          task: input.task,
          agentId: input.agentId,
          project: input.project ?? null,
          ...(budgetUsd !== undefined ? { budgetUsd } : {}),
          informSession: input.informSession,
        },
        deps,
      );
      if (!input.execute) {
        contractDryRun(op, { cloud: true, ...prepared.plan }, { asJson: input.asJson });
      }
      const run = await executeCloudTaskDispatch(prepared);
      const where = input.informSession ? `; the result arrives in ${input.informSession}` : "";
      const marked = await (deps.markInProgress ?? defaultMarkInProgress)({
        taskId: input.task.id,
        actor: input.actor,
        message: `Running in the cloud: run ${run.id} of ${prepared.plan.library.ref}${where}.`,
      });
      const result: CloudTaskDispatchResult = { mode: "cloud", task: marked.task, event: marked.event, cloudRun: run };
      if (input.asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n✓ Dispatched ${input.task.id} to the cloud`);
        console.log(`  Run:      ${run.id} (${run.status})`);
        console.log(`  Agent:    ${prepared.plan.library.ref} in ${prepared.plan.project}`);
        console.log(`  Result:   ${input.informSession ?? "ravi tasks show / ravi cloud runs show"}`);
        console.log(`  Follow:   ravi cloud runs follow ${run.id}`);
      }
      return result;
    },
    { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
  );
}

async function defaultMarkInProgress(input: { taskId: string; actor: string; message: string }) {
  const { emitTaskEvent, reportTaskProgress } = await import("../tasks/service.js");
  const result = reportTaskProgress(input.taskId, { actor: input.actor, message: input.message });
  await emitTaskEvent(result.task, result.event);
  return result;
}
