# Runtime Model Presets Rationale

## Why Indirect References

Copying a model selector into every agent row makes rotation an O(agents)
migration and drifts silently when one row is missed. A preset reference keeps a
single source of truth: agents point at a preset id, and the effective model is
resolved at runtime. Two or more agents referencing one preset always resolve
the same effective model, and rotating the preset updates all of them at once
without touching agent rows.

## Why the Provider Is Immutable

A preset's provider defines the runtime adapter, model catalog, and validation
rules for its model selector. Allowing the provider to change would silently
invalidate the stored model and every referencing agent's runtime assumptions.
Keeping the provider immutable in this first version makes preset mutation a
narrow, safe operation: only the model and enabled flag move, and each move bumps
the version exactly once. Changing provider is an explicit create-new-preset plus
reassign flow.

## Why Next-Turn Application

An in-flight turn already resolved its model. Interrupting it to swap models
would corrupt the turn's context and traces. Instead, a preset update commits,
emits `ravi.config.changed`, and the next unshadowed turn recomputes the
effective model and applies it with the provider's existing direct-set or
restart-next-turn strategy. This keeps model changes observable and ordered
without mid-turn switching.

## Why Mutual Exclusion With Direct Model

Supporting both a direct `model` and a `modelPresetId` on the same agent creates
an ambiguous effective model. The two are mutually exclusive: assigning a preset
clears the direct model, and writing a direct model clears the preset, both in
one transaction. Legacy rows that still carry both prefer the direct model and
emit an observable warning so the drift is diagnosable rather than silent.
