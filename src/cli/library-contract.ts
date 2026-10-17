/**
 * Contract helpers shared by the Library commands (`ravi skills`, `ravi
 * agents`, `ravi themes`, `ravi widgets`): the runtime caller, the error
 * envelope for Library, package, diagnostics and Console failures, what each
 * Console `CONFLICT` reason means for the command that got it, and, for themes
 * and widgets, diagnostics output, proposal text, return schemas and the
 * command bodies the two groups share. Kept out of `src/cli/commands/`
 * because every file there is re-exported by the generated barrel.
 *
 * spec: skills/library, cli
 */

import { z } from "zod";

import { isCloudAuthError } from "../cloud-auth/errors.js";
import { readCloudCredentials } from "../cloud-auth/storage.js";
import {
  countErrors,
  diagnosticIssue,
  diagnosticLine,
  LibraryDiagnosticsError,
  normalizeDiagnostics,
  ThemeCheckFailed,
  type LibraryDiagnostic,
} from "../library/diagnostics.js";
import {
  isReservedPresentationSlug,
  LIBRARY_KIND_PROFILES,
  type LibraryKindProfile,
  type PresentationKind,
} from "../library/kinds.js";
import { LibraryPackageError } from "../library/package.js";
import { searchPresentationItems, showPresentationItem } from "../library/presentation.js";
import { isLibrarySlug, looksLikeLibraryRef, parseLibraryRef } from "../library/refs.js";
import {
  executeLibraryProposal,
  executeLibraryPublish,
  LIBRARY_AGENT_CANNOT_PUBLISH,
  LibraryCommandError,
  listLibraryProposals,
  prepareLibraryProposal,
  prepareLibraryPublish,
  showLibraryProposal,
  type LibraryCaller,
  type LibraryProposalState,
} from "../library/service.js";
import type { LibraryContrastReport, LibraryProposal, LibraryProposalComment } from "../library/types.js";
import {
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  ContractError,
  contractDryRun,
  contractFail,
  renderContractError,
} from "./agent-contract.js";
import { resolveCallerPath } from "./caller-cwd.js";
import { cloudErrorToContractError } from "./cloud-error-contract.js";
import {
  libraryItemReturnSchema,
  libraryProposalReturnSchema,
  skillsProposalReturnSchema,
  skillsProposalsReturnSchema,
} from "./commands/operational-return-schemas.js";
import { getContext, hasRuntimeInvocationContext } from "./context.js";

export type PresentationProfile = LibraryKindProfile & { kind: PresentationKind };

export function presentationProfile(kind: PresentationKind): PresentationProfile {
  return LIBRARY_KIND_PROFILES[kind] as PresentationProfile;
}

export const LIBRARY_AGENT_CANNOT_SET_THEME = "LIBRARY_AGENT_CANNOT_SET_THEME";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function outputSuppressed(): boolean {
  return getContext({ localOnly: true })?.suppressCliOutput === true;
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

/**
 * The remote gateway client renders issues[] but replaces suggestedAction with
 * generic copy, so the remediation also travels as a trailing issue.
 */
export function libraryContractIssues(
  path: Array<string | number>,
  code: string,
  message: string,
  suggestedAction?: string,
): Array<{ path: Array<string | number>; code: string; message: string }> {
  return [
    { path, code, message },
    ...(suggestedAction ? [{ path: ["suggestedAction"], code: "SUGGESTED_ACTION", message: suggestedAction }] : []),
  ];
}

/** The name `ravi skills` and `ravi agents` use for `libraryContractIssues`. */
export const skillContractIssues = libraryContractIssues;

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
    exitCode: CONTRACT_EXIT_POLICY,
    details: { suggestedAction, issues: libraryContractIssues([], code, message, suggestedAction) },
  });
}

/** A usage error (exit 2) with its remediation as a trailing issue. */
export function failLibraryUsage(
  op: string,
  message: string,
  suggestedAction: string,
  asJson: boolean | undefined,
  path: Array<string | number> = [],
): never {
  contractFail(op, "USAGE_ERROR", message, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: { suggestedAction, issues: libraryContractIssues(path, "USAGE_ERROR", message, suggestedAction) },
  });
}

/**
 * Agents never publish (nor set the active theme): a person reviews what
 * they propose. Refused before any request, like `ravi skills publish`.
 */
