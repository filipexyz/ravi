import { execFileSync } from "node:child_process";
import { ensureGhWatchFollow, type GhWatchFollowContext, type GhWatchFollowDeps } from "./gh-watch.js";

export interface GhPrPublication {
  repo: string;
  head: string;
  base: string;
  sha: string;
  title: string;
  body: string;
  context: GhWatchFollowContext;
}

interface PullRequest {
  number: number;
  node_id: string;
  html_url: string;
  state: string;
  draft: boolean;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string; repo: { full_name: string } };
}

export type GhPublicationRequest = (endpoint: string, method: string, body?: Record<string, unknown>) => unknown;

/** Use stdin for JSON: PR text must never become shell code or argv. */
export const requestGhPublication: GhPublicationRequest = (endpoint, method, body) => {
  const args = ["api", endpoint, "--method", method];
  if (body) args.push("--input", "-");
  return JSON.parse(
    execFileSync("gh", args, {
      input: body ? JSON.stringify(body) : undefined,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
};

function assertPublishedHead(pr: PullRequest, input: GhPrPublication): void {
  if (
    !Number.isSafeInteger(pr.number) ||
    pr.number <= 0 ||
    !pr.node_id ||
    pr.state !== "open" ||
    typeof pr.draft !== "boolean" ||
    pr.head?.sha !== input.sha ||
    pr.head?.ref !== input.head ||
    pr.head?.repo?.full_name !== input.repo ||
    pr.base?.ref !== input.base ||
    pr.base?.repo?.full_name !== input.repo ||
    pr.html_url !== `https://github.com/${input.repo}/pull/${pr.number}`
  ) {
    throw new Error("PR does not match the verified repository, branches and head SHA; publication incomplete");
  }
}

/**
 * Final step of Git Data API publication. Re-running also repairs a PR created
 * by the old ad-hoc path: same PR, same follow registry, current publishing session.
 * A partial failure is an error, never a successful unobserved publication.
 */
export async function publishGhPr(
  input: GhPrPublication,
  deps: { request?: GhPublicationRequest; follow?: GhWatchFollowDeps } = {},
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo) || !/^[a-f0-9]{40}$/.test(input.sha)) {
    throw new Error("Expected owner/repo and a full verified commit SHA");
  }
  if (!input.head || !input.base || input.head === input.base || !input.title.trim() || !input.body.trim()) {
    throw new Error("Publication requires distinct head/base branches, title and body");
  }
  if (!input.context.agentId || !(input.context.sessionName || input.context.sessionKey)) {
    throw new Error("Publication requires the publishing Ravi agent and session");
  }
  const request = deps.request ?? requestGhPublication;
  const root = `repos/${input.repo}`;
  const ref = request(`${root}/git/ref/heads/${input.head}`, "GET") as { object?: { sha?: string } };
  if (ref.object?.sha !== input.sha) throw new Error("Remote branch does not match the verified local commit SHA");

  const owner = input.repo.split("/")[0];
  const query = new URLSearchParams({ state: "open", head: `${owner}:${input.head}`, base: input.base });
  const existing = request(`${root}/pulls?${query}`, "GET") as PullRequest[];
  if (!Array.isArray(existing) || existing.length > 1) throw new Error("Ambiguous PR lookup; publication incomplete");
  const reused = existing.length === 1;
  const pr =
    existing[0] ??
    (request(`${root}/pulls`, "POST", {
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: false,
    }) as PullRequest);
  assertPublishedHead(pr, input);

  // This is the SAME primitive used by observeGhBashCommand, not a second ledger.
  const follow = await ensureGhWatchFollow(
    {
      repo: input.repo,
      prNumber: pr.number,
      context: input.context,
      reconcile: true,
    },
    deps.follow,
  );
  if (!follow.watchId || !follow.ciWatchId || !follow.triggerId) {
    throw new Error(`PR ${pr.html_url} exists but CI follow is incomplete; rerun publication to reconcile`);
  }

  if (pr.draft) {
    // Only the explicitly selected legacy PR is promoted. Never scan/promote other drafts.
    const response = request("graphql", "POST", {
      query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
      variables: { id: pr.node_id },
    }) as { errors?: unknown[]; data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } } } };
    if (response.errors?.length || response.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
      throw new Error(`Could not mark ${pr.html_url} ready; rerun publication to reconcile`);
    }
  }
  const verified = request(`${root}/pulls/${pr.number}`, "GET") as PullRequest;
  assertPublishedHead(verified, input);
  if (verified.draft) throw new Error(`PR ${pr.html_url} is still draft; publication incomplete`);
  return { url: verified.html_url, number: verified.number, sha: input.sha, ready: true, reused, follow };
}
