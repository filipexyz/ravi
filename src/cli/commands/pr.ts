import "reflect-metadata";
import { readFile, stat } from "node:fs/promises";
import { errorDiagnostic } from "../../utils/error-diagnostic.js";
import { Command, CommandAccess, Group, Option, Returns, type CommandAccessOptions } from "../decorators.js";
import { contractDryRun, ContractError, renderContractError, wasContractErrorRendered } from "../agent-contract.js";
import { enforceCliCommandAuthorization, RUNTIME_CONTEXT_INACTIVE } from "../command-access.js";
import { getCallerCwd, resolveCallerPath } from "../caller-cwd.js";
import { buildAuditContextProvenance } from "../../permissions/audit-provenance.js";
import { resultSchema, prError, PUBLICATION_CONTEXT_REQUIRED_MESSAGE, LIMITS } from "../../pr/contracts.js";
import {
  createPublicationDeadline,
  publicationBudgetMs,
  publicationTimeoutError,
  PUBLICATION_TIMEOUT_CEILING_MS,
  PUBLICATION_TIMEOUT_ENV,
} from "../../pr/budget.js";
import { githubClient, GithubError } from "../../pr/github.js";
import { LocalGit, utf8 } from "../../pr/git.js";
import { preparePublication, executePublication } from "../../pr/service.js";
import { resolvePublicationCaller, resolvePublicationContext } from "../../pr/context.js";
import { requireFollowRuntime } from "../../pr/follow-health.js";

const access: CommandAccessOptions = {
  kind: "mutate",
  resource: "pr",
  action: "publish",
  risk: "high",
  requiresConfirmation: true,
  localOperator: true,
  input: ["repo", "base", "expectSha", "replySession"],
  redactions: ["title", "bodyFile"],
};
const HELP = `
USE
  Publish a committed work branch through Git Data API, then create/reuse its ready PR and CI follow.
  In a Ravi session (through the gateway/agent), CI follows that session's durable origin.
  From the operator's terminal, with the installed CLI, pass --reply-session <session>: the session whose
  chat receives the CI follow. It names a destination and grants no authority.
NÃO USE
  This is not commit, merge, approval, force-push, fork publication or a draft workflow.
REGRAS HARD
  Clean named branch, github.com origin matching --repo, head distinct from base/default.
  Exact local/remote tree AND commit SHA. Only fast-forward ref updates. No hook configuration changes.
  Missing signed/nonstandard commits, new submodules, LFS and SHA-256 repositories are unsupported.
  Limits: ${LIMITS.commits} missing commits, ${LIMITS.objects} objects, 50 MiB total, 8 MiB per blob.
  Time budget: 180s plus 1s per 250 KiB of measured upload, at most ${PUBLICATION_TIMEOUT_CEILING_MS / 1000}s.
  ${PUBLICATION_TIMEOUT_ENV}=<ms> in the publishing process replaces it, under the same ceiling.
CONFIRMAÇÃO
  Dry-run by default. --execute publishes externally; it does not grant permissions or approve review.
LIFECYCLE
  preflight -> objects -> ref -> PR -> follow -> ready -> verified result.
  Repeating publish repairs the same PR/follow. Existing title/body are preserved.
EXAMPLES
  ravi pr publish --repo owner/repo --base dev --title "Fix parser" --body-file /tmp/pr.md --dry-run --json
  ravi pr publish --repo owner/repo --base dev --title "Fix parser" --body-file /tmp/pr.md --expect-sha <40-char-sha> --json --execute
  ravi pr publish --repo owner/repo --base dev --json --execute
ON ERROR
  PERMISSION_DENIED in a runtime context: ${PUBLICATION_CONTEXT_REQUIRED_MESSAGE}
  RUNTIME_CONTEXT_INACTIVE: the context that started publish is no longer live (revoked, e.g. its turn ended, or
  expired), possibly mid-upload; it is not a missing grant. Rerun with the same --expect-sha from a live turn and
  keep it open until the command exits.
  PUBLICATION_SESSION_REQUIRED from a terminal: pass --reply-session <session> that has a chat destination.
  STATE_SCHEMA_NOT_READY from a terminal: the installed daemon prepares state; run ravi daemon restart -m "prepare state".
  WORKTREE_DIRTY: commit changes. GIT_OBJECT_MISMATCH: inspect the object; never accept a substitute SHA.
  NON_FAST_FORWARD / REMOTE_REF_CHANGED: integrate remote changes or choose a new branch.
  PR_PUBLICATION_INCOMPLETE: inspect partial.phase and rerun with the same --expect-sha.
  PUBLICATION_TIMEOUT: timeout reports the phase and the objects/bytes already uploaded; rerun with the same
  --expect-sha, objects GitHub already holds are skipped.
  PUBLICATION_REQUEST_TIMEOUT: one git/GitHub request passed its own limit, not the publication budget; rerun with
  the same --expect-sha. PUBLICATION_RESPONSE_TOO_LARGE: a response passed the output limit; a rerun does not help.
  FOLLOW_RUNTIME_UNAVAILABLE: update/start Ravi's runtime; no success without its active CI producer.
OUTPUT
  --json returns publication/attempt IDs, repo/head/base, SHAs, PR URL, watch/trigger IDs and CI snapshot.
  Exits: 0 complete; 1 failed/incomplete; 2 invalid usage; 3 preview/write brake (no mutations).
FONTES
  src/pr; CLI and watch specifications; GitHub REST Git database and pull-request APIs.
`;

