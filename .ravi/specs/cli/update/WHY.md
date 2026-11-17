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
