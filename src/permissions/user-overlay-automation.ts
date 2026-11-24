import { getContext } from "../cli/context.js";
import { CliExpectedError } from "../cli/expected-error.js";

/**
 * A turn narrowed to a contact's chat grants (`actorAuthorizationMode:
 * user-overlay`) cannot write work that runs later as the executor agent:
 * triggers, followups, hooks, tasks and signals carry no binding to the
 * contact's grants, so they would outlive and exceed them. A turn relayed from
 * such a turn (`relayNarrowing`) is held to the same rule, and so is a
 * person's turn in an ungoverned chat that was held below the agent's
 * break-glass (`actorBreakGlassWithheld`). Cron jobs record the overlay chat
 * instead (`creatorChat`).
 */
export function isUserOverlayAutomationTurn(): boolean {
  const metadata = getContext()?.context?.metadata;
  return (
    metadata?.actorAuthorizationMode === "user-overlay" ||
    metadata?.relayNarrowing === true ||
    // A person's turn (or a relay of it) held to "agent minus break-glass":
    // automation written here would run later as the whole agent.
    (Array.isArray(metadata?.actorBreakGlassWithheld) && metadata.actorBreakGlassWithheld.length > 0)
  );
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
