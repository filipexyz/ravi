---
id: commands
title: "Ravi Commands"
kind: domain
domain: commands
capabilities:
  - prompt-composition
  - file-registry
  - invocation
tags:
  - commands
  - prompts
  - runtime
  - agents
applies_to:
  - src/runtime
  - src/prompt-builder.ts
  - src/router
  - src/cli/commands
  - .ravi/commands
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi Commands

## Intent

Ravi Commands are user-invoked prompt templates. A command expands a Markdown file into a composed prompt and sends that prompt to the resolved Ravi agent through the normal session runtime.

Commands exist for short, repeatable workflows that do not need a full skill, task profile, or dedicated CLI. They are not shell commands and are not Ravi CLI subcommands.

## Command Syntax

- A Ravi Command invocation MUST start at the first non-whitespace character of a user message.
- The invocation prefix MUST be `#`.
- The command token MUST match `#[A-Za-z0-9][A-Za-z0-9-]{0,63}`.
- Command names MUST be canonicalized to lowercase for lookup and conflict detection.
- Command files SHOULD use lowercase ASCII filenames for portability.
- The command token ends at the first whitespace character. The rest of the message is the raw argument string.
- A syntactically valid `#command` token that is not registered MUST pass through as ordinary chat text.
- A message starting with `#` followed by an invalid command token MUST fail with a clear command-name error. It MUST NOT silently fall back to normal chat.
- A `#word` appearing later in a message is ordinary text, not a command invocation.

Examples:

```text
#review-pr 123 urgent
#deploy staging
#daily-summary
```

## Registry Locations

Commands are registered as Markdown files in `commands` directories:

```text
<agent.cwd>/.ravi/commands/<name>.md
$RAVI_HOME/commands/<name>.md
```

`$RAVI_HOME` defaults to `~/.ravi`.

Resolution order:

1. Agent command: `<agent.cwd>/.ravi/commands`.
2. Global user command: `$RAVI_HOME/commands`.

An agent command with the same canonical name MUST shadow the global command. The resolver MUST expose shadowing in list/show output.

Nested directories MAY be used for organization, but the command id is always the Markdown basename. For example, `.ravi/commands/review/pr.md` and `.ravi/commands/pr.md` both define `#pr`; duplicates inside the same scope MUST be reported as validation errors.

The filesystem is the source of truth. A database or generated index MAY cache command metadata, but it MUST be rebuildable from Markdown.

## File Format

Each command is a Markdown file with optional YAML frontmatter.

```markdown
---
description: Review a pull request with the local engineering checklist.
argument-hint: "<pr-number> [priority]"
arguments:
  - pr
  - priority
---

Review PR $pr with priority $priority.

Use the current repository instructions and report findings first.
```

Supported frontmatter for the initial implementation:

- `title`: optional display title.
- `description`: short description for list/autocomplete/help.
- `argument-hint`: human hint for invocation UI.
- `arguments`: optional ordered list of named positional arguments.
- `disabled`: when true, the command is discoverable but cannot run.

Unsupported frontmatter such as `allowed-tools`, `model`, `effort`, `shell`, `hooks`, `context`, or `agent` MUST NOT grant capabilities or alter runtime behavior. Validators SHOULD warn when unsupported fields are present.

## Argument Rendering

The renderer MUST support:

- `$ARGUMENTS`: the raw argument string after the command token.
- `$ARGUMENTS[N]`: zero-based positional argument access.
- `$N`: zero-based shorthand for positional arguments.
- `$name`: named positional argument declared in `arguments`.

Arguments SHOULD be parsed with shell-like quoting for positional access while preserving the raw argument string for `$ARGUMENTS`.

If a command is invoked with arguments and the Markdown body does not contain any argument placeholder, the renderer SHOULD append:

```text
ARGUMENTS: <raw arguments>
```

This keeps argument delivery explicit and avoids silently dropping user input.

## Prompt Composition

Running a command MUST produce a composed prompt, then dispatch that prompt through the normal Ravi session path.

The composed prompt MUST include:

- command id;
- command source scope (`agent` or `global`);
- command file path;
- original user text;
- raw arguments;
- rendered Markdown body.

The composed prompt SHOULD be formatted as Markdown and sent as a normal user prompt. It MUST NOT mutate the agent system prompt, persistent agent instructions, or loaded skill state.

The durable user message and session trace MUST retain command metadata so the executed prompt can be audited later. At minimum: command id, scope, source path, original text, rendered prompt hash, and argument string.

## Runtime Semantics

- Commands MUST be user-invoked only. Agents MUST NOT auto-trigger commands by emitting `#name` text.
- Commands MUST use the already resolved route/session/agent. They MUST NOT reroute messages on their own.
- Channel inbound commands MUST be detected against the raw user text before Ravi adds channel envelope text such as `[WhatsApp ...] Sender:`.
- Commands MUST obey the same queueing, debounce, interruption, task barrier, permissions, and provider rules as normal prompts.
- Commands MUST NOT grant tools, bypass skill gates, change model/effort/thinking, or create runtime context keys.
- Commands MUST NOT execute local shell snippets during render in the initial implementation. Any Markdown syntax inspired by Claude `!` shell injection MUST be treated as literal text until a separate security spec enables it.
- Commands MUST be reloaded without daemon restart. The implementation MAY read files on every invocation or cache with mtime invalidation.

## Operator Surface

The operator CLI SHOULD expose:

```bash
ravi commands list [--agent <agent>] [--json]
ravi commands show <name> [--agent <agent>] [--json]
ravi commands validate [--agent <agent>] [--json]
ravi commands run <name> [--agent <agent>] [--json] -- <arguments>
```

`ravi commands run` MUST render and return the composed prompt only. It MUST NOT publish to a session or start runtime execution.

All machine-consumed outputs MUST support `--json`.

## Non-Goals

- No DB-backed command source of truth.
- No automatic command invocation by the model.
- No shell preprocessing.
- No permission grants from command frontmatter.
- No slash-command compatibility layer for `/name`; Ravi Commands use `#name`.

## Acceptance Criteria

- A file at `<agent.cwd>/.ravi/commands/review-pr.md` creates `#review-pr`.
- A file at `$RAVI_HOME/commands/review-pr.md` creates a global `#review-pr`.
- Agent scope shadows global scope for the same canonical command id.
- `#review-pr 123 high` renders `$ARGUMENTS`, `$ARGUMENTS[0]`, `$0`, and named placeholders correctly.
- Unknown commands are ordinary chat and dispatch without command expansion.
- Invalid command names return structured errors without dispatching to the model.
- Unsupported frontmatter cannot grant tools or change runtime settings.
- Editing a command file is visible without daemon restart.
- The session trace can show which command produced a prompt and where the Markdown came from.
