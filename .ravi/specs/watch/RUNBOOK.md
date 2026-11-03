# Watch / RUNBOOK

## Publish Or Reconcile A PR After Git Data API Upload

From the publishing Ravi session and committed worktree, after verifying the
uploaded Git tree and commit against the local SHA:

```bash
bun scripts/publish-pr.ts --repo owner/repo --base dev --title "Fix description" --body-file /tmp/pr-body.md
```

This command validates the branch SHA, creates a ready PR (or finds the existing
one for that head/base), and registers its CI follow with the shared primitive.
The JSON result reports PR, SHA, watch and trigger. Inspect the returned trigger
and local watch to confirm routing and active CI coverage. It does not upload
Git objects or replace commit hooks.

If publication fails after creating a PR, run the identical command again in
the same worktree/session. The PR and trigger are reused; a legacy draft is
promoted only after its follow exists. Do not repair this by making another
trigger or by editing Review Gate policy. Unrelated PRs are never reconciled by
this command. Missing independent approval remains a legitimate review blocker.

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
