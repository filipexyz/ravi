// Write-after-read (contract §11.4). A turn that read unapproved Knowledge
// (meeting speech, page text: anything below `approved`) may have been steered
// by it, so before that turn sends something out of the org, now or later, the
// operator approves the action on a PT-BR card in their own chat. The terminal
// is never gated: the operator is typing there.
//
// Rows hold the turn key, a fingerprint of the command and a summary made of
// flag names only; never option values, bodies or secrets.

import { createHash, randomUUID } from "node:crypto";

import { requestApproval } from "../../approval/service.js";
import { CONTRACT_EXIT_POLICY, ContractError } from "../../cli/agent-contract.js";
import { getContext } from "../../cli/context.js";
import type { CommandAccessOptions } from "../../cli/decorators.js";
import { logger } from "../../utils/logger.js";
import { resolveOwnerDirectTarget } from "../owner.js";
import {
  findWriteApproval,
  lowestTierReadInTurn,
  upsertWriteApproval,
  setWriteApprovalStatus,
  type WriteApprovalRow,
} from "../store/turn-reads.js";
import { resolveKnowledgeConnectorTurn } from "./turn.js";

const log = logger.child("knowledge:write-after-read");

export type WriteAfterReadInput = {
  group: string;
  command: string;
  options: Record<string, unknown>;
  access: CommandAccessOptions | undefined;
  turnKey: string | null;
};
export type WriteAfterReadDecision =
  | { allowed: true }
  | { allowed: false; code: "KNOWLEDGE_WRITE_AFTER_READ"; approvalId: string; issues: string[] };

export interface WriteAfterReadDeps {
  now?: number;
  requestApproval?: typeof requestApproval;
  ownerTarget?: typeof resolveOwnerDirectTarget;
}

/** How long the operator has to answer the card. */
export const WRITE_APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** An answer (approved or denied) holds for this long for the same command in the same turn. */
export const WRITE_APPROVAL_REUSE_MS = 30 * 60_000;
/** A `pending` row older than this lost its waiter (daemon restart, CLI exit). */
const STALE_PENDING_MS = WRITE_APPROVAL_TIMEOUT_MS + 60_000;

export const WRITE_AFTER_READ_ISSUE =
  "This turn read unapproved content (meeting speech or page text). Ravi asked the operator to approve this action; run it again after they approve.";
export const WRITE_AFTER_READ_DENIED_ISSUE = "The operator denied this action.";
export const WRITE_AFTER_READ_NO_OWNER_ISSUE =
  "This turn read unapproved content (meeting speech or page text), and Ravi has no operator chat to ask for approval. Do not run this action from this turn; ask the operator to run it from the terminal.";

/** Commands that send right away (`requiresConfirmation` + `--execute` covers the rest). */
const ALWAYS_GATED = new Set([
  "sessions.send",
  "sessions.ask",
  "sessions.inform",
  "sessions.execute",
  // Delayed egress: these would send what the turn read later.
  "cron.add",
  "cron.set",
  "triggers.add",
  "triggers.set",
  "triggers.test",
  "tasks.create",
  "tasks.dispatch",
  "agents.set",
]);

const SECRET_OPTION = /pass(word|phrase)?|secret|token|api[-_]?key|credential|authorization|cookie|private[-_]?key/i;

let defaultsForTests: WriteAfterReadDeps | null = null;

/** Tests only: deps the hook sites use when they pass none. */
export function setWriteAfterReadDefaultsForTests(deps: WriteAfterReadDeps | null): void {
  defaultsForTests = deps;
}

export function isWriteAfterReadGated(input: Omit<WriteAfterReadInput, "turnKey">): boolean {
  const name = commandName(input.group, input.command);
  if (ALWAYS_GATED.has(name)) return true;
  if (name === "pages.ship") {
    const visibility = input.options.visibility;
    return visibility !== undefined && visibility !== null && visibility !== "" && visibility !== "private";
  }
  return input.access?.requiresConfirmation === true && input.options.execute === true;
}

export function checkWriteAfterRead(input: WriteAfterReadInput, deps: WriteAfterReadDeps = {}): WriteAfterReadDecision {
  const resolved = { ...(defaultsForTests ?? {}), ...deps };
  const now = resolved.now ?? Date.now();
  if (!input.turnKey || !isWriteAfterReadGated(input)) return { allowed: true };

  let tier: ReturnType<typeof lowestTierReadInTurn>;
  try {
    tier = lowestTierReadInTurn(input.turnKey, now);
  } catch (error) {
    // No readable record of what this turn read: the reads were recorded
    // in the same store, so there is nothing to hold the write against.
    log.warn("turn reads unavailable; write allowed", { error: errorMessage(error) });
    return { allowed: true };
  }
  if (tier === null || tier === "approved") return { allowed: true };
  try {
    return askOperator(input, input.turnKey, now, resolved);
  } catch (error) {
    // The turn read unapproved content: without a recorded answer, deny.
    log.warn("write-after-read approval unavailable", { error: errorMessage(error) });
    return deny("", WRITE_AFTER_READ_ISSUE);
  }
}

