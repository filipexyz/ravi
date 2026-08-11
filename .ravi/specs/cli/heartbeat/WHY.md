# Heartbeat agent-first CLI contract / WHY

Manual heartbeat triggering is an execution request, not a routine local
write. When `HEARTBEAT.md` contains work, `heartbeat trigger` queues a prompt
for an agent session and therefore uses the same risk-based confirmation rule
as other dispatched runs.

The command still avoids needless friction. It validates the agent and reads
the local heartbeat file first. Missing or empty files return `skipped` with
exit 0 and do not require `--execute`. Only a trigger that would actually
queue work returns the exit-3 dry-run and asks the caller to repeat with
`--execute`.

`enable`/`disable` remain a reversible pair, and every `set` property has an
obvious inverse. Those configuration writes remain immediate. The domain also
keeps the shared contract for typed errors, exit taxonomy and compact
`--fields` discovery.
