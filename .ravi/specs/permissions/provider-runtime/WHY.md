# Permission Provider Runtime / WHY

The previous native permission graph made every protected surface depend on one
policy shape. The provider runtime keeps Ravi core policy-agnostic: core
resolves context, calls providers, composes decisions, and records audit
metadata.

Provider-owned config is now the supported path for subject authority. For
agents, that means `agent.defaults.runtimePermissions` managed by
`ravi agents permissions`.

This boundary lets apps, contacts, agents, automations, and future enterprise
providers own their policy without reintroducing hidden authorization paths in
core runtime code.
