# GitHub Watch Connector / CHECKS

## Source Strategy Checks

- `auto` chooses Console when a GitHub App installation exists for the repo.
- Private repo watches do not require storing a local PAT.
- Multiple watches on the same repo reuse the same provider installation stream.
- Repository webhook creation is not the default path.
- Console placement uses `/api/cli/watches/*` and `delivery:{type:"inbox"}`.
- GitHub App install/repo/permission failures surface stable Console watch error
  codes.

## Event Mapping Checks

Simulate provider events and verify derived event types:

- `release/published` with `prerelease=false` -> `release.published`
- `release/published` with `prerelease=true` -> `release.prereleased`
- `create` branch -> `branch.created`
- `delete` tag -> `tag.deleted`
- `pull_request/closed` with merged true -> `pull_request.merged`
- `pull_request_review/submitted` approved -> `pull_request_review.approved`
- `issue_comment/created` on PR -> `pull_request_comment.created`
- `workflow_run/completed` failure -> `workflow_run.failed`
- `watch/started` -> `star.created`

## Local Polling Checks

- Polling stores per-endpoint cursors and ETags.
- `304 Not Modified` emits no event.
- Overlapping endpoint windows dedupe before NATS publish.
- Repository events feed is not used as the sole source for fine-grained events.
- Rate-limit and secondary-rate-limit responses produce backoff state.
- First poll creates baseline and does not emit historical events unless
  backfill is explicit.
- A release-only watch polls releases but not pulls/issues/actions/checks.
- Multiple local watches for the same repo coalesce identical endpoint requests.
- Poll fidelity is declared for every mapped event type.

## Payload Safety Checks

- Payload includes repo id/name, event type, actor, URL, and relevant object id.
- Payload does not include tokens, webhook secrets, raw headers, patch bodies, or
  private file contents.
- Trigger filters can match `watchId`, `source.repo`, `payload.branch`,
  `payload.label`, or `payload.workflow` without parsing raw GitHub payloads.
