---
id: watch/connectors/github
title: "GitHub Watch Connector"
kind: feature
domain: watch
capability: connectors
feature: github
tags:
  - watch
  - github
  - github-app
  - webhooks
applies_to:
  - src/watch/connectors/github.ts
  - src/cli/commands/watch.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# GitHub Watch Connector

## Intent

The GitHub connector watches repositories and emits normalized events for repo
activity that users commonly want to route into group triggers.

The connector must support public and private repositories while keeping event
types fine-grained enough that a group can subscribe only to the exact events it
cares about.

For Console placement, the "Ravi bot on GitHub" is the Ravi GitHub App managed
by Console. Local OSS code creates a Console provider watch and consumes events;
it does not host GitHub webhook ingress.

## Placement

- Console placement SHOULD be the default for reliable repo updates.
- Console placement MUST use a GitHub App installation and GitHub webhooks for
  private repositories, organization repositories, always-on monitoring, and
  low-latency delivery.
- Console placement MUST follow the public OSS<->Console contract in
  `watch/console-provider`.
- Local placement MAY support public repositories and authenticated private
  repositories through GitHub REST API polling.
- Local placement MUST be documented as a polling fallback, not the real-time
  path.
- Local placement MUST use conditional requests (`ETag` / `If-None-Match` or
  `Last-Modified` / `If-Modified-Since`) whenever the endpoint supports them.
- Local placement SHOULD serialize GitHub API requests per host/account to avoid
  secondary rate limits.
- `auto` placement SHOULD choose Console when a matching GitHub App
  installation is available. It MAY choose local only for explicit local debug,
  public repos, or event families with reliable low-volume polling.

## Efficient Update Strategy

The most efficient complete strategy is:

1. Install the Ravi GitHub App on the target account or repository selection.
2. Use the app-level webhook stream owned by Console.
3. Receive provider webhook deliveries in Console.
4. Verify webhook signature and installation/repository authorization in
   Console.
5. Normalize the provider event into one or more fine-grained Ravi watch events.
6. Deliver those watch events to local Ravi through inbox.

The connector MUST NOT create one GitHub repository webhook per Ravi watch when
a shared GitHub App installation can serve multiple watches. Watch records
SHOULD filter a shared provider event stream by repository id/name, provider
event, action, branch, label, workflow, and other connector config.

Repository webhooks MAY be supported only as an explicit fallback for accounts
where a GitHub App installation is not possible. They require repository admin
permission and should not be the default.

## Console API Contract

For `ravi watch create github ... --placement console`, the CLI SHOULD:

1. call `GET /api/cli/watches/capabilities?provider=github&eventTypes=...`;
2. call `GET /api/cli/watches/providers/github/installations` when installation
   choice is needed;
3. call
   `GET /api/cli/watches/providers/github/installations/:installationId/repos`
   when repo selection/lookup is needed;
4. call `POST /api/cli/watches` with provider `github`, placement `console`,
   provider installation/resource ids, event types, filters, and inbox delivery.

The Console watch record MUST reference Ravi-owned provider ids
(`providerInstallationId`, `providerResourceId`) as the durable authority.
`owner/repo` is display and lookup metadata, not the final authorization source.

The CLI MUST surface Console errors from `watch/console-provider`, including
`INSTALLATION_MISSING`, `REPO_NOT_SELECTED`, `PROVIDER_PERMISSION_MISSING`,
`WATCH_UNSUPPORTED_EVENT`, `WEBHOOK_UNHEALTHY`, and
`INBOX_SUBSCRIPTION_MISSING`.

## Configuration

Required:

- `repo`: repository in `owner/name` form.

Optional:

- `events`: event type allow-list.
- `branches`: branch allow-list for branch-scoped events.
- `labels`: label allow-list for issue or pull request events.
- `workflow`: workflow name or id for workflow run events.
- `actors`: actor login allow-list.
- `includeDrafts`: whether draft pull requests or draft releases should emit.
- `placement`: `auto`, `local`, or `console`.
- `githubHost`: GitHub host, defaulting to `github.com`.
- `installationId`: Console-managed GitHub App installation id.
- `credentialRef`: local or Console credential reference.

## Event Types

The connector MUST expose fine-grained Ravi event types, even when GitHub sends
a broader webhook event with an `action` field.

