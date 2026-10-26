# Turn Output — Checks

Checks are written against `SPEC.md` (id `sessions/turn-output`). A check is expected to
fail before the fix lands, and to stay as a regression test after it.

## Materialization

- [ ] A codex turn with three `commentary` items and one final answer yields four history rows; three carry the commentary class and one is final.
- [ ] A turn with two `commentary` items that then fails with `provider_inactive` yields two history rows plus one turn record with `reason` and usage.
- [ ] A session with no bound chat materializes every utterance and performs zero external deliveries.
- [ ] A failed send leaves the materialized row byte-identical (content, class, order, provider session id).
- [ ] Replaying the same utterance inside a turn yields one row; a new utterance that merely resembles an older one yields its own row.

## Delivery vs content

- [ ] `unresolved` produces one log line and no content loss (grep: the utterance exists in history).
- [ ] A blocked or failed turn is not reported as idle: `sessions read` shows the text, and the task observer sees activity.
- [ ] An utterance materialized from a failed turn is readable by recap and by the observer.

## Run health and usage

- [ ] A turn that fails with `provider_inactive` persists the reason and the usage it received.
- [ ] Usage not reported by the provider is persisted as `NULL` and rendered as `unknown`, never `0`.
- [ ] `sessions info` prints `unknown` for a turn with `NULL` usage.
- [ ] A token-summing aggregate skips `NULL` rows and reports an `unknown` count instead of adding zero.
- [ ] `systemSent` and token counters are not the only evidence of activity: a session with rows and no counters is not reported as idle.

## Validation commands

- `bun test src/runtime/assistant-transcript.test.ts`
- `bun test src/runtime/`
- manual: run a task against a provider with commentary phases and inspect `~/.ravi/chat.db` for the work session.
