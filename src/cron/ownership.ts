import { cronOwnerActsAsOperator } from "../link/connector-turn.js";
import type { CronJob } from "./types.js";

/** Current eligibility, also used for read-only inspection before reconciliation. */
export function cronOwnershipError(job: Pick<CronJob, "executionType" | "ownerPrincipal">): string | null {
  return job.executionType === "shell" && !cronOwnerActsAsOperator(job.ownerPrincipal ?? null)
    ? "CRON_SHELL_NOT_OPERATOR"
    : null;
}

export function cronOwnershipStatus(job: Pick<CronJob, "executionType" | "ownerPrincipal" | "enabled">): string {
  if (cronOwnershipError(job)) return job.enabled ? "invalid-owner" : "disabled-owner";
  return job.enabled ? "enabled" : "disabled";
}
