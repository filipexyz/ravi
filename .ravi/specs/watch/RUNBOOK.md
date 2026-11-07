# Watch / RUNBOOK

## Publish Or Reconcile A PR

From the publishing Ravi session and clean committed worktree:

```bash
ravi pr publish --repo owner/repo --base dev --title "Fix description" --body-file /tmp/pr-body.md --dry-run --json
ravi pr publish --repo owner/repo --base dev --title "Fix description" --body-file /tmp/pr-body.md --execute --json
```

This command uploads verified Git objects, advances the work branch without
force, creates/reuses a ready PR, and reconciles CI follow through the shared
primitive. Success requires the existing live runner to confirm its local CI
producer and loaded trigger configuration. The JSON result includes both
SHAs, PR URL and watch/trigger IDs. See `cli/pr` for limits and error recovery.

After a partial failure, repeat with the same `--expect-sha` in the same session.
The PR/follow are reused; do not create another trigger or alter Review Gate.
Independent current-head approval remains required before merge.

An older selected follow ending in `ravi.watch.github.*` is repaired in place
to `ravi.watch.github.>` during reconciliation. The former cannot receive the
two-token PR/CI event suffixes in NATS. After updating the runtime, republish
each affected PR from its owning session to repair its existing subscription.

## List Connectors

```bash
ravi watch connectors
ravi watch connectors --json
```

Check local and Console placement support before creating a watch.

## Create A Watch

Examples:

```bash
ravi watch create npm @scope/pkg --event package.version_published
ravi watch create github owner/repo --event release.published
```

The command should print:

- watch id;
- connector;
- placement;
- event subjects;
- next trigger command.

## Attach A Trigger

From a group chat, prefer the watch helper when available:

```bash
ravi watch trigger <watch-id> --event release.published --message "Resume a release e diga se precisamos agir." --execute
```

Without `--execute` the command is a dry-run (exit 3) that only prints the
resolved trigger plan; nothing is created.

Equivalent low-level form:

```bash
ravi triggers add "GitHub release" \
  --topic "ravi.watch.github.release.published" \
  --filter "data.watchId == '<watch-id>'" \
  --message "Resume a release e diga se precisamos agir."
```

## Debug Events

Subscribe broadly while debugging:

```text
ravi.watch.>
```

For Console-produced watches, also inspect Console delivery. Current commands
may still be compatibility aliases:

```bash
ravi inbox status
ravi inbox items --limit 25
```

## Disable

```bash
ravi watch disable <watch-id>
ravi triggers disable <trigger-id>
```

Disabling a watch stops event production. Disabling a trigger only stops the
chat reaction; the watch may continue producing events for other consumers.
