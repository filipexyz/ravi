# Turn Output — Runbook

> **Status: contract proposed, code not yet corrected.** This runbook describes
> how to inspect and validate the `sessions/turn-output` contract. The runtime
> fix has not landed, so the checks below are expected to fail until it does.
> Do not treat unverified output as real data, and do not "fix" a failure by
> discarding text.

## Read the Rules First

```bash
ravi specs get sessions/turn-output --mode rules --json
```

If the spec is not resolvable remotely, read it from the worktree filesystem and
do not change runtime permissions to make the wrapper work.

## Inspect a Turn's Text

1. Identify the session and turn.
2. Read the turn's history:

   ```bash
   ravi sessions read <session> --json -n 50
   ```

3. For each assistant utterance, confirm:
   - a durable history row exists;
   - the row carries its class (`final` or `commentary`);
   - delivery outcome did not remove, rewrite, or reorder the row.
4. A `commentary` row is visible in history but is not the turn's final answer.
   Do not count it as one.

## Check Commentary-Only Turns

A turn that produced only `commentary` and then failed or was interrupted must
still have history.

1. Confirm the rows exist.
2. Confirm the turn record carries its terminal reason
   (`provider_inactive`, `turn.failed`, `turn.interrupted`) and its usage.
3. Confirm the turn is marked `incomplete`, so a reader does not conclude that
   no work happened.
4. Confirm `recap`, the observer and the task observer can see the text, not
   just tool calls or counters.

## Check Delivery Separation

A session with no bound chat must materialize everything and deliver nothing.

```bash
ravi sessions subscriptions <session> --json
ravi sessions read <session> --json -n 20
```

- Zero active chats is `unresolved`, not a content drop.
- There is one `unresolved` log line, and every utterance is still in history.
- A delivery failure leaves the row byte-identical; attempts and outcomes are
  recorded separately from content.

## Check Usage Honesty

1. Read `sessions info` for the turn.
2. If the provider reported usage, counters reflect it.
3. If it did not, counters are `unknown`/`null` — never `0`.
4. In an aggregate that sums tokens, a window with an unknown-usage turn must
   report the same total as the same window without it, plus an `unknown` count.

Do not coerce `NULL` to `0` to make a report tidy; that recreates the original
false negative.

## Check Dedupe

- Replaying the same utterance inside one turn yields one row.
- A new utterance that merely resembles an older one yields its own row.
- If a real utterance disappeared, treat it as a dedupe overreach, not as
  expected behavior.

## Validation Commands

These are the contract's validation entry points. They are expected to be
red before the runtime fix:

```bash
bun test src/runtime/assistant-transcript.test.ts
bun test src/runtime/
```

Manual check after the fix lands: dispatch a task to a provider that separates
`commentary` from final answer, then confirm the work session has history rows
in `~/.ravi/chat.db`. Reading the database is an inspection of local state, not
a substitute for the spec rules.

## Failure Triage

- **Session looks idle but work happened**: check history rows before trusting
  counters (`systemSent`, tokens). A consumer that reads only counters is the
  bug, not the evidence.
- **Text is missing after a failed send**: materialization was gated on
  delivery. That is a contract violation.
- **Counters say `0` after a failed turn**: the provider usage was coerced.
  Persist `NULL` and render `unknown`.
- **A repeated real utterance vanished**: dedupe was generalized beyond
  same-turn replay.
- **A watchdog turned into a data-loss path**: run health leaked into content
  decisions; it must only end the turn and record the reason.
