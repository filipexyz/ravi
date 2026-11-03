import { z } from "zod";
import { ContractError } from "../cli/agent-contract.js";

export const SHA = /^[a-f0-9]{40}$/;
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const LIMITS = { commits: 100, objects: 5000, bytes: 50 * 1024 * 1024, blobBytes: 8 * 1024 * 1024 };
export const PUBLICATION_TIMEOUT_MS = 180_000;
const sha = z.string().regex(SHA);
const repo = z.string().max(200).regex(REPO);
const branch = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s\x00-\x1f~^:?*[\\]+$/);
export const phaseSchema = z.enum(["preflight", "objects", "ref", "pr", "follow", "ready", "verify", "complete"]);
export type PublicationPhase = z.infer<typeof phaseSchema>;
export const planSchema = z.object({
  repo,
  base: branch,
  head: branch,
  localSha: sha,
  treeSha: sha,
  remoteSha: sha.nullable(),
  commitCount: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  uploadBytes: z.number().int().nonnegative(),
  refAction: z.enum(["create", "advance", "reuse"]),
  prAction: z.enum(["create", "reuse", "ready"]),
  prNumber: z.number().int().positive().nullable(),
  replySession: z.string().min(1).max(255),
  followAction: z.literal("reconcile"),
});
export type PublicationPlan = z.infer<typeof planSchema>;
export const resultSchema = z.object({
  publicationId: z.string(),
  attemptId: z.string(),
  repo,
  base: branch,
  head: branch,
  localSha: sha,
  remoteSha: sha,
  treeSha: sha,
  pr: z.object({
    number: z.number().int().positive(),
    url: z.string().url(),
    reused: z.boolean(),
    ready: z.literal(true),
  }),
  follow: z.object({
    watchId: z.string(),
    ciWatchId: z.string(),
    triggerId: z.string(),
    replySession: z.string(),
    verifiedAt: z.string(),
  }),
  checks: z.object({ state: z.enum(["pending", "success", "failure"]), count: z.number().int().nonnegative() }),
});
export const partialSchema = z.object({
  publicationId: z
    .string()
    .regex(/^prpub_[a-f0-9]{24}$/)
    .optional(),
  attemptId: z.string().uuid().optional(),
  phase: phaseSchema,
  repo,
  head: branch,
  localSha: sha,
  refPublished: z.boolean(),
  prNumber: z.number().int().positive().nullable(),
  uncertain: z.boolean(),
});

export function prError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  exitCode = 1,
): ContractError {
  return new ContractError("pr publish", code, message, exitCode, {
    retryable: false,
    suggestedAction: "Correct the reported condition and rerun ravi pr publish with the same expected SHA.",
    ...details,
  });
}

export function publicationRecoveryAction(code: string): string {
  switch (code) {
    case "GIT_OBJECT_MISMATCH":
      return "Compare local and remote object hashes; never accept a replacement SHA or move the ref.";
    case "NON_FAST_FORWARD":
    case "REMOTE_REF_CHANGED":
      return "Integrate the remote work explicitly or choose another work branch; publication never forces a ref.";
    case "FOLLOW_RUNTIME_UNAVAILABLE":
      return "Update/start the normal Ravi runtime, then rerun publication with the same expected SHA.";
    case "PR_PUBLICATION_INCOMPLETE":
    case "PUBLICATION_TIMEOUT":
    case "PUBLICATION_AUDIT_FAILED":
      return "Inspect partial publication state and rerun the same publication with --expect-sha to reconcile.";
    case "WORKTREE_DIRTY":
      return "Commit the intended changes before publishing the branch.";
    case "PR_CONFLICT":
      return "Resolve the existing PR explicitly or choose another branch; no automatic retarget or reopen.";
    default:
      return "Inspect ravi pr publish --help and correct the reported condition before retrying.";
  }
}

/** This is the complete allowlist for remote plans/partial failures, never a payload passthrough. */
export function projectPublicationDetails(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const plan = planSchema.safeParse(value.plan);
  if (plan.success) result.plan = plan.data;
  const partial = partialSchema.safeParse(value.partial);
  if (partial.success) result.partial = partial.data;
  for (const key of ["expectedSha", "actualSha"])
    if (typeof value[key] === "string" && SHA.test(value[key] as string)) result[key] = value[key];
  if (["blob", "tree", "commit"].includes(String(value.objectType))) result.objectType = value.objectType;
  return result;
}
