/**
 * The notice that goes out when Ravi turns off a shell cron job or a shell
 * trigger instead of running it (owner is not the operator, env file refused).
 *
 * It travels the way a cron failure does (`failure-notification.ts`): a direct
 * message through the gateway, with no model in the path, so the report of a
 * broken automation never needs the agent that may be what is broken.
 *
 * One person is told, chosen by the notice's `audience`:
 *
 * - `operator`: only the operator can act on it (the owner does not act as the
 *   operator, so the owner cannot recreate a shell). The operator alone is told,
 *   never the owner: a contact owner would be reached over the instance where
 *   Ravi last saw them, which can be the operator's own line, about something
 *   they cannot act on.
 * - `owner`: the owner acts as the operator, so the owner is who can act. They
 *   are told in their own direct chat, or the operator is when nobody owns it or
 *   the owner has no direct chat (a legacy row, one Ravi wrote, an agent).
 *
 * When that person was not reached by direct message (the chat does not
 * resolve, for example no contact or more than one is tagged as the operator, or
 * the delivery failed) the runner's own `fallback` runs: the prompt it always
 * sent to the default agent's main session, which is the operator's. Whoever can
 * act on the notice is never left without it.
 *
 * The text names the code, the reason and what to do next. It never carries
 * the command, its environment, an event or the content of an env file, and no
 * internal id of who owns it.
 */

import { deliverToChat } from "../cloud-agents/chat-target.js";
import { resolveOwnerDirectTarget, type OwnerDirectTarget } from "../knowledge/owner.js";
import { logger } from "../utils/logger.js";
import { resolveCronFailureOwner } from "./failure-notification.js";

const log = logger.child("cron:automation-notice");

const KIND_LABEL = { cron: "O agendamento de shell", trigger: "O gatilho de shell" } as const;
const NAME_MAX = 60;

/** Who is told: the owner (who acts as the operator) or the operator alone (the owner cannot act). */
export type AutomationNoticeAudience = "owner" | "operator";

export interface AutomationNotice {
  kind: keyof typeof KIND_LABEL;
  id: string;
  name: string;
  /** Who owns it: `operator`, `contact:<id>`, anything else (or nothing) is nobody. Read only for the `owner` audience. */
  ownerPrincipal: string | null | undefined;
  /** The stable code, for example `TRIGGER_SHELL_NOT_OPERATOR`. */
  code: string;
  /** Why it was turned off (pt-BR, one or two sentences, no command, env, file content or owner id). */
  reason: string;
  /** What to do about it (pt-BR). */
  next: string;
  audience: AutomationNoticeAudience;
  /** Runs when the person it is for was not reached by direct message. */
  fallback: () => Promise<unknown>;
}

export interface AutomationNoticeDeps {
  /** The owner's direct chat, null when nobody owns it or the owner has none. */
  owner?: (ownerPrincipal: string | null | undefined) => OwnerDirectTarget | null;
  /** The operator's direct chat. */
  operator?: () => OwnerDirectTarget | null;
  deliver?: (target: OwnerDirectTarget, text: string) => Promise<unknown>;
}

export interface AutomationNoticeResult {
  /** Direct messages sent (0 or 1). */
  delivered: number;
  /** The fallback ran because the direct message did not go out. */
  fellBack: boolean;
}

/** One line, no angle brackets or backticks: the name is text a person chose. */
export function automationNoticeName(name: string): string {
  const clean = name
    .replace(/[\u0000-\u001f\u007f<>`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > NAME_MAX ? `${clean.slice(0, NAME_MAX - 1)}…` : clean || "(sem nome)";
}

export function automationNoticeText(notice: AutomationNotice): string {
  return `${KIND_LABEL[notice.kind]} “${automationNoticeName(notice.name)}” (${notice.id}) foi desligado: ${notice.code}. ${notice.reason} ${notice.next}`;
}

function defaultOwnerTarget(ownerPrincipal: string | null | undefined): OwnerDirectTarget | null {
  const owner = ownerPrincipal?.trim();
  // A cron failure reads no owner as the operator; here no owner is nobody.
  return owner ? resolveCronFailureOwner({ ownerPrincipal: owner }) : null;
}

/**
 * One chat, resolved on its own: a resolver that throws (an unreadable contact
 * store, say) loses that chat and nothing else, so the operator is still tried
 * when the owner's chat cannot be read.
 */
function resolveChat(
  notice: AutomationNotice,
  who: "owner" | "operator",
  resolve: () => OwnerDirectTarget | null,
): OwnerDirectTarget | null {
  try {
    return resolve();
  } catch (error) {
    log.warn("Automation notice recipient unresolved", {
      kind: notice.kind,
      id: notice.id,
      code: notice.code,
      who,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The one chat the notice goes to, or null when none resolves. */
function recipient(notice: AutomationNotice, deps: AutomationNoticeDeps): OwnerDirectTarget | null {
  const owner =
    notice.audience === "owner"
      ? resolveChat(notice, "owner", () => (deps.owner ?? defaultOwnerTarget)(notice.ownerPrincipal))
      : null;
  return owner ?? resolveChat(notice, "operator", () => (deps.operator ?? resolveOwnerDirectTarget)());
}

/**
 * Sends the notice once. Resolves after the fallback when the direct message
 * did not go out; rejects only when that fallback does.
 */
export async function notifyAutomationOff(
  notice: AutomationNotice,
  deps: AutomationNoticeDeps = {},
): Promise<AutomationNoticeResult> {
  let delivered = 0;
  try {
    const target = recipient(notice, deps);
    if (target) {
      const deliver = deps.deliver ?? ((chat, message) => deliverToChat(chat, { text: message }));
      try {
        await deliver(target, automationNoticeText(notice));
        delivered = 1;
      } catch (error) {
        log.warn("Automation notice not delivered", {
          kind: notice.kind,
          id: notice.id,
          code: notice.code,
          audience: notice.audience,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    // Building the text must never swallow the notice: the fallback still runs.
    log.warn("Automation notice not built", {
      kind: notice.kind,
      id: notice.id,
      code: notice.code,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (delivered > 0) return { delivered, fellBack: false };
  log.warn("Automation notice has no direct delivery; sending it to the main session", {
    kind: notice.kind,
    id: notice.id,
    code: notice.code,
    audience: notice.audience,
  });
  await notice.fallback();
  return { delivered, fellBack: true };
}
