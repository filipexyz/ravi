/**
 * Which WhatsApp account a `ravi whatsapp ...` command acts on.
 *
 * The account used to be `--account ?? <account of the current turn> ?? <first enabled instance>`, whatever the
 * channel. From a Slack turn that picked `ravi-slack` ("No omni instance mapped for account ravi-slack"), and the
 * "first enabled instance" fallback could be a non-WhatsApp instance too. The account of the turn only says which
 * WhatsApp account to use when the turn itself comes from WhatsApp.
 */
import { fail, getContext } from "./context.js";
import { dbListInstances } from "../router/router-db.js";

export interface WhatsAppAccountInstance {
  name: string;
  channel?: string;
  instanceId?: string;
  enabled?: boolean;
  deletedAt?: number;
}

export interface PickWhatsAppAccountInput {
  /** Value of `--account`, when given. */
  account?: string;
  /** Source of the current turn. Undefined from a terminal, a cron job or a script. */
  source?: { channel?: string; accountId?: string };
  instances: readonly WhatsAppAccountInstance[];
}

export type WhatsAppAccountFailureCode = "NO_WHATSAPP_ACCOUNT" | "ACCOUNT_NOT_WHATSAPP" | "AMBIGUOUS_WHATSAPP_ACCOUNT";

export type PickWhatsAppAccountResult =
  | { ok: true; accountId: string; via: "flag" | "turn" | "single-account" | "first-account" }
  | { ok: false; code: WhatsAppAccountFailureCode; message: string; candidates: string[] };

function whatsappCandidates(instances: readonly WhatsAppAccountInstance[]): string[] {
  return instances
    .filter((instance) => instance.channel === "whatsapp" && instance.enabled !== false && !instance.deletedAt)
    .map((instance) => instance.name);
}

/** ` WhatsApp accounts: main, luis. Pass --account <id>.` for error messages, or "" when there is none to suggest. */
export function whatsappAccountsHint(instances: readonly WhatsAppAccountInstance[]): string {
  const candidates = whatsappCandidates(instances);
  return candidates.length > 0 ? ` WhatsApp accounts: ${candidates.join(", ")}. Pass --account <id>.` : "";
}

export function pickWhatsAppAccount(input: PickWhatsAppAccountInput): PickWhatsAppAccountResult {
  const candidates = whatsappCandidates(input.instances);
  const hint = whatsappAccountsHint(input.instances);

  const flag = input.account?.trim();
  if (flag) {
    const named = input.instances.find((instance) => instance.name === flag);
    if (named?.channel && named.channel !== "whatsapp") {
      return {
        ok: false,
        code: "ACCOUNT_NOT_WHATSAPP",
        message: `Account "${flag}" is a ${named.channel} account, not WhatsApp.${hint}`,
        candidates,
      };
    }
    // An unknown name is kept as given: it may be an omni instance UUID, which the callers resolve themselves.
    return { ok: true, accountId: flag, via: "flag" };
  }

  const turnAccount = input.source?.accountId?.trim();
  if (input.source?.channel === "whatsapp" && turnAccount) {
    return { ok: true, accountId: turnAccount, via: "turn" };
  }

  if (candidates.length === 1) return { ok: true, accountId: candidates[0], via: "single-account" };

  if (candidates.length === 0) {
    return { ok: false, code: "NO_WHATSAPP_ACCOUNT", message: "No WhatsApp account configured.", candidates };
  }

  const turnChannel = input.source?.channel?.trim();
  if (!turnChannel) {
    // No turn to learn the account from (terminal, cron, script). Keep the historical behaviour of taking the
    // first enabled account so existing automation does not start failing.
    return { ok: true, accountId: candidates[0], via: "first-account" };
  }

  return {
    ok: false,
    code: "AMBIGUOUS_WHATSAPP_ACCOUNT",
    message: `This turn comes from ${turnChannel}, which does not say which WhatsApp account to use.${hint}`,
    candidates,
  };
}

/** Resolve the account for the running command, or fail with an error that names the accounts to pass. */
export function resolveWhatsAppAccount(account?: string): string {
  const result = pickWhatsAppAccount({
    account,
    source: getContext()?.source,
    instances: dbListInstances(),
  });
  if (!result.ok) fail(result.message);
  return result.accountId;
}

/** Hint for "No omni instance mapped for account ..." style errors, from the instances registered now. */
export function currentWhatsAppAccountsHint(): string {
  return whatsappAccountsHint(dbListInstances());
}
