import { z } from "zod";
import { ContractError } from "../cli/agent-contract.js";
import { publishGhPr, type GhPrPublicationDeps } from "../hooks/gh-pr-publish.js";
import type { GhWatchFollowContext } from "../hooks/gh-watch.js";
import { planSchema, prError, REPO, SHA, type PublicationPhase } from "./contracts.js";
import { LocalGit, planObjects } from "./git.js";
import {
  commitSchema,
  findPublicationPr,
  GithubError,
  oidSchema,
  parseGithub,
  readRef,
  type GithubRequest,
} from "./github.js";
import { openPublicationJournal, type PublicationJournal } from "./journal.js";
import { resolvePublicationFollowContext } from "./context.js";

export interface PublicationInput {
  cwd: string;
  repo: string;
  base: string;
  title?: string;
  body?: string;
  expectSha?: string;
  context: GhWatchFollowContext;
}
export async function preparePublication(
  input: PublicationInput,
  request: GithubRequest,
  git = new LocalGit(input.cwd),
) {
  if (!REPO.test(input.repo) || !input.base || (input.expectSha !== undefined && !SHA.test(input.expectSha)))
    throw prError("USAGE_ERROR", "Provide --repo owner/repo, --base branch and optionally a full --expect-sha.", {}, 2);
  const followContext = resolvePublicationFollowContext(input.context);
  const snapshot = await git.snapshot(input.repo);
  await git.run(["check-ref-format", `refs/heads/${input.base}`]);
  if (input.expectSha && snapshot.sha !== input.expectSha)
    throw prError("LOCAL_HEAD_CHANGED", "Local HEAD differs from --expect-sha.", {
      expectedSha: input.expectSha,
      actualSha: snapshot.sha,
    });
  const metadata = parseGithub(
    z.object({ full_name: z.string().regex(REPO), default_branch: z.string() }),
    await request(`repos/${input.repo}`, "GET"),
  );
  if (metadata.full_name.toLowerCase() !== input.repo.toLowerCase())
    throw prError("REPOSITORY_MISMATCH", "GitHub resolved a different repository.");
  const repo = metadata.full_name;
  if (snapshot.head === input.base || snapshot.head === metadata.default_branch)
    throw prError("PROTECTED_PUBLICATION_HEAD", "Publish a work branch distinct from the base and default branch.");
  if (!(await readRef(request, repo, input.base)))
    throw prError("BASE_NOT_FOUND", "The requested base branch does not exist.");
  const remoteSha = await readRef(request, repo, snapshot.head);
  if (remoteSha && remoteSha !== snapshot.sha && !(await git.isAncestor(remoteSha, snapshot.sha)))
    throw prError(
      "NON_FAST_FORWARD",
      "The remote branch is not an ancestor of local HEAD. Integrate it or select another branch.",
    );
  const existing = await findPublicationPr(request, repo, snapshot.head, input.base);
  if (!existing && (!input.title?.trim() || !input.body?.trim()))
    throw prError("USAGE_ERROR", "A new PR requires --title and --body-file.", {}, 2);
  if ((input.title?.length ?? 0) > 256 || (input.body?.length ?? 0) > 60_000)
    throw prError("USAGE_ERROR", "PR title or body exceeds the publication limit.", {}, 2);
  const objects = await planObjects(git, request, repo, snapshot.sha);
  const plan = planSchema.parse({
    repo,
    head: snapshot.head,
    base: input.base,
    localSha: snapshot.sha,
    treeSha: snapshot.tree,
    remoteSha,
    commitCount: objects.filter((object) => object.type === "commit").length,
    objectCount: objects.length,
    uploadBytes: objects.reduce((total, object) => total + object.bytes, 0),
    refAction: remoteSha === snapshot.sha ? "reuse" : remoteSha ? "advance" : "create",
    prAction: existing ? (existing.draft ? "ready" : "reuse") : "create",
    prNumber: existing?.number ?? null,
    replySession: followContext.sessionName ?? followContext.sessionKey ?? "",
    followAction: "reconcile",
  });
  return { input: { ...input, repo }, plan, objects, git };
}
export type PreparedPublication = Awaited<ReturnType<typeof preparePublication>>;

