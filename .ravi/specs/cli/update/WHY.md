# Package update and managed runtime reconciliation / WHY

Package replacement changes disk files, while running daemon and channel
runner processes retain their loaded code. Treating installation alone as an
update leaves native intake on an older build indefinitely. Explicit package
updates therefore own the restart of online siblings and verify their boot
identity. A status check or env write only reports drift because neither
operation asks to interrupt intake.

Keeping the PM2 interpreter inside the replaceable package made an installation
remove the very launcher needed for recovery. PM2 also treats any interpreter
path containing `bun` as Bun, including the directory name `bundle`. A constant
`/bin/sh` command with the exact Bun executable supplied separately avoids both
failures without relaxing the process-identity boundary. Direct registration
also preserves PM2's forced standby behavior during supervised replacement.

Real-state protection exposed an independent bootstrap dependency: local CLI
authorization tried to initialize the database before it could repair the daemon.
Stateful commands should use the existing authenticated gateway; local recovery
uses the already-defined operator authority without opening runtime storage.

PM2 writes its manager/client version mismatch banner to stdout before the
`jlist` JSON. Parsing the entire output failed updates/status and hid identity
from other consumers. Separately, requiring a default manager PID file refused
an installed daemon even after the banner was removed. The shared parser and
the state-boundary parent verification address these independent dependencies;
the installed launcher remains direct, with the same identity checks.

## Detached execution (19/11/2026)

`pm2 delete ravi` tree-kills every descendant of the daemon. A `detached`
child does not escape that: it still has a parent inside the tree. On
19/11/2026 an agent ran `ravi update` from inside its session on a client's
server. The supervisor deleted `ravi-channels` and `ravi`, died with the
daemon before starting the replacements, and left PM2 with neither process.
`ravi daemon restart` already solved this with a two-step handoff, where the
intermediate exits so the worker is reparented. The update now uses the same
shape. The env-based `CLI_ONLY` refusal did not prevent this, because a caller
inside the tree does not always carry `RAVI_CONTEXT_KEY` (a provider that
filters `RAVI_*`, a cron shell job, a hook). The tree check is the precise
condition. The supervisor's own refusal covers a CLI installed before this
change: that CLI starts the supervisor wherever it runs. Refusing leaves the
previous runtime running, and the next run uses the CLI that was just
installed.

## Snapshot and rollback (19/11/2026)

The VPS report ended with both processes in a restart loop and the question
"is there a command that goes back to the previous version?". The rule until
then forbade any automatic database or package downgrade, for a good reason:
an older release must never run on a state a newer one migrated, and a
database restore without its package changes nothing. Restoring both together,
from a snapshot taken while no daemon owned the stores, is the safe form of
that downgrade: the previous release runs on exactly the state it last wrote.
The locks prove that no daemon writes during the copy; a CLI writing from a
terminal at that moment is not excluded.

The snapshot needs a moment with no owner, after the predecessor's last write
and before the target's first. Coordinated replacement has no such moment,
because the successor takes ownership the instant the predecessor exits. So an
update that can roll back stops both processes first. The cost is the target's
boot time added to the downtime, plus the copy itself on a filesystem without
clones (seconds per gigabyte), with the channel runner stopped too. A target that cannot boot at
all now goes through a rollback, with a reinstall, instead of leaving the
predecessor running. `ravi daemon restart` keeps the coordinated cutover.

The previous release starts through its own CLI because only that release
knows its launcher and registration. What the target wrote during the attempt
leaves the live state, Thread records included: its files are kept in
`candidate/`, not deleted, and the result names the window. Copy-on-write
clones make the snapshot nearly free on APFS, btrfs and XFS. On ext4 it is a
full copy, so the space check refuses before anything stops instead of finding
a full disk afterwards.