export function refuseAgentWrite(
  op: string,
  code: string,
  message: string,
  suggestedAction: string,
  asJson: boolean | undefined,
): void {
  if (!runtimeLibraryCaller()) return;
  failLibraryPolicy(op, code, message, suggestedAction, asJson);
}

// ---------------------------------------------------------------------------
// Diagnostics

/** The code a check with errors fails with (exit 2). */
export function invalidCode(profile: PresentationProfile): string {
  return profile.kind === "theme" ? "THEME_INVALID" : "WIDGET_INVALID";
}

function contrastLine(check: LibraryContrastReport["checks"][number]): string {
  const [fg, bg] = check.pair;
  return `contrast ${check.mode} ${fg} on ${bg} ${check.ratio.toFixed(2)}:1 (min ${check.min}:1)`;
}

/**
 * Fail with the Console's diagnostics: text mode prints one
 * `file:line:column severity code message` line each on stderr; JSON carries
 * them as contract issues (exit 2).
 */
export function failDiagnostics(
  op: string,
  code: string,
  profile: PresentationProfile,
  diagnostics: readonly LibraryDiagnostic[],
  asJson: boolean | undefined,
  options: { headline?: string; contrast?: LibraryContrastReport | null } = {},
): never {
  const errors = countErrors(diagnostics);
  const headline =
    options.headline ?? `The ${profile.noun} has ${errors} error${errors === 1 ? "" : "s"}: nothing was saved.`;
  const suggestedAction = `Fix the lines above in the ${profile.noun} folder, then run: ravi ${profile.group} check <dir>`;
  const failedContrast = options.contrast?.checks.filter((check) => !check.ok) ?? [];
  const contract = new ContractError(op, code, headline, CONTRACT_EXIT_USAGE, {
    errors,
    warnings: diagnostics.length - errors,
    ...(failedContrast.length > 0 ? { contrast: { ok: false, failed: failedContrast } } : {}),
    suggestedAction,
    issues: [
      ...diagnostics.map(diagnosticIssue),
      { path: ["suggestedAction"], code: "SUGGESTED_ACTION", message: suggestedAction },
    ],
  });
  if (asJson) {
    renderContractError(contract, true);
  } else if (!outputSuppressed()) {
    for (const diagnostic of diagnostics) console.error(diagnosticLine(diagnostic));
    for (const check of failedContrast) console.error(contrastLine(check));
    console.error(headline);
  }
  throw contract;
}

export function printDiagnostics(diagnostics: readonly LibraryDiagnostic[]): void {
  for (const diagnostic of diagnostics) console.log(diagnosticLine(diagnostic));
}

// ---------------------------------------------------------------------------
// Error mapping

/**
 * Library, package, diagnostics and Console failures as contract errors,
 * rendered once. `profile` is the theme or widget kind of `ravi themes` and
 * `ravi widgets`; skills and agents leave it out.
 */
