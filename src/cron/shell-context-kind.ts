import type { ContextRecord } from "../router/router-db.js";

/** Context kind the cron runner issues for one shell job run. Only a root context of this kind counts. */
export const CRON_SHELL_CONTEXT_KIND = "cron-shell";

/** Whether a context is a shell cron run's own root context (the kind alone is not enough). */
export function isShellCronRootContext(context: Pick<ContextRecord, "kind" | "metadata">): boolean {
  return context.kind === CRON_SHELL_CONTEXT_KIND && context.metadata?.parentContextId === undefined;
}
