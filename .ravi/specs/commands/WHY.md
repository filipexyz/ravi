---
id: commands
title: "Ravi Commands Rationale"
kind: domain
domain: commands
status: draft
normative: false
---

# Why Ravi Commands Exist

Ravi already has CLIs, skills, task profiles, hooks, triggers, and cron. Commands fill a narrower gap: a human wants to type a short token in a chat or session and expand it into a known prompt for the same agent.

The design intentionally follows the file-backed Markdown pattern used by coding agents:

- Claude Code now treats custom commands as a compatibility path for skills. Its docs state that `.claude/commands/deploy.md` still creates `/deploy`, while skills are the recommended richer form.
- Claude frontmatter and argument substitutions are useful precedents: `description`, `argument-hint`, named/positional arguments, and `$ARGUMENTS`.
- Codex CLI has built-in slash commands in the interactive composer. Public issue history also shows custom prompt files under `~/.codex/prompts/*.md` being expected to surface as slash commands such as `/prompts:commit`, but that surface is less stable and less explicitly documented than Claude's current skill/command docs.

Ravi should copy the durable parts of the pattern:

- Markdown files are easy to create, review, commit, and sync.
- The command id comes from the file name.
- Frontmatter carries autocomplete/help metadata.
- Arguments are rendered into prompt text.

Ravi should not copy the risky parts by default:

- Commands do not execute shell snippets during render.
- Commands do not grant tools.
- Commands do not auto-load like skills.
- Commands do not change provider model or runtime settings.

## Why `#` Instead of `/`

Ravi runs in channels where `/` can collide with platform UX, provider-native slash commands, or ordinary text. `#name` gives Ravi its own command namespace while still being quick to type on mobile.

The parser requires `#` at message start so hashtags inside normal text stay ordinary text.

## Why Agent Scope Overrides Global Scope

Claude's current skill precedence favors personal settings over project settings. Ravi agents are operational personas with their own workspaces and route ownership, so the closest operational owner should win:

1. Agent command controls the agent-specific workflow.
2. Global command provides reusable defaults.

This lets `#review` mean one thing for a dev agent and another for a support agent without forcing every user to rename commands.

## References

- Claude Code skills/commands docs: https://code.claude.com/docs/en/slash-commands
- OpenAI Codex CLI slash commands docs: https://developers.openai.com/codex/cli/slash-commands
- Codex custom prompt issue example: https://github.com/openai/codex/issues/15941
