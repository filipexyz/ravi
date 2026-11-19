/**
 * The notice that goes out when Ravi turns off a shell cron job or a shell
 * trigger instead of running it (owner is not the operator, env file refused).
 *
 * It travels the way a cron failure does (`failure-notification.ts`): a direct
 * message through the gateway, with no model in the path, so the report of a
 * broken automation never needs the agent that may be what is broken. Who
 * receives it:
 *
 * - the owner, when a person owns the automation (the operator, or a contact)
 *   and has a direct chat;
 * - the operator as well when the owner does not act as the operator, because
 *   only the operator can recreate it, and instead of the owner when nobody
 *   owns it or the owner has no direct chat (a legacy row, one Ravi wrote, an
 *   agent).
 *
 * When no direct message went out (no recipient resolves, or every delivery
 * failed) the runner's own `fallback` runs: the prompt it always sent to the
 * default agent's main session. The notice is never silent.
 *
 * The text names the code, the reason and what to do next. It never carries
 * the command, its environment, an event or the content of an env file.
 */

import { deliverToChat } from "../cloud-agents/chat-target.js";
import { resolveOwnerDirectTarget, type OwnerDirectTarget } from "../knowledge/owner.js";
import { logger } from "../utils/logger.js";
import { resolveCronFailureOwner } from "./failure-notification.js";

const log = logger.child("cron:automation-notice");

const KIND_LABEL = { cron: "O agendamento de shell", trigger: "O gatilho de shell" } as const;
const NAME_MAX = 60;

export interface AutomationNotice {
  kind: keyof typeof KIND_LABEL;
  id: string;
  name: string;
  /** Who owns it: `operator`, `contact:<id>`, anything else (or nothing) is nobody. */
  ownerPrincipal: string | null | undefined;
  /** The stable code, for example `TRIGGER_SHELL_NOT_OPERATOR`. */
  code: string;
  /** Why it was turned off (pt-BR, one or two sentences, no command, env or file content). */
  reason: string;
  /** What to do about it (pt-BR). */
  next: string;
  /** The operator is told as well: the owner does not act as the operator. */
  operatorToo: boolean;
  /** Runs when no direct message went out. */
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
  /** Direct messages sent. */
  delivered: number;
  /** The fallback ran because no direct message went out. */
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

function recipients(notice: AutomationNotice, deps: AutomationNoticeDeps): OwnerDirectTarget[] {
  const owner = (deps.owner ?? defaultOwnerTarget)(notice.ownerPrincipal);
  const operator = notice.operatorToo || !owner ? (deps.operator ?? resolveOwnerDirectTarget)() : null;
  const seen = new Set<string>();
  const out: OwnerDirectTarget[] = [];
  for (const target of [owner, operator]) {
    if (!target) continue;
    const key = `${target.channel}\u0000${target.accountId}\u0000${target.chatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * Sends the notice once to each recipient. Resolves after the fallback when no
 * direct message went out; rejects only when that fallback does.
 */
export async function notifyAutomationOff(
  notice: AutomationNotice,
  deps: AutomationNoticeDeps = {},
): Promise<AutomationNoticeResult> {
  let delivered = 0;
  try {
    const text = automationNoticeText(notice);
    const deliver = deps.deliver ?? ((target, message) => deliverToChat(target, { text: message }));
    for (const target of recipients(notice, deps)) {
      try {
        await deliver(target, text);
        delivered++;
      } catch (error) {
        log.warn("Automation notice not delivered to one recipient", {
          kind: notice.kind,
          id: notice.id,
          code: notice.code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    // Resolving a recipient must never swallow the notice: the fallback still runs.
    log.warn("Automation notice recipients unresolved", {
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
  });
  await notice.fallback();
  return { delivered, fellBack: true };
}
