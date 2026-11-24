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

/**
 * Storage-level guard for automation (triggers, cron jobs, hooks, session
 * followups, signals, task automations): whatever command or side effect
 * reaches the store, a turn held below the agent (contact chat overlay, a
 * relay of it, or a person held below the agent's break-glass) cannot write
 * work that would later run as the whole agent. Command-level guards stay for
 * a good error message; this one is what guarantees it. Code outside a turn
 * (daemon, migrations, terminal) is unaffected. Reducing (disabling) is always
 * allowed.
 *
 * `bindableToOverlayChat`: a cron job bound to the overlay chat (`creatorChat`)
 * runs under that chat's grants, so an overlay turn may write it; a person held
 * below break-glass has no grant to bind to.
 */
export function assertAutomationStoreWrite(
  store: string,
  options: { disablesOnly?: boolean; bindableToOverlayChat?: boolean } = {},
): void {
  if (options.disablesOnly) return;
  const metadata = getContext()?.context?.metadata;
  if (!metadata) return;
  const withheld = Array.isArray(metadata.actorBreakGlassWithheld) && metadata.actorBreakGlassWithheld.length > 0;
  const narrowed = metadata.actorAuthorizationMode === "user-overlay" || metadata.relayNarrowing === true;
  if (!withheld && (!narrowed || options.bindableToOverlayChat)) return;
  throw new CliExpectedError(
    `${store} cannot be written in a turn limited below the agent's authority: it would run later with the agent's full authority.`,
    "PERMISSION_DENIED",
    1,
    "Ask the operator to set it up.",
  );
}
