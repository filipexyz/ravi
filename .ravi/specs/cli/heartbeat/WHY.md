# Heartbeat agent-first CLI contract / WHY

Heartbeat is the one migrated domain where the right number of write brakes is
zero. The instinct is to brake `trigger` because it "fires an agent" — but
unlike `tasks dispatch` (which starts real tracked work in another session) or
`watch trigger` (which arms a durable automation), `heartbeat trigger` fires
the agent's OWN heartbeat: it reads `HEARTBEAT.md`, runs the standing
check-in, and the runtime suppresses the output entirely when the agent
answers `HEARTBEAT_OK`. It is also a frequent operational action — operators
and agents use it to test heartbeat config (`ravi heartbeat trigger main` +
`ravi daemon logs -f`) — so exit-3 friction there would tax the routine path
daily while protecting nothing destructive: the worst case of a stray trigger
is one extra benign check-in.

`enable`/`disable` are the textbook reversible pair, and every `set` property
(interval, model, account, active-hours) has an obvious inverse value. Nothing
in this domain deletes state or reaches an external provider.

The migration value here is the rest of the contract: unknown agents now
return the `AGENT_NOT_FOUND` envelope with live suggestions instead of plain
text, usage errors exit 2 with `acceptedFlags`, and `status --fields` gives
compact discovery. Declaring the no-brake decision explicitly (with this
rationale) is part of the contract — future waves should not "fix" it by
adding `--execute` here.
