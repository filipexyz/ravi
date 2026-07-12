# Agents Rationale

## Why Agents Are Distinct Identities

An agent is Ravi's unit of execution identity: behavior, working directory,
provider configuration, and an authority ceiling. Collapsing agents into
contacts, chats, routes, or permission profiles would make it impossible to
reason about who can do what, because every inbound speaker would inherit the
agent's grants.

Keeping the agent separate lets grants act as a ceiling rather than ambient
authority for anyone who can message the agent.

## Why Visibility Is Authorization-Bearing

Agent list/show/picker/route-selection surfaces are not just cosmetic. Hidden
agents and their configuration are sensitive, so visibility filtering is
enforced with `view agent:<id>` instead of trusting broad operator grants. A
superadmin executor invoked by an untrusted contact must not leak hidden agents
simply because the executor holds wide grants.

## Why Model Presets Are Referenced Indirectly

Agents reference a runtime model preset by id (`model_preset_id`) rather than
copying its model selector. This keeps one selector centrally managed and
rotatable without editing every agent row. A direct `model` and a
`modelPresetId` are mutually exclusive so an agent has exactly one source of
truth for its model, resolved by the canonical resolver. See
`runtime/model-presets`.