The OSS catalog MAY list the long-term event model, but each catalog item MUST
make current support explicit. As of the Console P1 webhook implementation,
`consoleSupport=supported` applies only to:

- `push.branch`
- `push.default_branch`
- `push.tag`
- `pull_request.opened`
- `pull_request.closed`
- `pull_request.merged`
- `pull_request.reopened`
- `issue.opened`
- `issue.closed`
- `workflow_run.completed`

Other GitHub catalog events are roadmap until Console capabilities report them
as supported. `ravi watch create github ... --placement auto|console` MUST
honor `capabilities.unsupportedEventTypes` and fail before creating a watch.

Initial event families SHOULD include:

### Releases

- `release.published`
- `release.prereleased`
- `release.edited`
- `release.deleted`

Provider source: GitHub `release` webhook or releases polling.

### Refs And Pushes

- `branch.created`
- `branch.deleted`
- `tag.created`
- `tag.deleted`
- `push.branch`
- `push.default_branch`
- `push.tag`

Provider source: GitHub `create`, `delete`, and `push` webhooks. Local polling
MAY support tags and branch heads but cannot reconstruct every push delivery
perfectly.

### Pull Requests

- `pull_request.opened`
- `pull_request.reopened`
- `pull_request.ready_for_review`
- `pull_request.converted_to_draft`
- `pull_request.synchronize`
- `pull_request.review_requested`
- `pull_request.closed`
- `pull_request.merged`

Provider source: GitHub `pull_request` webhook. `pull_request.merged` is derived
from provider action `closed` with `pull_request.merged == true`.

### Pull Request Reviews

- `pull_request_review.submitted`
- `pull_request_review.approved`
- `pull_request_review.changes_requested`
- `pull_request_review.dismissed`
- `pull_request_review.commented`

Provider source: GitHub `pull_request_review` webhook. Approval-specific events
are derived from submitted reviews by inspecting review state.

### Issues And Comments

- `issue.opened`
- `issue.closed`
- `issue.reopened`
- `issue.labeled`
- `issue.assigned`
- `issue.edited`
- `issue_comment.created`
- `pull_request_comment.created`

Provider source: GitHub `issues` and `issue_comment` webhooks.
`pull_request_comment.created` is derived from `issue_comment` when the issue is
a pull request.

### Actions And Checks

- `workflow_run.requested`
- `workflow_run.in_progress`
- `workflow_run.completed`
- `workflow_run.succeeded`
- `workflow_run.failed`
- `workflow_run.cancelled`
- `check_run.completed`
- `check_suite.completed`

Provider source: GitHub `workflow_run`, `check_run`, and `check_suite`
webhooks. Conclusion-specific workflow events are derived from completed
workflow runs.

### Repository Metadata

- `repository.archived`
- `repository.unarchived`
- `repository.renamed`
- `repository.transferred`
- `repository.publicized`
- `repository.privatized`

Provider source: GitHub `repository` and `public` webhooks where available.

### Stars

- `star.created`

Provider source: GitHub `watch` webhook. The Ravi event name MUST use `star` to
avoid confusion with Ravi watch records.

Connector implementations MAY start with a smaller subset, but they MUST report
unsupported event types clearly from `ravi watch connectors --json`.

## Provider Event Mapping

The connector SHOULD maintain an explicit mapping table from GitHub provider
event/action to Ravi event type.

The mapping MUST be action-aware. For example:

| GitHub event | GitHub action/state | Ravi event type |
| --- | --- | --- |
| `release` | `published` + `prerelease=false` | `release.published` |
| `release` | `published` + `prerelease=true` | `release.prereleased` |
| `create` | `ref_type=branch` | `branch.created` |
| `create` | `ref_type=tag` | `tag.created` |
| `delete` | `ref_type=branch` | `branch.deleted` |
| `delete` | `ref_type=tag` | `tag.deleted` |
| `push` | `ref=refs/heads/<branch>` | `push.branch` |
| `push` | `ref=refs/tags/<tag>` | `push.tag` |
| `pull_request` | `closed` + `merged=true` | `pull_request.merged` |
| `pull_request` | `closed` + `merged=false` | `pull_request.closed` |
| `pull_request_review` | `submitted` + `state=approved` | `pull_request_review.approved` |
| `pull_request_review` | `submitted` + `state=changes_requested` | `pull_request_review.changes_requested` |
| `issue_comment` | issue has `pull_request` | `pull_request_comment.created` |
| `issue_comment` | issue has no `pull_request` | `issue_comment.created` |
| `workflow_run` | `completed` + `conclusion=success` | `workflow_run.succeeded` |
| `workflow_run` | `completed` + `conclusion=failure` | `workflow_run.failed` |
| `watch` | `started` | `star.created` |

