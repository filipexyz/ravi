# Cron agent-first CLI contract / WHY

Cron jobs are standing instructions: an agent that misreads an id can delete a
schedule someone else depends on (`rm`), or — worse — fire a job right now that
was written to run at 9am against production (`run`). `cron run` is not "just a
test": it emits `ravi.cron.trigger` and the daemon executes the REAL job — a
real agent session or a real shell command — outside its schedule. That is why
`run` joins `rm` behind the write brake, mirroring `tasks dispatch` (the other
op that starts real agent execution).

`add`, `set`, `enable` and `disable` stay immediate: each has an inverse
(`rm --execute` undoes `add`, `disable` undoes `enable`, `set` overwrites
`set`), and braking the configuration loop would put exit-3 friction inside
every scheduling conversation without protecting anything irreversible.

Not-found envelopes cover every id-resolving op (not just `show`) because cron
ids are short opaque hashes that agents routinely mistype; the `suggestions`
list is built from the same REBAC-filtered listing as `cron list`, so the
envelope never leaks jobs the caller cannot see, and access-denied remains
indistinguishable from not-found — exactly as the legacy text path behaved.
