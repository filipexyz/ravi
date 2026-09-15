# Settings agent-first CLI contract / WHY

`ravi settings` mutates live daemon configuration: `defaultAgent`, DM/group
policies, timezone, task-session TTLs. A wrong `delete` silently changes
runtime routing/policy behavior for every channel the daemon serves, and there
is no undo — the previous value is gone unless someone remembers it. That is
why `delete` is the single braked op: dry-run by default, and the plan echoes
the key plus `valuePresent` so the caller can confirm what will be erased
before passing `--execute`. The value itself is omitted because custom settings
may contain credentials or other secrets.

`set` deliberately stays unbraked:

- it is the most-taught command of the domain (AGENTS.md, docs, skill) and its
  effect is reversible by re-setting or deleting the key;
- known settings are validated before the write (agent existence, enum values,
  timezone, durations), so the common failure mode is already caught;
- braking it would add exit-3 friction to the primary configuration loop
  without protecting anything irreversible.

Immediate execution does not make the value public: `settings set` declares
`value` as redacted audit input, and the shared sanitizer also recognizes a
secret-bearing sibling `key` such as `custom.password`. The two layers keep
CLI, tool and gateway audits safe even if one caller omits metadata.

Not-found semantics required a distinction the old code did not make: known
settings may legitimately be unset (reads show their default), and legacy
`account.*` rows carry a migration hint. Only keys that are unknown AND unset
are true not-founds — those now return `SETTING_NOT_FOUND` with suggestions
drawn from the union of known keys and set keys, so a typo like `defaultAgnt`
points back to `defaultAgent` instead of printing a soft "not set" that agents
mistook for state.
