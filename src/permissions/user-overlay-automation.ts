import { getContext } from "../cli/context.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { type ActorLimitContextLike, isActorBreakGlassLimitedContext, isRelayHeldBelowAgent } from "./actor-limit.js";
import { AUTOMATION_HOLD_SUGGESTED_ACTION, type AutomationHoldCause } from "./automation-hold.js";

export type { AutomationHoldCause } from "./automation-hold.js";

/**
 * Why a turn may not write automation that runs later as the executor agent
 * (causes in `automation-hold.ts`), or null when it may. A held relay is named
 * first, also when the relayed turn is narrowed to a contact's chat grants too
 * (a thread opened from a governed chat): no grant lifts it, and that is what
 * the caller must read. The refusal names the cause because the remedy
 * differs; whether the turn is refused does not depend on the order.
 */
export function automationHoldCause(
  context: ActorLimitContextLike | null | undefined = getContext()?.context,
): AutomationHoldCause | null {
  const metadata = context?.metadata ?? undefined;
  const withheld = isActorBreakGlassLimitedContext(context);
  // A relay carrying its caller's withheld break-glass is held by the relay, not by its own actor.
  if (metadata?.relayNarrowing === true && (withheld || isRelayHeldBelowAgent(metadata))) return "held-relay";
  if (metadata?.actorAuthorizationMode === "user-overlay") return "contact-chat-grants";
  return withheld ? "person-without-chat-grant" : null;
}

const HOLD_TEXT: Record<AutomationHoldCause, { turn: string; store: string }> = {
  "contact-chat-grants": {
    turn: "a turn limited to a contact's chat permissions",
    store: "a contact's chat permissions",
  },
  "held-relay": {
    turn: "a relayed turn (a thread, a thread's return or a session message) whose caller does not carry the agent's whole authority",
    store: "a relay whose caller does not carry the agent's whole authority",
  },
  "person-without-chat-grant": {
    turn: "the turn of a person with no grant in this chat (held below the agent's break-glass)",
    store: "a person with no grant in this chat",
  },
};

/** The refusal, with the cause as a control field the remote CLI maps to the same fixed advice. */
function automationHoldError(message: string, cause: AutomationHoldCause): CliExpectedError {
  return new CliExpectedError(message, "PERMISSION_DENIED", 1, AUTOMATION_HOLD_SUGGESTED_ACTION[cause], {
    automationHold: cause,
  });
}

/**
 * A turn narrowed to a contact's chat grants (`actorAuthorizationMode:
 * user-overlay`) cannot write work that runs later as the executor agent:
 * triggers, followups, hooks, tasks and signals carry no binding to the
 * contact's grants, so they would outlive and exceed them. A turn relayed from
 * such a turn (`relayNarrowing`) is held to the same rule, and so is a
 * person's turn in an ungoverned chat that was held below the agent's
 * break-glass (`actorBreakGlassWithheld`). Cron jobs record the overlay chat
 * instead (`creatorChat`). The operator's own relay (a thread they asked for)
 * carries `relayNarrowing` too, but holds the agent's authority
 * (`relayCallerUnrestricted`) and writes automation as itself. The operator
 * speaking in a governed chat is not narrowed either: a contact whose own
 * power covers the agent gets a lifted overlay (`userOverlay: lifted`), not an
 * overlay turn (`permissions/user-overlay`, "Lifted Overlay").
 */
export function isUserOverlayAutomationTurn(): boolean {
  return automationHoldCause() !== null;
}

export function assertNoUserOverlayAutomationWrite(op: string): void {
  const cause = automationHoldCause();
  if (!cause) return;
  throw automationHoldError(
    `${op} is not available in ${HOLD_TEXT[cause].turn}: it would run later with the agent's full authority.`,
    cause,
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
  const context = getContext()?.context;
  if (!context) return;
  const cause = automationHoldCause(context);
  if (!cause) return;
  // Binding to the overlay chat excuses a narrowed turn, never a withheld break-glass.
  if (options.bindableToOverlayChat && !isActorBreakGlassLimitedContext(context)) return;
  throw automationHoldError(
    `${store} cannot be written in a turn limited below the agent's authority (${HOLD_TEXT[cause].store}): it would run later with the agent's full authority.`,
    cause,
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
