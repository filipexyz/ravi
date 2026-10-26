# Turn Output — Why

## Problem

A turn produces text. Today three separate concerns are decided together, so
they fail together:

- **materialization**: does the text become a durable history row?
- **delivery**: does a chat receive it, and which one?
- **run health**: did the turn finish, and with what usage?

When delivery gates materialization, a session with no bound chat keeps no
history. When a provider separates `commentary` from final answer, a turn can
do real work and still leave no durable trace, because only the final block was
ever considered content. The observer and recap then read history and counters,
see nothing, and conclude no work happened.

The failure is structural, not a single missing `if`. Conflating content with
delivery and with run health means any one of them can erase the other two.

## Design Choice

Separate the three concerns and give each one an owner.

- Materialization belongs to turn output: every non-silent utterance becomes a
  history row, whatever its class.
- Delivery belongs to `sessions/attach`: it decides which chat, if any,
  receives an utterance, per utterance and per binding.
- Run health belongs to the runtime/provider: terminal state and usage are
  recorded independently of content.

The core rules are:

- **materialization is never conditioned on delivery**; `unresolved` means "no
  external target", not "discard the text";
- **commentary is persisted** as history with its class, and is readable by
  recap, observer, task observer and `sessions read`;
- **run health never reclassifies or erases** materialized text;
- **a missing measurement is not a zero**: usage the provider did not report is
  persisted as `NULL` and rendered as `unknown`;
- **dedupe is same-turn only**: an exact replay inside a turn does not create a
  second row, but a new utterance that merely resembles an older one is kept.

## Why Commentary Is History

A provider that emits one message per completed item produces intermediate
blocks (`commentary`) before the final answer. Discarding them loses the only
record of a long tool loop. They are not a hidden channel and not a private
scratchpad: they are what the turn actually said.

Keeping them has a cost: history gets noisier and a consumer must not mistake a
`commentary` row for the turn's final answer. The class column carries that
distinction. A turn that ends without a `final` block is marked `incomplete`
rather than appearing empty.

## Why Usage Is `NULL`, Not `0`

`totalTokens=0` and `0` counters are a measurement: the provider said the turn
used no tokens. Absence of a measurement is different. Coercing it to `0` makes
a turn that did work look like a turn that did nothing, and every token-summing
aggregate silently undercounts.

So usage a provider did not report is persisted as `NULL` and rendered as
`unknown`. Consumers that sum treat `NULL` as unknown and never add it as zero.
If a numeric field is required, the override is an explicit `usage_state`
(`reported | unknown`), never a sentinel `0`.

## Why Dedupe Is Same-Turn Only

Replay of the same utterance inside one turn must not create duplicate rows.
But dedupe generalized from replay is dangerous: it can swallow a genuine new
utterance that happens to repeat an earlier one. The rule is deliberately
narrow — exact same-turn replay only.

## Alternatives Considered

- **Keep conflating delivery and content**: rejected. It is the bug.
- **Persist only the final block**: rejected. Commentary-only turns then leave
  no history, which is exactly the failure this capability exists to prevent.
- **Emit commentary to chat only**: rejected. Sessions without a chat have no
  projection target, so the text disappears.
- **Default missing usage to `0`**: rejected. It recreates the false-negative
  signal this contract removes.
- **Dedupe across turns**: rejected. It hides legitimate repeated utterances.

## Tradeoffs

- History grows with commentary rows, so consumers must read the class.
- Run health becomes a separate record that readers must consult; rows alone do
  not say whether the turn completed.
- Nullable usage widens the type of token counters and forces aggregates to
  handle `unknown` explicitly.
- Delivery resolution runs per utterance and per binding, which is more work
  than resolving once, but it is the only way to keep delivery from deciding
  content.

## Expected Impact

- A multi-minute tool-loop turn leaves a materialized transcript, not an empty
  session.
- A failed or interrupted turn keeps the text it produced and is marked, so no
  consumer mistakes silence for idleness.
- `sessions read` shows what a failed turn said; `sessions info` reports the
  provider's usage when it was reported, and `unknown`/`null` when it was not.
- Missing chat delivery suppresses external delivery only; history is intact.
