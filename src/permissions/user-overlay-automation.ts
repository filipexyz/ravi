import { AsyncLocalStorage } from "node:async_hooks";
import { getContext } from "../cli/context.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { isActorBreakGlassLimitedContext } from "./actor-limit.js";

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
    // A person's turn (or a relay or derived context of it) held to "agent
    // minus break-glass": automation written here would run later as the whole agent.
    isActorBreakGlassLimitedContext(getContext()?.context)
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
  options: { disablesOnly?: boolean; bindableToOverlayChat?: boolean; canonicalFollow?: Record<string, unknown> } = {},
): void {
  if (options.disablesOnly) return;
  const context = getContext()?.context;
  if (!context) return;
  const metadata = context.metadata ?? {};
  const withheld = isActorBreakGlassLimitedContext(context);
  const narrowed = metadata.actorAuthorizationMode === "user-overlay" || metadata.relayNarrowing === true;
  if (!withheld && (!narrowed || options.bindableToOverlayChat)) return;
  if (options.canonicalFollow && canonicalFollowCovers(options.canonicalFollow)) return;
  throw new CliExpectedError(
    `${store} cannot be written in a turn limited below the agent's authority: it would run later with the agent's full authority.`,
    "PERMISSION_DENIED",
    1,
    "Ask the operator to set it up.",
  );
}

/**
 * A person held below the agent's break-glass cannot move an agent's
 * workspace or create an agent: the workspace is where that person's file
 * writes are allowed, so moving it (e.g. to the Ravi state dir) would reopen
 * operator config. Code outside a turn is unaffected.
 */
export function assertNotActorBreakGlassLimited(op: string): void {
  if (!isActorBreakGlassLimitedContext(getContext()?.context)) return;
  throw new CliExpectedError(
    `${op} is not available in a turn limited below the agent's authority.`,
    "PERMISSION_DENIED",
    1,
    "Ask the operator to set it up.",
  );
}

/**
 * The one automation a limited turn may leave behind: the CI follow that
 * `ravi pr publish` arms for the session that published. Its content is fixed
 * by the runtime (`buildGhFollowTriggerInput`: topic, filter, message and
 * routing derive only from the verified repository, PR number and the
 * publisher's own session), so it carries nothing the person wrote and cannot
 * widen what they may do. The publisher already holds `mutate:pr:publish`,
 * which is what authorizes the follow.
 *
 * Narrow on purpose: only an active scope opened by the publication, only a
 * synchronous body, and a write that sets nothing but the fields the scope
 * names, each with exactly the named value. Any other trigger written inside
 * the same turn is still refused above.
 */
const canonicalFollowScope = new AsyncLocalStorage<{ fields: Readonly<Record<string, unknown>> }>();

export function runCanonicalFollowWrite<T>(allowance: { fields: Readonly<Record<string, unknown>> }, body: () => T): T {
  if (body.constructor?.name === "AsyncFunction")
    throw new Error("runCanonicalFollowWrite takes a synchronous body: the scope must not outlive the write.");
  const result = canonicalFollowScope.run(allowance, body);
  if (result instanceof Promise) {
    // Never leave the allowance to a continuation that runs after the write.
    throw new Error("runCanonicalFollowWrite took a body that returned a promise.");
  }
  return result;
}

function canonicalFollowCovers(written: Record<string, unknown>): boolean {
  const allowance = canonicalFollowScope.getStore();
  if (!allowance) return false;
  const entries = Object.entries(written).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, value]) => JSON.stringify(allowance.fields[key]) === JSON.stringify(value) && value !== undefined,
  );
}
