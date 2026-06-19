# Work Objects Runbook

## Inspect

```bash
ravi work-objects resolve --type task --id <task-id> --json
ravi work-objects action task <task-id> task.comment --value "comment" --json
ravi work-objects suggest task <task-id> status --json
```

## NATS Transport

Daemon-side listeners use these subjects:

```text
ravi.work_objects.resolve
ravi.work_objects.update
ravi.work_objects.action
ravi.work_objects.suggest
```

For compatibility with the first Omni integration, the daemon also accepts
`omni.work_objects.*` aliases. New consumers should use `ravi.work_objects.*`.

Requests should include a `replyTopic`. Replies are JSON with either:

```json
{ "ok": true, "providerId": "task", "result": {} }
```

or:

```json
{ "ok": false, "error": "message" }
```

## Troubleshooting

- If Slack renders only text, first verify the Omni Slack Work Object app
  settings and domain allowlist.
- If an object does not resolve, test the same reference through
  `ravi work-objects resolve`.
- If mutations fail, inspect `fieldErrors` before debugging transport.
