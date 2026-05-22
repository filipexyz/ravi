# Runtime Prompt Rules / WHY

## Rationale

Issue #27 exposed a gap between direct sessions and task sessions: task runtime prompts did not receive the user's global Claude rules. The immediate hypothesis was to allow provider `settingSources` to include `"user"`, but that would make a Ravi runtime invariant depend on provider-specific settings behavior.

Ravi needs a provider-neutral source for rules that should be part of the runtime system prompt. `.ravi/rules` gives the repository or workspace ownership over those rules and makes them visible in code review, trace metadata, and prompt assembly tests.

## Decisions

- Use `<session-cwd>/.ravi/rules`, not `~/.claude/rules`, as the canonical Ravi-owned source.
- Render one `## Ravi Rules` section instead of spreading each file into top-level sections. This keeps trace metadata compact while preserving per-file headings inside the section.
- Place `Ravi Rules` after `Workspace Instructions` and before `Agent Instructions`. Workspace instructions establish local repo context; Ravi rules add operational constraints; agent instructions can specialize behavior last.
- Keep `.gitkeep` out of the prompt by ignoring hidden files.
- Keep provider fallback support in Codex because some direct provider paths may not receive a fully built runtime prompt yet.
- Support imports from `.claude/rules` and `.agents/rules` as an explicit CLI operation. This gives teams a migration path from provider-owned rules to Ravi-owned rules without making runtime behavior depend on those provider folders.
- Require explicit user-level import. `~/.claude/rules` and `~/.agents/rules` are often personal/private, so the CLI can inspect or import them only when the operator asks.
- Preserve imported rule filenames under `.ravi/rules/imported/<provider>/<scope>/...` instead of flattening into the root. This keeps provenance visible and avoids collisions between provider formats.

## Rejected Alternatives

- **`settingSources: ["user", "project"]`**: rejected as the primary fix because it depends on provider settings loaders and pulls user-global state into sessions without Ravi trace ownership.
- **Copying `~/.claude/rules` at runtime**: rejected because it silently snapshots private user state and creates unclear precedence.
- **Automatically importing user-level rules during build/runtime**: rejected because it would commit or inject personal state without review.
- **Adding rules to `AGENTS.md`**: rejected because workspace instructions and runtime/fleet rules have different ownership and should be independently auditable.
- **One prompt section per rule file**: rejected for now because it makes section metadata noisy and complicates ordering without adding meaningful behavior.