@Group({ name: "pr", description: "Publish verified GitHub pull requests and reconcile CI follow", scope: "open" })
export class PrCommands {
  constructor(
    private readonly dependencies = {
      context: resolvePublicationContext,
      github: githubClient,
      health: requireFollowRuntime,
      execute: executePublication,
    },
  ) {}

  @Command({
    name: "publish",
    description: "Upload the current branch, publish a ready PR and verify CI follow",
    helpAfter: HELP,
    remoteTimeoutMs: PUBLICATION_TIMEOUT_CEILING_MS + 15_000,
  })
  @CommandAccess(access)
  @Returns(resultSchema)
  async publish(
    @Option({ flags: "--repo <owner/repo>", description: "Required github.com destination; must match origin" })
    repo?: string,
    @Option({ flags: "--base <branch>", description: "Required existing target branch" }) base?: string,
    @Option({ flags: "--title <text>", description: "Required for a new PR; existing PR text is preserved" })
    title?: string,
    @Option({
      flags: "--body-file <path>",
      description: "UTF-8 PR description, relative to caller cwd; required for a new PR",
    })
    bodyFile?: string,
    @Option({ flags: "--expect-sha <sha>", description: "Require this full local commit SHA (default: capture HEAD)" })
    expectSha?: string,
    @Option({
      flags: "--reply-session <session>",
      description:
        "From a terminal: the session whose chat receives the CI follow. In a session it must be that session. Grants no authority",
    })
    replySession?: string,
    @Option({ flags: "--dry-run", description: "Preview only; also the default without --execute (exit 3)" })
    dryRun?: boolean,
    @Option({ flags: "--json", description: "Print one typed JSON result or error envelope" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Publish externally and reconcile CI follow" }) execute?: boolean,
  ) {
    try {
      return await this.publishFor({ repo, base, title, bodyFile, expectSha, replySession, dryRun, asJson, execute });
    } catch (error) {
      // A gateway client and a tool caller show the returned failure themselves.
      // In a terminal nothing else does, so it is shown here, once.
      if (error instanceof ContractError && !wasContractErrorRendered(error)) renderContractError(error, asJson);
      throw error;
    }
  }

  private async publishFor(input: {
    repo?: string;
    base?: string;
    title?: string;
    bodyFile?: string;
    expectSha?: string;
    replySession?: string;
    dryRun?: boolean;
    asJson?: boolean;
    execute?: boolean;
  }) {
    const { repo, base, title, bodyFile, expectSha, replySession, dryRun, asJson, execute } = input;
    // A session through the gateway/agent, or the operator's own terminal.
    const caller = resolvePublicationCaller();
    const context = caller.kind === "session" ? caller.context : undefined;
    let signal: AbortSignal | undefined;
    const authorize = () => {
      if (signal?.aborted)
        throw prError("PUBLICATION_TIMEOUT", "Publication time budget expired; reconcile any partial effects.", {
          retryable: true,
        });
      const decision = enforceCliCommandAuthorization({
        group: "pr",
        command: "publish",
        scope: "open",
        access,
        source: context?.transport ?? "cli",
        input: { repo, base, expectSha, replySession },
      });
      if (!decision.allowed) {
        // A context that ended under a running publish is not a missing grant: say so, so nobody asks for one.
        if (decision.denialDetails?.reason === RUNTIME_CONTEXT_INACTIVE)
          throw prError(
            "RUNTIME_CONTEXT_INACTIVE",
            "The runtime context that started this publication is no longer live (revoked, for example when its turn ended, or expired); the grant is not the problem.",
            {
              ...decision.denialDetails,
              suggestedAction:
                "Rerun the same ravi pr publish command with the same --expect-sha from a live turn and keep that turn open until it exits; objects already uploaded are skipped.",
            },
          );
        throw prError("PERMISSION_DENIED", "This context cannot publish the selected PR.", decision.denialDetails);
      }
    };
    authorize();
    if (!repo || !base || (dryRun && execute))
      throw prError("USAGE_ERROR", "Provide --repo and --base; --dry-run and --execute are mutually exclusive.", {}, 2);
    if (context?.transport && !context.cwd)
      throw prError("CALLER_CWD_REQUIRED", "The gateway needs the caller worktree directory for publication.");
    const publisher = this.dependencies.context(replySession);
    const cwd = resolveCallerPath(getCallerCwd());
    let body: string | undefined;
    if (bodyFile) {
      try {
        const path = resolveCallerPath(bodyFile);
        const info = await stat(path);
        if (!info.isFile() || info.size > 240_000)
          throw prError("USAGE_ERROR", "PR body must be a UTF-8 file within the size limit.", {}, 2);
        body = utf8(await readFile(path));
      } catch (error) {
        if (error instanceof ContractError) throw error;
        throw prError(
          "BODY_FILE_UNREADABLE",
          "Cannot read the PR description file from the caller directory.",
          errorDiagnostic(error, { operation: "pr publish" }),
        );
      }
    }
    // The preflight runs on the base budget; once it has measured the upload, the same deadline grows with it.
    const deadline = createPublicationDeadline(publicationBudgetMs(0));
    signal = deadline.signal;
    const request = this.dependencies.github(signal);
    const measure = async () => {
      try {
        return await preparePublication(
          { cwd, repo, base, title, body, expectSha, context: publisher },
          request,
          new LocalGit(cwd, signal),
        );
      } catch (error) {
        // The budget ended before the upload was measured: say so instead of reporting unknown progress.
        if (error instanceof ContractError && error.code === "PUBLICATION_TIMEOUT")
          throw publicationTimeoutError(
            {
              phase: "preflight",
              budgetMs: publicationBudgetMs(0),
              objectsUploaded: 0,
              objectCount: null,
              bytesUploaded: 0,
              uploadBytes: null,
            },
            error.details,
          );
        throw error;
      }
    };
    try {
      const prepared = await measure();
      deadline.setBudget(publicationBudgetMs(prepared.plan.uploadBytes));
      await this.dependencies.health();
      if (!execute) contractDryRun("pr publish", prepared.plan, { asJson });
      const provenance = buildAuditContextProvenance(context);
      const result = await this.dependencies.execute(prepared, request, {
        authorize,
        provenance: {
          actor: provenance?.actorPrincipal ?? (context ? `agent:${context.agentId}` : "local-operator"),
          executorAgentId: context?.agentId ?? null,
          sessionKey: publisher.sessionKey ?? null,
          contextId: context?.contextId ?? null,
        },
      });
      console.log(
        asJson
          ? JSON.stringify(result, null, 2)
          : `${result.pr.url}\nPublished ${result.localSha}; ready for review. CI follow verified in ${result.follow.replySession}. Checks: ${result.checks.state}.`,
      );
      return result;
    } catch (error) {
      if (error instanceof GithubError)
        throw prError(
          "GITHUB_REQUEST_FAILED",
          `GitHub refused preflight (HTTP ${error.status}). Check repository access and credentials.`,
          { retryable: error.status >= 500 || error.status === 429 },
        );
      throw error;
    } finally {
      deadline.dispose();
    }
  }
}