async function readChecks(request: GithubRequest, repo: string, sha: string) {
  const status = parseGithub(
    z.object({ state: z.enum(["pending", "success", "failure"]), total_count: z.number().int().nonnegative() }),
    await request(`repos/${repo}/commits/${sha}/status`, "GET"),
  );
  let count = 0;
  let expected: number | undefined;
  let pending = status.total_count > 0 && status.state === "pending";
  let failed = status.total_count > 0 && status.state === "failure";
  for (let page = 1; page <= 10; page++) {
    const checks = parseGithub(
      z.object({
        total_count: z.number().int().nonnegative(),
        check_runs: z
          .array(
            z.object({
              head_sha: z.string().regex(SHA),
              status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
              conclusion: z.string().nullable(),
            }),
          )
          .max(100),
      }),
      await request(`repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`, "GET"),
    );
    expected ??= checks.total_count;
    if (expected !== checks.total_count || checks.check_runs.some((check) => check.head_sha !== sha))
      throw prError("GITHUB_RESPONSE_INVALID", "CI evidence changed during pagination; retry publication.", {
        retryable: true,
      });
    for (const check of checks.check_runs) {
      pending ||= check.status !== "completed" || check.conclusion === null;
      failed ||=
        check.status === "completed" &&
        check.conclusion !== null &&
        !["success", "neutral", "skipped"].includes(check.conclusion);
    }
    count += checks.check_runs.length;
    if (count === expected)
      return {
        state: failed
          ? ("failure" as const)
          : pending || count + status.total_count === 0
            ? ("pending" as const)
            : ("success" as const),
        count: count + status.total_count,
      };
    if (!checks.check_runs.length || count > expected) break;
  }
  throw prError("GITHUB_RESPONSE_INVALID", "CI snapshot is incomplete; retry publication.", { retryable: true });
}

