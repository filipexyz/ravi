---
name: ravi-rules
description: |
  Use when creating, reviewing, or debugging `.ravi/rules` runtime prompt rules:
  - adding workspace/fleet rules that must be injected into built system prompts
  - diagnosing missing or duplicated `## Ravi Rules` sections
  - changing runtime prompt assembly around rules, AGENTS.md, or provider fallbacks
  - deciding whether a rule belongs in `.ravi/rules`, AGENTS.md, a spec, or an agent prompt
---

# Ravi Rules

`.ravi/rules` is the Ravi-owned source for workspace runtime rules that must be injected into the built system prompt.

Before changing this area, read the normative spec:

```bash
bin/ravi specs get runtime/prompt-rules --mode rules --json
```

## Mental Model

- `AGENTS.md` describes workspace development instructions.
- `.ravi/rules` describes runtime/fleet rules that should be injected into session prompts.
- Agent `systemPromptAppend` specializes one configured agent.
- Provider settings such as `~/.claude/rules` are not the Ravi source of truth.

The runtime loads rules from the effective session cwd:

```text
<session-cwd>/.ravi/rules/
```

Each non-empty supported file is rendered under one final prompt section:

```markdown
## Ravi Rules

### some-rule.md

...
```

## Loader Contract

- Read recursively.
- Emit deterministic relative-path order.
- Ignore hidden entries such as `.gitkeep` and `.DS_Store`.
- Ignore empty files.
- Accept `.md`, `.markdown`, `.txt`, and extensionless text files.
- Do not inject binary files or arbitrary generated artifacts.
- Keep one top-level `## Ravi Rules` section.
- Place the section after `Workspace Instructions` and before `Agent Instructions`.
- Preserve trace metadata as `id=ravi.rules`.

## Editing Guidance

Put a rule in `.ravi/rules` when it is:

- operational behavior expected across sessions in that workspace;
- stable enough to be reviewed as repository content;
- useful in both task sessions and direct sessions;
- not specific to a single agent identity.

Put it somewhere else when:

- it is a codebase contributor convention: use `AGENTS.md`;
- it is a durable architectural invariant: use `.ravi/specs`;
- it is specific to one agent: use that agent's prompt/config;
- it is private user preference: keep it out of the repo.

Never store secrets, tokens, private keys, or credentials in `.ravi/rules`.

## Validation

After changing loader behavior or prompt ordering, run:

```bash
bun test src/runtime/runtime-system-prompt.test.ts src/runtime/codex-provider.test.ts src/runtime/session-trace.test.ts
bun run typecheck
bun run build
```

If task behavior is involved, also run:

```bash
bun test src/tasks/service.test.ts src/tasks/profiles.test.ts
```
