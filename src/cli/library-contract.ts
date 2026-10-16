/**
 * Contract helpers shared by the Library commands (`ravi skills ...` and
 * `ravi agents ...`): the runtime caller, the error envelope for Library,
 * package and Console failures, and what each Console `CONFLICT` reason means
 * for the command that got it.
 *
 * spec: skills/library, cli
 */

import { isCloudAuthError } from "../cloud-auth/errors.js";
import { readCloudCredentials } from "../cloud-auth/storage.js";
import { LibraryPackageError } from "../library/package.js";
import { LibraryCommandError, type LibraryCaller } from "../library/service.js";
import { CONTRACT_EXIT_USAGE, ContractError, contractFail, renderContractError } from "./agent-contract.js";
import { cloudErrorToContractError } from "./cloud-error-contract.js";
import { getContext, hasRuntimeInvocationContext } from "./context.js";

/**
 * The remote gateway client renders issues[] but replaces suggestedAction with
 * generic copy, so the remediation also travels as a trailing issue.
 */
export function skillContractIssues(
  path: string[],
  code: string,
  message: string,
  suggestedAction?: string,
): Array<{ path: string[]; code: string; message: string }> {
  return [
    { path, code, message },
    ...(suggestedAction ? [{ path: ["suggestedAction"], code: "SUGGESTED_ACTION", message: suggestedAction }] : []),
  ];
}

/** The agent of an agent runtime turn; null in the operator's terminal. */
export function runtimeLibraryCaller(): LibraryCaller | null {
  const agentId = hasRuntimeInvocationContext() ? getContext()?.agentId?.trim() : undefined;
  if (!agentId) return null;
  const capabilities = getContext()?.context?.capabilities;
  return { agentId, ...(capabilities ? { capabilities } : {}) };
}

/** The session of an agent runtime turn (key and name); null in the operator's terminal. */
export function runtimeLibrarySession(): { key: string | null; name: string | null } | null {
  if (!hasRuntimeInvocationContext()) return null;
  const context = getContext();
  const key = context?.sessionKey?.trim() || null;
  const name = context?.sessionName?.trim() || null;
  return key || name ? { key, name } : null;
}

export function hasCloudLogin(): boolean {
  try {
    return readCloudCredentials() !== null;
  } catch {
    return false;
  }
}

/** A policy refusal (exit 3) with the remediation also carried as an issue. */
export function failLibraryPolicy(
  op: string,
  code: string,
  message: string,
  suggestedAction: string,
  asJson?: boolean,
): never {
  contractFail(op, code, message, {
    asJson,
    exitCode: 3,
    details: { suggestedAction, issues: skillContractIssues([], code, message, suggestedAction) },
  });
}

/** Library, package and Console failures as contract errors, rendered once. */
export async function withLibraryContract<T>(
  op: string,
  asJson: boolean | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if (error instanceof LibraryCommandError) {
      const suggestedAction = typeof error.details.suggestedAction === "string" ? error.details.suggestedAction : "";
      contractFail(op, error.code, error.message, {
        asJson,
        exitCode: error.exitCode,
        details: {
          ...error.details,
          issues: skillContractIssues([], error.code, error.message, suggestedAction || undefined),
        },
      });
    }
    if (error instanceof LibraryPackageError) {
      const suggestedAction = "Fix the skill folder and run the same command again";
      contractFail(op, error.code, error.message, {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: {
          suggestedAction,
          issues: [...error.issues, { path: ["suggestedAction"], code: "SUGGESTED_ACTION", message: suggestedAction }],
        },
      });
    }
    if (isCloudAuthError(error)) {
      const base = cloudErrorToContractError(op, error);
      const reason = typeof error.details?.reason === "string" ? error.details.reason : undefined;
      const copy = error.code === "CONFLICT" && reason ? libraryConflictCopy(op, reason) : null;
      const contract = copy
        ? new ContractError(op, base.code, copy.message ?? base.message, base.exitCode, {
            ...base.details,
            // The envelope redacts `reason` as free text; `conflict` carries the code.
            reason,
            conflict: reason,
            ...(typeof error.details?.currentVersion === "number"
              ? { currentVersion: error.details.currentVersion }
              : {}),
            ...(typeof error.details?.baseVersion === "number" ? { baseVersion: error.details.baseVersion } : {}),
            ...(typeof error.details?.status === "string" ? { proposalStatus: error.details.status } : {}),
            suggestedAction: copy.suggestedAction,
          })
        : base;
      renderContractError(contract, asJson);
      throw contract;
    }
    throw error;
  }
}

