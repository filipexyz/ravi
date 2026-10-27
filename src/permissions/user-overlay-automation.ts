import { getContext } from "../cli/context.js";
import { CliExpectedError } from "../cli/expected-error.js";

/**
 * A turn narrowed to a contact's chat grants (`actorAuthorizationMode:
 * user-overlay`) cannot write work that runs later as the executor agent:
 * triggers, followups, hooks, tasks and signals carry no binding to the
 * contact's grants, so they would outlive and exceed them. A turn relayed from
 * such a turn (`relayNarrowing`) is held to the same rule. Cron jobs record
 * the overlay chat instead (`creatorChat`).
 */
export function isUserOverlayAutomationTurn(): boolean {
  const metadata = getContext()?.context?.metadata;
  return metadata?.actorAuthorizationMode === "user-overlay" || metadata?.relayNarrowing === true;
}

export function assertNoUserOverlayAutomationWrite(op: string): void {
  if (!isUserOverlayAutomationTurn()) return;
  throw new CliExpectedError(
    `${op} is not available in a turn limited to a contact's chat permissions: it would run later with the agent's full authority.`,
    "PERMISSION_DENIED",
    1,
    "Ask the operator to set it up.",
  );
}
