# Stickers agent-first CLI contract / WHY

Stickers split cleanly along the Manual v2 risk axes. `send` reaches a real
person on a live channel and cannot be unsent — the same class as a WhatsApp
DM, so it gets the same brake. `remove` deletes a catalog entry with no undo
and no soft-delete; braked. `add` is the inverse of `remove` and purely local;
unbraked, because braking reversible local config would only add friction to
catalog curation.

The ordering inside `send` was the subtle part: `buildStickerSendEvent` is
simultaneously the validator (channel capability, enabled flag, per-channel and
per-agent allowlists) and the event builder. Keeping it BEFORE the brake means
exit 3 is only ever shown for sends that would actually succeed — an agent on a
Matrix channel gets the capability error (exit 1) instead of a dry-run plan for
an impossible send. The plan deliberately omits the raw event payload (paths,
mime internals) and shows the operator-relevant facts: sticker id/label, target
chat, filename.

This domain has the widest teaching surface of the batch: the sessions action
hints AND a dedicated prompt section (`stickers/prompt.ts`) inject the send
command into live agent prompts. Both now carry `--execute`; a stale consumer
is the main regression risk, which is why both files are in applies_to.

`STICKER_NOT_FOUND` suggestions come from the local catalog file — zero-cost,
and typo-level misses ("wav" for "wave") resolve in one retry.
