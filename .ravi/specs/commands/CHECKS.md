---
id: commands
title: "Ravi Commands Checks"
kind: domain
domain: commands
status: draft
normative: false
---

# Ravi Commands Checks

## Unit Coverage

- Parser accepts `#abc`, `#abc-123`, mixed-case input, and trailing arguments.
- Parser rejects empty names, underscores, slashes, dots, colons, spaces inside the name, leading hyphen, and names longer than 64 chars.
- Parser only treats the first non-whitespace token as a command.
- Resolver loads `$RAVI_HOME/commands/*.md`.
- Resolver loads `<agent.cwd>/.ravi/commands/*.md`.
- Resolver reports duplicate ids within the same scope.
- Resolver reports shadowed global commands when an agent command has the same id.
- Renderer substitutes `$ARGUMENTS`, `$ARGUMENTS[0]`, `$0`, and named placeholders.
- Renderer appends `ARGUMENTS: ...` when arguments exist and no placeholder is present.
- Unsupported frontmatter cannot affect tool permissions, model, effort, thinking, hooks, or shell behavior.

## Integration Coverage

- Channel message `#command args` dispatches one composed prompt to the resolved session.
- CLI/session message `#command args` follows the same path as channel messages.
- `ravi commands run <name> -- <args>` returns the composed prompt preview and does not dispatch to a session.
- Unknown command passes through as ordinary chat without command expansion.
- Invalid command name fails before provider handoff.
- Disabled command fails before provider handoff.
- Editing a command file changes subsequent invocations without daemon restart.
- Session trace records command id, scope, source path, original text, rendered prompt hash, and argument string.
- Durable user message stores the composed prompt or enough metadata to reconstruct the composed prompt.

## Suggested Commands

```bash
ravi commands validate --json
ravi commands list --agent dev --json
ravi commands show review-pr --agent dev --json
bun test src/commands
bun test src/runtime/session-dispatcher.test.ts src/runtime/session-trace.test.ts
bun run typecheck
bun run build
```