export async function withLibraryContract<T>(
  op: string,
  asJson: boolean | undefined,
  run: () => Promise<T>,
  profile?: PresentationProfile,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if (error instanceof LibraryDiagnosticsError && profile) {
      failDiagnostics(op, invalidCode(profile), profile, error.diagnostics, asJson, {
        contrast: error instanceof ThemeCheckFailed ? error.contrast : null,
      });
    }
    if (error instanceof LibraryCommandError) {
      const suggestedAction = typeof error.details.suggestedAction === "string" ? error.details.suggestedAction : "";
      contractFail(op, error.code, error.message, {
        asJson,
        exitCode: error.exitCode,
        details: {
          ...error.details,
          issues: libraryContractIssues([], error.code, error.message, suggestedAction || undefined),
        },
      });
    }
    if (error instanceof LibraryPackageError) {
      const suggestedAction = `Fix the ${profile?.noun ?? "skill"} folder and run the same command again`;
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
      // A publish or proposal the Console's compiler rejected: its diagnostics, exit 2.
      const rejected = error.code === "PAYLOAD_INVALID" ? normalizeDiagnostics(error.details?.diagnostics) : [];
      if (profile && rejected.length > 0) failDiagnostics(op, invalidCode(profile), profile, rejected, asJson);
      const base = cloudErrorToContractError(op, error);
      const reason = typeof error.details?.reason === "string" ? error.details.reason : undefined;
      const copy = error.code === "CONFLICT" && reason ? libraryConflictCopy(op, reason, profile) : null;
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

/** `withLibraryContract` for `ravi themes` and `ravi widgets`: diagnostics and copy in the kind's words. */
export function withPresentationContract<T>(
  op: string,
  profile: PresentationProfile,
  asJson: boolean | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return withLibraryContract(op, asJson, run, profile);
}

/** What a Library `CONFLICT` (by `details.reason`) means for the command that got it. */
export function libraryConflictCopy(
  op: string,
  reason: string,
  profile?: PresentationProfile,
): { message?: string; suggestedAction: string } {
  const agents = !profile && op.startsWith("agents ");
  const noun = profile?.noun ?? (agents ? "agent" : "skill");
  const group = profile?.group ?? "skills";
  switch (reason) {
    case "stale_base":
      if (agents) {
        return {
          message: "Someone published a newer version of this Library agent after the plan was read.",
          suggestedAction:
            "Read it (ravi agents show <ref>), bring its changes into the agent's AGENTS.md, then run the same publish without --execute to see the new plan",
        };
      }
      return op.endsWith(" propose")
        ? {
            message: "The published version changed after the plan was read.",
            suggestedAction: `Read the new version with 'ravi ${group} show <ref>', bring its changes into your folder, then run the same propose without --execute to see the new plan (with --update, add --rebase)`,
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
        message: `The organization already has a Library ${noun} with this slug.`,
        suggestedAction: profile
          ? `Pick another slug with --slug, or use --scope org to change the organization's ${noun}`
          : "Pick another slug with --slug, or use --scope org to change the organization's one",
      };
    case "slug_taken_in_project":
      return {
        message: `A project already has a Library ${noun} with this slug.`,
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

export function failLibraryRefInvalid(
  op: string,
  value: string,
  profile: PresentationProfile,
  asJson?: boolean,
): never {
  const message = `Not a valid Library ref: ${value.slice(0, 120)}. Use org/<slug> or <project>/<slug> (a-z, 0-9 and -).`;
  const suggestedAction = `Copy the ref from: ravi ${profile.group} search <words> --json`;
  contractFail(op, "LIBRARY_REF_INVALID", message, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: {
      suggestedAction,
      issues: libraryContractIssues([profile.noun], "LIBRARY_REF_INVALID", message, suggestedAction),
    },
  });
}

// ---------------------------------------------------------------------------
// Proposal text

/** "agent X for Y", or the member's name. */
export function proposalAuthorLabel(author: LibraryProposal["author"]): string {
  const name = author.name ?? (author.self ? "you" : "a member");
  return author.agentId
    ? `agent ${author.agentId} for ${name}`
    : `${name}${author.self && author.name ? " (you)" : ""}`;
}

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

const PROPOSAL_STATUS_COPY: Record<string, string> = {
  draft: "draft, not submitted",
  proposed: "waiting for review",
  published: "published",
  superseded: "published, since superseded",
  rejected: "rejected",
  withdrawn: "withdrawn",
};

/** The text form of `<group> proposal`: what an author needs to answer the review. */
export function proposalShowLines(
  profile: PresentationProfile,
  view: {
    ref: string;
    proposal: LibraryProposal;
    files: Array<{ path: string; bytes: number }>;
    base: { number: number } | null;
    comments: LibraryProposalComment[];
  },
): string[] {
  const { proposal } = view;
  const lines = [
    `${view.ref} proposal ${proposal.number}: ${proposal.status} (${PROPOSAL_STATUS_COPY[proposal.status] ?? proposal.status}), round ${proposal.round}`,
    `Author: ${proposalAuthorLabel(proposal.author)}`,
    `Base version: ${proposal.baseVersion || `none (new ${profile.noun})`} · published now: ${proposal.currentVersion || "none"}${proposal.publishedVersion ? ` · published as version ${proposal.publishedVersion}` : ""}`,
  ];
  if (proposal.stale) {
    lines.push(
      `Stale: version ${proposal.currentVersion} was published after this proposal was written. Read it (ravi ${profile.group} show ${view.ref}), bring its changes into your folder, then update with --update ${proposal.number} --rebase.`,
    );
  }
  if (proposal.note) lines.push(`Note: ${proposal.note}`);
  if (proposal.reviewUrl) lines.push(`Review: ${proposal.reviewUrl}`);
  if (proposal.decisionReason || proposal.decidedBy) {
    lines.push(
      `Decision: ${proposal.status}${proposal.decidedBy?.name ? ` by ${proposal.decidedBy.name}` : ""}${proposal.decisionReason ? `: ${proposal.decisionReason}` : ""}`,
    );
  }
  lines.push(`Files (${view.files.length}, ${formatBytes(proposal.totalBytes)}):`);
  for (const file of view.files) lines.push(`  ${file.path}  ${formatBytes(file.bytes)}`);
  const topLevel = view.comments.filter((comment) => !comment.parentId);
  const open = topLevel.filter((comment) => !comment.resolvedAt).length;
  lines.push(view.comments.length === 0 ? "Comments: none" : `Comments (${open} open):`);
  for (const comment of topLevel) {
    lines.push(`  ${commentLine(comment)}`);
    for (const reply of view.comments.filter((entry) => entry.parentId === comment.id)) {
      lines.push(`    ↳ ${commentLine(reply)}`);
    }
  }
  if (proposal.can.edit) {
    lines.push(
      `Answer the review by updating it: ravi ${profile.group} propose <dir> --scope ${view.ref.split("/")[0]} --update ${proposal.number} --execute`,
    );
  }
  return lines;
}

function commentLine(comment: LibraryProposalComment): string {
  const where = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""} ` : "";
  const marks = [comment.outdated ? `[outdated, round ${comment.round}]` : "", comment.resolvedAt ? "[resolved]" : ""]
    .filter(Boolean)
    .join(" ");
  const body = comment.body.replace(/\s+/g, " ").trim();
  return `${where}${marks ? `${marks} ` : ""}${proposalAuthorLabel(comment.author)}: ${body}`;
}

// ---------------------------------------------------------------------------
// Return schemas

export const libraryDiagnosticReturnSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string(),
    message: z.string(),
    file: z.string().nullable(),
    line: z.number().nullable(),
    column: z.number().nullable(),
  })
  .strict();

export const presentationSearchReturnSchema = z
  .object({
    query: z.string(),
    project: z.string().nullable(),
    total: z.number(),
    items: z.array(
      z
        .object({
          ref: z.string(),
          scope: z.enum(["org", "project"]),
          project: z.string().nullable(),
          name: z.string(),
          description: z.string(),
          version: z.number(),
          next: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export const presentationShowReturnSchema = z
  .object({
    ref: z.string(),
    kind: z.enum(["theme", "widget"]),
    version: z.number(),
    note: z.string().nullable(),
    contentHash: z.string(),
    publishedAt: z.string().nullable(),
    item: libraryItemReturnSchema,
    files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string(), content: z.string() }).strict()),
  })
  .strict();

export const presentationInitReturnSchema = z
  .object({
    success: z.literal(true),
    kind: z.enum(["theme", "widget"]),
    dir: z.string(),
    slug: z.string().nullable(),
    files: z.array(z.object({ file: z.string(), bytes: z.number(), overwritten: z.boolean() }).strict()),
    diagnostics: z.array(libraryDiagnosticReturnSchema),
    next: z.string(),
  })
  .strict();

export const presentationPublishReturnSchema = z
  .object({
    success: z.literal(true),
    ref: z.string(),
    version: z.number(),
    contentHash: z.string(),
    unchanged: z.boolean(),
    item: libraryItemReturnSchema,
    diagnostics: z.array(libraryDiagnosticReturnSchema),
  })
  .strict();

export const presentationProposeReturnSchema = z
  .object({
    success: z.literal(true),
    ref: z.string(),
    number: z.number(),
    status: libraryProposalReturnSchema.shape.status,
    round: z.number(),
    baseVersion: z.number(),
    currentVersion: z.number(),
    stale: z.boolean(),
    created: z.boolean(),
    next: z.string(),
    proposal: libraryProposalReturnSchema,
    diagnostics: z.array(libraryDiagnosticReturnSchema),
  })
  .strict();

/** `proposals` and `proposal` answer the same shapes as `ravi skills`. */
export const presentationProposalsReturnSchema = skillsProposalsReturnSchema;
export const presentationProposalReturnSchema = skillsProposalReturnSchema;

const fileSizeReturnSchema = z.object({ file: z.string(), bytes: z.number() }).strict();

export const themeCheckReturnSchema = z
  .object({
    kind: z.literal("theme"),
    ok: z.boolean(),
    files: z.array(fileSizeReturnSchema),
    diagnostics: z.array(libraryDiagnosticReturnSchema),
    contrast: z
      .object({
        ok: z.boolean(),
        checks: z.array(
          z
            .object({
              mode: z.enum(["light", "dark"]),
              pair: z.array(z.string()),
              ratio: z.number(),
              min: z.number(),
              ok: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    css: z.string().nullable(),
  })
  .strict();

const widgetFieldReturnSchema = z
  .object({
    type: z.string(),
    role: z.string().nullable(),
    required: z.boolean(),
    label: z.string().nullable(),
    description: z.string().nullable(),
  })
  .strict();

export const widgetCheckReturnSchema = z
  .object({
    kind: z.literal("widget"),
    ok: z.boolean(),
    files: z.array(fileSizeReturnSchema),
    diagnostics: z.array(libraryDiagnosticReturnSchema),
    widget: z
      .object({
        name: z.string(),
        description: z.string(),
        fields: z.record(z.string(), widgetFieldReturnSchema),
        variants: z.array(z.string()),
        actions: z.number(),
        hash: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const widgetPreviewReturnSchema = z
  .object({
    success: z.literal(true),
    out: z.string(),
    bytes: z.number(),
    diagnostics: z.array(libraryDiagnosticReturnSchema),
  })
  .strict();

export const widgetCatalogReturnSchema = z
  .object({
    project: z.string().nullable(),
    text: z.string(),
    widgets: z.array(
      z
        .object({
          ref: z.string(),
          name: z.string(),
          description: z.string(),
          fields: z.record(z.string(), widgetFieldReturnSchema),
          variants: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

const themePointerReturnSchema = z
  .object({
    ref: z.string(),
    itemId: z.string(),
    scope: z.enum(["org", "project"]),
    slug: z.string(),
    name: z.string(),
    setAt: z.string().nullable(),
    setBy: z.string().nullable(),
  })
  .strict();

export const themeActiveReturnSchema = z
  .object({
    projectRef: z.string().nullable(),
    org: themePointerReturnSchema.nullable(),
    project: themePointerReturnSchema.nullable(),
    effective: themePointerReturnSchema
      .extend({ version: z.number(), hash: z.string(), source: z.enum(["project", "org"]) })
      .strict()
      .nullable(),
    warnings: z.array(z.string()),
  })
  .strict();

export const themeUseReturnSchema = z
  .object({
    success: z.literal(true),
    applied: z.boolean(),
    unchanged: z.boolean(),
    plan: z
      .object({
        scope: z.enum(["org", "project"]),
        project: z.object({ id: z.string(), slug: z.string(), name: z.string().nullable() }).strict().nullable(),
        from: themePointerReturnSchema.nullable(),
        to: themePointerReturnSchema.nullable(),
        affectedHosts: z.array(z.object({ siteSlug: z.string(), hostname: z.string(), routes: z.number() }).strict()),
      })
      .strict(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Command bodies shared by `ravi themes` and `ravi widgets`

export function parseSearchLimit(op: string, limit: string | undefined, asJson?: boolean): number | undefined {
  if (limit === undefined) return undefined;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    failLibraryUsage(op, "--limit must be a whole number from 1 to 50.", "Pass --limit between 1 and 50", asJson, [
      "limit",
    ]);
  }
  return parsed;
}

/** `<ref>` or a bare slug; `null` when the input is neither (the caller fails with LIBRARY_REF_INVALID). */
export function parseItemSelector(
  value: string,
): { ref: NonNullable<ReturnType<typeof parseLibraryRef>> } | { slug: string } | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (looksLikeLibraryRef(trimmed)) {
    const ref = parseLibraryRef(trimmed);
    return ref ? { ref } : null;
  }
  return isLibrarySlug(trimmed) ? { slug: trimmed } : null;
}

export async function runPresentationSearch(
  profile: PresentationProfile,
  input: { query?: string; limit?: string; project?: string; asJson?: boolean },
) {
  const op = `${profile.group} search`;
  const limit = parseSearchLimit(op, input.limit, input.asJson);
  const payload = await withPresentationContract(op, profile, input.asJson, () =>
    searchPresentationItems({
      kind: profile.kind,
      query: input.query?.trim() ?? "",
      ...(limit !== undefined ? { limit } : {}),
      project: input.project?.trim() || null,
      caller: runtimeLibraryCaller(),
    }),
  );
  if (input.asJson) {
    printJson(payload);
    return payload;
  }
  if (payload.items.length === 0) {
    console.log(payload.query ? `No ${profile.noun}s match "${payload.query}".` : `No ${profile.noun}s in this view.`);
  }
  for (const item of payload.items) {
    const description = item.description ? ` — ${item.description.split("\n")[0]}` : "";
    console.log(`${item.ref} [${item.scope} v${item.version}] ${item.name}${description}`);
    console.log(`  ${item.next}`);
  }
  return payload;
}

/** The command a reserved route word stands for, suggested when `show` gets it as a slug. */
const RESERVED_SHOW_HINTS: Readonly<Record<PresentationKind, Readonly<Record<string, string>>>> = {
  theme: {
    active: "ravi themes active",
    default: "ravi themes init <dir>",
    none: "ravi themes active",
    check: "ravi themes check <dir>",
    proposals: "ravi themes proposals",
  },
  widget: {
    catalog: "ravi widgets catalog",
    check: "ravi widgets check <dir>",
    preview: "ravi widgets preview <dir>",
    scaffold: "ravi widgets init <dir> --slug <slug>",
    proposals: "ravi widgets proposals",
    none: "ravi widgets search <words>",
  },
};

/** Files whose text `show` prints (a logo is listed, not printed). */
const SHOWN_TEXT_FILES = new Set([
  "theme.json",
  "fields.json",
  "README.md",
  "widget.json",
  "widget.html",
  "example.json",
]);

export async function runPresentationShow(
  profile: PresentationProfile,
  input: { ref: string; version?: string; project?: string; asJson?: boolean },
) {
  const op = `${profile.group} show`;
  const selector = parseItemSelector(input.ref);
  if (!selector) failLibraryRefInvalid(op, input.ref ?? "", profile, input.asJson);
  // A bare route word would reach another Console route (`themes/active`), never an item.
  if ("slug" in selector && isReservedPresentationSlug(profile.kind, selector.slug)) {
    failLibraryUsage(
      op,
      `"${selector.slug}" is a reserved word of ravi ${profile.group}, never a ${profile.noun} slug.`,
      `Use: ${RESERVED_SHOW_HINTS[profile.kind][selector.slug] ?? `ravi ${profile.group} search <words>`}`,
      input.asJson,
      ["ref"],
    );
  }
  const version = input.version === undefined ? undefined : Number(input.version);
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    failLibraryUsage(
      op,
      "--version takes a version number (1, 2, 3...).",
      "Drop --version to read the current one",
      input.asJson,
      ["version"],
    );
  }
  const outcome = await withPresentationContract(op, profile, input.asJson, () =>
    showPresentationItem({
      kind: profile.kind,
      ...selector,
      ...(version !== undefined ? { version } : {}),
      project: input.project?.trim() || null,
      caller: runtimeLibraryCaller(),
    }),
  );
  const payload = {
    ref: outcome.ref.ref,
    kind: profile.kind,
    version: outcome.version.number,
    note: outcome.version.note,
    contentHash: outcome.version.contentHash,
    publishedAt: outcome.version.publishedAt,
    item: outcome.item,
    files: outcome.version.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      content: file.content,
    })),
  };
  if (input.asJson) {
    printJson(payload);
    return payload;
  }
  console.log(`${payload.ref} v${payload.version} — ${outcome.item.name}`);
  if (outcome.item.description) console.log(`  ${outcome.item.description.split("\n")[0]}`);
  if (outcome.item.archived) console.log("  Archived: pages keep the versions they shipped with.");
  if (payload.note) console.log(`  Note: ${payload.note}`);
  console.log(`Files (${payload.files.length}):`);
  for (const file of payload.files) console.log(`  ${file.path}  ${formatBytes(file.bytes)}`);
  for (const file of payload.files.filter((entry) => SHOWN_TEXT_FILES.has(entry.path))) {
    console.log(`\n--- ${file.path} ---`);
    console.log(file.content.trimEnd());
  }
  return payload;
}

export interface PublishCommandInput {
  dir: string;
  scope?: string;
  slug?: string;
  name?: string;
  note?: string;
  asJson?: boolean;
  execute?: boolean;
}

export async function runPresentationPublish(profile: PresentationProfile, input: PublishCommandInput) {
  const op = `${profile.group} publish`;
  const scopeHint = input.scope?.trim() ? input.scope.trim().toLowerCase() : "org|<project-slug>";
  refuseAgentWrite(
    op,
    LIBRARY_AGENT_CANNOT_PUBLISH,
    `Agents do not publish Library ${profile.noun}s: propose the change and a person reviews and publishes it in the Console.`,
    `ravi ${profile.group} propose <dir> --scope ${scopeHint} --execute`,
    input.asJson,
  );
  return withPresentationContract(op, profile, input.asJson, async () => {
    const prepared = await prepareLibraryPublish({
      kind: profile.kind,
      dir: resolveCallerPath(input.dir ?? ""),
      ...(input.scope?.trim() ? { scope: input.scope } : {}),
      ...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    if (!input.execute) contractDryRun(op, { ...prepared.plan }, { asJson: input.asJson });
    const result = await executeLibraryPublish(prepared);
    const payload = {
      success: true as const,
      ref: result.ref,
      version: result.version.number,
      contentHash: result.version.contentHash,
      unchanged: result.unchanged,
      item: result.item,
      diagnostics: result.diagnostics ?? [],
    };
    if (input.asJson) {
      printJson(payload);
      return payload;
    }
    printDiagnostics(payload.diagnostics);
    if (result.unchanged) {
      console.log(`= ${result.ref} unchanged (version ${result.version.number} already has this content)`);
    } else {
      console.log(`✓ Published ${result.ref} version ${result.version.number}`);
      console.log(
        profile.kind === "theme"
          ? `  Make it the active theme with: ravi themes use ${result.ref} --execute`
          : `  Pages use it with <ravi-widget use="${result.ref}"> or <ravi-view widget="${result.ref}">; agents find it with: ravi widgets catalog`,
      );
    }
    return payload;
  });
}

export interface ProposeCommandInput extends PublishCommandInput {
  draft?: boolean;
  update?: string;
  rebase?: boolean;
}

export async function runPresentationPropose(profile: PresentationProfile, input: ProposeCommandInput) {
  const op = `${profile.group} propose`;
  const updateNumber = input.update === undefined ? undefined : Number(input.update);
  if (updateNumber !== undefined && (!Number.isInteger(updateNumber) || updateNumber < 1)) {
    failLibraryUsage(
      op,
      "--update takes a proposal number (1, 2, 3...).",
      `List your proposals with: ravi ${profile.group} proposals --mine`,
      input.asJson,
      ["update"],
    );
  }
  return withPresentationContract(op, profile, input.asJson, async () => {
    const prepared = await prepareLibraryProposal({
      kind: profile.kind,
      dir: resolveCallerPath(input.dir ?? ""),
      ...(input.scope?.trim() ? { scope: input.scope } : {}),
      ...(input.slug?.trim() ? { slug: input.slug.trim() } : {}),
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      draft: input.draft === true,
      ...(updateNumber !== undefined ? { update: updateNumber } : {}),
      rebase: input.rebase === true,
      caller: runtimeLibraryCaller(),
    });
    if (!input.execute) contractDryRun(op, { ...prepared.plan }, { asJson: input.asJson });
    const result = await executeLibraryProposal(prepared);
    const { proposal } = result;
    const next = `ravi ${profile.group} proposal ${result.ref} ${proposal.number}`;
    const payload = {
      success: true as const,
      ref: result.ref,
      number: proposal.number,
      status: proposal.status,
      round: proposal.round,
      baseVersion: proposal.baseVersion,
      currentVersion: proposal.currentVersion,
      stale: proposal.stale,
      created: result.created,
      next,
      proposal,
      diagnostics: result.diagnostics,
    };
    if (input.asJson) {
      printJson(payload);
      return payload;
    }
    printDiagnostics(payload.diagnostics);
    const label = `${result.ref} (proposal ${proposal.number}${result.created ? "" : `, round ${proposal.round}`})`;
    if (proposal.status === "draft") {
      console.log(`✓ Saved draft ${label}; only you and the scope's reviewers see it`);
    } else {
      console.log(`✓ ${result.created ? "Proposed" : "Updated"} ${label}, waiting for review`);
    }
    if (proposal.stale) {
      console.log(
        `  Stale: written against version ${proposal.baseVersion}, version ${proposal.currentVersion} is published. Read it, then run again with --update ${proposal.number} --rebase.`,
      );
    }
    if (proposal.reviewUrl) console.log(`  Review: ${proposal.reviewUrl}`);
    console.log(`  Follow it with: ${next}`);
    return payload;
  });
}

