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

## Quoting-aware Bash checks

The old raw regex scan rejected literal search strings, JSON and code arguments.
Applying `stripShellQuoting` would not fix that: it retains the token text while
discarding the information needed to decide whether the shell evaluates it.
Double quotes also do not suppress command substitution.

Use a bounded lexical view for active operators and the existing `shell-quote`
dependency to decode executable/flag words. Retaining the old deletion of quoted
words would weaken enforcement once harmless quoted data is accepted: `ba"sh"`
and `python3 "-c"` must remain visible to their respective checks. No new parser
dependency, full shell grammar, file-content heuristics or permission change.

The product decision is to register interpreter scripts as an open capability
boundary, with a follow-up requirement for actual host confinement or trusted
immutable entrypoints before promising isolation. File Write is not a sufficient
security boundary: scripts may already exist, and granted executables have
their own file, network and subprocess effects. CLI contexts and session checks
still protect Ravi-mediated calls; they are not a general process sandbox.