function askOperator(
  input: WriteAfterReadInput,
  turnKey: string,
  now: number,
  resolved: WriteAfterReadDeps,
): WriteAfterReadDecision {
  const name = commandName(input.group, input.command);
  const fingerprint = writeFingerprint(name, input.options, input.access);
  const existing = findWriteApproval(turnKey, fingerprint);
  if (existing) {
    const decidedAge = now - (existing.decidedAt ?? existing.requestedAt);
    if (existing.status === "approved" && decidedAge < WRITE_APPROVAL_REUSE_MS) return { allowed: true };
    if (existing.status === "denied" && decidedAge < WRITE_APPROVAL_REUSE_MS) {
      return deny(existing.id, WRITE_AFTER_READ_DENIED_ISSUE);
    }
    if (existing.status === "pending" && now - existing.requestedAt <= STALE_PENDING_MS) {
      return deny(existing.id, WRITE_AFTER_READ_ISSUE);
    }
  }

  const target = (resolved.ownerTarget ?? resolveOwnerDirectTarget)();
  if (!target) return deny(existing?.id ?? "", WRITE_AFTER_READ_NO_OWNER_ISSUE);

  const summary = summarizeCommand(name, input.options, input.access);
  const row: WriteApprovalRow = {
    id: randomUUID(),
    turnKey,
    fingerprint,
    summary,
    status: "pending",
    requestedAt: now,
    decidedAt: null,
  };
  upsertWriteApproval(row);

  const context = getContext();
  const agentId = context?.agentId ?? "desconhecido";
  const ask = resolved.requestApproval ?? requestApproval;
  const text = `O agente ${agentId} leu conteúdo não aprovado neste turno (fala de reunião ou texto de página) e agora quer: ${summary}. Aprovar?`;
  // Fire and forget: the command is denied now and runs again once approved.
  void Promise.resolve()
    .then(() =>
      ask({ channel: target.channel, accountId: target.accountId, chatId: target.chatId }, text, {
        timeoutMs: WRITE_APPROVAL_TIMEOUT_MS,
        type: "permission",
        permission: "knowledge:write_after_read",
        objectType: "command",
        objectId: name,
        ...(context?.agentId ? { agentId: context.agentId } : {}),
        ...(context?.sessionName ? { sessionName: context.sessionName } : {}),
      }),
    )
    .then((result) => {
      setWriteApprovalStatus(row.id, approvalOutcome(result));
    })
    .catch((error) => {
      log.warn("write-after-read approval failed", { approvalId: row.id, error: errorMessage(error) });
      try {
        setWriteApprovalStatus(row.id, "expired");
      } catch {
        // The row stays pending and is replaced once stale.
      }
    });
  return deny(row.id, WRITE_AFTER_READ_ISSUE);
}

/**
 * The hook sites' entry: cheap gating first, then the turn key from the
 * current context (AsyncLocalStorage or env), then the check.
 */
export function enforceWriteAfterRead(
  input: Omit<WriteAfterReadInput, "turnKey">,
  deps: WriteAfterReadDeps = {},
): WriteAfterReadDecision {
  if (!isWriteAfterReadGated(input)) return { allowed: true };
  return checkWriteAfterRead({ ...input, turnKey: currentWriteGateTurnKey() }, deps);
}

/** The current turn's key, whether or not the turn may use Knowledge; null on the terminal. */
export function currentWriteGateTurnKey(): string | null {
  try {
    const result = resolveKnowledgeConnectorTurn();
    if (result.ok) return result.turn.turnKey ?? null;
    return result.candidate?.turnKey ?? result.relay?.turnKey ?? null;
  } catch {
    return null;
  }
}

export function writeAfterReadContractError(
  op: string,
  decision: Extract<WriteAfterReadDecision, { allowed: false }>,
): ContractError {
  return new ContractError(
    op,
    decision.code,
    "This action needs the operator's approval because the turn read unapproved Knowledge.",
    CONTRACT_EXIT_POLICY,
    {
      retryable: decision.issues[0] === WRITE_AFTER_READ_ISSUE,
      ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
      issues: decision.issues,
    },
  );
}

/** sha256 of `group.command` plus the canonical JSON of the options without secrets. */
export function writeFingerprint(
  name: string,
  options: Record<string, unknown>,
  access: CommandAccessOptions | undefined,
): string {
  return createHash("sha256")
    .update(name)
    .update("\n")
    .update(canonicalJson(publicOptions(options, access)))
    .digest("hex");
}

/** `pages share --url <url> --with <with> --execute`: flag names, never values. */
function summarizeCommand(name: string, options: Record<string, unknown>, access: CommandAccessOptions | undefined) {
  const parts = [name.replace(/\./g, " ")];
  for (const [key, value] of Object.entries(publicOptions(options, access)).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined || value === null || value === false) continue;
    parts.push(value === true ? `--${key}` : `--${key} <${key}>`);
  }
  return parts.join(" ").slice(0, 300);
}

function publicOptions(
  options: Record<string, unknown>,
  access: CommandAccessOptions | undefined,
): Record<string, unknown> {
  const redacted = new Set(access?.redactions ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || redacted.has(key) || SECRET_OPTION.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
}

function approvalOutcome(result: { approved: boolean; reason?: string; messageId?: string }) {
  if (result.approved) return "approved" as const;
  // Undelivered cards and timeouts may be asked again; an answer is a denial.
  if (!result.messageId || result.reason?.startsWith("Timeout")) return "expired" as const;
  return "denied" as const;
}

function commandName(group: string, command: string): string {
  return `${group.trim().replace(/[\s_]+/g, ".")}.${command.trim()}`;
}

function deny(approvalId: string, issue: string): WriteAfterReadDecision {
  return { allowed: false, code: "KNOWLEDGE_WRITE_AFTER_READ", approvalId, issues: [issue] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
