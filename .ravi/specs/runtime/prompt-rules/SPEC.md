---
id: runtime/prompt-rules
title: "Runtime Prompt Rules"
kind: capability
domain: runtime
capabilities:
  - prompt-rules
tags:
  - runtime
  - prompts
  - rules
  - tasks
  - codex
applies_to:
  - .ravi/rules
  - src/runtime/ravi-rules.ts
  - src/runtime/runtime-system-prompt.ts
  - src/runtime/codex-provider.ts
  - src/runtime/runtime-request-builder.ts
  - src/session-trace/runtime-trace.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Prompt Rules

## Intent

Runtime Prompt Rules make workspace-owned operating rules part of the Ravi-built system prompt.

The capability exists so task sessions, direct sessions, and provider fallbacks can receive the same durable project/fleet rules without relying on provider-specific user settings such as `~/.claude/rules` or `settingSources: ["user"]`.

The source of truth is `<session-cwd>/.ravi/rules`. Files there are rendered into one audited Markdown section named `Ravi Rules`.

## Model

- **Rules root**: `<cwd>/.ravi/rules`, where `cwd` is the effective runtime session cwd.
- **Rule file**: a non-hidden, non-empty text file under the rules root.
- **Runtime section**: a `PromptContextSection` with `id=ravi.rules`, `title=Ravi Rules`, `priority=30`, and `source=<cwd>/.ravi/rules`.
- **Rendered prompt**: final Markdown emitted by `renderPromptSections`.

## Invariants

- Runtime prompt assembly MUST look for `.ravi/rules` under the effective session cwd, not under process cwd, repository root guesses, or provider user home.
- If `.ravi/rules` is missing or contains no readable rule content, no `Ravi Rules` section MUST be emitted.
- Rule discovery MUST be deterministic. Files MUST be emitted in stable relative-path order.
- Rule discovery MUST recurse into subdirectories.
- Hidden entries whose basename starts with `.` MUST be ignored. This keeps `.gitkeep`, `.DS_Store`, and local editor artifacts out of the prompt.
- Empty files MUST be ignored.
- Supported rule files MUST be Markdown/text oriented: `.md`, `.markdown`, `.txt`, or extensionless.
- Binary or unsupported-extension files MUST NOT be injected into the prompt.
- The final runtime prompt MUST render rules as a Markdown section headed exactly `## Ravi Rules`.
- The `Ravi Rules` section MUST appear after `Workspace Instructions` and before `Agent Instructions`.
- The section metadata MUST remain traceable through runtime trace metadata with `id=ravi.rules`, `title=Ravi Rules`, `source=<rules-dir>`, `chars`, and `sha256`.
- Provider adapters MAY add a fallback `Ravi Rules` section only when the runtime-provided prompt does not already contain `## Ravi Rules`.
- Provider adapters MUST NOT duplicate `Ravi Rules` when the runtime-built prompt already carries it.
- Implementations MUST NOT solve this capability by broadening provider settings to include user-global rules. `.ravi/rules` is the Ravi-owned, workspace-auditable source.
- Rule files are prompt content. They MUST NOT contain secrets, tokens, private keys, or credentials.

## Validation

- `bun test src/runtime/runtime-system-prompt.test.ts`
- `bun test src/runtime/codex-provider.test.ts`
- `bun test src/runtime/session-trace.test.ts`
- `bun test src/tasks/service.test.ts src/tasks/profiles.test.ts`
- `bun run typecheck`
- `bun run build`

## Known Failure Modes

- Task sessions run from an agent cwd that lacks `.ravi/rules`, so no rules are injected even though another workspace has rules.
- A provider fallback injects rules after the runtime prompt already did, causing duplicate instructions.
- A hidden sentinel file such as `.gitkeep` leaks into the system prompt.
- A binary or generated artifact is placed under `.ravi/rules` and corrupts prompt readability.
- A developer changes `settingSources` to include user settings and accidentally couples Ravi behavior to one provider's private settings loader.
