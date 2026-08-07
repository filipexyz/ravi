# Metrics agent-first CLI contract / WHY

Metrics reports on `daily_metrics`, a table whose entire content is derived:
every row can be recomputed from `cost_events` and `session_events` at any
time, per day, idempotently. That property decides the whole brake question —
there is nothing to protect. Worse, braking `rollup` would actively mislead:
the daemon refreshes the same table through the service layer every interval
(`src/ephemeral/runner.ts`), and `metrics show`'s own empty-state message
tells the user to run `ravi metrics rollup` — an exit-3 wall there would be
pure friction in front of an idempotent write.

What the domain did need was honesty in two places. First, `--by`: an invalid
dimension used to silently coerce to `agent-model`, so a typo like
`--by agents` produced a plausible report grouped the wrong way — the most
dangerous kind of wrong answer for an agent consumer, because nothing signals
the coercion. That is now a `USAGE_ERROR` with `acceptedValues`, fired before
any query. Second, `rollup` is authorized as `mutate` because it persists
derived rows. It remains unbraked because that persistence is local,
idempotent and recomputable. Exact legacy read grants receive the matching
mutate capability so authorization becomes honest without silently breaking
least-privilege callers.

`--fields` lands on `show` because that is the payload agents actually read
in loops (16 numeric columns per agent×model×day adds up fast). `dates`
returns bare strings — projection has nothing to project, declared as such
rather than pretending the flag exists everywhere.
