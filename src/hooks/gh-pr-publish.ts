import {
  ensureGhWatchFollow,
  buildGhFollowTriggerInput,
  type GhWatchFollowContext,
  type GhWatchFollowDeps,
  type GhWatchFollowResult,
} from "./gh-watch.js";
import {
  githubClient,
  findPublicationPr,
  parseGithub,
  pullSchema,
  type GithubRequest,
  type PullRequest,
} from "../pr/github.js";
import { prError, type PublicationPhase } from "../pr/contracts.js";
import { requireFollowRuntime } from "../pr/follow-health.js";
import { dbGetTrigger } from "../triggers/index.js";
import { getWatch } from "../watch/watch-db.js";

export interface GhPrPublication {
  repo: string;
  head: string;
  base: string;
  sha: string;
  title?: string;
  body?: string;
  context: GhWatchFollowContext;
}
export type GhPublicationRequest = GithubRequest;
export const requestGhPublication = githubClient();
export interface GhPrPublicationDeps {
  request?: GithubRequest;
  follow?: GhWatchFollowDeps;
  beforeFollow?: () => void;
  afterFollow?: () => void;
  phase?: (phase: PublicationPhase) => void;
  onPr?: (pr: PullRequest) => void;
  verifyFollow?: (input: GhPrPublication, result: GhWatchFollowResult, prNumber: number) => Promise<void>;
}

function assertPublishedHead(pr: PullRequest, input: GhPrPublication): void {
  if (
    pr.state !== "open" ||
    pr.head.sha !== input.sha ||
    pr.head.ref !== input.head ||
    pr.head.repo.full_name.toLowerCase() !== input.repo.toLowerCase() ||
    pr.base.ref !== input.base ||
    pr.base.repo.full_name.toLowerCase() !== input.repo.toLowerCase() ||
    pr.html_url !== `https://github.com/${input.repo}/pull/${pr.number}`
  )
    throw prError(
      "PR_PUBLICATION_INCOMPLETE",
      "PR does not match the verified repository, branches and head SHA; publication incomplete",
    );
}

export async function verifyPublicationFollow(
  input: GhPrPublication,
  follow: GhWatchFollowResult,
  prNumber: number,
  deps: { watch?: typeof getWatch; trigger?: typeof dbGetTrigger; runtime?: typeof requireFollowRuntime } = {},
): Promise<void> {
  const watch = follow.ciWatchId ? (deps.watch ?? getWatch)(follow.ciWatchId) : null;
  const trigger = follow.triggerId ? (deps.trigger ?? dbGetTrigger)(follow.triggerId) : null;
  const desired = buildGhFollowTriggerInput(input.repo, prNumber, input.context);
  if (
    !watch ||
    watch.status !== "active" ||
    watch.placement !== "local" ||
    watch.provider !== "github" ||
    watch.resourceRef !== input.repo ||
    !watch.eventTypes.includes("workflow_run.completed") ||
    !trigger?.enabled ||
    ["topic", "filter", "agentId", "replySession", "replySource", "session", "accountId"].some(
      (key) =>
        JSON.stringify(trigger[key as keyof typeof trigger]) !== JSON.stringify(desired[key as keyof typeof desired]),
    )
  )
    throw prError(
      "PR_PUBLICATION_INCOMPLETE",
      "PR exists but CI follow is incomplete; rerun publication to reconcile.",
      { retryable: true },
    );
  await (deps.runtime ?? requireFollowRuntime)(trigger);
}

/** Shared final publication step. Retry repairs the same PR and the existing follow registry. */
export async function publishGhPr(input: GhPrPublication, deps: GhPrPublicationDeps = {}) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.repo) ||
    !/^[a-f0-9]{40}$/.test(input.sha) ||
    !input.head ||
    !input.base ||
    input.head === input.base
  )
    throw prError(
      "USAGE_ERROR",
      "Publication requires owner/repo, a full verified commit SHA and distinct branches.",
      {},
      2,
    );
  if (!input.context.agentId || !(input.context.sessionName || input.context.sessionKey))
    throw prError("PUBLICATION_SESSION_REQUIRED", "Publication requires the publishing Ravi agent and session");
  const request = deps.request ?? requestGhPublication;
  const root = `repos/${input.repo}`;
  const ref = (await request(`${root}/git/ref/heads/${encodeURIComponent(input.head)}`, "GET")) as {
    object?: { sha?: string };
  };
  if (ref.object?.sha !== input.sha)
    throw prError("REMOTE_REF_CHANGED", "Remote branch does not match the verified local commit SHA");
  deps.phase?.("pr");
  let pr = await findPublicationPr(request, input.repo, input.head, input.base);
  let reused = Boolean(pr);
  if (!pr) {
    if (!input.title?.trim() || !input.body?.trim())
      throw prError("USAGE_ERROR", "A new PR requires --title and --body-file.", {}, 2);
    try {
      pr = parseGithub(
        pullSchema,
        await request(`${root}/pulls`, "POST", {
          head: input.head,
          base: input.base,
          title: input.title,
          body: input.body,
          draft: false,
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["PUBLICATION_AUDIT_FAILED", "PERMISSION_DENIED"].includes(String(error.code))
      )
        throw error;
      // A timeout or a competing publisher may have created it. A 422 by itself is not success.
      pr = await findPublicationPr(request, input.repo, input.head, input.base);
      if (!pr) throw error;
      reused = true;
    }
  }
  assertPublishedHead(pr, input);
  deps.onPr?.(pr);
  deps.phase?.("follow");
  deps.beforeFollow?.();
  const follow = await ensureGhWatchFollow(
    { repo: input.repo, prNumber: pr.number, context: input.context, reconcile: true },
    { ...deps.follow, localOnly: true },
  );
  if (!follow.watchId || !follow.ciWatchId || !follow.triggerId)
    throw prError(
      "PR_PUBLICATION_INCOMPLETE",
      "PR exists but CI follow is incomplete; rerun publication to reconcile.",
      { retryable: true },
    );
  await (deps.verifyFollow ?? verifyPublicationFollow)(input, follow, pr.number);
  deps.afterFollow?.();
  if (pr.draft) {
    deps.phase?.("ready");
    const response = (await request("graphql", "POST", {
      query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
      variables: { id: pr.node_id },
    })) as { errors?: unknown[]; data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } } };
    if (response.errors?.length || response.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false)
      throw prError("PR_PUBLICATION_INCOMPLETE", "Could not mark the PR ready; rerun publication to reconcile.", {
        retryable: true,
      });
  }
  deps.phase?.("verify");
  const verified = parseGithub(pullSchema, await request(`${root}/pulls/${pr.number}`, "GET"));
  assertPublishedHead(verified, input);
  if (verified.draft)
    throw prError("PR_PUBLICATION_INCOMPLETE", "PR is still draft; publication incomplete.", { retryable: true });
  return { url: verified.html_url, number: verified.number, sha: input.sha, ready: true as const, reused, follow };
}
