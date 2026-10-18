// Exit mapping for `ravi knowledge *` (contract §10.4, §10.6). Every exit-3
// envelope carries one English line in `issues[]` telling the agent what to
// do; `issues` survives the remote gateway's projection.

import { isCloudAuthError } from "../cloud-auth/errors.js";
import {
  CONTRACT_EXIT_ERROR,
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  ContractError,
  mapExecutionErrorToContractError,
  renderContractError,
} from "../cli/agent-contract.js";
import { cloudErrorToContractError } from "../cli/cloud-error-contract.js";
import { isConsoleUnavailable } from "./client.js";

export const KNOWLEDGE_EXIT_CODES: Readonly<Record<string, 1 | 2 | 3>> = Object.freeze({
  KNOWLEDGE_NOT_FOUND: 1,
  KNOWLEDGE_CONSOLE_UNAVAILABLE: 1,
  USAGE_ERROR: 2,
  PAYLOAD_INVALID: 2,
  KNOWLEDGE_EXPOSURE_UNSAFE: 3,
  KNOWLEDGE_TURN_NOT_OPERATOR: 3,
  KNOWLEDGE_DISABLED: 3,
  WRITE_REQUIRES_EXECUTE: 3,
  KNOWLEDGE_WRITE_AFTER_READ: 3,
});

/** The line an agent acts on, per code. */
export const KNOWLEDGE_ISSUE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  KNOWLEDGE_TURN_NOT_OPERATOR:
    "Knowledge only answers the operator in their own direct chat or terminal. Tell the person to ask in private.",
  KNOWLEDGE_DISABLED:
    "Knowledge is not enabled for this organization. Tell the operator an org owner or admin must enable it in the Console; do not retry.",
  KNOWLEDGE_NOT_FOUND:
    "This ref is missing or no longer visible. Search again with `ravi knowledge search` instead of retrying the ref.",
  KNOWLEDGE_CONSOLE_UNAVAILABLE:
    "The Console is unavailable for Knowledge right now. Use local results (`ravi knowledge search --local-only`) or retry later.",
  PAYLOAD_INVALID: "Fix the command input (ref syntax or flags) and run it again.",
});

/**
 * Maps any error of a Knowledge command to its contract error, renders it once
 * and throws it.
 */
export function knowledgeContractError(op: string, error: unknown, asJson: boolean): never {
  const contractError = toKnowledgeContractError(op, error);
  renderContractError(contractError, asJson);
  throw contractError;
}

export function toKnowledgeContractError(op: string, error: unknown): ContractError {
  if (error instanceof ContractError) return error;
  if (isCloudAuthError(error)) {
    const details = {
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(typeof error.details?.reason === "string" ? { reason: error.details.reason } : {}),
    };
    switch (error.code) {
      case "KNOWLEDGE_TURN_NOT_OPERATOR":
      case "KNOWLEDGE_DISABLED":
        return new ContractError(op, error.code, policyMessage(error.code), CONTRACT_EXIT_POLICY, {
          ...details,
          retryable: false,
          issues: [KNOWLEDGE_ISSUE_TEXT[error.code] as string],
        });
      case "PAYLOAD_INVALID": {
        const message = error.message?.trim() || "Knowledge request input was invalid.";
        return new ContractError(op, "PAYLOAD_INVALID", message, CONTRACT_EXIT_USAGE, {
          ...details,
          retryable: false,
          issues: [message, KNOWLEDGE_ISSUE_TEXT.PAYLOAD_INVALID as string],
        });
      }
      case "NOT_FOUND":
        return new ContractError(op, "KNOWLEDGE_NOT_FOUND", "Knowledge ref was not found.", CONTRACT_EXIT_ERROR, {
          ...details,
          retryable: false,
          issues: [KNOWLEDGE_ISSUE_TEXT.KNOWLEDGE_NOT_FOUND as string],
        });
      default:
        break;
    }
    if (isConsoleUnavailable(error)) {
      return new ContractError(
        op,
        "KNOWLEDGE_CONSOLE_UNAVAILABLE",
        `The Console is unavailable for Knowledge (${error.code}).`,
        CONTRACT_EXIT_ERROR,
        {
          ...details,
          cause: error.code,
          retryable: error.code !== "KNOWLEDGE_UNAVAILABLE",
          issues: [KNOWLEDGE_ISSUE_TEXT.KNOWLEDGE_CONSOLE_UNAVAILABLE as string],
        },
      );
    }
    return cloudErrorToContractError(op, error);
  }
  return mapExecutionErrorToContractError(op, error);
}

function policyMessage(code: "KNOWLEDGE_TURN_NOT_OPERATOR" | "KNOWLEDGE_DISABLED"): string {
  return code === "KNOWLEDGE_TURN_NOT_OPERATOR"
    ? "Knowledge answers only the operator's own turns: the terminal, the operator's direct chat and the operator's routines."
    : "Knowledge is not enabled for this organization.";
}