export async function executePublication(
  prepared: PreparedPublication,
  request: GithubRequest,
  options: {
    authorize: () => void;
    provenance: Record<string, string | null>;
    journal?: (plan: PreparedPublication["plan"], provenance: Record<string, string | null>) => PublicationJournal;
    publication?: Omit<GhPrPublicationDeps, "request" | "phase" | "onPr" | "beforeFollow" | "afterFollow">;
  },
) {
  const { input, plan, git, objects } = prepared;
  options.authorize();
  const journal = (options.journal ?? openPublicationJournal)(plan, options.provenance);
  const partial = {
    publicationId: journal.publicationId,
    attemptId: journal.attemptId,
    phase: "preflight" as PublicationPhase,
    repo: plan.repo,
    head: plan.head,
    localSha: plan.localSha,
    refPublished: plan.remoteSha === plan.localSha,
    prNumber: plan.prNumber,
    uncertain: false,
  };
  let currentObject: { objectType: string; sha: string } | undefined;
  const auditedRequest: GithubRequest = async (endpoint, method, body) => {
    if (method === "GET") return await request(endpoint, method, body);
    options.authorize();
    resolvePublicationFollowContext(input.context);
    const detail: Record<string, string> = currentObject ?? (partial.phase === "ref" ? { sha: plan.localSha } : {});
    journal.record(partial.phase, "intent", detail);
    partial.uncertain = true;
    const result = await request(endpoint, method, body);
    journal.record(partial.phase, "confirmed", detail);
    partial.uncertain = false;
    return result;
  };
  const verifyCommit = async () => {
    const remote = parseGithub(commitSchema, await request(`repos/${plan.repo}/git/commits/${plan.localSha}`, "GET"));
    if (remote.sha !== plan.localSha || remote.tree.sha !== plan.treeSha)
      throw prError("GIT_OBJECT_MISMATCH", "Uploaded commit/tree does not match local HEAD.", {
        expectedSha: plan.localSha,
        actualSha: remote.sha,
        objectType: "commit",
      });
  };
  try {
    resolvePublicationFollowContext(input.context);
    partial.phase = "objects";
    for (const object of objects) {
      currentObject = { objectType: object.type, sha: object.sha };
      const plural = object.type === "tree" ? "trees" : `${object.type}s`;
      const uploaded = parseGithub(
        oidSchema,
        await auditedRequest(`repos/${plan.repo}/git/${plural}`, "POST", object.payload),
      );
      if (uploaded.sha !== object.sha)
        throw prError(
          "GIT_OBJECT_MISMATCH",
          "GitHub created an object with a different SHA. The branch has not been moved.",
          { objectType: object.type, expectedSha: object.sha, actualSha: uploaded.sha },
        );
      currentObject = undefined;
    }
    await verifyCommit();
    partial.phase = "ref";
    const current = await git.snapshot(plan.repo);
    if (current.sha !== plan.localSha || current.head !== plan.head)
      throw prError("LOCAL_HEAD_CHANGED", "Local branch or HEAD changed during upload.");
    const remoteSha = await readRef(request, plan.repo, plan.head);
    if (remoteSha !== plan.localSha) {
      if (remoteSha !== plan.remoteSha)
        throw prError("REMOTE_REF_CHANGED", "Remote branch changed during publication; no ref update was attempted.");
      try {
        if (remoteSha)
          await auditedRequest(`repos/${plan.repo}/git/refs/heads/${encodeURIComponent(plan.head)}`, "PATCH", {
            sha: plan.localSha,
            force: false,
          });
        else
          await auditedRequest(`repos/${plan.repo}/git/refs`, "POST", {
            ref: `refs/heads/${plan.head}`,
            sha: plan.localSha,
          });
      } catch (error) {
        if (error instanceof ContractError && ["PUBLICATION_AUDIT_FAILED", "PERMISSION_DENIED"].includes(error.code))
          throw error;
        if ((await readRef(request, plan.repo, plan.head)) !== plan.localSha) throw error;
        journal.record("ref", "confirmed", { sha: plan.localSha });
        partial.uncertain = false;
      }
    }
    if ((await readRef(request, plan.repo, plan.head)) !== plan.localSha)
      throw prError("REMOTE_REF_CHANGED", "Remote branch moved before PR publication.");
    partial.refPublished = true;
    const body = input.body
      ? `${input.body}\n\nPublication: Git Data API via ravi pr publish; head ${plan.localSha}. No git push or pre-push hook was run by this command. Validation is described above and in CI.\n`
      : undefined;
    const published = await publishGhPr(
      {
        repo: plan.repo,
        base: plan.base,
        head: plan.head,
        sha: plan.localSha,
        title: input.title,
        body,
        context: input.context,
      },
      {
        ...options.publication,
        request: auditedRequest,
        phase: (phase) => {
          partial.phase = phase;
        },
        onPr: (pr) => {
          partial.prNumber = pr.number;
          journal.record("pr", "confirmed", { prNumber: pr.number });
          partial.uncertain = false;
        },
        beforeFollow: () => {
          options.authorize();
          journal.record("follow", "intent");
          partial.uncertain = true;
        },
        afterFollow: () => {
          journal.record("follow", "confirmed");
          partial.uncertain = false;
        },
      },
    );
    const checks = await readChecks(request, plan.repo, plan.localSha);
    await verifyCommit();
    if ((await readRef(request, plan.repo, plan.head)) !== plan.localSha)
      throw prError("REMOTE_REF_CHANGED", "The remote head changed during final verification.");
    if ((await git.text(["rev-parse", "HEAD"])) !== plan.localSha)
      throw prError("LOCAL_HEAD_CHANGED", "Local HEAD changed during final verification.");
    const followContext = resolvePublicationFollowContext(input.context);
    journal.record("complete", "confirmed", {
      prNumber: published.number,
      sha: plan.localSha,
      watchId: published.follow.watchId!,
      ciWatchId: published.follow.ciWatchId!,
      triggerId: published.follow.triggerId!,
      checksState: checks.state,
      checksCount: checks.count,
    });
    return {
      publicationId: journal.publicationId,
      attemptId: journal.attemptId,
      repo: plan.repo,
      base: plan.base,
      head: plan.head,
      localSha: plan.localSha,
      remoteSha: plan.localSha,
      treeSha: plan.treeSha,
      pr: { number: published.number, url: published.url, reused: published.reused, ready: true as const },
      follow: {
        watchId: published.follow.watchId!,
        ciWatchId: published.follow.ciWatchId!,
        triggerId: published.follow.triggerId!,
        replySession: followContext.sessionName ?? followContext.sessionKey ?? "",
        verifiedAt: new Date().toISOString(),
      },
      checks,
    };
  } catch (error) {
    const failure =
      error instanceof ContractError
        ? error
        : error instanceof GithubError
          ? prError(
              "GITHUB_REQUEST_FAILED",
              `GitHub refused publication (HTTP ${error.status}). Check repository rules and credentials.`,
              { retryable: error.status >= 500 || error.status === 429 },
            )
          : prError(
              "PR_PUBLICATION_INCOMPLETE",
              "Publication did not complete. Rerun the same publication to reconcile its PR and follow.",
              { retryable: true },
            );
    try {
      journal.record(partial.phase, partial.uncertain ? "uncertain" : "failed", {
        errorCode: failure.code,
        refPublished: partial.refPublished,
        prNumber: partial.prNumber,
      });
    } catch {
      /* The durable intent remains uncertain; never invent a successful result. */
    }
    throw prError(failure.code, failure.message, { ...failure.details, partial }, failure.exitCode);
  } finally {
    journal.close();
  }
}
