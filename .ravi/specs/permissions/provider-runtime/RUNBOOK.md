# Permission Provider Runtime / RUNBOOK

## Bash Literal Refusal Or Script Execution

Determine which characters the shell evaluates before changing permissions.
Single quotes suppress expansion; double quotes still evaluate dollar-paren and
backticks. Quote JSON/search arguments for the shell as well as for their target
tool. A quoted heredoc delimiter does not remove the heredoc operator itself.

Run `bun test src/bash/` in isolated test state. Inspect parser and hook decisions
for the exact command without placing secrets in logs, test fixtures or reports.
Unsupported expanded quoting and malformed quoting fail closed. Identity/env,
session, executable and redirect checks still apply independently.

If a file-based interpreter script passes, do not report the syntax guard as
confining its effects. Review the executable grant and the host execution boundary.
Do not inspect script text with heuristic deny patterns or broaden permissions
to cure a quoting false positive. Real confinement remains a follow-up contract.

## Recover A Mixed-Version Channel Runner

Use this sequence when channels fail after an update because a stale channel
runner still expects storage retired by the new bundle:

```bash
ravi channels stop
ravi daemon restart -m "recover mixed-version runtime"
ravi channels start
```

Do not recreate retired permission tables. Confirm that both managed processes
that were online before the update return online and that a new inbound channel
turn completes without a schema error.

## Validate Update Coordination

```bash
bun test src/cli/commands/update.test.ts src/router/router.test.ts
bun run typecheck
bun run build
```

The updater must preserve the pre-update running set, stop channel intake before
the daemon transition, and report any managed process that does not return
online.
