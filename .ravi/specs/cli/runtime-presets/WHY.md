# Runtime presets agent-first CLI contract / WHY

Presets arrived at this wave already carrying a safety design of their own:
opt-in `--dry-run` previews on every risky mutation, versioned rotation on
`set`, and a store-level guard that refuses to disable or delete a preset any
agent still references (pointing the operator at `impact` instead). The wave's
standard brake (`--execute`, exit 3) is dry-run-by-DEFAULT; the local pattern
is dry-run-by-CHOICE. Converting `delete` to the standard brake was considered
and rejected: the normative model-presets spec, its RUNBOOK and CHECKS all
teach the `--dry-run` flow verbatim, the reference guard already makes the
genuinely dangerous case (deleting a preset in use) impossible regardless of
flags, and renaming working safety flags breaks callers for zero safety gain.
The contract here documents the equivalence instead of forcing uniformity —
same decision the wave made for `context prune`'s `--apply --confirm`.

What the domain lacked was a machine-readable not-found surface. The store
raises `RuntimeModelPresetError` with a human `nextCommand` hint for every
guard, which is great for operators and useless for agents branching on error
codes. The migration splits that error family: the `^Model preset not found:`
case becomes the `PRESET_NOT_FOUND` envelope with live id suggestions; every
other guard (referenced preset, invalid id, immutable provider) keeps the
legacy text + hint, because those are argument errors the agent caused, not
entity lookups it can retry with a suggestion.

One naming footnote: this domain's "presets" hold no secrets, so the wave's
anti-leak invariant reduces to the general rule that envelopes carry ids only
— proven in the tests by asserting the description text never leaks into the
envelope.
