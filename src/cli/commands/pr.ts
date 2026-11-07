import "reflect-metadata";
import { readFile, stat } from "node:fs/promises";
import { Command, CommandAccess, Group, Option, Returns, type CommandAccessOptions } from "../decorators.js";
import { contractDryRun, ContractError } from "../agent-contract.js";
import { enforceCliCommandAuthorization } from "../command-access.js";
import { getContext } from "../context.js";
import { getCallerCwd, resolveCallerPath } from "../caller-cwd.js";
import { buildAuditContextProvenance } from "../../permissions/audit-provenance.js";
import { resultSchema, prError, PUBLICATION_TIMEOUT_MS, LIMITS } from "../../pr/contracts.js";
import { githubClient, GithubError } from "../../pr/github.js";
import { LocalGit, utf8 } from "../../pr/git.js";
import { preparePublication, executePublication } from "../../pr/service.js";
import { resolvePublicationContext } from "../../pr/context.js";
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
  Publication requires an authenticated gateway context and the installed daemon journal.
  Run in the publishing Ravi session; a bare operator terminal is not a supported publication path.
  --reply-session must match the publishing session; it does not authenticate the caller.
NÃO USE
  This is not commit, merge, approval, force-push, fork publication or a draft workflow.
REGRAS HARD
  Clean named branch, github.com origin matching --repo, head distinct from base/default.
  Exact local/remote tree AND commit SHA. Only fast-forward ref updates. No hook configuration changes.
  Missing signed/nonstandard commits, new submodules, LFS and SHA-256 repositories are unsupported.
  Limits: ${LIMITS.commits} missing commits, ${LIMITS.objects} objects, 50 MiB total, 8 MiB per blob; 180s total.
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
  WORKTREE_DIRTY: commit changes. GIT_OBJECT_MISMATCH: inspect the object; never accept a substitute SHA.
  NON_FAST_FORWARD / REMOTE_REF_CHANGED: integrate remote changes or choose a new branch.
  PR_PUBLICATION_INCOMPLETE: inspect partial.phase and rerun with the same --expect-sha.
  FOLLOW_RUNTIME_UNAVAILABLE: update/start Ravi's runtime; no success without its active CI producer.
  PUBLICATION_AUDIT_FAILED from a local terminal: use the authenticated gateway path; do not open real state locally.
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
    remoteTimeoutMs: PUBLICATION_TIMEOUT_MS + 15_000,
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
      description: "CI publishing session; must match the authenticated session and does not grant authority",
    })
    replySession?: string,
    @Option({ flags: "--dry-run", description: "Preview only; also the default without --execute (exit 3)" })
    dryRun?: boolean,
    @Option({ flags: "--json", description: "Print one typed JSON result or error envelope" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Publish externally and reconcile CI follow" }) execute?: boolean,
  ) {
    const context = getContext();
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
      if (!decision.allowed)
        throw prError("PERMISSION_DENIED", "This context cannot publish the selected PR.", decision.denialDetails);
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
        throw prError("BODY_FILE_UNREADABLE", "Cannot read the PR description file from the caller directory.");
      }
    }
    signal = AbortSignal.timeout(PUBLICATION_TIMEOUT_MS);
    const request = this.dependencies.github(signal);
    try {
      const prepared = await preparePublication(
        { cwd, repo, base, title, body, expectSha, context: publisher },
        request,
        new LocalGit(cwd, signal),
      );
      await this.dependencies.health();
      if (!execute) contractDryRun("pr publish", prepared.plan, { asJson });
      const provenance = buildAuditContextProvenance(context);
      const result = await this.dependencies.execute(prepared, request, {
        authorize,
        provenance: {
          actor: provenance?.actorPrincipal ?? (context?.agentId ? `agent:${context.agentId}` : "local-operator"),
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
    }
  }
}