Unsupported provider actions MUST be logged and counted without crashing the
watch runner.

## Permissions

Console placement SHOULD request the minimum GitHub App permissions needed by
the selected event families:

- metadata: repo identity, public events, stars;
- contents: push/create/delete, tags, releases, workflow dispatch metadata;
- pull requests: pull request and pull request review events;
- issues: issues and issue comments;
- actions: workflow run events;
- checks: check run and check suite events;
- administration: repository metadata/security settings when those event
  families are enabled.

Console SHOULD expose these as safe provider capabilities to OSS clients:

- `source.repo.metadata.read`
- `source.repo.contents.read`
- `source.pull_request.read`
- `source.issue.read`
- `source.check.read`
- `source.action.read`
- `source.repository.admin_metadata.read`

The connector MUST NOT require broad permissions for event families the watch
does not use.

For private repositories, Console placement MUST validate that the GitHub App
installation includes the target repository before creating the watch.

Local placement MAY use:

- `gh auth token` as a credential source;
- `GH_TOKEN` / `GITHUB_TOKEN` as explicit environment credential references;
- a Ravi-managed local credential reference.

Local placement MUST NOT persist raw GitHub tokens inside the watch record.

## Local Polling Strategy

Local polling MUST use provider-specific endpoints, not only the repository
events feed, when the user asks for fine-grained events.

Recommended endpoint families:

- releases: `GET /repos/{owner}/{repo}/releases`;
- tags/branches: refs or git matching refs endpoints;
- pull requests: `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated`;
- issues: `GET /repos/{owner}/{repo}/issues?state=all&sort=updated`;
- issue comments: repository issue comments with `since` when available;
- workflow runs: `GET /repos/{owner}/{repo}/actions/runs`;
- check runs/suites: checks endpoints scoped to recent refs or SHAs.

The repository events feed MAY be used only as a coarse fallback or bootstrap
hint because GitHub documents it as unsuitable for real-time use and it may lag
substantially.

The local runner MUST store per-stream cursor state:

- endpoint path and query;
- last `ETag` or `Last-Modified`;
- last seen provider id/node id;
- last seen `updated_at` / `created_at`;
- rate-limit reset and backoff state.

Local polling MUST dedupe before publishing, because endpoint windows can
overlap across ticks.

## Poll Semantics

Polling is a fallback, not the primary source of truth. The connector MUST mark
each polled event family with a fidelity level:

- `full`: polling can detect the event with stable provider identity.
- `derived`: polling can infer the event by comparing current state to cached
  prior state.
- `best_effort`: polling can usually detect the outcome, but may miss short-lived
  intermediate states or exact provider actions.
- `webhook_only`: the event should not be promised from polling.

The first successful poll MUST establish a baseline cursor and SHOULD NOT emit
historical events by default. Historical emission MUST require an explicit
backfill option.

Each subsequent poll MUST:

1. select endpoint streams from the watch's enabled event families;
2. request only bounded recent windows;
3. send `If-None-Match` / `If-Modified-Since` when cursor headers exist;
4. treat `304 Not Modified` as no event and keep the prior cursor;
5. compare returned objects against cached state;
6. derive fine-grained Ravi events;
7. dedupe by semantic provider key;
8. advance cursors only after local persistence/publish succeeds.

If implemented through `gh`, the runner SHOULD use `gh api` only as an
authenticated API transport:

```bash
gh api -i repos/OWNER/REPO/releases \
  -H "If-None-Match: <etag>"
```

The implementation SHOULD parse response headers from `--include` and persist
`etag`, `last-modified`, rate-limit, and pagination state. Production code MAY
use a native HTTP client with the same REST semantics instead of shelling out to
`gh`.

## Poll Matrix