/** What a Library `CONFLICT` (by `details.reason`) means for the command that got it. */
export function libraryConflictCopy(op: string, reason: string): { message?: string; suggestedAction: string } {
  const agents = op.startsWith("agents ");
  switch (reason) {
    case "stale_base":
      if (agents) {
        return {
          message: "Someone published a newer version of this Library agent after the plan was read.",
          suggestedAction:
            "Read it (ravi agents show <ref>), bring its changes into the agent's AGENTS.md, then run the same publish without --execute to see the new plan",
        };
      }
      return op === "skills propose"
        ? {
            message: "The published version changed after the plan was read.",
            suggestedAction:
              "Read the new version with 'ravi skills show <ref>', bring its changes into your folder, then run the same propose without --execute to see the new plan (with --update, add --rebase)",
          }
        : {
            message: "Someone published a newer version after the plan was read.",
            suggestedAction:
              "Someone published a newer version: run the same publish again without --execute to see the new plan",
          };
    case "unchanged":
      return agents
        ? {
            message: "The agent's files and description are exactly the published version.",
            suggestedAction: "Change AGENTS.md, HEARTBEAT.md or the description first: there is nothing to publish",
          }
        : {
            message: "The folder and its metadata are exactly the published version.",
            suggestedAction: "Change a file or the description first: there is nothing to propose",
          };
    case "slug_taken_in_org":
      return {
        message: `The organization already has a Library ${agents ? "agent" : "skill"} with this slug.`,
        suggestedAction: "Pick another slug with --slug, or use --scope org to change the organization's one",
      };
    case "slug_taken_in_project":
      return {
        message: `A project already has a Library ${agents ? "agent" : "skill"} with this slug.`,
        suggestedAction: "Pick another slug with --slug",
      };
    case "slug_reserved":
      return { message: "This slug is reserved.", suggestedAction: "Pick another slug with --slug" };
    case "proposal_closed":
      return {
        message: "The proposal is closed (published, rejected or withdrawn).",
        suggestedAction: "Open a new proposal: run the same command without --update",
      };
    case "not_published":
      return {
        message: "Only a published, non-archived Library skill can be pinned.",
        suggestedAction: "Publish a version first (ravi skills publish <dir> --scope <scope> --execute), then pin it",
      };
    case "agent_out_of_scope":
      return {
        message: "A project skill can only be pinned to an agent reported in that project.",
        suggestedAction:
          "Bind the agent to the skill's Console project (ravi cloud scope set --agent <agent> --project <project>), wait for the next pin sync, then pin again",
      };
    case "no_installation":
      return {
        message: agents
          ? "This login has no linked installation, so it cannot send or answer requests."
          : "This login has no linked installation, so it has no pins.",
        suggestedAction: "Run `ravi login` on this daemon so it links an installation, then run the same command again",
      };
    case "same_installation":
      return {
        message: "That agent runs on this same machine: ask it locally instead of through a request.",
        suggestedAction: 'Send it a message here: ravi sessions send <session> "<message>" -a <agent>',
      };
    case "not_accepting":
      return {
        message: "That agent is not taking requests from other machines.",
        suggestedAction:
          "Ask its operator to open it (ravi agents requests <agent> on --execute), or pick another agent",
      };
    case "too_many_open":
      return {
        message: "This machine already has the most open requests allowed.",
        suggestedAction:
          "Wait for answers, or cancel one: ravi agents requests list, then ravi agents requests cancel <id>",
      };
    case "not_pending":
      return {
        message: "The request is no longer waiting: it was answered, failed, expired or was cancelled.",
        suggestedAction: "See its state with: ravi agents requests list --all",
      };
    case "not_open":
      return {
        message: "The request is already closed.",
        suggestedAction: "See its state with: ravi agents requests list --received --all",
      };
    default:
      return { suggestedAction: "Run the same command without --execute to see the current plan" };
  }
}
