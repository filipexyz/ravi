# Why

## The incident (2026-11-13)

A Slack thread was created with `--provider claude --model fable-5-2`. The
command accepted the write: the cross-vendor heuristic (`modelProviderMismatch`)
only checks that a model does not obviously belong to another runtime, and
`fable-5-2` looks Claude-shaped. The installed runtime did not know the model,
so the thread died on its first turn with a masked error that never named the
real cause. Reconstructing "the model name was wrong" cost a human debugging
session.

Two structural gaps compounded:

1. Validation checked vendor shape, not existence. Nothing compared the value
   against what this installation can actually run.
2. Nothing proved a runtime change before the user's next real message paid
   for it.

## Why catalog-driven, not a second list

The runtime catalog (`src/runtime/model-catalog.ts`) already answers "which
models does this installation offer" for selection menus. Validation consumes
the same source so there is exactly one place that ages when an SDK bump adds
models (the bump PR updates the catalog beside it). A private allowlist inside
the validation layer would drift from the catalog and reintroduce the original
failure with two owners instead of one.

## Why apply → probe → rollback (not probe-first)

The probe must prove the runtime the next turn will launch with — the one
`resolveEffectiveSessionRuntime` computes from PERSISTED state, including
layering against agent defaults and presets. Probing the persisted result
catches persistence and resolution bugs that probing a hypothetical tuple
would miss. Rollback is cheap because only the four override values are
written before proof; destructive steps (clearing provider continuity,
rematerializing) wait until after the probe.

## Why the probe is out-of-band

Running the probe through the session itself would post into the user's chat,
consume the session's provider continuity, and race its queue. The probe
spawns the provider directly with a scratch cwd and no tools: same provider
binary, same credential pool, none of the session's state.
