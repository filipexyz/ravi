# GitHub Watch Connector / RUNBOOK

## Preferred Console Path

1. Install the Ravi GitHub App on the account or repository selection.
2. Let the CLI discover Console capabilities and create the watch:

```bash
ravi watch create github owner/repo --event release.published --placement auto
```

3. Create the trigger from the target group:

```bash
ravi watch trigger <watch-id> \
  --event release.published \
  --message "Resume a release e diga se precisamos agir."
```

Expected topic:

```text
ravi.watch.github.release.published
```

Expected Console calls:

```text
GET  /api/cli/watches/capabilities?provider=github&eventTypes=release.published
POST /api/cli/watches
```

## Private Repo Debug

Check:

- GitHub App installation includes the repository.
- App permissions cover the requested event family.
- Console webhook delivery was accepted and signature-verified.
- Console matched an active provider watch.
- Local inbox received the Console watch event.
- Local NATS published the normalized `ravi.watch.github...` subject.

## Local Polling Debug

Use local only when explicitly requested or when Console is unavailable:

```bash
ravi watch create github owner/repo --event pull_request.merged --placement local
ravi watch run <watch-id> --once --json
```

Check:

- `gh auth status` or the configured credential ref can read the repo.
- The connector uses endpoint-specific cursors.
- `ETag` or `Last-Modified` state is stored after the first request.
- A `304 Not Modified` response produces no watch event.
- Only endpoint streams required by enabled event families are polled.
- First successful poll establishes baseline unless explicit backfill is set.

Example low-level `gh api` shape:

```bash
gh api -i repos/OWNER/REPO/pulls \
  -F state=all \
  -F sort=updated \
  -F direction=desc \
  -H "If-None-Match: <etag>"
```

The implementation should parse response headers and body separately. `gh` is a
transport/auth helper; event derivation must live in the connector.

## Event Mapping Debug

For a raw GitHub webhook:

1. Identify `X-GitHub-Event`.
2. Read payload `action` and relevant state fields.
3. Map to Ravi event type through the connector table.
4. Confirm subject is `ravi.watch.github.<event-type>`.
5. Confirm dedupe key is semantic and stable across webhook retries.

Examples:

- `pull_request` + `closed` + `merged=true` -> `pull_request.merged`
- `workflow_run` + `completed` + `conclusion=failure` -> `workflow_run.failed`
- `watch` + `started` -> `star.created`

## Poll Fidelity Debug

When a local watch misses an event, classify the event first:

- `full`: should be a bug if the endpoint returned the object.
- `derived`: inspect cached prior state and transition detection.
- `best_effort`: verify whether the event is inherently lossy under polling.
- `webhook_only`: move the watch to Console placement.