export async function runPresentationProposals(
  profile: PresentationProfile,
  input: { ref?: string; project?: string; state?: string; mine?: boolean; asJson?: boolean },
) {
  const op = `${profile.group} proposals`;
  const state = (input.state?.trim().toLowerCase() || "open") as LibraryProposalState;
  if (!["open", "closed", "all"].includes(state)) {
    failLibraryUsage(
      op,
      "--state is open, closed or all.",
      "Pass --state open, --state closed or --state all",
      input.asJson,
      ["state"],
    );
  }
  const parsedRef = input.ref?.trim() ? parseLibraryRef(input.ref) : null;
  if (input.ref?.trim() && !parsedRef) failLibraryRefInvalid(op, input.ref, profile, input.asJson);
  const outcome = await withPresentationContract(op, profile, input.asJson, () =>
    listLibraryProposals({
      kind: profile.kind,
      ...(parsedRef ? { ref: parsedRef } : {}),
      project: input.project?.trim() || null,
      state,
      mine: input.mine === true,
      caller: runtimeLibraryCaller(),
    }),
  );
  const payload = {
    ...outcome,
    proposals: outcome.proposals.map((entry) => ({
      ...entry,
      next: `ravi ${profile.group} proposal ${entry.ref} ${entry.number}`,
    })),
  };
  if (input.asJson) {
    printJson(payload);
    return payload;
  }
  if (payload.proposals.length === 0) {
    console.log(`No ${state === "all" ? "" : `${state} `}proposals${payload.ref ? ` for ${payload.ref}` : ""}.`);
  }
  for (const entry of payload.proposals) {
    const stale = entry.stale ? " [stale]" : "";
    const comments =
      entry.openComments > 0 ? ` — ${entry.openComments} open comment${entry.openComments === 1 ? "" : "s"}` : "";
    console.log(
      `${entry.ref} #${entry.number} ${entry.status}${stale} — ${proposalAuthorLabel(entry.author)}${comments}`,
    );
    console.log(`  ${entry.next}`);
  }
  return payload;
}

