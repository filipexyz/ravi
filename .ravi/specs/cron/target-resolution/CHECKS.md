# Cron Target Resolution / CHECKS

## JSON List MUST Include Target Resolution

```bash
ravi cron list --json --limit 1 | jq '.items[0].targetResolution'
```

- Output MUST contain a `state` field with one of: `ok`, `agent_missing`, `reply_session_missing`, `derived_key`, `unresolved`.
- The `targetResolution` field MUST be present on every item. The check fails if any item lacks it.

## JSON List MUST Be Parseable

```bash
ravi cron list --json --limit 500 > /tmp/cron-list.json
node -e "JSON.parse(require('fs').readFileSync('/tmp/cron-list.json','utf8')); console.log('ok')"
```

- The command MUST print `ok` with no error. It fails if `JSON.parse` throws.

## Items and Jobs MUST Carry Equivalent Fields

```bash
ravi cron list --json --limit 5 | jq '[.items[0].targetResolution, .jobs[0].targetResolution] | .[0] == .[1]'
```

- The command MUST output `true`. It fails if `items[i].targetResolution` differs from `jobs[i].targetResolution`.

## Doctor Check MUST Emit Stable Finding IDs

```bash
ravi doctor --json | jq '.checks[] | select(.id == "cron.targets") | .data.findings[].id'
```

- Each finding id MUST be one of `cron.agent_missing`, `cron.reply_session_missing`, `cron.routing_derived_key`, `cron.routing_unresolved`. The check fails if an unexpected id appears.

## Shell Jobs Without Notification Targets MUST NOT Be Marked Stale

Given a shell cron with no `onError`:

```bash
ravi cron list --json | jq '.items[] | select(.executionType == "shell" and .onError == null) | .targetResolution.state'
```

- The state MUST be `ok`. The check fails if a shell job without a notification target is reported as `agent_missing`.
