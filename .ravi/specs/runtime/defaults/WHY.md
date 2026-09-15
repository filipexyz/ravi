# Runtime Defaults Rationale

`RAVI_MODEL` (and similar env) used to behave like the live default. That made
it impossible to change the next-turn engine from SQLite without a restart, and
it let env silently win over a stored agent, session, preset, or setting.

Settings already own global daemon configuration and already emit
`ravi.config.changed`. Reusing `runtime.defaultProvider`,
`runtime.defaultModel`, and `runtime.defaultEffort` avoids a fifth override
namespace while giving operators one obvious runtime method.

Provider and model stay independent: selecting a provider does not invent a
catalog model, and selecting a model does not imply a provider. Display and
launch share one resolver so `sessions info` cannot lie about the next turn.