| Ravi event type | Poll source | Cursor | Poll fidelity |
| --- | --- | --- | --- |
| `release.published` | `GET /repos/{owner}/{repo}/releases` | release id + `published_at` + ETag | `full` |
| `release.prereleased` | releases list | release id + `published_at` + ETag | `full` |
| `release.edited` | releases list | release id + `updated_at` + cached fields | `derived` |
| `release.deleted` | releases list + cached release ids | cached id missing in bounded window | `best_effort` |
| `branch.created` | `GET /repos/{owner}/{repo}/git/matching-refs/heads` | ref name + sha snapshot + ETag | `derived` |
| `branch.deleted` | matching heads refs | ref name removed from snapshot | `derived` |
| `tag.created` | `GET /repos/{owner}/{repo}/git/matching-refs/tags` | ref name + sha snapshot + ETag | `derived` |
| `tag.deleted` | matching tag refs | ref name removed from snapshot | `derived` |
| `push.branch` | matching heads refs, optionally commits/compare | branch head sha transition | `best_effort` |
| `push.default_branch` | repo metadata + default branch head | default branch head sha transition | `best_effort` |
| `push.tag` | matching tag refs | tag ref appeared or changed | `best_effort` |
| `pull_request.opened` | `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc` | PR number + `created_at`/first seen | `derived` |
| `pull_request.reopened` | pulls list | cached state closed -> open | `derived` |
| `pull_request.ready_for_review` | pulls list | cached draft true -> false | `derived` |
| `pull_request.converted_to_draft` | pulls list | cached draft false -> true | `derived` |
| `pull_request.synchronize` | pulls list | cached head sha changed | `derived` |
| `pull_request.review_requested` | pulls list + requested reviewers snapshot | reviewer/team added | `best_effort` |
| `pull_request.closed` | pulls list | cached state open -> closed, `merged_at` null | `derived` |
| `pull_request.merged` | pulls list | cached state open -> closed, `merged_at` set | `derived` |
| `pull_request_review.submitted` | `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` for changed PRs | review id | `full` |
| `pull_request_review.approved` | PR reviews endpoint | review id + state approved | `full` |
| `pull_request_review.changes_requested` | PR reviews endpoint | review id + state changes requested | `full` |
| `pull_request_review.dismissed` | PR reviews endpoint | review id + state dismissed | `derived` |
| `pull_request_review.commented` | PR reviews endpoint | review id + state commented | `full` |
| `issue.opened` | `GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc` | issue number + first seen/created_at | `derived` |
| `issue.closed` | issues list | cached state open -> closed | `derived` |
| `issue.reopened` | issues list | cached state closed -> open | `derived` |
| `issue.labeled` | issues list | label added to cached label set | `derived` |
| `issue.assigned` | issues list | assignee added to cached assignee set | `derived` |
| `issue.edited` | issues list | `updated_at` changed + title/body hash changed | `best_effort` |
| `issue_comment.created` | `GET /repos/{owner}/{repo}/issues/comments?since=<cursor>` | comment id + `created_at` | `full` |
| `pull_request_comment.created` | issue comments + cached issue is PR | comment id + `created_at` | `full` |
| `workflow_run.requested` | `GET /repos/{owner}/{repo}/actions/runs` | run id + status | `derived` |
| `workflow_run.in_progress` | workflow runs list | run id + status transition | `derived` |
| `workflow_run.completed` | workflow runs list | run id + completed status | `full` |
| `workflow_run.succeeded` | workflow runs list | run id + conclusion success | `full` |
| `workflow_run.failed` | workflow runs list | run id + conclusion failure | `full` |
| `workflow_run.cancelled` | workflow runs list | run id + conclusion cancelled | `full` |
| `check_run.completed` | `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` for recent refs | check run id + completed status | `best_effort` |
| `check_suite.completed` | check suites for recent refs | check suite id + completed status | `best_effort` |
| `repository.archived` | `GET /repos/{owner}/{repo}` | cached `archived` false -> true | `derived` |
| `repository.unarchived` | repo metadata | cached `archived` true -> false | `derived` |
| `repository.renamed` | repo metadata | cached `name`/`full_name` changed | `derived` |
| `repository.transferred` | repo metadata | cached owner/repository id relation changed | `best_effort` |
| `repository.publicized` | repo metadata | cached `private` true -> false | `derived` |
| `repository.privatized` | repo metadata | cached `private` false -> true | `derived` |
| `star.created` | stargazers endpoint with starred-at media type | new stargazer id + starred time | `best_effort` |

