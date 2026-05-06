---
id: commands
title: "Ravi Commands Runbook"
kind: domain
domain: commands
status: draft
normative: false
---

# Ravi Commands Runbook

## Add a Global Command

```bash
mkdir -p ~/.ravi/commands
$EDITOR ~/.ravi/commands/review-pr.md
ravi commands validate --json
```

Invoke it from a session or channel:

```text
#review-pr 123 high
```

## Add an Agent Command

Use the agent's configured `cwd`:

```bash
mkdir -p <agent.cwd>/.ravi/commands
$EDITOR <agent.cwd>/.ravi/commands/review-pr.md
ravi commands validate --agent <agent> --json
```

If the same command exists globally, the agent command shadows it.

## Inspect Resolution

```bash
ravi commands list --agent <agent> --json
ravi commands show review-pr --agent <agent> --json
ravi commands run review-pr --agent <agent> -- 123 high
```

Check:

- selected source scope;
- source path;
- whether another command is shadowed;
- frontmatter warnings;
- duplicate ids.
- `run` returns the composed prompt preview and does not dispatch to any session.

## Debug an Unknown Command

Unknown commands are passed through as ordinary chat text. If a `#name` did not expand:

1. Confirm the message starts with `#name`.
2. Confirm the name matches `[A-Za-z0-9][A-Za-z0-9-]{0,63}`.
3. Run `ravi commands list --agent <agent> --json`.
4. Check the agent `cwd` and `$RAVI_HOME`.
5. Run `ravi commands validate --agent <agent> --json`.

## Debug a Bad Prompt

1. Run `ravi commands show <name> --agent <agent> --json` and inspect the rendered preview.
2. Check placeholder spelling: `$ARGUMENTS`, `$ARGUMENTS[0]`, `$0`, or named args declared in `arguments`.
3. Inspect `ravi sessions trace <session> --json` for command metadata.
4. Confirm the composed prompt, not the raw command text, was dispatched.

## Disable a Command

Set frontmatter:

```yaml
---
disabled: true
description: Temporarily disabled.
---
```

Disabled commands remain visible in `list/show` but fail before dispatch.