export async function runPresentationProposal(
  profile: PresentationProfile,
  input: { ref: string; number: string; asJson?: boolean },
) {
  const op = `${profile.group} proposal`;
  const parsedRef = parseLibraryRef(input.ref);
  if (!parsedRef) failLibraryRefInvalid(op, input.ref ?? "", profile, input.asJson);
  const parsedNumber = Number(input.number);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 1) {
    failLibraryUsage(
      op,
      "The proposal number is a whole number (1, 2, 3...).",
      `List them with: ravi ${profile.group} proposals ${parsedRef.ref}`,
      input.asJson,
      ["number"],
    );
  }
  const outcome = await withPresentationContract(op, profile, input.asJson, () =>
    showLibraryProposal({ kind: profile.kind, ref: parsedRef, number: parsedNumber, caller: runtimeLibraryCaller() }),
  );
  const { proposal } = outcome;
  const payload = {
    ref: outcome.ref.ref,
    number: proposal.number,
    item: outcome.item,
    proposal,
    files: outcome.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      ...(outcome.contentsVisible ? { content: file.content } : {}),
    })),
    base: outcome.base
      ? {
          number: outcome.base.number,
          files: outcome.base.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
        }
      : null,
    comments: outcome.comments,
    contentsVisible: outcome.contentsVisible,
  };
  if (input.asJson) {
    printJson(payload);
    return payload;
  }
  for (const line of proposalShowLines(profile, payload)) console.log(line);
  return payload;
}
