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

## Arbitrary execution and restricted syntax

An executor already authorized for every executable can run a script file with
arbitrary host effects. Refusing only the equivalent inline shell form adds
operational failures without establishing a sandbox. The restricted parser stays
useful for named-executable contexts; the effective wildcard decision must include
the issued context's limits and live reductions, not just the agent profile.
Syntax-policy failures need their own diagnostic so operators are not encouraged
to add an executable grant that cannot resolve that policy refusal.

## Every tool name is checked

The Claude tool hook used to check only names from Ravi's own registry of
built-in tools. Everything else passed: tools of MCP servers that Claude Code
loads from `.mcp.json`, plugins or user configuration, the MCP resource readers,
and built-in tools added after the registry was written (`Monitor`,
`CronCreate`, `RemoteTrigger`, `Workflow` and others). A `chat-only` or
`explicit-only` agent could call them, and so could a turn with no capabilities
at all. A registry cannot keep up with a runtime that ships tools every
release, so the check is by the reported name, with no registry in between.
Turns that hold `use:tool:*` (a bootstrap agent at its full ceiling) see no
change. Turns narrowed below it lose MCP tools and tools outside the registry
unless granted: a sender with no contact, a request turn, a governed chat whose
grants name specific tools.

Host tools are exempt by provenance, not by name. A live session showed a
project server named `spec` and the in-process `spec` server running side by
side, both answering under `mcp__spec__`; only the `source` the runtime reports
tells them apart.

The same session showed that a PreToolUse hook that throws does not block: the
tool ran. A permission hook that fails while reading state must therefore
answer with a denial itself.

A grant such as `use:tool:mcp__github__*` is a prefix on the tool name. Binding
it to the reported server name was considered and left out: the name is
whatever the runtime's configuration says, so a second server can take it, and
the binding would promise an identity the runtime does not give. Choosing
which servers exist belongs to the registry of servers Ravi loads itself.

## A mention is not a tool call

With every tool denied, a live Claude Code session still answered with the
content of a file outside the agent's `cwd`, because the prompt held
`@/abs/path`: Claude Code read the file while building the turn and no
PreToolUse event fired. The same happened when the path sat inside chat-shaped
text. `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1` stopped it in the same session and
left `@AGENTS.md` imports in `CLAUDE.md` working. `@server:uri` mentions of MCP
resources did not resolve in three live runs on Claude Code 2.1.323 (also after
the resource list was loaded in the same process); the switch does not cover
them, so the live check repeats that run on every SDK upgrade.