Poll support MUST be configurable per event family. A watch that requests only
`release.published` MUST NOT poll pull request, issue, workflow, or check
endpoints.

The runner SHOULD coalesce endpoint streams across local watches for the same
repository so ten local watches do not make ten identical GitHub requests.

## Poll Intervals

Default local polling intervals SHOULD be event-family aware:

- releases, refs, and repository metadata: 5-15 minutes;
- pull requests and issues: 1-5 minutes;
- workflow runs/checks: 30-90 seconds while recent runs are active, then back
  off to 5 minutes;
- stars: 15-60 minutes or disabled for high-volume repositories.

The runner MUST back off on rate-limit or secondary-rate-limit responses using
GitHub response headers when present.

## Dedupe

Dedupe keys SHOULD use stable GitHub ids when available:

- release: `github:<repo>:release:<release_id>`
- tag: `github:<repo>:tag:<ref>`
- push: `github:<repo>:push:<push_id>` for webhooks, otherwise
  `github:<repo>:push:<ref>:<before>:<after>`
- pull request: `github:<repo>:pull_request:<number>:<event_type>:<updated_at>`
- pull request review: `github:<repo>:pull_request_review:<review_id>:<event_type>`
- issue: `github:<repo>:issue:<number>:<event_type>:<updated_at>`
- issue comment: `github:<repo>:issue_comment:<comment_id>:<event_type>`
- workflow run: `github:<repo>:workflow_run:<run_id>:<conclusion>`
- check run: `github:<repo>:check_run:<check_run_id>:<event_type>`

Webhook delivery ids MUST be stored as delivery evidence when available, but
semantic dedupe MUST be based on provider object identity and event type so
replayed webhook deliveries do not create duplicate trigger firings.

## Payload

Payload SHOULD include:

- repository owner/name;
- repository id/node id;
- action;
- actor login when available;
- number/id for issue, pull request, release, or workflow run;
- title/name;
- branch/tag when relevant;
- commit SHA range for push events when available;
- URL;
- conclusion/status for workflow runs.

Payload MUST NOT include GitHub tokens, raw webhook secrets, private diff
contents, full patch bodies, or raw webhook headers.

Payload SHOULD include a `provider` object with minimal provenance:

```ts
{
  provider: "github";
  providerEvent: "pull_request";
  providerAction?: "opened";
  deliveryId?: string;
  installationId?: number;
  repositoryId: number;
}
```

The `deliveryId` is operational provenance. Trigger filters SHOULD use stable
payload/source fields, not delivery ids.

Payload SHOULD include a normalized watch block:

```ts
{
  watch: {
    id: string;
    provider: "github";
    placement: "console" | "local";
    resourceRef: "owner/repo";
    eventTypes?: string[];
  };
}
```

For `pull_request.merged`, provider provenance SHOULD preserve
`providerEventType="pull_request"` and `providerAction="closed"`, while the
normalized payload carries `merged: true`.

When delivered through Console inbox, the inbox item `eventType` SHOULD use the
Console event namespace:

```text
watch.github.pull_request.merged
watch.github.workflow_run.failed
```

The local NATS subject for triggers remains:

```text
ravi.watch.github.pull_request.merged
ravi.watch.github.workflow_run.failed
```

## Subject Examples

```text
ravi.watch.github.release.published
ravi.watch.github.tag.created
ravi.watch.github.pull_request.merged
ravi.watch.github.issue.opened
ravi.watch.github.workflow_run.completed
```

## Acceptance Criteria

- `ravi watch create github owner/repo --placement auto` chooses Console when a
  GitHub App installation exists for the repo.
- GitHub App webhook delivery for a private repo can produce a normalized watch
  event without storing a PAT locally.
- Console provider watch creation uses `/api/cli/watches/*` and delivery type
  `inbox`.
- Multiple watches for the same repo reuse the shared installation/webhook event
  stream and filter internally.
- Trigger topics can subscribe at `ravi.watch.github.release.published`,
  `ravi.watch.github.pull_request.merged`, or any other fine-grained event.
- Local polling uses conditional requests and per-stream cursors.
- The repository events API is never the only mechanism for fine-grained or
  near-real-time watches.
